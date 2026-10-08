import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Run only on a clean installation. Uses production storage without creating test entities.
const root = resolve(import.meta.dirname, '..');
const installer = join(root, 'src-tauri/target/release/bundle/nsis/StartFlow_1.0.0_x64-setup.exe');
const installed = join(process.env.LOCALAPPDATA, 'StartFlow', 'StartFlow.exe');
const report = { startedAt: new Date().toISOString(), checks: [] };
const results = join(root, 'test-results');
await mkdir(results, { recursive: true });
const exists = async (p) =>
  access(p).then(
    () => true,
    () => false,
  );
assert.equal(await exists(installed), false, 'Existing installation: refuse to overwrite');
function installerProcess(file) {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$p=Start-Process -WindowStyle Hidden -Wait -PassThru -FilePath $env:STARTFLOW_INSTALL_TEST_EXE -ArgumentList "/S"; exit $p.ExitCode',
    ],
    { windowsHide: true, env: { ...process.env, STARTFLOW_INSTALL_TEST_EXE: file } },
  );
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, description) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await pause(200);
  }
  throw new Error(description);
}
function pass(name, details) {
  report.checks.push({ name, details, status: 'passed' });
  console.log('PASS', name);
}
let app;
let browser;
async function inspect() {
  app = spawn(installed, [], {
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9224',
    },
  });
  app.stderr.on('data', (s) => console.error(String(s).trim()));
  await until(async () => {
    try {
      return (await fetch('http://127.0.0.1:9224/json/version')).ok;
    } catch {
      return false;
    }
  }, 'Installed WebView2 unavailable');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
  let page;
  await until(async () => {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('tauri.localhost'));
    return !!page;
  }, 'Installed page unavailable');
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  await page.getByText('欢迎使用 StartFlow', { exact: true }).waitFor();
  const snapshot = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('snapshot'));
  assert.equal(snapshot.autostart_enabled, false);
  assert.equal(snapshot.config.scenes.length, 0);
  assert.equal(snapshot.config.tasks.length, 0);
  assert.equal(snapshot.config.settings.onboarding_done, false);
  assert.equal(snapshot.config.settings.theme, 'dark');
  await page.screenshot({ path: join(results, 'installed-welcome.png') });
  const stopped = new Promise((r) => app.once('exit', r));
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('quit')).catch(() => {});
  await Promise.race([stopped, pause(5000)]);
  assert.notEqual(app.exitCode, null, 'Installed process did not exit');
  await browser.close().catch(() => {});
  browser = undefined;
  return snapshot;
}
try {
  installerProcess(installer);
  assert.equal(await exists(installed), true);
  pass('NSIS 当前用户安装', installed);
  const first = await inspect();
  pass('安装后发行程序运行', '真实本地 IPC、首次引导、空配置、登录自启默认关闭');
  const db = join(first.data_directory, 'startflow.sqlite3');
  const digest = createHash('sha256')
    .update(await readFile(db))
    .digest('hex');
  installerProcess(join(process.env.LOCALAPPDATA, 'StartFlow', 'uninstall.exe'));
  await until(
    async () => !(await exists(installed)),
    'Uninstaller did not remove installed executable',
  );
  assert.equal(await exists(db), true);
  assert.equal(
    createHash('sha256')
      .update(await readFile(db))
      .digest('hex'),
    digest,
  );
  pass('静默卸载默认保留数据库', '已移除程序；SQLite 文件保留且 SHA256 完全一致');
  installerProcess(installer);
  const second = await inspect();
  assert.equal(second.data_directory, first.data_directory);
  assert.deepEqual(second.config, first.config);
  pass('重新安装读取原数据', '生产数据库位置和配置一致；登录自启保持关闭');
  report.status = 'passed';
  report.installedExecutable = installed;
  report.dataDirectory = second.data_directory;
} catch (e) {
  report.status = 'failed';
  report.error = String(e);
  throw e;
} finally {
  if (app?.exitCode === null) app.kill();
  await browser?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await writeFile(join(results, 'installer-smoke.json'), JSON.stringify(report, null, 2));
}
