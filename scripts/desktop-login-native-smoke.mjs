import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
assert.equal(
  Number(
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', '@(Get-Process startflow -ErrorAction SilentlyContinue).Count'],
      { windowsHide: true, encoding: 'utf8' },
    ).trim(),
  ),
  0,
  'Close existing StartFlow before isolated tests',
);
const temp = await mkdtemp(join(tmpdir(), 'startflow-uia-'));
const fixtureExe = join(temp, 'DesktopLoginFixture.exe');
execFileSync(
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  [
    '/nologo',
    '/target:exe',
    '/platform:x64',
    '/out:' + fixtureExe,
    join(root, 'scripts/fixtures/DesktopLoginFixture.cs'),
  ],
  { windowsHide: true, stdio: 'pipe' },
);
const dir = join(temp, 'app-data');
await mkdir(dir);
const dbfile = join(dir, 'startflow.sqlite3');
const seed = new DatabaseSync(dbfile);
seed.exec(await readFile(join(root, 'src-tauri/tests/fixtures/v3-populated.sql'), 'utf8'));
const originalWorkflowCount = seed.prepare('SELECT COUNT(*) n FROM workflows').get().n;
seed.exec(
  "UPDATE settings SET value_json=json_set(value_json,'$.paused',json('true')) WHERE key='general';UPDATE settings SET value_json=json_set(value_json,'$.enabled',json('false')) WHERE key='automation'",
);
seed.close();
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  limitations: [
    '合成 Win32 测试应用；未验证真实第三方应用。',
    '锁屏、UAC 安全桌面和管理员应用仍需人工实机验证。',
  ],
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 120; i++) {
    if (await fn()) return;
    await delay(150);
  }
  throw Error('Timeout ' + label);
}
const pass = (name) => {
  report.checks.push({ name, status: 'passed' });
  console.log('PASS', name);
};
const clean = (value) =>
  assert.ok(!JSON.stringify(value).includes('StartFlowSynthetic-only'), 'Secret leak');
let app, browser, page, account;
const fixtures = [];
let stderr = '';
let isolated = false;
async function call(cmd, args = {}, p = page) {
  const r = await p.evaluate(
    async ({ cmd, args }) => {
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(cmd, args) };
      } catch (error) {
        return { ok: false, error };
      }
    },
    { cmd, args },
  );
  clean(r);
  if (!r.ok) throw r.error;
  return r.value;
}
async function rejection(cmd, args, code) {
  let e;
  try {
    await call(cmd, args);
  } catch (error) {
    e = error;
  }
  assert.ok(e, 'Expected rejection');
  if (code) assert.equal(e.code, code);
}
async function fixture(mode) {
  const state = join(temp, randomUUID() + '.json');
  const child = spawn(fixtureExe, [mode, state], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  fixtures.push(child);
  await until(async () => {
    try {
      return JSON.parse(await readFile(state, 'utf8'));
    } catch {
      return false;
    }
  }, 'fixture');
  await delay(200);
  return { child, state, read: async () => JSON.parse(await readFile(state, 'utf8')) };
}
async function stop(f) {
  f.child.kill();
  await until(async () => f.child.exitCode !== null || f.child.signalCode !== null, 'fixture exit');
  await delay(100);
}
const locator = (id, type) => ({
  automation_id: String(id),
  control_type: type,
  name: '',
  ancestor_id: '',
});
function ownedWindow(action, handle = 0) {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-File',
      join(root, 'scripts/fixtures/OwnedTestWindow.ps1'),
      '-ProcessId',
      String(app.pid),
      '-Action',
      action,
      '-HandleValue',
      String(handle),
    ],
    { windowsHide: true, encoding: 'utf8' },
  ).trim();
}
function config(w, a = account) {
  return {
    id: randomUUID(),
    account_id: a.id,
    credential_ref: a.credential_ref,
    schema_version: 1,
    name: '合成测试应用登录',
    executable_path: fixtureExe,
    window_title: w.title,
    window_class: w.class_name,
    username: locator(1001, 50004),
    password: locator(1002, 50004),
    submit: locator(1003, 50000),
    success: locator(1004, 50020),
    identity: locator(1005, 50020),
    failure: locator(1006, 50020),
    challenge: locator(1007, 50020),
    timeout_seconds: 3,
  };
}
async function windowFor(f, a = account) {
  const r = await call('desktop_login_windows', { accountId: a.id });
  assert.equal(r.status, 'ready', JSON.stringify(r));
  return r.windows.find((w) => w.pid === f.child.pid);
}
async function resetClaim() {
  const c = new DatabaseSync(dbfile);
  c.exec('DELETE FROM desktop_login_attempts');
  c.close();
}
try {
  app = spawn(join(root, 'src-tauri/target/debug/startflow.exe'), [], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      STARTFLOW_TEST_DATA_DIR: dir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9240',
    },
  });
  app.stderr.on('data', (b) => (stderr += String(b)));
  await until(async () => {
    try {
      return (await fetch('http://127.0.0.1:9240/json/version')).ok;
    } catch {
      return false;
    }
  }, 'webview');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9240');
  await until(async () => {
    for (const p of browser.contexts().flatMap((c) => c.pages())) {
      try {
        if (
          await p.evaluate(
            () => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label === 'main',
          )
        ) {
          page = p;
          return true;
        }
      } catch {}
    }
    return false;
  }, 'main');
  await page.waitForSelector('.sidebar');
  assert.equal((await call('snapshot')).data_directory, dir);
  isolated = true;
  account = (
    await call('accounts_save', {
      request: {
        id: null,
        name: '合成桌面账号',
        username: 'demo1@example.test',
        kind: 'app',
        target: fixtureExe,
        password: 'StartFlowSynthetic-only',
        expected_revision: null,
      },
    })
  ).account;
  const f = await fixture('success');
  const w = await windowFor(f);
  assert.ok(w);
  assert.equal(typeof w.creation_time, 'string');
  const controls = (await call('desktop_login_inspect', { accountId: account.id, target: w }))
    .controls;
  clean(controls);
  assert.ok(
    controls.find((c) => c.locator.automation_id === '1002' && c.is_password && c.value_supported),
  );
  assert.equal(controls.find((c) => c.locator.automation_id === '1001').locator.name, '');
  pass('真实 Win32 窗口、PID、创建时间与 UIA 控件识别，不读取输入值');
  const cfg = config(w);
  assert.equal((await call('desktop_login_test', { config: cfg, target: w })).status, 'validated');
  await call('desktop_login_save', { config: cfg });
  const probe = await call('desktop_login_run', { id: cfg.id, authorized: false });
  assert.equal(probe.result.status, 'authorization_required');
  assert.equal((await f.read()).submissions, 0);
  pass('未授权时仅检查，不读取密码、不提交');
  const login = await call('desktop_login_run', { id: cfg.id, authorized: true });
  assert.equal(login.result.status, 'success', JSON.stringify(login));
  assert.equal(login.result.submitted, true);
  assert.equal((await f.read()).submissions, 1);
  assert.equal((await f.read()).logged, true);
  pass('凭据库真实读取，ValuePattern 填写、InvokePattern 提交并验证成功与身份');
  const reused = await call('desktop_login_run', { id: cfg.id, authorized: true });
  assert.equal(reused.result.status, 'session_reused');
  assert.equal(reused.result.submitted, false);
  assert.equal((await f.read()).submissions, 1);
  pass('已登录会话复用，无重复提交');
  const other = (
    await call('accounts_save', {
      request: {
        id: null,
        name: '合成第二账号',
        username: 'demo2@example.test',
        kind: 'app',
        target: fixtureExe,
        password: 'StartFlowSynthetic-only',
        expected_revision: null,
      },
    })
  ).account;
  const c2 = config(w, other);
  await call('desktop_login_save', { config: c2 });
  const wrong = await call('desktop_login_run', { id: c2.id, authorized: true });
  assert.equal(wrong.result.status, 'wrong_account');
  assert.equal((await f.read()).submissions, 1);
  pass('已有其他账号会话时停止，避免账号混淆');
  f.child.stdin.write('reset\n');
  await until(async () => !(await f.read()).logged, 'reset');
  assert.equal(
    (await call('desktop_login_run', { id: cfg.id, authorized: false })).result.status,
    'session_expired',
  );
  pass('真实退出会话后的过期状态识别');
  await rejection('desktop_login_run', { id: cfg.id, authorized: true }, 'cooldown');
  pass('持久化五分钟提交节流');
  const stale = await call('desktop_login_inspect', {
    accountId: account.id,
    target: { ...w, creation_time: '1' },
  });
  assert.equal(stale.status, 'wrong_target');
  const bad = await call('desktop_login_test', {
    config: { ...cfg, username: locator(9999, 50004) },
    target: w,
  });
  assert.equal(bad.status, 'invalid_controls');
  pass('进程身份变化及无效控件明确拒绝');
  const duplicateWindow = await fixture('success');
  await rejection('desktop_login_run', { id: cfg.id, authorized: false }, 'wrong_target');
  await stop(duplicateWindow);
  pass('多个同 EXE 同标题窗口拒绝自动选择');
  await page.getByRole('button', { name: '桌面应用登录', exact: true }).click();
  await page.getByRole('heading', { name: '桌面应用登录', exact: true }).waitFor();
  await page.screenshot({ path: join(root, 'docs/desktop-login-native-dark.png') });
  await page.getByLabel('选择应用账号').selectOption(account.id);
  await page.getByRole('button', { name: '录制登录配置', exact: true }).click();
  await page.getByRole('button', { name: '读取应用窗口', exact: true }).click();
  await until(
    async () => (await page.getByLabel('目标窗口').locator('option').count()) > 1,
    'recorder windows',
  );
  await page.getByLabel('目标窗口').selectOption(String(w.handle));
  await page.getByRole('button', { name: '刷新控件列表', exact: true }).click();
  await until(
    async () =>
      (await page.getByLabel('账号输入框', { exact: true }).locator('option').count()) > 1,
    'recorder controls',
  );
  for (const [label, id] of [
    ['账号输入框', '1001'],
    ['密码输入框', '1002'],
    ['登录按钮', '1003'],
  ]) {
    const select = page.getByLabel(label, { exact: true });
    const values = await select
      .locator('option')
      .evaluateAll(
        (o, id) => o.filter((x) => x.textContent.startsWith(id + ' ·')).map((x) => x.value),
        id,
      );
    assert.equal(values.length, 1);
    await select.selectOption(values[0]);
  }
  f.child.stdin.write('show-success\n');
  await until(async () => (await f.read()).logged, 'manual success');
  await page.getByRole('button', { name: '刷新控件列表', exact: true }).click();
  await until(
    async () =>
      (await page
        .getByLabel('显示用户名的文本', { exact: true })
        .locator('option')
        .filter({ hasText: '1005 ·' })
        .count()) === 1,
    'success controls',
  );
  for (const [label, id] of [
    ['登录成功控件', '1004'],
    ['显示用户名的文本', '1005'],
  ]) {
    const select = page.getByLabel(label, { exact: true });
    const values = await select
      .locator('option')
      .evaluateAll(
        (o, id) => o.filter((x) => x.textContent.startsWith(id + ' ·')).map((x) => x.value),
        id,
      );
    assert.equal(values.length, 1);
    await select.selectOption(values[0]);
  }
  await page.getByRole('button', { name: '验证并保存', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  pass('真实前端录制、登录后刷新、保存控件规则');
  await call('save_settings', {
    settings: { ...(await call('snapshot')).config.settings, theme: 'light' },
  });
  await until(
    async () => await page.evaluate(() => document.documentElement.dataset.theme === 'light'),
    'light theme',
  );
  await page.screenshot({ path: join(root, 'docs/desktop-login-native-light.png') });
  await stop(f);
  for (const [mode, expected] of [
    ['fail', 'failed'],
    ['timeout', 'timeout'],
    ['challenge', 'waiting_manual'],
    ['after-challenge', 'waiting_manual'],
    ['success-challenge', 'waiting_manual'],
    ['disabled', 'manual_required'],
    ['unsupported', 'manual_required'],
    ['duplicates', 'ambiguous_controls'],
  ]) {
    await resetClaim();
    const t = await fixture(mode);
    if (mode === 'success-challenge') {
      t.child.stdin.write('show-success\n');
      await until(async () => (await t.read()).logged, 'partial session');
    }
    const tw = await windowFor(t);
    const tc = config(tw);
    await call('desktop_login_save', { config: tc });
    const result = await call('desktop_login_run', { id: tc.id, authorized: true });
    assert.equal(result.result.status, expected, JSON.stringify(result));
    assert.equal(
      (await t.read()).submissions,
      ['fail', 'timeout', 'after-challenge'].includes(mode) ? 1 : 0,
    );
    await stop(t);
    pass('真实 UIA ' + mode + ' → ' + expected);
  }
  await resetClaim();
  const waiting = await fixture('timeout');
  const waitWindow = await windowFor(waiting);
  const waitConfig = { ...config(waitWindow), timeout_seconds: 6 };
  await call('desktop_login_save', { config: waitConfig });
  const mainHandle = Number(ownedWindow('handle'));
  assert.ok(mainHandle > 0);
  assert.equal((await call('snapshot')).config.settings.close_to_tray, true);
  const pending = call('desktop_login_run', { id: waitConfig.id, authorized: true });
  await until(async () => (await waiting.read()).submissions === 1, 'waiting submit');
  await rejection('desktop_login_run', { id: waitConfig.id, authorized: true }, 'busy');
  ownedWindow('close', mainHandle);
  assert.equal(ownedWindow('visible', mainHandle), 'False');
  assert.equal((await pending).result.status, 'timeout');
  ownedWindow('show', mainHandle);
  await stop(waiting);
  pass('关闭主窗口后真实后台等待继续运行，同应用并发重入被拒绝');
  const hung = await fixture('hang');
  const hw = await windowFor(hung);
  hung.child.stdin.write('hang\n');
  await until(async () => (await hung.read()).armed, 'armed provider');
  const start = Date.now();
  await rejection('desktop_login_inspect', { accountId: account.id, target: hw }, 'timeout');
  assert.ok(Date.now() - start < 21000);
  assert.equal((await hung.read()).submissions, 0);
  await stop(hung);
  pass('真实无响应 UIA 提供程序在工作进程时限内停止，未填写或提交');
  const snapshot = await call('desktop_login_snapshot');
  clean(snapshot);
  clean(stderr);
  const conn = new DatabaseSync(dbfile);
  assert.equal(conn.prepare('SELECT MAX(version) v FROM migrations').get().v, 6);
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM workflows').get().n, originalWorkflowCount);
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM pragma_foreign_key_check').get().n, 0);
  for (const table of ['desktop_login_configs', 'desktop_login_runs'])
    clean(conn.prepare('SELECT payload FROM ' + table).all());
  conn.close();
  await call('export_config', { path: join(temp, 'export.json') });
  clean(await readFile(join(temp, 'export.json'), 'utf8'));
  pass('原有配置保留、Schema 6 与数据库/普通 IPC/日志秘密检查');
  await call('accounts_delete', { id: other.id, expectedRevision: other.revision });
  pass('账号删除及关联配置外键清理');
  report.finishedAt = new Date().toISOString();
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = { code: e.code, message: e.message ?? String(e) };
  clean(stderr);
  console.log('Test app diagnostics:', stderr.slice(0, 1800));
  if (page)
    console.log(
      'Test UI:',
      (
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      ).slice(0, 1800),
    );
  throw e;
} finally {
  for (const f of fixtures) f.kill();
  if (page && isolated) {
    for (const a of (await call('accounts_list').catch(() => ({ accounts: [] }))).accounts)
      await call('accounts_delete', { id: a.id, expectedRevision: a.revision }).catch(() => {});
  }
  if (page) await call('quit').catch(() => {});
  await browser?.close().catch(() => {});
  if (app) app.kill();
  clean(report);
  await writeFile(
    join(root, 'docs/desktop-login-native-results.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
