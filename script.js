// Set this to the YouTube video ID when the demo is available.
const YOUTUBE_DEMO_ID = '';
if (/^[\w-]{11}$/.test(YOUTUBE_DEMO_ID)) {
  const frame = document.createElement('iframe');
  frame.src = `https://www.youtube-nocookie.com/embed/${YOUTUBE_DEMO_ID}`;
  frame.title = '油字幕 V-Translate 實際使用示範';
  frame.loading = 'lazy';
  frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
  frame.allowFullscreen = true;
  document.getElementById('video-shell').replaceChildren(frame);
}
