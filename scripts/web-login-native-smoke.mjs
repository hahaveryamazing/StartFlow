// Actual Windows vault -> Rust -> private sidecar pipes -> Chromium, isolated local HTTPS.
// All identities and passwords are synthetic. No trace, HAR or screenshots of secrets.
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { fixture } from '../automation/web-login/test-fixture.mjs';
const root = resolve(import.meta.dirname, '..');
const f = await fixture();
const dir = join(f.directory, 'app-data');
await mkdir(dir);
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  limitations: [
    '仅本地 HTTPS 测试站；未提交任何真实网站账号。',
    '真实网站的验证码、扫码、MFA、Passkey 及企业安全策略仍需逐站人工验证。',
  ],
};
const secrets = [randomUUID() + randomUUID(), randomUUID() + randomUUID()];
f.users.set('native@example.test', secrets[0]);
f.users.set('other@example.test', secrets[1]);
const dbfile = join(dir, 'startflow.sqlite3');
const seed = new DatabaseSync(dbfile);
seed.exec(await readFile(join(root, 'src-tauri/tests/fixtures/v3-populated.sql'), 'utf8'));
seed.exec(
  "UPDATE settings SET value_json=json_set(value_json,'$.paused',json('true')) WHERE key='general';UPDATE settings SET value_json=json_set(value_json,'$.enabled',json('false')) WHERE key='automation'",
);
seed.close();
let app,
  browser,
  page,
  stderr = '';
const errors = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = (name) => {
  report.checks.push({ name, status: 'passed' });
  console.log('PASS', name);
};
async function until(fn, label) {
  for (let i = 0; i < 180; i++) {
    if (await fn()) return;
    await pause(150);
  }
  throw Error('Timeout: ' + label);
}
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
  if (!r.ok) throw r.error;
  return r.value;
}
async function rejected(command, args, pattern, p = page) {
  let e;
  try {
    await call(command, args, p);
  } catch (error) {
    e = error;
  }
  assert.ok(e, 'Expected rejection');
  assert.match(String(e?.message ?? e), pattern);
}
const clean = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert.ok(!text.includes(secret), 'Secret leaked');
};
async function snapshot() {
  return call('web_login_snapshot');
}
async function awaitState(run, status) {
  await until(
    async () => (await snapshot()).runs.some((r) => r.id === run.id && r.status === status),
    status,
  );
}
async function close(run) {
  await call('web_login_close', { id: run.id });
  await until(async () => !(await snapshot()).active_runs.includes(run.id), 'browser closed');
}
async function save(account, mode = 'normal') {
  const c = { ...f.config(account.id, mode), timeout_seconds: 5 };
  await call('web_login_save', { config: c });
  return c;
}
async function start(c, authorized = true) {
  return call('web_login_start', { id: c.id, authorized });
}
const helper = join(f.directory, 'cleanup.ps1');
await writeFile(
  helper,
  `param([Guid]$Reference)\nAdd-Type @'\nusing System;using System.Runtime.InteropServices;public class TestVault{[DllImport("Advapi32.dll",EntryPoint="CredDeleteW",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool Delete(string name,int type,int flags);}\n'@\nif(-not [TestVault]::Delete("StartFlow.V3.1.Account."+$Reference.ToString(),1,0)){if([Runtime.InteropServices.Marshal]::GetLastWin32Error()-ne 1168){exit 1}}\n`,
);
try {
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
  app = spawn(join(root, 'src-tauri/target/debug/startflow.exe'), [], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      STARTFLOW_TEST_DATA_DIR: dir,
      STARTFLOW_LOGIN_TEST_CERT_PIN: f.pin,
      STARTFLOW_LOGIN_TEST_HEADLESS: '1',
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9233',
    },
  });
  app.stderr.on('data', (data) => (stderr += String(data)));
  await until(async () => {
    try {
      return (await fetch('http://127.0.0.1:9233/json/version')).ok;
    } catch {
      return false;
    }
  }, 'WebView2');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9233');
  await until(async () => {
    for (const p of browser.contexts().flatMap((c) => c.pages()))
      try {
        if (
          (await p.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label)) ===
          'main'
        )
          page = p;
      } catch {}
    return !!page;
  }, 'main');
  page.on('pageerror', (e) => errors.push(e.message));
  const accounts = [];
  for (const [index, username] of ['native@example.test', 'other@example.test'].entries()) {
    const r = await call('accounts_save', {
      request: {
        id: null,
        name: '测试账号 ' + index,
        username,
        kind: 'web',
        target: f.origin,
        password: secrets[index],
        expected_revision: null,
      },
    });
    accounts.push(r.account);
    clean(r);
  }
  assert.ok((await snapshot()).runtime_ready);
  pass('真实 Windows 凭据入库及受控浏览器运行时就绪');
  const config = await save(accounts[0]);
  let run = await start(config);
  await awaitState(run, 'authenticated');
  assert.equal(f.posts.get('normal'), 1);
  await rejected('web_login_start', { id: config.id, authorized: true }, /已打开/);
  await close(run);
  run = await start(config, false);
  await awaitState(run, 'session_reused');
  assert.equal(f.posts.get('normal'), 1);
  await close(run);
  pass('Rust 私有管道实际登录、独立持久 Profile 会话复用及防重复运行');
  const other = await save(accounts[1]);
  run = await start(other);
  await awaitState(run, 'authenticated');
  assert.equal(f.posts.get('normal'), 2);
  await close(run);
  pass('同一 HTTPS 网站两个账号使用独立 Profile，身份核验成功');
  f.expire();
  const manual = await save(accounts[0], 'mfa');
  run = await start(manual);
  await awaitState(run, 'waiting_manual');
  assert.equal((await snapshot()).runs.find((r) => r.id === run.id).submitted, false);
  await close(run);
  const evil = await save(accounts[0], 'redirect');
  run = await start(evil);
  await awaitState(run, 'blocked');
  await close(run);
  assert.equal(f.evilRequests, 0);
  pass('人工验证停止自动提交，跨 Origin 重定向被阻止');
  const failed = await save(accounts[1], 'fail');
  run = await start(failed);
  await awaitState(run, 'cooldown'); // Successful submit also consumes the durable five-minute budget.
  assert.ok(!f.posts.has('fail'));
  await close(run);
  const db = new DatabaseSync(dbfile);
  db.prepare(
    'UPDATE web_login_attempts SET last_requested_at=last_requested_at-301 WHERE account_id=?',
  ).run(accounts[1].id);
  db.close(); // Injectable synthetic fixture clock, never real system clock.
  run = await start(failed);
  await awaitState(run, 'failed');
  assert.equal(f.posts.get('fail'), 1);
  await close(run);
  run = await start(failed);
  await awaitState(run, 'cooldown');
  assert.equal(f.posts.get('fail'), 1);
  await close(run);
  pass('真实失败状态、最多一次提交及跨配置持久冷却');
  await rejected(
    'web_login_save',
    { config: { ...config, origin: f.origin + 'evil' } },
    /绑定|网站/,
  );
  await rejected(
    'web_login_save',
    { config: { ...config, password: 'forbidden' } },
    /unknown field/,
  );
  await rejected('accounts_get_password', { id: accounts[0].id }, /not found|unknown|不存在/i);
  await call('v2_show_palette');
  let palette;
  await until(async () => {
    for (const p of browser.contexts().flatMap((c) => c.pages()))
      try {
        if (
          (await p.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label)) ===
          'palette'
        )
          palette = p;
      } catch {}
    return !!palette;
  }, 'palette');
  for (const [command, args] of [
    ['web_login_snapshot', {}],
    ['web_login_save', { config }],
    ['web_login_start', { id: config.id, authorized: true }],
    ['web_login_close', { id: run.id }],
    ['web_login_delete', { id: config.id }],
  ])
    await rejected(command, args, /主窗口/, palette);
  await call('v2_hide_palette');
  pass('配置验证、无密码读取 IPC、快速命令窗口拒绝全部登录接口');
  await page.getByRole('button', { name: '网页登录', exact: true }).click();
  await page.getByRole('button', { name: '编辑配置', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  const uiConfig = { ...config, id: randomUUID(), name: '界面登录配置' };
  await dialog.getByLabel('登录配置 JSON').fill(JSON.stringify(uiConfig, null, 2));
  await dialog.getByRole('button', { name: '验证并保存', exact: true }).click();
  await page.getByText('界面登录配置', { exact: true }).waitFor();
  const card = page
    .locator('article')
    .filter({ has: page.getByText('界面登录配置', { exact: true }) });
  const runsBefore = (await snapshot()).runs.length;
  await card.getByRole('button', { name: '授权登录', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await snapshot()).runs.length, runsBefore);
  for (const theme of ['dark', 'light']) {
    const settings = (await call('snapshot')).config.settings;
    await call('save_settings', { settings: { ...settings, theme } });
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
    assert.ok(await card.isVisible());
  }
  assert.equal(errors.length, 0);
  clean(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  );
  pass('真实深浅主题页面保存配置不执行、授权取消保护、无页面异常');
  const exportFile = join(dir, 'config.json');
  await call('v2_export', { path: exportFile });
  await call('v2_create_backup');
  const exported = await readFile(exportFile, 'utf8');
  clean(exported);
  assert.ok(!exported.includes('sf_session') && !exported.includes('credential_ref'));
  for (const name of await readdir(join(dir, 'backups'))) {
    const content = await readFile(join(dir, 'backups', name));
    clean(content.toString('utf8'));
    assert.ok(!content.includes(Buffer.from('sf_session')));
  }
  for (const suffix of ['', '-wal'])
    try {
      clean((await readFile(dbfile + suffix)).toString('utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  clean(await snapshot());
  clean(await call('accounts_list'));
  clean(stderr);
  async function checkProfile(folder) {
    for (const file of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, file.name);
      if (file.isDirectory()) await checkProfile(path);
      else if (file.isFile()) {
        const content = await readFile(path);
        for (const secret of secrets) {
          assert.ok(!content.includes(Buffer.from(secret)), 'Password leaked to Profile');
          assert.ok(
            !content.includes(Buffer.from(secret, 'utf16le')),
            'Password leaked to Profile',
          );
        }
      }
    }
  }
  await checkProfile(join(dir, 'browser-profiles'));
  pass('查询、SQLite/WAL、JSON、备份、浏览器存储及日志无测试密码或 Cookie');
  const raw = new DatabaseSync(dbfile, { readOnly: true });
  assert.equal(raw.prepare('SELECT MAX(version) AS n FROM migrations').get().n, 5);
  assert.equal(raw.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.ok(raw.prepare('SELECT COUNT(*) AS n FROM workflows').get().n > 0);
  raw.close();
  pass('真实 V3→5 迁移、旧工作流保留、外键完整性');
  // Check running sidecar process arguments while authenticated: secrets never argv, browser CDP uses pipe.
  run = await start(config, false);
  await awaitState(run, 'authorization_required');
  const processInfo = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*browser-runtime*' -or $_.CommandLine -like '*browser-profiles*' } | Select-Object Name,CommandLine | ConvertTo-Json -Compress",
    ],
    { windowsHide: true, encoding: 'utf8' },
  );
  clean(processInfo);
  assert.ok(processInfo.includes('--remote-debugging-pipe'));
  assert.ok(!processInfo.includes('--remote-debugging-port='));
  await close(run);
  pass('专用浏览器无调试端口、启动参数不含密码');
  run = await start(manual);
  await awaitState(run, 'waiting_manual');
  await call('quit').catch(() => {});
  await until(() => app.exitCode !== null || app.signalCode !== null, 'quit with browser');
  const ownedProcesses = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `@(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.ParentProcessId -eq ${app.pid}) -or ($_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*${dir.replaceAll("'", "''")}*') }).Count`,
    ],
    { windowsHide: true, encoding: 'utf8' },
  );
  assert.equal(Number(ownedProcesses.trim()), 0);
  page = undefined;
  pass('退出 StartFlow 时 Windows Job Object 清理专用服务和浏览器进程');
  report.finishedAt = new Date().toISOString();
} catch (error) {
  let message = String(error?.stack ?? error);
  for (const secret of secrets) message = message.replaceAll(secret, '[REDACTED]');
  report.error = message;
  process.exitCode = 1;
  console.error(message);
} finally {
  try {
    if (page) {
      for (const id of (await snapshot()).active_runs) await call('web_login_close', { id });
      await call('quit').catch(() => {});
      await until(() => app.exitCode !== null || app.signalCode !== null, 'quit');
    }
  } catch {}
  await browser?.close().catch(() => {});
  if (app && app.exitCode === null) app.kill();
  try {
    const db = new DatabaseSync(dbfile, { readOnly: true });
    for (const a of db
      .prepare(
        'SELECT credential_ref FROM credential_accounts UNION SELECT credential_ref FROM credential_cleanup',
      )
      .all())
      execFileSync('powershell.exe', ['-NoProfile', '-File', helper, a.credential_ref], {
        windowsHide: true,
        stdio: 'pipe',
      });
    db.close();
  } catch {}
  clean(report);
  await writeFile(
    join(root, 'docs/web-login-native-results.json'),
    JSON.stringify(report, null, 2),
  );
  await f.close();
}
