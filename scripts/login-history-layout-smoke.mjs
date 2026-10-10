// Layout-only regression with synthetic text and the actual built application CSS.
// No Tauri, credentials, user profiles or application login are involved.
import { chromium } from 'playwright';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const assets = join(root, 'dist/assets');
const css = (
  await Promise.all(
    (await readdir(assets))
      .filter((name) => name.endsWith('.css'))
      .map((name) => readFile(join(assets, name), 'utf8')),
  )
).join('\n');
assert.ok(
  css.includes('.desktop-run') && css.includes('.login-history'),
  'Build the frontend first',
);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = { kind: 'CSS layout only, synthetic text, installed Edge', checks: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const name = '工作网页登录配置' + 'VeryLongUnbrokenAccountDisplayName'.repeat(6);
  const message = '控件已经失效，请重新配置登录规则。' + 'LongUnbrokenDiagnosticSummary'.repeat(6);
  for (const theme of ['dark', 'light']) {
    for (const width of [300, 420, 650, 950]) {
      await page.setContent(`<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head>
        <body><main style="width:${width}px;margin:24px;display:grid;gap:24px">
          <section class="panel login-history"><h3>最近登录记录</h3><p class="muted">账号中心、工作台和运行日志 · 合成长文本</p>
            <div class="log-detail"><div class="grow"><strong>${name}</strong><p>等待人工验证 · 网页</p><small>2026年10月9日 18:08:40 · 已提交一次登录请求</small></div></div>
          </section>
          <section class="account-card desktop-login-history"><h3>最近登录记录</h3><p class="muted">桌面应用登录 · 合成长文本</p>
            <div class="desktop-run"><time>2026/10/9 18:08:40</time><span>${message}</span><span>等待人工验证</span></div>
          </section>
        </main></body></html>`);
      const measurements = await page.locator('main').evaluate((main) =>
        [
          main,
          ...main.querySelectorAll(
            'section,.log-detail,.grow,strong,p,small,.desktop-run,time,span',
          ),
        ].map((el) => ({
          element: el.className || el.tagName,
          width: el.clientWidth,
          content: el.scrollWidth,
        })),
      );
      assert.ok(
        measurements.every((m) => m.content <= m.width + 1),
        JSON.stringify({ theme, width, measurements }),
      );
      report.checks.push({ theme, width, status: 'passed' });
      if (width === 650)
        await page.screenshot({
          path: join(root, `docs/phase5-login-history-layout-${theme}.png`),
        });
      console.log(`PASS ${theme} ${width}px, both login history layouts`);
    }
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  throw error;
} finally {
  await browser.close();
  await writeFile(
    join(root, 'docs/phase5-login-history-layout-results.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
