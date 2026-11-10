// Reuse verified inference engines, never the older application executable.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const archiveSha='c5ce4a61468ebd78e8ca91b3576a13158fd84232d2899fafb34e678f204545ea';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function files(directory){return fs.readdirSync(directory).sort().flatMap(name=>{const file=path.join(directory,name),stat=fs.lstatSync(file);assert.ok(!stat.isSymbolicLink(),`Unexpected symlink: ${file}`);return stat.isDirectory()?files(file):[file];});}
function verify(root){
 for(const line of fs.readFileSync(path.join(root,'SHA256SUMS.txt'),'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/)){
  const match=line.match(/^([a-f0-9]{64})  (.+)$/);assert.ok(match,'Invalid baseline checksum');
  assert.ok(!path.isAbsolute(match[2])&&!match[2].split(/[\\/]/).includes('..'));
  assert.equal(sha(fs.readFileSync(path.join(root,match[2]))),match[1],match[2]);
 }
 const app=path.join(root,'V-Translate.app'),resources=path.join(app,'Contents/Resources'),runtime=path.join(resources,'runtime');
 const manifest=JSON.parse(fs.readFileSync(path.join(resources,'runtime-manifest.json')));assert.equal(manifest.format_version,1);
 const expected=new Set();
 for(const entry of manifest.files){
  assert.match(entry.path,/^(whisper|llama)\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/);assert.ok(!expected.has(entry.path));expected.add(entry.path);
  const bytes=fs.readFileSync(path.join(runtime,entry.path));assert.equal(bytes.length,entry.size_bytes);assert.equal(sha(bytes),entry.sha256);
  assert.equal(bytes.readUInt32LE(0),0xfeedfacf);assert.equal(bytes.readUInt32LE(4),0x0100000c);
 }
 assert.deepEqual(new Set(files(runtime).map(file=>path.relative(runtime,file))),expected);
 return {app,resources,runtime,baseline_app_sha256:sha(fs.readFileSync(path.join(app,'Contents/MacOS/V-Translate')))};
}
function stage(archive,project=path.resolve(__dirname,'..')){
 assert.equal(process.platform,'darwin','Native Apple Silicon build required');assert.equal(process.arch,'arm64');
 assert.equal(sha(fs.readFileSync(archive)),archiveSha,'Pinned runtime archive checksum');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'vtranslate-runtime-baseline-'));
 try{
  execFileSync('/usr/bin/ditto',['-x','-k',archive,temporary]);
  const verified=verify(path.join(temporary,'V-Translate-macOS-arm64'));
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',verified.app],{stdio:'inherit'});
  const dist=path.join(project,'dist');fs.mkdirSync(dist,{recursive:true});
  for(const [source,name] of [[verified.runtime,'macos-runtime'],[path.join(verified.resources,'licenses'),'macos-runtime-licenses']]){
   const output=path.join(dist,name);fs.rmSync(output,{recursive:true,force:true});fs.cpSync(source,output,{recursive:true,preserveTimestamps:true});
  }
  fs.copyFileSync(path.join(verified.resources,'runtime-manifest.json'),path.join(dist,'macos-runtime-manifest.json'));
  fs.writeFileSync(path.join(dist,'macos-runtime-baseline.json'),JSON.stringify({archive_sha256:archiveSha,baseline_app_sha256:verified.baseline_app_sha256,application_binary_reused:false},null,2)+'\n');
  console.log('Verified ARM64 inference runtime staged. The application executable must be rebuilt from v0.5.2 source.');
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
module.exports={archiveSha,verify};if(require.main===module)stage(path.resolve(process.argv[2]));
