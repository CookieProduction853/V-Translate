import test from 'node:test';
import assert from 'node:assert/strict';
import { initialBackpressure, recordInferenceTiming, beginBackpressure, backpressureStatus, finishBackpressure, settleBackpressure, initialSongBuffer, observeSongBuffer, addCompletedWindow, completedThrough, chooseResumePosition } from './backpressure.js';
import { playbackDecision } from './timeline.js';

test('Song Mode grows the delay after repeated waits, and waits for the new buffer before playing', () => {
  const buffer = initialSongBuffer(8);
  for (let now = 0; now <= 800; now += 200) assert.equal(observeSongBuffer(buffer, now, true), false);
  assert.equal(observeSongBuffer(buffer, 1000, false), false);
  for (let now = 1200; now <= 1800; now += 200) assert.equal(observeSongBuffer(buffer, now, true), false);
  assert.equal(observeSongBuffer(buffer, 2000, true), true);
  assert.equal(buffer.delay, 11);
  const play = { playing: true, current: 4, delay: buffer.delay, readyUntil: 5, waitForSubtitles: true, primed: false };
  assert.equal(playbackDecision({ ...play, bufferedEnd: 14.9 }).reason, 'buffering');
  assert.equal(playbackDecision({ ...play, bufferedEnd: 15 }).play, true);
  assert.equal(initialSongBuffer(8).delay, 8);
});

test('Song Mode forgets isolated waits and caps the extra delay', () => {
  const buffer = initialSongBuffer(116);
  for (let now = 0; now <= 1000; now += 200) observeSongBuffer(buffer, now, true);
  observeSongBuffer(buffer, 1020, false);
  assert.equal(observeSongBuffer(buffer, 12000, true), false);
  assert.equal(buffer.waitedMs, 0);
  for (let now = 12200; now <= 18000; now += 200) observeSongBuffer(buffer, now, true);
  assert.equal(buffer.delay, 120);
  assert.equal(observeSongBuffer(buffer, 18200, true), false);
  assert.equal(initialSongBuffer(8).limit, 20);
});

test('performance presets provide visible 20 / 35 / 60 second starting estimates', () => {
  for (const [preset, seconds] of [['high', 20], ['balanced', 35], ['low', 60]]) {
    const state = beginBackpressure(initialBackpressure(preset), 500);
    assert.deepEqual(backpressureStatus(state, 500), { active: true, expired: false, totalSeconds: seconds, remainingSeconds: seconds });
  }
});
test('recent inference speed lengthens the estimate and caps a slow machine at 120 seconds', () => {
  let state = initialBackpressure('high');
  for (const ms of [5000, 10000, 15000, 20000]) state = recordInferenceTiming(state, ms, 5);
  assert.deepEqual(state.ratios, [2, 3, 4]);
  assert.equal(beginBackpressure(state, 0).totalSeconds, 60);
  assert.equal(beginBackpressure(recordInferenceTiming(initialBackpressure('low'), 100000, 5), 0).totalSeconds, 120);
  assert.equal(recordInferenceTiming(state, Infinity, 5), state);
  assert.equal(recordInferenceTiming(state, 5000, 0), state);
});
test('new pressure and late timing samples never reset an active countdown deadline', () => {
  const initial = beginBackpressure(initialBackpressure(), 1000);
  const later = recordInferenceTiming(initial, 20000, 5);
  assert.equal(beginBackpressure(later, 9000), later);
  assert.equal(later.deadline, 21000);
  assert.equal(backpressureStatus(later, 999).remainingSeconds, 20, 'a preceding animation timestamp cannot flash 21 seconds');
  assert.equal(backpressureStatus(later, 9500).remainingSeconds, 12);
  assert.equal(backpressureStatus(later, 21000).expired, true);
  assert.equal(backpressureStatus(later, 22000).remainingSeconds, 0);
});
test('an overloaded machine cannot immediately start another pause after the first countdown', () => {
  const fallback = finishBackpressure(beginBackpressure(initialBackpressure(), 0));
  assert.equal(beginBackpressure(fallback, 21000), fallback);
  let state = settleBackpressure(fallback, { now: 25000, healthy: true });
  state = settleBackpressure(state, { now: 50000, healthy: false });
  assert.equal(state.healthySince, null);
  state = settleBackpressure(state, { now: 60000, healthy: true });
  assert.equal(settleBackpressure(state, { now: 89999, healthy: true }).phase, 'fallback');
  state = settleBackpressure(state, { now: 90000, healthy: true });
  assert.equal(state.phase, 'idle');
  assert.equal(beginBackpressure(state, 90000).phase, 'cooldown');
});
test('silence counts as checked audio but skipped and failed speech gaps stay unchecked', () => {
  let windows = addCompletedWindow([], 0, 5);
  windows = addCompletedWindow(windows, 10, 15);
  assert.equal(completedThrough(windows, 7), 7);
  assert.equal(completedThrough(windows, 12), 15);
  windows = addCompletedWindow(windows, 5, 10);
  assert.deepEqual(windows, [[0, 15]]);
  assert.equal(completedThrough(windows, 14), 15);
  assert.equal(completedThrough(windows, 15), 15);
  for (let i = 0; i < 200; i++) windows = addCompletedWindow(windows, 100 + i * 2, 101 + i * 2);
  assert.equal(windows.length, 128);
});
test('resume prefers real completed audio after the fresh-window floor, inside a buffered range', () => {
  const result = chooseResumePosition({ ranges: [[0, 30], [150, 210]], completed: [[0, 25], [175, 185]], current: 20, floor: 170, delay: 20 });
  assert.equal(result.position, 175);
  assert.equal(result.captionsReady, true);
  assert.equal(result.readyUntil, 185);
});
test('a stale old completion cannot label fresh resumed media as subtitle-ready', () => {
  const result = chooseResumePosition({ ranges: [[0, 210]], completed: [[0, 200]], current: 0, floor: 202, delay: 20 });
  assert.equal(result.position, 202);
  assert.equal(result.captionsReady, false);
  assert.equal(result.waitingForMedia, false);
});
test('resume does not rewind, seek into a gap, or seek beyond available media', () => {
  for (const current of [50, 100, 205]) {
    const result = chooseResumePosition({ ranges: [[0, 30], [180, 210]], completed: [], current, floor: current, delay: 20 });
    assert.ok(result.position >= current);
    assert.ok(result.position >= 180 && result.position <= 209.5);
  }
  const empty = chooseResumePosition({ ranges: [[0, 10]], completed: [], current: 5, floor: 20, delay: 20 });
  assert.equal(empty.position, 5);
  assert.equal(empty.waitingForMedia, true);
});
test('manual pause wins even with missing captions or media, including after countdown expiry', () => {
  assert.equal(playbackDecision({ playing: false, current: 100, bufferedEnd: 100, delay: 20, readyUntil: 0, waitForSubtitles: true, primed: false }).reason, 'paused');
});
