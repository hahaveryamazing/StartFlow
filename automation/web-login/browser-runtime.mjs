import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Backend-controlled candidates only. This module never receives login data or credentials.
export async function probeBrowser(executable, cache) {
  await mkdir(join(cache, 'probes'), { recursive: true });
  const profile = await mkdtemp(join(cache, 'probes', 'probe-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: executable,
      headless: true,
      timeout: 10000,
      chromiumSandbox: true,
      acceptDownloads: false,
      serviceWorkers: 'block',
      ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'],
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const version = (await cdp.send('Browser.getVersion')).product;
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
    await cdp.send('Fetch.disable');
    return version.slice(0, 80);
  } finally {
    await context?.close().catch(() => {});
    const inside = relative(resolve(cache, 'probes'), resolve(profile));
    if (!inside.startsWith('..') && !isAbsolute(inside))
      await rm(profile, { recursive: true, force: true });
  }
}
export async function detectBrowser(request, probe = probeBrowser) {
  if (
    !isAbsolute(request.cache) ||
    !Array.isArray(request.candidates) ||
    request.candidates.length > 2
  )
    throw Error('invalid');
  for (const candidate of request.candidates) {
    if (
      !['edge', 'chrome'].includes(candidate.source) ||
      !isAbsolute(candidate.executable) ||
      !['msedge.exe', 'chrome.exe'].includes(basename(candidate.executable).toLowerCase())
    )
      throw Error('invalid');
  }
  const managed = {
    source: 'managed',
    executable: join(request.cache, 'browsers', 'chromium-1248', 'chrome-win64', 'chrome.exe'),
  };
  for (const candidate of [...request.candidates, managed]) {
    if (!existsSync(candidate.executable)) continue;
    try {
      const version = await probe(candidate.executable, request.cache);
      return { source: candidate.source, executable: candidate.executable, version };
    } catch {
      // Installed but blocked/incompatible is not ready. Try the next known browser.
    }
  }
  return null;
}
async function downloadBrowser() {
  // Fixed official Playwright package/revision and HTTPS CDN defaults. No custom URL or shell.
  await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dirname, 'node_modules/playwright/cli.js'),
        'install',
        'chromium',
        '--no-shell',
      ],
      {
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: '30000',
          PLAYWRIGHT_SKIP_BROWSER_GC: '1',
        },
      },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(Error('timeout'));
    }, 420000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(Error('download'));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? accept() : reject(Error('download'));
    });
  });
}
export async function prepareBrowser(request, dependencies = {}) {
  if (!['detect', 'install'].includes(request.operation)) throw Error('invalid');
  const detect = dependencies.detect ?? detectBrowser;
  let browser = await detect(request);
  if (browser || request.operation === 'detect') return browser;
  await (dependencies.download ?? downloadBrowser)();
  browser = await detect(request);
  if (!browser) throw Error('unavailable');
  return browser;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (part) => {
    input += part;
    if (Buffer.byteLength(input) > 16384) process.exit(2);
  });
  process.stdin.on('end', async () => {
    try {
      const result = await prepareBrowser(JSON.parse(input));
      process.stdout.write(JSON.stringify({ browser: result }) + '\n');
    } catch {
      process.exitCode = 2; // Never forward raw browser errors, paths or installer logs to the UI.
    }
  });
}
