// Documentation screenshots (npm run screenshots): docs/images/*.png from the production build.
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testDir: 'screenshots',
  timeout: 300_000,
  retries: 0,
  reporter: 'list',
  use: { ...base.use, viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, trace: 'off' },
});
