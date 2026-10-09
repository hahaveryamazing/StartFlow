// Runs the actual Tauri binary in an isolated directory. Protocol server is a fixture, not an LLM.
import { chromium } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..'),
  dir = await mkdtemp(join(tmpdir(), 'StartFlow-v3-'));
const report = {
  startedAt: new Date().toISOString(),
  directory: dir,
  checks: [],
  limitations: [
    '真实 Wi-Fi 切换/权限拒绝、显示器插拔、电源切换、系统锁定/解锁及睡眠恢复仍需实机操作。',
    'AI 使用实际 HTTP 协议测试服务，不是已连接真实模型。',
    '短时空闲资源采样不能代替长时间性能测试。',
  ],
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let app, browser, page;
let responseMode = 'valid';
let requests = 0;
const pageErrors = [];
function pass(name, details) {
  report.checks.push({ name, details, status: 'passed' });
  console.log('PASS', name);
}
async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await wait(200);
  }
  throw Error(`Timeout: ${label}`);
}
async function invoke(command, args) {
  const r = await page.evaluate(
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
async function rejects(command, args, pattern) {
  try {
    await invoke(command, args);
    assert.fail('Expected rejection');
  } catch (e) {
    assert.match(String(e.message ?? e), pattern);
  }
}
const snapshot = () => invoke('snapshot'),
  v3 = () => invoke('v3_snapshot');
const stamp = () => new Date().toISOString(),
  node = (type, config = {}) => ({
    id: randomUUID(),
    name: type,
    x: 0,
    y: 0,
    config: { type, ...config },
    on_error: 'stop',
  });
function workflow(scene, type = 'delay', config = { milliseconds: 100 }) {
  const nodes = [node('start'), node(type, config), node('end')];
  return {
    id: randomUUID(),
    scene_id: scene.id,
    name: `${scene.name}流程`,
    description: '测试',
    schema_version: 1,
    enabled: true,
    max_seconds: 30,
    nodes,
    edges: nodes
      .slice(1)
      .map((n, i) => ({ id: randomUUID(), source: nodes[i].id, target: n.id, handle: 'next' })),
    created_at: stamp(),
    updated_at: stamp(),
  };
}
function scene(name) {
  return {
    id: randomUUID(),
    name,
    description: '隔离原生测试',
    icon: 'briefcase',
    color: '#3B82F6',
    enabled: true,
    sort_order: 0,
    created_at: stamp(),
    updated_at: stamp(),
  };
}
function rule(s, w, policy = 'confirm') {
  return {
    id: randomUUID(),
    name: s.name + '规则',
    description: '原生后端验证',
    enabled: true,
    version: 1,
    priority: 50,
    triggers: ['unlock'],
    condition: {
      id: randomUUID(),
      enabled: true,
      expression: { type: 'network', connected: true },
    },
    target: { scene_id: s.id, workflow_id: w.id },
    mode_id: null,
    policy,
    cooldown_seconds: 300,
    stability_seconds: 5,
    schedule: null,
    created_at: stamp(),
    updated_at: stamp(),
  };
}
async function launch() {
  app = spawn(join(root, 'src-tauri/target/debug/startflow.exe'), [], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      STARTFLOW_TEST_DATA_DIR: dir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9227',
    },
  });
  app.stderr.on('data', (s) => console.error(String(s).trim()));
  await until(async () => {
    try {
      return (await fetch('http://127.0.0.1:9227/json/version')).ok;
    } catch {
      return false;
    }
  }, 'WebView2');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9227');
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
  }, 'main');
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
}
async function quit() {
  await invoke('quit').catch(() => {});
  await until(() => app.exitCode !== null || app.signalCode !== null, 'exit');
  await browser?.close().catch(() => {});
  browser = undefined;
  page = undefined;
}
async function finished(id) {
  await until(async () => (await snapshot()).runs.find((r) => r.id === id)?.finished_at, 'run');
  return (await snapshot()).runs.find((r) => r.id === id);
}
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  requests++;
  assert.equal(JSON.parse(body).messages.length >= 2, true);
  res.setHeader('Content-Type', 'application/json');
  const content =
    responseMode === 'malicious'
      ? JSON.stringify({ type: 'shell', command: 'cmd /c echo forbidden' })
      : JSON.stringify({
          type: 'rule',
          rule: { ...aiRule, enabled: true, policy: 'auto' },
          missing: [],
          notes: ['协议测试草稿，不是真实模型响应'],
        });
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
let aiRule;
try {
  // Only the application under development is stopped, after its identity is verified.
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      '$expected=Join-Path $env:LOCALAPPDATA "StartFlow/StartFlow.exe";Get-Process startflow -ErrorAction SilentlyContinue|Where-Object {$_.Path -eq $expected}|ForEach-Object {Stop-Process -Id $_.Id};exit 0',
    ],
    { windowsHide: true },
  );
  const fixture = new DatabaseSync(join(dir, 'startflow.sqlite3'));
  fixture.exec(await readFile(join(root, 'src-tauri/tests/fixtures/v2-populated.sql'), 'utf8'));
  assert.equal(fixture.prepare('SELECT MAX(version) AS n FROM migrations').get().n, 2);
  const counts = {};
  for (const table of [
    'scenes',
    'tasks',
    'schedules',
    'workflows',
    'window_layouts',
    'shortcuts',
    'execution_runs',
  ])
    counts[table] = fixture.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  assert.ok(counts.scenes > 0 && counts.workflows > 0 && counts.window_layouts > 0);
  fixture
    .prepare(
      "UPDATE settings SET value_json=json_set(value_json,'$.paused',json('true'),'$.notifications',json('false'),'$.onboarding_done',json('true')) WHERE key='general'",
    )
    .run();
  fixture.close();
  await launch();
  let data = await snapshot();
  let status = await v3();
  const sql = new DatabaseSync(join(dir, 'startflow.sqlite3'), { readOnly: true });
  assert.equal(sql.prepare('SELECT MAX(version) AS n FROM migrations').get().n, 3);
  for (const [t, n] of Object.entries(counts))
    assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, n);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM pragma_foreign_key_check').get().n, 0);
  sql.close();
  const upgrade = data.v2.backups.find((b) => b.backup_type === 'upgrade');
  assert.ok(upgrade);
  const old = new DatabaseSync(join(dir, 'backups', upgrade.filename), { readOnly: true });
  assert.equal(old.prepare('SELECT MAX(version) AS n FROM migrations').get().n, 2);
  old.close();
  const preview = await invoke('v2_read_backup', { backupId: upgrade.id });
  assert.equal(preview.extension.workflows.length, counts.workflows);
  pass('非空 V2 数据库真实升级和备份恢复预览', JSON.stringify(counts));
  await until(
    async () => (await v3()).context.displays.status === 'available',
    'real provider capture',
  );
  status = await v3();
  assert.equal(status.config.enabled, false);
  assert.equal(status.config.permissions.wifi, false);
  assert.equal(status.context.wifi_ssid.value, null);
  assert.equal(status.context.network_connected.status, 'available');
  assert.ok(status.context.displays.value.length >= 1);
  assert.equal(status.subscription_error, null);
  assert.equal(status.context.session.status, 'available');
  pass('真实网络、显示器、电源和当前会话读取', {
    network: status.context.network_connected,
    displays: status.context.displays.value,
    power: status.context.power_source,
    battery: status.context.battery_percentage,
    session: status.context.session,
    wifi: status.context.wifi_ssid,
  });
  const one = scene('V3 确认场景'),
    two = scene('V3 应用场景');
  await invoke('save_scene', { scene: one, taskIds: [] });
  await invoke('save_scene', { scene: two, taskIds: [] });
  const probe = join(dir, '中文 测试程序.exe');
  await copyFile(join(root, 'src-tauri/target/debug/examples/launch_probe.exe'), probe);
  const marker = join(dir, '启动请求.json');
  const task = {
    id: randomUUID(),
    name: '受控应用',
    kind: 'app',
    url: '',
    executable_path: probe,
    arguments: [marker, '含 空格的参数'],
    working_directory: dir,
    browser_mode: 'default',
    browser_path: '',
    delay_ms: 0,
    wait_for_network: false,
    skip_if_running: false,
    enabled: true,
    created_at: stamp(),
    updated_at: stamp(),
  };
  await invoke('save_task', { task });
  const w1 = workflow(one),
    w2 = workflow(two, 'app', { task_id: task.id });
  data = await snapshot();
  const extension = { ...data.v2.extension, workflows: [...data.v2.extension.workflows, w1, w2] };
  await invoke('v2_save_extension', { extension });
  let c = (await v3()).config;
  c.enabled = true;
  c.rules = [rule(one, w1)];
  await invoke('v3_save', { config: c });
  const simulated = {
    ...(await v3()).context,
    id: randomUUID(),
    captured_at: '2026-10-08T09:00:00+08:00',
    network_connected: { status: 'available', value: true, reason: '' },
  };
  const before = (await snapshot()).runs.length;
  let dry = await invoke('v3_simulate', {
    simulation: {
      snapshot: simulated,
      kind: 'refresh',
      schedule_id: null,
      include_runtime_guards: false,
      stable_seconds: 10,
    },
  });
  assert.equal(dry[0].decision, 'waiting_confirmation');
  assert.deepEqual(dry[0].execution_run_ids, []);
  assert.equal((await snapshot()).runs.length, before);
  simulated.network_connected = {
    status: 'permission_denied',
    value: null,
    reason: '模拟权限拒绝',
  };
  dry = await invoke('v3_simulate', {
    simulation: {
      snapshot: simulated,
      kind: 'refresh',
      schedule_id: null,
      include_runtime_guards: false,
      stable_seconds: 10,
    },
  });
  assert.equal(dry[0].match_result, 'unknown');
  assert.equal(dry[0].decision, 'skipped');
  pass('Dry Run 与 unknown 安全降级', '后端模拟没有创建执行记录或启动应用');
  await invoke('save_settings', {
    settings: { ...(await snapshot()).config.settings, paused: false, notifications: false },
  });
  await wait(5500);
  await invoke('v3_refresh');
  let suggestion;
  await until(async () => {
    suggestion = (await v3()).decisions.find(
      (d) => d.rule_id === c.rules[0].id && d.decision === 'waiting_confirmation',
    );
    return !!suggestion;
  }, 'confirmation suggestion');
  const approved = await invoke('v3_confirm', { decisionId: suggestion.id, accept: true });
  assert.equal(approved[0].execution_run_ids.length, 1);
  assert.equal((await finished(approved[0].execution_run_ids[0])).status, 'completed');
  await rejects('v3_confirm', { decisionId: suggestion.id, accept: true }, /处理/);
  assert.notEqual(
    (await v3()).decisions.find((d) => d.id === suggestion.id).decision,
    'waiting_confirmation',
  );
  const replay = await invoke('v3_replay', { decisionId: suggestion.id });
  assert.equal(replay[0].decision, 'waiting_confirmation');
  assert.equal(replay[0].rule_version, 1);
  assert.deepEqual(replay[0].execution_run_ids, []);
  pass(
    '确认只提交一次、真实后端流程完成和历史回放',
    '确认后原建议已处理，回放仍使用旧规则和无副作用路径',
  );
  c = (await v3()).config;
  c.rules[0].policy = 'auto';
  c.rules[0].cooldown_seconds = 0;
  c.rules.push(rule(two, w2, 'auto'));
  await invoke('v3_save', { config: c });
  await invoke('v3_refresh');
  await until(async () => {
    try {
      return JSON.parse(await readFile(marker, 'utf8')).arguments[1] === '含 空格的参数';
    } catch {
      return false;
    }
  }, 'real app launch');
  await until(
    async () =>
      (await v3()).decisions.some((d) => d.rule_id === c.rules[1].id && d.decision === 'completed'),
    'app decision completed',
  );
  assert.ok(
    (await v3()).decisions.some(
      (d) => d.rule_id === c.rules[0].id && d.reasons.some((r) => r.includes('本日')),
    ),
  );
  pass(
    '环境协调器复用真实 EXE 启动与自然日去重',
    '实际 EXE 写入参数及工作目录；同日已执行场景被跳过',
  );
  const scheduledScene = scene('V3 定时稳定性测试');
  await invoke('save_scene', { scene: scheduledScene, taskIds: [] });
  const scheduledFlow = workflow(scheduledScene, 'delay', { milliseconds: 10 });
  data = await snapshot();
  await invoke('v2_save_extension', {
    extension: { ...data.v2.extension, workflows: [...data.v2.extension.workflows, scheduledFlow] },
  });
  const scheduledRule = rule(scheduledScene, scheduledFlow, 'auto');
  const scheduledNow = new Date();
  scheduledRule.triggers = ['schedule'];
  scheduledRule.schedule = {
    time: `${String(scheduledNow.getHours()).padStart(2, '0')}:${String(scheduledNow.getMinutes()).padStart(2, '0')}`,
    days: [scheduledNow.getDay() || 7],
    catch_up_minutes: 30,
  };
  c = (await v3()).config;
  c.rules.push(scheduledRule);
  await invoke('v3_save', { config: c });
  // Actual Rust scheduler; no v3_refresh or front-end timer triggers this rule.
  await until(
    async () =>
      (await v3()).decisions.some(
        (d) => d.rule_id === scheduledRule.id && d.decision === 'completed',
      ),
    'actual V3 timed rule',
    70000,
  );
  assert.equal((await snapshot()).runs.filter((r) => r.scene_id === scheduledScene.id).length, 1);
  await invoke('v3_refresh');
  await wait(5600);
  assert.equal((await snapshot()).runs.filter((r) => r.scene_id === scheduledScene.id).length, 1);
  pass(
    'V3 Rust 定时实际触发和重复刷新去重',
    '未调用模拟或前端触发；后端在稳定后执行当前计划，重复刷新不重复启动',
  );
  const crashScene = scene('V3 中断场景');
  await invoke('save_scene', { scene: crashScene, taskIds: [] });
  const crashFlow = workflow(crashScene, 'delay', { milliseconds: 15000 });
  data = await snapshot();
  await invoke('v2_save_extension', {
    extension: { ...data.v2.extension, workflows: [...data.v2.extension.workflows, crashFlow] },
  });
  c = (await v3()).config;
  const crashRule = rule(crashScene, crashFlow, 'auto');
  c.rules.push(crashRule);
  await invoke('v3_save', { config: c });
  await invoke('v3_refresh');
  let crashDecision;
  await until(async () => {
    crashDecision = (await v3()).decisions.find(
      (d) => d.rule_id === crashRule.id && d.decision === 'running',
    );
    return !!crashDecision;
  }, 'running automation before crash');
  const crashRun = crashDecision.execution_run_ids[0];
  app.kill();
  await until(() => app.signalCode !== null || app.exitCode !== null, 'controlled crash');
  await browser.close();
  browser = undefined;
  page = undefined;
  await launch();
  assert.equal((await snapshot()).runs.find((r) => r.id === crashRun).status, 'interrupted');
  assert.equal(
    (await v3()).decisions.find((d) => d.id === crashDecision.id).decision,
    'interrupted',
  );
  const runCount = (await snapshot()).runs.length;
  await invoke('v3_refresh');
  await wait(5600);
  assert.equal((await snapshot()).runs.length, runCount);
  pass(
    '自动化异常退出、运行状态恢复和持久化去重',
    '受控终止自己的测试进程；重启标记 interrupted，不盲目重放',
  );
  const pausedBefore = (await snapshot()).runs.length;
  await invoke('save_settings', {
    settings: { ...(await snapshot()).config.settings, paused: true },
  });
  await invoke('v3_refresh');
  await wait(5600);
  assert.equal((await snapshot()).runs.length, pausedBefore);
  assert.ok((await v3()).decisions.some((d) => d.reasons.some((r) => r.includes('暂停'))));
  pass('全局暂停阻止新自动提交', '手动启动仍由原有执行器提供');
  let mode = {
    id: randomUUID(),
    name: '手动测试模式',
    description: '',
    icon: 'briefcase',
    color: '#3B82F6',
    enabled: true,
    priority: 50,
    exclusive_group: 'work',
    strategy: 'suggest',
    targets: [{ scene_id: one.id, workflow_id: w1.id }],
    created_at: stamp(),
    updated_at: stamp(),
  };
  c = (await v3()).config;
  c.modes = [mode];
  await invoke('v3_save', { config: c });
  const switched = await invoke('v3_switch_mode', { modeId: mode.id, hold: 'hour' });
  assert.equal(switched.execution_run_ids.length, 1);
  await finished(switched.execution_run_ids[0]);
  assert.equal((await v3()).manual_override.mode_id, mode.id);
  pass('手动工作模式与一小时覆盖', '暂停自动化时手动模式仍真实执行，覆盖持久化');
  await invoke('v3_clear_override');
  const net = await invoke('v3_trust_network', {
    name: '受信任测试网络',
    ssid: 'StartFlow-Test-Private-SSID',
  });
  assert.ok(net.sealed_ssid);
  assert.ok(!JSON.stringify(net).includes('StartFlow-Test-Private-SSID'));
  c = (await v3()).config;
  c.permissions.wifi = true;
  await invoke('v3_save', { config: c });
  await wait(800);
  status = await v3();
  assert.ok(
    ['available', 'unavailable', 'permission_denied', 'unsupported', 'error'].includes(
      status.context.wifi_ssid.status,
    ),
  );
  if (status.context.wifi_ssid.status !== 'available')
    assert.equal(status.context.wifi_ssid.value, null);
  pass('DPAPI 信任网络与真实 WLAN 可用性', status.context.wifi_ssid.status);
  c = (await v3()).config;
  c.permissions.wifi = false;
  await invoke('v3_save', { config: c });
  assert.equal((await v3()).context.wifi_ssid.value, null);
  c = (await v3()).config;
  const monitorRule = rule(two, w2, 'notify');
  monitorRule.condition.expression = { type: 'process', task_id: task.id, state: 'running' };
  monitorRule.triggers = ['processes'];
  c.rules.push(monitorRule);
  c.permissions.processes = true;
  await invoke('v3_save', { config: c });
  const controlled = spawn(probe, [marker + '.monitor', '--hold'], { windowsHide: true });
  await invoke('v3_refresh');
  await until(
    async () => (await v3()).context.processes[task.id]?.running.value === true,
    'selected actual process',
    3000,
  );
  await until(() => controlled.exitCode !== null, 'controlled process exit', 7000);
  await invoke('v3_refresh');
  await until(
    async () => (await v3()).context.processes[task.id]?.running.value === false,
    'selected process stopped',
    3000,
  );
  c = (await v3()).config;
  c.permissions.processes = false;
  await invoke('v3_save', { config: c });
  assert.equal((await v3()).context.processes[task.id]?.running.value ?? null, null);
  pass('指定应用完整路径真实运行/停止检测', '仅检测启用规则选择的任务；关闭授权后立即屏蔽状态');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const settings = {
    id: randomUUID(),
    enabled: true,
    provider_type: 'local',
    endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    model: 'protocol-fixture',
    history: false,
  };
  await invoke('v3_ai_save_settings', { settings });
  c = (await v3()).config;
  c.permissions.ai = true;
  await invoke('v3_save', { config: c });
  const fakeKey = 'fixture-only-' + randomUUID();
  await invoke('v3_ai_set_key', { key: fakeKey });
  assert.equal((await invoke('v3_ai_status')).credential_present, true);
  assert.ok(!JSON.stringify(await invoke('v3_ai_status')).includes(fakeKey));
  aiRule = rule(one, w1);
  const request = {
    kind: 'rule',
    prompt: '工作日早上九点启动已选场景；测试响应仅用于验证草稿',
    scene_id: one.id,
    task_ids: [task.id],
    layout_ids: [],
    rule_id: null,
  };
  let prepared = await invoke('v3_ai_preview', { request });
  assert.equal(requests, 0);
  assert.ok(!JSON.stringify(prepared).includes(probe));
  const generated = await invoke('v3_ai_generate', { token: prepared.token });
  assert.equal(generated.valid, true);
  assert.equal(generated.configuration.rule.enabled, false);
  assert.equal(generated.configuration.rule.policy, 'confirm');
  assert.equal(requests, 1);
  assert.equal((await v3()).config.rules.length, c.rules.length);
  pass(
    'AI 实际协议、发送预览与 Windows 凭据保护',
    '本地 HTTP 测试服务仅验证接口；草稿没有自动保存或执行，不是实际模型',
  );
  const keysBefore = (await v3()).config.rules.length;
  await invoke('v3_ai_commit', { configuration: generated.configuration });
  assert.equal((await v3()).config.rules.length, keysBefore + 1);
  assert.equal((await v3()).config.rules.at(-1).enabled, false);
  responseMode = 'malicious';
  prepared = await invoke('v3_ai_preview', { request });
  await rejects('v3_ai_generate', { token: prepared.token }, /结构|格式|配置/);
  assert.equal((await v3()).config.rules.length, keysBefore + 1);
  await invoke('v3_ai_delete_key');
  assert.equal((await invoke('v3_ai_status')).credential_present, false);
  await invoke('v3_ai_save_settings', { settings: { ...settings, enabled: false } });
  pass(
    'AI 恶意 Schema 拒绝和显式草稿确认',
    '不支持 shell 输出；确认保存后规则仍停用；测试凭据已删除',
  );
  const exportPath = join(dir, '完整 V3 配置.json');
  await invoke('v2_export', { path: exportPath });
  const bundle = await invoke('v2_read_import', { path: exportPath });
  assert.equal(bundle.schema_version, 3);
  assert.ok(bundle.automation.rules.length >= 3);
  assert.ok(!JSON.stringify(bundle).includes(fakeKey));
  assert.ok(!JSON.stringify(bundle).includes('StartFlow-Test-Private-SSID'));
  const originalRules = bundle.automation.rules.length;
  await invoke('v2_apply_import', { bundle, mode: 'merge' });
  assert.equal((await v3()).config.rules.length, originalRules * 2);
  let merged = (await v3()).config;
  assert.equal(new Set(merged.rules.map((r) => r.id)).size, merged.rules.length);
  assert.ok(merged.rules.slice(originalRules).every((r) => !r.enabled));
  await invoke('v2_apply_import', { bundle, mode: 'replace' });
  status = await v3();
  assert.equal(status.config.rules.length, originalRules);
  assert.equal(status.config.enabled, false);
  assert.equal(status.config.permissions.ai, false);
  assert.ok(status.config.rules.every((r) => !r.enabled));
  pass(
    'V3 完整备份合并、替换、UUID 引用恢复',
    '恢复前备份、事务及 FK 校验；导入不执行，敏感授权关闭',
  );
  await invoke('v3_clear_history');
  assert.equal((await v3()).decisions.length, 0);
  assert.equal((await v3()).config.rules.length, originalRules);
  await quit();
  await launch();
  assert.equal((await v3()).config.rules.length, originalRules);
  assert.equal((await v3()).config.enabled, false);
  pass('重启持久化与仅清理环境历史', '配置仍存在，规则不会未经授权执行');
  await mkdir(join(root, 'test-results'), { recursive: true });
  const routes = [
    ['工作模式', '工作模式'],
    ['智能规则', '智能规则'],
    ['规则模拟', '规则模拟器'],
    ['决策历史', '决策历史'],
    ['执行统计', '执行统计'],
    ['系统设置', '系统设置'],
  ];
  for (const [nav, title] of routes) {
    await page.getByRole('button', { name: nav, exact: true }).click();
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
  }
  await page.getByRole('button', { name: 'AI 配置助手', exact: true }).click();
  await page.getByRole('heading', { name: 'AI 配置助手', exact: true }).waitFor();
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('heading', { name: /好/ }).first().waitFor();
  await page.screenshot({ path: join(root, 'test-results/v3-dashboard.png') });
  assert.deepEqual(pageErrors, []);
  pass('真实 WebView2 所有 V3 页面加载和工作台截图', '没有 JavaScript 页面错误');
  const pid = app.pid;
  const startCpu = JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$p=Get-Process -Id ${pid};@{cpu=$p.CPU;bytes=$p.WorkingSet64}|ConvertTo-Json -Compress`,
      ],
      { windowsHide: true, encoding: 'utf8' },
    ),
  );
  await wait(10000);
  const endCpu = JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$p=Get-Process -Id ${pid};@{cpu=$p.CPU;bytes=$p.WorkingSet64}|ConvertTo-Json -Compress`,
      ],
      { windowsHide: true, encoding: 'utf8' },
    ),
  );
  report.shortIdleSample = {
    seconds: 10,
    cpuSeconds: endCpu.cpu - startCpu.cpu,
    rustProcessWorkingSetBytes: endCpu.bytes,
    includesWebView2: false,
  };
  pass('短时真实进程资源采样', report.shortIdleSample);
  await quit();
  report.completedAt = stamp();
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error.message ?? JSON.stringify(error));
  console.error(error);
  process.exitCode = 1;
} finally {
  server.close();
  if (app && app.exitCode === null && app.signalCode === null) app.kill();
  await browser?.close().catch(() => {});
  await writeFile(join(root, 'docs/v3-native-results.json'), JSON.stringify(report, null, 2));
  console.log('Report', join(root, 'docs/v3-native-results.json'));
}
