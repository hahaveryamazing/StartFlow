import { readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const filename = `StartFlow_${version}_phase5_x64-setup.exe`;
const source = join(
  root,
  'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis',
  `StartFlow_${version}_x64-setup.exe`,
);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
await copyFile(source, join(root, 'release', filename));
const locks = {};
for (const path of ['package-lock.json', 'src-tauri/Cargo.lock', 'rust-toolchain.toml'])
  locks[path] = digest(await readFile(join(root, path)));
const runtime = JSON.parse(
  await readFile(join(root, 'src-tauri/resources/browser-runtime/manifest.json'), 'utf8'),
);
const manifest = {
  application: 'StartFlow',
  version,
  stage: 'V3.1 phase 5 login workflow integration',
  platform: 'windows-x64',
  createdAt: new Date().toISOString(),
  sourceBranch: execFileSync('C:/Program Files/Git/cmd/git.exe', ['branch', '--show-current'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  databaseSchema: 7,
  backupSchema: 4,
  loginConfigSchemas: { web: [1, 2], desktop: 1 },
  signed: false,
  installationTested: false,
  browserBundled: false,
  runtime,
  lockfileSha256: locks,
  file: { filename, bytes: (await stat(source)).size, sha256: digest(await readFile(source)) },
  validationReport: 'docs/V3.1-PHASE5-TESTS.md',
};
await writeFile(
  join(root, 'release', `StartFlow_${version}_phase5_manifest.json`),
  JSON.stringify(manifest, null, 2) + '\n',
);
await writeFile(
  join(root, 'release', filename + '.sha256'),
  `${manifest.file.sha256}  ${filename}\n`,
);
console.log(JSON.stringify(manifest.file));
