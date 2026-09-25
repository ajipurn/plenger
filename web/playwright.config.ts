import {defineConfig} from '@playwright/test';

const browserPath = process.env.PLENGER_E2E_BROWSER;
const requestedEngine = process.env.PLENGER_E2E_ENGINE;
const supportedEngines = ['chromium', 'firefox', 'webkit'] as const;
type BrowserEngine = (typeof supportedEngines)[number];

if (
  requestedEngine !== undefined &&
  !supportedEngines.includes(requestedEngine as BrowserEngine)
) {
  throw new Error(`Unsupported PLENGER_E2E_ENGINE: ${requestedEngine}`);
}

const browserName = (requestedEngine as BrowserEngine | undefined) ?? 'chromium';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  expect: {timeout: 10_000},
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:7331',
    headless: true,
    browserName,
    launchOptions: browserName === 'chromium' && browserPath
      ? {executablePath: browserPath}
      : undefined,
    trace: 'retain-on-failure',
  },
});
