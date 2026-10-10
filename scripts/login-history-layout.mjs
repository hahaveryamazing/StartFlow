// Browser layout regression with synthetic IPC summaries; no native account access.
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve('.test-runtime/browsers');
const { chromium } = await import('playwright');
assert.match(
  await readFile('src/main.tsx', 'utf8'),
  /import ['"]\.\/styles\/login-history\.css['"]/,
);
const handler = (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body>
    <div id="root" style="height:auto;padding:24px"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      const { createRoot } = ReactDOM;
      const { LoginHistory } = await import('/src/features/accounts/LoginHistory.tsx');
      import '/src/styles/index.css';
      import '/src/styles/v2.css';
      import '/src/styles/login-history.css';
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command) => command === 'login_history' ? window.testRows : 1
      };
      window.renderHistory = (rows) => {
        window.testRows = rows;
        window.testRoot?.unmount();
        window.testRoot = createRoot(document.getElementById('root'));
        window.testRoot.render(React.createElement(React.Fragment, null,
          React.createElement(LoginHistory, { compact: true }),
          React.createElement('div', { className: 'quick-operations' },
            React.createElement('button', null, '配置智能规则'))));
      };
      renderHistory([]);
    </script></body></html>`);
};
const server = await createServer({
  plugins: [
    {
      name: 'layout-fixture',
      configureServer(server) {
        server.middlewares.use('/__login-history-layout', handler);
      },
    },
  ],
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
let browser;
const report = { kind: 'Chromium layout; synthetic IPC; no native login execution', checks: [] };
try {
  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  console.log('Browser ready');
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__login-history-layout`);
  await page.getByText('还没有登录记录。').waitFor({ timeout: 10000 });
  for (const theme of ['dark', 'light']) {
    for (const width of [1024, 1280, 360]) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      for (const populated of [false, true]) {
        await page.evaluate(
          (populated) =>
            window.renderHistory(
              populated
                ? [
                    {
                      id: 'synthetic',
                      name: 'VeryLongUnbrokenAccountName'.repeat(24),
                      target: 'web',
                      status: 'waiting_manual',
                      timestamp: '2026-10-10T00:00:00Z',
                      submitted: false,
                    },
                  ]
                : [],
            ),
          populated,
        );
        await page.getByText(populated ? /等待人工验证/ : '还没有登录记录。').waitFor();
        const bounds = await page.locator('.login-history').evaluate((el) => {
          const r = el.getBoundingClientRect(),
            css = getComputedStyle(el);
          return {
            padding: parseFloat(css.paddingLeft),
            overflow: el.scrollWidth > el.clientWidth,
            gap: document.querySelector('.quick-operations').getBoundingClientRect().top - r.bottom,
            childrenInside: [...el.querySelectorAll('h3,p,strong,small')].every((child) => {
              const c = child.getBoundingClientRect();
              return c.left >= r.left + 19 && c.right <= r.right - 19 && c.bottom <= r.bottom - 19;
            }),
          };
        });
        assert.equal(bounds.padding, 20);
        assert.equal(bounds.overflow, false);
        assert.equal(bounds.childrenInside, true);
        assert.ok(bounds.gap >= 24);
        report.checks.push({ theme, width, populated, status: 'passed' });
      }
    }
  }
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.evaluate(() => window.renderHistory([]));
  await page.getByText('还没有登录记录。').waitFor();
  await page.locator('#root').screenshot({ path: 'docs/login-history-layout.png' });
  report.passed = true;
  console.log(`PASS ${report.checks.length} layout checks`);
} finally {
  await browser?.close();
  await server.close();
  await writeFile('docs/login-history-layout-results.json', JSON.stringify(report, null, 2) + '\n');
}
