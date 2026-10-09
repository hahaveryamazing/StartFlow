// A test-only copy avoids executable virtualization issues in the host's Playwright cache.
// It is outside Tauri resources and is never included in the installer.
import { chromium } from 'playwright';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
const browser = dirname(dirname(chromium.executablePath()));
const target = resolve('.test-runtime/browsers', basename(browser));
if (!existsSync(chromium.executablePath()))
  throw Error('Run npm run browser:install for browser tests');
if (!existsSync(join(target, '.startflow-test-ready'))) {
  await mkdir(dirname(target), { recursive: true });
  await cp(browser, target, { recursive: true });
  await writeFile(join(target, '.startflow-test-ready'), 'complete');
}
console.log('Test-only Chromium cache ready; excluded from installation resources.');
