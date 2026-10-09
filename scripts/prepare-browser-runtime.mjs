// Package Node/Playwright only. Browsers are discovered/downloaded at runtime, never bundled.
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
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
      if (source.split(/[\\/]/).includes('.local-browsers')) return false;
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
await mkdir(join(dest, 'node_modules'), { recursive: true });
await copy(process.execPath, join(dest, 'node.exe'));
await copy(join(root, 'automation/web-login/licenses/node-LICENSE'), join(dest, 'node-LICENSE'));
for (const name of ['playwright', 'playwright-core'])
  await copy(join(root, 'node_modules', name), join(dest, 'node_modules', name), true);
for (const name of ['playwright', 'playwright-core'])
  if (existsSync(join(dest, 'node_modules', name, '.local-browsers')))
    throw Error('Remove stale generated .local-browsers from packaged runtime before building');
for (const name of ['worker.mjs', 'engine.mjs', 'browser-runtime.mjs'])
  await copy(join(root, 'automation/web-login', name), join(dest, name));
const manifest = {
  node: process.version,
  playwright: JSON.parse(await readFile(join(root, 'node_modules/playwright/package.json'), 'utf8'))
    .version,
  browser_strategy: 'detect-or-download',
  sha256: {},
};
for (const name of ['node.exe', 'worker.mjs', 'engine.mjs', 'browser-runtime.mjs'])
  manifest.sha256[name] = createHash('sha256')
    .update(await readFile(join(dest, name)))
    .digest('hex');
await writeFile(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Prepared Windows x64 dedicated browser runtime:', manifest.node, manifest.playwright);
