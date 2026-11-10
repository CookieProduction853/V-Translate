// Native macOS CI only. Uses the pinned public JFK WAV, never user audio.
// CPU transcription/translation is required. Metal is attempted separately and
// reports its own outcome so a hosted VM cannot masquerade as a GPU validation.
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const clean = value => String(value).replace(/#token=[^\s]+/g, '#token=[redacted]').replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]').slice(0, 1200);

function shortPcm(input) {
  assert.equal(input.toString('ascii',0,4),'RIFF','sample must be a WAV');
  assert.equal(input.toString('ascii',8,12),'WAVE');
  let format, audio;
  for(let offset=12;offset+8<=input.length;) {
    const name=input.toString('ascii',offset,offset+4),length=input.readUInt32LE(offset+4),start=offset+8;
    assert.ok(start+length<=input.length,'sample contains an incomplete WAV chunk');
    if(name==='fmt ')format=input.subarray(start,start+length);
    if(name==='data')audio=input.subarray(start,start+length);
    offset=start+length+(length%2);
  }
  assert.ok(format&&format.length>=16&&audio,'sample needs format and audio chunks');
  assert.equal(format.readUInt16LE(0),1,'sample must be PCM');
  assert.equal(format.readUInt16LE(2),1,'sample must be mono');
  assert.equal(format.readUInt32LE(4),16000,'sample must be 16 kHz');
  assert.equal(format.readUInt16LE(14),16,'sample must be PCM16');
  const length=Math.min(audio.length-audio.length%2,8*16000*2);
  assert.ok(length>=16000*2,'sample must contain speech-length audio');
  const output=Buffer.alloc(44+length);
  output.write('RIFF');output.writeUInt32LE(36+length,4);output.write('WAVEfmt ',8);
  output.writeUInt32LE(16,16);format.copy(output,20,0,16);
  output.write('data',36);output.writeUInt32LE(length,40);audio.copy(output,44,0,length);
  return output;
}

async function launch(binary, data) {
  const process=spawn(binary,['--no-open','--data-dir',data],{stdio:['ignore','pipe','pipe']});
  let output='',errors='';
  process.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-65536);});
  const url=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{process.kill('SIGINT');reject(Error('Packaged server startup timed out'));},30000);
    process.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);resolve(output.split('\n')[0].trim());}});
    process.once('error',error=>{clearTimeout(timer);reject(error);});
    process.once('exit',code=>{if(!output.includes('\n')){clearTimeout(timer);reject(Error(`Startup exit ${code}: ${clean(errors)}`));}});
  });
  return {process,url};
}

(async()=>{
  if(process.platform!=='darwin'||process.arch!=='arm64') {
    console.log('SKIP native inference smoke: requires Apple Silicon macOS; no models downloaded');
    return;
  }
  const report={format_version:1,cpu:'not_run',metal:'not_run',sample:'pinned whisper.cpp samples/jfk.wav trimmed to at most 8 seconds'};
  const binary=path.resolve(process.env.LIVESUB_BINARY||'dist/V-Translate-macOS-arm64/V-Translate.app/Contents/MacOS/V-Translate');
  const sample=path.resolve(process.env.WHISPER_SAMPLE_PATH||'target/macos-runtime-build/whisper-source/samples/jfk.wav');
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'vtranslate-native-inference-'));
  let app, api, activeSession, heartbeat;
  let requiredFailure;
  const saveReport=async()=>{
    if(process.env.MACOS_INFERENCE_REPORT_PATH) {
      const file=path.resolve(process.env.MACOS_INFERENCE_REPORT_PATH);
      await fs.mkdir(path.dirname(file),{recursive:true});
      await fs.writeFile(file,JSON.stringify(report,null,2)+'\n');
    }
  };
  try {
    const stat=await fs.stat(sample);assert.ok(stat.size>0&&stat.size<=4*1024*1024,'expected a small pinned sample WAV');
    const wav=shortPcm(await fs.readFile(sample));
    app=await launch(binary,data);
    const url=new URL(app.url);assert.equal(url.hostname,'127.0.0.1');
    const token=new URLSearchParams(url.hash.slice(1)).get('token');assert.ok(token);
    api=async(route,options={})=>{
      const response=await fetch(`${url.origin}${route}`,{...options,headers:{Authorization:`Bearer ${token}`,...options.headers},signal:AbortSignal.timeout(options.timeout||30000)});
      const text=await response.text();let body;try{body=JSON.parse(text);}catch{throw Error(`Non-JSON response (${response.status})`);}
      if(!response.ok)throw Error(`HTTP ${response.status}: ${clean(body.error||body.detail||'request failed')}`);
      return body;
    };
    const platform=await api('/api/platform');assert.equal(platform.os,'macos');assert.equal(platform.arch,'aarch64');
    // Match the player's status heartbeat while a slow inference request runs.
    heartbeat=setInterval(()=>{api('/api/status').catch(()=>{});},20000);
    const initial=await api('/api/settings');
    const low={...initial,backend:'cpu',device:null,performance:'low',whisper_model:'tiny',translation_model:null,cpu_threads:2,chunk_seconds:8,buffer_seconds:60};
    const put=async settings=>api('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)});
    const prepare=async(backend,timeout)=>{
      await api('/api/setup',{method:'POST'});
      const deadline=Date.now()+timeout;let previous='';
      while(Date.now()<deadline) {
        const status=await api('/api/status');
        if(status.phase!==previous){previous=status.phase;console.log(`Native ${backend}: ${status.phase}`);}
        if(status.ready){assert.equal(status.backend,backend);return status;}
        if(status.phase==='error')throw Error(clean(status.error||status.detail||'AI initialization failed'));
        if(app.process.exitCode!==null)throw Error('Packaged server exited during model preparation');
        await delay(1500);
      }
      throw Error(`Native ${backend} model preparation exceeded its deadline`);
    };
    const infer=async()=>{
      const session=await api('/api/session',{method:'POST'});activeSession=session.id;
      assert.ok(activeSession);
      try {
        const query=new URLSearchParams({session:activeSession,start:'0',language:'en',target:'繁體中文'});
        const result=await api(`/api/transcribe?${query}`,{method:'POST',headers:{'Content-Type':'audio/wav'},body:wav,timeout:300000});
        assert.ok(Array.isArray(result.segments)&&result.segments.length,'Whisper must produce speech segments from the public sample');
        assert.ok(result.segments.some(segment=>typeof segment.text==='string'&&segment.text.trim()),'Whisper must return non-empty original speech');
        assert.ok(result.segments.some(segment=>typeof segment.translation==='string'&&segment.translation.trim()),'translation must complete, not merely fall back to original speech');
        return {segments:result.segments.length,elapsed_ms:result.elapsed_ms,warnings:result.warnings?.length||0};
      } finally {await api(`/api/session/${encodeURIComponent(activeSession)}`,{method:'DELETE'});activeSession=null;}
    };
    await put(low);
    await prepare('cpu',12*60*1000);
    report.cpu_result=await infer();report.cpu='passed';
    console.log('PASS native CPU: verified Tiny and Qwen 0.5B downloaded, real sample transcribed and translated');

    // Same verified models. Require both engines to use Metal when the runner has a device.
    try {
      const devices=await api('/api/devices');
      const device=devices.devices?.find(item=>/^MTL\d+$/.test(item.id));
      if(!device) {
        report.metal='unavailable';report.metal_detail='Hosted macOS runner exposes no usable Metal device';
        console.log('UNAVAILABLE native Metal: no usable device exposed by the hosted runner');
      } else {
        await put({...low,backend:'metal',device:device.id});
        const ready=await prepare('metal',3*60*1000);
        assert.ok(typeof ready.device==='string'&&ready.device.includes(device.id),'ready status must identify the actually offloaded Metal device');
        assert.match(ready.detail,/Metal 聽寫/);
        const whisperLog=await fs.readFile(path.join(data,'logs','whisper.log'),'utf8');
        assert.match(whisperLog,/whisper_backend_init_gpu: using Metal backend/);
        assert.doesNotMatch(whisperLog,/failed to initialize Metal backend/);
        report.metal_result={device:device.id,...await infer()};report.metal='passed';
        console.log(`PASS native Metal: ${device.id} verified offload and real sample transcription/translation`);
      }
    } catch(error) {
      report.metal='failed';report.metal_detail=clean(error.message);
      console.log(`FAILED native Metal attempt (CPU passed; hosted GPU compatibility is separate): ${report.metal_detail}`);
      requiredFailure=error;
    }
  } catch(error) {
    report.cpu='failed';report.cpu_detail=clean(error.message);requiredFailure=error;
    console.error(`FAIL native CPU inference: ${report.cpu_detail}`);
  } finally {
    clearInterval(heartbeat);
    if(api) {
      if(activeSession)await api(`/api/session/${encodeURIComponent(activeSession)}`,{method:'DELETE'}).catch(()=>{});
      await api('/api/quit',{method:'POST',timeout:5000}).catch(()=>{});
    }
    if(app?.process.exitCode===null) {
      await Promise.race([once(app.process,'exit'),delay(10000)]);
      if(app.process.exitCode===null){app.process.kill('SIGINT');await Promise.race([once(app.process,'exit'),delay(5000)]);}
      if(app.process.exitCode===null)app.process.kill('SIGKILL');
    }
    await saveReport();
    await fs.rm(data,{recursive:true,force:true});
    console.log(`NATIVE_INFERENCE_SUMMARY ${JSON.stringify(report)}`);
  }
  if(requiredFailure)throw requiredFailure;
})().catch(error=>{console.error(clean(error.message));process.exitCode=1;});
