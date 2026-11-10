// macOS capabilities are an API fixture. This does not claim native Metal or
// macOS screen-recording verification on the Linux browser test machine.
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE||'playwright');
(async()=>{
  const root=path.resolve(__dirname,'..');
  let settings={backend:'metal',device:'MTL0',performance:'high',whisper_model:'small',translation_model:null,cpu_threads:6,chunk_seconds:5,buffer_seconds:20};
  let appearance={theme:'studio',language:'zh-Hant'};
  let status={ready:true,phase:'ready',backend:'metal',device:'Apple M3 GPU',detail:'Synthetic Apple Metal UI fixture',progress:1};
  let deviceGets=0;let deviceDetections=0;let setups=0;let folderOpens=0;
  const calls=[];const changes=[];const errors=[];
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    try{
      if(url.pathname.startsWith('/api/')){
        assert.equal(req.headers.authorization,'Bearer mac-ui');calls.push(`${req.method} ${url.pathname}`);res.setHeader('Content-Type','application/json');
        if(url.pathname==='/api/platform')return res.end(JSON.stringify({os:'macos',arch:'aarch64',backends:['cpu','metal']}));
        if(url.pathname==='/api/status')return res.end(JSON.stringify(status));
        if(url.pathname==='/api/settings'){
          if(req.method==='PUT'){
            const chunks=[];for await(const chunk of req)chunks.push(chunk);settings=JSON.parse(Buffer.concat(chunks));
            assert.ok(['cpu','metal'].includes(settings.backend));assert.ok(settings.device===null||settings.device==='MTL0');
            changes.push({...settings});status={ready:false,phase:'idle',backend:settings.backend,device:null,detail:'Saved fixture settings'};
          }
          return res.end(JSON.stringify(settings));
        }
        if(url.pathname==='/api/appearance'){
          if(req.method==='PUT'){const chunks=[];for await(const chunk of req)chunks.push(chunk);appearance=JSON.parse(Buffer.concat(chunks));}
          return res.end(JSON.stringify(appearance));
        }
        if(url.pathname==='/api/devices'){
          assert.equal(settings.backend,'metal','device discovery must retain the Metal backend');
          if(req.method==='POST')deviceDetections++;else deviceGets++;
          return res.end(JSON.stringify({devices:[{id:'MTL0',name:'Apple M3 GPU'}]}));
        }
        if(url.pathname==='/api/setup'&&req.method==='POST'){
          assert.equal(settings.backend,'metal');assert.equal(settings.device,'MTL0');setups++;
          status={ready:true,phase:'ready',backend:'metal',device:'Apple M3 GPU',detail:'Synthetic Apple Metal UI fixture',progress:1};return res.end(JSON.stringify({accepted:true}));
        }
        if(url.pathname==='/api/models/open'&&req.method==='POST'){folderOpens++;return res.end(JSON.stringify({path:'/Users/viewer/Library/Application Support/LiveSub/LiveSub/data/models',opened:true}));}
        if(url.pathname==='/api/vocabulary')return res.end(JSON.stringify({profiles:[],active_id:null,warnings:[]}));
        if(url.pathname==='/api/translation-models')return res.end(JSON.stringify({models:[],warnings:[]}));
        if(url.pathname==='/api/ads')return res.end(JSON.stringify({state:'ready',ads:[{id:'mac-ad',image_url:'/ad-assets/mac-ad',link_url:'https://sponsor.example/mac'}]}));
        res.writeHead(404);return res.end('{}');
      }
      if(url.pathname==='/manifest.webmanifest'){res.setHeader('Content-Type','application/manifest+json');return res.end(JSON.stringify({name:'V-Translate',icons:[{src:'/app-icon.png',type:'image/png'}]}));}
      const file=url.pathname==='/'?'web/index.html':url.pathname==='/ad-assets/mac-ad'?'assets/app-icon.png':['/app-icon.png','/favicon.ico'].includes(url.pathname)?`assets/${url.pathname==='/app-icon.png'?'app-icon.png':'app-icon.ico'}`:`web${url.pathname}`;
      const body=await fs.readFile(path.join(root,file));res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':file.endsWith('.ico')?'image/x-icon':'text/html');res.end(body);
    }catch(error){errors.push(error.stack);res.writeHead(500);res.end('{}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,headless:true,args:['--no-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1100}});page.on('pageerror',error=>errors.push(error.stack));
    await page.addInitScript(()=>{const interval=window.setInterval.bind(window);window.fixtureIntervals=[];window.setInterval=(callback,delay,...args)=>{window.fixtureIntervals.push(delay);return interval(callback,delay===10000?180:delay,...args);};});
    await page.goto(`${origin}/#token=mac-ui`);
    await page.getByText('本機 AI 已就緒',{exact:true}).waitFor();
    await page.waitForFunction(()=>!document.getElementById('gpu-device').disabled);
    assert.ok(calls.indexOf('GET /api/platform')<calls.indexOf('GET /api/settings'),'platform capabilities must load before saved Metal settings');
    assert.deepEqual(await page.locator('#backend option').evaluateAll(options=>options.map(option=>option.value)),['cpu','metal']);
    assert.equal(await page.locator('#backend').inputValue(),'metal');assert.equal(await page.locator('#gpu-device').inputValue(),'MTL0');assert.ok(deviceGets>=1);
    await page.locator('#open-settings').click();
    assert.match(await page.locator('#compute-badge').textContent(),/Metal.*GPU/);
    assert.equal(await page.locator('#macos-capture-hint').isVisible(),true);assert.match(await page.locator('#macos-capture-hint').textContent(),/螢幕與系統音訊錄製/);
    assert.equal(await page.locator('#windows-runtime-note').isHidden(),true);assert.match(await page.locator('#compute-hint').textContent(),/Apple.*Metal/);assert.match(await page.locator('#gpu-platform-note').textContent(),/Apple.*Metal/);
    assert.match(await page.locator('#open-models').textContent(),/Finder/);assert.match(await page.locator('#open-translation-models').textContent(),/Finder/);
    await page.keyboard.press('Escape');
    await page.locator('#language').selectOption('ko');await page.locator('#target').selectOption('English');
    await page.locator('#interface-language').selectOption('en');await page.waitForFunction(()=>document.documentElement.lang==='en');
    assert.match(await page.locator('#interface-language-label').textContent(),/language/i);
    await page.locator('#open-settings').click();
    assert.match(await page.locator('#macos-capture-hint').textContent(),/Screen & System Audio Recording/);assert.match(await page.locator('#macos-capture-hint').textContent(),/Safari\/Firefox/);
    assert.equal(await page.locator('#windows-runtime-note').isHidden(),true);assert.equal(await page.locator('#language').inputValue(),'ko');assert.equal(await page.locator('#target').inputValue(),'English');
    await page.locator('#open-models').click();await page.locator('#model-path').waitFor({state:'visible'});assert.equal(folderOpens,1);assert.match(await page.locator('#model-path').textContent(),/^\/Users\//);
    await page.keyboard.press('Escape');
    await page.locator('#backend').selectOption('cpu');await page.waitForFunction(()=>!document.getElementById('backend').disabled);assert.equal(settings.backend,'cpu');assert.equal(settings.device,null);
    await page.locator('#backend').selectOption('metal');await page.waitForFunction(()=>!document.getElementById('detect-gpu').disabled);
    await page.locator('#open-settings').click();
    await page.locator('#detect-gpu').click();await page.waitForFunction(()=>!document.getElementById('gpu-device').disabled);assert.equal(deviceDetections,1);
    await page.locator('#gpu-device').selectOption('MTL0');await page.waitForFunction(()=>!document.getElementById('setup').disabled);
    assert.equal(settings.backend,'metal');assert.equal(settings.device,'MTL0');assert.equal(settings.cpu_threads,6);assert.equal(settings.whisper_model,'small');assert.equal(settings.buffer_seconds,20);
    await page.locator('#setup').click();await page.locator('#save-and-setup').click();await page.getByText('Local AI is ready',{exact:true}).waitFor();
    assert.equal(setups,1);assert.match(await page.locator('#compute-badge').textContent(),/Metal.*GPU/);assert.match(await page.locator('#engine-detail').textContent(),/Apple M3 GPU/);
    await page.reload();await page.getByText('Local AI is ready',{exact:true}).waitFor();await page.waitForFunction(()=>!document.getElementById('gpu-device').disabled);
    assert.equal(await page.locator('#backend').inputValue(),'metal');assert.equal(await page.locator('#gpu-device').inputValue(),'MTL0');
    assert.equal(await page.locator('#fans-ad-email').getAttribute('href'),'mailto:vtranslate853@gmail.com');assert.equal(await page.locator('#fans-ad-contact').isVisible(),true);
    await page.mouse.move(0,0);await page.locator('#language').focus();
    await page.waitForFunction(()=>!document.getElementById('sponsor-image-link').hidden);await page.waitForFunction(()=>!document.getElementById('sponsor-placeholder').hidden);
    assert.ok((await page.evaluate(()=>window.fixtureIntervals)).includes(10000));
    await page.locator('#interface-language').selectOption('zh-Hant');await page.waitForFunction(()=>document.documentElement.lang==='zh-Hant');
    assert.equal(await page.locator('#backend').inputValue(),'metal');assert.match(await page.locator('#macos-capture-hint').textContent(),/螢幕與系統音訊錄製/);
    assert.ok(changes.every(change=>change.backend!=='vulkan'));assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(os.tmpdir(),'vtranslate-macos-main-ui.png'),fullPage:true});
    await page.locator('#open-settings').click();
    await page.screenshot({path:path.join(os.tmpdir(),'vtranslate-macos-metal-ui.png'),fullPage:true});
    console.log('PASS macOS UI fixture: platform-first saved Metal, CPU/Metal-only choices, automatic/manual discovery, MTL0 persistence, bilingual recording/Finder guidance, no Windows runtime prompt, sponsorship retained');
  }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
