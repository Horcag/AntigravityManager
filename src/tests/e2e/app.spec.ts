import { test, expect, ElectronApplication } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { findLatestBuild, parseElectronApp } from 'electron-playwright-helpers';
import electronPath from 'electron';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const electronBinaryPath = electronPath as unknown as string;

const latestBuild = findLatestBuild();
const appInfo = parseElectronApp(latestBuild);

const injectCloudAccountsFailureScript = `
(() => {
  const START_ORPC_SERVER = 'start-orpc-server';
  const originalPostMessage = window.postMessage.bind(window);
  const isStringValue = (value) => Object.prototype.toString.call(value) === '[object String]';

  window.postMessage = function (message, targetOrigin, transfer) {
    if (message === START_ORPC_SERVER && Array.isArray(transfer) && transfer[0]) {
      const serverPort = transfer[0];
      if (serverPort.start instanceof Function) {
        serverPort.start();
      }

      serverPort.onmessage = (event) => {
        try {
          const request = isStringValue(event.data) ? JSON.parse(event.data) : event.data;
          const requestId = request && (request.i || request.id);
          const requestUrl = (request && request.p && request.p.u) || '';

          if (!requestId) {
            return;
          }

          if (requestUrl.includes('/cloud/listCloudAccounts')) {
            serverPort.postMessage(
              JSON.stringify({
                i: requestId,
                p: { s: 500, b: { json: { message: 'internal server error' } } },
              }),
            );
            return;
          }

          let result = null;
          if (requestUrl.includes('/process/isProcessRunning')) {
            result = false;
          } else if (requestUrl.includes('/cloud/getAutoSwitchEnabled')) {
            result = false;
          }

          serverPort.postMessage(
            JSON.stringify({
              i: requestId,
              p: { b: { json: result } },
            }),
          );
        } catch (_error) {
          // Ignore malformed messages in E2E bridge stub.
        }
      };

      return;
    }

    return originalPostMessage(message, targetOrigin, transfer);
  };
})();
`;

test.describe('Antigravity Manager', () => {
  let electronApp: ElectronApplication;

  test.beforeAll(async () => {
    // Launch Electron app
    const userDataDir = join(
      tmpdir(),
      'antigravity-manager-e2e',
      `app-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    electronApp = await electron.launch({
      executablePath: electronBinaryPath,
      args: [appInfo.main, `--user-data-dir=${userDataDir}`],
    });
  });

  test.afterAll(async () => {
    await electronApp.close();
  });

  test('should launch and display home page', async () => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const title = await window.title();
    expect(title).toBe('Antigravity Manager');

    await expect(window.getByRole('main')).toBeVisible();
    await expect(window.locator('a[href="/settings"]').first()).toBeVisible();
  });

  test('should navigate to settings', async () => {
    const window = await electronApp.firstWindow();

    // Navigate through the stable route target instead of translated copy.
    await window.click('a[href="/settings"]');
    await window.waitForLoadState('domcontentloaded');

    // Check settings page has content (i18n-agnostic)
    await expect(window.locator('h2').first()).toBeVisible();
  });

  test('should show fallback UI when cloud accounts loading fails', async () => {
    await electronApp.close();

    const userDataDir = join(
      tmpdir(),
      'antigravity-manager-e2e',
      `app-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    electronApp = await electron.launch({
      executablePath: electronBinaryPath,
      args: [appInfo.main, `--user-data-dir=${userDataDir}`],
    });

    const page = await electronApp.firstWindow();
    await page.addInitScript("localStorage.setItem('lang', 'en');");
    await page.addInitScript(injectCloudAccountsFailureScript);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    const mainContent = page.getByRole('main');
    // The injected failure is emitted at the ORPC transport layer before
    // structured app-level error data reaches cloud-account handling.
    // This path carries only a generic transport failure, so the UI surfaces
    // the generic fallback message instead of cloud.error.loadFailed.
    await expect(
      mainContent.getByText('An unexpected error occurred.', { exact: true }),
    ).toBeVisible({
      timeout: 15000,
    });
    await expect(mainContent.getByRole('button', { exact: true, name: 'Retry' })).toBeVisible();
  });

  // More detailed tests would require mocking IPC or having a real environment
  // For now, we verify basic navigation and rendering
});
