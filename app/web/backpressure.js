// A monotonic clock is supplied by the player (or by deterministic tests).
export const MAX_QUEUED_AUDIO_SECONDS = 180;
const presetSeconds = { high: 20, balanced: 35, low: 60 };
export function initialBackpressure(preset = 'high') {
  return { phase: 'idle', baseSeconds: presetSeconds[preset] || 20, ratios: [], startedAt: null, deadline: null, totalSeconds: 0, healthySince: null };
}
export function recordInferenceTiming(state, elapsedMs, audioSeconds) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || !Number.isFinite(audioSeconds) || audioSeconds <= 0) return state;
  return { ...state, ratios: [...state.ratios, elapsedMs / (audioSeconds * 1000)].slice(-3) };
}
export function beginBackpressure(state, now) {
  if (state.phase !== 'idle') return state;
  const ratio = state.ratios.length ? state.ratios.reduce((sum, value) => sum + value, 0) / state.ratios.length : 1;
  const totalSeconds = Math.min(120, Math.ceil(state.baseSeconds * Math.max(1, ratio)));
  return { ...state, phase: 'cooldown', startedAt: now, deadline: now + totalSeconds * 1000, totalSeconds, healthySince: null };
}
export function backpressureStatus(state, now) {
  const remainingSeconds = state.phase === 'cooldown' ? Math.min(state.totalSeconds, Math.max(0, Math.ceil((state.deadline - now) / 1000))) : 0;
  return { active: state.phase === 'cooldown' && now < state.deadline, expired: state.phase === 'cooldown' && now >= state.deadline, totalSeconds: state.totalSeconds, remainingSeconds };
}
export function finishBackpressure(state) {
  return state.phase === 'cooldown' ? { ...state, phase: 'fallback', healthySince: null } : state;
}
export function settleBackpressure(state, { now, healthy }) {
  if (state.phase !== 'fallback') return state;
  if (!healthy) return state.healthySince === null ? state : { ...state, healthySince: null };
  if (state.healthySince === null) return { ...state, healthySince: now };
  return now - state.healthySince >= 30000 ? { ...state, phase: 'idle', healthySince: null } : state;
}

export function initialSongBuffer(delay) {
  return { delay, limit: Math.min(120, delay + 12), waiting: false, waitedMs: 0, lastWaitAt: null };
}

export function observeSongBuffer(buffer, now, waiting) {
  if (!waiting || buffer.delay >= buffer.limit) {
    buffer.waiting = false;
    return false;
  }
  const elapsed = buffer.lastWaitAt === null ? Infinity : now - buffer.lastWaitAt;
  if (elapsed > 10000) buffer.waitedMs = 0;
  else if (buffer.waiting) buffer.waitedMs += Math.min(elapsed, 250);
  buffer.waiting = true;
  buffer.lastWaitAt = now;
  if (buffer.waitedMs < 1500) return false;

  buffer.delay = Math.min(buffer.limit, buffer.delay + 3);
  buffer.waitedMs = 0;
  buffer.waiting = false;
  return true;
}

export function addCompletedWindow(windows, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return windows;
  const merged = [];
  for (const window of [...windows, [start, end]].sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && window[0] <= previous[1] + 0.000001) previous[1] = Math.max(previous[1], window[1]);
    else merged.push([...window]);
  }
  return merged.slice(-128);
}
export function completedThrough(windows, current) {
  return windows.find(([start, end]) => start <= current + 0.000001 && end > current)?.[1] ?? current;
}
export function chooseResumePosition({ ranges, completed, current, floor = current, delay }) {
  const minimum = Math.max(current, floor);
  const viable = ranges.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end - start >= 0.75 && end > minimum + 0.5);
  // Never use an old completion before the retained audio window as proof
  // that skipped speech has captions. Prefer the newest checked intersection.
  for (const [start, end] of [...viable].reverse()) {
    for (const [checkedStart, checkedEnd] of [...completed].reverse()) {
      const position = Math.max(minimum, start + 0.05, checkedStart);
      if (position + 0.5 < Math.min(end, checkedEnd)) return { position, captionsReady: true, readyUntil: checkedEnd, waitingForMedia: false };
    }
  }
  const range = viable.at(-1);
  if (!range) return { position: current, captionsReady: false, readyUntil: current, waitingForMedia: true };
  const [start, end] = range;
  const position = Math.min(end - 0.5, Math.max(minimum, start + 0.05, end - Math.max(1, delay)));
  return { position, captionsReady: false, readyUntil: completedThrough(completed, position), waitingForMedia: false };
}
