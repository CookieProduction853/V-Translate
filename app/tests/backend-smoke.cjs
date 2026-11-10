// Run after cargo build; exercises the actual Rust server and instance lock.
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
// A bounded GGUF container fixture, not a usable language model. This exercises
// catalog parsing without downloading model weights or starting inference.
function minimalGguf() {
  const bytes = Buffer.alloc(68);
  bytes.write('GGUF'); bytes.writeUInt32LE(3, 4);
  bytes.writeBigUInt64LE(1n, 8); // tensor count
  bytes.writeBigUInt64LE(0n, 16); // metadata count
  bytes.writeBigUInt64LE(6n, 24); bytes.write('weight', 32);
  bytes.writeUInt32LE(1, 38); bytes.writeBigUInt64LE(1n, 42);
  bytes.writeUInt32LE(0, 50); bytes.writeBigUInt64LE(0n, 54);
  return bytes;
}
async function launch(binary, data) {
  const process = spawn(binary, ['--no-open', '--no-network-updates', '--data-dir', data], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  process.stderr.on('data', data => { errors += data; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { process.kill(); reject(new Error('Server startup timed out')); }, 10000);
    process.stdout.on('data', data => {
      output += data;
      if (output.includes('\n')) { clearTimeout(timer); resolve(output.trim()); }
    });
    process.on('error', error => { clearTimeout(timer); reject(error); });
    process.on('exit', code => { if (!output) { clearTimeout(timer); reject(new Error(`Startup exit ${code}: ${errors}`)); } });
  });
  return { process, url };
}
(async () => {
  const binary = path.resolve(process.env.LIVESUB_BINARY || 'target/debug/livesub');
  const expectedVersion=(await fs.readFile(path.resolve(__dirname,'../Cargo.toml'),'utf8')).match(/^version\s*=\s*"([^"]+)"/m)[1];
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'livesub-backend-'));
  let first;
  try {
    first = await launch(binary, data);
    const url = new URL(first.url); const token = new URLSearchParams(url.hash.slice(1)).get('token');
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${url.origin}/api/player/open`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({browser:'chrome'})})).status,401);
    for (const body of [{browser:'shell'},{browser:'chrome',url:'https://external.example'}]) {
      assert.equal((await fetch(`${url.origin}/api/player/open`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)})).status,422);
    }
    const presenceUrl=`${url.origin}/api/player/presence`;
    const postPresence=(body,auth=headers)=>fetch(presenceUrl,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await postPresence({id:'test',closed:false,english:false},{})).status,401);
    assert.equal((await postPresence({id:'invalid id!',closed:false,english:false})).status,400);
    assert.equal((await postPresence({id:'test',closed:false,english:false})).status,200);
    assert.equal((await postPresence({id:'test',closed:true,english:false})).status,200);
    assert.equal((await postPresence({id:'replacement',closed:false,english:false})).status,200);
    await new Promise(resolve=>setTimeout(resolve,3200));
    const version = await (await fetch(`${url.origin}/api/version`, { headers })).json();
    assert.equal(version.version, expectedVersion);
    const platformUrl=`${url.origin}/api/platform`;
    assert.equal((await fetch(platformUrl)).status,401);
    assert.equal((await fetch(platformUrl,{headers:{...headers,Origin:'https://external.example'}})).status,403);
    const platformResponse=await fetch(platformUrl,{headers});
    assert.equal(platformResponse.status,200);
    const platform=await platformResponse.json();
    assert.ok(['windows','linux','macos'].includes(platform.os));assert.ok(typeof platform.arch==='string'&&platform.arch.length>0);
    const expectedBackends=platform.os==='macos'&&platform.arch==='aarch64'?['cpu','metal']:['cpu','vulkan'];
    assert.deepEqual(platform.backends,expectedBackends,'advertised compute modes must match the running platform');
    const status = await fetch(`${url.origin}/api/status`, { headers });
    assert.equal(status.status, 200); assert.equal((await status.json()).ready, false);
    assert.equal((await fetch(`${url.origin}/api/status`)).status, 401);
    assert.equal((await fetch(`${url.origin}/api/status`, { headers: { ...headers, Origin: 'https://external.example' } })).status, 403);
    assert.equal((await fetch(`${url.origin}/api/ads`)).status, 401);
    const adsResponse = await fetch(`${url.origin}/api/ads`, { headers });
    assert.equal(adsResponse.status, 200);
    const ads = await adsResponse.json();
    assert.equal(ads.state, 'unconfigured', '--no-network-updates must disable the remote feed before startup');
    const bundledManifest = JSON.parse(await fs.readFile(path.resolve(__dirname, '../assets/ad/manifest.json'), 'utf8'));
    if (ads.state !== 'ready') {
      const bundledVisible = bundledManifest.ads.filter(ad => !/^ad ?1\.[^.]+$/i.test(ad.image));
      assert.equal(ads.ads.length, bundledVisible.length, 'ordinary bundled ads remain available while a remote update is pending or offline');
    }
    for (const ad of ads.ads) {
      const bundled = bundledManifest.ads.find(entry => entry.id === ad.id);
      const isBundled = bundled && ad.image_url === `/ad-assets/${bundled.sha256}`;
      if (isBundled) assert.equal(ad.link_url, bundled.link_url, 'the image and shortcut destination must stay paired');
      assert.match(ad.image_url, /^\/ad-assets\/[a-f0-9]{64}$/);
      assert.equal(new URL(ad.link_url).protocol, 'https:');
      const imageResponse = await fetch(`${url.origin}${ad.image_url}`);
      assert.equal(imageResponse.status, 200);
      assert.ok(imageResponse.headers.get('content-type').startsWith('image/'));
      assert.equal(imageResponse.headers.get('x-content-type-options'), 'nosniff');
      const image = Buffer.from(await imageResponse.arrayBuffer());
      assert.equal(createHash('sha256').update(image).digest('hex'), ad.image_url.split('/').pop());
      if (isBundled) assert.deepEqual(image, await fs.readFile(path.resolve(__dirname, '../assets/ad', bundled.image)));
      assert.equal((await fetch(`${url.origin}${ad.image_url}`, { headers: { Origin: 'https://external.example' } })).status, 403);
    }
    assert.equal((await fetch(`${url.origin}/ad-assets/not-found`)).status, 404);
    const settingsUrl = `${url.origin}/api/settings`;
    const initialSettings=await (await fetch(settingsUrl, { headers })).json();
    assert.deepEqual(initialSettings,{backend:'cpu',device:null,performance:'high',whisper_model:'small',translation_model:null,cpu_threads:6,chunk_seconds:5,buffer_seconds:5});
    const gpuBackend=platform.backends.find(backend=>backend!=='cpu')||'cpu';
    const gpuDevice=gpuBackend==='metal'?'MTL0':gpuBackend==='vulkan'?'Vulkan1':null;
    const gpu={...initialSettings, backend:gpuBackend,device:gpuDevice};
    const switched = await fetch(settingsUrl, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(gpu) });
    assert.equal(switched.status, 200); assert.deepEqual(await switched.json(), gpu);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(data, 'settings.json'), 'utf8')), gpu);
    const gpuStatus = await (await fetch(`${url.origin}/api/status`, { headers })).json();
    assert.equal(gpuStatus.backend, gpuBackend); assert.equal(gpuStatus.ready, false); assert.equal(gpuStatus.device, null);
    const invalid = await fetch(settingsUrl, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({backend:gpuBackend,device:'--bad-option'}) });
    assert.equal(invalid.status, 400);
    for(const unsupported of ['vulkan','metal'].filter(backend=>!platform.backends.includes(backend))){
      const rejected=await fetch(settingsUrl,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({...initialSettings,backend:unsupported,device:unsupported==='metal'?'MTL0':'Vulkan0'})});
      assert.equal(rejected.status,400,`${unsupported} must be rejected on ${platform.os}/${platform.arch}`);
    }
    assert.deepEqual(await (await fetch(settingsUrl,{headers})).json(),gpu,'unsupported backends must not overwrite saved compute choices');
    const low={...gpu,performance:'low',whisper_model:'tiny',cpu_threads:2,chunk_seconds:8,buffer_seconds:60};
    const lowResponse=await fetch(settingsUrl,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(low)});
    assert.equal(lowResponse.status,200);assert.deepEqual(await lowResponse.json(),low);
    const translationModelsUrl=`${url.origin}/api/translation-models`;
    assert.deepEqual(await (await fetch(translationModelsUrl,{headers})).json(),{models:[],warnings:[]});
    assert.equal((await fetch(translationModelsUrl)).status,401);
    const customFolder=path.join(data,'models','translation');
    await fs.mkdir(customFolder,{recursive:true});
    const customFilename='viewer-chat-q4_k_m.gguf';
    await fs.writeFile(path.join(customFolder,customFilename),minimalGguf());
    await fs.writeFile(path.join(customFolder,'broken.gguf'),Buffer.from('not a GGUF model'));
    await fs.writeFile(path.join(customFolder,'ignored.txt'),'not a model');
    await fs.mkdir(path.join(customFolder,'nested'),{recursive:true});
    await fs.writeFile(path.join(customFolder,'nested','nested.gguf'),minimalGguf());
    const catalogResponse=await fetch(translationModelsUrl,{headers});
    assert.equal(catalogResponse.status,200);
    const catalog=await catalogResponse.json();
    assert.equal(catalog.models.length,1,'catalog accepts direct valid containers and skips malformed or nested files');
    const model=catalog.models[0];
    assert.equal(model.id,customFilename);assert.equal(model.filename,customFilename);
    assert.equal(model.name,'viewer-chat-q4_k_m');assert.equal(model.size_bytes,68);
    assert.ok(catalog.warnings.some(warning=>warning.includes('broken.gguf')));
    const customSettings={...low,translation_model:customFilename};
    const customResponse=await fetch(settingsUrl,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(customSettings)});
    assert.equal(customResponse.status,200);assert.deepEqual(await customResponse.json(),customSettings);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(data,'settings.json'),'utf8')),customSettings);
    for(const unsafe of ['../outside.gguf','nested/nested.gguf','C:\\models\\outside.gguf','model.gguf:stream','NUL.gguf']){
      const rejected=await fetch(settingsUrl,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({...customSettings,translation_model:unsafe})});
      assert.equal(rejected.status,400,`unsafe model selection must be rejected: ${unsafe}`);
    }
    assert.deepEqual(await (await fetch(settingsUrl,{headers})).json(),customSettings,'invalid model names must not replace saved compute settings');
    await fs.unlink(path.join(customFolder,customFilename));
    assert.deepEqual((await (await fetch(translationModelsUrl,{headers})).json()).models,[]);
    assert.equal((await (await fetch(settingsUrl,{headers})).json()).translation_model,customFilename,'rescanning must not silently select the built-in model');
    const missing=await fetch(settingsUrl,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(customSettings)});
    assert.equal(missing.status,400,'even the saved selection must still exist when submitted again');
    const missingSetup=await fetch(`${url.origin}/api/setup`,{method:'POST',headers});
    assert.equal(missingSetup.status,400,'missing custom weights must fail before any download');
    assert.equal((await (await fetch(`${url.origin}/api/status`,{headers})).json()).ready,false);
    const restored = await fetch(settingsUrl, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({backend:'cpu',device:null}) });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).translation_model,null,'legacy API clients retain the built-in automatic choice');
    const appearanceUrl=`${url.origin}/api/appearance`;
    assert.deepEqual(await (await fetch(appearanceUrl,{headers})).json(),{theme:'studio',language:'zh-Hant',onboarding_complete:false});
    const appearance = await fetch(appearanceUrl, {method:'PUT', headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({theme:'light',language:'en'})});
    assert.equal(appearance.status,200);
    assert.deepEqual(await appearance.json(),{theme:'light',language:'en',onboarding_complete:false});
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(data,'appearance.json'),'utf8')),{theme:'light',language:'en'});
    const invalidLanguage=await fetch(appearanceUrl,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({theme:'studio',language:'unsupported'})});
    assert.ok(invalidLanguage.status>=400&&invalidLanguage.status<500);
    assert.deepEqual(await (await fetch(appearanceUrl,{headers})).json(),{theme:'light',language:'en',onboarding_complete:false},'invalid language must not overwrite the saved appearance');
    const pack={format_version:1,name:'測試詞彙包',language:'ja',terms:[{source:'星乃',target:'星乃',reading:'ほしの'}]};
    const imported=await (await fetch(`${url.origin}/api/vocabulary/import`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(pack)})).json();
    const profileId=imported.profiles[0].id;
    const active=await fetch(`${url.origin}/api/vocabulary/active`,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({id:profileId})});
    assert.equal(active.status,200);
    assert.equal((await active.json()).active_id,profileId);
    assert.equal((await fetch(`${url.origin}/api/vocabulary/${profileId}`,{method:'DELETE',headers})).status,200);
    const csvPack=await fetch(`${url.origin}/api/vocabulary/import`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({format:'csv',name:'Exchange',content:'source,target\n"星乃,露米","星乃，露米"\n'})});
    assert.equal(csvPack.status,200);
    const csvId=(await csvPack.json()).profiles[0].id;
    const exported=await (await fetch(`${url.origin}/api/vocabulary/${csvId}/export?format=tsv`,{headers})).json();
    assert.ok(exported.content.includes('星乃,露米\t星乃，露米'));
    assert.equal((await fetch(`${url.origin}/api/vocabulary/${csvId}`,{method:'DELETE',headers})).status,200);
    const page = await fetch(url.origin);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.ok((await page.text()).includes('油字幕'));
    for (const file of ['app.js', 'audio-worklet.js', 'timeline.js', 'backpressure.js', 'advertisements.js', 'i18n.js', 'backend-i18n.js']) {
      const response = await fetch(`${url.origin}/${file}`);
      assert.equal(response.status, 200); assert.ok(response.headers.get('content-type').startsWith('text/javascript'));
    }
    const manifestResponse=await fetch(`${url.origin}/manifest.webmanifest`);
    assert.equal(manifestResponse.status,200);assert.ok(manifestResponse.headers.get('content-type').startsWith('application/manifest+json'));
    const manifest=await manifestResponse.json();
    assert.equal(manifest.name,'油字幕 / V-Translate');
    for(const [route,filename,mime] of [['app-icon.png','app-icon.png','image/png'],['favicon.ico','app-icon.ico','image/x-icon']]){
      const source=await fs.readFile(path.resolve(__dirname,'../assets',filename)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      const response=await fetch(`${url.origin}/${route}`);
      assert.equal(response.status,source?200:404,`${route} must use the supplied asset when present`);
      if(source){assert.ok(response.headers.get('content-type').startsWith(mime));assert.deepEqual(Buffer.from(await response.arrayBuffer()),source);}
      if(route==='app-icon.png')assert.equal((manifest.icons||[]).some(icon=>icon.src==='/app-icon.png'),!!source);
    }
    const duplicate = await launch(binary, data);
    assert.equal(duplicate.url, first.url);
    if (duplicate.process.exitCode === null) await once(duplicate.process, 'exit');
    assert.equal(duplicate.process.exitCode, 0);
    const exited = once(first.process, 'exit');
    await fetch(`${url.origin}/api/quit`, { method: 'POST', headers });
    const [code] = await exited; assert.equal(code, 0);

    // Existing users retain their saved compute choices while legacy cinema maps to studio.
    const savedSettings={backend:'cpu',device:null,performance:'balanced',whisper_model:'base',cpu_threads:4,chunk_seconds:7,buffer_seconds:47};
    await fs.writeFile(path.join(data,'settings.json'),JSON.stringify(savedSettings));
    await fs.writeFile(path.join(data,'appearance.json'),JSON.stringify({theme:'cinema'}));
    first=await launch(binary,data);
    const migratedUrl=new URL(first.url);
    const migratedHeaders={Authorization:`Bearer ${new URLSearchParams(migratedUrl.hash.slice(1)).get('token')}`};
    assert.deepEqual(await (await fetch(`${migratedUrl.origin}/api/settings`,{headers:migratedHeaders})).json(),{...savedSettings,translation_model:null});
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(data,'settings.json'),'utf8')),savedSettings,'opening the app must not rewrite saved inference settings');
    assert.deepEqual(await (await fetch(`${migratedUrl.origin}/api/appearance`,{headers:migratedHeaders})).json(),{theme:'studio',language:'zh-Hant',onboarding_complete:false});
    const migratedExited=once(first.process,'exit');
    if (['windows','macos'].includes(platform.os)) {
      const tool=platform.os==='windows'?'Stop-Whisper.ps1':'Stop-Whisper.command';
      const toolPath=path.resolve(__dirname,'../scripts/stop-tools',tool);
      const stopTool=()=>new Promise((resolve,reject)=>{
        const command=platform.os==='windows'?'powershell.exe':'bash';
        const args=platform.os==='windows'?['-NoProfile','-ExecutionPolicy','Bypass','-File',toolPath,'-DataDir',data]:[toolPath,data];
        const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});
        let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
        child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Stop helper failed ${code}: ${output}`)));
      });
      await stopTool();
      assert.equal((await migratedExited)[0],0,'folder tool must stop the actual packaged server');
      await stopTool(); // Already stopped remains harmless.
    } else {
      await fetch(`${migratedUrl.origin}/api/quit`,{method:'POST',headers:migratedHeaders});
      assert.equal((await migratedExited)[0],0);
    }
    if (process.env.LIVESUB_OLD_BINARY) {
      const old = await launch(path.resolve(process.env.LIVESUB_OLD_BINARY), data);
      const oldUrl = new URL(old.url);
      const oldHeaders = {Authorization: `Bearer ${new URLSearchParams(oldUrl.hash.slice(1)).get('token')}`};
      try {
        await assert.rejects(launch(binary, data), /舊版 LiveSub 仍在背景執行/);
        assert.equal(old.process.exitCode, null, 'upgrading must not silently kill an existing capture');
        assert.equal((await fetch(`${oldUrl.origin}/api/status`, {headers:oldHeaders})).status, 200);
      } finally {
        const stopped = once(old.process, 'exit');
        await fetch(`${oldUrl.origin}/api/quit`, {method:'POST',headers:oldHeaders});
        await stopped;
      }
    }
    console.log(`PASS actual Rust server (${platform.os}/${platform.arch}): authenticated platform API, supported CPU/${gpuBackend} settings, origin checks, bundled ad images/hashes/links, bilingual appearance, custom GGUF catalog and safe selection, first-run defaults, saved-settings preservation, legacy settings/theme migration, frontend assets, version-aware single instance, clean shutdown`);
  } finally {
    if (first?.process.exitCode === null) first.process.kill();
    await fs.rm(data, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
