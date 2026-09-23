import {defineConfig} from '@playwright/test';

const browserPath = process.env.PLENGER_E2E_BROWSER;

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
    launchOptions: browserPath ? {executablePath: browserPath} : undefined,
    trace: 'retain-on-failure',
  },
});
