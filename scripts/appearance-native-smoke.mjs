// Actual Tauri/WebView2, isolated synthetic data. No OS native color chooser required.
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  'Close existing StartFlow before isolated checks',
);
const dir = await mkdtemp(join(tmpdir(), 'StartFlow-appearance-'));
const db = new DatabaseSync(join(dir, 'startflow.sqlite3'));
db.exec(await readFile(join(root, 'src-tauri/tests/fixtures/v3-populated.sql'), 'utf8'));
db.exec(
  "UPDATE settings SET value_json=json_set(value_json,'$.paused',json('true'),'$.onboarding_done',json('true')) WHERE key='general';UPDATE settings SET value_json=json_set(value_json,'$.enabled',json('false')) WHERE key='automation'",
);
db.close();
const report = {
  startedAt: new Date().toISOString(),
  kind: 'Actual WebView2 via CDP; synthetic isolated database; no user tasks',
  checks: [],
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let app, browser, page;
async function until(fn, label) {
  for (let i = 0; i < 120; i++) {
    if (await fn()) return;
    await delay(150);
  }
  throw Error('Timeout: ' + label);
}
const call = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const accent = () =>
  page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'));
function pass(name) {
  report.checks.push({ name, status: 'passed' });
  console.log('PASS', name);
}
async function start() {
  app = spawn(join(root, 'src-tauri/target/debug/startflow.exe'), [], {
    windowsHide: true,
    env: {
      ...process.env,
      STARTFLOW_TEST_DATA_DIR: dir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9242',
    },
  });
  await until(async () => {
    try {
      return (await fetch('http://127.0.0.1:9242/json/version')).ok;
    } catch {
      return false;
    }
  }, 'WebView2');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9242');
  await until(async () => {
    for (const p of browser.contexts().flatMap((c) => c.pages())) {
      if (!p.url().includes('tauri.localhost')) continue;
      try {
        if (
          (await p.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label)) ===
          'main'
        )
          page = p;
      } catch {}
    }
    return !!page;
  }, 'main WebView');
  await page.locator('.main-content h1').first().waitFor();
}
async function stop() {
  if (page) await call('quit').catch(() => {});
  if (app)
    await until(() => app.exitCode !== null || app.signalCode !== null, 'owned test process exit');
  await browser?.close().catch(() => {});
  page = undefined;
  browser = undefined;
  app = undefined;
}
try {
  await start();
  const before = await call('snapshot');
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page.getByText('常规设置', { exact: true }).waitFor();
  await page.getByRole('button', { name: '选择主题强调色' }).click();
  await page.getByRole('dialog', { name: '选择主题强调色' }).waitFor();
  assert.equal(await page.locator('input[type=color]').count(), 0);
  pass('Click opens an in-app color panel without native color input');
  await page.getByRole('button', { name: '颜色 #22c55e' }).click();
  await until(async () => (await accent()) === '#22c55e', 'palette preview');
  assert.equal((await call('snapshot')).config.settings.accent, before.config.settings.accent);
  pass('Palette previews immediately without implicitly saving');
  await page.getByRole('slider', { name: '红色分量' }).focus();
  await page.keyboard.press('Home');
  await until(async () => (await accent()) === '#00c55e', 'red slider');
  pass('RGB slider changes the actual theme');
  await page.getByLabel('颜色代码').fill('#zzzzzz');
  assert.ok(await page.getByRole('button', { name: '完成', exact: true }).isDisabled());
  assert.equal(await accent(), '#00c55e');
  await page.getByLabel('颜色代码').fill('#ec4899');
  await until(async () => (await accent()) === '#ec4899', 'hex preview');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  pass('Hex input validates and keeps invalid values out of theme CSS');
  await page.getByRole('button', { name: '保存外观设置', exact: true }).click();
  await until(
    async () => (await call('snapshot')).config.settings.accent === '#ec4899',
    'bottom save',
  );
  pass('Bottom appearance save persists custom accent');
  await page.getByRole('button', { name: '森林绿', exact: true }).click();
  await until(async () => (await accent()) === '#22c55e', 'preset accent');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await until(async () => {
    const d = await call('snapshot');
    return d.config.settings.accent === '#22c55e' && d.v2.extension.theme.preset === 'forest';
  }, 'unified top save');
  pass('Forest preset updates both accent and mode, and top save persists both');
  await page.getByRole('button', { name: '极简白', exact: true }).click();
  await until(async () => (await accent()) === '#2563eb', 'white accent');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.getByRole('button', { name: '选择主题强调色' }).click();
  await page.getByRole('button', { name: '颜色 #f97316' }).click();
  await until(async () => (await accent()) === '#f97316', 'orange preview');
  await delay(250);
  await page.screenshot({ path: join(root, 'docs/appearance-color-panel.png') });
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '保存外观设置', exact: true }).click();
  await until(
    async () => (await call('snapshot')).config.settings.accent === '#f97316',
    'light custom accent',
  );
  pass('Light preset supports a custom accent');
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await page.locator('.main-content h1').first().waitFor();
  assert.equal(await accent(), '#f97316');
  const after = await call('snapshot');
  assert.deepEqual(after.config.scenes, before.config.scenes);
  assert.deepEqual(after.config.tasks, before.config.tasks);
  assert.deepEqual(after.v2.extension.workflows, before.v2.extension.workflows);
  assert.deepEqual(after.v2.extension.shortcuts, before.v2.extension.shortcuts);
  pass('Navigation keeps saved color; scenes, tasks, workflows and shortcuts unchanged');
  await stop();
  await start();
  await until(async () => (await accent()) === '#f97316', 'restored theme');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.equal((await call('snapshot')).v2.extension.theme.preset, 'white');
  pass('Restart restores mode, preset and custom accent from SQLite');
  report.passed = true;
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.passed = false;
  report.error = String(error);
  throw error;
} finally {
  await stop().catch(() => {
    if (app && app.exitCode === null) app.kill();
  });
  await writeFile(
    join(root, 'docs/appearance-native-results.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
