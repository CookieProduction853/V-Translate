// Developer packaging helper; the shipped app does not require Node or Python.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
const source = path.join(cargoHome, 'registry', 'src');
const registries = fs.readdirSync(source).map(name => path.join(source, name));
const lock = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
let output = 'V-Translate / 油字幕 — bundled Rust dependency license texts\nGenerated from the packages in Cargo.lock present in the build cache.\nRuntime engines and AI models are downloaded separately; see THIRD_PARTY_NOTICES.md.\n';
for (const block of lock.split('[[package]]').slice(1)) {
  const name = block.match(/^name = "([^"]+)"/m)?.[1];
  const version = block.match(/^version = "([^"]+)"/m)?.[1];
  const directory = registries.map(reg => path.join(reg, `${name}-${version}`)).find(p => fs.existsSync(p));
  if (!directory) continue;
  const licenses = [];
  function scan(dir, depth) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isFile() && /^(license|licence|copying|copyright|notice)([-_.]|$)/i.test(entry.name)) licenses.push(file);
      else if (entry.isDirectory() && depth > 0 && /^(licenses?|legal|third.party)$/i.test(entry.name)) scan(file, depth - 1);
    }
  }
  scan(directory, 2);
  output += `\n${'='.repeat(72)}\n${name} ${version}\n`;
  if (!licenses.length) {
    const manifest = fs.readFileSync(path.join(directory, 'Cargo.toml'), 'utf8');
    output += `Declared license: ${manifest.match(/^license = "([^"]+)"/m)?.[1] || 'see upstream manifest'}\n`;
  }
  for (const file of licenses.sort()) output += `\n--- ${path.relative(directory, file)} ---\n${fs.readFileSync(file, 'utf8')}\n`;
}
fs.writeFileSync(path.join(root, 'THIRD_PARTY_LICENSES.txt'), output);
console.log('Wrote THIRD_PARTY_LICENSES.txt');
