(() => {
  const themes = { classic: '暖白・珊瑚紅', sakura: '櫻花・奶油粉', midnight: '午夜・電光青', matcha: '抹茶・日系書刊' };
  const params = new URLSearchParams(location.search);
  const theme = Object.hasOwn(themes, params.get('theme')) ? params.get('theme') : 'matcha';
  document.documentElement.dataset.theme = theme;
  if (params.get('preview') === '1') {
    document.addEventListener('DOMContentLoaded', () => {
      const bar = document.createElement('aside');
      bar.className = 'design-toolbar';
      bar.setAttribute('aria-label', '設計預覽工具');
      const back = document.createElement('a');
      back.href = 'designs.html';
      back.textContent = '← 比較全部設計';
      const label = document.createElement('label');
      label.htmlFor = 'design-choice';
      label.textContent = '目前風格';
      const select = document.createElement('select');
      select.id = 'design-choice';
      for (const [value, title] of Object.entries(themes)) {
        const option = new Option(title, value, false, value === theme);
        select.add(option);
      }
      select.addEventListener('change', () => {
        params.set('theme', select.value);
        location.search = params.toString();
      });
      bar.append(back, label, select);
      document.body.prepend(bar);
    });
  }
})();
