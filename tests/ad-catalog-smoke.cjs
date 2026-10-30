const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { buildCatalog } = require('../scripts/build-ad-catalog.cjs');

const repository = path.resolve(__dirname, '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vtranslate-ad-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'assets', 'ad'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ads'));
  return root;
}

function imageBytes(filename, marker = 1, size) {
  if (path.extname(filename).toLowerCase() === '.png') {
    const bytes = Buffer.alloc(size || 28, marker);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(1, 16);
    bytes.writeUInt32BE(1, 20);
    return bytes;
  }
  const bytes = Buffer.alloc(size || 8, marker);
  bytes[0] = 255;
  bytes[1] = 216;
  bytes[2] = 255;
  return bytes;
}

function writeImage(root, folder, filename, marker = 1, size) {
  const location = path.join(root, folder, filename);
  const bytes = imageBytes(filename, marker, size);
  fs.writeFileSync(location, bytes);
  return { location, bytes };
}

function writeLink(root, folder, filename, destination) {
  fs.writeFileSync(path.join(root, folder, filename), `[InternetShortcut]\r\nURL=${destination}\r\n`);
}

function pair(root, folder, filename, destination, marker = 1, size) {
  const image = writeImage(root, folder, filename, marker, size);
  writeLink(root, folder, `${path.parse(filename).name}.url`, destination);
  return image;
}

function snapshot(directory) {
  const entries = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) entries.push(...snapshot(location).map(([name, checksum]) => [path.join(entry.name, name), checksum]));
    else entries.push([entry.name, digest(fs.readFileSync(location))]);
  }
  return entries;
}

function assertCatalogIntegrity(catalog) {
  assert.equal(catalog.manifest.format_version, 1);
  assert.ok(catalog.sources instanceof Map);
  assert.equal(new Set(catalog.manifest.ads.map(ad => ad.id)).size, catalog.manifest.ads.length);
  for (const ad of catalog.manifest.ads) {
    assert.match(ad.id, /^[A-Za-z0-9_-]{1,80}$/);
    const source = catalog.sources.get(ad.image);
    assert.ok(path.isAbsolute(source), `${ad.image} must have an absolute source`);
    const bytes = fs.readFileSync(source);
    assert.equal(ad.size_bytes, bytes.length);
    assert.equal(ad.sha256, digest(bytes));
    assert.equal(new URL(ad.link_url).protocol, 'https:');
  }
}

test('ten root image and shortcut pairs are discovered without a hard-coded ad list', t => {
  const root = fixture(t);
  for (let index = 1; index <= 10; index++) pair(root, 'ads', `AD${index}.jpg`, `https://example.com/ad-${index}`, index);
  fs.writeFileSync(path.join(root, 'ads', 'manifest.json'), '{"user_note":"do not overwrite"}\n');
  const before = snapshot(root);
  const catalog = buildCatalog(root);
  assert.equal(catalog.manifest.ads.length, 10);
  assertCatalogIntegrity(catalog);
  assert.deepEqual(new Set(catalog.manifest.ads.map(ad => ad.link_url)), new Set(Array.from({ length: 10 }, (_, index) => `https://example.com/ad-${index + 1}`)));
  assert.deepEqual(snapshot(root), before, 'catalog discovery must not rewrite user files');
});

test('root canonical aliases replace a legacy spaced image once, including its destination', t => {
  const root = fixture(t);
  const legacy = writeImage(root, 'assets/ad', 'AD 1.png', 1);
  writeLink(root, 'assets/ad', 'AD1.url', 'https://example.com/legacy');
  writeImage(root, 'ads', 'AD 1.png', 2);
  const canonical = writeImage(root, 'ads', 'AD1.png', 3);
  writeLink(root, 'ads', 'AD1.url', 'https://example.com/current');
  const before = snapshot(root);
  const catalog = buildCatalog(root);
  assert.equal(catalog.manifest.ads.length, 1);
  assert.equal(catalog.manifest.ads[0].image, 'AD1.png');
  assert.equal(catalog.manifest.ads[0].link_url, 'https://example.com/current');
  assert.equal(catalog.manifest.ads[0].sha256, digest(canonical.bytes));
  assert.notEqual(catalog.manifest.ads[0].sha256, digest(legacy.bytes));
  assert.equal(catalog.sources.get('AD1.png'), canonical.location);
  assertCatalogIntegrity(catalog);
  assert.deepEqual(snapshot(root), before);
});

test('a root shortcut alone overrides a legacy image link without replacing its bytes', t => {
  const root = fixture(t);
  const image = pair(root, 'assets/ad', 'AD2.jpg', 'https://example.com/old', 7);
  writeLink(root, 'ads', 'AD2.url', 'https://example.com/new');
  const before = snapshot(root);
  const catalog = buildCatalog(root);
  assert.equal(catalog.manifest.ads.length, 1);
  const ad = catalog.manifest.ads[0];
  assert.equal(ad.image, 'AD2.jpg');
  assert.equal(ad.link_url, 'https://example.com/new');
  assert.equal(ad.sha256, digest(image.bytes));
  assert.equal(catalog.sources.get(ad.image), image.location);
  assert.deepEqual(snapshot(root), before);
});

test('exact shortcut names beat aliases, while ambiguous normalized matches are not guessed', t => {
  const root = fixture(t);
  pair(root, 'ads', 'Exact.jpg', 'https://example.com/exact');
  writeLink(root, 'ads', 'Ex act.url', 'https://example.com/alias');
  writeImage(root, 'ads', 'Cro wd X.jpg');
  writeLink(root, 'ads', 'CrowdX.url', 'https://example.com/ambiguous-one');
  writeLink(root, 'ads', 'Crow dX.url', 'https://example.com/ambiguous-two');
  pair(root, 'assets/ad', 'Legacy Pair.jpg', 'https://example.com/original');
  writeLink(root, 'ads', 'LegacyPair.url', 'https://example.com/override-one');
  writeLink(root, 'ads', 'Leg acyPair.url', 'https://example.com/override-two');
  const before = snapshot(root);
  const catalog = buildCatalog(root);
  assert.equal(catalog.manifest.ads.length, 1);
  assert.equal(catalog.manifest.ads.find(ad => ad.image === 'Exact.jpg').link_url, 'https://example.com/exact');
  assert.ok(!catalog.manifest.ads.some(ad => ad.image === 'Legacy Pair.jpg'), 'conflicting replacements must not silently publish a stale legacy destination');
  assert.ok(!catalog.manifest.ads.some(ad => ad.image === 'Cro wd X.jpg'));
  assertCatalogIntegrity(catalog);
  assert.deepEqual(snapshot(root), before);
});

test('invalid root advertisements do not remove unrelated valid legacy or root entries', t => {
  const root = fixture(t);
  pair(root, 'assets/ad', 'Legacy.jpg', 'https://example.com/legacy');
  pair(root, 'ads', 'Current.jpg', 'https://example.com/current');
  fs.writeFileSync(path.join(root, 'ads', 'BadBytes.jpg'), 'not a JPEG');
  writeLink(root, 'ads', 'BadBytes.url', 'https://example.com/bad-bytes');
  pair(root, 'ads', 'UnsafeLink.jpg', 'http://example.com/insecure');
  pair(root, 'ads', 'Unsafe#Name.jpg', 'https://example.com/unsafe-name');
  pair(root, 'ads', 'Credential.jpg', 'https://name:password@example.com/credential');
  writeImage(root, 'ads', 'MissingLink.jpg');
  const before = snapshot(root);
  const catalog = buildCatalog(root);
  assert.deepEqual(new Set(catalog.manifest.ads.map(ad => ad.image)), new Set(['Legacy.jpg', 'Current.jpg']));
  assertCatalogIntegrity(catalog);
  assert.deepEqual(snapshot(root), before);
});

test('the merged catalog keeps the global count and image-byte budgets', t => {
  const root = fixture(t);
  for (const [folder, prefix] of [['assets/ad', 'legacy'], ['ads', 'root']]) {
    for (let index = 0; index < 20; index++) pair(root, folder, `${prefix}-${index}.jpg`, `https://example.com/${prefix}-${index}`);
  }
  const catalog = buildCatalog(root);
  assert.equal(catalog.manifest.ads.length, 32);
  assertCatalogIntegrity(catalog);
  const largeRoot = fixture(t);
  for (const [folder, prefix] of [['assets/ad', 'legacy'], ['ads', 'root']]) {
    for (let index = 0; index < 4; index++) pair(largeRoot, folder, `${prefix}-${index}.jpg`, `https://example.com/${prefix}-${index}`, index + 1, 5 * 1024 * 1024);
  }
  const large = buildCatalog(largeRoot);
  assert.ok(large.manifest.ads.length > 0);
  assert.ok(large.manifest.ads.reduce((sum, ad) => sum + ad.size_bytes, 0) <= 30 * 1024 * 1024);
  assertCatalogIntegrity(large);
});

test('the public website build preserves homepage and downloads while publishing merged advertisements', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const filename of ['build-public-site.cjs', 'build-ad-feed.cjs', 'build-ad-catalog.cjs']) fs.copyFileSync(path.join(repository, 'scripts', filename), path.join(root, 'scripts', filename));
  const homepage = '<!doctype html><title>Existing public homepage</title><a href="downloads/application.zip">Download</a>\n';
  const englishHomepage = '<!doctype html><html lang="en"><title>Existing English homepage</title><a href="index.html">中文</a></html>\n';
  const englishRedirect = '<!doctype html><meta http-equiv="refresh" content="0;url=en/">\n';
  const stylesheet = 'body { color: rebeccapurple; }\n';
  fs.writeFileSync(path.join(root, 'index.html'), homepage);
  fs.mkdirSync(path.join(root, 'en'));
  fs.writeFileSync(path.join(root, 'en', 'index.html'), englishHomepage);
  fs.writeFileSync(path.join(root, 'en.html'), englishRedirect);
  fs.writeFileSync(path.join(root, 'style.css'), stylesheet);
  fs.mkdirSync(path.join(root, 'downloads'));
  fs.writeFileSync(path.join(root, 'downloads', 'application.zip'), 'public download fixture');
  fs.writeFileSync(path.join(root, 'assets', 'logo.png'), imageBytes('logo.png'));
  fs.writeFileSync(path.join(root, 'assets/ad', 'bundle-data.rs'), 'private generated build data');
  fs.writeFileSync(path.join(root, 'assets/ad', '.editor-note'), 'hidden author note');
  pair(root, 'assets/ad', 'Legacy.jpg', 'https://example.com/legacy');
  pair(root, 'ads', 'Current.jpg', 'https://example.com/current', 9);
  fs.writeFileSync(path.join(root, 'ads', 'manifest.json'), '{"user_note":"preserve this file"}\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'private.rs'), 'private source');
  fs.mkdirSync(path.join(root, 'dist', 'site'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'site', 'obsolete.txt'), 'old output must not survive');
  const before = new Map(['assets', 'ads', 'downloads'].map(folder => [folder, snapshot(path.join(root, folder))]));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-public-site.cjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = path.join(root, 'dist', 'site');
  assert.equal(fs.readFileSync(path.join(output, 'index.html'), 'utf8'), homepage);
  assert.equal(fs.readFileSync(path.join(output, 'en.html'), 'utf8'), englishRedirect);
  assert.equal(fs.readFileSync(path.join(output, 'en', 'index.html'), 'utf8'), englishHomepage);
  assert.equal(fs.readFileSync(path.join(output, 'style.css'), 'utf8'), stylesheet);
  assert.equal(fs.readFileSync(path.join(output, 'downloads', 'application.zip'), 'utf8'), 'public download fixture');
  const published = JSON.parse(fs.readFileSync(path.join(output, 'ads', 'manifest.json'), 'utf8'));
  assert.deepEqual(new Set(published.ads.map(ad => ad.image)), new Set(['Legacy.jpg', 'Current.jpg']));
  for (const ad of published.ads) assert.equal(digest(fs.readFileSync(path.join(output, 'ads', ad.image))), ad.sha256);
  for (const relative of ['src', 'scripts', 'obsolete.txt', 'assets/ad/bundle-data.rs', 'assets/ad/.editor-note']) assert.ok(!fs.existsSync(path.join(output, relative)), `${relative} must not be published`);
  assert.ok(fs.existsSync(path.join(output, '.nojekyll')));
  for (const [folder, contents] of before) assert.deepEqual(snapshot(path.join(root, folder)), contents, `${folder} source files must remain unchanged`);
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), homepage);
  assert.equal(fs.readFileSync(path.join(root, 'en.html'), 'utf8'), englishRedirect);
  assert.equal(fs.readFileSync(path.join(root, 'en', 'index.html'), 'utf8'), englishHomepage);
  assert.equal(fs.readFileSync(path.join(root, 'style.css'), 'utf8'), stylesheet);
});
