import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { detectBrowser, prepareBrowser, probeBrowser } from './browser-runtime.mjs';

async function fixture(fn) {
  const cache = await mkdtemp(join(tmpdir(), 'StartFlow-browser-test-'));
  try {
    await fn(cache);
  } finally {
    const inside = relative(resolve(tmpdir()), resolve(cache));
    if (
      !inside.startsWith('..') &&
      !isAbsolute(inside) &&
      inside.startsWith('StartFlow-browser-test-')
    )
      await rm(cache, { recursive: true, force: true });
  }
}
test('no browser is not reported ready; invalid arbitrary candidate is rejected', () =>
  fixture(async (cache) => {
    assert.equal(await detectBrowser({ cache, candidates: [] }), null);
    await assert.rejects(
      detectBrowser({
        cache,
        candidates: [{ source: 'edge', executable: join(cache, 'script.cmd') }],
      }),
    );
  }));
test('installed browser must pass a real probe; a failed Edge falls back to Chrome', () =>
  fixture(async (cache) => {
    const candidates = [
      { source: 'edge', executable: join(cache, 'msedge.exe') },
      { source: 'chrome', executable: join(cache, 'chrome.exe') },
    ];
    for (const c of candidates) await writeFile(c.executable, 'fixture');
    const called = [];
    const result = await detectBrowser({ cache, candidates }, async (exe) => {
      called.push(exe);
      if (exe.endsWith('msedge.exe')) throw Error('policy');
      return 'Chrome/156';
    });
    assert.equal(result.source, 'chrome');
    assert.equal(called.length, 2);
  }));
test('available browser skips download entirely, and failed download never returns ready', async () => {
  let downloads = 0;
  const browser = { source: 'edge', executable: 'fixed', version: '156' };
  assert.equal(
    await prepareBrowser(
      { operation: 'install' },
      {
        detect: async () => browser,
        download: async () => {
          downloads++;
        },
      },
    ),
    browser,
  );
  assert.equal(downloads, 0);
  await assert.rejects(
    prepareBrowser(
      { operation: 'install' },
      {
        detect: async () => null,
        download: async () => {
          throw Error('offline');
        },
      },
    ),
  );
});
test('missing browser downloads once and is re-probed; detect mode never downloads', async () => {
  let downloads = 0,
    detections = 0;
  const request = { operation: 'install' };
  const deps = {
    detect: async () => (++detections === 1 ? null : { source: 'managed' }),
    download: async () => {
      downloads++;
    },
  };
  assert.equal((await prepareBrowser(request, deps)).source, 'managed');
  assert.equal(downloads, 1);
  assert.equal(detections, 2);
  assert.equal(
    await prepareBrowser(
      { operation: 'detect' },
      {
        detect: async () => null,
        download: async () => {
          throw Error('must not download');
        },
      },
    ),
    null,
  );
});
test('installed Windows Edge passes actual CDP / response interception probe in an isolated temporary profile', (t) =>
  fixture(async (cache) => {
    const edge = join(
      process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)',
      'Microsoft/Edge/Application/msedge.exe',
    );
    const { existsSync } = await import('node:fs');
    if (!existsSync(edge)) {
      t.skip('No installed Edge in this test environment');
      return;
    }
    assert.match(await probeBrowser(edge, cache), /(?:Edg|Chrome)\//);
  }));
