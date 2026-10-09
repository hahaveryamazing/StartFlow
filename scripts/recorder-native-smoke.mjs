// Debug-only Windows desktop + separate real Edge, synthetic local HTTPS identities.
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { fixture } from '../automation/web-login/test-fixture.mjs';
const root = resolve(import.meta.dirname, '..');
const reportPrefix = process.env.STARTFLOW_RECORDER_REPORT_PREFIX ?? 'recorder';
assert.match(reportPrefix, /^[a-z0-9-]+$/);
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
const f = await fixture(),
  dir = join(f.directory, 'app-data');
await mkdir(dir);
const password = randomUUID() + randomUUID(),
  username = 'user@example.test';
f.users.set(username, password);
const dbfile = join(dir, 'startflow.sqlite3');
const seed = new DatabaseSync(dbfile);
seed.exec(await readFile(join(root, 'src-tauri/tests/fixtures/v3-populated.sql'), 'utf8'));
seed.exec(
  "UPDATE settings SET value_json=json_set(value_json,'$.paused',json('true')) WHERE key='general';UPDATE settings SET value_json=json_set(value_json,'$.enabled',json('false')) WHERE key='automation'",
);
seed.close();
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  limitations: [
    '仅合成账号与本地 HTTPS；第三方网站仍需逐站验证。',
    'CDP 9234 仅在显式 debug 测试环境开启，发布版不启用。',
  ],
};
let app, browser, recorderBrowser, page, account;
let stderr = '';
const errors = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 160; i++) {
    if (await fn()) return;
    await delay(150);
  }
  throw Error('Timeout: ' + label);
}
const pass = (name) => {
  report.checks.push({ name, status: 'passed' });
  console.log('PASS', name);
};
const clean = (value) =>
  assert.ok(
    !(Buffer.isBuffer(value) ? value.toString('utf8') : JSON.stringify(value)).includes(password),
    'Secret leaked',
  );
async function call(command, args = {}, p = page) {
  const r = await p.evaluate(
    async ({ command, args }) => {
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(command, args) };
      } catch (error) {
        return { ok: false, error };
      }
    },
    { command, args },
  );
  clean(r);
  if (!r.ok) throw r.error;
  return r.value;
}
async function rejected(command, args, p = page) {
  let failure;
  try {
    await call(command, args, p);
  } catch (e) {
    failure = e;
  }
  assert.ok(failure, 'Expected rejection');
}
const snapshot = () => call('web_recorder_snapshot');
async function stopRecord(id) {
  await call('web_recorder_close', { id });
  await until(async () => !(await snapshot()).active, 'recorder closed');
  await recorderBrowser?.close().catch(() => {});
  recorderBrowser = null;
}
async function recording(mode) {
  const s = await call('web_recorder_start', {
    accountId: account.id,
    loginUrl: f.origin + '/login/' + mode,
  });
  await until(
    async () => ['ready', 'blocked', 'failed'].includes((await snapshot()).status),
    'record ready',
  );
  if ((await snapshot()).status === 'ready') {
    recorderBrowser = await chromium.connectOverCDP('http://127.0.0.1:9234');
    const pages = recorderBrowser.contexts().flatMap((c) => c.pages());
    return { id: s.id, p: pages.find((p) => p.url().startsWith(f.origin)) };
  }
  return { id: s.id };
}
async function pick(id, p, field, locator) {
  await call('web_recorder_command', { id, command: { type: 'arm', field } });
  await until(async () => (await snapshot()).status === 'picking', 'armed');
  const b = await locator.boundingBox();
  assert.ok(b);
  await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await until(async () => !!(await snapshot()).rules[field], 'picked ' + field);
}
async function testRules(id) {
  const s = await snapshot();
  await call('web_recorder_command', { id, command: { type: 'test', rules: s.rules } });
}
async function runState(id, status) {
  await until(
    async () =>
      (await call('web_login_snapshot')).runs.some((r) => r.id === id && r.status === status),
    status,
  );
}
async function closeLogin(id) {
  await call('web_login_close', { id });
  await until(
    async () => !(await call('web_login_snapshot')).active_runs.includes(id),
    'login closed',
  );
}
const helper = join(f.directory, 'cleanup.ps1');
await writeFile(
  helper,
  `param([Guid]$Reference)\nAdd-Type @'\nusing System;using System.Runtime.InteropServices;public class TestVault{[DllImport("Advapi32.dll",EntryPoint="CredDeleteW",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool Delete(string name,int type,int flags);}\n'@\nif(-not [TestVault]::Delete("StartFlow.V3.1.Account."+$Reference.ToString(),1,0)){if([Runtime.InteropServices.Marshal]::GetLastWin32Error()-ne 1168){exit 1}}\n`,
);
try {
  app = spawn(join(root, 'src-tauri/target/debug/startflow.exe'), [], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      STARTFLOW_TEST_DATA_DIR: dir,
      STARTFLOW_LOGIN_TEST_CERT_PIN: f.pin,
      STARTFLOW_LOGIN_TEST_HEADLESS: '1',
      STARTFLOW_RECORDER_TEST_CDP_PORT: '9234',
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9233',
    },
  });
  app.stderr.on('data', (b) => (stderr += String(b)));
  await until(async () => {
    try {
      return (await fetch('http://127.0.0.1:9233/json/version')).ok;
    } catch {
      return false;
    }
  }, 'WebView2');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9233');
  await until(async () => {
    for (const p of browser.contexts().flatMap((c) => c.pages())) {
      try {
        if (
          (await p.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label)) ===
          'main'
        )
          page = p;
      } catch {}
    }
    return !!page;
  }, 'main');
  page.on('pageerror', (e) => errors.push(e.message));
  account = (
    await call('accounts_save', {
      request: {
        id: null,
        name: '录制测试账号',
        username,
        kind: 'web',
        target: f.origin,
        password,
        expected_revision: null,
      },
    })
  ).account;
  await until(async () => (await call('web_login_snapshot')).runtime_ready, 'browser available');
  report.browser = (await call('web_login_snapshot')).browser;
  pass('真实 Windows 凭据保存、Edge 启动检测及隔离数据目录');
  await rejected('web_recorder_start', {
    accountId: account.id,
    loginUrl: 'https://wrong.example.test/login',
  });
  await rejected('web_recorder_start', {
    accountId: account.id,
    loginUrl: f.origin + '/login?token=secret',
  });
  const { id, p } = await recording('record');
  assert.ok(p);
  await rejected('web_recorder_start', {
    accountId: account.id,
    loginUrl: f.origin + '/login/record',
  });
  await rejected('web_recorder_command', {
    id,
    command: { type: 'manual', password: 'not-allowed' },
  });
  await rejected('web_recorder_command', {
    id,
    command: { type: 'evaluate', script: 'not-allowed' },
  });
  pass('错误 Origin、令牌 URL、重复录制及越权命令被真实 IPC 拒绝');
  await page.getByRole('button', { name: '账号与凭据', exact: true }).click();
  await page.getByRole('button', { name: '录制登录流程', exact: true }).click();
  await page.getByRole('dialog', { name: '配置网页登录 · 可视化录制' }).waitFor();
  await mkdir(join(root, '.test-runtime'), { recursive: true });
  const settings = (await call('snapshot')).config.settings;
  for (const theme of ['dark', 'light']) {
    await call('save_settings', { settings: { ...settings, theme } });
    await delay(300);
    await page.screenshot({ path: join(root, '.test-runtime', 'recorder-' + theme + '.png') });
    const metrics = await page
      .locator('.modal')
      .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(metrics.scroll <= metrics.width + 2, 'Recorder must not overflow horizontally');
  }
  await call('save_settings', { settings });
  pass('真实桌面深浅主题渲染与录制弹窗无横向溢出');
  await pick(id, p, 'username', p.getByLabel('工作账号'));
  await pick(id, p, 'password', p.getByLabel('登录密码'));
  await pick(id, p, 'submit', p.getByRole('button', { name: '安全登录' }));
  await testRules(id);
  await until(async () => (await snapshot()).verified_login, 'form proof');
  assert.equal(f.posts.get('record'), undefined);
  await call('web_recorder_command', { id, command: { type: 'manual' } });
  await until(async () => (await snapshot()).status === 'manual', 'manual');
  await p.getByLabel('工作账号').fill(username);
  await p.getByLabel('登录密码').fill(password);
  await p.getByRole('button', { name: '安全登录' }).click();
  await p.getByTestId('signed-in').waitFor();
  await pick(id, p, 'success', p.getByTestId('signed-in'));
  await pick(id, p, 'identity', p.getByTestId('account-identity'));
  await testRules(id);
  await until(async () => (await snapshot()).verified_success, 'success identity proof');
  await page.getByRole('button', { name: '保存登录配置', exact: true }).click();
  await until(async () => (await call('web_login_snapshot')).configs.length === 1, 'saved by UI');
  const config = (await call('web_login_snapshot')).configs[0];
  assert.equal(config.schema_version, 2);
  assert.equal(config.credential_ref, account.credential_ref);
  clean(await snapshot());
  clean(config);
  assert.ok(!JSON.stringify(await snapshot()).includes('sf_session'));
  pass('桌面录制向导实时接收点选事件、验证五项规则并持久化配置');
  await page.getByRole('button', { name: '授权测试登录', exact: true }).click();
  assert.equal((await call('web_login_snapshot')).runs.length, 0, 'No login before confirmation');
  await page.getByRole('button', { name: '确认继续', exact: true }).click();
  await until(
    async () => (await call('web_login_snapshot')).runs.some((r) => r.status === 'authenticated'),
    'authenticated from UI',
  );
  let run = (await call('web_login_snapshot')).runs[0];
  await closeLogin(run.id);
  assert.equal(f.posts.get('record'), 2);
  run = await call('web_login_start', { id: config.id, authorized: false });
  await runState(run.id, 'session_reused');
  await closeLogin(run.id);
  assert.equal(f.posts.get('record'), 2);
  pass('界面授权后真实 Windows 凭据登录；录制会话隔离及专用 Profile 复用');
  await page.locator('.modal-footer').getByRole('button', { name: '关闭', exact: true }).click();
  const duplicate = await recording('duplicate');
  await call('web_recorder_command', {
    id: duplicate.id,
    command: {
      type: 'test',
      rules: { username: { kind: 'role', role: 'textbox', name: '工作账号' } },
    },
  });
  await until(async () => (await snapshot()).results.username === 'ambiguous', 'ambiguous');
  assert.equal((await snapshot()).verified_login, false);
  await stopRecord(duplicate.id);
  const redirected = await recording('redirect');
  assert.equal((await snapshot()).status, 'blocked');
  await stopRecord(redirected.id);
  assert.equal(f.evilRequests, 0);
  pass('重复匹配明确报错，恶意重定向未发送任何请求到未知 Origin');
  const palette = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((q) => q !== page);
  assert.ok(palette, 'Expected the actual command panel WebView');
  if (palette) {
    await rejected('web_recorder_snapshot', {}, palette);
    await rejected(
      'web_recorder_start',
      { accountId: account.id, loginUrl: f.origin + '/login/record' },
      palette,
    );
  }
  pass('录制权限仅限可信主窗口，不扩展命令面板权限');
  const db = new DatabaseSync(dbfile, { readOnly: true });
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM migrations').get().v, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pragma_foreign_key_check').get().n, 0);
  for (const table of ['credential_accounts', 'web_login_configs', 'web_login_runs', 'settings'])
    clean(db.prepare('SELECT * FROM ' + table).all());
  clean(await readFile(dbfile));
  db.close();
  clean(stderr);
  assert.deepEqual(errors, []);
  pass('SQLite 升级到版本 6、外键有效、元数据及错误输出不含密码');
  const liveRecording = await recording('dynamic');
  assert.ok(liveRecording.p);
  const owned = JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$items=Get-CimInstance Win32_Process;$ids=[System.Collections.Generic.List[int]]::new();$ids.Add(${app.pid});for($i=0;$i -lt $ids.Count;$i++){foreach($item in $items){if($item.ParentProcessId -eq $ids[$i] -and -not $ids.Contains([int]$item.ProcessId)){$ids.Add([int]$item.ProcessId)}}};ConvertTo-Json -Compress -InputObject @($ids | Select-Object -Skip 1)`,
      ],
      { windowsHide: true, encoding: 'utf8' },
    ),
  );
  assert.ok(owned.length > 0);
  await call('quit');
  await until(() => app.exitCode !== null || app.signalCode !== null, 'quit');
  const remaining = Number(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `@(Get-Process -Id @(${owned.join(',')}) -ErrorAction SilentlyContinue).Count`,
      ],
      { windowsHide: true, encoding: 'utf8' },
    ).trim(),
  );
  assert.equal(remaining, 0, 'Owned sidecar and browsers must exit');
  pass('真实退出清理录制服务与专用浏览器');
  report.finishedAt = new Date().toISOString();
} catch (e) {
  report.error = String(e?.stack ?? e).replaceAll(password, '[REDACTED]');
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await recorderBrowser?.close().catch(() => {});
  try {
    if (page) await call('quit');
  } catch {}
  await browser?.close().catch(() => {});
  if (app && app.exitCode === null) {
    await delay(1000);
    if (app.exitCode === null) app.kill();
  }
  if (account)
    execFileSync('powershell.exe', ['-NoProfile', '-File', helper, account.credential_ref], {
      windowsHide: true,
      stdio: 'pipe',
    });
  clean(report);
  await writeFile(
    join(root, `docs/${reportPrefix}-native-results.json`),
    JSON.stringify(report, null, 2),
  );
  await f.close();
}
