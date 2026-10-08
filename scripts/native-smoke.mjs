import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// Real Windows WebView2 + real Rust commands; no IPC mocks or fake launch results.
// Tests run in debug-only isolated storage and do not leave autostart enabled.
const root = resolve(import.meta.dirname, '..');
const exe = join(root, 'src-tauri', 'target', 'debug', 'startflow.exe');
const probeSource = join(root, 'src-tauri', 'target', 'debug', 'examples', 'launch_probe.exe');
const dir = await mkdtemp(join(tmpdir(), 'StartFlow-native-'));
const results = join(root, 'test-results');
await mkdir(results, { recursive: true });
const working = join(dir, '中文 工作目录');
await mkdir(working);
const probe = join(working, '测试 程序.exe');
await copyFile(probeSource, probe);
const report = {
  platform: process.platform,
  startedAt: new Date().toISOString(),
  directory: dir,
  checks: [],
  limitations: [
    '默认浏览器和资源管理器的窗口内容需人工观察',
    '原生文件选择器、托盘点击、真实退出登录与睡眠恢复需人工验证',
  ],
};
let app;
let browser;
let page;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await pause(200);
  }
  throw new Error(`Timeout: ${description}`);
}
function pass(name, details) {
  report.checks.push({ name, status: 'passed', details });
  console.log(`PASS ${name}`);
}
async function attach() {
  page = undefined;
  await until(async () => {
    try {
      return (await fetch('http://127.0.0.1:9223/json/version')).ok;
    } catch {
      return false;
    }
  }, 'WebView2 CDP');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
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
  }, 'local WebView');
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
}
function launch(args = []) {
  app = spawn(exe, args, {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      STARTFLOW_TEST_DATA_DIR: dir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223',
    },
  });
  app.stderr.on('data', (s) => console.error(String(s).trim()));
}
function windowState(close = false, handle = 0) {
  const command = `Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public class StartFlowWindowTest { public delegate bool EnumProc(IntPtr h,IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc c,IntPtr l); [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); public static IntPtr FindMain(uint pid){IntPtr result=IntPtr.Zero;EnumWindows((h,l)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner==pid){var title=new StringBuilder(512);GetWindowText(h,title,512);if(title.ToString().StartsWith("StartFlow · 智能",StringComparison.Ordinal)){result=h;return false;}}return true;},IntPtr.Zero);return result;} }'; $p=Get-Process -Id ${app.pid}; $h=${handle ? `[IntPtr]${handle}` : '[StartFlowWindowTest]::FindMain($p.Id)'}; if($h -eq [IntPtr]::Zero){throw "Main window not found"}; ${close ? '[uint32]$owner=0;[void][StartFlowWindowTest]::GetWindowThreadProcessId($h,[ref]$owner);if($owner -ne $p.Id){throw "Unexpected window owner"};[void][StartFlowWindowTest]::PostMessage($h,16,[IntPtr]::Zero,[IntPtr]::Zero);' : ''} @{handle=$h.ToInt64();visible=[StartFlowWindowTest]::IsWindowVisible($h)}|ConvertTo-Json -Compress`;
  return JSON.parse(
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      encoding: 'utf8',
    }),
  );
}
const invoke = async (command, args) => {
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
};
const snapshot = () => invoke('snapshot');
const runFinished = async (runId) => {
  await until(async () => {
    const d = await snapshot();
    return d.runs.find((r) => r.id === runId)?.finished_at;
  }, 'run completion');
  return (await snapshot()).runs.find((r) => r.id === runId);
};
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
function scene(name) {
  return {
    id: randomUUID(),
    name,
    description: 'Windows 原生验收测试',
    icon: 'briefcase',
    color: '#3B82F6',
    enabled: true,
    sort_order: 0,
    created_at: stamp(),
    updated_at: stamp(),
  };
}
try {
  assert.equal(process.platform, 'win32');
  launch();
  await attach();
  let d = await snapshot();
  assert.equal(resolve(d.data_directory), resolve(dir));
  assert.equal(d.config.scenes.length, 0);
  assert.equal(d.autostart_enabled, false);
  await page.getByRole('heading', { name: '欢迎使用 StartFlow', exact: true }).waitFor();
  await page.screenshot({ path: join(results, 'onboarding.png') });
  await page.getByRole('button', { name: '跳过引导' }).click();
  await page.getByRole('heading', { name: /让工作，从容开始/ }).waitFor();
  d = await snapshot();
  await invoke('save_settings', { settings: { ...d.config.settings, notifications: false } });
  pass('真实 WebView2 启动与首次引导', '初始化 SQLite，首次自启关闭，跳过引导保存到数据库');

  // UI interaction (not just backend CRUD): create scene, edit it, add task.
  await page.getByRole('button', { name: '启动场景', exact: false }).click();
  await page.getByRole('button', { name: '创建场景', exact: true }).first().click();
  await page.getByLabel('场景名称', { exact: true }).fill('日常办公');
  await page.getByLabel('场景描述', { exact: true }).fill('邮箱、创作平台与工作文件夹，一键准备。');
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  await page.getByRole('heading', { name: '日常办公', exact: true }).waitFor();
  d = await snapshot();
  const office = d.config.scenes[0];
  assert.equal(office.name, '日常办公');
  await page.getByRole('button', { name: '编辑 日常办公', exact: true }).click();
  await page.getByLabel('场景描述', { exact: true }).fill('今天的工作，从这里开始。');
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  assert.equal((await snapshot()).config.scenes[0].description, '今天的工作，从这里开始。');
  pass('界面创建与编辑场景', '真实点击后读取 SQLite 确认数据变化');

  await page.getByRole('button', { name: '任务管理', exact: true }).click();
  await page.getByRole('button', { name: '添加任务', exact: true }).first().click();
  await page.getByLabel('任务名称', { exact: true }).fill('工作搜索');
  await page.getByLabel('目标网址', { exact: true }).fill('https://www.bing.com');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await page.getByText('工作搜索', { exact: true }).waitFor();
  d = await snapshot();
  const bing = d.config.tasks.find((t) => t.name === '工作搜索');
  const web2 = task('参考网页', 'web', { url: 'https://example.com' });
  await invoke('save_task', { task: web2 });
  const output = join(dir, '启动 参数回执.json');
  const exeTask = task('工作应用', 'app', {
    executable_path: probe,
    arguments: [output, '--name', '中文 内容', 'quote"inside', 'C:\\末尾\\'],
    working_directory: working,
  });
  await invoke('save_task', { task: exeTask });
  const missing = task('错误路径', 'app', { executable_path: join(dir, '不存在.exe') });
  await invoke('save_task', { task: missing });
  const folder = task('工作文件夹', 'folder', { executable_path: working });
  await invoke('save_task', { task: folder });
  // Acceptance 1: real ShellExecuteW. This validates request acceptance, not browser readiness.
  await page.getByRole('button', { name: '测试运行', exact: true }).first().click();
  await until(async () => {
    const s = await snapshot();
    return s.logs.some((l) => l.task_id === bing.id && l.status === 'launch_requested');
  }, 'Bing ShellExecute');
  pass(
    '必应默认浏览器启动请求',
    'Windows ShellExecuteW 已接受请求，日志 launch_requested；标签页人工观察',
  );
  let runId = await invoke('run_task', { taskId: exeTask.id });
  assert.equal((await runFinished(runId)).status, 'launch_requested');
  const receipt = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(receipt.arguments, exeTask.arguments);
  assert.equal(resolve(receipt.working_directory), resolve(working));
  pass('真实 EXE、中文空格路径与参数', '受控原生 EXE 回执确认 argv 数组和工作目录');
  runId = await invoke('run_task', { taskId: folder.id });
  assert.equal((await runFinished(runId)).status, 'launch_requested');
  pass('文件夹启动请求', '真实资源管理器关联请求成功；窗口内容人工观察');
  // Controlled LNK fixture using Windows COM in test setup only.
  const shortcut = join(dir, '快捷方式 测试.lnk');
  const lnkOutput = join(dir, 'lnk-receipt.json');
  const quotePS = (s) => `'${s.replaceAll("'", "''")}'`;
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${quotePS(shortcut)});$s.TargetPath=${quotePS(probe)};$s.Arguments=${quotePS('"' + lnkOutput + '" "快捷方式 参数"')};$s.WorkingDirectory=${quotePS(working)};$s.Save()`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    windowsHide: true,
  });
  const lnkTask = task('快捷方式', 'app', { executable_path: shortcut });
  await invoke('save_task', { task: lnkTask });
  runId = await invoke('run_task', { taskId: lnkTask.id });
  assert.equal((await runFinished(runId)).status, 'launch_requested');
  await until(async () => {
    try {
      await access(lnkOutput);
      return true;
    } catch {
      return false;
    }
  }, 'LNK receipt');
  pass('LNK 系统关联启动', 'Windows 快捷方式目标 EXE 确实写入回执');

  await invoke('save_scene', {
    scene: office,
    taskIds: [bing.id, web2.id, missing.id, exeTask.id],
  });
  await page.getByRole('navigation').getByRole('button', { name: '启动场景', exact: true }).click();
  await page.getByRole('button', { name: '编辑 日常办公', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑启动场景', exact: true });
  const handle = editor.getByRole('button', { name: '调整 工作应用 顺序', exact: true });
  await handle.focus();
  await handle.press('Space');
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowUp');
    await pause(250);
  }
  await page.keyboard.press('Space');
  await editor.getByRole('button', { name: '保存场景', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  d = await snapshot();
  assert.deepEqual(
    d.config.scene_tasks
      .filter((a) => a.scene_id === office.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((a) => a.task_id),
    [exeTask.id, bing.id, web2.id, missing.id],
  );
  pass('真实界面键盘排序与稳定关联', 'dnd-kit 键盘移动任务并保存，数据库顺序和 UUID 关系核验');
  await invoke('save_scene', {
    scene: office,
    taskIds: [bing.id, web2.id, missing.id, exeTask.id],
  });
  // Delay makes a second invocation deterministically overlap.
  await invoke('save_task', { task: { ...bing, delay_ms: 1000 } });
  const officeCard = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: '日常办公', exact: true }) });
  await officeCard.getByRole('button', { name: '启动场景', exact: true }).click();
  await until(async () => {
    runId = (await snapshot()).runs.find((r) => r.scene_id === office.id)?.id;
    return !!runId;
  }, 'scene UI submission');
  await assert.rejects(
    () => invoke('run_scene', { sceneId: office.id }),
    (e) => e.code === 'busy',
  );
  const run = await runFinished(runId);
  assert.equal(run.status, 'partial');
  d = await snapshot();
  const entries = d.logs.filter((l) => l.run_id === runId);
  assert.deepEqual(
    entries.map((l) => l.task_id),
    [bing.id, web2.id, missing.id, exeTask.id],
  );
  assert.deepEqual(
    entries.map((l) => l.status),
    ['launch_requested', 'launch_requested', 'failed', 'launch_requested'],
  );
  for (let i = 1; i < entries.length; i++)
    assert.ok(entries[i].started_at >= entries[i - 1].finished_at);
  pass(
    '场景按序、失败隔离及禁止重入',
    '两网页和 EXE 提交成功，错误程序失败后继续；日志顺序和时间核验',
  );
  // Reliable actual full-path running detection.
  const holdOutput = join(dir, 'hold.json');
  const held = spawn(probe, [holdOutput, '--hold'], { cwd: working, windowsHide: true });
  await until(async () => {
    try {
      await access(holdOutput);
      return true;
    } catch {
      return false;
    }
  }, 'held EXE');
  await invoke('save_task', { task: { ...exeTask, skip_if_running: true } });
  runId = await invoke('run_task', { taskId: exeTask.id });
  assert.equal((await runFinished(runId)).status, 'skipped');
  held.kill();
  await pause(300);
  pass('完整 EXE 路径检测并跳过', '真实同路径进程运行时日志 skipped');
  await invoke('save_task', { task: { ...exeTask, skip_if_running: false } });

  // Schedule time in the current minute is a real due rule, no frontend timer.
  const scheduled = scene('原生自动计划');
  await invoke('save_scene', { scene: scheduled, taskIds: [exeTask.id] });
  const n = new Date();
  const hhmm = `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
  const rule = {
    id: randomUUID(),
    scene_id: scheduled.id,
    trigger_type: 'daily',
    time_of_day: hhmm,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    delay_seconds: 0,
    catch_up_minutes: 120,
    enabled: true,
    created_at: stamp(),
    updated_at: stamp(),
  };
  await invoke('save_schedule', { schedule: rule });
  await until(async () => {
    const s = await snapshot();
    return s.runs.some((r) => r.rule_id === rule.id && r.finished_at);
  }, 'Rust scheduler trigger');
  await invoke('save_schedule', { schedule: { ...rule, id: randomUUID() } });
  await pause(2300);
  d = await snapshot();
  assert.equal(
    d.runs.filter((r) => r.scene_id === scheduled.id && r.trigger_type !== 'manual').length,
    1,
  );
  assert.equal(d.today_auto_count, 1);
  pass('Rust 真实后台调度和同日去重', '无需前端计时器；两条重叠规则仅产生一次自动执行');
  runId = await invoke('run_scene', { sceneId: scheduled.id });
  assert.equal((await runFinished(runId)).status, 'launch_requested');
  assert.equal((await snapshot()).today_auto_count, 1);
  pass('手动启动不受自动日期限制', '同一场景自动执行后仍允许手动运行，自动次数保持不变');

  // Autostart writes to the real current-user mechanism and queries actual state.
  const initial = d.autostart_enabled;
  try {
    assert.equal(await invoke('set_autostart', { enabled: true }), true);
    assert.equal((await snapshot()).autostart_enabled, true);
  } finally {
    await invoke('set_autostart', { enabled: initial });
  }
  pass('Windows 自启注册和实际查询', '已启用、查询并恢复原状态；真实重新登录仍需人工验证');
  const second = spawn(exe, [], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, STARTFLOW_TEST_DATA_DIR: dir },
  });
  await new Promise((resolve, reject) => {
    second.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Second process exit ' + code)),
    );
    setTimeout(() => reject(new Error('Single instance timeout')), 10000).unref();
  });
  pass('单实例重复启动', '第二进程退出，已有实例仍提供同一份数据');

  // Export/delete/import validates stable task IDs and relations. Import pauses automation.
  const exported = join(dir, 'export.json');
  await invoke('export_config', { path: exported });
  const imported = await invoke('read_import', { path: exported });
  await invoke('delete_entity', { kind: 'scene', entityId: office.id });
  await invoke('apply_import', { config: imported });
  d = await snapshot();
  assert.equal(d.config.scenes.find((s) => s.id === office.id)?.name, '日常办公');
  assert.deepEqual(
    d.config.scene_tasks
      .filter((a) => a.scene_id === office.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((a) => a.task_id),
    [bing.id, web2.id, missing.id, exeTask.id],
  );
  assert.equal(d.config.settings.paused, true);
  pass('JSON 导出、删除和关系恢复', '稳定 ID 和任务顺序恢复；导入后的自动任务已暂停');
  await writeFile(join(dir, 'bad.json'), '{"version":999,"script":"x"}');
  await assert.rejects(() => invoke('read_import', { path: join(dir, 'bad.json') }));
  assert.equal((await snapshot()).config.scenes.length, d.config.scenes.length);
  pass('错误导入保护', '未知字段/版本被拒绝，原配置保留');
  const history = await invoke('query_logs', { date: '', sceneId: '', status: '', offset: 0 });
  assert.ok(history.total > 0);
  assert.ok(history.failed >= 1);
  pass('后端分页日志与统计', '从 SQLite 查询全部匹配记录，失败和请求统计真实');
  // Real themes and layout screenshots.
  await invoke('save_settings', {
    settings: { ...d.config.settings, theme: 'dark', animations: false },
  });
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('heading', { name: /让工作，从容开始/ }).waitFor();
  await pause(200);
  await page.screenshot({ path: join(results, 'dashboard-dark.png') });
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.screenshot({ path: join(results, 'dashboard-light.png') });
  for (const label of ['启动场景', '任务管理', '计划调度', '运行日志', '系统设置']) {
    await page.getByRole('button', { name: new RegExp('^' + label) }).click();
    await page.locator('h1').waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: join(results, `${label}.png`) });
  }
  pass('六页面深浅主题与布局', '真实本地数据截图，无水平溢出');
  await page.setViewportSize({ width: 1024, height: 700 });
  for (const label of ['工作台', '启动场景', '任务管理', '计划调度', '运行日志', '系统设置']) {
    await page.getByRole('navigation').getByRole('button', { name: label, exact: true }).click();
    await page.locator('h1').waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await page.screenshot({ path: join(results, 'minimum-size.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  pass('1024×700 最小尺寸布局', '六个页面在最小逻辑尺寸均无水平溢出');
  // Future timed rule after a genuine native WM_CLOSE; UI remains hidden in tray.
  d = await snapshot();
  await invoke('save_settings', {
    settings: { ...d.config.settings, paused: false, close_to_tray: true },
  });
  const backgroundScene = scene('隐藏窗口后的定时验收');
  await invoke('save_scene', { scene: backgroundScene, taskIds: [exeTask.id] });
  const future = new Date(Date.now() + 60000);
  if (future.getSeconds() > 54) future.setMinutes(future.getMinutes() + 1);
  future.setSeconds(0, 0);
  const backgroundRule = {
    ...rule,
    id: randomUUID(),
    scene_id: backgroundScene.id,
    time_of_day: `${String(future.getHours()).padStart(2, '0')}:${String(future.getMinutes()).padStart(2, '0')}`,
  };
  await invoke('save_schedule', { schedule: backgroundRule });
  const windowHandle = windowState().handle;
  assert.ok(windowHandle > 0);
  windowState(true, windowHandle);
  await pause(500);
  assert.equal(windowState(false, windowHandle).visible, false);
  assert.equal(app.exitCode, null);
  console.log(`WAIT hidden-window scheduler at ${backgroundRule.time_of_day}`);
  await until(
    async () => {
      const s = await snapshot();
      return s.runs.some((r) => r.rule_id === backgroundRule.id && r.finished_at);
    },
    'future scheduled background execution',
    130000,
  );
  d = await snapshot();
  const backgroundRun = d.runs.find((r) => r.rule_id === backgroundRule.id);
  assert.ok(+new Date(backgroundRun.started_at) >= +future);
  assert.equal(backgroundRun.trigger_type, 'daily');
  assert.equal(windowState(false, windowHandle).visible, false);
  pass('真实关闭窗口后到点执行', 'WM_CLOSE 隐藏主窗口，进程仍存在；未来计划由 Rust 在目标时间触发');
  const reopened = spawn(exe, [], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, STARTFLOW_TEST_DATA_DIR: dir },
  });
  await new Promise((resolve) => reopened.once('exit', resolve));
  await pause(500);
  assert.equal(windowState(false, windowHandle).visible, true);
  pass('已有实例恢复隐藏主窗口', '重复启动恢复并聚焦原窗口，后台数据未丢失');
  // A login rule must not execute in the manually launched instance.
  const loginScene = scene('登录方式验收');
  await invoke('save_scene', { scene: loginScene, taskIds: [exeTask.id] });
  const loginRule = {
    ...rule,
    id: randomUUID(),
    scene_id: loginScene.id,
    trigger_type: 'login',
    delay_seconds: 2,
  };
  await invoke('save_schedule', { schedule: loginRule });
  await pause(2200);
  assert.equal((await snapshot()).runs.filter((r) => r.rule_id === loginRule.id).length, 0);
  pass('手动打开不触发登录规则', '手动实例创建登录规则后，后台没有执行该规则');
  const expectedSceneCount = (await snapshot()).config.scenes.length;
  // Restart confirms persisted theme and history; same-day automatic claims remain.
  await invoke('quit').catch(() => {});
  await until(async () => app.exitCode !== null, 'quit process');
  await browser.close();
  browser = null;
  launch();
  await attach();
  d = await snapshot();
  assert.equal(d.config.settings.theme, 'light');
  assert.ok(d.runs.length > 0);
  assert.equal(d.config.scenes.length, expectedSceneCount);
  await invoke('save_settings', { settings: { ...d.config.settings, paused: false } });
  await pause(2200);
  d = await snapshot();
  assert.equal(
    d.runs.filter((r) => r.scene_id === scheduled.id && r.trigger_type !== 'manual').length,
    1,
  );
  pass('进程退出、重启持久化与去重', '主题、关系、历史和自然日去重均保留');
  // Simulated autostart flag validates application semantics, not a real Windows logon.
  await invoke('quit').catch(() => {});
  await until(async () => app.exitCode !== null, 'manual instance quit');
  await browser.close();
  browser = null;
  const loginStarted = Date.now();
  launch(['--autostart']);
  await attach();
  assert.equal(windowState().visible, false);
  await until(async () => {
    const s = await snapshot();
    return s.runs.some((r) => r.rule_id === loginRule.id && r.finished_at);
  }, 'login flag execution');
  d = await snapshot();
  const loginRun = d.runs.find((r) => r.rule_id === loginRule.id);
  assert.equal(loginRun.trigger_type, 'login');
  assert.ok(+new Date(loginRun.started_at) >= loginStarted + 1800);
  pass(
    '模拟登录参数、隐藏启动和延迟',
    '真实进程传 --autostart，延迟执行登录规则；真实重新登录仍需人工验证',
  );
  const laterLoginScene = scene('下次登录才执行');
  await invoke('save_scene', { scene: laterLoginScene, taskIds: [exeTask.id] });
  const laterLoginRule = {
    ...loginRule,
    id: randomUUID(),
    scene_id: laterLoginScene.id,
    delay_seconds: 0,
  };
  await invoke('save_schedule', { schedule: laterLoginRule });
  await pause(2200);
  assert.equal((await snapshot()).runs.filter((r) => r.rule_id === laterLoginRule.id).length, 0);
  pass('新建登录规则不制造登录事件', '已自动登录启动的进程中，新规则等待下一次登录初始化');
  await invoke('clear_logs');
  d = await snapshot();
  assert.equal(d.runs.length, 0);
  assert.equal(d.today_auto_count, 3);
  pass('清空日志保留自动领取记录', '清日志不会重复启动当天自动场景');
  await invoke('save_settings', { settings: { ...d.config.settings, close_to_tray: false } });
  windowState(true, windowState().handle);
  await until(async () => app.exitCode !== null, 'close-to-exit setting');
  pass('关闭窗口时彻底退出设置', '真实 WM_CLOSE 结束后台进程，设置已持久化');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: join(results, 'failure.png') }).catch(() => {});
} finally {
  if (page) await invoke('set_autostart', { enabled: false }).catch(() => {});
  if (page) await invoke('quit').catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (app && app.exitCode === null) app.kill();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(results, 'v2-v1-regression.json'), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${join(results, 'v2-v1-regression.json')}`);
}
