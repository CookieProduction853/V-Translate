const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {assemble}=require('../scripts/assemble-release.cjs');
test('complete download requires every part hash, final size and full ZIP hash',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-release-'));
 try{
  const input=path.join(root,'input'),output=path.join(root,'output');fs.mkdirSync(input);const bytes=Buffer.from('complete ZIP fixture'),sha=crypto.createHash('sha256').update(bytes).digest('hex');
  const manifest={version:'0.6.0',platform:'Windows-x64',source_commit:'a'.repeat(40),sha256:sha,size_bytes:bytes.length,names:['V-Translate-v0.6.0-Windows-x64.zip','V-Translate-Windows-x64.zip'],parts:[{name:'package.part-000',sha256:sha,size_bytes:bytes.length}]};
  fs.writeFileSync(path.join(input,'release.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(input,'package.part-000'),'corrupt');assert.throws(()=>assemble(input,output));
  fs.writeFileSync(path.join(input,'package.part-000'),bytes);assemble(input,output);assert.deepEqual(fs.readFileSync(path.join(output,'V-Translate-Windows-x64.zip')),bytes);
  manifest.parts[0].name='../outside';fs.writeFileSync(path.join(input,'release.json'),JSON.stringify(manifest));assert.throws(()=>assemble(input,output));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
