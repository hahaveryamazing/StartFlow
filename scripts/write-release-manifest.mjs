import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const files = [];
for (const name of [`StartFlow_${version}_x64-setup.exe`, `StartFlow_${version}.exe`]) {
  const path = join(root, 'release', name);
  files.push({
    filename: name,
    bytes: (await stat(path)).size,
    sha256: digest(await readFile(path)),
  });
}
const locks = {};
for (const name of ['package-lock.json', 'src-tauri/Cargo.lock', 'rust-toolchain.toml']) {
  locks[name] = digest(await readFile(join(root, name)));
}
const manifest = {
  application: 'StartFlow',
  version,
  platform: 'windows-x64',
  createdAt: new Date().toISOString(),
  sourceBranch: execFileSync('git', ['branch', '--show-current'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  databaseSchema: 3,
  backupSchema: 3,
  signed: false,
  files,
  lockfileSha256: locks,
};
await writeFile(
  join(root, 'release', `StartFlow_${version}-manifest.json`),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(JSON.stringify(manifest, null, 2));
