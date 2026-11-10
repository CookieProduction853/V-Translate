const http = require('node:http');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
// Optional developer test dependency: npm install --prefix /tmp/livesub-test playwright
// Then NODE_PATH=/tmp/livesub-test/node_modules node tests/browser-smoke.cjs
// LIVESUB_RECOVER_FIRST_FAIL=1 also verifies recovery after an initial restart failure.
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
(async () => {
const root=path.resolve(__dirname, '../web');
const assetRoot=path.resolve(__dirname, '../assets');
const iconPng=await fs.readFile(path.join(assetRoot,'app-icon.png'));
const iconDimensions={width:iconPng.readUInt32BE(16),height:iconPng.readUInt32BE(20)};
const artifacts=process.env.LIVESUB_TEST_ARTIFACTS || os.tmpdir();
const uploads=[]; let deleted=false; let capturing=false; let sessionCreations=0;let failGpu=false; let runtimePrepared=false;
let settings={backend:'cpu',device:null,performance:'high',whisper_model:'small',translation_model:null,cpu_threads:6,chunk_seconds:5,buffer_seconds:20};
let setupRequests=0;let recoveries=0;let quitRequests=0;let failedAudio=false;const vocabularyImports=[];
const recoverFirstFail=process.env.LIVESUB_RECOVER_FIRST_FAIL==='1';
let engineStatus={ready:true,phase:'ready',detail:'Synthetic browser smoke',progress:1,backend:'cpu',device:null};
const settingChanges=[];
let appearance={theme:'studio',language:'zh-Hant'};let folderOpens=0;let vocabulary={profiles:[],active_id:null,warnings:[]};
const customFilename='viewer-chat-q4_k_m.gguf';
const customModel={id:customFilename,filename:customFilename,name:'Viewer Chat Q4_K_M',size_bytes:1024*1024,architecture:'qwen2',has_chat_template:true};
let translationCatalog={models:[customModel],warnings:[]};let translationScans=0;let translationFolderOpens=0;let failCustomModel=false;
const devices=[{id:'Vulkan0',name:'AMD Radeon Graphics'},{id:'Vulkan1',name:'AMD Radeon RX 9070'},{id:'Vulkan2',name:'NVIDIA GeForce RTX 4070'}];
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
  if(req.headers.authorization!=='Bearer smoke'){res.writeHead(401);res.end('{}');return;}
  res.setHeader('Content-Type','application/json');
  if(url.pathname==='/api/player/presence'){res.end('{}');return;}
  if(url.pathname==='/api/status'){res.end(JSON.stringify(engineStatus));return;}
  if(url.pathname==='/api/ads'){res.end(JSON.stringify(capturing?{ads:[{id:'smoke-ad',image_url:'/ad-assets/smoke-ad',link_url:'https://sponsor.example/smoke'}],state:'ready'}:{ads:[],state:'checking'}));return;}
  if(url.pathname==='/api/quit'&&req.method==='POST'){assert.equal(capturing,false);quitRequests++;res.end('{}');return;}
  if(url.pathname==='/api/appearance'){
   if(req.method==='PUT'){const chunks=[];for await(const c of req)chunks.push(c);const next=JSON.parse(Buffer.concat(chunks).toString());assert.deepEqual(Object.keys(next).sort(),['language','theme']);assert.ok(['studio','light'].includes(next.theme));assert.ok(['zh-Hant','en'].includes(next.language));await new Promise(resolve=>setTimeout(resolve,next.theme==='light'?120:5));appearance=next;}
   res.end(JSON.stringify(appearance));return;
  }
  if(url.pathname==='/api/models/open'){folderOpens++;res.end(JSON.stringify({path:'C:\\Users\\Viewer\\LiveSub\\models',opened:true}));return;}
  if(url.pathname==='/api/translation-models'&&req.method==='GET'){translationScans++;res.end(JSON.stringify(translationCatalog));return;}
  if(url.pathname==='/api/translation-models/open'&&req.method==='POST'){translationFolderOpens++;res.end(JSON.stringify({path:'C:\\Users\\Viewer\\AppData\\Local\\LiveSub\\LiveSub\\data\\models\\translation',opened:true}));return;}
  if(url.pathname==='/api/vocabulary'){res.end(JSON.stringify(vocabulary));return;}
  if(url.pathname==='/api/vocabulary/import'){
   const chunks=[];for await(const c of req)chunks.push(c);const pack=JSON.parse(Buffer.concat(chunks).toString());
   vocabularyImports.push(pack);
   if(pack.format){assert.ok(['csv','tsv','txt'].includes(pack.format));assert.equal(typeof pack.content,'string');assert.ok(pack.name.length<=80);}
   else if(!Array.isArray(pack.terms)||pack.format_version!==1){res.writeHead(400);res.end(JSON.stringify({error:'詞彙包格式不正確'}));return;}
   vocabulary.profiles.push({id:'testprofile',name:pack.name,terms_count:pack.terms?.length||1,language:pack.language||'ja'});res.end(JSON.stringify(vocabulary));return;
  }
  if(url.pathname==='/api/vocabulary/testprofile/export'){
   const format=url.searchParams.get('format');assert.ok(['csv','tsv'].includes(format));
   const content=format==='csv'?'source,target,reading\r\n"星,ルナ","露娜 ""月""",ほしるな\r\n':'source\ttarget\treading\r\n星,ルナ\t露娜 "月"\tほしるな\r\n';
   res.end(JSON.stringify({filename:`quoted.${format}`,content}));return;
  }
  if(url.pathname==='/api/vocabulary/active'){
   if(capturing){res.writeHead(409);res.end(JSON.stringify({error:'請先結束擷取'}));return;}
   const chunks=[];for await(const c of req)chunks.push(c);vocabulary.active_id=JSON.parse(Buffer.concat(chunks).toString()).id;res.end(JSON.stringify(vocabulary));return;
  }
  if(url.pathname==='/api/vocabulary/testprofile'&&req.method==='DELETE'){vocabulary={profiles:[],active_id:null,warnings:[]};res.end(JSON.stringify(vocabulary));return;}

  if(url.pathname==='/api/settings' && req.method==='GET'){res.end(JSON.stringify(settings));return;}
  if(url.pathname==='/api/settings' && req.method==='PUT'){
   if(capturing || ['loading','detecting'].includes(engineStatus.phase)){res.writeHead(409);res.end(JSON.stringify({error:'請先結束擷取或等候目前工作完成'}));return;}
   const chunks=[];for await(const c of req)chunks.push(c);
   settings=JSON.parse(Buffer.concat(chunks).toString());
   assert.deepEqual(Object.keys(settings).sort(),['backend','device','performance','whisper_model','translation_model','cpu_threads','chunk_seconds','buffer_seconds'].sort());
   assert.ok(settings.translation_model===null||translationCatalog.models.some(model=>model.id===settings.translation_model));
   assert.ok(settings.buffer_seconds>=settings.chunk_seconds);settingChanges.push({...settings});
   engineStatus={ready:false,phase:'idle',detail:'設定已儲存',progress:0,backend:settings.backend,device:null};
   res.end(JSON.stringify(settings));return;
  }
  if(url.pathname==='/api/devices'){
   if(req.method==='POST'){
    engineStatus={...engineStatus,ready:false,phase:'detecting'};
    await new Promise(resolve=>setTimeout(resolve,400));runtimePrepared=true;
    engineStatus={...engineStatus,phase:'idle',detail:'顯卡偵測完成，請準備 AI 模型'};
   }
   if(!runtimePrepared){res.writeHead(409);res.end(JSON.stringify({error:'請先偵測顯卡以下載 Vulkan 元件'}));return;}
   res.end(JSON.stringify({devices}));return;
  }
  if(url.pathname==='/api/setup' && req.method==='POST'){
   setupRequests++;engineStatus={...engineStatus,ready:false,phase:'loading',error:null};
   setTimeout(()=>{engineStatus=failCustomModel&&settings.translation_model
    ? {ready:false,phase:'error',backend:settings.backend,device:null,error:`llama.cpp 無法載入自訂翻譯模型 ${settings.translation_model}：架構不支援或記憶體不足`}
    : failGpu&&settings.backend==='vulkan'
    ? {ready:false,phase:'error',backend:'vulkan',device:null,error:'未找到可用的 Vulkan 顯卡'}
    : {ready:true,phase:'ready',detail:'Synthetic browser smoke',progress:1,backend:settings.backend,device:settings.backend==='vulkan'?(devices.find(d=>d.id===settings.device)||devices[0]).name:null};},500);
   res.end(JSON.stringify({accepted:true}));return;
  }
  if(url.pathname==='/api/recover' && req.method==='POST'){
   assert.equal(capturing,true,'recovery must preserve the session');recoveries++;assert.ok(recoveries<=(recoverFirstFail?2:1));
   if(recoverFirstFail&&recoveries===1){engineStatus={...engineStatus,ready:false,phase:'error',error:'Synthetic first recovery failed'};res.writeHead(503);res.end(JSON.stringify({error:'Synthetic first recovery failed'}));return;}
   engineStatus={...engineStatus,ready:false,phase:'loading',error:null};
   setTimeout(()=>{engineStatus={...engineStatus,ready:true,phase:'ready',detail:'Recovered verified engines'};},500);
   res.end(JSON.stringify({accepted:true}));return;
  }
  if(url.pathname==='/api/session' && req.method==='POST'){capturing=true;sessionCreations++;res.end(JSON.stringify({id:'test-session',chunk_seconds:settings.chunk_seconds,buffer_seconds:settings.buffer_seconds}));return;}
  if(url.pathname==='/api/session/test-session' && req.method==='DELETE'){capturing=false;deleted=true;res.end('{}');return;}
  if(url.pathname==='/api/transcribe'){
   const chunks=[];for await(const c of req) chunks.push(c); const wav=Buffer.concat(chunks);const start=Number(url.searchParams.get('start'));
   assert.equal(url.searchParams.get('language'),'ja','interface appearance must not change the capture source language');
   assert.equal(url.searchParams.get('target'),'繁體中文','interface appearance must not change the subtitle translation target');
   assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),16000);assert.equal(wav.length,160044);
   uploads.push({start,length:wav.length});
   if(start===5&&!failedAudio){failedAudio=true;engineStatus={...engineStatus,ready:false,phase:'error',error:'Synthetic AI process stopped'};res.writeHead(500);res.end(JSON.stringify({error:'Synthetic AI process stopped'}));return;}
   if(start===5&&recoverFirstFail&&recoveries<2){res.writeHead(503);res.end(JSON.stringify({error:'Engines still restarting'}));return;}
   if(start===5)await new Promise(resolve=>setTimeout(resolve,13000));
   res.end(JSON.stringify({segments:[{start:start+.1,end:start+4.9,text:`speech ${start}`,translation:start===10?'':`譯文 ${start}`}],warnings:start===10?['翻譯暫時無法完成，已保留原文']:[],elapsed_ms:1}));return;
  }
  res.writeHead(404);res.end('{}');return;
 }
 if(url.pathname==='/manifest.webmanifest'){res.setHeader('Content-Type','application/manifest+json');res.end(JSON.stringify({name:'油字幕 / V-Translate',short_name:'V-Translate',start_url:'/',display:'standalone',icons:[{src:'/app-icon.png',sizes:'any',type:'image/png',purpose:'any'}]}));return;}
 try {
  if(url.pathname==='/ad-assets/smoke-ad'){res.setHeader('Content-Type','image/png');res.end(iconPng);return;}
  if(['/app-icon.png','/favicon.ico'].includes(url.pathname)){
   const png=url.pathname==='/app-icon.png';
   const body=await fs.readFile(path.join(assetRoot,png?'app-icon.png':'app-icon.ico'));
   res.setHeader('Content-Type',png?'image/png':'image/x-icon');res.end(body);return;
  }
  const file=url.pathname==='/'?'index.html':url.pathname.slice(1);const body=await fs.readFile(path.join(root,file));
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(body);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}});
 const setInterfaceLanguage=async(language,{persist=true}={})=>{
  if(persist)await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/appearance')&&response.request().method()==='PUT'&&response.request().postDataJSON().language===language),page.locator('#interface-language').selectOption(language)]);
  else await page.locator('#interface-language').selectOption(language);
  await page.waitForFunction(expected=>document.documentElement.lang===expected,language);
  if(persist)assert.equal(appearance.language,language);
 };
 const prepare=async()=>{const before=setupRequests;await page.locator('#setup').click();await page.locator('#save-and-setup').waitFor({state:'visible'});assert.equal(setupRequests,before,'model choice must happen before setup/download');await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/setup')&&response.request().method()==='POST'),page.locator('#save-and-setup').click()]);};
 const checkSponsorLayout=async()=>{
  const layout=await page.evaluate(()=>{const rect=selector=>document.querySelector(selector).getBoundingClientRect().toJSON();return{slot:rect('#sponsor-slot'),cta:rect('#sponsor-contact'),fans:rect('#fans-ad-contact'),vocabulary:rect('.vocabulary-panel'),player:rect('#player-shell'),controls:rect('.transport'),width:innerWidth,scrollWidth:document.documentElement.scrollWidth};});
  assert.ok(layout.slot.height>=200&&layout.slot.height<=420,'sponsor area must remain a compact banner at every supported width');
  assert.ok(layout.slot.y>=layout.vocabulary.bottom+16,'sponsor area must appear below the vocabulary panel');
  assert.ok(layout.slot.y>=Math.max(layout.player.bottom,layout.controls.bottom)+48,'sponsor area must stay away from playback and capture controls');
  assert.ok(layout.slot.x>=-1&&layout.slot.right<=layout.width+1,'sponsor area must fit the viewport');
  assert.ok(layout.cta.x>=layout.slot.x&&layout.cta.right<=layout.slot.right&&layout.cta.bottom<=layout.slot.bottom,'sponsor contact must remain inside the banner');
  assert.ok(layout.fans.y>=layout.slot.bottom&&layout.fans.x>=-1&&layout.fans.right<=layout.width+1,'persistent advertising email must sit below the banner and fit the viewport');
  assert.ok(layout.scrollWidth<=layout.width+1,'contact and sponsor content must not cause horizontal scrolling');
 };
 const errors=[];const externalRequests=[];page.on('request',request=>{const requestUrl=new URL(request.url());if(['http:','https:'].includes(requestUrl.protocol)&&requestUrl.hostname!=='127.0.0.1')externalRequests.push(request.url());});page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error')console.log('browser console:',msg.text());});
 if(recoverFirstFail)page.on('response',response=>{
  // Advance only the recovery cooldown; audio and MSE clocks still run in real time.
  if(response.url().endsWith('/api/recover')&&response.status()===503)page.evaluate(()=>{const now=Date.now.bind(Date);Date.now=()=>now()+16000;}).catch(()=>{});
 });
 await page.addInitScript(()=>{
  const NativeRecorder=window.MediaRecorder;
  window.MediaRecorder=class extends NativeRecorder{constructor(stream,options){super(stream,options);window.smokeRecorderOptions=options;}};
  navigator.mediaDevices.getDisplayMedia=async constraints=>{
   window.smokeCaptureConstraints=constraints;
   const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const context=canvas.getContext('2d');let n=0;
   const draw=()=>{context.fillStyle=n%2?'#324b76':'#48724d';context.fillRect(0,0,640,360);context.fillStyle='#fff';context.font='40px sans-serif';context.fillText(`SOURCE ${n++}`,60,180);};draw();
   const timer=setInterval(draw,40);const stream=canvas.captureStream(24);const ac=new AudioContext();const osc=ac.createOscillator();const gain=ac.createGain();gain.gain.value=.05;const dest=ac.createMediaStreamDestination();osc.connect(gain).connect(dest);osc.start();await ac.resume();dest.stream.getAudioTracks().forEach(track=>stream.addTrack(track));
   const originalStop=stream.getVideoTracks()[0].stop.bind(stream.getVideoTracks()[0]);stream.getVideoTracks()[0].stop=()=>{clearInterval(timer);ac.close();originalStop();};window.smokeStream=stream;return stream;
  };
 });
 await page.goto(`http://127.0.0.1:${port}/#token=smoke`);
 await page.getByText('本機 AI 已就緒',{exact:true}).waitFor();
 await page.waitForFunction(expected=>{const image=document.getElementById('brand-image');return image.complete&&image.naturalWidth===expected.width&&image.naturalHeight===expected.height;},iconDimensions);
 assert.equal(await page.locator('#brand-image').isVisible(),true,'the supplied PNG must render in the brand');
 assert.equal(await page.locator('#brand-icon-fallback').isHidden(),true,'loaded artwork must replace the fallback symbol');
 const manifestResponse=await page.request.get(`http://127.0.0.1:${port}/manifest.webmanifest`);
 assert.match(manifestResponse.headers()['content-type'],/^application\/manifest\+json/);
 assert.equal((await manifestResponse.json()).icons[0].src,'/app-icon.png');
 assert.ok((await page.title()).includes('油字幕'));
 assert.ok((await page.title()).includes('本地 AI Vtuber 即時字幕'));
 assert.ok((await page.title()).includes('v0.5.5'));
 assert.equal(await page.locator('#app-version').textContent(),'v0.5.5');
 assert.equal(await page.locator('#app-version').isVisible(),true);
 assert.equal(await page.locator('#contact-email').getAttribute('href'),'mailto:vtranslate853@gmail.com');
 assert.equal(await page.locator('#sponsor-contact').getAttribute('href'),'mailto:vtranslate853@gmail.com');
 assert.equal(await page.locator('#fans-ad-email').getAttribute('href'),'mailto:vtranslate853@gmail.com');
 assert.equal(await page.locator('#interface-language-label').textContent(),'介面語言 (Language)');
 assert.equal(await page.locator('#instagram-link').getAttribute('href'),'https://www.instagram.com/cookie_production/');
 assert.equal(await page.locator('#instagram-link').getAttribute('target'),'_blank');
 assert.match(await page.locator('#instagram-link').getAttribute('rel'),/\bnoopener\b/);assert.match(await page.locator('#instagram-link').getAttribute('rel'),/\bnoreferrer\b/);
 assert.ok((await page.locator('footer.app-footer').textContent()).includes('歡迎聯絡及提出用戶要求'));
 assert.ok((await page.locator('footer.app-footer').textContent()).includes('Power by 曲奇 @Cookie Production'));
 assert.equal(await page.locator('#sponsor-title').textContent(),'一起支持跨語言的觀看體驗。');
 assert.equal(await page.getByLabel('CPU／顯卡選擇').isVisible(),true);
 assert.equal(await page.locator('#backend').inputValue(),'cpu');
 assert.equal(await page.locator('#capture-quality').inputValue(),'1080p');
 await page.locator('#capture-quality').selectOption('1440p');
 assert.equal(await page.locator('#language').evaluate(element=>!!(element.compareDocumentPosition(document.getElementById('backend'))&Node.DOCUMENT_POSITION_FOLLOWING)),true,'stream language must appear before AI compute settings');
 assert.equal(await page.locator('#target').evaluate(element=>!!(element.compareDocumentPosition(document.getElementById('translation-model'))&Node.DOCUMENT_POSITION_FOLLOWING)),true,'subtitle language must appear before model selection');
 await page.waitForFunction(()=>!document.getElementById('translation-model').disabled);
 assert.equal(await page.locator('#translation-model').inputValue(),'');
 assert.equal(await page.locator('#translation-model option').count(),2);
 const library=page.locator('.model-library-link');
 assert.equal(await library.getAttribute('href'),'https://ollama.com/search?q=translate');
 assert.equal(await library.getAttribute('target'),'_blank');
 assert.match(await library.getAttribute('rel'),/noopener/);
 assert.match(await library.getAttribute('rel'),/noreferrer/);
 assert.equal(await page.locator('#interface-language').inputValue(),'zh-Hant');
 assert.equal(await page.locator('#delay').inputValue(),'20');
 assert.equal(await page.locator('#delay-value').textContent(),'20');
 assert.equal(await page.locator('.intro').count(),0);
 assert.equal(await page.locator('[data-theme-choice]').count(),2);
 assert.equal(await page.locator('[data-theme-choice="cinema"]').count(),0);
 assert.equal(await page.locator('.theme-options .engine-status').count(),1);
 await page.locator('#model-settings').click();
 assert.equal(await page.locator('#performance').inputValue(),'high');
 assert.equal(await page.locator('#whisper-model').inputValue(),'small');
 assert.equal(await page.locator('#cpu-threads').inputValue(),'6');
 assert.equal(await page.locator('#chunk-seconds').inputValue(),'5');
 assert.equal(await page.locator('#buffer-seconds').inputValue(),'20');
 const chinesePreset=await page.locator('#preset-detail').textContent();
 await setInterfaceLanguage('en');
 assert.ok((await page.title()).includes('V-Translate'));
 assert.ok((await page.title()).includes('Real time local AI translator for Vtuber viewers'));
 assert.equal(await page.locator('#performance').inputValue(),'high');
 assert.notEqual(await page.locator('#preset-detail').textContent(),chinesePreset,'open settings must relocalize without losing selected preset');
 await page.locator('#close-model-settings').click();
 assert.match(await page.locator('#engine-title').textContent(),/ready/i,'dynamic engine status must switch to English');
 assert.match(await page.locator('#start').textContent(),/tab/i,'static capture button must switch to English');
 assert.equal(await page.locator('#interface-language-label').textContent(),'Interface language');
 assert.match(await page.locator('footer.app-footer').textContent(),/Get in touch with questions and feature requests/);
 assert.match(await page.locator('footer.app-footer').textContent(),/Power by Cookie @Cookie Production/);
 assert.equal(await page.locator('#sponsor-title').textContent(),'Support a viewing experience across languages.');
 await page.screenshot({path:path.join(artifacts,'vtranslate-english.png'),fullPage:true});
 await page.locator('#language').selectOption('ko');
 await page.locator('#target').selectOption('日本語');
 await setInterfaceLanguage('zh-Hant');
 assert.equal(await page.locator('#language').inputValue(),'ko');
 assert.equal(await page.locator('#target').inputValue(),'日本語');
 assert.ok((await page.locator('footer.app-footer').textContent()).includes('歡迎聯絡及提出用戶要求'));
 assert.equal(await page.locator('#sponsor-title').textContent(),'一起支持跨語言的觀看體驗。');
 await setInterfaceLanguage('en');
 assert.equal(await page.locator('#language').inputValue(),'ko');
 assert.equal(await page.locator('#target').inputValue(),'日本語');
 await page.waitForFunction(()=>!document.getElementById('import-vocabulary').disabled);
 const stopBox=await page.locator('#stop').boundingBox();const quitBox=await page.locator('#quit').boundingBox();
 assert.ok(quitBox.y>=stopBox.y+stopBox.height,'quit should sit directly below stop capture');
 assert.ok(quitBox.height>=stopBox.height,'quit must remain a prominent action');
 assert.equal(await page.locator('#quit').count(),1);
 for(const theme of ['studio','light']){
  await page.locator(`[data-theme-choice="${theme}"]`).click();
  await page.waitForFunction(expected=>document.documentElement.dataset.theme===expected,theme);
  await page.waitForTimeout(150);
  assert.equal(appearance.theme,theme);
  assert.equal(appearance.language,'en','theme changes must preserve the interface language');
  assert.equal(await page.locator('#interface-language').inputValue(),'en');
  assert.equal(await page.locator('#language').inputValue(),'ko');
  assert.equal(await page.locator('#target').inputValue(),'日本語');
  await page.screenshot({path:path.join(artifacts,`livesub-theme-${theme}.png`),fullPage:true});
  await page.locator('footer.app-footer').screenshot({path:path.join(artifacts,`vtranslate-footer-${theme}.png`)});
  for(const width of [1440,1024,640,390]){await page.setViewportSize({width,height:1100});await checkSponsorLayout();}
  await page.locator('#sponsor-slot').screenshot({path:path.join(artifacts,`vtranslate-sponsor-mobile-${theme}.png`)});
  await page.setViewportSize({width:1440,height:1100});
 }
 await page.evaluate(()=>{document.querySelector('[data-theme-choice="studio"]').click();document.querySelector('[data-theme-choice="light"]').click();document.querySelector('[data-theme-choice="studio"]').click();});
 await page.waitForTimeout(400);assert.deepEqual(appearance,{theme:'studio',language:'en'});
 await page.reload();
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='studio'&&document.documentElement.lang==='en'&&/ready/i.test(document.getElementById('engine-title').textContent));
 assert.equal(await page.locator('#interface-language').inputValue(),'en','saved interface language must survive reopening');
 await setInterfaceLanguage('zh-Hant');
 await page.getByText('本機 AI 已就緒',{exact:true}).waitFor();
 await page.locator('#open-models').click();await page.waitForFunction(()=>!document.getElementById('model-location').hidden);
 assert.equal(folderOpens,1);assert.ok((await page.locator('#model-path').textContent()).includes('models'));
 const exampleDownload=page.waitForEvent('download');await page.locator('#example-vocabulary').click();
 const example=await exampleDownload;const pack=JSON.parse(await fs.readFile(await example.path(),'utf8'));
 assert.equal(pack.format_version,1);assert.ok(pack.terms.length>0);
 await page.locator('#vocabulary-file').setInputFiles({name:'vtuber.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pack))});
 await page.waitForFunction(()=>document.getElementById('vocabulary-select').options.length===2&&!document.getElementById('vocabulary-select').disabled);
 assert.deepEqual(vocabularyImports[0],pack,'native JSON retains its original import shape');
 await page.locator('#vocabulary-select').selectOption('testprofile');
 await page.waitForFunction(()=>document.getElementById('vocabulary-detail').textContent.includes('使用中'));
 assert.equal(vocabulary.active_id,'testprofile');
 await setInterfaceLanguage('en');
 assert.match(await page.locator('#vocabulary-detail').textContent(),/active|in use/i);
 assert.equal(await page.locator('#vocabulary-select').inputValue(),'testprofile');
 await setInterfaceLanguage('zh-Hant');
 assert.ok((await page.locator('#vocabulary-detail').textContent()).includes('使用中'));
 await page.locator('#vocabulary-file').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{broken')});
 await page.waitForFunction(()=>document.getElementById('message').textContent.includes('不是有效的 JSON'));
 assert.equal(vocabulary.profiles.length,1);
 await setInterfaceLanguage('en');
 assert.match(await page.locator('#message').textContent(),/not valid JSON|invalid.*JSON|JSON.*invalid/i);
 await setInterfaceLanguage('zh-Hant');
 assert.ok((await page.locator('#message').textContent()).includes('不是有效的 JSON'));
 await page.locator('#remove-vocabulary').click();
 await page.waitForFunction(()=>document.getElementById('vocabulary-select').options.length===1);
 assert.equal(vocabulary.profiles.length,0);assert.equal(vocabulary.active_id,null);

 const csv='source,target,reading\r\n"星,ルナ","露娜 ""月""",ほしるな\r\n';
 await page.locator('#vocabulary-file').setInputFiles({name:'quoted.csv',mimeType:'text/csv',buffer:Buffer.from('\ufeff'+csv)});
 await page.waitForFunction(()=>document.getElementById('vocabulary-select').options.length===2&&!document.getElementById('vocabulary-select').disabled);
 assert.deepEqual(vocabularyImports.at(-1),{format:'csv',name:'quoted',content:csv});
 await page.locator('#vocabulary-select').selectOption('testprofile');
 await page.waitForFunction(()=>!document.getElementById('export-vocabulary-csv').disabled);
 for(const format of ['csv','tsv']){
  const nextDownload=page.waitForEvent('download');await page.locator(`#export-vocabulary-${format}`).click();const exported=await nextDownload;
  assert.equal(exported.suggestedFilename(),`quoted.${format}`);
  const content=(await fs.readFile(await exported.path(),'utf8')).replace(/^\ufeff/,'');
  assert.ok(content.includes('星,ルナ'));assert.ok(content.includes(format==='csv'?'"露娜 ""月"""':'露娜 "月"'));
 }
 await page.locator('#remove-vocabulary').click();await page.waitForFunction(()=>document.getElementById('vocabulary-select').options.length===1);
 for(const [format,content] of [['tsv','source\ttarget\n星見\t露娜\n'],['txt','星見ルナ\nおつルナ\n']]){
  await page.locator('#vocabulary-file').setInputFiles({name:`terms.${format}`,mimeType:'text/plain',buffer:Buffer.from(content)});
  await page.waitForFunction(()=>document.getElementById('vocabulary-select').options.length===2&&!document.getElementById('vocabulary-select').disabled);
  assert.deepEqual(vocabularyImports.at(-1),{format,name:'terms',content});
  await page.locator('#vocabulary-select').selectOption('testprofile');await page.waitForFunction(()=>!document.getElementById('remove-vocabulary').disabled);
  await page.locator('#remove-vocabulary').click();await page.waitForFunction(()=>document.getElementById('vocabulary-select').options.length===1);
 }
 const importsBeforeModel=vocabularyImports.length;
 await page.locator('#vocabulary-file').setInputFiles({name:'translation.gguf',mimeType:'application/octet-stream',buffer:Buffer.from('GGUF')});
 await page.waitForFunction(()=>document.getElementById('message').textContent.includes('模型權重'));
 assert.equal(vocabularyImports.length,importsBeforeModel,'model weights must not be sent to the vocabulary importer');

 await page.locator('#model-settings').click();
 await page.locator('#performance').selectOption('low');
 assert.equal(await page.locator('#whisper-model').inputValue(),'tiny');
 assert.equal(await page.locator('#cpu-threads').inputValue(),'2');
 assert.equal(await page.locator('#chunk-seconds').inputValue(),'8');
 assert.equal(await page.locator('#buffer-seconds').inputValue(),'60');
 await page.screenshot({path:path.join(artifacts,'livesub-low-config.png'),fullPage:true});
 const setupBeforeSave=setupRequests;
 await page.locator('#save-model-settings').click();
 await page.waitForFunction(()=>!document.getElementById('setup').disabled);
 assert.equal(setupRequests,setupBeforeSave);
 assert.deepEqual(settings,{backend:'cpu',device:null,performance:'low',whisper_model:'tiny',translation_model:null,cpu_threads:2,chunk_seconds:8,buffer_seconds:60});
 assert.equal(await page.locator('#capture-quality').inputValue(),'1440p','AI presets must retain an explicit capture quality choice');

 await page.locator('#backend').selectOption('vulkan');
 await page.waitForFunction(()=>document.getElementById('backend').value==='vulkan'&&!document.getElementById('setup').disabled);
 assert.equal(settings.backend,'vulkan');assert.equal(settings.device,null);
 await page.locator('#detect-gpu').click();
 assert.equal(await page.locator('#backend').isDisabled(),true);
 await page.waitForFunction(()=>document.getElementById('gpu-device').options.length===4&&!document.getElementById('gpu-device').disabled);
 await page.locator('#gpu-device').selectOption('Vulkan1');
 await page.waitForFunction(()=>!document.getElementById('setup').disabled&&!document.getElementById('gpu-device').disabled);
 assert.equal(settings.device,'Vulkan1');
 await page.locator('#model-settings').click();await page.locator('#performance').selectOption('high');await page.locator('#save-model-settings').click();
 await page.waitForFunction(()=>!document.getElementById('setup').disabled);
 assert.deepEqual(settings,{backend:'vulkan',device:'Vulkan1',performance:'high',whisper_model:'small',translation_model:null,cpu_threads:6,chunk_seconds:5,buffer_seconds:20});
 await prepare();
 assert.equal(await page.locator('#backend').isDisabled(),true);
 await page.getByText('本機 AI 已就緒',{exact:true}).waitFor();
 assert.ok((await page.locator('#engine-detail').textContent()).includes('AMD Radeon RX 9070'));
 assert.ok((await page.locator('#compute-badge').textContent()).includes('GPU'));
 await page.screenshot({path:path.join(artifacts, 'livesub-player-gpu-settings.png'),fullPage:true});
 await page.locator('#gpu-device').selectOption('Vulkan2');
 await page.waitForFunction(()=>!document.getElementById('setup').disabled&&!document.getElementById('gpu-device').disabled);
 assert.equal(settings.device,'Vulkan2');
 await prepare();await page.getByText('本機 AI 已就緒',{exact:true}).waitFor();
 assert.ok((await page.locator('#engine-detail').textContent()).includes('NVIDIA GeForce RTX 4070'));
 assert.ok((await page.locator('#compute-badge').textContent()).includes('GPU'));
 // Custom translation choice is independent of compute, languages and manual settings.
 await page.locator('#language').selectOption('ko');await page.locator('#target').selectOption('日本語');
 const beforeCustom={...settings};
 await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/settings')&&response.request().method()==='PUT'),page.locator('#translation-model').selectOption(customFilename)]);
 await page.waitForFunction(()=>!document.getElementById('model-settings').disabled);
 assert.deepEqual(settings,{...beforeCustom,translation_model:customFilename});
 assert.equal(await page.locator('#language').inputValue(),'ko');assert.equal(await page.locator('#target').inputValue(),'日本語');
 await page.locator('#open-translation-models').click();
 await page.locator('#translation-model-path').waitFor({state:'visible'});
 assert.equal(translationFolderOpens,1);assert.ok((await page.locator('#translation-model-path').textContent()).endsWith('models\\translation'));
 await page.locator('#model-settings').click();
 await page.locator('#performance').selectOption('low');
 await page.locator('#advanced-settings > summary').click();
 await page.locator('#whisper-model').selectOption('base');await page.locator('#cpu-threads').fill('4');
 await page.locator('#chunk-seconds').fill('7');await page.locator('#buffer-seconds').fill('42');
 assert.ok((await page.locator('#preset-detail').textContent()).includes(customFilename));
 const scansBeforeDraft=translationScans;
 await page.locator('#refresh-translation-models').evaluate(button=>button.click());
 await page.waitForFunction(expected=>!document.getElementById('refresh-translation-models').disabled&&document.getElementById('translation-model').value===expected,customFilename);
 assert.ok(translationScans>scansBeforeDraft);
 await page.locator('#interface-language').evaluate(select=>{select.value='en';select.dispatchEvent(new Event('change'));});
 await page.waitForFunction(()=>document.documentElement.lang==='en');
 assert.equal(await page.locator('#performance').inputValue(),'low');assert.equal(await page.locator('#whisper-model').inputValue(),'base');
 assert.equal(await page.locator('#cpu-threads').inputValue(),'4');assert.equal(await page.locator('#chunk-seconds').inputValue(),'7');assert.equal(await page.locator('#buffer-seconds').inputValue(),'42');
 assert.equal(await page.locator('#translation-model').inputValue(),customFilename);
 await page.locator('#save-model-settings').click();await page.waitForFunction(()=>!document.getElementById('setup').disabled);
 const customManual={backend:'vulkan',device:'Vulkan2',performance:'low',whisper_model:'base',translation_model:customFilename,cpu_threads:4,chunk_seconds:7,buffer_seconds:42};
 assert.deepEqual(settings,customManual);
 await setInterfaceLanguage('zh-Hant');
 translationCatalog={models:[],warnings:['broken.gguf：GGUF 標頭不正確']};
 await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/translation-models')),page.locator('#refresh-translation-models').click()]);
 await page.waitForFunction(()=>document.getElementById('translation-model-detail').textContent.includes('找不到'));
 assert.equal(await page.locator('#translation-model').inputValue(),customFilename);
 assert.deepEqual(settings,customManual,'missing selected files must not silently switch to built-in Qwen');
 assert.equal(await page.locator('#start').isDisabled(),true);
 assert.ok((await page.locator('#translation-model-detail').textContent()).includes('broken.gguf'));
 await setInterfaceLanguage('en');assert.equal(await page.locator('#translation-model').inputValue(),customFilename);
 await setInterfaceLanguage('zh-Hant');
 translationCatalog={models:[customModel],warnings:[]};
 await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/translation-models')),page.locator('#refresh-translation-models').click()]);
 await page.waitForFunction(()=>!document.getElementById('translation-model').disabled);
 await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/settings')&&response.request().method()==='PUT'),page.locator('#translation-model').selectOption('')]);
 await page.waitForFunction(()=>!document.getElementById('translation-model').disabled);
 assert.deepEqual(settings,{...customManual,translation_model:null},'explicit built-in choice must retain manual compute settings');
 await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/settings')&&response.request().method()==='PUT'),page.locator('#translation-model').selectOption(customFilename)]);
 await page.waitForFunction(()=>!document.getElementById('model-settings').disabled);
 await page.locator('#model-settings').click();await page.locator('#performance').selectOption('high');await page.locator('#save-model-settings').click();
 await page.waitForFunction(()=>!document.getElementById('setup').disabled);
 assert.equal(settings.translation_model,customFilename,'changing performance must retain the custom translation model');
 assert.equal(settings.backend,'vulkan');assert.equal(settings.device,'Vulkan2');
 failCustomModel=true;await prepare();await page.getByText('AI 準備失敗',{exact:true}).waitFor();
 assert.ok((await page.locator('#engine-detail').textContent()).includes(customFilename));
 assert.equal(settings.translation_model,customFilename);assert.equal(await page.locator('#translation-model').inputValue(),customFilename);
 assert.equal(await page.locator('#translation-model').isDisabled(),false);
 failCustomModel=false;await prepare();await page.getByText('本機 AI 已就緒',{exact:true}).waitFor();
 await page.locator('#language').selectOption('ja');await page.locator('#target').selectOption('繁體中文');
 // A failed Vulkan startup must leave the UI usable for an explicit CPU retry.
 await page.locator('#backend').selectOption('cpu');
 await page.waitForFunction(()=>!document.getElementById('setup').disabled);
 assert.equal(settings.device,null);
 await prepare();await page.getByText('本機 AI 已就緒',{exact:true}).waitFor();
 failGpu=true;
 await page.locator('#backend').selectOption('vulkan');await page.waitForFunction(()=>!document.getElementById('setup').disabled);
 await prepare();await page.getByText('AI 準備失敗',{exact:true}).waitFor();
 assert.ok((await page.locator('#engine-detail').textContent()).includes('可選 CPU'));
 assert.ok(!(await page.locator('#compute-badge').textContent()).includes('● GPU'));
 assert.equal(await page.locator('#backend').isDisabled(),false);
 await page.locator('#backend').selectOption('cpu');await page.waitForFunction(()=>!document.getElementById('setup').disabled);
 await prepare();await page.getByText('本機 AI 已就緒',{exact:true}).waitFor();
 assert.ok((await page.locator('#compute-badge').textContent()).includes('CPU'));
 await page.screenshot({path:path.join(artifacts, 'livesub-player-before.png'),fullPage:true});
 await page.reload();await page.getByText('本機 AI 已就緒',{exact:true}).waitFor();
 assert.equal(await page.locator('#capture-quality').inputValue(),'1440p','capture quality must survive reopening the player');
 await page.locator('#delay').evaluate(el=>{el.value='10';el.dispatchEvent(new Event('input'));});
 await page.locator('#start').click();
 await page.waitForFunction(()=>!document.getElementById('stop').disabled);
 const originalSource=await page.locator('#video').evaluate(v=>v.src);
 await page.locator('#sponsor-image-link').evaluate(link=>{window.smokeDisplayedAds=0;new MutationObserver(()=>{if(!link.hidden)window.smokeDisplayedAds++;}).observe(link,{attributes:true,attributeFilter:['hidden']});});
 const capture=await page.evaluate(()=>({constraints:window.smokeCaptureConstraints,options:window.smokeRecorderOptions,contentHint:window.smokeStream.getVideoTracks()[0].contentHint}));
 assert.equal(capture.constraints.video.width.ideal,2560);assert.equal(capture.constraints.video.height.ideal,1440);
 assert.equal(capture.constraints.video.frameRate.ideal,30);assert.equal(capture.options.videoBitsPerSecond,14000000);
 assert.equal(capture.contentHint,'detail');assert.equal(await page.locator('#capture-quality').isDisabled(),true);
 assert.match(await page.locator('#capture-quality-detail').textContent(),/640\s*[×x]\s*360/,'actual source resolution must be displayed without claiming the requested upscale');
 assert.equal(await page.locator('#backend').isDisabled(),true);assert.equal(await page.locator('#gpu-device').isDisabled(),true);assert.equal(await page.locator('#vocabulary-select').isDisabled(),true);assert.equal(await page.locator('#import-vocabulary').isDisabled(),true);
 assert.equal(await page.locator('#translation-model').isDisabled(),true);assert.equal(await page.locator('#refresh-translation-models').isDisabled(),true);
 assert.equal(settings.translation_model,customFilename);
 await page.waitForFunction(()=>document.getElementById('video').currentTime>1,null,{timeout:25000});
 const snapshot=await page.evaluate(()=>({time:document.getElementById('video').currentTime,end:document.getElementById('video').buffered.end(0),caption:document.getElementById('translated').textContent,status:document.getElementById('playback-label').textContent}));
 assert.ok(snapshot.time>1&&snapshot.end-snapshot.time>=8);assert.equal(snapshot.caption,'譯文 0');assert.equal(snapshot.status,'同步播放中');assert.ok(uploads.length>=2);
 await page.screenshot({path:path.join(artifacts, 'livesub-player-capture.png'),fullPage:true});
 const beforeContact=await page.locator('#video').evaluate(video=>video.currentTime);
 await page.locator('#sponsor-contact').focus();await page.locator('footer.app-footer').scrollIntoViewIfNeeded();
 await page.waitForFunction(time=>document.getElementById('video').currentTime>time+.1,beforeContact);
 assert.equal(await page.locator('#video').evaluate(video=>video.src),originalSource,'viewing sponsor/contact content must preserve captured playback');
 assert.equal(await page.evaluate(()=>window.smokeStream.getTracks().every(track=>track.readyState==='live')),true);
 assert.equal(capturing,true);assert.equal(deleted,false);await page.locator('#player-shell').scrollIntoViewIfNeeded();
 await page.locator('#pause').click();const paused=await page.locator('#video').evaluate(v=>v.currentTime);await page.waitForTimeout(600);assert.ok(Math.abs(await page.locator('#video').evaluate(v=>v.currentTime)-paused)<.1);
 const translatedBeforeLanguage=await page.locator('#translated').textContent();
 await setInterfaceLanguage('en');
 assert.match(await page.locator('#playback-label').textContent(),/paused/i);
 assert.match(await page.locator('#pause').textContent(),/resume|play/i);
 assert.match(await page.locator('#live-delay').textContent(),/second|sec|behind|delay/i);
 await page.locator('[data-theme-choice="light"]').click();
 await page.waitForTimeout(150);
 assert.equal(appearance.language,'en');
 assert.equal(await page.locator('#interface-language').inputValue(),'en');
 assert.equal(await page.locator('#video').evaluate(v=>v.src),originalSource,'appearance changes must preserve the captured video source');
 assert.ok(Math.abs(await page.locator('#video').evaluate(v=>v.currentTime)-paused)<.1,'appearance changes must preserve paused playback');
 assert.equal(await page.evaluate(()=>window.smokeStream.getTracks().every(t=>t.readyState==='live')),true);
 assert.equal(await page.locator('#translated').textContent(),translatedBeforeLanguage,'UI language must preserve subtitle content');
 assert.equal(await page.locator('#language').inputValue(),'ja');
 assert.equal(await page.locator('#target').inputValue(),'繁體中文');
 assert.equal(deleted,false);
 assert.equal(capturing,true);
 await setInterfaceLanguage('zh-Hant');
 await page.locator('#pause').click();
 await page.waitForFunction(()=>document.getElementById('playback-label').textContent==='等待字幕', null, {timeout:15000});
 const waiting=await page.locator('#video').evaluate(v=>v.currentTime);
 assert.ok(waiting >= 4 && waiting < 5);
 await page.waitForTimeout(700);assert.ok(Math.abs(await page.locator('#video').evaluate(v=>v.currentTime)-waiting)<.1);
 const sourceBeforeRecovery=await page.locator('#video').evaluate(v=>v.src);
 assert.equal(sourceBeforeRecovery,originalSource);
 assert.equal(await page.evaluate(()=>window.smokeStream.getTracks().every(t=>t.readyState==='live')),true);
 assert.equal(await page.locator('#stop').isDisabled(),false);
 await page.locator('#wait-subtitles').uncheck();
 await page.waitForFunction(()=>document.getElementById('video').currentTime>5.5,null,{timeout:10000});
 assert.equal(await page.locator('#video').evaluate(v=>v.src),sourceBeforeRecovery);
 assert.equal(await page.evaluate(()=>window.smokeStream.getTracks().every(t=>t.readyState==='live')),true);
 await page.locator('#wait-subtitles').check();
 await page.waitForFunction(()=>document.getElementById('translated').textContent==='譯文 5',null,{timeout:25000});
 assert.equal(recoveries,recoverFirstFail?2:1);
 assert.ok(await page.evaluate(()=>window.smokeDisplayedAds>0),'image ads must rotate during capture without replacing the live player');
 assert.equal(sessionCreations,1,'ad rotation must not recreate the server capture session');
 assert.equal(settings.translation_model,customFilename,'automatic AI recovery must retain the selected custom model');
 const retried=uploads.filter(item=>item.start===5);assert.ok(retried.length>=2);
 if(!recoverFirstFail)assert.equal(retried.length,2);
 assert.equal(deleted,false,'AI errors must not delete the capture session');assert.equal(capturing,true);
 assert.equal(await page.locator('#video').evaluate(v=>v.src),sourceBeforeRecovery);
 await page.waitForFunction(()=>document.getElementById('video').currentTime>5.5,null,{timeout:20000});
 assert.equal(await page.locator('#translated').textContent(),'譯文 5');
 await page.locator('#show-original').uncheck();
 await page.waitForFunction(()=>document.getElementById('video').currentTime>10.5,null,{timeout:15000});
 assert.equal(await page.locator('#translated').textContent(),'speech 10');
 assert.equal(await page.locator('#original').textContent(),'');
 assert.ok((await page.locator('#message').textContent()).includes('翻譯暫時無法完成'));
 await page.locator('#show-original').check();
 await page.waitForFunction(()=>document.getElementById('subtitles').textContent.split('speech 10').length===2);
 assert.ok((await page.locator('#transcript').textContent()).includes('speech 10'));
 const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();const download=await downloadPromise;const srt=await fs.readFile(await download.path(),'utf8');assert.ok(srt.includes('speech 0'));assert.ok(srt.includes('00:00:00,100 --> 00:00:04,900'));
 await page.locator('#stop').click();await page.waitForFunction(()=>document.getElementById('stop').disabled);assert.equal(deleted,true);assert.equal(await page.evaluate(()=>window.smokeStream.getTracks().every(t=>t.readyState==='ended')),true);
 await setInterfaceLanguage('en');
 assert.match(await page.locator('#live-delay').textContent(),/capture ended/i,'stopped session labels must remain safe to relocalize');
 assert.equal(await page.locator('#stop').isDisabled(),true);
 assert.equal(await page.locator('#video').evaluate(v=>v.getAttribute('src')),null);
 await setInterfaceLanguage('zh-Hant');
 assert.equal(await page.locator('#live-delay').textContent(),'擷取已結束');
 await page.locator('#quit').click();
 await page.getByText('本機程式已關閉',{exact:true}).waitFor();
 assert.equal(quitRequests,1);
 await setInterfaceLanguage('en',{persist:false});
 assert.match(await page.locator('#engine-title').textContent(),/local app has closed/i);
 assert.match(await page.locator('#message').textContent(),/local app has closed/i);
 assert.equal(await page.locator('#start').isDisabled(),true);
 await setInterfaceLanguage('zh-Hant',{persist:false});
 assert.equal(await page.locator('#engine-title').textContent(),'本機程式已關閉');
 assert.equal(quitRequests,1);
 assert.deepEqual(errors,[]);
 assert.deepEqual(externalRequests,[],'the sponsor placeholder must not load an external ad or tracking service');
 console.log(JSON.stringify({result:'PASS',recoverFirstFail,settingChanges,setupRequests,recoveries,uploads,snapshot,deleted,screenshots:[path.join(artifacts, 'livesub-player-before.png'),path.join(artifacts, 'livesub-player-capture.png')]}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});
