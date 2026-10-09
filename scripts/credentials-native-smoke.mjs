// Real Windows Credential Manager + Tauri IPC/UI, isolated synthetic V3 database.
// No auto-login, launcher calls, production data, saved passwords, or test traces.
import { chromium } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..'),
  dir = await mkdtemp(join(tmpdir(), 'StartFlow-credentials-'));
const reportName = process.env.STARTFLOW_CREDENTIAL_REPORT_PREFIX ?? 'credentials';
assert.match(reportName, /^[a-z0-9-]+$/);
const report = {
  startedAt: new Date().toISOString(),
  directory: dir,
  checks: [],
  limitations: [
    '其他 Windows 用户、损坏的用户凭据库和凭据管理器被系统策略禁用，仍需专门实机环境验证。',
    '不覆盖自动登录；未操作生产数据库或已安装的 V3 应用。',
  ],
};
const secrets = [randomUUID() + randomUUID(), randomUUID() + randomUUID()];
let app,
  browser,
  page,
  stderr = '',
  errors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = (name) => {
  report.checks.push({ name, status: 'passed' });
  console.log('PASS', name);
};
async function until(fn, label) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await wait(200);
  }
  throw Error('Timeout: ' + label);
}
async function call(command, args, p = page) {
  const result = await p.evaluate(
    async ({ command, args }) => {
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(command, args) };
      } catch (error) {
        return { ok: false, error };
      }
    },
    { command, args },
  );
  if (!result.ok) throw result.error;
  return result.value;
}
async function rejected(command, args, pattern, p = page) {
  let error;
  try {
    await call(command, args, p);
  } catch (e) {
    error = e;
  }
  assert.ok(error, 'Expected rejection');
  assert.match(String(error?.message ?? error), pattern);
}
const noSecrets = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert.ok(!text.includes(secret), 'Secret leaked');
};
const dbfile = join(dir, 'startflow.sqlite3');
const seed = new DatabaseSync(dbfile);
seed.exec(await readFile(join(root, 'src-tauri/tests/fixtures/v3-populated.sql'), 'utf8'));
// Always pause legacy schedules and V3 rules in the isolated fixture.
seed.exec(
  "UPDATE settings SET value_json=json_set(value_json,'$.paused',json('true')) WHERE key='general';UPDATE settings SET value_json=json_set(value_json,'$.enabled',json('false')) WHERE key='automation'",
);
const oldCounts = {};
for (const table of [
  'scenes',
  'tasks',
  'schedules',
  'workflows',
  'window_layouts',
  'shortcuts',
  'execution_runs',
  'execution_logs',
  'environment_rules',
  'workspace_modes',
])
  oldCounts[table] = seed.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
seed.close();
// Test helper can only delete a UUID in this test account namespace; never reads secrets.
const helper = join(dir, 'remove-test-credential.ps1');
await writeFile(
  helper,
  `param([Guid]$Reference)\nAdd-Type @'\nusing System; using System.Runtime.InteropServices;\npublic class TestVault { [DllImport("Advapi32.dll",EntryPoint="CredDeleteW",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool Delete(string name,int type,int flags); }\n'@\nif (-not [TestVault]::Delete("StartFlow.V3.1.Account."+$Reference.ToString(),1,0)) { if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { exit 1 } }\n`,
);
function removeVault(reference) {
  execFileSync('powershell.exe', ['-NoProfile', '-File', helper, reference], {
    windowsHide: true,
    stdio: 'pipe',
  });
}
async function launch() {
  app = spawn(join(root, 'src-tauri/target/debug/startflow.exe'), [], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      STARTFLOW_TEST_DATA_DIR: dir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9231',
    },
  });
  app.stderr.on('data', (s) => {
    stderr += String(s);
  });
  await until(async () => {
    try {
      return (await fetch('http://127.0.0.1:9231/json/version')).ok;
    } catch {
      return false;
    }
  }, 'WebView2');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9231');
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
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
}
async function quit() {
  await call('quit').catch(() => {});
  await until(() => app.exitCode !== null || app.signalCode !== null, 'quit');
  await browser?.close().catch(() => {});
  browser = undefined;
  page = undefined;
}
function request(name, kind = 'web') {
  return {
    id: null,
    name,
    username: name + '@example.test',
    kind,
    target: kind === 'web' ? 'https://example.test/path' : 'C:\\测试 空格\\example.exe',
    password: secrets[0],
    expected_revision: null,
  };
}
try {
  // Abort instead of interrupting a user's running StartFlow instance.
  const processes = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', '@(Get-Process startflow -ErrorAction SilentlyContinue).Count'],
    { windowsHide: true, encoding: 'utf8' },
  );
  assert.equal(
    Number(processes.trim()),
    0,
    'Close existing StartFlow before running isolated integration tests',
  );
  await launch();
  const db = new DatabaseSync(dbfile, { readOnly: true });
  assert.equal(db.prepare('SELECT MAX(version) AS n FROM migrations').get().n, 6);
  for (const [table, count] of Object.entries(oldCounts))
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, count, table);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  let found = false;
  for (const file of await readdir(join(dir, 'backups'))) {
    if (!file.endsWith('.sqlite3')) continue;
    const b = new DatabaseSync(join(dir, 'backups', file), { readOnly: true });
    if (b.prepare('SELECT MAX(version) AS n FROM migrations').get().n === 3) {
      found = true;
      for (const [table, count] of Object.entries(oldCounts))
        assert.equal(b.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, count);
    }
    b.close();
  }
  assert.ok(found);
  db.close();
  pass('非空 V3→当前版本迁移、旧表保留及迁移前 SQLite 备份');
  const saved = [];
  for (const [name, kind] of [
    ['主账号', 'web'],
    ['备用账号', 'web'],
    ['应用账号', 'app'],
    ['应用备用', 'app'],
  ]) {
    const r = await call('accounts_save', { request: request(name, kind) });
    noSecrets(r);
    assert.equal(r.account.credential_state, 'saved');
    saved.push(r.account);
  }
  assert.equal((await call('accounts_list')).accounts.length, 4);
  assert.ok(await call('accounts_exists', { id: saved[0].id }));
  pass('真实 IPC 新增网页/应用账号，同一目标绑定多个账号');
  let r = await call('accounts_save', {
    request: {
      ...request('主账号修改'),
      id: saved[0].id,
      password: null,
      expected_revision: saved[0].revision,
    },
  });
  assert.equal(r.account.credential_ref, saved[0].credential_ref);
  saved[0] = r.account;
  r = await call('accounts_save', {
    request: {
      ...request('主账号修改'),
      id: saved[0].id,
      password: secrets[1],
      expected_revision: saved[0].revision,
    },
  });
  assert.notEqual(r.account.credential_ref, saved[0].credential_ref);
  saved[0] = r.account;
  assert.equal(r.pending_cleanup, 0);
  pass('元数据更新保留密码，密码更新轮换引用并清理旧凭据');
  await rejected(
    'accounts_save',
    { request: { ...request('过期修改'), id: saved[0].id, expected_revision: 1 } },
    /已被修改/,
  );
  await rejected('accounts_delete', { id: saved[0].id, expectedRevision: 1 }, /已被修改/);
  await rejected(
    'accounts_save',
    { request: { ...request('非法'), credential_ref: randomUUID() } },
    /unknown field/,
  );
  await rejected(
    'accounts_save',
    { request: { ...request('非法'), target: 'https://name:password@example.test' } },
    /网站地址/,
  );
  await rejected('accounts_exists', { id: randomUUID() }, /不存在/);
  pass('过期版本、注入引用、内嵌凭据地址与外部账号 ID 拒绝');
  const list = await call('accounts_list');
  noSecrets(list);
  assert.ok(!JSON.stringify(list).includes('password'));
  noSecrets(await call('snapshot'));
  noSecrets(await call('v3_snapshot'));
  await rejected('accounts_get_password', { id: saved[0].id }, /not found|不存在|unknown/i);
  pass('普通查询不返回密码，没有密码读取 IPC');
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
    ['accounts_list', {}],
    ['accounts_save', { request: request('禁止') }],
    ['accounts_delete', { id: saved[0].id, expectedRevision: saved[0].revision }],
    ['accounts_exists', { id: saved[0].id }],
    ['accounts_retry_cleanup', {}],
  ])
    await rejected(command, args, /主窗口/, palette);
  await call('v2_hide_palette');
  pass('快速命令窗口拒绝所有凭据 IPC');
  removeVault(saved[1].credential_ref);
  assert.equal(await call('accounts_exists', { id: saved[1].id }), false);
  assert.equal(
    (await call('accounts_list')).accounts.find((a) => a.id === saved[1].id).credential_state,
    'missing',
  );
  pass('外部删除密码后返回 missing，无虚假保存状态');
  await page.getByRole('button', { name: '账号与凭据', exact: true }).click();
  await page.getByText('主账号修改', { exact: true }).waitFor();
  await page.getByRole('button', { name: '新增账号', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('账号名称', { exact: true }).fill('界面测试账号');
  await dialog.getByLabel('用户名', { exact: true }).fill('ui@example.test');
  await dialog.getByPlaceholder('https://example.com').fill('https://ui.example.test');
  await dialog.getByLabel('密码', { exact: true }).fill(secrets[1]);
  await dialog.getByRole('button', { name: '保存账号' }).click();
  await page.getByText('界面测试账号', { exact: true }).waitFor();
  await page.getByLabel('编辑 界面测试账号', { exact: true }).click();
  assert.equal(
    await dialog.getByLabel('新密码（留空保留原密码）', { exact: true }).inputValue(),
    '',
  );
  await dialog.getByLabel('账号名称', { exact: true }).fill('界面更新账号');
  await dialog.getByRole('button', { name: '保存账号' }).click();
  await page.getByText('界面更新账号', { exact: true }).waitFor();
  pass('真实界面新增、编辑，不读取或回填原密码');
  for (const theme of ['dark', 'light']) {
    const s = (await call('snapshot')).config.settings;
    await call('save_settings', { settings: { ...s, theme } });
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('.app-shell')?.scrollTo(0, 0);
      document.querySelector('.main-content')?.scrollTo(0, 0);
      document.querySelector('nav')?.scrollTo(0, 0);
    });
    const layout = await page.evaluate(() => {
      const shell = document.querySelector('.app-shell');
      return {
        headerTop: document.querySelector('.topbar').getBoundingClientRect().top,
        fits: shell.scrollHeight <= shell.clientHeight + 1,
      };
    });
    assert.ok(
      layout.headerTop >= 0 && layout.fits,
      'Header and navigation must stay within window',
    );
    await page.screenshot({ path: join(root, `docs/${reportName}-${theme}.png`) });
  }
  noSecrets(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  );
  assert.equal(errors.length, 0);
  pass('深浅主题页面与浏览器存储安全检查，无页面异常');
  const json = join(dir, 'export.json');
  await call('v2_export', { path: json });
  const bundle = JSON.parse(await readFile(json, 'utf8'));
  noSecrets(bundle);
  assert.ok(!JSON.stringify(bundle).includes('credential_accounts'));
  noSecrets(await call('v2_create_backup'));
  for (const name of await readdir(join(dir, 'backups'))) {
    noSecrets((await readFile(join(dir, 'backups', name))).toString('utf8'));
  }
  for (const suffix of ['', '-wal'])
    try {
      noSecrets((await readFile(dbfile + suffix)).toString('utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  noSecrets(stderr);
  pass('SQLite/WAL、普通 JSON、备份和进程日志未包含测试密码');
  const beforeRestart = await call('accounts_list');
  await quit();
  await launch();
  const afterRestart = await call('accounts_list');
  assert.deepEqual(afterRestart, beforeRestart);
  pass('重启后账号、引用和真实 Windows 密码状态保留');
  await page.getByRole('button', { name: '账号与凭据', exact: true }).click();
  await page.getByLabel('删除 界面更新账号', { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
  assert.ok((await call('accounts_list')).accounts.some((a) => a.name === '界面更新账号'));
  await page.getByLabel('删除 界面更新账号', { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认继续' }).click();
  await until(
    async () => !(await call('accounts_list')).accounts.some((a) => a.name === '界面更新账号'),
    'delete',
  );
  pass('真实界面删除确认和取消保护');
  for (const a of (await call('accounts_list')).accounts)
    assert.equal(
      (await call('accounts_delete', { id: a.id, expectedRevision: a.revision })).pending_cleanup,
      0,
    );
  assert.deepEqual(await call('accounts_list'), { accounts: [], pending_cleanup: 0 });
  noSecrets(stderr);
  pass('账号删除和 Windows 清理完成，无待清理密码');
  await quit();
  report.finishedAt = new Date().toISOString();
} catch (error) {
  let message = String(error?.stack ?? error);
  for (const s of secrets) message = message.replaceAll(s, '[REDACTED]');
  report.error = message;
  process.exitCode = 1;
  console.error(message);
} finally {
  // Clean only test-generated namespace entries even if an assertion failed or IPC disconnected.
  try {
    const db = new DatabaseSync(dbfile, { readOnly: true });
    for (const a of db
      .prepare(
        'SELECT credential_ref FROM credential_accounts UNION SELECT credential_ref FROM credential_cleanup',
      )
      .all())
      removeVault(a.credential_ref);
    db.close();
  } catch {}
  if (page) await quit().catch(() => {});
  if (app && app.exitCode === null) app.kill();
  noSecrets(report);
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(
    join(root, `docs/${reportName}-native-results.json`),
    JSON.stringify(report, null, 2),
  );
}
