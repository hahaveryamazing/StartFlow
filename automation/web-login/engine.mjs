import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { configLocator, validateLocator, inspectForm, uniqueControl } from './locators.mjs';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secure = (u) => {
  const v = new URL(u);
  if (v.protocol !== 'https:' || v.username || v.password || v.search || v.hash)
    throw Error('blocked');
  return v;
};
function validate(config, profile) {
  if (config.locators)
    for (const field of [
      'username',
      'password',
      'submit',
      'success',
      'identity',
      'challenge',
      'failure',
    ])
      validateLocator(config.locators[field]);
  if (!/^[0-9a-f-]{36}$/i.test(config.account_id) || basename(profile) !== config.account_id)
    throw Error('blocked');
  if (secure(config.origin).origin !== config.origin) throw Error('blocked');
  for (const u of [config.login_url, config.form_action_url])
    if (secure(u).origin !== config.origin) throw Error('blocked');
  for (const key of [
    'username_selector',
    'password_selector',
    'submit_selector',
    'success_selector',
    'identity_selector',
    'challenge_selector',
    'failure_selector',
  ])
    if (
      typeof config[key] !== 'string' ||
      !config[key] ||
      config[key].length > 512 ||
      config[key].includes('>>')
    )
      throw Error('blocked');
  if (
    !Number.isInteger(config.timeout_seconds) ||
    config.timeout_seconds < 3 ||
    config.timeout_seconds > 120
  )
    throw Error('blocked');
}
// Only typed state leaves the worker. No URLs, DOM, exceptions, screenshots, traces or secrets.
export async function loginSession(request, transport) {
  const { config, profile, username } = request;
  let context,
    page,
    blocked = false,
    submitted = false,
    authenticated = false,
    closing = false,
    passwordPhase = false,
    submissionRequests = 0,
    expires = performance.now() + config.timeout_seconds * 1000;
  const state = (status) => transport.emit({ type: 'status', status, submitted });
  const challenge = async (forProof = false) =>
    (await page.evaluate(
      (forProof) =>
        window.__startflowAuthChallenge === true && (!forProof || window.__startflowAuthActive > 0),
      forProof,
    )) ||
    (await configLocator(page, config, 'challenge').filter({ visible: true }).count()) > 0 ||
    (await page
      .locator(
        'input[autocomplete="one-time-code"], [data-captcha], [data-mfa], [data-passkey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]',
      )
      .filter({ visible: true })
      .count()) > 0;
  const proof = async () => {
    if (new URL(page.url()).origin !== config.origin) throw Error('blocked');
    if (await challenge(true)) return false;
    const success = configLocator(page, config, 'success'),
      identity = configLocator(page, config, 'identity');
    if ((await success.count()) > 1 || (await identity.count()) > 1) throw Error('locator_invalid');
    if (
      (await success.count()) !== 1 ||
      !(await success.isVisible()) ||
      (await identity.count()) !== 1 ||
      !(await identity.isVisible())
    )
      return false;
    if ((await identity.innerText()).trim() !== username) throw Error('blocked');
    // A visible password form and success marker together are ambiguous, never accepted.
    if (await configLocator(page, config, 'password').filter({ visible: true }).count())
      return false;
    return true;
  };
  const guard = async () => {
    if (performance.now() >= expires) throw Error('timeout');
    if (blocked || page.isClosed() || new URL(page.url()).origin !== config.origin)
      throw Error('blocked');
    if (config.locators)
      for (const field of ['username', 'password', 'submit'])
        await uniqueControl(page, config.locators[field], field);
    const valid = await inspectForm(page, config);
    if (!valid) throw Error('blocked');
    if (await challenge()) throw Error('manual');
    if (performance.now() >= expires) throw Error('timeout');
  };
  async function close() {
    closing = true;
    await context?.close().catch(() => {});
  }
  transport.onCommand(async (message) => {
    if (message.type === 'close') await close();
    if (message.type === 'check') {
      let status = 'blocked';
      try {
        // A DOM marker left on an old page is not proof that its server session is valid.
        // Reload only the previously authorized same-origin login URL, never a model URL.
        if (!blocked && !closing) {
          await page.goto(config.login_url, { waitUntil: 'domcontentloaded' });
          const checkDeadline = performance.now() + config.timeout_seconds * 1000;
          while (
            !blocked &&
            !(await proof()) &&
            !(await challenge(true)) &&
            !(await configLocator(page, config, 'password').filter({ visible: true }).count()) &&
            performance.now() < checkDeadline
          )
            await pause(200);
        }
        if (blocked || closing) status = 'blocked';
        else if (await challenge(true)) status = 'waiting_manual';
        else if (await proof()) status = 'session_reused';
        else status = authenticated ? 'session_expired' : 'authorization_required';
      } catch {}
      transport.emit({ type: 'checked', nonce: message.nonce, status });
    }
  });
  const timer = setInterval(() => transport.emit({ type: 'heartbeat' }), 2000);
  try {
    validate(config, profile);
    await mkdir(profile, { recursive: true });
    if ((await lstat(profile)).isSymbolicLink()) throw Error('blocked');
    const preferences = join(profile, 'Default', 'Preferences');
    await mkdir(join(profile, 'Default'), { recursive: true });
    let prefs = {};
    try {
      prefs = JSON.parse(await readFile(preferences, 'utf8'));
    } catch {}
    prefs.credentials_enable_service = false;
    prefs.profile = { ...prefs.profile, password_manager_enabled: false };
    await writeFile(preferences, JSON.stringify(prefs));
    const args = [];
    // Test-only pinned SPKI exception, limited to the local HTTPS fixture; no global TLS bypass.
    if (request.test_mode && request.test_pin) {
      if (
        !['localhost', '127.0.0.1'].includes(secure(config.origin).hostname) ||
        !/^[A-Za-z0-9+/]{43}=$/.test(request.test_pin)
      )
        throw Error('blocked');
      args.push('--ignore-certificate-errors-spki-list=' + request.test_pin);
    }
    context = await chromium.launchPersistentContext(profile, {
      executablePath: request.browser_executable ?? chromium.executablePath(),
      timeout: config.timeout_seconds * 1000,
      headless: request.test_mode && request.test_headless === true,
      chromiumSandbox: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
      args,
      ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'],
    });
    context.setDefaultTimeout(3000);
    await context.addInitScript(() => {
      // Observe the standard WebAuthn request; do not fulfill, intercept or bypass it.
      if (navigator.credentials?.get) {
        const original = navigator.credentials.get.bind(navigator.credentials);
        navigator.credentials.get = (options) => {
          if (!options?.publicKey) return original(options);
          window.__startflowAuthChallenge = true;
          window.__startflowAuthActive = (window.__startflowAuthActive ?? 0) + 1;
          return original(options).finally(() => {
            window.__startflowAuthActive--;
          });
        };
      }
    });
    context.setDefaultNavigationTimeout(config.timeout_seconds * 1000);
    await context.route('**/*', async (route) => {
      let allowed = false;
      try {
        const u = new URL(route.request().url());
        allowed =
          u.protocol === 'https:' && u.origin === config.origin && !u.username && !u.password;
        if (route.request().isNavigationRequest() && route.request().frame() === page?.mainFrame())
          allowed = allowed && !u.search && !u.hash;
      } catch {}
      if (allowed && passwordPhase && route.request().method() !== 'GET') {
        allowed =
          submitted &&
          route.request().method() === 'POST' &&
          route.request().url() === config.form_action_url &&
          submissionRequests++ === 0;
      }
      if (!allowed) {
        // External static resources / challenge frames remain blocked; a visible
        // challenge can still be reported as waiting for the user, without fill.
        if (
          passwordPhase ||
          route.request().method() !== 'GET' ||
          (route.request().isNavigationRequest() && route.request().frame() === page?.mainFrame())
        )
          blocked = true;
        await route.abort('blockedbyclient').catch(() => {});
      } else await route.continue().catch(() => {});
    });
    await context.routeWebSocket('**/*', (ws) => ws.close());
    page = context.pages()[0] ?? (await context.newPage());
    // Playwright route() does not re-intercept redirected requests. Inspect Location
    // BEFORE Chromium follows it, including 307/308 which would replay a password POST.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
    cdp.on('Fetch.requestPaused', async (event) => {
      try {
        if (event.responseErrorReason) {
          await cdp
            .send('Fetch.failRequest', {
              requestId: event.requestId,
              errorReason: event.responseErrorReason,
            })
            .catch(() => {});
          return;
        }
        const location = event.responseHeaders?.find((h) => h.name.toLowerCase() === 'location');
        if (event.responseStatusCode >= 300 && event.responseStatusCode < 400 && location) {
          const target = new URL(location.value, event.request.url);
          if (
            target.protocol !== 'https:' ||
            target.origin !== config.origin ||
            target.username ||
            target.password ||
            target.search ||
            target.hash ||
            (event.request.method === 'POST' && [307, 308].includes(event.responseStatusCode))
          ) {
            blocked = true;
            await cdp.send('Fetch.failRequest', {
              requestId: event.requestId,
              errorReason: 'BlockedByClient',
            });
            return;
          }
        }
        await cdp.send('Fetch.continueResponse', { requestId: event.requestId });
      } catch {
        if (!closing) {
          blocked = true;
          await close();
        }
      }
    });
    transport.onPage?.(page);
    context.on('page', async (other) => {
      if (other !== page) await other.close().catch(() => {});
    });
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('download', (d) => d.cancel().catch(() => {}));
    try {
      state('checking_session');
      await page.goto(config.login_url, { waitUntil: 'domcontentloaded' });
      if (blocked) throw Error('blocked');
      if (config.locators) {
        try {
          for (const field of [
            'username',
            'password',
            'submit',
            'success',
            'identity',
            'challenge',
            'failure',
          ])
            await configLocator(page, config, field).count();
        } catch {
          throw Error('locator_invalid');
        }
      }
      while (
        !blocked &&
        !(await proof()) &&
        !(await challenge()) &&
        !(await configLocator(page, config, 'password').filter({ visible: true }).count()) &&
        performance.now() < expires
      )
        await pause(200);
      if (await proof()) {
        authenticated = true;
        state('session_reused');
      } else if (await challenge()) {
        state('waiting_manual');
      } else {
        await configLocator(page, config, 'username').waitFor({
          state: 'visible',
          timeout: Math.max(1, expires - performance.now()),
        });
        await guard();
        if (request.previous_session) state('session_expired');
        passwordPhase = true;
        const nonce = randomUUID();
        let deadlineTimer;
        let secret;
        try {
          secret = await Promise.race([
            transport.password(nonce),
            new Promise((_, reject) => {
              deadlineTimer = setTimeout(
                () => reject(Error('timeout')),
                Math.max(1, expires - performance.now()),
              );
            }),
          ]);
        } finally {
          clearTimeout(deadlineTimer);
        }
        if (!secret) {
          state('authorization_required');
        } else {
          try {
            await guard();
            await configLocator(page, config, 'username').fill(username);
            await guard();
            await configLocator(page, config, 'password').fill(secret);
            secret = '';
            await guard();
            // Install a same-document capture guard immediately before the one allowed submit.
            await configLocator(page, config, 'password').evaluate((p, c) => {
              const f = p.form;
              f.addEventListener(
                'submit',
                (e) => {
                  const b = e.submitter;
                  const action = new URL(
                    b?.getAttribute('formaction') || f.getAttribute('action') || location.href,
                    location.href,
                  );
                  if (
                    location.origin !== c.origin ||
                    action.href !== c.form_action_url ||
                    f.method !== 'post'
                  ) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    window.__startflowBlocked = true;
                  }
                },
                { capture: true },
              );
            }, config);
            submitted = true;
            state('logging_in');
            await configLocator(page, config, 'submit').click({ timeout: 3000 });
            while (!closing && !page.isClosed()) {
              if (blocked || (await page.evaluate(() => window.__startflowBlocked === true)))
                throw Error('blocked');
              if (await challenge()) {
                passwordPhase = false;
                state('waiting_manual');
                break;
              }
              if (await proof()) {
                authenticated = true;
                state('authenticated');
                break;
              }
              if (await configLocator(page, config, 'failure').filter({ visible: true }).count()) {
                state('failed');
                break;
              }
              if (performance.now() >= expires) {
                state('timeout');
                break;
              }
              await pause(200);
            }
          } finally {
            secret = '';
            try {
              const input = page ? configLocator(page, config, 'password') : null;
              if (input && (await input.count())) await input.fill('', { timeout: 500 });
            } catch {}
          }
        }
      }
      passwordPhase = false;
    } catch (e) {
      passwordPhase = false;
      if (closing) state('closed');
      else if (e?.message === 'manual') state('waiting_manual');
      else if (e?.message === 'locator_invalid')
        state(config.locators ? 'locator_invalid' : 'blocked');
      else if (e?.name === 'TimeoutError' || e?.message === 'timeout')
        state(config.locators && e?.name === 'TimeoutError' ? 'locator_invalid' : 'timeout');
      else throw e;
    }
    // Manual verification is only observed, never submitted again by StartFlow.
    // Keep the dedicated browser usable until its owner closes it (8h upper bound).
    const stopAt = performance.now() + 8 * 60 * 60 * 1000;
    const manualDeadline = performance.now() + 10 * 60 * 1000;
    while (!closing && !page.isClosed() && performance.now() < stopAt) {
      if (blocked) {
        state('blocked');
        await close();
        break;
      }
      try {
        const logged = await proof();
        if (logged && !authenticated) {
          authenticated = true;
          state('authenticated');
        } else if (
          authenticated &&
          !logged &&
          (await configLocator(page, config, 'password').filter({ visible: true }).count())
        ) {
          authenticated = false;
          state('session_expired');
        }
      } catch {
        state('blocked');
        await close();
        break;
      }
      if (!authenticated && performance.now() > manualDeadline) {
        await close();
        break;
      }
      await pause(2000);
    }
  } catch (error) {
    state(
      closing
        ? 'closed'
        : error?.message === 'locator_invalid' && config.locators
          ? 'locator_invalid'
          : error?.name === 'TimeoutError'
            ? 'timeout'
            : 'blocked',
    );
    await close();
  } finally {
    clearInterval(timer);
    await close();
    transport.emit({ type: 'closed' });
  }
}
