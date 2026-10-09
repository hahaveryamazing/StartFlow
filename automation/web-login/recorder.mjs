import { chromium } from 'playwright';
import { locatorFor, validateLocator, uniqueControl, inspectForm } from './locators.mjs';
import { installPicker } from './picker.mjs';
const fields = ['username', 'password', 'submit', 'success', 'identity', 'challenge', 'failure'];
const secure = (value, origin) => {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.origin !== origin ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw Error('blocked');
  return u;
};
// Avoid volatile IDs, hashes, long opaque metadata and URLs. Never inspect typed values.
const safeMetadata = (value) =>
  typeof value === 'string' &&
  value.trim() &&
  Buffer.byteLength(value) < 180 &&
  !/[\x00-\x1f]|https?:|[0-9a-f]{16,}|[A-Za-z0-9_\-]{28,}/i.test(value);
export async function generateLocator(page, point, field) {
  if (!fields.includes(field)) throw Error('invalid');
  const metadata = await page.evaluate(
    ({ x, y, field }) => {
      let e = document.elementFromPoint(x, y);
      if (!e || e.closest('#__startflow_recorder_overlay')) return null;
      if (field === 'submit') e = e.closest('button,input') ?? e;
      if (e instanceof HTMLLabelElement && e.control) e = e.control;
      const css = [];
      if (e.id) css.push('#' + CSS.escape(e.id));
      if (e.getAttribute('name'))
        css.push(e.tagName.toLowerCase() + '[name="' + CSS.escape(e.getAttribute('name')) + '"]');
      const classes = [...e.classList]
        .filter((v) => /^[a-zA-Z_][a-zA-Z0-9_\-]{0,40}$/.test(v))
        .slice(0, 3);
      if (classes.length)
        css.push(e.tagName.toLowerCase() + classes.map((c) => '.' + CSS.escape(c)).join(''));
      let current = e,
        path = [];
      for (let i = 0; current && i < 4; i++, current = current.parentElement) {
        path.unshift(current.id ? '#' + CSS.escape(current.id) : current.tagName.toLowerCase());
        css.push(path.join(' > '));
        if (current.id) break;
      }
      // Success / identity locators must not embed visible account, session or token text.
      const control = ['username', 'password', 'submit'].includes(field);
      const label = control
        ? e.getAttribute('aria-label') ||
          (e.labels?.length === 1 ? e.labels[0].textContent.trim() : '')
        : '';
      const button =
        field === 'submit'
          ? e.getAttribute('aria-label') ||
            (e.tagName === 'BUTTON' && !e.querySelector('input,textarea')
              ? e.textContent.trim()
              : '')
          : '';
      return {
        label,
        button,
        placeholder: control ? e.getAttribute('placeholder') : '',
        testId: e.getAttribute('data-testid'),
        css,
      };
    },
    { ...point, field },
  );
  if (!metadata) throw Error('invalid');
  const candidates = [];
  if (field === 'submit' && safeMetadata(metadata.button))
    candidates.push({ kind: 'role', role: 'button', name: metadata.button });
  if (field === 'username' && safeMetadata(metadata.label))
    candidates.push({ kind: 'role', role: 'textbox', name: metadata.label });
  if (safeMetadata(metadata.label)) candidates.push({ kind: 'label', value: metadata.label });
  if (safeMetadata(metadata.placeholder))
    candidates.push({ kind: 'placeholder', value: metadata.placeholder });
  if (safeMetadata(metadata.testId)) candidates.push({ kind: 'test_id', value: metadata.testId });
  for (const css of metadata.css)
    if (safeMetadata(css)) candidates.push({ kind: 'css', value: css });
  for (const candidate of candidates) {
    try {
      validateLocator(candidate);
      const target = await uniqueControl(page, candidate, field);
      const same = await target.evaluate(
        (e, { x, y, field }) => {
          let other = document.elementFromPoint(x, y);
          if (field === 'submit') other = other?.closest('button,input') ?? other;
          if (other instanceof HTMLLabelElement && other.control) other = other.control;
          return e === other;
        },
        { ...point, field },
      );
      if (same) return candidate;
    } catch {}
  }
  throw Error('ambiguous');
}
export async function recorderSession(request, transport) {
  secure(request.login_url, request.origin);
  let browser,
    context,
    page,
    closing = false,
    blocked = false,
    armed = null,
    picking = false,
    manual = false,
    manualPosts = 0,
    action = null;
  let rules = {},
    verifiedLogin = false,
    verifiedSuccess = false;
  const state = (status) => transport.emit({ type: 'state', status });
  const close = async () => {
    closing = true;
    await browser?.close().catch(() => {});
  };
  const ensure = () => {
    if (blocked || closing || !page || page.isClosed()) throw Error('blocked');
    secure(page.url(), request.origin);
  };
  const test = async () => {
    ensure();
    const results = {};
    for (const field of fields) {
      if (!rules[field]) continue;
      try {
        const count = await locatorFor(page, rules[field]).count();
        results[field] = count === 0 ? 'absent' : count > 1 ? 'ambiguous' : 'ok';
        if (count === 1) await uniqueControl(page, rules[field], field);
      } catch {
        results[field] = results[field] === 'ambiguous' ? 'ambiguous' : 'invalid';
      }
    }
    if (['username', 'password', 'submit'].every((f) => results[f] === 'ok')) {
      const submit = await uniqueControl(page, rules.submit, 'submit');
      action = await submit.evaluate(
        (e) =>
          new URL(
            e.getAttribute('formaction') || e.form?.getAttribute('action') || location.href,
            location.href,
          ).href,
      );
      secure(action, request.origin);
      verifiedLogin = await inspectForm(page, {
        origin: request.origin,
        form_action_url: action,
        locators: rules,
      });
      if (!verifiedLogin) results.submit = 'form_mismatch';
    }
    verifiedSuccess = false;
    if (results.success === 'ok' && results.identity === 'ok') {
      verifiedSuccess =
        (await locatorFor(page, rules.identity).innerText()).trim() === request.username &&
        !(await page.locator('input[type="password"]').filter({ visible: true }).count());
      if (!verifiedSuccess) results.identity = 'identity_mismatch';
    }
    transport.emit({
      type: 'tested',
      results,
      verified_login: verifiedLogin,
      verified_success: verifiedSuccess,
      form_action_url: action,
    });
  };
  const command = async (message) => {
    if (message.type === 'close') {
      await close();
      return;
    }
    ensure();
    if (message.type === 'arm' && fields.includes(message.field)) {
      armed = message.field;
      manual = false;
      await page.evaluate((f) => window.__sfRecordArm(f), armed);
      state('picking');
    } else if (message.type === 'test') {
      if (message.rules) {
        for (const [key, rule] of Object.entries(message.rules)) {
          if (!fields.includes(key)) throw Error('invalid');
          validateLocator(rule);
        }
      }
      const next = message.rules ?? rules;
      if (
        ['username', 'password', 'submit'].some(
          (f) => JSON.stringify(next[f]) !== JSON.stringify(rules[f]),
        )
      )
        verifiedLogin = false;
      if (['success', 'identity'].some((f) => JSON.stringify(next[f]) !== JSON.stringify(rules[f])))
        verifiedSuccess = false;
      rules = next;
      await test();
      state('ready');
    } else if (message.type === 'manual') {
      await test();
      for (const field of ['username', 'password', 'submit'])
        await uniqueControl(page, rules[field], field);
      if (
        !verifiedLogin ||
        !(await inspectForm(page, {
          origin: request.origin,
          form_action_url: action,
          locators: rules,
        }))
      )
        throw Error('invalid');
      armed = null;
      manual = true;
      await page.evaluate(() => window.__sfRecordArm(null));
      state('manual');
    } else if (message.type === 'reload') {
      armed = null;
      manual = false;
      verifiedLogin = false;
      verifiedSuccess = false;
      manualPosts = 0;
      await context.clearCookies();
      await page.goto(request.login_url, { waitUntil: 'domcontentloaded' });
      state('ready');
    } else throw Error('invalid');
  };
  let queue = Promise.resolve();
  transport.onCommand((m) => {
    queue = queue
      .then(() => command(m))
      .catch(async () => {
        if (blocked) {
          state('blocked');
          await close();
        } else if (!closing) state('invalid');
      });
  });
  const heartbeat = setInterval(() => transport.emit({ type: 'heartbeat' }), 2000);
  try {
    const args = [];
    if (request.test_mode && request.test_pin) {
      if (
        !['127.0.0.1', 'localhost'].includes(new URL(request.origin).hostname) ||
        !/^[A-Za-z0-9+/]{43}=$/.test(request.test_pin)
      )
        throw Error('blocked');
      args.push('--ignore-certificate-errors-spki-list=' + request.test_pin);
      // Explicit debug-only integration harness. Rust release never sends this field.
      if (request.test_cdp_port === 9234)
        args.push('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9234');
    }
    browser = await chromium.launch({
      executablePath: request.browser_executable ?? chromium.executablePath(),
      headless: request.test_mode && request.test_headless === true,
      chromiumSandbox: true,
      timeout: 15000,
      args,
      ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'],
    });
    context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    context.setDefaultTimeout(5000);
    context.setDefaultNavigationTimeout(15000);
    await context.addInitScript(installPicker);
    await context.route('**/*', async (route) => {
      const req = route.request();
      let allowed = false;
      try {
        const u = new URL(req.url());
        allowed =
          u.protocol === 'https:' && u.origin === request.origin && !u.username && !u.password;
        if (req.isNavigationRequest() && req.frame() === page?.mainFrame())
          allowed = allowed && !u.search && !u.hash;
        if (req.method() !== 'GET')
          allowed =
            allowed &&
            manual &&
            req.method() === 'POST' &&
            req.url() === action &&
            manualPosts++ === 0;
      } catch {}
      if (!allowed) {
        if (
          req.method() !== 'GET' ||
          (req.isNavigationRequest() && req.frame() === page?.mainFrame())
        ) {
          blocked = true;
          state('blocked');
          void close();
        }
        await route.abort().catch(() => {});
      } else await route.continue().catch(() => {});
    });
    await context.routeWebSocket('**/*', (ws) => ws.close());
    page = await context.newPage();
    context.on('page', (p) => {
      if (p !== page) void p.close().catch(() => {});
    });
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('download', (d) => d.cancel().catch(() => {}));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
    cdp.on('Fetch.requestPaused', async (event) => {
      try {
        if (event.responseErrorReason) {
          await cdp.send('Fetch.failRequest', {
            requestId: event.requestId,
            errorReason: event.responseErrorReason,
          });
          return;
        }
        const location = event.responseHeaders?.find((h) => h.name.toLowerCase() === 'location');
        if (event.responseStatusCode >= 300 && event.responseStatusCode < 400 && location) {
          secure(new URL(location.value, event.request.url).href, request.origin);
          if (event.request.method === 'POST' && [307, 308].includes(event.responseStatusCode))
            throw Error('blocked');
        }
        await cdp.send('Fetch.continueResponse', { requestId: event.requestId });
      } catch {
        blocked = true;
        state('blocked');
        await cdp
          .send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
          .catch(() => {});
        await close();
      }
    });
    await page.exposeBinding('__sfRecordClick', async (source, point) => {
      if (
        picking ||
        !armed ||
        source.frame !== page.mainFrame() ||
        !point ||
        Object.keys(point).sort().join(',') !== 'x,y' ||
        ![point.x, point.y].every((v) => Number.isFinite(v) && v >= 0 && v < 20000)
      )
        return;
      picking = true;
      try {
        ensure();
        const field = armed,
          rule = await generateLocator(page, point, field);
        ensure();
        if (field !== armed) return;
        if (field === 'submit') {
          const target = await uniqueControl(page, rule, field);
          const form = await target.evaluate((e) => ({
            action: new URL(
              e.getAttribute('formaction') || e.form?.getAttribute('action') || location.href,
              location.href,
            ).href,
            method: e.getAttribute('formmethod') || e.form?.method,
            target: e.getAttribute('formtarget') || e.form?.getAttribute('target'),
          }));
          secure(form.action, request.origin);
          if (form.method !== 'post' || ![null, '', '_self'].includes(form.target))
            throw Error('invalid');
          action = form.action;
        }
        rules[field] = rule;
        armed = null;
        if (['username', 'password', 'submit'].includes(field)) verifiedLogin = false;
        else verifiedSuccess = false;
        await page.evaluate(() => window.__sfRecordArm(null));
        transport.emit({
          type: 'picked',
          field,
          rule,
          form_action_url: action,
          page_url: page.url(),
        });
        state('ready');
      } catch {
        state(blocked ? 'blocked' : 'invalid');
      } finally {
        picking = false;
      }
    });
    transport.onPage?.(page);
    await page.goto(request.login_url, { waitUntil: 'domcontentloaded' });
    ensure();
    state('ready');
    const end = performance.now() + 30 * 60 * 1000;
    while (!closing && !page.isClosed() && performance.now() < end)
      await new Promise((r) => setTimeout(r, 200));
  } catch {
    state(blocked ? 'blocked' : 'failed');
  } finally {
    clearInterval(heartbeat);
    await close();
    transport.emit({ type: 'closed' });
  }
}
