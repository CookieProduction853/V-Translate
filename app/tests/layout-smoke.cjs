// User-flow regression for the compact header, Settings and transcript view.
// Real browser media recording/MSE; API inference uses local fixtures only.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
(async () => {
  const root = path.resolve(__dirname, '..');
  const image = await fs.readFile(path.join(root, 'assets/app-icon.png'));
  let appearance = {theme: 'studio', language: 'zh-Hant'};
  const settings = {backend:'cpu',device:null,performance:'high',whisper_model:'small',translation_model:null,cpu_threads:6,chunk_seconds:5,buffer_seconds:20};
  const ads = Array.from({length:10}, (_, i) => ({id:`layout${i}`,image_url:`/ad-assets/layout${i}`,link_url:`https://sponsor.example/layout${i}`}));
  const errors = [], external = [], mutations = [], presence = [];
  let aiReady=true,aiPhase='ready';
  let created = 0, deleted = 0, audio = 0, heartbeats = 0, idlePaused = false, restartFails = false;
  const read = async req => {const chunks=[];for await(const chunk of req)chunks.push(chunk);return Buffer.concat(chunks);};
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        assert.equal(req.headers.authorization, 'Bearer layout');
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') mutations.push(`${req.method} ${url.pathname}`);
        if (url.pathname === '/api/player/presence') {presence.push(JSON.parse(await read(req)));return res.end('{}');}
        if (url.pathname === '/api/status') return res.end(JSON.stringify({ready:aiReady&&!idlePaused,phase:idlePaused?'paused':aiPhase,backend:'cpu',device:null,detail:'Local layout fixture',progress:1}));
        if (url.pathname === '/api/setup') { if (restartFails) {res.writeHead(500);return res.end(JSON.stringify({error:'Restart failed'}));} idlePaused=false;return res.end('{}'); }
        if (url.pathname === '/api/player/open') {assert.ok(['chrome','edge'].includes(JSON.parse(await read(req)).browser));return res.end(JSON.stringify({opened:true}));}
        if (url.pathname === '/api/settings') return res.end(JSON.stringify(settings));
        if (url.pathname === '/api/appearance') {
          if (req.method === 'PUT') appearance = JSON.parse(await read(req));
          return res.end(JSON.stringify(appearance));
        }
        if (url.pathname === '/api/ads') return res.end(JSON.stringify({state:'ready',ads}));
        if (url.pathname === '/api/vocabulary') return res.end(JSON.stringify({profiles:[],active_id:null,warnings:[]}));
        if (url.pathname === '/api/translation-models') return res.end(JSON.stringify({models:[],warnings:[]}));
        if (url.pathname === '/api/models/open') return res.end(JSON.stringify({path:'C:\\Users\\Viewer\\models',opened:true}));
        if (url.pathname === '/api/session' && req.method === 'POST') {created++;return res.end(JSON.stringify({id:'layout-session',chunk_seconds:5,buffer_seconds:20}));}
        if (url.pathname === '/api/session/layout-session' && req.method === 'POST') {heartbeats++;return res.end('{}');}
        if (url.pathname === '/api/session/layout-session' && req.method === 'DELETE') {deleted++;return res.end('{}');}
        if (url.pathname === '/api/transcribe') {
          const wav = await read(req);assert.equal(wav.toString('ascii',0,4),'RIFF');audio++;
          const start=Number(url.searchParams.get('start'));
          return res.end(JSON.stringify({segments:[{start:start+.1,end:start+4.9,text:`speech ${start}`,translation:`字幕 ${start}`}],warnings:[],elapsed_ms:1}));
        }
        res.writeHead(404);return res.end('{}');
      }
      if (url.pathname.startsWith('/ad-assets/')) {res.setHeader('Content-Type','image/png');return res.end(image);}
      if (url.pathname === '/manifest.webmanifest') {res.setHeader('Content-Type','application/manifest+json');return res.end(JSON.stringify({name:'V-Translate',icons:[{src:'/app-icon.png',sizes:'any',type:'image/png'}]}));}
      const file = url.pathname === '/ui-performance.png' ? 'assets/Icon_performance.png' : url.pathname === '/ui-language.png' ? 'assets/Icon_language.png' : url.pathname === '/' ? 'web/index.html' : url.pathname === '/app-icon.png' ? 'assets/app-icon.png' : url.pathname === '/favicon.ico' ? 'assets/app-icon.ico' : `web${url.pathname}`;
      const bytes = await fs.readFile(path.join(root, file));
      res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':file.endsWith('.ico')?'image/x-icon':'text/html');res.end(bytes);
    } catch (error) {errors.push(error.stack);res.writeHead(500);res.end('{}');}
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
    page.on('pageerror',error=>errors.push(error.stack));
    page.on('request',request=>{const url=new URL(request.url());if(['https:','http:'].includes(url.protocol)&&url.origin!==origin)external.push(request.url());});
    await page.addInitScript(() => {
      const interval = window.setInterval.bind(window);
      window.layoutIntervals=[];
      window.setInterval=(callback,delay,...args)=>{window.layoutIntervals.push(delay);return interval(callback,delay===10000?1800:delay,...args);};
      window.layoutCaptureCalls=0;
      Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{if(window.denyCopy)throw Error('denied');window.copiedPlayerLink=value;}}});
      navigator.mediaDevices.getDisplayMedia = async () => {
        window.layoutCaptureCalls++;
        const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
        const drawing=canvas.getContext('2d');let frame=0;
        const paint=()=>{drawing.fillStyle=frame%2?'#23374d':'#31574c';drawing.fillRect(0,0,640,360);drawing.fillStyle='white';drawing.font='32px sans-serif';drawing.fillText(`FRAME ${frame++}`,40,180);};paint();
        const timer=setInterval(paint,40);const stream=canvas.captureStream(24);
        const context=new AudioContext(),osc=context.createOscillator(),gain=context.createGain(),destination=context.createMediaStreamDestination();
        gain.gain.value=.05;osc.connect(gain).connect(destination);osc.start();await context.resume();destination.stream.getAudioTracks().forEach(track=>stream.addTrack(track));
        const stop=stream.getVideoTracks()[0].stop.bind(stream.getVideoTracks()[0]);stream.getVideoTracks()[0].stop=()=>{clearInterval(timer);context.close();stop();};
        window.layoutStream=stream;return stream;
      };
    });
    await page.goto(`${origin}/#token=layout`);
    await page.locator('#engine-title').filter({hasText:'本機 AI 已就緒'}).waitFor();
    await page.waitForFunction(()=>document.getElementById('sponsor-slide-position').textContent.endsWith('/ 11'));
    aiReady=false;aiPhase='idle';
    await page.locator('#engine-title').filter({hasText:'請準備 AI 模型'}).waitFor();
    await page.locator('#open-engine-settings').click();assert.equal(await page.locator('#setup-dialog').isVisible(),true);
    await page.locator('#close-model-settings').click();
    await page.locator('#open-settings').click();await page.locator('#open-engine-settings').click();assert.equal(await page.locator('#setup-dialog').isVisible(),true);
    await page.locator('#close-model-settings').click();await page.keyboard.press('Escape');
    aiPhase='loading';await page.locator('#engine-title').filter({hasText:'正在準備 AI'}).waitFor();
    assert.equal(await page.locator('#open-engine-settings').isDisabled(),true);assert.equal(await page.locator('#setup-dialog').isVisible(),false);
    aiReady=true;aiPhase='ready';await page.locator('#engine-title').filter({hasText:'本機 AI 已就緒'}).waitFor();
    await page.locator('#capture-browser-help').click();
    for(const browser of ['chrome','edge'])await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/player/open')),page.locator(`#open-in-${browser}`).click()]);
    await page.locator('#copy-player-link').click();const copied=await page.evaluate(()=>window.copiedPlayerLink);
    assert.equal(new URL(copied).origin,origin);assert.equal(new URL(copied).hash,'#token=layout');
    const other=await browser.newContext();const profile=await other.newPage();await profile.goto(copied);await profile.locator('#engine-title').filter({hasText:'本機 AI 已就緒'}).waitFor();await other.close();
    await page.evaluate(()=>window.denyCopy=true);await page.locator('#copy-player-link').click();assert.equal(await page.locator('#player-link').inputValue(),copied);assert.equal(await page.locator('#player-link').getAttribute('readonly'),'');
    await page.keyboard.press('Escape');

    await page.locator('#settings-dialog').waitFor({state:'hidden'});
    for (const variant of [{width:1440,theme:'studio',language:'zh-Hant'},{width:1440,theme:'light',language:'en'},{width:390,theme:'studio',language:'en'},{width:390,theme:'light',language:'zh-Hant'}]) {
      await page.locator('.topbar #setup').waitFor({state:'visible'});
      await page.setViewportSize({width:variant.width,height:1000});
      for (const id of ['open-models','translation-model']) assert.equal(await page.locator(`#${id}`).isVisible(),false,`${id} must not clutter the main view`);
      for (const id of ['model-settings','setup']) assert.equal(await page.locator(`#${id}`).isVisible(),true);
      assert.match(await page.locator('#setup').textContent(),/模型已就緒|Models ready/);
      assert.equal(await page.locator('[data-theme-choice="studio"]').isVisible(),false,'theme choices belong in Settings');
      await page.locator('#open-settings').click();
      assert.equal(await page.locator('#settings-dialog #backend').count(),1);
      assert.equal(await page.locator('#settings-dialog').isVisible(),true);
      for (const id of ['open-models','model-settings','setup','translation-model']) assert.equal(await page.locator(`#${id}`).isVisible(),true,`${id} stays available through Settings`);
      await page.locator(`[data-theme-choice="${variant.theme}"]`).click();
      await page.screenshot({path:path.join(os.tmpdir(),`vtranslate-settings-${variant.width}-${variant.theme}.png`)});
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#settings-dialog').isVisible(),false);
      await page.waitForFunction(()=>document.activeElement.id==='open-settings');
      assert.equal(await page.evaluate(()=>document.activeElement.id),'open-settings','Escape returns focus to the gear');
      await page.locator('#interface-language').selectOption(variant.language);
      await page.waitForFunction(value=>document.documentElement.lang===value.language&&document.documentElement.dataset.theme===value.theme,variant);
      assert.match(await page.locator('#interface-language-label').textContent(),/language/i,'English speakers must recognize the language selector');
      const layout=await page.evaluate(()=>{
        const ids=['header-language','header-engine-status','header-engine-choice'];
        const elements=ids.map(id=>document.getElementById(id));
        return {logical:elements.slice(1).every((element,index)=>!!(elements[index].compareDocumentPosition(element)&Node.DOCUMENT_POSITION_FOLLOWING)),boxes:elements.map(element=>element.getBoundingClientRect().toJSON()),gear:document.getElementById('open-settings').getBoundingClientRect().toJSON(),width:innerWidth,scrollWidth:document.documentElement.scrollWidth};
      });
      assert.equal(layout.logical,true,'header keyboard/read order is Language, AI status, engine');
      assert.ok(layout.boxes.every(box=>box.width>0&&box.left>=-1&&box.right<=layout.width+1),'header controls fit the viewport');
      assert.ok(layout.scrollWidth<=layout.width+1,'compact layout does not overflow horizontally');
      if (variant.width>1000) assert.ok(layout.boxes.every((box,index)=>!index||box.x+box.width/2>layout.boxes[index-1].x+layout.boxes[index-1].width/2),'desktop controls follow requested left-to-right order');
      await page.screenshot({path:path.join(os.tmpdir(),`vtranslate-header-${variant.width}-${variant.theme}.png`)});
      await page.locator('#player-tab').focus();await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('#transcript-tab').getAttribute('aria-selected'),'true');
      assert.equal(await page.locator('#transcript-view').isVisible(),true);
      assert.equal(await page.locator('#player-view').isVisible(),false);
      await page.keyboard.press('Home');
      assert.equal(await page.locator('#player-tab').getAttribute('aria-selected'),'true');
      assert.equal(await page.locator('#fans-ad-email').getAttribute('href'),'mailto:vtranslate853@gmail.com');
      await page.screenshot({path:path.join(os.tmpdir(),`vtranslate-layout-${variant.width}-${variant.theme}.png`)});
    }
    // Settings still exposes the existing performance dialog and folder action.
    await page.locator('#open-settings').click();
    await page.locator('#model-settings').click();await page.locator('#setup-dialog').waitFor();
    await page.locator('#close-model-settings').click();
    if (!(await page.locator('#settings-dialog').isVisible())) await page.locator('#open-settings').click();
    const folder=page.waitForResponse(response=>response.url().endsWith('/api/models/open'));await page.locator('#open-models').click();await folder;
    await page.keyboard.press('Escape');
    // Manual navigation wraps and never opens a sponsor page.
    await page.locator('#sponsor-rotation-pause').click();
    const position=()=>page.locator('#sponsor-slide-position').textContent();
    const initial=Number((await position()).split('/')[0]);
    await page.locator('#sponsor-previous').click();
    assert.equal(Number((await position()).split('/')[0]),initial===1?11:initial-1);
    await page.locator('#sponsor-next').click();assert.equal(Number((await position()).split('/')[0]),initial);
    for(let index=0;index<11;index++)await page.locator('#sponsor-next').click();
    assert.equal(Number((await position()).split('/')[0]),initial,'next wraps a complete ten-ad-plus-placeholder cycle');
    assert.equal(await page.locator('#sponsor-rotation-pause').getAttribute('aria-pressed'),'true','manual navigation preserves explicit pause');
    await page.mouse.move(0,0);await page.locator('#language').focus();const paused=await position();await page.waitForTimeout(2000);assert.equal(await position(),paused);
    assert.ok((await page.evaluate(()=>window.layoutIntervals)).includes(10000));
    assert.equal(page.context().pages().length,1,'arrow clicks must not open the image link');
    // One actual recording session continues while users read transcript or Settings.
    await page.locator('#interface-language').selectOption('zh-Hant');
    await page.locator('#start').click();
    await page.waitForFunction(()=>document.getElementById('video').src.startsWith('blob:')&&window.layoutStream?.getTracks().every(track=>track.readyState==='live'));
    const original=await page.locator('#video').evaluate(video=>video.src);
    await page.waitForFunction(()=>document.querySelectorAll('#transcript .transcript-row').length>0,null,{timeout:15000});
    assert.equal(created,1);assert.equal(deleted,0);assert.ok(audio>0);
    await page.locator('#transcript-tab').click();
    assert.equal(await page.locator('#transcript-view').isVisible(),true);assert.equal(await page.locator('#player-view').isVisible(),false);
    assert.ok((await page.locator('#transcript').textContent()).includes('字幕'));
    const beforeRows=await page.locator('#transcript .transcript-row').count();
    await page.waitForFunction(previous=>document.querySelectorAll('#transcript .transcript-row').length>previous,beforeRows,{timeout:10000});
    const download=page.waitForEvent('download');await page.locator('#export').click();assert.match((await download).suggestedFilename(),/\.srt$/i);
    await page.locator('#open-settings').click();assert.equal(await page.locator('#backend').isDisabled(),true);assert.equal(await page.locator('#open-in-chrome').isDisabled(),true);assert.equal(await page.locator('#open-in-edge').isDisabled(),true);
    await page.keyboard.press('Escape');
    await page.locator('#player-tab').click();
    assert.equal(await page.locator('#video').evaluate(video=>video.src),original,'view changes must preserve MediaSource URL');
    assert.equal(await page.evaluate(()=>window.layoutCaptureCalls),1);
    assert.equal(await page.evaluate(()=>window.layoutStream.getTracks().every(track=>track.readyState==='live')),true);
    assert.equal(created,1);assert.equal(deleted,0,'view changes must not end or recreate the backend session');
    await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/session/layout-session')&&response.request().method()==='DELETE'),page.locator('#stop').click()]);
    await page.waitForFunction(()=>window.layoutStream.getTracks().every(track=>track.readyState==='ended'));
    assert.equal(deleted,1);
    assert.ok(heartbeats>0,'captured media sends source heartbeats');
    // Server timeout remains authoritative even while this UI keeps polling.
    await page.locator('#start').click();
    await page.waitForFunction(()=>window.layoutCaptureCalls===2&&window.layoutStream.getTracks().every(track=>track.readyState==='live'));
    idlePaused=true;
    await page.locator('#idle-overlay').waitFor();
    await page.waitForFunction(()=>window.layoutStream.getTracks().every(track=>track.readyState==='ended'));
    assert.equal(deleted,2,'idle pause releases capture resources');
    await page.screenshot({path:path.join(os.tmpdir(),'vtranslate-idle-overlay.png')});
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#idle-overlay').isVisible(),true);
    restartFails=true;
    await page.locator('#resume-whisper').click();
    await page.locator('#resume-error').filter({hasText:'Restart failed'}).waitFor();
    assert.equal(await page.locator('#resume-whisper').isEnabled(),true);
    restartFails=false;
    await page.locator('#resume-whisper').click();
    await page.waitForFunction(()=>!document.getElementById('idle-overlay').open);
    assert.equal(await page.locator('#start').isEnabled(),true);
    assert.equal(created,2,'restart does not silently recapture a tab');
    assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
    assert.deepEqual(mutations.filter(value=>!['PUT /api/appearance','POST /api/models/open','POST /api/session','DELETE /api/session/layout-session','POST /api/transcribe','POST /api/session/layout-session','POST /api/setup','POST /api/player/open','POST /api/player/presence'].includes(value)),[]);
    console.log('PASS compact layout: ordered header, Settings visibility/focus, bilingual themes/mobile, keyboard transcript tabs, live capture/export continuity, safe looping ad arrows, media heartbeat, idle overlay, browser/profile transfer, clipboard fallback, AI-hint setup shortcut, restart failure and success');
    const presenceCount=presence.length;
    await page.reload();
    await page.waitForLoadState('networkidle');
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.ok(presence.slice(presenceCount).some(p=>p.closed),'reload reports departing document');
    assert.ok(presence.slice(presenceCount).some(p=>!p.closed),'replacement document cancels pending shutdown');
    const lastId=presence.filter(p=>!p.closed).at(-1).id;
    await page.close();
    for(let i=0;i<30&&!presence.some(p=>p.id===lastId&&p.closed);i++)await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(presence.some(p=>p.id===lastId&&p.closed),'closing the player reports final departure');
  } finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
