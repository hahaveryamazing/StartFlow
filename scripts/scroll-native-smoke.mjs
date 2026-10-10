// Real WebView2 wheel regression; isolated synthetic database, no task execution.
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
  'Close existing StartFlow before isolated tests',
);
const dir = await mkdtemp(join(tmpdir(), 'StartFlow-scroll-'));
const db = new DatabaseSync(join(dir, 'startflow.sqlite3'));
db.exec(await readFile(join(root, 'src-tauri/tests/fixtures/v3-populated.sql'), 'utf8'));
db.exec(
  "UPDATE settings SET value_json=json_set(value_json,'$.paused',json('true'),'$.onboarding_done',json('true')) WHERE key='general';UPDATE settings SET value_json=json_set(value_json,'$.enabled',json('false')) WHERE key='automation'",
);
db.close();
let app, browser, page;
const report = {
  startedAt: new Date().toISOString(),
  kind: 'Actual Tauri WebView2; CDP wheel/keyboard input; synthetic isolated database',
  revision: 'transient-scrollbars',
  limitations: [
    'Physical mouse-wheel input is not verified by CDP',
    'Small viewport uses browser emulation, not native window resizing',
  ],
  checks: [],
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 120; i++) {
    if (await fn()) return;
    await delay(150);
  }
  throw Error('Timeout: ' + label);
}
async function call(command, args = {}) {
  return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
}
async function metrics() {
  return page.evaluate(() => ({
    viewport: {
      width: innerWidth,
      height: innerHeight,
      outerWidth,
      outerHeight,
      dpr: devicePixelRatio,
      screenHeight: screen.height,
      screenWidth: screen.width,
      availHeight: screen.availHeight,
      availWidth: screen.availWidth,
      screenX,
      screenY,
    },
    locked: document.body.getAttribute('data-scroll-locked'),
    modalCount: document.querySelectorAll('.modal-overlay').length,
    elements: ['.app-shell', '.sidebar', '.sidebar nav', '.workspace', '.main-content'].map(
      (selector) => {
        const el = document.querySelector(selector),
          style = getComputedStyle(el),
          r = el.getBoundingClientRect();
        return {
          selector,
          client: el.clientHeight,
          content: el.scrollHeight,
          top: r.top,
          bottom: r.bottom,
          scrollTop: el.scrollTop,
          overflow: style.overflowY,
          rows: style.gridTemplateRows,
        };
      },
    ),
  }));
}
function pass(name, details) {
  report.checks.push({ name, details, status: 'passed' });
  console.log('PASS', name);
}
async function checkTransientScrollbars(theme) {
  await page.mouse.move(350, 30);
  for (const selector of ['.main-content', '.sidebar nav']) {
    const element = page.locator(selector);
    await element.evaluate((el) => {
      el.scrollTop = 0;
    });
    await until(
      async () => (await element.getAttribute('data-scrolling')) === null,
      'idle scrollbar',
    );
    const read = () =>
      element.evaluate((el) => ({
        color: getComputedStyle(el).scrollbarColor,
        thumb: getComputedStyle(el).getPropertyValue('--scrollbar-thumb').trim(),
        width: el.clientWidth,
        height: el.clientHeight,
        top: el.scrollTop,
      }));
    const hidden = await read();
    assert.equal(hidden.thumb, 'transparent');
    await wheel(selector, 40);
    await until(
      async () => (await element.evaluate((el) => el.scrollTop)) > 0,
      'scroll with hidden scrollbar',
    );
    assert.equal(await element.getAttribute('data-scrolling'), 'true');
    const active = await read();
    assert.notEqual(active.color, hidden.color, 'Actual scrollbar paint must change');
    assert.ok(active.thumb.includes('40%'), 'Thumb uses translucent theme color');
    // Keep the pointer over the scroll container; inactivity must still hide its bar.
    await until(
      async () => (await element.getAttribute('data-scrolling')) === null,
      'scrollbar hides with pointer stationary',
    );
    const idle = await read();
    assert.equal(idle.thumb, 'transparent');
    assert.equal(idle.width, hidden.width, 'Showing/hiding must not shift the content');
    assert.equal(idle.height, hidden.height);
    assert.equal(idle.top, active.top, 'Hiding must not alter scroll position');
    await wheel(selector, 40);
    await until(
      async () => (await element.evaluate((el) => el.scrollTop)) > idle.top,
      'subsequent wheel',
    );
    pass('Transient scrollbar stays scrollable and hides while idle', {
      theme,
      selector,
      hidden: hidden.color,
      active: active.color,
    });
  }
}
async function wheel(selector, delta) {
  const bounds = await page.locator(selector).boundingBox();
  assert.ok(bounds, selector + ' must be visible');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + Math.min(150, bounds.height / 2));
  await page.mouse.wheel(0, delta);
}
async function checkPage(name) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.locator('.main-content h1').first().waitFor();
  await delay(250);
  const main = page.locator('.main-content');
  // Short/empty pages get an explicit layout fixture, never fake application records.
  const addedFixture = await main.evaluate((el) => {
    el.querySelector('[data-scroll-fixture]')?.remove();
    if (el.scrollHeight <= el.clientHeight + 200) {
      const fixture = document.createElement('div');
      fixture.dataset.scrollFixture = 'true';
      fixture.style.height = '1800px';
      el.firstElementChild.append(fixture);
    }
    el.scrollTop = 0;
    return !!el.querySelector('[data-scroll-fixture]');
  });
  const before = await metrics();
  const container = before.elements.find((e) => e.selector === '.main-content');
  assert.ok(
    container.bottom <= before.viewport.height + 1,
    name + ': content viewport must fit the window',
  );
  assert.ok(container.content > container.client, name + ': expected overflow');
  await wheel('.main-content', 600);
  await until(async () => (await main.evaluate((el) => el.scrollTop)) > 0, name + ': wheel down');
  await wheel('.main-content', 50000);
  await until(
    async () => main.evaluate((el) => el.scrollTop >= el.scrollHeight - el.clientHeight - 2),
    name + ': bottom reachable',
  );
  await wheel('.main-content', -50000);
  await until(async () => (await main.evaluate((el) => el.scrollTop)) <= 1, name + ': wheel up');
  await main.evaluate((el) => el.querySelector('[data-scroll-fixture]')?.remove());
  pass(name + ': bounded layout, wheel down/up and bottom reachable', { addedFixture });
}
try {
  app = spawn(join(root, 'src-tauri/target/debug/startflow.exe'), [], {
    windowsHide: true,
    env: {
      ...process.env,
      STARTFLOW_TEST_DATA_DIR: dir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9241',
    },
  });
  await until(async () => {
    try {
      return (await fetch('http://127.0.0.1:9241/json/version')).ok;
    } catch {
      return false;
    }
  }, 'WebView2');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9241');
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
  report.initial = await metrics();
  const initialTop = await page.locator('.main-content').evaluate((el) => el.scrollTop);
  await wheel('.main-content', 600);
  await until(
    async () => (await page.locator('.main-content').evaluate((el) => el.scrollTop)) > initialTop,
    'fresh dashboard wheel',
  );
  pass('Freshly opened dashboard accepts wheel before navigation');
  const names = await page
    .locator('nav[aria-label="主导航"] button')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  for (const name of [...names, 'AI 配置助手']) await checkPage(name);
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page.getByText('常规设置', { exact: true }).waitFor();
  const settings = (await call('snapshot')).config.settings;
  for (const theme of ['dark', 'light']) {
    await call('save_settings', { settings: { ...settings, theme } });
    await until(
      async () => (await page.locator('html').getAttribute('data-theme')) === theme,
      'theme persisted',
    );
    await checkTransientScrollbars(theme);
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 1024, height: 700 },
    ]) {
      await page.setViewportSize(viewport);
      await checkPage('系统设置');
      pass('Theme and viewport combination', { theme, viewport });
    }
  }
  const main = page.locator('.main-content');
  await main.evaluate((el) => {
    el.scrollTop = 0;
  });
  await main.focus();
  await page.keyboard.press('PageDown');
  await until(async () => (await main.evaluate((el) => el.scrollTop)) > 0, 'keyboard PageDown');
  pass('Main content is keyboard scrollable');
  await page.locator('.sidebar nav').evaluate((el) => {
    el.scrollTop = 0;
  });
  await wheel('.sidebar nav', 500);
  await until(
    async () => (await page.locator('.sidebar nav').evaluate((el) => el.scrollTop)) > 0,
    'sidebar wheel',
  );
  pass('Sidebar scrolls independently');
  // Simulate an older engine ignoring dynamic viewport units. The shell must stay bounded.
  await page.evaluate(() => {
    function strip(rules) {
      for (const rule of rules) {
        if (rule.style) {
          for (const property of [...rule.style]) {
            if (rule.style.getPropertyValue(property).includes('dvh'))
              rule.style.removeProperty(property);
          }
        }
        if (rule.cssRules) strip(rule.cssRules);
      }
    }
    for (const sheet of document.styleSheets) strip(sheet.cssRules);
  });
  await checkPage('系统设置');
  pass('Viewport remains scrollable without dynamic viewport unit support');
  await page.getByRole('button', { name: '账号与凭据', exact: true }).click();
  await page.getByRole('button', { name: '新增账号', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await until(
    async () => (await page.locator('body').getAttribute('data-scroll-locked')) === null,
    'dialog scroll lock released',
  );
  await checkPage('系统设置');
  pass('Scrolling after opening and closing an account dialog');
  report.final = await metrics();
  await page.mouse.move(350, 30);
  await until(
    async () => (await page.locator('.main-content').getAttribute('data-scrolling')) === null,
    'idle screenshot',
  );
  await until(
    async () => (await page.locator('.sidebar nav').getAttribute('data-scrolling')) === null,
    'sidebar idle screenshot',
  );
  await page.screenshot({ path: join(root, 'docs/scroll-idle-light.png') });
  report.finishedAt = new Date().toISOString();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  throw error;
} finally {
  if (page) await call('quit').catch(() => {});
  await browser?.close().catch(() => {});
  if (app && app.exitCode === null) app.kill();
  await writeFile(
    join(root, 'docs/scroll-transient-native-results.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
