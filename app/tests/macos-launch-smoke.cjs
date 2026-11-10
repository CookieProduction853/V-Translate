// Native Launch Services check. This does not simulate browser capture or inference.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function launch(app, data) {
  const process = spawn('/usr/bin/open', ['-n', app, '--args', '--no-open', '--data-dir', data], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  process.stderr.on('data', chunk => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { process.kill(); reject(new Error('Launch Services command timed out')); }, 10000);
    process.once('error', error => { clearTimeout(timer); reject(error); });
    process.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Launch Services exited ${code}: ${errors}`)); });
  });
}
async function until(check, deadline, description) {
  let latest;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; }
    catch (error) { latest = error; }
    await delay(100);
  }
  throw new Error(`${description}${latest ? `: ${latest.message}` : ''}`);
}

(async () => {
  if (process.platform !== 'darwin') { console.log('SKIP native macOS Launch Services check: requires macOS'); return; }
  assert.equal(process.arch, 'arm64');
  const binary = path.resolve(process.env.LIVESUB_BINARY || 'dist/V-Translate-macOS-arm64/V-Translate.app/Contents/MacOS/V-Translate');
  const app = path.resolve(binary, '../../..');
  assert.equal(path.basename(app), 'V-Translate.app');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'vtranslate-launch-'));
  const deadline = Date.now() + 30000;
  let url; let headers;
  try {
    await launch(app, data);
    url = await until(async () => {
      const value = (await fs.readFile(path.join(data, 'player.url'), 'utf8')).trim();
      const candidate = new URL(value);
      assert.equal(candidate.protocol, 'http:'); assert.equal(candidate.hostname, '127.0.0.1');
      assert.ok(candidate.port); assert.equal(candidate.username, ''); assert.equal(candidate.password, '');
      const token = new URLSearchParams(candidate.hash.slice(1)).get('token'); assert.ok(token);
      headers = { Authorization: `Bearer ${token}` };
      return candidate;
    }, deadline, 'The app did not publish its local player after Finder-style launch');
    const request = (route, options = {}) => fetch(`${url.origin}${route}`, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(3000) });
    const platformResponse = await request('/api/platform'); assert.equal(platformResponse.status, 200);
    assert.deepEqual(await platformResponse.json(), { os: 'macos', arch: 'aarch64', backends: ['cpu', 'metal'] });
    assert.equal((await fetch(`${url.origin}/api/platform`, { signal: AbortSignal.timeout(3000) })).status, 401);
    const versionResponse = await request('/api/version'); assert.equal(versionResponse.status, 200);
    const expectedVersion = (await fs.readFile(path.resolve(__dirname, '../Cargo.toml'), 'utf8')).match(/^version\s*=\s*"([^"]+)"/m)[1];
    assert.equal((await versionResponse.json()).version, expectedVersion);
    const page = await request('/'); assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes(`id="app-version" class="version-badge">v${expectedVersion}</span>`), 'The launched app must serve its matching player version');
    assert.match(html, /<dialog id="settings-dialog"/);
    assert.match(html, /id="transcript-view"[^>]*role="tabpanel"/);
    const quit = await request('/api/quit', { method: 'POST' }); assert.equal(quit.status, 200);
    await until(async () => {
      try { await request('/api/version'); return false; }
      catch (error) { if (error.name === 'TimeoutError') return false; return true; }
    }, deadline, 'The background app did not stop after Quit');
    console.log('PASS native macOS Launch Services: open .app, authenticated Apple Silicon platform API, player HTML and clean background quit');
  } finally {
    if (url && headers) {
      try { await fetch(`${url.origin}/api/quit`, { method: 'POST', headers, signal: AbortSignal.timeout(2000) }); } catch { /* already stopped */ }
    }
    await fs.rm(data, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
