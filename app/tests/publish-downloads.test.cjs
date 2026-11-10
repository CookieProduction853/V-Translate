const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {publish} = require('../scripts/publish-downloads.cjs');
test('publish verifies both archives before changing public downloads and preserves other platform sums',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vtranslate-publish-'));
  try {
    const source=path.join(root,'source'), website=path.join(root,'website');
    fs.mkdirSync(source);fs.mkdirSync(path.join(website,'downloads'),{recursive:true});
    fs.writeFileSync(path.join(website,'downloads','SHA256SUMS.txt'),'other-platform-checksum\n');
    const names=['V-Translate-v0.5.2-Windows-x64.zip','V-Translate-Windows-x64.zip'];
    const bytes=Buffer.from('package fixture'),sha=crypto.createHash('sha256').update(bytes).digest('hex');
    names.forEach(name=>fs.writeFileSync(path.join(source,name),bytes));
    const checksum=path.join(source,'SHA256SUMS-Windows-x64.txt');
    fs.writeFileSync(checksum,'\uFEFF'+names.map(name=>`${sha}  ${name}`).join('\r\n'));
    fs.writeFileSync(path.join(source,names[1]),'corrupt');
    assert.throws(()=>publish(source,website,'Windows-x64','a'.repeat(40),'0.5.2'),/Checksum mismatch/);
    assert.equal(fs.existsSync(path.join(website,'downloads',names[0])),false);
    fs.writeFileSync(path.join(source,names[1]),bytes);
    publish(source,website,'Windows-x64','a'.repeat(40),'0.5.2');
    assert.deepEqual(fs.readFileSync(path.join(website,'downloads',names[1])),bytes);
    assert.equal(JSON.parse(fs.readFileSync(path.join(website,'downloads','release-Windows-x64.json'))).source_commit,'a'.repeat(40));
    assert.ok(fs.readFileSync(path.join(website,'downloads','SHA256SUMS.txt'),'utf8').includes('other-platform-checksum'));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
