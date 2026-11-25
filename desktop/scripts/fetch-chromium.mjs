// Downloads Playwright's headless Chromium into desktop/browsers so electron-builder can ship it
// (extraResources). At runtime main.js points PLAYWRIGHT_BROWSERS_PATH at resources/browsers.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(here, 'node_modules', 'playwright', 'cli.js');
execFileSync(process.execPath, [cli, 'install', 'chromium', '--only-shell'], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(here, 'browsers') },
});
