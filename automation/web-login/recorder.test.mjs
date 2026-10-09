import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fixture } from './test-fixture.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve('.test-runtime/browsers');
const { recorderSession, generateLocator } = await import('./recorder.mjs');
const { loginSession } = await import('./engine.mjs');
const { locatorFor, validateLocator } = await import('./locators.mjs');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await delay(100);
  }
  throw Error('Recorder state timeout');
}
async function record(f, mode = 'record', origin = f.origin) {
  if (new URL(f.origin + '/login/' + mode).origin !== origin) {
    await assert.rejects(recorderSession({ origin, login_url: f.origin + '/login/' + mode }, {}));
    throw Error('blocked');
  }
  const events = [];
  let page, command;
  const promise = recorderSession(
    {
      origin,
      login_url: f.origin + '/login/' + mode,
      username: 'user@example.test',
      test_mode: true,
      test_pin: f.pin,
      test_headless: true,
    },
    {
      emit: (e) => events.push(e),
      onCommand: (fn) => (command = fn),
      onPage: (p) => (page = p),
    },
  );
  const s = {
    events,
    promise,
    get page() {
      return page;
    },
    has: (status) => events.some((e) => e.type === 'state' && e.status === status),
    send: async (c) => {
      const n = events.length;
      command(c);
      await until(() => events.slice(n).some((e) => e.type === 'state' || e.type === 'closed'));
    },
    pick: async (field, locator) => {
      const n = events.length;
      await s.send({ type: 'arm', field });
      const box = await locator.boundingBox();
      assert.ok(box);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await until(
        () =>
          events.slice(n).some((e) => e.type === 'picked' && e.field === field) || s.has('invalid'),
      );
      const picked = events.slice(n).find((e) => e.type === 'picked' && e.field === field);
      assert.ok(picked, 'Expected a unique, safe picked locator');
      return picked.rule;
    },
    close: async () => {
      command?.({ type: 'close' });
      await promise;
    },
  };
  f.sessions ??= [];
  f.sessions.push(s);
  await until(() => s.has('ready') || s.has('blocked') || s.has('failed'));
  return s;
}
async function login(f, config, account, password) {
  const events = [];
  let command,
    reads = 0;
  const promise = loginSession(
    {
      config,
      profile: join(f.directory, 'profiles', account),
      username: 'user@example.test',
      test_mode: true,
      test_pin: f.pin,
      test_headless: true,
    },
    {
      emit: (e) => events.push(e),
      onCommand: (fn) => (command = fn),
      password: async () => {
        reads++;
        return password;
      },
    },
  );
  const s = {
    events,
    get reads() {
      return reads;
    },
    has: (status) => events.some((e) => e.status === status),
    close: async () => {
      await command?.({ type: 'close' });
      await promise;
    },
  };
  f.sessions.push(s);
  return s;
}
test('真实点选五个控件，录制不含秘密；录制配置接入登录引擎及独立会话复用', async () => {
  const f = await fixture();
  const password = 'synthetic-recording-password';
  f.users.set('user@example.test', password);
  try {
    const s = await record(f);
    const p = s.page;
    const rules = {};
    rules.username = await s.pick('username', p.getByLabel('工作账号'));
    rules.password = await s.pick('password', p.getByLabel('登录密码'));
    rules.submit = await s.pick('submit', p.getByRole('button', { name: '安全登录' }));
    assert.equal(rules.username.kind, 'role');
    assert.equal(rules.password.kind, 'label');
    assert.equal(rules.submit.kind, 'role');
    assert.equal(f.posts.get('record'), undefined, 'Picker clicks must not submit');
    await s.send({ type: 'test', rules });
    assert.equal(s.events.filter((e) => e.type === 'tested').at(-1).verified_login, true);
    await s.send({ type: 'manual' });
    await p.getByLabel('工作账号').fill('user@example.test');
    await p.getByLabel('登录密码').fill(password);
    await p.getByRole('button', { name: '安全登录' }).click();
    await p.getByTestId('signed-in').waitFor();
    rules.success = await s.pick('success', p.getByTestId('signed-in'));
    rules.identity = await s.pick('identity', p.getByTestId('account-identity'));
    assert.equal(rules.success.kind, 'test_id');
    assert.equal(rules.identity.kind, 'test_id');
    await s.send({ type: 'test', rules });
    const proof = s.events.filter((e) => e.type === 'tested').at(-1);
    assert.equal(proof.verified_login, true);
    assert.equal(proof.verified_success, true);
    const metadata = JSON.stringify(s.events);
    assert.ok(!metadata.includes(password));
    assert.ok(!metadata.includes('sf_session'));
    assert.ok(
      !metadata.includes('user@example.test'),
      'Identity text must not be part of locators',
    );
    await s.close();
    const aid = randomUUID();
    const config = {
      ...f.config(aid, 'record'),
      schema_version: 2,
      credential_ref: randomUUID(),
      locators: {
        ...rules,
        challenge: { kind: 'css', value: '[data-mfa]' },
        failure: { kind: 'css', value: '#failure' },
      },
    };
    const unauth = await login(f, config, aid, null);
    await until(() => unauth.has('authorization_required'));
    await unauth.close();
    const first = await login(f, config, aid, password);
    await until(() => first.has('authenticated'));
    assert.equal(first.reads, 1);
    await first.close();
    const reused = await login(f, config, aid, null);
    await until(() => reused.has('session_reused'));
    assert.equal(reused.reads, 0);
    assert.equal(f.posts.get('record'), 2, 'One manual recording submit and one automated submit');
  } finally {
    await f.close();
  }
});
test('动态页面优先稳定语义，多个匹配报错而不选择第一个', async () => {
  const f = await fixture();
  try {
    const s = await record(f, 'dynamic');
    const rule = await s.pick('username', s.page.getByLabel('工作账号'));
    await s.send({ type: 'reload' });
    assert.equal(await locatorFor(s.page, rule).count(), 1);
    await s.close();
    const duplicate = await record(f, 'duplicate');
    await duplicate.send({
      type: 'test',
      rules: { username: { kind: 'role', role: 'textbox', name: '工作账号' } },
    });
    assert.equal(
      duplicate.events.filter((e) => e.type === 'tested').at(-1).results.username,
      'ambiguous',
    );
    assert.equal(duplicate.events.filter((e) => e.type === 'tested').at(-1).verified_login, false);
    await duplicate.send({ type: 'manual' });
    assert.ok(duplicate.has('invalid'));
    assert.equal(f.posts.size, 0);
  } finally {
    await f.close();
  }
});
test('错误 Origin、恶意重定向、跨域表单及无效定位不泄露输入', async () => {
  const f = await fixture();
  try {
    await assert.rejects(record(f, 'record', 'https://wrong.example.test'));
    const redirected = await record(f, 'redirect');
    assert.ok(redirected.has('blocked'));
    await redirected.close();
    const s = await record(f, 'evil-action');
    await s.send({ type: 'arm', field: 'submit' });
    const box = await s.page.locator('#login').boundingBox();
    await s.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await until(() => s.has('invalid'));
    assert.ok(!s.events.some((e) => e.type === 'picked' && e.field === 'submit'));
    await s.send({ type: 'test', rules: { password: { kind: 'css', value: '[' } } });
    assert.equal(s.events.filter((e) => e.type === 'tested').at(-1).results.password, 'invalid');
    assert.equal(f.evilRequests, 0);
    assert.equal(f.posts.size, 0);
  } finally {
    await f.close();
  }
});
test('定位 Schema 拒绝脚本、跨帧和额外秘密字段', () => {
  for (const rule of [
    { kind: 'css', value: 'xpath=//input' },
    { kind: 'css', value: '#x >> iframe' },
    { kind: 'role', role: 'button', name: '登录', password: 'secret' },
    { kind: 'evaluate', value: 'evil' },
    { kind: 'label', value: '\n' },
  ])
    assert.throws(() => validateLocator(rule));
});
test('Placeholder 与 CSS 回退可真实定位，结构变化报告 locator_invalid 而不读取密码', async () => {
  const f = await fixture();
  try {
    const s = await record(f);
    await s.page.setContent(
      '<form style="margin-top:100px" method="post"><input type="email" placeholder="办公邮箱"><input type="password" class="password-entry"></form>',
    );
    const user = s.page.getByPlaceholder('办公邮箱');
    let b = await user.boundingBox();
    const rule = await generateLocator(
      s.page,
      { x: b.x + b.width / 2, y: b.y + b.height / 2 },
      'username',
    );
    assert.equal(rule.kind, 'placeholder');
    b = await s.page.locator('.password-entry').boundingBox();
    const passwordRule = await generateLocator(
      s.page,
      { x: b.x + b.width / 2, y: b.y + b.height / 2 },
      'password',
    );
    assert.equal(passwordRule.kind, 'css');
    await s.close();
    const aid = randomUUID();
    const config = {
      ...f.config(aid, 'missing'),
      schema_version: 2,
      credential_ref: randomUUID(),
      locators: {
        username: rule,
        password: passwordRule,
        submit: { kind: 'role', role: 'button', name: '安全登录' },
        success: { kind: 'test_id', value: 'signed-in' },
        identity: { kind: 'test_id', value: 'account-identity' },
        challenge: { kind: 'css', value: '[data-mfa]' },
        failure: { kind: 'css', value: '#failure' },
      },
    };
    const run = await login(f, config, aid, 'test-password');
    await until(() => run.has('locator_invalid'));
    assert.equal(run.reads, 0);
    assert.equal(f.posts.size, 0);
  } finally {
    await f.close();
  }
});
