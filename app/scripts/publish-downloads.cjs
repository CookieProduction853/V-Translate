// Copy only verified release files into the public website checkout.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
function publish(source, website, platform, commit, version) {
  assert.ok(['Windows-x64', 'macOS-arm64'].includes(platform));
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const names = [`V-Translate-v${version}-${platform}.zip`, `V-Translate-${platform}.zip`];
  const checksumName = `SHA256SUMS-${platform}.txt`;
  const sums = fs.readFileSync(path.join(source, checksumName), 'utf8').replace(/^\uFEFF/, '');
  const verified = names.map(name => {
    const bytes = fs.readFileSync(path.join(source, name));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.ok(sums.split(/\r?\n/).some(line => line.trim() === `${sha256}  ${name}`), `Checksum mismatch: ${name}`);
    return {name, bytes, sha256};
  });
  assert.equal(verified[0].sha256, verified[1].sha256, 'Fixed download must match the versioned package');
  const downloads = path.join(website, 'downloads');
  fs.mkdirSync(downloads, {recursive:true});
  for (const file of verified) fs.writeFileSync(path.join(downloads, file.name), file.bytes);
  fs.copyFileSync(path.join(source, checksumName), path.join(downloads, checksumName));
  fs.writeFileSync(path.join(downloads, `release-${platform}.json`), JSON.stringify({version, source_commit:commit, files:verified.map(({name,bytes,sha256})=>({name,size_bytes:bytes.length,sha256}))},null,2)+'\n');
  // Maintain the combined checksum file used by the website, preserving the other platform.
  const combinedPath = path.join(downloads,'SHA256SUMS.txt');
  const previous = fs.existsSync(combinedPath) ? fs.readFileSync(combinedPath,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/) : [];
  const preserved = previous.filter(line=>line.trim() && !names.some(name=>line.trim().endsWith(`  ${name}`)));
  fs.writeFileSync(combinedPath,[...preserved,sums.trim()].join('\n')+'\n');
}
module.exports = {publish};
if (require.main === module) publish(...process.argv.slice(2));
