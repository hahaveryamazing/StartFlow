import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolve } from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve('.test-runtime/browsers');
const { loginSession } = await import('./engine.mjs');
import { fixture } from './test-fixture.mjs';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 120; i++) {
    if (await fn()) return;
    await delay(100);
  }
  throw Error('State timeout');
}
async function run(f, account, mode = 'normal', password = 'test-only-password', opts = {}) {
  const events = [];
  let reads = 0,
    page,
    command;
  const config = f.config(account, mode);
  const promise = loginSession(
    {
      config,
      profile: join(f.directory, 'browser-profiles', account),
      username: opts.username ?? 'user@example.test',
      test_mode: true,
      test_pin: opts.untrustedTLS ? undefined : f.pin,
      test_headless: true,
      previous_session: opts.previous ?? false,
    },
    {
      emit: (e) => events.push(e),
      onCommand: (fn) => {
        command = fn;
      },
      onPage: (p) => {
        page = p;
      },
      password: async () => {
        reads++;
        if (opts.passwordDelay) await delay(opts.passwordDelay);
        return password;
      },
    },
  );
  const session = {
    events,
    get reads() {
      return reads;
    },
    get page() {
      return page;
    },
    has: (s) => events.some((e) => e.type === 'status' && e.status === s),
    close: async () => {
      await command?.({ type: 'close' });
      await promise;
    },
    promise,
  };
  f.sessions ??= [];
  f.sessions.push(session);
  return session;
}
// Real Chromium and local HTTPS. No passwords or cookies are included in TAP output.
test('真实登录、持久 Cookie 会话复用和账号独立 Profile', async () => {
  const f = await fixture();
  let a, b, c;
  try {
    f.users.set('user@example.test', 'test-only-password');
    f.users.set('other@example.test', 'other-only');
    const aid = randomUUID();
    a = await run(f, aid);
    await until(() => a.has('authenticated'));
    assert.equal(a.reads, 1);
    await a.close();
    b = await run(f, aid, 'normal', null);
    await until(() => b.has('session_reused'));
    assert.equal(b.reads, 0);
    assert.equal(f.posts.get('normal'), 1);
    await b.close();
    c = await run(f, randomUUID(), 'normal', 'other-only', { username: 'other@example.test' });
    await until(() => c.has('authenticated'));
    assert.equal(c.reads, 1);
  } finally {
    await a?.close();
    await b?.close();
    await c?.close();
    await f.close();
  }
});
test('恶意重定向、跨 Origin 表单和提交时篡改不泄露密码', async () => {
  const f = await fixture();
  try {
    for (const mode of ['redirect', 'evil-action', 'mutation', 'redirect-on-input']) {
      const r = await run(f, randomUUID(), mode);
      await until(() => r.has('blocked'));
      if (['redirect', 'evil-action'].includes(mode)) assert.equal(r.reads, 0);
      await r.close();
    }
    assert.equal(f.evilRequests, 0);
  } finally {
    await f.close();
  }
});
test('失败、超时、307 重放最多一个自动提交', async () => {
  const f = await fixture();
  try {
    for (const [mode, status] of [
      ['fail', 'failed'],
      ['timeout', 'timeout'],
      ['resubmit', 'blocked'],
    ]) {
      const r = await run(f, randomUUID(), mode);
      await until(() => r.has(status));
      assert.equal(f.posts.get(mode), 1);
      assert.equal(r.reads, 1);
      await r.close();
    }
  } finally {
    await f.close();
  }
});
test('验证码、扫码、MFA、Passkey 不读取密码、不自动提交', async () => {
  const f = await fixture();
  try {
    for (const mode of ['captcha', 'captcha-frame', 'mfa', 'qr', 'passkey', 'passkey-api']) {
      const r = await run(f, randomUUID(), mode);
      await until(() => r.has('waiting_manual'));
      assert.equal(r.reads, 0);
      assert.ok(!r.events.some((e) => e.submitted));
      await r.close();
    }
  } finally {
    await f.close();
  }
});
test('提交后 MFA 停止、人工验证成功与会话过期检测', async () => {
  const f = await fixture();
  let a, b;
  try {
    a = await run(f, randomUUID(), 'post-mfa');
    await until(() => a.has('waiting_manual'));
    assert.equal(a.reads, 1);
    assert.equal(f.posts.get('post-mfa'), 1);
    await a.close();
    b = await run(f, randomUUID(), 'mfa');
    await until(() => b.has('waiting_manual'));
    await b.page.locator('#identity-input').fill('user@example.test');
    await b.page.locator('#otp').fill('test-code');
    await b.page.locator('#verify').click();
    await until(() => b.has('authenticated'));
    assert.equal(b.reads, 0);
    f.expire();
    await b.page.goto(f.origin + '/login/normal');
    await until(() => b.has('session_expired'));
    assert.equal(b.reads, 0);
  } finally {
    await a?.close();
    await b?.close();
    await f.close();
  }
});
test('未知输入框、无授权与错误账号身份均不自动填密', async () => {
  const f = await fixture();
  let a, b, c;
  try {
    f.users.set('user@example.test', 'test-only-password');
    a = await run(f, randomUUID(), 'missing');
    await until(() => a.has('timeout'));
    assert.equal(a.reads, 0);
    await a.close();
    b = await run(f, randomUUID(), 'normal', null);
    await until(() => b.has('authorization_required'));
    assert.equal(f.posts.size, 0);
    await b.close();
    const id = randomUUID();
    c = await run(f, id);
    await until(() => c.has('authenticated'));
    await c.close();
    c = await run(f, id, 'normal', null, { username: 'wrong@example.test' });
    await until(() => c.has('blocked'));
    assert.equal(c.reads, 0);
  } finally {
    await a?.close();
    await b?.close();
    await c?.close();
    await f.close();
  }
});
test('未受信任 HTTPS 证书不填写或提交凭据', async () => {
  const f = await fixture();
  try {
    const r = await run(f, randomUUID(), 'normal', 'test-only-password', { untrustedTLS: true });
    await until(() => r.has('blocked'));
    assert.equal(r.reads, 0);
    assert.equal(f.posts.size, 0);
  } finally {
    await f.close();
  }
});
test('凭据响应超过期限时不填写也不提交', async () => {
  const f = await fixture();
  try {
    const r = await run(f, randomUUID(), 'normal', 'test-only-password', { passwordDelay: 5000 });
    await until(() => r.has('timeout'));
    assert.equal(r.reads, 1);
    assert.equal(f.posts.size, 0);
  } finally {
    await f.close();
  }
});
