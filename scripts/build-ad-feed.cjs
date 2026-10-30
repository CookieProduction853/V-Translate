// Publisher/build helper. The distributed Rust executable does not need Node.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const directory = path.resolve(process.argv[2] || path.join(root, 'assets/ad'));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function target(text) {
  if (Buffer.isBuffer(text)) {
    if (!text.length || text.length > 8192) throw Error('Shortcut is empty or too large');
    text = new TextDecoder('utf-8', { fatal: true }).decode(text);
  }
  if (typeof text !== 'string' || !text || Buffer.byteLength(text, 'utf8') > 8192) throw Error('Shortcut is empty or too large');
  text = text.replace(/^\uFEFF/, '').trim();
  const destination = value => {
    if (!value || /\p{Cc}/u.test(value)) throw Error('Destination contains invalid characters');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) throw Error('Use one HTTPS destination without embedded credentials');
    return url.href;
  };
  if (!/[\r\n]/.test(text) && !text.startsWith('[')) return destination(text);
  let inShortcut = false;
  let result = null;
  for (const line of text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
    if (line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      inShortcut = line.toLowerCase() === '[internetshortcut]';
      continue;
    }
    const equals = line.indexOf('=');
    if (equals >= 0 && line.slice(0, equals).trim().toLowerCase() === 'url') {
      if (!inShortcut || result !== null) throw Error('Shortcut needs one URL in its InternetShortcut section');
      result = destination(line.slice(equals + 1).trim());
    }
  }
  if (result === null) throw Error('Shortcut is missing its InternetShortcut URL');
  return result;
}
function imageType(bytes, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png' && bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (bytes.readUInt32BE(16) > 8192 || bytes.readUInt32BE(20) > 8192 || bytes.readUInt32BE(16)*bytes.readUInt32BE(20) > 16777216) throw Error('Image dimensions exceed the banner limit');
    return;
  }
  if (['.jpg','.jpeg'].includes(ext) && bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return;
  if (ext === '.webp' && bytes.length >= 12 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' && bytes.readUInt32LE(4)+8 === bytes.length) return;
  throw Error('Expected a JPEG, PNG or WebP image matching its extension');
}
function build(folder) {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, {recursive:true});
  const names = fs.readdirSync(folder).filter(name => fs.lstatSync(path.join(folder,name)).isFile() && !fs.lstatSync(path.join(folder,name)).isSymbolicLink()).sort();
  const shortcuts = names.filter(name => path.extname(name).toLowerCase() === '.url');
  const normalize = name => path.basename(name,path.extname(name)).replace(/\s/g,'').toLowerCase();
  const ads = []; let total = 0;
  for (const image of names.filter(name => /\.(png|jpe?g|webp)$/i.test(name))) {
    try {
      if (image.length > 160 || Buffer.byteLength(image, 'utf8') > 240 || /[\\/\p{Cc}<>:"|?*%#]/u.test(image) || image.startsWith('.') || image !== image.trim()) throw Error('Unsupported portable image filename');
      const exact = shortcuts.filter(name => path.basename(name,path.extname(name)).toLowerCase() === path.basename(image,path.extname(image)).toLowerCase());
      const matches = exact.length ? exact : shortcuts.filter(name => normalize(name) === normalize(image));
      const siblings = names.filter(name => /\.(png|jpe?g|webp)$/i.test(name) && normalize(name) === normalize(image));
      if (matches.length !== 1 || (!exact.length && siblings.length !== 1)) throw Error('No unique same-name .url shortcut');
      const shortcutPath = path.join(folder,matches[0]);
      if (fs.statSync(shortcutPath).size > 8192) throw Error('Shortcut is too large');
      const shortcut = fs.readFileSync(shortcutPath);
      const link_url = target(shortcut);
      const size = fs.statSync(path.join(folder,image)).size;
      if (!size || size > 5*1024*1024 || total+size > 30*1024*1024 || ads.length >= 32) throw Error('Banner byte/count budget exceeded');
      const bytes = fs.readFileSync(path.join(folder,image));
      if (!bytes.length || bytes.length > 5*1024*1024 || total+bytes.length > 30*1024*1024 || ads.length >= 32) throw Error('Banner byte/count budget exceeded');
      imageType(bytes,image);
      ads.push({id:`ad-${digest(Buffer.from(image)).slice(0,16)}`,image,sha256:digest(bytes),size_bytes:bytes.length,link_url}); total += bytes.length;
    } catch (error) { console.error(`Skipped ${image}: ${error.message}`); }
  }
  return {format_version:1, ads};
}
if (require.main === module) {
  const manifest = build(directory);
  fs.writeFileSync(path.join(directory,'manifest.json'), JSON.stringify(manifest,null,2)+'\n');
  const fields = manifest.ads.map(ad => `    crate::ads::BundledAd { id: ${JSON.stringify(ad.id)}, image: ${JSON.stringify(ad.image)}, bytes: include_bytes!(${JSON.stringify(ad.image)}), sha256: ${JSON.stringify(ad.sha256)}, link_url: ${JSON.stringify(ad.link_url)} },`);
  fs.writeFileSync(path.join(directory,'bundle-data.rs'), '&[\n'+fields.join('\n')+'\n]\n');
  console.log(`Prepared ${manifest.ads.length} bundled advertisements and public feed manifest`);
}
module.exports={build,target};
