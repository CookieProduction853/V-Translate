/* Pure timeline helpers are shared by the player and its Node tests. */
export function captionsAt(segments, playbackTime, offset = 0) {
  const time = playbackTime + offset;
  return segments.filter(segment => segment.start <= time && time < segment.end);
}

export function playbackDecision({ playing, current, bufferedEnd, delay, readyUntil, waitForSubtitles, primed }) {
  if (!playing) return { play: false, reason: 'paused' };
  const lead = bufferedEnd - current;
  if (!primed && lead < delay) return { play: false, reason: 'buffering' };
  if (lead < 0.5) return { play: false, reason: 'buffering' };
  // Pause before the next configured inference window until it has finished.
  if (waitForSubtitles && current + 0.35 >= readyUntil) return { play: false, reason: 'inference' };
  return { play: true, reason: 'playing' };
}

export function captureModeSettings(mode, delay, chunkSeconds, preset) {
  if (mode === 'replay') return { delay: Math.max(delay, 20), chunkSeconds: Math.max(chunkSeconds, 10) };
  if (mode === 'chat') {
    delay = Math.min(delay, preset.buffer_seconds);
    chunkSeconds = Math.min(chunkSeconds, preset.chunk_seconds);
  }
  return { delay, chunkSeconds: Math.min(chunkSeconds, delay) };
}

export function wav16(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, sample)), true));
  return buffer;
}
