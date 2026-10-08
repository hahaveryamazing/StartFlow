import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..'),
  results = join(root, 'test-results');
await mkdir(results, { recursive: true });
const installed = join(process.env.LOCALAPPDATA, 'StartFlow/StartFlow.exe'),
  installer = join(root, 'src-tauri/target/release/bundle/nsis/StartFlow_2.0.0_x64-setup.exe');
const report = { startedAt: new Date().toISOString(), checks: [] };
let app, browser, page;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await pause(200);
  }
  throw new Error(label);
}
async function inspect() {
  app = spawn(installed, [], {
    windowsHide: true,
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9224' },
  });
  await until(async () => {
    try {
      return (await fetch('http://127.0.0.1:9224/json/version')).ok;
    } catch {
      return false;
    }
  }, 'Installed WebView2');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
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
  }, 'Installed main');
  return page.evaluate(() => window.__TAURI_INTERNALS__.invoke('snapshot'));
}
async function close() {
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('quit')).catch(() => {});
  await until(() => app.exitCode !== null || app.signalCode !== null, 'Installed exit');
  await browser.close();
  page = undefined;
  browser = undefined;
}
function pass(name, details) {
  report.checks.push({ name, details, status: 'passed' });
  console.log('PASS', name);
}
try {
  await access(installed);
  await access(installer);
  assert.equal(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        '@(Get-Process startflow -ErrorAction SilentlyContinue).Count;exit 0',
      ],
      { windowsHide: true, encoding: 'utf8' },
    ).trim(),
    '0',
    'Close other instances before upgrade test',
  );
  const before = await inspect();
  assert.ok(
    !before.runs.some((r) => r.status === 'running'),
    'Production tasks are active; wait before installer',
  );
  await close();
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$p=Start-Process -WindowStyle Hidden -Wait -PassThru -FilePath $env:STARTFLOW_INSTALL_TEST_EXE -ArgumentList "/S";exit $p.ExitCode',
    ],
    { windowsHide: true, env: { ...process.env, STARTFLOW_INSTALL_TEST_EXE: installer } },
  );
  assert.equal(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        '(Get-Item -LiteralPath $env:STARTFLOW_INSTALLED_TEST_EXE).VersionInfo.ProductVersion',
      ],
      {
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, STARTFLOW_INSTALLED_TEST_EXE: installed },
      },
    ).trim(),
    '2.0.0',
  );
  pass('NSIS V1 → V2 原位升级', '当前用户安装目录的真实文件版本为 2.0.0');
  const after = await inspect();
  assert.deepEqual(after.config, before.config);
  assert.deepEqual(after.logs, before.logs);
  assert.deepEqual(after.runs, before.runs);
  assert.equal(after.autostart_enabled, before.autostart_enabled);
  assert.equal(after.data_directory, before.data_directory);
  assert.ok(after.v2.backups.some((b) => b.backup_type === 'upgrade'));
  pass(
    '生产配置保留与升级备份',
    '真实安装后读取同一目录，场景、任务、顺序、计划、主题、执行历史和 Windows 自启状态逐字段一致',
  );
  await page.screenshot({ path: join(results, 'v2-installed.png') });
  await close();
  const again = await inspect();
  assert.deepEqual(again.config, after.config);
  assert.deepEqual(again.v2.extension, after.v2.extension);
  await close();
  pass('安装发行版重启', '再次启动保持配置和 V2 扩展；发行版未使用隔离测试数据');
  report.status = 'passed';
  report.installedExecutable = installed;
} catch (e) {
  report.status = 'failed';
  report.error = String(e);
  process.exitCode = 1;
  console.error(e);
} finally {
  if (page) await close().catch(() => {});
  await browser?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await writeFile(join(results, 'v2-installer-upgrade.json'), JSON.stringify(report, null, 2));
}
