// Probe the actual windowed release executable without creating a Tauri app or touching user data.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
const binary = join(root, 'src-tauri/target/x86_64-pc-windows-msvc/release/startflow.exe');
const temp = await mkdtemp(join(tmpdir(), 'startflow-release-uia-'));
const exe = join(temp, 'DesktopLoginFixture.exe'),
  state = join(temp, 'state.json');
execFileSync(
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  [
    '/nologo',
    '/target:exe',
    '/platform:x64',
    '/out:' + exe,
    join(root, 'scripts/fixtures/DesktopLoginFixture.cs'),
  ],
  { windowsHide: true, stdio: 'pipe' },
);
const fixture = spawn(exe, ['success', state], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  limitations: ['发布版工作进程私有管道与只读 UIA 探测；未安装覆盖生产应用。'],
};
function pass(name) {
  report.checks.push({ name, status: 'passed' });
  console.log('PASS', name);
}
function call(request) {
  return new Promise((res, rej) => {
    const child = spawn(binary, ['--desktop-login-worker'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '',
      err = '';
    const timer = setTimeout(() => {
      child.kill();
      rej(new Error('Release worker timeout'));
    }, 18000);
    child.stdout.on('data', (b) => (out += String(b)));
    child.stderr.on('data', (b) => (err += String(b)));
    child.on('error', (e) => {
      clearTimeout(timer);
      rej(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0);
        assert.equal(err, '');
        assert.ok(!out.includes('StartFlowSynthetic-only'));
        res(JSON.parse(out));
      } catch (e) {
        rej(e);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
try {
  for (let i = 0; i < 100; i++) {
    try {
      await readFile(state);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const inventory = await call({ operation: 'windows', executable_path: exe });
  assert.equal(inventory.status, 'ready');
  const w = inventory.windows.find((w) => w.pid === fixture.pid);
  assert.ok(w);
  pass('发布版 Windows GUI EXE 的私有 stdin/stdout 通信与真实窗口识别');
  const inspected = await call({ operation: 'inspect', window: w });
  assert.equal(inspected.status, 'ready');
  assert.ok(inspected.controls.some((c) => c.is_password && c.value_supported));
  pass('发布版真实 COM MTA 控件读取，密码框只读元数据');
  const l = (id, type) => ({
    automation_id: String(id),
    control_type: type,
    name: '',
    ancestor_id: '',
  });
  const config = {
    id: randomUUID(),
    account_id: randomUUID(),
    credential_ref: randomUUID(),
    schema_version: 1,
    name: 'release fixture',
    executable_path: exe,
    window_class: w.class_name,
    window_title: w.title,
    username: l(1001, 50004),
    password: l(1002, 50004),
    submit: l(1003, 50000),
    success: l(1004, 50020),
    identity: l(1005, 50020),
    failure: l(1006, 50020),
    challenge: l(1007, 50020),
    timeout_seconds: 3,
  };
  const result = await call({
    operation: 'login',
    window: w,
    config,
    binding: { username: 'demo1@example.test', credential_ref: config.credential_ref },
    authorized: false,
  });
  assert.equal(result.status, 'authorization_required');
  assert.equal(JSON.parse(await readFile(state, 'utf8')).submissions, 0);
  pass('发布版无授权不访问虚构凭据或提交登录');
  assert.equal(
    (await call({ operation: 'inspect', window: { ...w, creation_time: '1' } })).status,
    'wrong_target',
  );
  pass('发布版拒绝失效的进程身份');
  assert.equal(
    (await call({ operation: 'read_password', password: 'forbidden-field' })).status,
    'worker',
  );
  pass('发布版拒绝任意秘密读取和额外秘密字段');
  report.passed = true;
  report.finishedAt = new Date().toISOString();
} finally {
  fixture.kill();
  await writeFile(
    join(root, 'docs/desktop-login-release-worker-results.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
