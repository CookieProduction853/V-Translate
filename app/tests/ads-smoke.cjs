// Focused carousel test: local cached-image fixtures, no external ad network.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
(async () => {
  const root=path.resolve(__dirname,'..');
  const artwork=await fs.readFile(path.join(root,'assets/app-icon.png'));
  const advertisements=Array.from({length:10},(_,index)=>({id:`ad${index+1}`,image_url:`/ad-assets/ad${index+1}`,link_url:`https://sponsor.example/ad${index+1}`}));
  const first=advertisements[0];
  let payload={state:'ready',ads:[]};let checks=0;let checking=false;
  let appearance={theme:'studio',language:'zh-Hant'};
  const errors=[];const mutations=[];const unexpectedRequests=[];
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    try{
      if(url.pathname.startsWith('/api/')){
        assert.equal(req.headers.authorization,'Bearer ads');res.setHeader('Content-Type','application/json');
        if(req.method!=='GET')mutations.push(`${req.method} ${url.pathname}`);
        if(url.pathname==='/api/ads'){checks++;return res.end(JSON.stringify(checking&&checks===1?{state:'checking',ads:[]}:payload));}
        if(url.pathname==='/api/status')return res.end(JSON.stringify({ready:true,phase:'ready',backend:'cpu',detail:'Carousel fixture',progress:1}));
        if(url.pathname==='/api/settings')return res.end(JSON.stringify({backend:'cpu',device:null,performance:'high',whisper_model:'small',translation_model:null,cpu_threads:6,chunk_seconds:5,buffer_seconds:20}));
        if(url.pathname==='/api/appearance'){if(req.method==='PUT'){const chunks=[];for await(const chunk of req)chunks.push(chunk);appearance=JSON.parse(Buffer.concat(chunks));}return res.end(JSON.stringify(appearance));}
        if(url.pathname==='/api/vocabulary')return res.end(JSON.stringify({profiles:[],active_id:null,warnings:[]}));
        if(url.pathname==='/api/translation-models')return res.end(JSON.stringify({models:[],warnings:[]}));
        res.writeHead(404);return res.end('{}');
      }
      if(url.pathname.startsWith('/ad-assets/')){
        if(!advertisements.some(ad=>ad.image_url===url.pathname)){res.writeHead(404);return res.end();}
        res.setHeader('Content-Type','image/png');return res.end(artwork);
      }
      if(url.pathname==='/manifest.webmanifest'){res.setHeader('Content-Type','application/manifest+json');return res.end(JSON.stringify({name:'V-Translate',icons:[{src:'/app-icon.png',sizes:'any',type:'image/png'}]}));}
      const file=url.pathname==='/'?'web/index.html':['/app-icon.png','/favicon.ico'].includes(url.pathname)?`assets/${url.pathname==='/app-icon.png'?'app-icon.png':'app-icon.ico'}`:`web${url.pathname}`;
      const body=await fs.readFile(path.join(root,file));
      res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':file.endsWith('.ico')?'image/x-icon':'text/html');res.end(body);
    }catch(error){errors.push(error.stack);res.writeHead(500);res.end('{}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,headless:true,args:['--no-sandbox']});
  const open=async()=>{
    appearance={theme:'studio',language:'zh-Hant'};
    const page=await browser.newPage({viewport:{width:1280,height:1050}});
    page.on('pageerror',error=>errors.push(error.stack));
    page.on('request',request=>{const url=new URL(request.url());if(['http:','https:'].includes(url.protocol)&&url.origin!==origin&&url.hostname!=='sponsor.example')unexpectedRequests.push(request.url());});
    await page.context().route('https://sponsor.example/**',route=>route.fulfill({contentType:'text/html',body:'<title>Local sponsor destination fixture</title>'}));
    await page.addInitScript(()=>{
      const timeout=window.setTimeout.bind(window);const interval=window.setInterval.bind(window);
      window.rotationDelays=[];
      window.setTimeout=(callback,delay,...args)=>timeout(callback,delay===5000?50:delay,...args);
      window.setInterval=(callback,delay,...args)=>{window.rotationDelays.push(delay);return interval(callback,delay===10000?150:delay,...args);};
      let hidden=false;Object.defineProperty(document,'hidden',{get:()=>hidden});Object.defineProperty(document,'visibilityState',{get:()=>hidden?'hidden':'visible'});
      window.setCarouselVisibility=value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'));};
    });
    await page.goto(`${origin}/#token=ads`);await page.getByText('本機 AI 已就緒',{exact:true}).waitFor();
    return page;
  };
  const slide=page=>page.evaluate(()=>document.getElementById('sponsor-placeholder').hidden?document.getElementById('sponsor-image-link').href:'placeholder');
  const stats=page=>page.evaluate(()=>({source:document.getElementById('video').getAttribute('src'),processed:document.getElementById('processed').textContent,inference:document.getElementById('inference-time').textContent,delay:document.getElementById('live-delay').textContent}));
  try{
    payload={state:'ready',ads:[...advertisements,{id:'broken',image_url:'/ad-assets/broken',link_url:'https://sponsor.example/broken'},{id:'unsafe',image_url:'/ad-assets/unsafe',link_url:'javascript:alert(1)'},{id:'remote',image_url:'https://tracking.example/ad.jpg',link_url:'https://sponsor.example/remote'},first]};
    checking=true;checks=0;const page=await open();
    await page.waitForFunction(()=>document.getElementById('sponsor-slide-position').textContent.endsWith('/ 11'));
    assert.ok(checks>=2,'startup checking state must be refreshed');const before=await stats(page);
    const expected=['placeholder',...advertisements.map(ad=>ad.link_url)];
    for(const variant of [{theme:'studio',language:'zh-Hant',width:1280},{theme:'light',language:'en',width:1280},{theme:'studio',language:'en',width:390},{theme:'light',language:'zh-Hant',width:390}]){
      await page.setViewportSize({width:variant.width,height:1050});
      await page.locator('#open-settings').click();
      await page.locator(`[data-theme-choice="${variant.theme}"]`).click();
      await page.keyboard.press('Escape');
      await page.locator('#interface-language').selectOption(variant.language);
      await page.waitForFunction(value=>document.documentElement.lang===value.language&&document.documentElement.dataset.theme===value.theme,variant);
      assert.match(await page.locator('#interface-language-label').textContent(),/language/i);
      assert.equal(await page.locator('#interface-language').isVisible(),true,'language selection must be discoverable in both interfaces');
      assert.equal(await page.locator('#fans-ad-email').getAttribute('href'),'mailto:vtranslate853@gmail.com');
      await page.mouse.move(0,0);await page.locator('#language').focus();
      await page.waitForFunction(()=>document.getElementById('sponsor-slide-position').textContent==='1 / 11');
      await page.evaluate(()=>{
        window.carouselObserver?.disconnect();window.carouselSequence=[];
        const sample=()=>{
          const banner=document.getElementById('sponsor-slot');const contact=document.getElementById('fans-ad-contact');const email=document.getElementById('fans-ad-email');
          const key=document.getElementById('sponsor-placeholder').hidden?document.getElementById('sponsor-image-link').href:'placeholder';
          if(window.carouselSequence.at(-1)?.key===key)return;
          const box=contact.getBoundingClientRect();const bannerBox=banner.getBoundingClientRect();
          window.carouselSequence.push({key,visible:box.width>0&&box.height>0&&getComputedStyle(contact).visibility==='visible',below:box.top>=bannerBox.bottom,outside:!banner.contains(contact),fits:box.left>=-1&&box.right<=innerWidth+1,href:email.getAttribute('href')});
        };
        window.carouselObserver=new MutationObserver(sample);window.carouselObserver.observe(document.getElementById('sponsor-slot'),{subtree:true,childList:true,attributes:true});sample();
      });
      await page.waitForFunction(()=>window.carouselSequence.length>=23,null,{timeout:15000});
      const cycle=await page.evaluate(()=>window.carouselSequence.slice(0,23));
      assert.deepEqual(cycle.map(entry=>entry.key),[...expected,...expected,expected[0]],'ten ads and the placeholder must repeat complete cycles');
      assert.ok(cycle.every(entry=>entry.visible&&entry.below&&entry.outside&&entry.fits&&entry.href==='mailto:vtranslate853@gmail.com'),'Fans AD Contact must remain visible below the banner throughout every slide, theme and mobile layout');
      await page.locator('#fans-ad-contact').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(os.tmpdir(),`vtranslate-fans-contact-${variant.theme}-${variant.width}.png`)});
    }
    assert.ok((await page.evaluate(()=>window.rotationDelays)).includes(10000),'production rotation must request a ten-second interval');
    assert.ok(!(await page.evaluate(()=>window.rotationDelays)).includes(8000),'the old eight-second rotation must not remain active');
    await page.locator('#sponsor-rotation-pause').click();await page.mouse.move(0,0);await page.locator('#language').focus();
    assert.equal(await page.locator('#sponsor-rotation-pause').getAttribute('aria-pressed'),'true');const paused=await slide(page);
    await page.waitForTimeout(1700);assert.equal(await slide(page),paused,'explicit pause must hold the same slide');
    await page.locator('#sponsor-rotation-pause').click();await page.mouse.move(0,0);await page.locator('#language').focus();
    await page.waitForFunction(previous=>{const placeholder=document.getElementById('sponsor-placeholder');return(placeholder.hidden?document.getElementById('sponsor-image-link').href:'placeholder')!==previous;},paused);
    await page.locator('#sponsor-slot').hover();await page.waitForTimeout(50);const hovered=await slide(page);await page.waitForTimeout(1100);assert.equal(await slide(page),hovered,'hover must pause rotation');
    await page.mouse.move(0,0);await page.evaluate(()=>window.setCarouselVisibility(true));const hidden=await slide(page);await page.waitForTimeout(1100);assert.equal(await slide(page),hidden,'hidden pages must pause rotation');
    await page.evaluate(()=>window.setCarouselVisibility(false));await page.locator('#language').focus();
    await page.waitForFunction(()=>!document.getElementById('sponsor-image-link').hidden);
    await page.locator('#sponsor-rotation-pause').click();await page.mouse.move(0,0);await page.locator('#language').focus();
    const link=page.locator('#sponsor-image-link');assert.match(await link.getAttribute('href'),/^https:\/\/sponsor\.example\/ad(?:10|[1-9])$/);
    assert.equal(await link.getAttribute('target'),'_blank');assert.match(await link.getAttribute('rel'),/\bnoopener\b/);assert.match(await link.getAttribute('rel'),/\bnoreferrer\b/);
    assert.equal(await page.locator('#sponsor-image').evaluate(image=>getComputedStyle(image).objectFit),'cover');
    const popupPromise=page.context().waitForEvent('page');await link.click();const popup=await popupPromise;await popup.waitForLoadState();assert.match(popup.url(),/^https:\/\/sponsor\.example\/ad(?:10|[1-9])$/);await popup.close();await page.bringToFront();
    assert.deepEqual(await stats(page),before,'ad rotation and link clicks must preserve player state and counters');
    assert.deepEqual(mutations.filter(request=>request!=='PUT /api/appearance'),[],'ad rotation must not mutate capture, model or application settings');
    await page.locator('#sponsor-slot').screenshot({path:path.join(os.tmpdir(),'vtranslate-advertisement.png')});await page.close();
    checking=false;
    for(const next of [{state:'ready',ads:[]},{state:'offline',ads:[]},{state:'ready',ads:[{id:'broken',image_url:'/ad-assets/broken',link_url:'https://sponsor.example/broken'}]}]){
      payload=next;checks=0;const fallback=await open();await fallback.waitForTimeout(250);
      assert.equal(await fallback.locator('#sponsor-placeholder').isVisible(),true);assert.equal(await fallback.locator('#sponsor-image-link').isHidden(),true);
      assert.equal(await fallback.locator('#fans-ad-contact').isVisible(),true);assert.equal(await fallback.locator('#fans-ad-email').getAttribute('href'),'mailto:vtranslate853@gmail.com');
      assert.equal(await fallback.locator('#sponsor-rotation-pause').isDisabled(),true);assert.equal(await fallback.locator('#sponsor-slide-position').textContent(),'1 / 1');await fallback.close();
    }
    assert.deepEqual(errors,[]);assert.deepEqual(unexpectedRequests,[]);
    console.log('PASS ads: ten ads + placeholder repeat at ten-second intervals; bilingual language label, persistent email below banner in both themes/mobile, broken/unsafe entries, pause/visibility, safe link, unchanged player, empty/offline fallback');
  }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
