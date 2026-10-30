// Merge the legacy ad folder with the public ads/ upload folder without editing either.
const fs = require('node:fs');
const path = require('node:path');
const { build, target } = require('./build-ad-feed.cjs');

const stem = filename => path.basename(filename, path.extname(filename)).toLowerCase();
const key = filename => stem(filename).replace(/\s/g, '');
const compare = (left, right) => left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' }) || left.localeCompare(right, 'en');

function directoryExists(folder) {
  try {
    const stat = fs.lstatSync(folder);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error(`Ad input must be an ordinary directory: ${folder}`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function shortcutsIn(folder) {
  if (!directoryExists(folder)) return [];
  return fs.readdirSync(folder).filter(filename => {
    const stat = fs.lstatSync(path.join(folder, filename));
    return stat.isFile() && !stat.isSymbolicLink() && path.extname(filename).toLowerCase() === '.url';
  }).sort(compare);
}

function buildCatalog(root) {
  const legacy = path.join(root, 'assets', 'ad');
  const uploads = path.join(root, 'ads');
  const selected = new Map();
  for (const folder of [legacy, uploads]) {
    if (!directoryExists(folder)) continue;
    const candidates = build(folder).ads.sort((left, right) => {
      // A canonical AD1.png wins over an older "AD 1.png" alias in the same folder.
      const leftCanonical = stem(left.image) === key(left.image);
      const rightCanonical = stem(right.image) === key(right.image);
      return Number(rightCanonical) - Number(leftCanonical) || compare(left.image, right.image);
    });
    const seen = new Set();
    for (const entry of candidates) {
      const normalized = key(entry.image);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      selected.set(normalized, { entry, source: path.join(folder, entry.image) });
    }
  }

  // A new .url upload can update a destination while retaining its legacy image.
  const shortcuts = shortcutsIn(uploads);
  const candidates = [...selected.entries()].sort(([left], [right]) => compare(left, right));
  const manifest = { format_version: 1, ads: [] };
  const sources = new Map();
  let total = 0;
  for (const [, candidate] of candidates) {
    let entry = candidate.entry;
    try {
      const exact = shortcuts.filter(filename => stem(filename) === stem(entry.image));
      const matches = exact.length ? exact : shortcuts.filter(filename => key(filename) === key(entry.image));
      if (matches.length) {
        if (matches.length !== 1) throw Error('No unique root ads/ destination override');
        const shortcut = path.join(uploads, matches[0]);
        if (fs.statSync(shortcut).size > 8192) throw Error('Shortcut is too large');
        entry = { ...entry, link_url: target(fs.readFileSync(shortcut)) };
      }
      if (manifest.ads.length >= 32 || total + entry.size_bytes > 30 * 1024 * 1024) throw Error('Merged ad catalog exceeds its byte/count budget');
      manifest.ads.push(entry);
      sources.set(entry.image, candidate.source);
      total += entry.size_bytes;
    } catch (error) {
      console.error(`Skipped ${entry.image}: ${error.message}`);
    }
  }
  return { manifest, sources };
}

module.exports = { buildCatalog };
