(() => {
  const items = [
    ['/', 'Галерея'],
    ['/animation', 'Анимация по тексту'],
    ['/generate-model', '3D по картинке'],
    ['/playground', 'Playground'],
    ['/profiles', 'Авторы'],
    ['/profile', 'Профиль / Войти'],
  ];

  function renderLinks() {
    const current = location.pathname.replace(/\/+$/, '') || '/';
    document.querySelectorAll('.studio-legacy-links').forEach((nav) => {
      nav.replaceChildren(...items.map(([href, label]) => {
        const link = document.createElement('a');
        link.href = href;
        link.textContent = label;
        if (href === current || (href === '/profiles' && current.startsWith('/profile/'))) {
          link.setAttribute('aria-current', 'page');
        }
        const arrow = document.createElement('span');
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = href === current ? '•' : '↗';
        link.append(arrow);
        return link;
      }));
    });
    document.querySelectorAll('.studio-legacy-mobile summary small').forEach((label) => {
      label.textContent = 'Галерея · 3D · Анимация';
    });
  }

  const style = document.createElement('style');
  style.textContent = '.studio-legacy-nav a[aria-current="page"]{background:#1b4345;border-color:#4c9290;color:#c6fff1;pointer-events:none}.studio-legacy-nav a[aria-current="page"] span{color:#8fe0d5}';
  document.head.append(style);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderLinks, { once: true });
  else renderLinks();
})();
