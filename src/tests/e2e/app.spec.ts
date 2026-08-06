import { expect, test, type ElectronApplication } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { findLatestBuild, parseElectronApp } from 'electron-playwright-helpers';
import crypto from 'crypto';
import fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';

const injectCloudAccountsFailureScript = `
(() => {
  const START_ORPC_SERVER = 'start-orpc-server';
  const originalPostMessage = window.postMessage.bind(window);
  const isStringValue = (value) => Object.prototype.toString.call(value) === '[object String]';

  window.postMessage = function (message, targetOrigin, transfer) {
    if (message === START_ORPC_SERVER && Array.isArray(transfer) && transfer[0]) {
      const clientPort = transfer[0];
      const { port1: proxyPort, port2: mainPort } = new MessageChannel();
      const forwardedTransfer = transfer.slice();
      forwardedTransfer[0] = mainPort;

      if (clientPort.start instanceof Function) {
        clientPort.start();
      }

      if (proxyPort.start instanceof Function) {
        proxyPort.start();
      }

      clientPort.onmessage = (event) => {
        try {
          const request = isStringValue(event.data) ? JSON.parse(event.data) : event.data;
          const requestId = request && (request.i || request.id);
          const requestUrl = (request && request.p && request.p.u) || '';

          if (requestId && requestUrl.includes('/cloud/listCloudAccounts')) {
            clientPort.postMessage(
              JSON.stringify({
                i: requestId,
                p: { s: 500, b: { json: { message: 'internal server error' } } },
              }),
            );
            return;
          }

          proxyPort.postMessage(event.data);
        } catch (_error) {
          proxyPort.postMessage(event.data);
        }
      };

      proxyPort.onmessage = (event) => {
        clientPort.postMessage(event.data);
      };

      return originalPostMessage(message, targetOrigin, forwardedTransfer);
    }

    return originalPostMessage(message, targetOrigin, transfer);
  };
})();
`;

async function reservePort(): Promise<number> {
  const server = net.createServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not reserve an E2E proxy port');
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  return address.port;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

test.describe.serial('Antigravity Manager', () => {
  let electronApp: ElectronApplication;
  let e2eRoot: string;
  let userDataDir: string;
  let proxyPort: number;
  let proxyApiKey: string;

  async function launchApp() {
    const appInfo = parseElectronApp(findLatestBuild());

    electronApp = await electron.launch({
      executablePath: appInfo.executable,
      args: [appInfo.main, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        AGM_E2E_TEST: 'true',
        HOME: path.join(e2eRoot, 'UserProfile'),
        USERPROFILE: path.join(e2eRoot, 'UserProfile'),
        APPDATA: path.join(e2eRoot, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(e2eRoot, 'AppData', 'Local'),
      },
    });
  }

  test.beforeAll(async () => {
    e2eRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-e2e-'));
    userDataDir = path.join(e2eRoot, 'electron-user-data');
    proxyPort = await reservePort();
    proxyApiKey = crypto.randomUUID();
    const userProfile = path.join(e2eRoot, 'UserProfile');

    await fs.mkdir(path.join(userProfile, '.antigravity-agent'), { recursive: true });
    await fs.writeFile(
      path.join(userProfile, '.antigravity-agent', 'gui_config.json'),
      JSON.stringify({
        auto_startup: false,
        proxy: {
          enabled: true,
          port: proxyPort,
          api_key: proxyApiKey,
          auto_start: true,
        },
      }),
    );
    await launchApp();
  });

  test.afterAll(async () => {
    try {
      await electronApp?.close();
    } finally {
      await fs.rm(e2eRoot, { recursive: true, force: true });
    }

    expect(await pathExists(e2eRoot)).toBe(false);
  });

  test('should launch and display home page', async () => {
    expect(await electronApp.evaluate(() => process.env.HOME)).toBe(
      path.join(e2eRoot, 'UserProfile'),
    );

    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const title = await window.title();
    expect(title).toBe('Antigravity Manager');

    await expect(window.getByRole('main')).toBeVisible();
    await expect(window.locator('a[href="/settings"]').first()).toBeVisible();
  });

  test('starts the production proxy with multipart bootstrap and authenticates requests', async () => {
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
              headers: { Authorization: `Bearer ${proxyApiKey}` },
            });
            return response.status;
          } catch {
            return 0;
          }
        },
        { timeout: 15000 },
      )
      .toBe(200);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
      headers: { Authorization: `Bearer ${proxyApiKey}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      object: 'list',
      data: expect.any(Array),
    });
  });

  test('should navigate to settings', async () => {
    const window = await electronApp.firstWindow();

    // Click settings link (use data-testid or aria-label for reliability)
    await window.click('a[href="/settings"]');
    await window.waitForLoadState('domcontentloaded');

    // Check settings page has content (i18n-agnostic)
    await expect(window.locator('h2').first()).toBeVisible();
  });

  test('should show fallback UI when cloud accounts loading fails', async () => {
    await electronApp.close();

    await launchApp();

    const page = await electronApp.firstWindow();
    await page.addInitScript(injectCloudAccountsFailureScript);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('a[href="/"]').click();
    const mainContent = page.getByRole('main');
    await expect(mainContent.getByTestId('cloud-load-error-fallback')).toBeVisible({
      timeout: 15000,
    });
    await expect(mainContent.getByTestId('cloud-load-error-retry')).toBeVisible();
  });
});
