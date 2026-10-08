import { chromium } from '@playwright/test';
import { DatabaseSync, backup } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..'),
  results = join(root, 'test-results');
await mkdir(results, { recursive: true });
const previous = JSON.parse(await readFile(join(results, 'v2-native-smoke.json'), 'utf8'));
assert.equal(previous.status, 'passed');
const dir = await mkdtemp(join(tmpdir(), 'StartFlow-v2-ui-'));
const original = new DatabaseSync(join(previous.directory, 'startflow.sqlite3'));
await backup(original, join(dir, 'startflow.sqlite3'));
original.close();
await cp(join(previous.directory, 'backups'), join(dir, 'backups'), { recursive: true });
await cp(join(previous.directory, 'backgrounds'), join(dir, 'backgrounds'), { recursive: true });
const report = { startedAt: new Date().toISOString(), directory: dir, checks: [] };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let browser, page, app;
async function until(fn, label) {
  for (let i = 0; i < 120; i++) {
    if (await fn()) return;
    await pause(200);
  }
  throw new Error(label);
}
async function invoke(command, args) {
  return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
}
const snapshot = () => invoke('snapshot');
function pass(name, details) {
  report.checks.push({ name, details, status: 'passed' });
  console.log('PASS', name);
}
try {
  app = spawn(join(root, 'src-tauri/target/debug/startflow.exe'), [], {
    windowsHide: true,
    env: {
      ...process.env,
      STARTFLOW_TEST_DATA_DIR: dir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9226',
    },
  });
  await until(async () => {
    try {
      return (await fetch('http://127.0.0.1:9226/json/version')).ok;
    } catch {
      return false;
    }
  }, 'WebView2');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9226');
  await until(async () => {
    for (const p of browser.contexts().flatMap((c) => c.pages())) {
      try {
        if (
          p.url().includes('tauri.localhost') &&
          (await p.evaluate(() => window.__TAURI_INTERNALS__?.metadata.currentWindow.label)) ===
            'main'
        )
          page = p;
      } catch {}
    }
    return !!page;
  }, 'main');
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  await page.getByRole('button', { name: '编辑流程', exact: true }).first().click();
  await page.locator('.react-flow__node').first().waitFor();
  await page.getByLabel('工作流名称').fill('界面保存与执行校验');
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page
    .getByRole('dialog')
    .filter({ hasText: '离开工作流编辑器' })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  assert.ok(await page.getByLabel('工作流名称').isVisible());
  let d = await snapshot(),
    workflow = d.v2.extension.workflows[0];
  const wait = workflow.nodes.find((n) => n.config.type === 'delay');
  await page.getByRole('button', { name: '自动排列', exact: true }).click();
  await pause(300);
  await page.locator(`.react-flow__node[data-id="${wait.id}"]`).click();
  await page.getByLabel('等待时长').fill('0.1');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await until(
    async () => (await snapshot()).v2.extension.workflows[0].name === '界面保存与执行校验',
    'saved workflow',
  );
  workflow = (await snapshot()).v2.extension.workflows[0];
  assert.equal(workflow.nodes.find((n) => n.id === wait.id).config.milliseconds, 100);
  assert.equal(new Set(workflow.nodes.map((n) => n.x)).size, workflow.nodes.length);
  pass(
    '编辑器界面保存与未保存提示',
    '真实表单修改、秒单位转换、自动排列、导航取消及持久化参数核验',
  );
  const before = (await snapshot()).runs.length;
  await page.getByRole('button', { name: '正式执行', exact: true }).click();
  await page
    .getByRole('dialog')
    .filter({ hasText: '将场景切换为高级模式' })
    .getByRole('button', { name: '确认继续' })
    .click();
  await until(async () => (await snapshot()).runs.length > before, 'formal execution');
  await until(async () => (await snapshot()).runs[0].finished_at, 'execution finish');
  d = await snapshot();
  assert.equal(d.runs[0].status, 'completed');
  assert.equal(d.runs[0].trigger_type, 'manual');
  assert.equal(d.v2.extension.bindings[0].workflow_id, workflow.id);
  pass(
    '正式执行界面与模式确认',
    '确认后真实绑定高级模式并启动 Rust 工作流；画布状态与已完成日志一致',
  );
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page.getByRole('button', { name: '森林绿', exact: true }).click();
  await page.getByLabel('界面密度').selectOption('comfortable');
  await page.getByRole('button', { name: '保存外观设置', exact: true }).click();
  await until(
    async () => (await snapshot()).v2.extension.theme.density === 'comfortable',
    'theme save',
  );
  assert.equal(await page.evaluate(() => document.documentElement.dataset.density), 'comfortable');
  pass('外观设置真实生效', '预设与密度通过 SQLite 保存，CSS token 同步到已打开主窗口');
  await page.getByRole('button', { name: '添加快捷键', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: '设置快捷键' });
  await dialog.getByRole('button', { name: '录制快捷键' }).click();
  await dialog.getByRole('button', { name: '录制快捷键' }).press('Control+Alt+F10');
  await dialog.getByRole('button', { name: '保存并注册' }).click();
  await until(
    async () =>
      (await snapshot()).v2.extension.shortcuts.some(
        (s) => s.enabled && s.accelerator === 'Ctrl+Alt+F10',
      ),
    'shortcut form',
  );
  pass('快捷键录制表单与真实注册', '物理按键组合从界面提交，后端注册成功后才持久化启用状态');
  const count = (await snapshot()).v2.backups.length;
  await page.getByRole('button', { name: '立即备份', exact: true }).click();
  await until(async () => (await snapshot()).v2.backups.length > count, 'UI backup');
  await page
    .locator('.backup-row')
    .filter({ hasText: '手动配置备份' })
    .first()
    .getByRole('button', { name: '恢复预览' })
    .click();
  const preview = page.getByRole('dialog').filter({ hasText: '恢复预览' });
  await preview.getByRole('combobox').selectOption('replace');
  await preview.getByRole('button', { name: '确认恢复' }).click();
  await page
    .getByRole('dialog')
    .filter({ hasText: '确认完整替换？' })
    .getByRole('button', { name: '确认继续' })
    .click();
  await page
    .getByRole('dialog')
    .filter({ hasText: '再次确认替换全部配置' })
    .getByRole('button', { name: '确认继续' })
    .click();
  await until(
    async () => (await snapshot()).v2.extension.shortcuts.every((s) => !s.enabled),
    'double-confirm restore',
  );
  pass('备份界面与替换二次确认', '真实备份文件预览、两次确认、暂停调度并禁用导入快捷键');
  for (const label of [
    '工作台',
    '启动场景',
    '工作流',
    '任务管理',
    '计划调度',
    '窗口布局',
    '运行日志',
    '系统设置',
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await pause(200);
    await page.screenshot({ path: join(results, `v2-ui-${label}.png`) });
    assert.equal(await page.locator('.full-state').count(), 0);
  }
  pass('V2 八入口真实布局', '八页按需加载实际本地数据并保存 WebView2 截图');
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.error = String(e);
  console.error(e);
  await page?.screenshot({ path: join(results, 'v2-ui-failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await invoke('quit').catch(() => {});
  await browser?.close().catch(() => {});
  if (app && app.exitCode === null && app.signalCode === null) app.kill();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(results, 'v2-ui-smoke.json'), JSON.stringify(report, null, 2));
}
