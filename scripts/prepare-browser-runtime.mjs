// Prepare exact local Node/Playwright/Chromium resources. No runtime downloads or user profiles.
import { chromium } from 'playwright';
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { dirname, join, resolve, basename, relative } from 'node:path';
import { createHash } from 'node:crypto';
async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
async function copy(source, target, recursive = false) {
  await cp(source, target, {
    recursive,
    filter: async (source, target) => {
      const input = await stat(source);
      if (!input.isFile() || !existsSync(target)) return true;
      return (
        (await stat(target)).size !== input.size ||
        (await digest(source)) !== (await digest(target))
      );
    },
  });
}
const root = resolve(import.meta.dirname, '..'),
  dest = join(root, 'src-tauri/resources/browser-runtime');
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw Error('Prepare the Windows x64 runtime on Windows x64');
if (process.version !== 'v24.16.0')
  throw Error('Use the pinned Node v24.16.0 runtime for this build');
const executable = chromium.executablePath();
if (!existsSync(executable))
  throw Error('Run npx playwright install chromium before browser:prepare');
await mkdir(join(dest, 'node_modules'), { recursive: true });
await mkdir(join(dest, 'browsers'), { recursive: true });
await copy(process.execPath, join(dest, 'node.exe'));
await copy(join(root, 'automation/web-login/licenses/node-LICENSE'), join(dest, 'node-LICENSE'));
for (const name of ['playwright', 'playwright-core'])
  await copy(join(root, 'node_modules', name), join(dest, 'node_modules', name), true);
for (const name of ['worker.mjs', 'engine.mjs'])
  await copy(join(root, 'automation/web-login', name), join(dest, name));
const browserFolder = dirname(dirname(executable));
await copy(browserFolder, join(dest, 'browsers', basename(browserFolder)), true);
const manifest = {
  node: process.version,
  playwright: JSON.parse(await readFile(join(root, 'node_modules/playwright/package.json'), 'utf8'))
    .version,
  browser_executable: relative(
    dest,
    join(dest, 'browsers', basename(browserFolder), 'chrome-win64', 'chrome.exe'),
  ).replaceAll('\\', '/'),
  sha256: {},
};
for (const name of ['node.exe', 'worker.mjs', 'engine.mjs', manifest.browser_executable])
  manifest.sha256[name] = createHash('sha256')
    .update(await readFile(join(dest, name)))
    .digest('hex');
await writeFile(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Prepared Windows x64 dedicated browser runtime:', manifest.node, manifest.playwright);
