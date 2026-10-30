// Publish the existing public website, downloads, and validated ad feed together.
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('./build-ad-feed.cjs');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
const dist = path.join(root, 'dist');
const output = path.join(dist, 'site');
const assetTypes = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.avif', '.bmp', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm', '.mp3', '.wav', '.ogg', '.json', '.url', '.txt']);
const downloadTypes = new Set(['.zip', '.exe', '.msi', '.txt', '.md', '.json', '.sha256']);

function ordinary(location, directory) {
  const stat = fs.lstatSync(location);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw Error(`Expected an ordinary ${directory ? 'directory' : 'file'}: ${location}`);
}
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function filesIn(directory, allowed) {
  ordinary(directory, true);
  const files = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const source = path.join(directory, name);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw Error(`Public inputs cannot contain symbolic links: ${source}`);
    if (name.startsWith('.') || name === 'bundle-data.rs') continue;
    if (/[\\/\p{Cc}]/u.test(name) || name !== name.trim()) throw Error(`Unsupported public filename: ${name}`);
    if (stat.isDirectory()) files.push(...filesIn(source, allowed));
    else if (stat.isFile() && allowed.has(path.extname(name).toLowerCase())) files.push(source);
    else throw Error(`Unsupported public asset type: ${source}`);
  }
  return files;
}

const index = path.join(root, 'index.html');
const stylesheet = path.join(root, 'style.css');
ordinary(index, false);
ordinary(stylesheet, false);
const assets = path.join(root, 'assets');
const downloads = path.join(root, 'downloads');
const adSource = path.join(assets, 'ad');
ordinary(adSource, true);
const files = [index, stylesheet, ...filesIn(assets, assetTypes), ...filesIn(downloads, downloadTypes)];
for (const source of files) {
  if (inside(output, fs.realpathSync(source))) throw Error('Public build inputs must be outside dist/site');
}
const feed = build(adSource);

// Only this fixed output may be replaced. Refuse linked parents before removal.
if (fs.existsSync(dist)) ordinary(dist, true);
else fs.mkdirSync(dist);
try { ordinary(output, true); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output);
for (const source of files) {
  const destination = path.join(output, path.relative(root, source));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}
fs.mkdirSync(path.join(output, 'ads'));
fs.writeFileSync(path.join(output, 'ads', 'manifest.json'), `${JSON.stringify(feed, null, 2)}\n`);
for (const ad of feed.ads) fs.copyFileSync(path.join(adSource, ad.image), path.join(output, 'ads', ad.image));
fs.writeFileSync(path.join(output, '.nojekyll'), '');
console.log(`Prepared the public website, downloads, and ${feed.ads.length} ads in ${output}`);
