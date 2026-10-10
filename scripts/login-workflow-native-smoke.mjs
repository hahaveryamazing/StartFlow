import { fixture as webFixture } from '../automation/web-login/test-fixture.mjs';
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
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
let aiWorkflow, aiPayload;
const aiServer = createServer(async (req, res) => {
  let body = '';
  for await (const b of req) body += b;
  aiPayload = body;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              type: 'workflow',
              workflow: aiWorkflow,
              missing: [],
              notes: [],
            }),
          },
        },
      ],
    }),
  );
});
await new Promise((r) => aiServer.listen(0, '127.0.0.1', r));
const web = await webFixture();
web.users.set('flow@example.test', 'StartFlowSynthetic-only');
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
      STARTFLOW_LOGIN_TEST_CERT_PIN: web.pin,
      STARTFLOW_LOGIN_TEST_HEADLESS: '1',
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

  const scene = {
    id: randomUUID(),
    name: '第五阶段登录集成',
    description: '真实登录与后续节点',
    icon: 'briefcase',
    color: '#3B82F6',
    enabled: true,
    sort_order: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await call('save_scene', { scene, taskIds: [] });
  const node = (config, name = config.type) => ({
    id: randomUUID(),
    name,
    x: 0,
    y: 0,
    config,
    on_error: 'stop',
  });
  const make = (configs, name = '第五阶段 · 登录工作流') => {
    const nodes = configs.map((c, i) => ({ ...node(c), x: i * 300 }));
    return {
      id: randomUUID(),
      scene_id: scene.id,
      name,
      description: '本机原生集成',
      schema_version: 1,
      enabled: true,
      max_seconds: 120,
      nodes,
      edges: nodes
        .slice(1)
        .map((n, i) => ({ id: randomUUID(), source: nodes[i].id, target: n.id, handle: 'next' })),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  };
  const saveWorkflow = async (w) => {
    const snap = await call('snapshot');
    await call('v2_validate_workflow', { workflow: w });
    await call('v2_save_extension', {
      extension: {
        ...snap.v2.extension,
        workflows: [...snap.v2.extension.workflows.filter((x) => x.id !== w.id), w],
      },
    });
  };
  const grant = async (w) =>
    call('login_workflow_authorize', { workflowId: w.id, authorized: true });
  async function launch(w) {
    return call('v2_run_workflow', { workflowId: w.id });
  }
  async function finished(run) {
    let result;
    await until(async () => {
      result = (await call('snapshot')).runs.find((r) => r.id === run);
      return result && result.status !== 'running';
    }, 'workflow finished');
    return result;
  }
  async function logs(run) {
    return call('v2_query_node_logs', { runId: run });
  }
  async function closeWeb() {
    for (const id of (await call('web_login_snapshot')).active_runs)
      await call('web_login_close', { id });
    await until(
      async () => !(await call('web_login_snapshot')).active_runs.length,
      'browser cleanup',
    );
  }
  // A real app launch through the original Task Launcher, then a real UIA login.
  const state = join(temp, 'workflow-launched.json');
  const task = {
    id: randomUUID(),
    name: '专用 Win32 登录测试应用',
    kind: 'app',
    url: '',
    executable_path: fixtureExe,
    arguments: ['success', state],
    working_directory: temp,
    browser_mode: 'default',
    browser_path: '',
    delay_ms: 0,
    wait_for_network: false,
    skip_if_running: true,
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await call('save_task', { task });
  const desktop = config({
    title: 'StartFlow UIA Fixture success',
    class_name: 'StartFlowLoginFixture',
  });
  await call('desktop_login_save', { config: desktop });
  const cfg = { target: 'desktop', config_id: desktop.id, timeout_seconds: 20 };
  const w = make([
    { type: 'start' },
    { type: 'app', task_id: task.id },
    { type: 'login_check', ...cfg },
    { type: 'auto_login', ...cfg, failure_policy: 'stop' },
    { type: 'delay', milliseconds: 1 },
    { type: 'end' },
  ]);
  await saveWorkflow(w);
  let run = await launch(w);
  assert.equal((await finished(run)).status, 'failed');
  let stateValue = JSON.parse(await readFile(state, 'utf8'));
  assert.equal(stateValue.submissions, 0);
  assert.equal((await logs(run))[4].status, 'skipped');
  pass('工作流真实启动 EXE；未授权时不填密且停止后续节点');
  await grant(w);
  assert.equal(await call('login_workflow_authorized', { workflowId: w.id }), true);
  run = await launch(w);
  assert.equal((await finished(run)).status, 'completed');
  stateValue = JSON.parse(await readFile(state, 'utf8'));
  assert.equal(stateValue.submissions, 1);
  assert.equal(stateValue.logged, true);
  assert.equal((await logs(run))[4].status, 'completed');
  pass('启动 → 检查 → 真实 UIA 登录 → 身份验证 → 后续节点完整链路');
  run = await launch(w);
  assert.equal((await finished(run)).status, 'completed');
  assert.equal(JSON.parse(await readFile(state, 'utf8')).submissions, 1);
  pass('工作流重复手动运行复用桌面会话，未再次提交密码');
  const dw = (await call('desktop_login_windows', { accountId: account.id })).windows[0];
  const launchedPid = (await logs(run)).find((n) => n.node_type === 'app').result?.pid;
  // The exact enumerated fixture window belongs to the task above.
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-File',
      join(root, 'scripts/fixtures/OwnedTestWindow.ps1'),
      '-ProcessId',
      String(dw.pid),
      '-Action',
      'close',
      '-HandleValue',
      String(dw.handle),
    ],
    { windowsHide: true },
  );
  await until(
    async () => !(await call('desktop_login_windows', { accountId: account.id })).windows.length,
    'launched app close',
  );
  // Explicit false/true branch semantics, including independent end nodes.
  const f = await fixture('success');
  await resetClaim();
  const branch = make(
    [{ type: 'start' }, { type: 'login_branch', ...cfg }, { type: 'end' }, { type: 'end' }],
    '登录分支',
  );
  branch.nodes[1].config = { type: 'login_branch', target: 'desktop', config_id: desktop.id };
  branch.edges = [
    { id: randomUUID(), source: branch.nodes[0].id, target: branch.nodes[1].id, handle: 'next' },
    { id: randomUUID(), source: branch.nodes[1].id, target: branch.nodes[2].id, handle: 'true' },
    { id: randomUUID(), source: branch.nodes[1].id, target: branch.nodes[3].id, handle: 'false' },
  ];
  await saveWorkflow(branch);
  run = await launch(branch);
  await finished(run);
  assert.equal((await logs(run))[2].status, 'skipped');
  assert.equal((await logs(run))[3].status, 'completed');
  f.child.stdin.write('show-success\n');
  await until(async () => (await f.read()).logged, 'manual signed in');
  run = await launch(branch);
  await finished(run);
  assert.equal((await logs(run))[2].status, 'completed');
  assert.equal((await logs(run))[3].status, 'skipped');
  pass('登录结果 True/False 分支由真实 UIA 状态决定，未选分支不执行');
  await stop(f);
  async function desktopCase(mode, policy) {
    const f = await fixture(mode);
    const c = config(await windowFor(f));
    await call('desktop_login_save', { config: c });
    await resetClaim();
    const flow = make(
      [
        { type: 'start' },
        {
          type: 'auto_login',
          target: 'desktop',
          config_id: c.id,
          timeout_seconds: 20,
          failure_policy: policy,
        },
        { type: 'delay', milliseconds: 1 },
        { type: 'end' },
      ],
      mode + ' ' + policy,
    );
    await saveWorkflow(flow);
    await grant(flow);
    return { f, flow, run: await launch(flow) };
  }
  let test = await desktopCase('fail', 'skip');
  assert.equal((await finished(test.run)).status, 'completed');
  assert.equal((await logs(test.run))[1].status, 'skipped');
  assert.equal((await test.f.read()).submissions, 1);
  await stop(test.f);
  pass('明确失败跳过策略生效，最多提交一次');
  test = await desktopCase('after-challenge', 'manual');
  await until(async () => (await logs(test.run))[1].status === 'waiting_manual', 'manual wait');
  assert.equal((await test.f.read()).submissions, 1);
  test.f.child.stdin.write('show-success\n');
  assert.equal((await finished(test.run)).status, 'completed');
  assert.equal((await test.f.read()).submissions, 1);
  assert.equal((await logs(test.run))[1].result.submitted, true);
  await stop(test.f);
  pass('MFA 后等待人工验证，确认身份后继续，没有再次提交密码');
  test = await desktopCase('challenge', 'manual');
  await until(async () => (await logs(test.run))[1].status === 'waiting_manual', 'cancel wait');
  await call('v2_cancel_run', { runId: test.run });
  assert.equal((await finished(test.run)).status, 'cancelled');
  assert.equal((await test.f.read()).submissions, 0);
  assert.equal((await logs(test.run))[2].status, 'skipped');
  await stop(test.f);
  pass('人工等待可取消，后续节点停止且不终止目标程序');
  test = await desktopCase('timeout', 'stop');
  assert.equal((await finished(test.run)).status, 'failed');
  assert.equal((await test.f.read()).submissions, 1);
  assert.equal((await logs(test.run))[2].status, 'skipped');
  await stop(test.f);
  pass('登录超时不当作成功，停止后续节点且不重试');
  const hung = await fixture('hang');
  const hc = config(await windowFor(hung));
  await call('desktop_login_save', { config: hc });
  const hw = make(
    [
      { type: 'start' },
      { type: 'login_check', target: 'desktop', config_id: hc.id, timeout_seconds: 30 },
      { type: 'end' },
    ],
    'UIA 取消隔离',
  );
  await saveWorkflow(hw);
  hung.child.stdin.write('hang\n');
  await until(async () => (await hung.read()).armed, 'hung provider armed');
  const hrun = await launch(hw);
  await delay(600);
  const cancelAt = Date.now();
  await call('v2_cancel_run', { runId: hrun });
  assert.equal((await finished(hrun)).status, 'cancelled');
  assert.ok(Date.now() - cancelAt < 3000);
  assert.equal(hung.child.exitCode, null);
  await stop(hung);
  pass('真实无响应 UIA 工作进程可被工作流取消，目标应用保留');
  // Existing authorized config edited -> fail closed before touching the credential.
  const changed = { ...w, max_seconds: 121 };
  await saveWorkflow(changed);
  assert.equal(await call('login_workflow_authorized', { workflowId: w.id }), false);
  pass('工作流执行配置变化使授权失效');
  const wa = (
    await call('accounts_save', {
      request: {
        id: null,
        name: '合成网页账号',
        username: 'flow@example.test',
        kind: 'web',
        target: web.origin,
        password: 'StartFlowSynthetic-only',
        expected_revision: null,
      },
    })
  ).account;
  const wc = {
    ...web.config(wa.id),
    name: '超长登录配置·' + 'long-unbroken-configuration-name'.repeat(5),
    timeout_seconds: 15,
  };
  await call('web_login_save', { config: wc });
  const webcfg = { target: 'web', config_id: wc.id, timeout_seconds: 30 };
  const wf = make(
    [
      { type: 'start' },
      { type: 'login_check', ...webcfg },
      { type: 'auto_login', ...webcfg, failure_policy: 'stop' },
      { type: 'delay', milliseconds: 1 },
      { type: 'end' },
    ],
    '第五阶段 · 网页登录工作流',
  );
  await saveWorkflow(wf);
  await grant(wf);
  run = await launch(wf);
  assert.equal((await finished(run)).status, 'completed');
  assert.equal(web.posts.get('normal'), 1);
  pass('工作流通过既有 Playwright Sidecar 与凭据库完成真实 HTTPS 登录');
  run = await launch(wf);
  assert.equal((await finished(run)).status, 'completed');
  assert.equal(web.posts.get('normal'), 1);
  assert.equal((await logs(run))[1].result.login_status, 'session_reused');
  pass('打开的专用浏览器收到实时探测，安全复用会话');
  web.expire();
  run = await launch(wf);
  assert.equal((await finished(run)).status, 'failed');
  assert.equal(web.posts.get('normal'), 1);
  pass('会话过期及持久化预算生效，工作流不会重复提交密码');
  await closeWeb();
  const evil = { ...web.config(wa.id, 'redirect'), timeout_seconds: 5 };
  await call('web_login_save', { config: evil });
  const ew = make([
    { type: 'start' },
    { type: 'login_branch', target: 'web', config_id: evil.id },
    { type: 'end' },
    { type: 'end' },
  ]);
  ew.edges = [
    { id: randomUUID(), source: ew.nodes[0].id, target: ew.nodes[1].id, handle: 'next' },
    { id: randomUUID(), source: ew.nodes[1].id, target: ew.nodes[2].id, handle: 'true' },
    { id: randomUUID(), source: ew.nodes[1].id, target: ew.nodes[3].id, handle: 'false' },
  ];
  await saveWorkflow(ew);
  run = await launch(ew);
  assert.equal((await finished(run)).status, 'failed');
  assert.equal(web.evilRequests, 0);
  assert.equal((await logs(run))[2].status, 'skipped');
  assert.equal((await logs(run))[3].status, 'skipped');
  pass('未知 Origin 与恶意重定向不会填密，也不会被错误转换为 False 分支');
  await closeWeb();
  const automation = (await call('v3_snapshot')).config;
  await call('v3_save', {
    config: { ...automation, permissions: { ...automation.permissions, ai: true } },
  });
  await call('v3_ai_save_settings', {
    settings: {
      id: randomUUID(),
      enabled: true,
      provider_type: 'local',
      endpoint: `http://127.0.0.1:${aiServer.address().port}/v1/chat/completions`,
      model: 'protocol-fixture',
      history: false,
    },
  });
  const preview = await call('v3_ai_preview', {
    request: {
      kind: 'workflow',
      prompt: '创建先检查登录再自动登录的草稿。',
      scene_id: scene.id,
      task_ids: [],
      layout_ids: [],
      rule_id: null,
      login_configs: [{ target: 'web', id: wc.id }],
    },
  });
  clean(preview);
  const payload = JSON.stringify(preview.payload);
  assert.ok(payload.includes(wc.id));
  assert.ok(!payload.includes(wa.credential_ref));
  assert.ok(!payload.includes(wa.username));
  pass('AI 登录草稿发送预览仅包含明确选择的配置 ID/类型/名称，无密码及凭据引用');
  aiWorkflow = { ...wf, id: randomUUID(), name: '登录流程协议测试草稿', enabled: false };
  const draft = await call('v3_ai_generate', { token: preview.token });
  clean(aiPayload);
  clean(draft);
  assert.equal(draft.valid, true);
  assert.equal(draft.configuration.workflow.enabled, false);
  assert.equal(await call('login_workflow_authorized', { workflowId: aiWorkflow.id }), false);
  assert.equal(web.posts.get('normal'), 1);
  pass('本地协议测试服务生成有效登录工作流草稿，不自动保存、授权或执行（非真实模型）');
  // Export/import include metadata and locators, never secrets or authorization.
  const file = join(temp, 'bundle.json');
  await call('v2_export', { path: file });
  const text = await readFile(file, 'utf8');
  clean(text);
  const bundle = JSON.parse(text);
  assert.equal(bundle.schema_version, 4);
  assert.ok(bundle.login.web.length);
  assert.ok(bundle.login.desktop.length);
  assert.ok(!text.includes('workflow_login_grants'));
  assert.ok(!text.includes('sf_session='));
  const before = await call('accounts_list');
  await call('v2_apply_import', { bundle, mode: 'merge' });
  const after = await call('accounts_list');
  assert.equal(after.accounts.length, before.accounts.length * 2);
  for (const a of after.accounts.filter((a) => !before.accounts.some((o) => o.id === a.id)))
    assert.equal(a.credential_state, 'missing');
  pass('完整配置合并重映射登录引用，新账号不复用秘密，原账号保留');
  const rows = await call('login_history');
  clean(rows);
  assert.ok(rows.length);
  pass('统一登录历史来自真实后端状态，不包含秘密');
  await page.getByRole('button', { name: '账号与凭据', exact: true }).click();
  await page.locator('.login-history').getByText(wc.name, { exact: true }).first().waitFor();
  const historySettings = (await call('snapshot')).config.settings;
  for (const theme of ['dark', 'light']) {
    await call('save_settings', { settings: { ...historySettings, theme } });
    await until(
      async () => (await page.locator('html').getAttribute('data-theme')) === theme,
      'history theme',
    );
    await page.locator('.login-history').scrollIntoViewIfNeeded();
    const widths = await page.locator('.login-history').evaluate((el) =>
      [el, ...el.querySelectorAll('.log-detail,.grow,strong,p,small')].map((e) => ({
        client: e.clientWidth,
        scroll: e.scrollWidth,
      })),
    );
    assert.ok(
      widths.every((v) => v.scroll <= v.client + 1),
      'Login history must wrap long names and metadata',
    );
    await page.screenshot({ path: join(root, `docs/phase5-login-history-${theme}.png`) });
  }
  pass('最近登录记录长名称、状态与时间在真实深浅主题中换行，无文字溢出');
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  await page
    .locator(`[data-workflow-id="${wf.id}"]`)
    .getByRole('button', { name: '编辑流程' })
    .click();
  await page.getByRole('button', { name: '授权自动登录', exact: true }).waitFor();
  const settings = (await call('snapshot')).config.settings;
  await call('save_settings', { settings: { ...settings, theme: 'dark' } });
  await until(
    async () => (await page.locator('html').getAttribute('data-theme')) === 'dark',
    'dark theme',
  );
  await page.getByRole('button', { name: '自动排列', exact: true }).click();
  await delay(800);
  await page.locator('.react-flow__node').filter({ hasText: 'auto_login' }).click();
  await page.getByLabel('未确认登录成功时').waitFor();
  await page.screenshot({ path: join(root, 'docs/phase5-workflow-dark.png') });
  await call('save_settings', { settings: { ...settings, theme: 'light' } });
  await until(
    async () => (await page.locator('html').getAttribute('data-theme')) === 'light',
    'light theme',
  );
  await page.screenshot({ path: join(root, 'docs/phase5-workflow-light.png') });
  assert.equal((await page.locator('body').innerText()).includes('StartFlowSynthetic-only'), false);
  pass('登录节点编辑器与授权入口在真实 WebView2 深浅主题中渲染，无秘密内容');
  clean(stderr);
  const conn = new DatabaseSync(dbfile);
  assert.equal(conn.prepare('SELECT MAX(version) v FROM migrations').get().v, 7);
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM pragma_foreign_key_check').get().n, 0);
  for (const table of [
    'web_login_configs',
    'desktop_login_configs',
    'workflow_login_grants',
    'workflow_execution_logs',
  ])
    clean(conn.prepare('SELECT * FROM ' + table).all());
  conn.close();
  pass('Schema 7、外键一致性及数据库/IPC/日志秘密检查');
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
    for (const id of (await call('web_login_snapshot').catch(() => ({ active_runs: [] })))
      .active_runs)
      await call('web_login_close', { id }).catch(() => {});
    await delay(1200);
  }
  if (page && isolated) {
    for (const a of (await call('accounts_list').catch(() => ({ accounts: [] }))).accounts)
      await call('accounts_delete', { id: a.id, expectedRevision: a.revision }).catch(() => {});
  }
  if (page) await call('quit').catch(() => {});
  await browser?.close().catch(() => {});
  if (app) app.kill();
  aiServer.close();
  await web.close();
  clean(report);
  await writeFile(
    join(root, 'docs/phase5-login-workflow-native-results.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
