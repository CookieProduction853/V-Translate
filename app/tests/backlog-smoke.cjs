// Real Chromium capture/MSE, with only the audio-backlog threshold shortened
// in the served test module. Production keeps its 180-second threshold.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
(async () => {
  const root = path.resolve(__dirname, '..');
  let settings = { backend:'cpu', device:null, performance:'high', whisper_model:'small', translation_model:null, cpu_threads:6, chunk_seconds:4, buffer_seconds:10 };
  let appearance = { theme:'studio', language:'zh-Hant' };
  const sessions = new Map(); let serial = 0; let deletes = 0; let recoveries = 0;
  const requests = []; const pending = new Map(); const holdNext = new Set(); const errors = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        assert.equal(req.headers.authorization, 'Bearer countdown');
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/api/status') return res.end(JSON.stringify({ ready:true, phase:'ready', backend:'cpu', progress:1, detail:'Countdown browser fixture' }));
        if (url.pathname === '/api/settings') return res.end(JSON.stringify(settings));
        if (url.pathname === '/api/appearance') {
          if (req.method === 'PUT') { const chunks=[]; for await (const c of req) chunks.push(c); appearance=JSON.parse(Buffer.concat(chunks)); }
          return res.end(JSON.stringify(appearance));
        }
        if (url.pathname === '/api/vocabulary') return res.end(JSON.stringify({ profiles:[], active_id:null, warnings:[] }));
        if (url.pathname === '/api/translation-models') return res.end(JSON.stringify({ models:[], warnings:[] }));
        if (url.pathname === '/api/recover') { recoveries++; return res.end('{}'); }
        if (url.pathname === '/api/session' && req.method === 'POST') {
          const id=`session-${++serial}`; sessions.set(id, true);
          return res.end(JSON.stringify({ id, chunk_seconds:4, buffer_seconds:10 }));
        }
        if (url.pathname.startsWith('/api/session/') && req.method === 'DELETE') { deletes++; sessions.delete(url.pathname.split('/').at(-1)); return res.end('{}'); }
        if (url.pathname === '/api/transcribe') {
          const chunks=[]; for await (const c of req) chunks.push(c);
          const wav=Buffer.concat(chunks); assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
          const id=url.searchParams.get('session'); const start=Number(url.searchParams.get('start'));
          assert.ok(sessions.has(id)); requests.push({ id, start });
          if (start === 4 || holdNext.delete(id)) await new Promise(resolve => { pending.set(id, resolve); res.once('close', resolve); });
          if (res.destroyed) return;
          return res.end(JSON.stringify({ segments:[{ start:start+.05, end:start+3.95, text:`speech ${start}`, translation:`字幕 ${start}` }], elapsed_ms:1, warnings:[] }));
        }
        res.writeHead(404); return res.end('{}');
      }
      const pathname=url.pathname === '/' ? 'web/index.html' : ['/app-icon.png','/favicon.ico'].includes(url.pathname)
        ? `assets/${url.pathname === '/app-icon.png' ? 'app-icon.png' : 'app-icon.ico'}` : `web${url.pathname}`;
      let body=await fs.readFile(path.join(root, pathname));
      if (url.pathname === '/backpressure.js') {
        const source=body.toString(); assert.ok(source.includes('export const MAX_QUEUED_AUDIO_SECONDS = 180;'));
        body=Buffer.from(source.replace('export const MAX_QUEUED_AUDIO_SECONDS = 180;', 'export const MAX_QUEUED_AUDIO_SECONDS = 5;'));
      }
      res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.png') ? 'image/png' : pathname.endsWith('.ico') ? 'image/x-icon' : 'text/html');
      res.end(body);
    } catch (error) { errors.push(error.stack); res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({ executablePath:process.env.CHROMIUM_PATH || undefined, headless:true, args:['--no-sandbox','--autoplay-policy=no-user-gesture-required'] });
  const startPage=async () => {
    const page=await browser.newPage({ viewport:{width:1280,height:1000} }); page.on('pageerror', error => errors.push(error.stack));
    await page.addInitScript(() => {
      const clock=performance.now.bind(performance); let jump=0;
      Object.defineProperty(performance, 'now', { value:() => clock()+jump });
      window.advanceCountdown=milliseconds => { jump+=milliseconds; };
      navigator.mediaDevices.getDisplayMedia=async () => {
        const canvas=document.createElement('canvas'); canvas.width=640; canvas.height=360;
        const ctx=canvas.getContext('2d'); let frame=0;
        const draw=() => { ctx.fillStyle='#224b51'; ctx.fillRect(0,0,640,360); ctx.fillStyle='white'; ctx.font='24px sans-serif'; ctx.fillText(`live ${frame++}`,30,150); }; draw();
        const timer=setInterval(draw,40); const stream=canvas.captureStream(24);
        const audio=new AudioContext(); const osc=audio.createOscillator(); const dest=audio.createMediaStreamDestination(); osc.connect(dest); osc.start(); await audio.resume();
        dest.stream.getAudioTracks().forEach(track => stream.addTrack(track));
        const videoTrack=stream.getVideoTracks()[0]; const stop=videoTrack.stop.bind(videoTrack);
        videoTrack.stop=() => { clearInterval(timer); audio.close(); stop(); }; window.capturedStream=stream;
        return stream;
      };
    });
    await page.goto(`${origin}/#token=countdown`);
    await page.getByText('本機 AI 已就緒', {exact:true}).waitFor();
    await page.waitForFunction(() => !document.getElementById('start').disabled);
    await page.locator('#start').click();
    await page.waitForFunction(() => !document.getElementById('video').paused, null, {timeout:20000});
    const source=await page.locator('#video').evaluate(video => video.src);
    await page.locator('#catchup-countdown').waitFor({state:'visible', timeout:10000});
    return {page,source,id:`session-${serial}`};
  };
  try {
    const first=await startPage(); const page=first.page;
    assert.equal(await page.locator('#video').evaluate(video => video.paused), true);
    assert.match(await page.locator('#buffer-detail').textContent(), /20/);
    const atPause=await page.locator('#video').evaluate(video => video.currentTime);
    const remaining=async () => Number((await page.locator('#catchup-countdown').textContent()).match(/\d+/)[0]);
    const before=await remaining(); await page.waitForTimeout(1100); assert.ok(await remaining()<before);
    assert.ok(Math.abs((await page.locator('#video').evaluate(video => video.currentTime))-atPause)<.1);
    const deleteBefore=deletes; const requestBefore=requests.length;
    pending.get(first.id)();
    await page.waitForFunction(() => document.getElementById('processed').textContent !== '00:04');
    await page.locator('#interface-language').selectOption('en');
    assert.match(await page.locator('#buffer-detail').textContent(), /Estimated buffer: 20 seconds/);
    await page.evaluate(() => window.advanceCountdown(5000));
    await page.waitForTimeout(450); assert.ok(await remaining()<=14, 'additional chunks must not restart the original countdown');
    await page.waitForTimeout(4100); assert.ok(requests.length>requestBefore+1, 'inference must continue during the playback pause');
    assert.equal(deletes,deleteBefore); assert.equal(recoveries,0);
    await page.screenshot({path:path.join(os.tmpdir(),'vtranslate-countdown.png')});
    await page.evaluate(() => window.advanceCountdown(20000));
    await page.waitForFunction(() => document.getElementById('catchup-countdown').hidden && !document.getElementById('video').paused);
    const resumed=await page.locator('#video').evaluate(video => video.currentTime);
    await page.waitForTimeout(700); assert.ok((await page.locator('#video').evaluate(video => video.currentTime))>resumed+.3);
    assert.equal(await page.locator('#video').evaluate(video => video.src),first.source);
    assert.ok(await page.evaluate(() => window.capturedStream.getTracks().every(track => track.readyState==='live')));
    await page.locator('#stop').click(); await page.waitForTimeout(200); await page.close();

    settings={...settings,performance:'low',whisper_model:'tiny',cpu_threads:2}; appearance={theme:'studio',language:'zh-Hant'};
    const second=await startPage(); const other=second.page;
    assert.match(await other.locator('#buffer-detail').textContent(), /60/);
    await other.locator('#pause').click();
    await other.evaluate(() => window.advanceCountdown(65000));
    await other.waitForFunction(() => document.getElementById('catchup-countdown').hidden);
    assert.equal(await other.locator('#video').evaluate(video => video.paused),true,'manual pause must survive expiry');
    assert.equal(await other.locator('#playback-label').textContent(),'已暫停');
    assert.match(await other.locator('#message').textContent(),/部分內容可能暫時沒有字幕/);
    pending.get(second.id)();
    await other.waitForFunction(() => document.getElementById('processed').textContent !== '00:04');
    await other.locator('#pause').click();
    await other.waitForFunction(() => !document.getElementById('video').paused);
    await other.waitForTimeout(400);
    holdNext.add(second.id);
    await other.evaluate(() => window.advanceCountdown(31000));
    await other.waitForTimeout(400);
    await other.locator('#catchup-countdown').waitFor({state:'visible',timeout:16000});
    await other.locator('#stop').click();
    await other.evaluate(() => window.advanceCountdown(150000)); await other.waitForTimeout(350);
    assert.equal(await other.locator('#catchup-countdown').isHidden(),true);
    assert.equal(await other.locator('#video').evaluate(video => video.hasAttribute('src')),false);
    assert.ok(await other.evaluate(() => window.capturedStream.getTracks().every(track => track.readyState==='ended')));
    assert.equal(sessions.size,0); assert.equal(deletes,2); assert.equal(recoveries,0); assert.deepEqual(errors,[]);
    console.log('PASS countdown: adaptive duration, decreasing fixed deadline, live capture/inference, safe auto-resume, manual pause, stop cleanup');
    await other.close();
  } finally { for(const release of pending.values())release(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode=1; });
