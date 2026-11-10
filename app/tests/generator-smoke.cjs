const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { build, target } = require('../scripts/build-ad-feed.cjs');

const destination = 'https://example.com/sponsor?campaign=one';
const png = Buffer.alloc(24);
Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
png.writeUInt32BE(1, 16);
png.writeUInt32BE(1, 20);

function directory(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vtranslate-ad-generator-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}
function pair(folder, image, shortcut = image.replace(/\.[^.]+$/, '.url'), link = destination, bytes = png) {
  fs.writeFileSync(path.join(folder, image), bytes);
  fs.writeFileSync(path.join(folder, shortcut), link);
}
function generate(folder) {
  const previous = console.error;
  const warnings = [];
  console.error = warning => warnings.push(warning);
  try { return { feed: build(folder), warnings }; }
  finally { console.error = previous; }
}

test('existing spaced image and unspaced InternetShortcut match uniquely', t => {
  const folder = directory(t);
  pair(folder, 'AD 1.png', 'AD1.url', `[InternetShortcut]\r\nURL=${destination}\r\n`);
  const { feed, warnings } = generate(folder);
  assert.equal(warnings.length, 0);
  assert.equal(feed.ads.length, 1);
  assert.equal(feed.ads[0].image, 'AD 1.png');
  assert.equal(feed.ads[0].link_url, destination);
  assert.equal(feed.ads[0].size_bytes, png.length);
  assert.equal(feed.ads[0].sha256, crypto.createHash('sha256').update(png).digest('hex'));
});

test('an exact stem takes precedence over whitespace-normalized alternatives', t => {
  const folder = directory(t);
  pair(folder, 'AD1.png', 'AD1.url', 'https://example.com/exact');
  fs.writeFileSync(path.join(folder, 'AD 1.url'), 'https://example.com/normalized');
  const { feed, warnings } = generate(folder);
  assert.equal(warnings.length, 0);
  assert.equal(feed.ads[0].link_url, 'https://example.com/exact');
});

test('ambiguous normalized shortcuts or image siblings are skipped', t => {
  const ambiguousShortcuts = directory(t);
  pair(ambiguousShortcuts, 'AD 1.png', 'AD1.url');
  fs.writeFileSync(path.join(ambiguousShortcuts, 'AD  1.url'), destination);
  assert.equal(generate(ambiguousShortcuts).feed.ads.length, 0);

  const ambiguousImages = directory(t);
  pair(ambiguousImages, 'AD 1.png', 'AD1.url');
  fs.writeFileSync(path.join(ambiguousImages, 'AD  1.PNG'), png);
  assert.equal(generate(ambiguousImages).feed.ads.length, 0);
});

test('backend-incompatible filenames cannot poison otherwise valid feeds', t => {
  const folder = directory(t);
  pair(folder, 'valid.png');
  for (const image of ['percent%.png', 'fragment#.png', ' leading.png', 'control\x7f.png', 'control\x85.png', `${'界'.repeat(80)}.png`]) {
    pair(folder, image);
  }
  const { feed, warnings } = generate(folder);
  assert.deepEqual(feed.ads.map(ad => ad.image), ['valid.png']);
  assert.equal(warnings.length, 6);
});

test('shortcut parsing accepts only unambiguous UTF-8 HTTPS destinations', t => {
  assert.equal(target(Buffer.from(`\uFEFF[InternetShortcut]\r\nIconFile=ignored.ico\r\nURL=${destination}\r\n`)), destination);
  assert.equal(target(destination), destination);
  for (const invalid of [
    '[Other]\nURL=https://example.com/wrong-section',
    '[InternetShortcut]\nURL=https://example.com/one\nURL=https://example.com/two',
    '[InternetShortcut]\nURL=https://example.com/one\n[Other]\nURL=https://example.com/two',
    'http://example.com', 'javascript:alert(1)', 'file:///C:/Windows',
    'https://user:secret@example.com', 'https://example.com/\tmodified',
  ]) assert.throws(() => target(invalid), invalid);
  assert.throws(() => target(Buffer.from([0xff, 0xfe])));
  assert.throws(() => target(Buffer.alloc(8193, 65)));

  const folder = directory(t);
  pair(folder, 'valid.png');
  pair(folder, 'wrong-section.png', undefined, '[Other]\nURL=https://example.com');
  pair(folder, 'invalid-encoding.png', undefined, Buffer.from([0xff, 0xfe]));
  assert.deepEqual(generate(folder).feed.ads.map(ad => ad.image), ['valid.png']);
});

test('inconsistent WebP lengths are skipped before publication', t => {
  const folder = directory(t);
  pair(folder, 'valid.png');
  pair(folder, 'broken.webp', undefined, destination, Buffer.from('RIFF\x05\0\0\0WEBP', 'binary'));
  assert.deepEqual(generate(folder).feed.ads.map(ad => ad.image), ['valid.png']);
});

test('current bundled manifest and Rust image data remain byte-identical', t => {
  const folder = directory(t);
  const source = path.join(__dirname, '../assets/ad');
  fs.cpSync(source, folder, { recursive: true });
  const before = ['manifest.json', 'bundle-data.rs'].map(name => fs.readFileSync(path.join(folder, name)));
  const script = path.join(__dirname, '../scripts/build-ad-feed.cjs');
  const cliModule = { exports: {} };
  const cliRequire = name => require(name);
  cliRequire.main = cliModule;
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), {
    require: cliRequire, module: cliModule, __dirname: path.dirname(script),
    process: { argv: [process.execPath, script, folder] },
    Buffer, URL, TextDecoder, console: { log() {}, error: console.error },
  }, { filename: script });
  for (const [index, name] of ['manifest.json', 'bundle-data.rs'].entries()) {
    assert.deepEqual(fs.readFileSync(path.join(folder, name)), before[index], name);
  }
});
