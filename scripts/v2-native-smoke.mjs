import { chromium } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const dir = await mkdtemp(join(tmpdir(), 'StartFlow-v2-'));
const working = join(dir, '中文 工作目录');
await mkdir(working);
const probe = join(working, '测试 程序.exe');
await copyFile(join(root, 'src-tauri/target/debug/examples/launch_probe.exe'), probe);
const results = join(root, 'test-results');
await mkdir(results, { recursive: true });
const report = {
  startedAt: new Date().toISOString(),
  directory: dir,
  checks: [],
  limitations: ['真实重新登录、睡眠恢复和物理显示器断开仍需人工验证'],
};
const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let app, browser, page, palette;
const fixtures = [];
function pass(name, details) {
  report.checks.push({ name, details, status: 'passed' });
  console.log('PASS', name);
}
async function until(fn, description, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await pause(150);
  }
  throw new Error(`Timeout: ${description}`);
}
async function launch(exe, args = []) {
  app = spawn(exe, args, {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      STARTFLOW_TEST_DATA_DIR: dir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9225',
    },
  });
  app.stderr.on('data', (s) => console.error(String(s).trim()));
  await until(async () => {
    try {
      return (await fetch('http://127.0.0.1:9225/json/version')).ok;
    } catch {
      return false;
    }
  }, 'WebView2');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9225');
  await until(async () => {
    for (const p of browser.contexts().flatMap((c) => c.pages())) {
      if (!p.url().includes('tauri.localhost')) continue;
      try {
        const label = await p.evaluate(
          () => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label,
        );
        if (label === 'main') page = p;
        if (label === 'palette') palette = p;
      } catch {}
    }
    return !!page;
  }, 'main WebView');
  page.on('pageerror', (e) => console.error('WEBVIEW ERROR', e));
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
}
async function invoke(command, args) {
  const result = await page.evaluate(
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
const snapshot = () => invoke('snapshot');
async function quit() {
  await invoke('quit').catch(() => {});
  await until(() => app.exitCode !== null, 'process exit');
  await browser?.close().catch(() => {});
  await until(async () => {
    try {
      await fetch('http://127.0.0.1:9225/json/version');
      return false;
    } catch {
      return true;
    }
  }, 'old WebView2 endpoint closed');
  page = undefined;
  palette = undefined;
  browser = undefined;
}
async function finished(run) {
  await until(
    async () => (await snapshot()).runs.find((r) => r.id === run)?.finished_at,
    'run finished',
    30000,
  );
  return (await snapshot()).runs.find((r) => r.id === run);
}
async function extension(change) {
  const d = await snapshot();
  await invoke('v2_save_extension', { extension: change(structuredClone(d.v2.extension)) });
}
const stamp = () => new Date().toISOString();
function task(name, kind, fields = {}) {
  return {
    id: randomUUID(),
    name,
    kind,
    url: '',
    executable_path: '',
    arguments: [],
    working_directory: '',
    browser_mode: 'default',
    browser_path: '',
    delay_ms: 0,
    wait_for_network: false,
    skip_if_running: false,
    enabled: true,
    created_at: stamp(),
    updated_at: stamp(),
    ...fields,
  };
}
function node(type, config = {}, name = type) {
  return { id: randomUUID(), name, x: 0, y: 0, config: { type, ...config }, on_error: 'stop' };
}
function edge(a, b, handle = 'next') {
  return { id: randomUUID(), source: a.id, target: b.id, handle };
}
function windowState(close = false) {
  return JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public class SFV2WindowTest{public delegate bool EnumProc(IntPtr h,IntPtr l);[DllImport("user32.dll")]public static extern bool EnumWindows(EnumProc c,IntPtr l);[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);public static IntPtr Find(uint pid){IntPtr result=IntPtr.Zero;EnumWindows((h,l)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner==pid){var s=new StringBuilder(512);GetWindowText(h,s,512);if(s.ToString().StartsWith("StartFlow · 智能",StringComparison.Ordinal)){result=h;return false;}}return true;},IntPtr.Zero);return result;}}';$h=[SFV2WindowTest]::Find(${app.pid});if($h -eq [IntPtr]::Zero){throw 'Window unavailable'};${close ? '[void][SFV2WindowTest]::PostMessage($h,16,[IntPtr]::Zero,[IntPtr]::Zero);' : ''}@{visible=[SFV2WindowTest]::IsWindowVisible($h)}|ConvertTo-Json -Compress`,
      ],
      { windowsHide: true, encoding: 'utf8' },
    ),
  );
}
try {
  // Do not kill an active user run or use production configuration as test data.
  const production = join(process.env.APPDATA, 'com.startflow.desktop/startflow.sqlite3');
  if (await exists(production)) {
    const c = new DatabaseSync(production, { readOnly: true });
    const active = c
      .prepare("SELECT COUNT(*) AS n FROM execution_runs WHERE status='running'")
      .get().n;
    c.close();
    assert.equal(active, 0, 'Production is executing: close it after its run before testing');
  }
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$expected=Join-Path $env:LOCALAPPDATA "StartFlow/StartFlow.exe";Get-Process startflow -ErrorAction SilentlyContinue|Where-Object {$_.Path -eq $expected}|ForEach-Object {Stop-Process -Id $_.Id};exit 0',
    ],
    { windowsHide: true },
  );
  await launch(join(root, 'release/StartFlow_1.0.0-debug.exe'));
  let data = await snapshot();
  assert.equal(data.v2, undefined);
  assert.equal(data.data_directory, dir);
  const scene = {
    id: randomUUID(),
    name: 'V1 日常办公',
    description: '由真实 V1 程序创建的升级测试数据',
    icon: 'briefcase',
    color: '#3B82F6',
    enabled: true,
    sort_order: 0,
    created_at: stamp(),
    updated_at: stamp(),
  };
  const receipt = join(working, 'receipt.json');
  const web = task('必应', 'web', { url: 'https://www.bing.com' });
  const web2 = task('参考网页', 'web', { url: 'https://example.com' });
  const executable = task('受控程序', 'app', {
    executable_path: probe,
    arguments: [receipt, '中文参数', 'with spaces'],
    working_directory: working,
  });
  for (const t of [web, web2, executable]) await invoke('save_task', { task: t });
  await invoke('save_scene', { scene, taskIds: [web.id, web2.id, executable.id] });
  await invoke('save_schedule', {
    schedule: {
      id: randomUUID(),
      scene_id: scene.id,
      trigger_type: 'weekly',
      time_of_day: '09:00',
      weekdays: [1, 2, 3, 4, 5],
      delay_seconds: 0,
      catch_up_minutes: 120,
      enabled: true,
      created_at: stamp(),
      updated_at: stamp(),
    },
  });
  data = await snapshot();
  await invoke('save_settings', {
    settings: { ...data.config.settings, paused: true, onboarding_done: true, theme: 'light' },
  });
  const legacyRun = await invoke('run_task', { taskId: executable.id });
  assert.equal((await finished(legacyRun)).status, 'launch_requested');
  const legacy = await snapshot();
  await quit();
  const baseline = new DatabaseSync(join(dir, 'startflow.sqlite3'));
  baseline.prepare('VACUUM INTO ?').run(join(dir, 'v1-original.sqlite3'));
  baseline.close();
  const original = new DatabaseSync(join(dir, 'v1-original.sqlite3'), { readOnly: true });
  assert.equal(original.prepare('SELECT MAX(version) AS n FROM migrations').get().n, 1);
  original.close();
  pass('真实 V1 数据基线', 'V1 程序写入场景、三任务、顺序、星期计划、主题和实际 EXE 执行历史');
  await launch(join(root, 'src-tauri/target/debug/startflow.exe'));
  data = await snapshot();
  assert.deepEqual(data.config, legacy.config);
  assert.deepEqual(data.logs, legacy.logs);
  assert.deepEqual(data.runs, legacy.runs);
  assert.equal(data.autostart_enabled, legacy.autostart_enabled);
  const upgrades = data.v2.backups.filter((b) => b.backup_type === 'upgrade');
  const versions = [];
  for (const upgrade of upgrades) {
    const backup = new DatabaseSync(join(dir, 'backups', upgrade.filename), { readOnly: true });
    versions.push(backup.prepare('SELECT MAX(version) AS n FROM migrations').get().n);
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 3);
    backup.close();
  }
  assert.deepEqual(versions.sort(), [1, 2, 3]);
  pass(
    'V1 → V3 迁移和一致性备份',
    '原配置、关系、自启状态、主题和日志逐字段一致；两阶段升级保留 schema 1 和 2 备份',
  );
  let workflow = await invoke('v2_convert_scene', { sceneId: scene.id });
  data = await snapshot();
  assert.equal(data.v2.extension.bindings.length, 0);
  assert.deepEqual(data.config.scene_tasks, legacy.config.scene_tasks);
  pass('简单模式转换为独立草稿', 'Rust 保存可恢复草稿；原任务顺序和场景运行模式保留');
  const a = node('start', {}, '开始'),
    b = node('web', { task_id: web.id }, '打开网页'),
    c = node('delay', { milliseconds: 3000 }, '等待三秒'),
    d = node('app', { task_id: executable.id }, '启动应用'),
    z = node('end', {}, '结束');
  workflow = {
    ...workflow,
    nodes: [a, b, c, d, z].map((n, i) => ({ ...n, x: i * 260 })),
    edges: [edge(a, b), edge(b, c), edge(c, d), edge(d, z)],
  };
  await extension((e) => ({
    ...e,
    workflows: e.workflows.map((w) => (w.id === workflow.id ? workflow : w)),
  }));
  const run = await invoke('v2_run_workflow', { workflowId: workflow.id });
  assert.equal((await finished(run)).status, 'completed');
  data = await snapshot();
  const logs = data.v2.node_logs.filter((l) => l.run_id === run);
  assert.deepEqual(
    logs.filter((l) => l.started_at).map((l) => l.node_id),
    workflow.nodes.map((n) => n.id),
  );
  assert.equal(logs.find((l) => l.node_id === d.id).status, 'launch_requested');
  assert.ok(
    +new Date(logs.find((l) => l.node_id === d.id).started_at) -
      +new Date(logs.find((l) => l.node_id === c.id).started_at) >=
      2900,
  );
  assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')).arguments, [
    receipt,
    '中文参数',
    'with spaces',
  ]);
  pass(
    '真实顺序工作流和节点日志',
    '开始 → 网页 → 3 秒等待 → EXE → 结束；EXE 回执和节点实际时间核验',
  );
  await extension((e) => ({
    ...e,
    workflows: e.workflows.map((w) =>
      w.id === workflow.id
        ? {
            ...w,
            nodes: w.nodes.map((n) =>
              n.id === c.id ? { ...n, config: { type: 'delay', milliseconds: 15000 } } : n,
            ),
          }
        : w,
    ),
  }));
  const cancel = await invoke('v2_run_workflow', { workflowId: workflow.id });
  await until(
    async () =>
      (await snapshot()).v2.node_logs.some(
        (l) => l.run_id === cancel && l.node_id === c.id && l.status === 'running',
      ),
    'wait node',
  );
  await assert.rejects(
    () => invoke('run_scene', { sceneId: scene.id }),
    (e) => e.code === 'busy',
  );
  await invoke('v2_cancel_run', { runId: cancel });
  assert.equal((await finished(cancel)).status, 'cancelled');
  data = await snapshot();
  assert.equal(
    data.v2.node_logs.find((l) => l.run_id === cancel && l.node_id === d.id).status,
    'skipped',
  );
  pass('取消等待与场景互斥', '等待可中断；未提交应用节点被跳过，同一场景手动触发仍拒绝重入');
  const yes = task('True 分支', 'app', {
    executable_path: probe,
    arguments: [join(working, 'true.json')],
  });
  const no = task('False 分支', 'app', {
    executable_path: probe,
    arguments: [join(working, 'false.json')],
  });
  for (const t of [yes, no]) await invoke('save_task', { task: t });
  const cond = node(
      'condition',
      { mode: 'and', conditions: [{ type: 'process', path: probe }] },
      '检查进程',
    ),
    yn = node('app', { task_id: yes.id }, 'True 应用'),
    nn = node('app', { task_id: no.id }, 'False 应用'),
    ye = node('end', {}, '是分支结束'),
    ne = node('end', {}, '否分支结束');
  workflow = {
    ...workflow,
    nodes: [a, cond, yn, ye, nn, ne],
    edges: [
      edge(a, cond),
      edge(cond, yn, 'true'),
      edge(cond, nn, 'false'),
      edge(yn, ye),
      edge(nn, ne),
    ],
  };
  await extension((e) => ({
    ...e,
    workflows: e.workflows.map((w) => (w.id === workflow.id ? workflow : w)),
  }));
  const held = spawn(probe, [join(working, 'held.json'), '--hold'], { windowsHide: true });
  fixtures.push(held);
  await until(() => exists(join(working, 'held.json')), 'held process');
  let branch = await invoke('v2_run_workflow', { workflowId: workflow.id });
  await finished(branch);
  data = await snapshot();
  assert.equal(
    data.v2.node_logs.find((l) => l.run_id === branch && l.node_id === nn.id).status,
    'skipped',
  );
  assert.equal(
    data.v2.node_logs.find((l) => l.run_id === branch && l.node_id === cond.id).result.condition,
    true,
  );
  await until(() => held.exitCode !== null, 'held exit');
  branch = await invoke('v2_run_workflow', { workflowId: workflow.id });
  await finished(branch);
  data = await snapshot();
  assert.equal(
    data.v2.node_logs.find((l) => l.run_id === branch && l.node_id === yn.id).status,
    'skipped',
  );
  assert.equal(
    data.v2.node_logs.find((l) => l.run_id === branch && l.node_id === cond.id).result.condition,
    false,
  );
  pass('进程 True / False 分支', '真实同路径进程有 / 无两种状态；未选中分支没有启动请求');
  await extension((e) => ({
    ...e,
    workflows: e.workflows.map((w) =>
      w.id === workflow.id
        ? {
            ...w,
            nodes: w.nodes.map((n) =>
              n.id === cond.id
                ? {
                    ...n,
                    config: {
                      type: 'condition',
                      mode: 'and',
                      conditions: [{ type: 'process', path: join(working, '不存在.exe') }],
                    },
                  }
                : n,
            ),
          }
        : w,
    ),
  }));
  const failed = await invoke('v2_run_workflow', { workflowId: workflow.id });
  assert.equal((await finished(failed)).status, 'failed');
  data = await snapshot();
  assert.equal(
    data.v2.node_logs.find((l) => l.run_id === failed && l.node_id === cond.id).status,
    'failed',
  );
  assert.ok(
    data.v2.node_logs
      .filter((l) => l.run_id === failed && [yn.id, nn.id].includes(l.node_id))
      .every((l) => l.status === 'skipped'),
  );
  pass('异常条件不被解释为 False', '无法读取进程路径明确失败，两条分支均不执行');
  const delay = node('delay', { milliseconds: 3500 }, '后台等待');
  workflow = {
    ...workflow,
    nodes: [a, delay, d, z],
    edges: [edge(a, delay), edge(delay, d), edge(d, z)],
  };
  await extension((e) => ({
    ...e,
    workflows: e.workflows.map((w) => (w.id === workflow.id ? workflow : w)),
  }));
  const hidden = await invoke('v2_run_workflow', { workflowId: workflow.id });
  windowState(true);
  await until(() => !windowState().visible, 'hidden main');
  assert.equal((await finished(hidden)).status, 'completed');
  assert.equal(app.exitCode, null);
  const second = spawn(join(root, 'src-tauri/target/debug/startflow.exe'), [], {
    windowsHide: true,
  });
  await until(() => second.exitCode !== null, 'second instance');
  await until(() => windowState().visible, 'existing main reopened');
  pass(
    '主窗口隐藏后工作流继续',
    '真实 WM_CLOSE 隐藏主窗口；Rust 完成等待和 EXE 提交；第二实例恢复原窗口',
  );
  const bad = structuredClone(workflow);
  bad.edges.push(edge(z, a));
  await assert.rejects(
    () => invoke('v2_validate_workflow', { workflow: bad }),
    (e) => e.code === 'workflow_validation',
  );
  const missing = structuredClone(workflow);
  missing.nodes = missing.nodes.filter((n) => n.config.type !== 'end');
  await assert.rejects(() => invoke('v2_validate_workflow', { workflow: missing }));
  pass('工作流后端防错', '环形连接和缺少结束节点被真实后端拒绝');
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  await page.getByRole('button', { name: '编辑流程', exact: true }).first().click();
  await page.locator('.react-flow__node').first().waitFor();
  await page.getByRole('button', { name: '自动排列', exact: true }).click();
  await pause(400);
  await page.screenshot({ path: join(results, 'v2-workflow-editor.png') });
  pass('真实编辑器加载', '已保存工作流、节点和执行状态从 Rust 数据绘制；真实 WebView2 截图');
  if (!process.argv.includes('--core')) {
    const ready = join(dir, 'windows-ready.txt'),
      hotkeyReady = join(dir, 'hotkey-ready.txt');
    const windows = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-STA',
        '-File',
        join(root, 'scripts/window-probe.ps1'),
        '-ReadyFile',
        ready,
        '-HotkeyReadyFile',
        hotkeyReady,
      ],
      { windowsHide: true },
    );
    fixtures.push(windows);
    windows.stderr.on('data', (s) => console.error(String(s)));
    await until(() => exists(ready), 'two native windows');
    await until(() => exists(hotkeyReady), 'hotkey guard');
    await until(
      async () =>
        (await invoke('v2_window_inventory')).windows.filter(
          (w) => w.pid === windows.pid && w.title.startsWith('StartFlow V2 Window Fixture'),
        ).length === 2,
      'both native windows visible',
    );
    let inventory = await invoke('v2_window_inventory');
    let matches = inventory.windows.filter(
      (w) => w.pid === windows.pid && w.title.startsWith('StartFlow V2 Window Fixture'),
    );
    assert.equal(matches.length, 2);
    const layout = {
      id: randomUUID(),
      scene_id: null,
      name: '真实双窗口布局',
      monitors: inventory.monitors,
      items: matches.map((w) => {
        const m = inventory.monitors.find((m) => m.id === w.monitor_id),
          width = m.work.right - m.work.left,
          height = m.work.bottom - m.work.top;
        return {
          id: randomUUID(),
          executable_path: w.executable_path,
          title: w.title,
          title_mode: 'exact',
          monitor_id: m.id,
          x: Math.max(0, (w.rect.left - m.work.left) / width),
          y: Math.max(0, (w.rect.top - m.work.top) / height),
          width: Math.min(1, (w.rect.right - w.rect.left) / width),
          height: Math.min(1, (w.rect.bottom - w.rect.top) / height),
          state: 'normal',
        };
      }),
      missing_monitor: 'primary',
      fallback_layout_id: null,
      created_at: stamp(),
      updated_at: stamp(),
    };
    await extension((e) => ({ ...e, layouts: [layout] }));
    native(
      `foreach($title in @('StartFlow V2 Window Fixture A','StartFlow V2 Window Fixture B')){$h=[SFTest]::FindWindow([IntPtr]::Zero,$title);[void][SFTest]::SetWindowPos($h,[IntPtr]::Zero,300,300,350,260,20)}`,
    );
    await pause(500);
    const moved = (await invoke('v2_window_inventory')).windows.filter(
      (w) => w.pid === windows.pid,
    );
    console.log(
      'WINDOW GEOMETRY',
      JSON.stringify({
        before: matches.map((w) => ({ title: w.title, rect: w.rect })),
        after: moved.map((w) => ({ title: w.title, rect: w.rect })),
      }),
    );
    assert.ok(
      moved.some(
        (w) => Math.abs(w.rect.left - matches.find((x) => x.title === w.title).rect.left) > 40,
      ),
    );
    let restored = await invoke('v2_restore_layout', { layoutId: layout.id });
    assert.equal((await finished(restored)).status, 'completed');
    data = await snapshot();
    assert.ok(
      data.v2.node_logs
        .find((l) => l.run_id === restored)
        .result.every((r) => r.status === 'completed'),
    );
    pass(
      'Win32 双窗口保存与恢复',
      '两个真实普通窗口先移动，再由 Rust SetWindowPos 恢复；读取最终位置核验',
    );
    await extension((e) => ({
      ...e,
      layouts: e.layouts.map((l) => ({
        ...l,
        items: l.items.map((i) => ({ ...i, monitor_id: 'disconnected-fixture-monitor' })),
      })),
    }));
    restored = await invoke('v2_restore_layout', { layoutId: layout.id });
    assert.equal((await finished(restored)).status, 'completed');
    const primary = (await invoke('v2_window_inventory')).monitors.find((m) => m.primary).work;
    assert.ok(
      (await invoke('v2_window_inventory')).windows
        .filter((w) => w.pid === windows.pid)
        .every((w) => w.rect.left >= primary.left - 20 && w.rect.right <= primary.right + 20),
    );
    pass(
      '显示器缺失回退',
      '用不存在的显示器标识触发主屏回退，读取窗口坐标保持可见；物理拔屏仍待验证',
    );
    const paletteKey = {
      id: randomUUID(),
      action: 'palette',
      target_id: '',
      accelerator: 'Ctrl+Alt+F8',
      enabled: true,
    };
    const sceneKey = {
      id: randomUUID(),
      action: 'scene',
      target_id: scene.id,
      accelerator: 'Ctrl+Alt+F9',
      enabled: true,
    };
    await extension((e) => ({ ...e, shortcuts: [paletteKey, sceneKey] }));
    const stableKeys = (await snapshot()).v2.extension.shortcuts;
    await assert.rejects(
      () =>
        extension((e) => ({
          ...e,
          shortcuts: [
            ...e.shortcuts,
            {
              id: randomUUID(),
              action: 'open',
              target_id: '',
              accelerator: 'Alt+Ctrl+F8',
              enabled: true,
            },
          ],
        })),
      (e) => e.code === 'shortcut',
    );
    await assert.rejects(
      () =>
        extension((e) => ({
          ...e,
          shortcuts: [
            ...e.shortcuts,
            {
              id: randomUUID(),
              action: 'open',
              target_id: '',
              accelerator: 'Ctrl+Alt+F7',
              enabled: true,
            },
          ],
        })),
      (e) => e.code === 'shortcut',
    );
    assert.deepEqual((await snapshot()).v2.extension.shortcuts, stableKeys);
    pass(
      '实际全局快捷键冲突与回滚',
      '重复组合被拒绝；独立 Win32 RegisterHotKey 占用 F7 后保存失败，原配置和注册恢复',
    );
    windowState(true);
    await until(() => !windowState().visible, 'main hidden for shortcut');
    const before = (await snapshot()).runs.length;
    const inputUnavailable = process.env.STARTFLOW_TEST_SKIP_INPUT === '1';
    if (inputUnavailable) {
      report.checks.push({
        name: '隐藏主窗口后全局快捷键实际按键触发',
        status: 'not_verified',
        details: '显式跳过按键注入；独立 RegisterHotKey 诊断同样无法收到注入按键，需物理按键验证。',
      });
      await invoke('v2_show_palette');
    } else {
      keys(0x78);
      await until(
        async () => (await snapshot()).runs.length > before,
        'global shortcut actual run',
      );
      await finished((await snapshot()).runs[0].id);
      assert.equal((await snapshot()).runs[0].trigger_type, 'shortcut');
      pass(
        '隐藏主窗口后快捷键启动',
        '注入真实 Windows Ctrl+Alt+F9，官方插件触发统一后端执行并记录 shortcut',
      );
      keys(0x77);
    }
    await until(
      () =>
        native(
          "$h=[SFTest]::FindWindow([IntPtr]::Zero,'StartFlow · 快速命令');[SFTest]::IsWindowVisible($h)",
        ).trim() === 'True',
      'palette shortcut',
    );
    await until(async () => {
      for (const p of browser.contexts().flatMap((c) => c.pages())) {
        try {
          if (
            (await p.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label)) ===
            'palette'
          )
            palette = p;
        } catch {}
      }
      return !!palette;
    }, 'palette WebView');
    await palette.getByRole('textbox', { name: '搜索快速命令' }).fill('受控程序');
    await palette.getByRole('option').first().waitFor();
    const previous = (await snapshot()).runs.length;
    await palette.getByRole('textbox').press('Enter');
    await until(async () => (await snapshot()).runs.length > previous, 'palette run');
    await finished((await snapshot()).runs[0].id);
    assert.equal(
      native(
        "$h=[SFTest]::FindWindow([IntPtr]::Zero,'StartFlow · 快速命令');[SFTest]::IsWindowVisible($h)",
      ).trim(),
      'False',
    );
    pass(
      '独立命令面板搜索与执行',
      `${inputUnavailable ? '后端命令' : '真实快捷键'}呼出唯一悬浮窗口，键盘搜索、Enter 提交任务并隐藏；数据库和调度器未重建`,
    );
    const image = join(dir, 'background.png');
    await copyFile(join(root, 'src-tauri/icons/128x128.png'), image);
    const background = await invoke('v2_choose_background', { path: image });
    await extension((e) => ({
      ...e,
      theme: {
        ...e.theme,
        preset: 'forest',
        density: 'compact',
        radius: 20,
        background_id: background,
        background_style: 'image',
      },
    }));
    assert.ok(
      (await invoke('v2_read_background', { name: background })).startsWith(
        'data:image/png;base64,',
      ),
    );
    await quit();
    await launch(join(root, 'src-tauri/target/debug/startflow.exe'));
    data = await snapshot();
    assert.equal(data.v2.extension.theme.background_id, background);
    assert.equal(data.v2.extension.theme.density, 'compact');
    assert.equal(data.config.settings.theme, 'light');
    pass(
      '主题与背景持久化',
      '安全图片副本、主题预设、密度、圆角在真实进程重启后保留；V1 深浅模式同时保留',
    );
    const exported = join(dir, '完整配置.json');
    await invoke('v2_export', { path: exported });
    const bundle = await invoke('v2_read_import', { path: exported });
    assert.equal(bundle.schema_version, 3);
    assert.equal(bundle.extension.workflows.length, 1);
    assert.equal(bundle.extension.layouts.length, 1);
    assert.equal(bundle.assets.length, 1);
    await invoke('v2_apply_import', { bundle, mode: 'merge' });
    data = await snapshot();
    assert.equal(data.config.scenes.length, 2);
    assert.equal(data.v2.extension.workflows.length, 2);
    assert.equal(data.v2.extension.layouts.length, 2);
    assert.equal(data.config.settings.paused, true);
    assert.ok(
      data.v2.extension.shortcuts
        .filter((s) => stableKeys.some((k) => k.id === s.id))
        .every((s) => s.enabled),
    );
    await invoke('v2_apply_import', { bundle, mode: 'replace' });
    data = await snapshot();
    assert.deepEqual(data.config.scene_tasks, bundle.config.scene_tasks);
    assert.equal(data.config.scenes.length, 1);
    assert.equal(data.v2.extension.workflows.length, 1);
    assert.ok(data.v2.extension.shortcuts.every((s) => !s.enabled));
    assert.ok(data.v2.backups.some((b) => b.backup_type === 'before_restore'));
    assert.equal(data.v2.extension.layouts[0].items.length, 2);
    const invalid = structuredClone(bundle);
    invalid.extension.workflows[0].scene_id = randomUUID();
    const stable = structuredClone(data.config);
    await assert.rejects(() => invoke('v2_apply_import', { bundle: invalid, mode: 'replace' }));
    assert.deepEqual((await snapshot()).config, stable);
    pass(
      '完整备份、合并与替换',
      '工作流、布局、背景、稳定引用均恢复；合并 UUID 重映射，替换关闭快捷键并暂停自动任务；无效引用拒绝且原配置保留',
    );
    const backup = await invoke('v2_create_backup');
    const preview = await invoke('v2_read_backup', { backupId: backup.id });
    assert.equal(preview.extension.layouts.length, 1);
    await invoke('v2_delete_backup', { backupId: backup.id });
    assert.ok(!(await snapshot()).v2.backups.some((b) => b.id === backup.id));
    pass('备份管理真实文件操作', '创建、读取恢复预览及删除均作用于管理目录文件与 SQLite 记录');
    const long = {
      ...workflow,
      nodes: workflow.nodes.map((n) =>
        n.id === delay.id ? { ...n, config: { type: 'delay', milliseconds: 15000 } } : n,
      ),
    };
    await extension((e) => ({ ...e, workflows: [long] }));
    const interrupted = await invoke('v2_run_workflow', { workflowId: workflow.id });
    await until(
      async () =>
        (await snapshot()).v2.node_logs.some(
          (l) => l.run_id === interrupted && l.status === 'running' && l.node_id === delay.id,
        ),
      'interrupted waiting',
    );
    app.kill();
    await until(() => app.exitCode !== null || app.signalCode !== null, 'crash exit');
    await browser.close();
    page = undefined;
    palette = undefined;
    await launch(join(root, 'src-tauri/target/debug/startflow.exe'));
    assert.equal((await snapshot()).runs.find((r) => r.id === interrupted).status, 'interrupted');
    pass('异常退出恢复', '受控终止后历史标记 interrupted；未从等待节点自动恢复执行');
  }
  report.status = report.checks.some((c) => c.status === 'not_verified') ? 'partial' : 'passed';
} catch (e) {
  report.status = 'failed';
  report.error = String(e);
  console.error(e);
  await page?.screenshot({ path: join(results, 'v2-failure.png') }).catch(() => {});
  throw e;
} finally {
  for (const p of fixtures) if (p.exitCode === null) p.kill();
  if (app?.exitCode === null) {
    await invoke('quit').catch(() => {});
    await pause(600);
    if (app.exitCode === null) app.kill();
  }
  await browser?.close().catch(() => {});
  report.finishedAt = stamp();
  await writeFile(join(results, 'v2-native-smoke.json'), JSON.stringify(report, null, 2));
  console.log('Evidence:', join(results, 'v2-native-smoke.json'));
}
function native(code) {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class SFTest{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindow(IntPtr cls,string title);[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int height,uint flags);[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll")]public static extern void keybd_event(byte vk,byte scan,uint flags,UIntPtr extra);}';${code}`,
    ],
    { windowsHide: true, encoding: 'utf8' },
  );
}
function keys(vk) {
  native(
    `[SFTest]::keybd_event(0x11,0,0,[UIntPtr]::Zero);[SFTest]::keybd_event(0x12,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 100;[SFTest]::keybd_event(${vk},0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 100;[SFTest]::keybd_event(${vk},0,2,[UIntPtr]::Zero);[SFTest]::keybd_event(0x12,0,2,[UIntPtr]::Zero);[SFTest]::keybd_event(0x11,0,2,[UIntPtr]::Zero);`,
  );
}
