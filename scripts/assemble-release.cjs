// Assemble only the declared, hash-verified ZIP; no application source enters the public site.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
function assemble(input,output){
 const manifest=JSON.parse(fs.readFileSync(path.join(input,'release.json')));
 assert.match(manifest.version,/^\d+\.\d+\.\d+$/);assert.equal(manifest.platform,'Windows-x64');assert.match(manifest.source_commit,/^[a-f0-9]{40}$/);assert.match(manifest.sha256,/^[a-f0-9]{64}$/);
 const expected=[`V-Translate-v${manifest.version}-Windows-x64.zip`,'V-Translate-Windows-x64.zip'];assert.deepEqual(manifest.names,expected);
 fs.mkdirSync(output,{recursive:true});
 const destination=path.join(output,expected[0]),fd=fs.openSync(destination,'w'),digest=crypto.createHash('sha256');let size=0;
 try{
  assert.ok(manifest.parts.length>0&&manifest.parts.length<=20);
  for(const [index,part] of manifest.parts.entries()){
   assert.equal(part.name,`package.part-${String(index).padStart(3,'0')}`);
   const bytes=fs.readFileSync(path.join(input,part.name));assert.equal(bytes.length,part.size_bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),part.sha256);
   fs.writeFileSync(fd,bytes);digest.update(bytes);size+=bytes.length;
  }
 }finally{fs.closeSync(fd);}
 assert.equal(size,manifest.size_bytes);assert.equal(digest.digest('hex'),manifest.sha256);
 fs.copyFileSync(destination,path.join(output,expected[1]));
 fs.writeFileSync(path.join(output,'SHA256SUMS-Windows-x64.txt'),expected.map(name=>`${manifest.sha256}  ${name}`).join('\n')+'\n');
 fs.writeFileSync(path.join(output,'release-Windows-x64.json'),JSON.stringify({...manifest,parts:undefined,tag:`v${manifest.version}-Windows-x64-${manifest.source_commit.slice(0,8)}`},null,2)+'\n');
 console.log(`Verified complete Windows v${manifest.version} ZIP (${size} bytes)`);
 return manifest;
}
module.exports={assemble};if(require.main===module)assemble(...process.argv.slice(2));
