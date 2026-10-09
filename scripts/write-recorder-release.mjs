import { readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const name = `StartFlow_${version}_phase3_x64-setup.exe`;
const source = join(
  root,
  'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis',
  `StartFlow_${version}_x64-setup.exe`,
);
await copyFile(source, join(root, 'release', name));
const digest = (data) => createHash('sha256').update(data).digest('hex');
const locks = {};
for (const path of ['package-lock.json', 'src-tauri/Cargo.lock', 'rust-toolchain.toml'])
  locks[path] = digest(await readFile(join(root, path)));
const file = {
  filename: name,
  bytes: (await stat(source)).size,
  sha256: digest(await readFile(source)),
};
const manifest = {
  application: 'StartFlow',
  version,
  stage: 'V3.1 phase 3 visual login recorder',
  platform: 'windows-x64',
  createdAt: new Date().toISOString(),
  sourceBranch: execFileSync('C:/Program Files/Git/cmd/git.exe', ['branch', '--show-current'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  databaseSchema: 5,
  loginConfigSchema: 2,
  legacyLoginConfigSchema: 1,
  signed: false,
  installationTested: false,
  browserBundled: false,
  node: '24.16.0',
  playwright: '1.64.0',
  files: [file],
  lockfileSha256: locks,
  checks: {
    rustTests: 80,
    frontendTests: 34,
    nodeTestGroups: 18,
    recorderWindowsChecks: 9,
    credentialWindowsRegressionChecks: 13,
  },
};
await writeFile(
  join(root, 'release', `StartFlow_${version}_phase3_manifest.json`),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(JSON.stringify(file));
