import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { captionsAt, playbackDecision, captureModeSettings, wav16 } from './timeline.js';

test('capture modes apply per-session buffer and chunk preferences', () => {
  const preset = { buffer_seconds: 5, chunk_seconds: 5 };
  assert.deepEqual(captureModeSettings('song', 12, 6, preset), { delay: 12, chunkSeconds: 6 });
  assert.deepEqual(captureModeSettings('chat', 12, 6, preset), { delay: 5, chunkSeconds: 5 });
  assert.deepEqual(captureModeSettings('chat', 3, 5, preset), { delay: 3, chunkSeconds: 3 });
  assert.deepEqual(captureModeSettings('song', 3, 5, preset), { delay: 3, chunkSeconds: 3 });
  assert.deepEqual(captureModeSettings('replay', 3, 5, preset), { delay: 20, chunkSeconds: 10 });
  assert.deepEqual(captureModeSettings('replay', 12, 6, preset), { delay: 20, chunkSeconds: 10 });
  assert.deepEqual(captureModeSettings('replay', 26, 12, preset), { delay: 26, chunkSeconds: 12 });
});

test('captions follow playback time, not inference completion or wall clock', () => {
  const rows = [{ start: 0.7, end: 2, text: 'first' }, { start: 3, end: 4, text: 'second' }];
  assert.deepEqual(captionsAt(rows, 0), []);
  assert.equal(captionsAt(rows, 1)[0].text, 'first');
  assert.deepEqual(captionsAt(rows, 2), []);
  assert.equal(captionsAt(rows, 2.5, 0.7)[0].text, 'second');
  assert.equal(captionsAt(rows, 3.2, -2)[0].text, 'first');
});

test('first playback waits for the selected audiovisual buffer', () => {
  const base = { playing: true, current: 0, delay: 20, readyUntil: 5, waitForSubtitles: true, primed: false };
  assert.equal(playbackDecision({ ...base, bufferedEnd: 19 }).reason, 'buffering');
  assert.equal(playbackDecision({ ...base, bufferedEnd: 20 }).play, true);
});

test('once primed, both video and audio pause before unprocessed speech', () => {
  const base = { playing: true, current: 4.7, bufferedEnd: 24, delay: 20, readyUntil: 5, waitForSubtitles: true, primed: true };
  assert.equal(playbackDecision(base).reason, 'inference');
  assert.equal(playbackDecision({ ...base, readyUntil: 10 }).play, true);
  assert.equal(playbackDecision({ ...base, waitForSubtitles: false }).play, true);
  assert.equal(playbackDecision({ ...base, playing: false, readyUntil: 10 }).reason, 'paused');
});

test('a completed silence window can play, a depleted buffer waits', () => {
  const base = { playing: true, current: 1, bufferedEnd: 2, delay: 20, readyUntil: 5, waitForSubtitles: true, primed: true };
  assert.equal(playbackDecision(base).play, true);
  assert.equal(playbackDecision({ ...base, current: 1.8 }).reason, 'buffering');
});

test('upload is a genuine little endian mono 16kHz PCM16 WAV', () => {
  const result = wav16(new Int16Array([-32768, 0, 32767]));
  const view = new DataView(result);
  assert.equal(new TextDecoder().decode(result.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(result.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(48, true), 32767);
});

test('worklet captures configured eight-second stereo input as mono 16kHz WAV', () => {
  let Processor;
  const messages = [];
  vm.runInNewContext(readFileSync(new URL('./audio-worklet.js', import.meta.url), 'utf8'), {
    sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: value => messages.push(value) }; } },
    registerProcessor: (_name, value) => { Processor = value; },
  });
  const processor = new Processor();
  processor.port.onmessage({ data: { type: 'start', chunkSeconds: 8 } });
  for (let block = 0; block < 3000; block++) processor.process([[new Float32Array(128).fill(.5), new Float32Array(128).fill(-.25)]]);
  const previews = messages.filter(message => message.preview);
  assert.deepEqual(previews.map(message => message.samples.byteLength / 2), [20000, 40000, 60000, 80000, 100000]);
  assert.ok(previews.every(message => message.start === 0));
  const [final] = messages.filter(message => !message.preview);
  assert.equal(messages.length, previews.length + 1);
  assert.equal(final.start, 0);
  assert.equal(final.end, 8);
  const samples = new Int16Array(final.samples);
  assert.equal(samples.length, 128000);
  assert.equal(samples[0], 4096);
  const wav = new DataView(wav16(samples));
  assert.equal(wav.byteLength, 256044);
  assert.equal(wav.getUint16(22, true), 1);
  assert.equal(wav.getUint32(24, true), 16000);
  assert.equal(wav.getUint32(40, true), 256000);
  processor.port.onmessage({ data: 'stop' });
  processor.process([[new Float32Array(128)]]);
  assert.equal(messages.length, previews.length + 1);
});
