import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import { findLatestBuild, parseElectronApp } from 'electron-playwright-helpers';
import electronPath from 'electron';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const electronBinaryPath = electronPath as unknown as string;

/*
 * Using Playwright with Electron:
 * https://www.electronjs.org/pt/docs/latest/tutorial/automated-testing#using-playwright
 */

let electronApp: ElectronApplication;

test.beforeAll(async () => {
  const latestBuild = findLatestBuild();
  const appInfo = parseElectronApp(latestBuild);
  process.env.CI = 'e2e';
  const userDataDir = join(
    tmpdir(),
    'antigravity-manager-e2e',
    `example-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );

  electronApp = await electron.launch({
    executablePath: electronBinaryPath,
    args: [appInfo.main, `--user-data-dir=${userDataDir}`],
  });
  electronApp.on('window', async (page) => {
    const filename = page.url()?.split('/').pop();
    console.log(`Window opened: ${filename}`);

    page.on('pageerror', (error) => {
      console.error(error);
    });
    page.on('console', (msg) => {
      console.log(msg.text());
    });
  });
});

test('renders page name', async () => {
  const page: Page = await electronApp.firstWindow();

  await expect(
    page.getByRole('heading', { exact: true, level: 1, name: 'Antigravity' }),
  ).toBeVisible();
  await expect(page.locator('main')).toBeVisible();
});
