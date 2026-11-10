// Cross-platform integrity test only; signature/launch checks remain mandatory on the Mac runner.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {archiveSha,verify}=require('../scripts/prepare-macos-runtime-baseline.cjs');
assert.ok(process.argv[2],'Supply the pinned v0.5.1 runtime archive');
const archive=path.resolve(process.argv[2]);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),archiveSha);
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'mac-runtime-integrity-'));
try{
 execFileSync('unzip',['-q',archive,'-d',temporary]);
 const root=path.join(temporary,'V-Translate-macOS-arm64');const result=verify(root);
 assert.match(result.baseline_app_sha256,/^[a-f0-9]{64}$/);
 const binary=path.join(result.runtime,'whisper','whisper-server'),original=fs.readFileSync(binary),corrupt=Buffer.from(original);corrupt[corrupt.length-1]^=1;
 fs.writeFileSync(binary,corrupt);assert.throws(()=>verify(root));fs.writeFileSync(binary,original);verify(root);
 console.log('PASS pinned runtime archive and all file/ARM64 manifest hashes; tampering rejected. No application executable staged.');
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
