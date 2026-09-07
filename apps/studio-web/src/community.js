import './style.css';
import './community.css';

const API = '/api/model-studio';
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const paths = {
  cube: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m3 7 9 5 9-5M12 12v10M7.5 4.5l9 5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  comment: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 1 1 19 0Z"/><path d="M7 9h9M7 13h6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  play: '<path d="m8 4 12 8-12 8V4Z"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  logout: '<path d="M9 4H4v16h5M10 12h11m-4-4 4 4-4 4"/>',
};
const icon = (name) => `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none">${paths[name] || paths.cube}</svg></span>`;
const profileUrl = (user) => `/profile/${encodeURIComponent(user.username)}`;
const displayName = (user) => user?.displayName || user?.username || 'Автор без профиля';
const modelTitle = (model) => model?.title || `Модель ${String(model?.id || '').slice(0, 6)}`;
const date = (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? '' : parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
};
const plural = (number, one, few, many) => {
  const value = Math.abs(Number(number) || 0);
  return `${value.toLocaleString('ru-RU')} ${value % 100 >= 11 && value % 100 <= 14 ? many : value % 10 === 1 ? one : value % 10 >= 2 && value % 10 <= 4 ? few : many}`;
};
const initials = (user) => [...displayName(user).trim()].slice(0, 2).join('').toUpperCase();
const avatar = (user, large = false) => `<span class="community-avatar${large ? ' community-avatar-large' : ''}" aria-hidden="true">${escape(initials(user))}</span>`;
const noticeMarkup = (message, retry = false) => `<div class="community-empty"><span class="community-empty-icon">${icon('cube')}</span><p>${escape(message)}</p>${retry ? '<button class="button button-quiet button-small" type="button" data-retry>Попробовать ещё раз</button>' : ''}</div>`;

async function request(path, { method = 'GET', body, signal } = {}) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 30000);
  const abort = () => timeout.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(`${API}${path}`, {
      method, credentials: 'same-origin', cache: 'no-store', signal: timeout.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = result.detail || result.error;
      const error = new Error(typeof detail === 'string' ? detail : response.status === 401 ? 'Войди в профиль, чтобы продолжить.' : response.status === 404 ? 'Эта страница недоступна. Возможно, модель стала приватной или была удалена.' : `Не удалось выполнить запрос (${response.status}). Попробуй ещё раз.`);
      error.status = response.status;
      throw error;
    }
    return result;
  } catch (error) {
    if (error.name === 'AbortError' && !signal?.aborted) throw new Error('Сервер отвечает дольше обычного. Попробуй ещё раз.');
    if (error instanceof TypeError) throw new Error('Не удалось связаться со студией. Проверь подключение.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

let currentUser = null;
let authLoaded = false;
let authPromise = null;
async function loadAuth(force = false) {
  if (authPromise) return authPromise;
  if (authLoaded && !force) return currentUser;
  authPromise = request('/auth/me').then(({ user }) => {
    currentUser = user || null;
    authLoaded = true;
    updateHeaderAccount();
    return currentUser;
  }).finally(() => { authPromise = null; });
  return authPromise;
}
function setAuth(user) {
  currentUser = user || null;
  authLoaded = true;
  updateHeaderAccount();
  window.dispatchEvent(new CustomEvent('community:auth-changed', { detail: { user: currentUser } }));
}
function notify(message) {
  let toast = document.getElementById('community-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'community-toast';
    toast.className = 'community-toast';
    toast.setAttribute('role', 'status');
    document.body.append(toast);
  }
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toast.hideTimer);
  toast.hideTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

let authDialog;
let authMode = 'login';
let authBusy = false;
let authResolver = null;
function ensureAuthDialog() {
  if (authDialog?.isConnected) return authDialog;
  authDialog = document.createElement('dialog');
  authDialog.className = 'community-dialog community-auth-dialog';
  authDialog.setAttribute('aria-labelledby', 'community-auth-title');
  document.body.append(authDialog);
  authDialog.addEventListener('click', (event) => {
    const bounds = authDialog.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (event.target === authDialog && outside && !authBusy) authDialog.close();
  });
  authDialog.addEventListener('cancel', (event) => { if (authBusy) event.preventDefault(); });
  authDialog.addEventListener('close', () => {
    authResolver?.(currentUser);
    authResolver = null;
  });
  return authDialog;
}
function renderAuthDialog() {
  const registration = authMode === 'register';
  authDialog.innerHTML = `
    <div class="community-dialog-heading"><span class="community-dialog-mark">${icon('cube')}</span><button type="button" class="icon-button" data-auth-close aria-label="Закрыть окно входа">${icon('close')}</button></div>
    <div class="eyebrow">ТВОЁ МЕСТО В СТУДИИ</div>
    <h2 id="community-auth-title">${registration ? 'Создай свой профиль' : 'С возвращением'}</h2>
    <p class="community-dialog-intro">${registration ? 'Собери модели в одном профиле, делись работами и обсуждай идеи.' : 'Твои модели, настройки и обсуждения — в одном месте.'}</p>
    <div class="community-auth-tabs" role="group" aria-label="Вход или регистрация"><button type="button" data-auth-tab="login" aria-pressed="${!registration}">Войти</button><button type="button" data-auth-tab="register" aria-pressed="${registration}">Регистрация</button></div>
    <form id="community-auth-form" class="community-form">
      <label>Имя пользователя<input name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="24" pattern="[A-Za-z0-9_]{3,24}" required placeholder="например, polygon_master" aria-describedby="community-username-hint" /></label>
      <p class="community-field-note" id="community-username-hint">Латинские буквы, цифры и _ · от 3 до 24 символов.</p>
      ${registration ? '<label>Как тебя показывать<input name="displayName" type="text" autocomplete="nickname" maxlength="60" placeholder="Имя или псевдоним" /></label>' : ''}
      <label>Пароль<span class="community-password"><input name="password" type="password" autocomplete="${registration ? 'new-password' : 'current-password'}" minlength="8" maxlength="128" required placeholder="Минимум 8 символов" /><button type="button" data-password-toggle aria-label="Показать пароль" aria-pressed="false">Показать</button></span></label>
      <p class="community-form-error" role="alert" hidden></p>
      <button type="submit" class="button button-primary community-auth-submit">${registration ? 'Зарегистрироваться' : 'Войти в профиль'}${icon('arrow')}</button>
      ${registration ? '<p class="community-field-note community-auth-note">Готовые модели из этого браузера будут привязаны к профилю. Приватные работы останутся приватными.</p>' : ''}
    </form>`;
  authDialog.querySelector('[data-auth-close]').addEventListener('click', () => authDialog.close());
  authDialog.querySelectorAll('[data-auth-tab]').forEach((button) => button.addEventListener('click', () => {
    if (authBusy || button.dataset.authTab === authMode) return;
    const username = authDialog.querySelector('[name=username]').value;
    authMode = button.dataset.authTab;
    renderAuthDialog();
    authDialog.querySelector('[name=username]').value = username;
    authDialog.querySelector('[name=username]').focus();
  }));
  authDialog.querySelector('[data-password-toggle]').addEventListener('click', (event) => {
    const input = authDialog.querySelector('[name=password]');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    event.currentTarget.textContent = reveal ? 'Скрыть' : 'Показать';
    event.currentTarget.setAttribute('aria-label', reveal ? 'Скрыть пароль' : 'Показать пароль');
    event.currentTarget.setAttribute('aria-pressed', String(reveal));
  });
  authDialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (authBusy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const error = form.querySelector('[role=alert]');
    error.hidden = true;
    authBusy = true;
    authDialog.querySelectorAll('button,input').forEach((element) => { element.disabled = true; });
    form.querySelector('[type=submit]').textContent = registration ? 'Создаём профиль…' : 'Входим…';
    try {
      const { user } = await request(`/auth/${registration ? 'register' : 'login'}`, { method: 'POST', body: {
        username: String(data.get('username')).trim(), password: String(data.get('password')),
        ...(registration ? { displayName: String(data.get('displayName') || '').trim() || String(data.get('username')).trim() } : {}),
      } });
      setAuth(user);
      authDialog.querySelector('[name=password]').value = '';
      authDialog.close();
      notify(registration ? 'Профиль создан. Добро пожаловать в студию!' : `С возвращением, ${displayName(user)}!`);
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      authBusy = false;
      authDialog.querySelectorAll('button,input').forEach((element) => { element.disabled = false; });
      form.querySelector('[type=submit]').innerHTML = `${registration ? 'Зарегистрироваться' : 'Войти в профиль'}${icon('arrow')}`;
    }
  });
}
function openAuth(mode = 'login') {
  ensureAuthDialog();
  if (authDialog.open) return Promise.resolve(null);
  authMode = mode;
  renderAuthDialog();
  const result = new Promise((resolve) => { authResolver = resolve; });
  authDialog.showModal();
  authDialog.querySelector('[name=username]').focus();
  return result;
}

const navItems = [
  ['/', 'Анимация по тексту', 'play', 'Придумай движение'],
  ['/generate-model', '3D по картинке', 'image', 'Создай свою модель'],
  ['/playground', 'Playground', 'cube', 'Движение и физика'],
  ['/gallery', 'Галерея', 'grid', 'Работы сообщества'],
  ['/profiles', 'Авторы', 'user', 'Люди и их модели'],
];
const routeActive = (path) => path === '/' ? location.pathname === '/' : location.pathname === path || (path === '/profiles' && location.pathname.startsWith('/profile/'));
let menuDialog;
let menuButton;
let headerAccount;
function accountMarkup(mobile = false) {
  if (!authLoaded) return '<span class="community-account-pending" role="status">Загружаем профиль…</span>';
  if (currentUser) return `<a class="community-account-link" href="/profile">${avatar(currentUser)}<span>${escape(displayName(currentUser))}${mobile ? `<small>@${escape(currentUser.username)}</small>` : ''}</span></a><button class="${mobile ? 'button button-quiet' : 'community-logout icon-button'}" type="button" data-community-logout aria-label="Выйти из профиля">${icon('logout')}${mobile ? 'Выйти' : ''}</button>`;
  return `<button type="button" class="button button-quiet button-small" data-community-auth="login">Войти</button><button type="button" class="button button-primary button-small" data-community-auth="register">Регистрация</button>`;
}
function bindAccountActions(container) {
  container.querySelectorAll('[data-community-auth]').forEach((button) => button.addEventListener('click', () => {
    if (menuDialog?.open) menuDialog.close();
    openAuth(button.dataset.communityAuth);
  }));
  container.querySelectorAll('[data-community-logout]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await request('/auth/logout', { method: 'POST' });
      if (menuDialog?.open) menuDialog.close();
      setAuth(null);
      notify('Ты вышел из профиля.');
    } catch (error) { notify(error.message); button.disabled = false; }
  }));
}
function updateHeaderAccount() {
  if (headerAccount?.isConnected) {
    headerAccount.innerHTML = accountMarkup();
    bindAccountActions(headerAccount);
  }
  const mobileAccount = menuDialog?.querySelector('.community-menu-account');
  if (mobileAccount) { mobileAccount.innerHTML = accountMarkup(true); bindAccountActions(mobileAccount); }
}

export function mountCommunityHeader() {
  const header = document.querySelector('.site-header');
  if (!header || header.dataset.communityMounted) return;
  header.dataset.communityMounted = 'true';
  header.classList.add('community-header');
  const inner = header.querySelector('.header-inner');
  let nav = inner.querySelector('.main-nav');
  if (!nav) { nav = document.createElement('nav'); nav.className = 'main-nav'; inner.append(nav); }
  nav.setAttribute('aria-label', 'Главное меню');
  nav.innerHTML = navItems.map(([path, label]) => `<a href="${path}"${routeActive(path) ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  headerAccount = document.createElement('div');
  headerAccount.className = 'community-header-account';
  inner.append(headerAccount);
  menuButton = document.createElement('button');
  menuButton.type = 'button';
  menuButton.className = 'community-menu-toggle';
  menuButton.setAttribute('aria-label', 'Открыть меню');
  menuButton.setAttribute('aria-haspopup', 'dialog');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-controls', 'community-mobile-menu');
  menuButton.innerHTML = icon('menu');
  inner.append(menuButton);
  menuDialog = document.createElement('dialog');
  menuDialog.id = 'community-mobile-menu';
  menuDialog.className = 'community-menu-dialog';
  menuDialog.setAttribute('aria-labelledby', 'community-menu-title');
  menuDialog.innerHTML = `<div class="community-menu-heading"><a href="/generate-model" class="brand">${icon('cube')}<span>models<span class="brand-dot">.</span><span class="brand-domain">xedoc</span></span></a><button class="icon-button" type="button" aria-label="Закрыть меню" data-close-menu>${icon('close')}</button></div><div class="community-menu-body"><div class="eyebrow" id="community-menu-title">СОЗДАВАЙ. СМОТРИ. ДЕЛИСЬ.</div><nav aria-label="Мобильное меню">${navItems.map(([path, label, symbol, subtitle], index) => `<a href="${path}"${routeActive(path) ? ' aria-current="page"' : ''}><span class="community-menu-icon">${icon(symbol)}</span><span><strong>${label}</strong><small>${subtitle}</small></span><span class="community-menu-number">0${index + 1}</span>${icon('arrow')}</a>`).join('')}</nav><div class="community-menu-account"></div><p class="community-menu-footer">Из идеи — в третье измерение.</p></div>`;
  document.body.append(menuDialog);
  menuButton.addEventListener('click', () => { menuDialog.showModal(); menuButton.setAttribute('aria-expanded', 'true'); });
  menuDialog.querySelector('[data-close-menu]').addEventListener('click', () => menuDialog.close());
  menuDialog.addEventListener('click', (event) => {
    const bounds = menuDialog.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (event.target === menuDialog && outside) menuDialog.close();
  });
  menuDialog.addEventListener('close', () => { menuButton.setAttribute('aria-expanded', 'false'); menuButton.focus(); });
  const wideScreen = matchMedia('(min-width: 1221px)');
  wideScreen.addEventListener('change', () => { if (wideScreen.matches && menuDialog.open) menuDialog.close(); });
  updateHeaderAccount();
  loadAuth().catch(() => {
    authLoaded = true;
    updateHeaderAccount();
  });
}

function modelCard(model) {
  const author = model.author;
  return `<article class="community-model-card"><a class="community-model-cover" href="/playground?model=${encodeURIComponent(model.id)}" aria-label="Открыть модель: ${escape(modelTitle(model))}"><span class="community-model-fallback" aria-hidden="true">${icon('cube')}<span>3D / MODEL</span></span>${model.previewUrl ? `<img src="${escape(model.previewUrl)}" alt="${escape(modelTitle(model))}" loading="lazy" decoding="async" />` : ''}<span class="community-cover-label">${model.hasRig ? 'Скелет · GLB' : 'GLB · 3D'}</span><span class="community-cover-open">Смотреть ${icon('arrow')}</span></a><div class="community-model-info"><a class="community-model-title" href="/playground?model=${encodeURIComponent(model.id)}">${escape(modelTitle(model))}</a><div class="community-model-meta">${author ? `<a class="community-author" href="${profileUrl(author)}">${avatar(author)}<span>${escape(displayName(author))}</span></a>` : '<span class="community-author community-author-anonymous">Автор без профиля</span>'}<a class="community-comment-count" href="/playground?model=${encodeURIComponent(model.id)}#comments" aria-label="${escape(plural(model.commentsCount, 'комментарий', 'комментария', 'комментариев'))}">${icon('comment')}<span>${Number(model.commentsCount) || 0}</span></a></div></div></article>`;
}
function profileCard(user) {
  return `<a class="community-profile-card" href="${profileUrl(user)}">${avatar(user, true)}<div><h3>${escape(displayName(user))}</h3><span class="community-handle">@${escape(user.username)}</span><p>${escape(user.bio || 'Создаёт объекты и персонажей в 3D.')}</p><span class="community-profile-count">${icon('cube')}${escape(plural(user.modelCount, 'модель', 'модели', 'моделей'))}</span></div>${icon('arrow')}</a>`;
}
function bindImageFallbacks(element) {
  element.querySelectorAll('.community-model-cover img').forEach((image) => {
    image.addEventListener('error', () => { image.hidden = true; }, { once: true });
  });
}

function createCollection(element, { limit = 12, preview = false, kind = 'models', author = '', query = '', updateUrl = false, showSearch = true } = {}) {
  let currentKind = kind;
  let currentQuery = query;
  let currentOffset = 0;
  let currentTotal = 0;
  let sequence = 0;
  let controller = null;
  let searchTimer;
  let destroyed = false;
  element.innerHTML = `${showSearch ? `<form class="community-search" role="search"><label class="community-search-input">${icon('search')}<span class="sr-only">Поиск моделей и авторов</span><input type="search" name="q" maxlength="100" placeholder="Найди модель или автора" value="${escape(query)}" autocomplete="off" /></label><select name="kind" aria-label="Искать среди"><option value="models"${kind === 'models' ? ' selected' : ''}>Моделей</option><option value="profiles"${kind === 'profiles' ? ' selected' : ''}>Авторов</option></select><button type="submit" class="button button-secondary">Найти${icon('arrow')}</button></form>` : ''}<div class="community-collection-status" role="status" aria-live="polite"></div><div class="community-collection-grid"></div><div class="community-pagination"><button class="button button-quiet" type="button" data-load-more hidden>Показать ещё${icon('arrow')}</button><a class="button button-quiet" href="${kind === 'profiles' ? '/profiles' : '/gallery'}" data-open-collection hidden>Смотреть всю галерею${icon('arrow')}</a></div>`;
  const grid = element.querySelector('.community-collection-grid');
  const status = element.querySelector('.community-collection-status');
  const more = element.querySelector('[data-load-more]');
  const all = element.querySelector('[data-open-collection]');
  function queryString(offset) {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (currentQuery) params.set('q', currentQuery);
    if (author && currentKind === 'models') params.set('author', author);
    return params;
  }
  async function refresh(append = false) {
    if (destroyed) return;
    const requestId = ++sequence;
    controller?.abort();
    controller = new AbortController();
    if (!append) currentOffset = 0;
    grid.setAttribute('aria-busy', 'true');
    status.textContent = append ? 'Загружаем ещё…' : 'Загружаем…';
    if (!append) grid.innerHTML = Array.from({ length: preview ? 4 : 6 }, () => '<div class="community-card-skeleton" aria-hidden="true"><span></span><i></i><i></i></div>').join('');
    more.disabled = true;
    all.hidden = true;
    try {
      const data = await request(`${currentKind === 'profiles' ? '/profiles' : '/gallery'}?${queryString(currentOffset)}`, { signal: controller.signal });
      if (requestId !== sequence || destroyed) return;
      const items = currentKind === 'profiles' ? data.profiles : data.models;
      currentTotal = Number(data.total) || 0;
      if (!append) grid.innerHTML = '';
      grid.classList.toggle('community-profiles-grid', currentKind === 'profiles');
      grid.insertAdjacentHTML('beforeend', (items || []).map(currentKind === 'profiles' ? profileCard : modelCard).join(''));
      bindImageFallbacks(grid);
      currentOffset += (items || []).length;
      status.textContent = currentKind === 'profiles' ? plural(currentTotal, 'автор', 'автора', 'авторов') : plural(currentTotal, 'модель', 'модели', 'моделей');
      if (!currentTotal) {
        grid.innerHTML = noticeMarkup(currentQuery ? 'Ничего не нашлось. Попробуй другое имя или название.' : currentKind === 'profiles' ? 'Здесь скоро появятся первые авторы.' : author ? 'У автора пока нет публичных моделей.' : 'Здесь появятся публичные модели. Создай свою и стань первым!');
      }
      more.hidden = preview || currentOffset >= currentTotal;
      all.hidden = !preview || currentTotal <= limit;
      const search = new URLSearchParams();
      if (currentQuery) search.set('q', currentQuery);
      all.href = `${currentKind === 'profiles' ? '/profiles' : '/gallery'}${search.size ? `?${search}` : ''}`;
      all.innerHTML = `${currentKind === 'profiles' ? 'Все авторы' : 'Вся галерея'}${icon('arrow')}`;
    } catch (error) {
      if (requestId !== sequence || destroyed || error.name === 'AbortError') return;
      status.textContent = '';
      if (!append) { grid.innerHTML = noticeMarkup(error.message, true); grid.querySelector('[data-retry]').addEventListener('click', () => refresh()); }
      else { status.textContent = error.message; more.hidden = false; }
    } finally {
      if (requestId === sequence && !destroyed) { grid.setAttribute('aria-busy', 'false'); more.disabled = false; }
    }
  }
  function search() {
    clearTimeout(searchTimer);
    const form = element.querySelector('form');
    currentKind = form.elements.kind.value;
    currentQuery = form.elements.q.value.trim();
    if (updateUrl) {
      const url = new URL(location.href);
      if (currentQuery) url.searchParams.set('q', currentQuery); else url.searchParams.delete('q');
      url.pathname = currentKind === 'profiles' ? '/profiles' : '/gallery';
      history.replaceState(null, '', url);
      document.querySelectorAll('.main-nav a, .community-menu-body nav a').forEach((link) => {
        if (link.pathname === url.pathname) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      });
      document.querySelectorAll('.community-explore-tabs a').forEach((link) => {
        if (link.pathname === url.pathname) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      });
      const heading = document.querySelector('.community-page-heading');
      if (heading) {
        const profiles = currentKind === 'profiles';
        heading.querySelector('h1').textContent = profiles ? 'Люди, которые создают миры' : 'У каждой модели — своя история';
        heading.querySelector('p').textContent = profiles ? 'Найди автора, открой его работы и познакомься с новыми идеями.' : 'Рассмотри со всех сторон. Испытай в движении. Расскажи, что думаешь.';
        document.title = `${profiles ? 'Авторы' : 'Галерея 3D-моделей'} · models.xedoc.ru`;
      }
    }
    refresh();
  }
  const form = element.querySelector('form');
  form?.addEventListener('submit', (event) => { event.preventDefault(); search(); });
  form?.elements.q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 350); });
  form?.elements.kind.addEventListener('change', search);
  more.addEventListener('click', () => refresh(true));
  let refreshTimer;
  const refreshFromEvent = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh(), 40); };
  const refreshEvents = ['community:gallery-changed', 'community:models-changed', 'community:auth-changed'];
  refreshEvents.forEach((event) => window.addEventListener(event, refreshFromEvent));
  refresh();
  return { refresh: () => refresh(), destroy() { destroyed = true; clearTimeout(searchTimer); clearTimeout(refreshTimer); controller?.abort(); refreshEvents.forEach((event) => window.removeEventListener(event, refreshFromEvent)); } };
}

export function mountGallerySection(element, { limit = 8 } = {}) {
  if (!element || element.dataset.communityMounted) return;
  element.dataset.communityMounted = 'true';
  element.classList.add('community-gallery-section');
  element.innerHTML = `<div class="section-heading"><div><div class="eyebrow">СДЕЛАНО В СТУДИИ</div><h2>Галерея сообщества</h2><p>Открой модель, посмотри её в 3D и обсуди с автором.</p></div><a href="/gallery" class="button button-quiet button-small">Вся галерея${icon('arrow')}</a></div><div class="community-section-collection"></div>`;
  return createCollection(element.querySelector('.community-section-collection'), { limit, preview: true });
}

const publicationStates = new WeakMap();
export function renderPublicationPanel(element, job, { onUpdated = () => {}, capturePreview } = {}) {
  if (!element) return;
  if (!job || job.status !== 'complete' || !job.artifacts?.modelUrl) { element.hidden = true; return; }
  element.hidden = false;
  let state = publicationStates.get(element);
  if (!state || state.id !== job.id) {
    state = { id: job.id, job, onUpdated, capturePreview, dirty: false, saving: false };
    publicationStates.set(element, state);
    element.classList.add('community-publication-panel');
    element.innerHTML = `<div class="community-publication-heading"><h3>${icon('globe')}В галерее</h3><span class="community-publication-status" role="status"></span></div><form class="community-form"><label>Видимость<select name="visibility"><option value="public">Публичная — видна всем</option><option value="private">Приватная — только тебе</option></select></label><p class="community-field-note" data-visibility-note></p><label>Название модели<input name="title" maxlength="100" placeholder="Дай своей модели имя" /></label><label>Описание<textarea name="description" maxlength="2000" rows="3" placeholder="Что это за модель? Расскажи об идее."></textarea></label><div class="community-publication-author"></div><p class="community-form-error" role="alert" hidden></p><p class="community-save-note" role="status" hidden></p><button type="submit" class="button button-secondary community-publication-save">${icon('check')}Сохранить публикацию</button><a class="community-text-link" data-public-link hidden>Открыть страницу модели${icon('arrow')}</a></form>`;
    const form = element.querySelector('form');
    const visibilityNote = () => { element.querySelector('[data-visibility-note]').textContent = form.elements.visibility.value === 'public' ? 'Модель видна в галерее. Исходная картинка остаётся доступна только тебе.' : 'Модель исчезнет из галереи, а общая ссылка перестанет работать.'; };
    form.addEventListener('input', () => { state.dirty = true; element.querySelector('.community-publication-status').textContent = 'Есть изменения'; visibilityNote(); });
    form.addEventListener('change', () => { state.dirty = true; element.querySelector('.community-publication-status').textContent = 'Есть изменения'; visibilityNote(); });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.saving) return;
      const values = { visibility: form.elements.visibility.value, title: form.elements.title.value.trim(), description: form.elements.description.value.trim() };
      state.saving = true;
      const error = form.querySelector('[role=alert]');
      const note = form.querySelector('.community-save-note');
      const isCurrentPanel = () => publicationStates.get(element) === state && element.isConnected;
      error.hidden = note.hidden = true;
      form.querySelectorAll('input,select,textarea,button').forEach((control) => { control.disabled = true; });
      element.querySelector('.community-publication-status').textContent = 'Сохраняем…';
      try {
        let previewFailed = false;
        if (values.visibility === 'public' && !state.job.previewUrl && state.capturePreview) {
          try {
            const image = await state.capturePreview();
            if (image) await request(`/jobs/${encodeURIComponent(state.id)}/preview`, { method: 'POST', body: { image } });
          } catch { previewFailed = true; }
        }
        const result = await request(`/jobs/${encodeURIComponent(state.id)}/publication`, { method: 'PATCH', body: values });
        state.dirty = false;
        state.job = result.job;
        state.onUpdated(result.job);
        if (isCurrentPanel()) {
          element.querySelector('.community-publication-status').textContent = 'Сохранено';
          note.textContent = previewFailed ? 'Настройки сохранены. Превью пока не удалось загрузить.' : values.visibility === 'public' ? 'Модель доступна в галерее.' : 'Модель видна только тебе.';
          note.hidden = false;
          const link = element.querySelector('[data-public-link]');
          link.hidden = values.visibility !== 'public';
          link.href = `/model/${encodeURIComponent(state.id)}`;
        }
        window.dispatchEvent(new CustomEvent('community:gallery-changed'));
        window.dispatchEvent(new CustomEvent('community:models-changed'));
      } catch (failure) {
        if (isCurrentPanel()) { error.textContent = failure.message; error.hidden = false; element.querySelector('.community-publication-status').textContent = 'Не сохранено'; }
      } finally {
        state.saving = false;
        if (isCurrentPanel()) form.querySelectorAll('input,select,textarea,button').forEach((control) => { control.disabled = false; });
      }
    });
  }
  state.job = job;
  state.onUpdated = onUpdated;
  state.capturePreview = capturePreview;
  if (!state.dirty && !state.saving) {
    const form = element.querySelector('form');
    form.elements.visibility.value = job.visibility === 'public' ? 'public' : 'private';
    form.elements.title.value = job.title || '';
    form.elements.description.value = job.description || '';
    element.querySelector('.community-publication-status').textContent = job.visibility === 'public' ? 'Публичная' : 'Приватная';
    element.querySelector('[data-visibility-note]').textContent = job.visibility === 'public' ? 'Модель видна в галерее. Исходная картинка остаётся доступна только тебе.' : 'Модель доступна только тебе. Ты можешь опубликовать её здесь.';
    const link = element.querySelector('[data-public-link]');
    link.hidden = job.visibility !== 'public';
    link.href = `/model/${encodeURIComponent(job.id)}`;
  }
  const author = element.querySelector('.community-publication-author');
  const authorSignature = currentUser?.id || job.author?.id || 'anonymous';
  if (author.dataset.author !== authorSignature) {
    author.dataset.author = authorSignature;
    const user = currentUser || job.author;
    author.innerHTML = user ? `<span>Автор</span><a class="community-author" href="${profileUrl(user)}">${avatar(user)}${escape(displayName(user))}</a>` : '<button type="button" class="community-text-link" data-publication-register>Создать профиль автора →</button><p class="community-field-note">Модель появится в твоём профиле после регистрации.</p>';
    author.querySelector('[data-publication-register]')?.addEventListener('click', () => openAuth('register'));
  }
}

function shell() {
  return `<header class="site-header"><div class="header-inner"><a class="brand" href="/" aria-label="models.xedoc.ru — главная">${icon('cube')}<span>models<span class="brand-dot">.</span><span class="brand-domain">xedoc</span></span><span class="brand-tag">STUDIO</span></a><nav class="main-nav" aria-label="Главное меню"></nav></div></header><main class="page community-page" id="community-page"><div class="community-page-loading" role="status"><span class="small-loader"></span>Открываем студию…</div></main><footer class="page community-footer"><span>${icon('cube')} MODELS STUDIO</span><span>Воображение обретает форму.</span><a href="/generate-model">Создать модель${icon('arrow')}</a></footer>`;
}
function heading(eyebrow, title, subtitle, action = '') {
  return `<div class="page-heading community-page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${escape(title)}</h1><p>${escape(subtitle)}</p></div>${action}</div>`;
}
async function mountCollectionPage(page, kind) {
  const isProfiles = kind === 'profiles';
  document.title = `${isProfiles ? 'Авторы' : 'Галерея 3D-моделей'} · models.xedoc.ru`;
  page.innerHTML = `${heading('СООБЩЕСТВО · 3D · ИДЕИ', isProfiles ? 'Люди, которые создают миры' : 'У каждой модели — своя история', isProfiles ? 'Найди автора, открой его работы и познакомься с новыми идеями.' : 'Рассмотри со всех сторон. Испытай в движении. Расскажи, что думаешь.', `<a class="button button-primary" href="/generate-model">${icon('cube')}Создать модель</a>`)}<div class="community-explore-tabs"><a href="/gallery"${!isProfiles ? ' aria-current="page"' : ''}>${icon('grid')}Модели</a><a href="/profiles"${isProfiles ? ' aria-current="page"' : ''}>${icon('user')}Авторы</a></div><section id="community-page-collection" aria-label="${isProfiles ? 'Поиск авторов' : 'Галерея моделей'}"></section>`;
  createCollection(page.querySelector('#community-page-collection'), { limit: 12, kind, query: new URLSearchParams(location.search).get('q') || '', updateUrl: true });
}

async function mountProfilePage(page, username) {
  let generation = 0;
  let collection;
  async function render() {
    const token = ++generation;
    collection?.destroy();
    const ownRoute = !username;
    let user;
    try {
      await loadAuth();
      if (token !== generation) return;
      if (ownRoute && !currentUser) {
        document.title = 'Твой профиль · models.xedoc.ru';
        page.innerHTML = `${heading('ТВОЙ ПРОФИЛЬ', 'Место для твоих идей', 'Сохрани свои модели, собери портфолио и общайся с другими авторами.')}<div class="community-profile-invitation"><div class="community-invitation-art" aria-hidden="true">${icon('user')}<span>CREATOR / YOU</span></div><div><h2>Начнём с знакомства</h2><p>Войди или создай профиль. Модели из этого браузера привяжутся к нему автоматически.</p><div class="community-inline-actions"><button class="button button-primary" data-profile-auth="register">Создать профиль${icon('arrow')}</button><button class="button button-quiet" data-profile-auth="login">Уже есть профиль</button></div></div></div>`;
        page.querySelectorAll('[data-profile-auth]').forEach((button) => button.addEventListener('click', () => openAuth(button.dataset.profileAuth)));
        return;
      }
      user = ownRoute ? currentUser : (await request(`/profiles/${encodeURIComponent(username)}`)).profile;
      if (token !== generation) return;
      const isOwn = currentUser?.id === user.id;
      document.title = `${displayName(user)} · models.xedoc.ru`;
      page.innerHTML = `<a class="community-back-link" href="/profiles">← Все авторы</a><section class="community-profile-hero" aria-labelledby="community-profile-name"><div class="community-profile-identity">${avatar(user, true)}<div><div class="eyebrow">${isOwn ? 'ТВОЙ ПРОФИЛЬ' : 'АВТОР СТУДИИ'}</div><h1 id="community-profile-name">${escape(displayName(user))}</h1><span class="community-handle">@${escape(user.username)}</span></div></div><p class="community-profile-bio">${escape(user.bio || (isOwn ? 'Расскажи о себе — пусть другие авторы познакомятся с тобой.' : 'Создаёт объекты и персонажей в 3D.'))}</p><div class="community-profile-stats"><span>${icon('cube')}<strong>${Number(user.modelCount) || 0}</strong> публичных моделей</span><span>В студии с ${escape(date(user.createdAt))}</span></div>${isOwn ? '<div class="community-inline-actions"><button class="button button-secondary" data-edit-profile>Редактировать профиль</button><a class="button button-quiet" href="/generate-model">Моя библиотека</a></div>' : ''}</section>${isOwn ? '<section class="community-profile-editor" hidden></section>' : ''}<section class="community-profile-models"><div class="section-heading"><div><h2>${isOwn ? 'Твои публичные модели' : 'Модели автора'}</h2><p>${isOwn ? 'Приватные работы доступны в твоей библиотеке.' : 'Модели, которыми автор поделился с сообществом.'}</p></div>${isOwn ? `<a class="button button-quiet button-small" href="/generate-model">Создать${icon('arrow')}</a>` : ''}</div><div class="community-author-models"></div></section>`;
      collection = createCollection(page.querySelector('.community-author-models'), { author: user.username, limit: 12, showSearch: false });
      if (isOwn) {
        const editor = page.querySelector('.community-profile-editor');
        editor.innerHTML = `<form class="community-form"><h2>Редактировать профиль</h2><label>Имя в профиле<input name="displayName" required maxlength="60" value="${escape(user.displayName || user.username)}" autocomplete="nickname" /></label><label>О себе<textarea name="bio" maxlength="1000" rows="4" placeholder="Какие миры тебе хочется создавать?">${escape(user.bio || '')}</textarea></label><p class="community-field-note">Ссылка на профиль: /profile/${escape(user.username)}</p><p class="community-form-error" role="alert" hidden></p><div class="community-inline-actions"><button type="submit" class="button button-primary">Сохранить профиль</button><button type="button" class="button button-quiet" data-cancel-profile>Отмена</button></div></form>`;
        const open = page.querySelector('[data-edit-profile]');
        open.addEventListener('click', () => { editor.hidden = false; editor.querySelector('input').focus(); });
        editor.querySelector('[data-cancel-profile]').addEventListener('click', () => { editor.hidden = true; open.focus(); });
        editor.querySelector('form').addEventListener('submit', async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = { displayName: form.elements.displayName.value.trim(), bio: form.elements.bio.value.trim() };
          form.querySelectorAll('input,textarea,button').forEach((control) => { control.disabled = true; });
          const error = form.querySelector('[role=alert]');
          error.hidden = true;
          try {
            const result = await request('/auth/profile', { method: 'PATCH', body: values });
            setAuth(result.user);
            notify('Профиль сохранён.');
          } catch (failure) { error.textContent = failure.message; error.hidden = false; form.querySelectorAll('input,textarea,button').forEach((control) => { control.disabled = false; }); }
        });
      }
    } catch (error) {
      if (token !== generation) return;
      page.innerHTML = heading('ПРОФИЛЬ', 'Не удалось открыть профиль', error.message, '<a class="button button-quiet" href="/profiles">К авторам</a>');
    }
  }
  window.addEventListener('community:auth-changed', render);
  await render();
}

function modelViewArtifact(job) {
  const rotation = job.modelRotation ?? job.rig?.appliedRotation ?? job.rig?.rotation ?? {};
  const rigged = Boolean(job.artifacts?.riggedUrl && job.rig?.available !== false);
  const changed = ['x', 'y', 'z'].some((axis) => Math.abs((Number(rotation[axis]) || 0) - (Number(job.rig?.appliedRotation?.[axis]) || 0)) > 0.001);
  const source = !rigged || changed;
  return { url: source ? job.artifacts?.modelUrl : job.artifacts.riggedUrl, rotation: source ? rotation : {}, source };
}
async function mountModelPage(page, id) {
  try {
    const { job, model, canEdit } = await request(`/models/${encodeURIComponent(id)}`);
    const artifact = modelViewArtifact(job);
    document.title = `${modelTitle(model)} · models.xedoc.ru`;
    page.innerHTML = `<a class="community-back-link" href="/gallery">← В галерею</a><div class="community-model-detail"><section class="community-detail-viewer-panel" aria-label="3D-модель"><div class="community-detail-viewer" id="community-detail-viewer"></div><div class="community-viewer-top"><span><i></i>ПРОСМОТР 3D</span><span>GLB · PBR</span></div><div class="community-viewer-loading" role="status"><span class="small-loader"></span><p>Открываем модель…</p></div><div class="community-viewer-error" role="alert" hidden></div><div class="community-viewer-bottom"><span>Вращай, чтобы рассмотреть со всех сторон</span><button class="button button-quiet button-small" type="button" data-reset-camera>Вид спереди</button></div></section><aside class="community-model-about"><div class="eyebrow">${model.hasRig ? 'ПЕРСОНАЖ · СКЕЛЕТ · 3D' : 'СОЗДАНО В СТУДИИ'}</div><h1>${escape(modelTitle(model))}</h1><div class="community-model-byline">${model.author ? `<a class="community-author" href="${profileUrl(model.author)}">${avatar(model.author)}<span>${escape(displayName(model.author))}<small>@${escape(model.author.username)}</small></span></a>` : '<span class="community-handle">Автор без профиля</span>'}</div><p class="community-model-description">${escape(model.description || 'Автор пока не добавил описание. Рассмотри модель в 3D и поделись впечатлением в комментариях.')}</p><div class="community-detail-meta"><span>Создана ${escape(date(model.createdAt))}</span><a href="#comments">${icon('comment')}${escape(plural(model.commentsCount, 'комментарий', 'комментария', 'комментариев'))}</a></div><a class="button button-primary" href="/playground?model=${encodeURIComponent(id)}">${icon('play')}Открыть playground</a>${artifact.url ? `<a class="button button-quiet" href="${escape(artifact.url)}" download>${icon('download')}Скачать GLB</a>` : ''}<button class="button button-quiet" type="button" data-copy-model>${icon('globe')}Скопировать ссылку</button>${canEdit ? `<a class="community-text-link" href="/generate-model?job=${encodeURIComponent(id)}">Настройки моей модели${icon('arrow')}</a>` : ''}</aside></div><section id="comments" class="community-comments" aria-labelledby="community-comments-heading"></section>`;
    page.querySelector('[data-copy-model]').addEventListener('click', async () => {
      const url = `${location.origin}/model/${encodeURIComponent(id)}`;
      try { await navigator.clipboard.writeText(url); notify('Ссылка на модель скопирована.'); }
      catch {
        let field = page.querySelector('.community-copy-fallback');
        if (!field) { field = document.createElement('input'); field.className = 'community-copy-fallback'; field.readOnly = true; field.setAttribute('aria-label', 'Ссылка на модель'); page.querySelector('.community-model-about').append(field); }
        field.value = url; field.focus(); field.select();
        notify('Скопируй выделенную ссылку.');
      }
    });
    mountComments(page.querySelector('#comments'), id);
    const loading = page.querySelector('.community-viewer-loading');
    const error = page.querySelector('.community-viewer-error');
    let viewer;
    try {
      const { createViewer } = await import('./viewer.js');
      viewer = createViewer({ container: page.querySelector('#community-detail-viewer'), onState: (state) => {
        loading.hidden = !state.loading;
        if (state.loading) loading.querySelector('p').textContent = state.phase === 'checking' ? 'Проверяем сохранённую модель…'
          : state.phase === 'cached' ? 'Открываем модель из кеша…'
          : state.phase === 'parsing' ? 'Подготавливаем 3D-сцену…'
          : `Скачиваем модель${state.loadedPercent ? ` · ${state.loadedPercent}%` : '…'}`;
        if (state.error) { error.textContent = 'Не удалось открыть 3D-просмотр. Обнови страницу или скачай GLB.'; error.hidden = false; }
      } });
      page.querySelector('[data-reset-camera]').addEventListener('click', () => viewer.frontView());
      window.addEventListener('pagehide', () => viewer.dispose(), { once: true });
      await viewer.load(artifact.url, { rotation: artifact.rotation, position: job.placement || {}, environment: job.environment || {}, allowRagdoll: false });
      viewer.frontView();
    } catch { loading.hidden = true; error.textContent = '3D-просмотр недоступен. Можно открыть playground или скачать модель.'; error.hidden = false; }
  } catch (error) {
    page.innerHTML = `${heading('ГАЛЕРЕЯ СООБЩЕСТВА', 'Модель недоступна', error.message)}<a class="button button-primary" href="/gallery">Вернуться в галерею${icon('arrow')}</a>`;
  }
}

export function mountComments(element, modelId) {
  let offset = 0;
  let total = 0;
  let sequence = 0;
  let sending = false;
  let messageDraft = '';
  let disposed = false;
  element.innerHTML = `<div class="section-heading"><div><div class="eyebrow">ИДЕИ СТАНОВЯТСЯ ЛУЧШЕ ВМЕСТЕ</div><h2 id="community-comments-heading">Комментарии <span class="count" data-comments-total>0</span></h2></div></div><div class="community-comment-composer"></div><div class="community-comments-status" role="status"></div><div class="community-comment-list"></div><button class="button button-quiet" type="button" data-more-comments hidden>Ещё комментарии</button>`;
  const list = element.querySelector('.community-comment-list');
  const status = element.querySelector('.community-comments-status');
  const more = element.querySelector('[data-more-comments]');
  function renderComposer() {
    if (disposed) return;
    const composer = element.querySelector('.community-comment-composer');
    messageDraft = composer.querySelector('textarea')?.value ?? messageDraft;
    if (!currentUser) {
      composer.innerHTML = `<div class="community-comment-signin">${icon('comment')}<div><strong>Что думаешь об этой модели?</strong><p>Войди в профиль, чтобы оставить комментарий.</p></div><button class="button button-secondary button-small" type="button" data-comment-signin>Войти</button><button class="button button-quiet button-small" type="button" data-comment-register>Регистрация</button></div>`;
      composer.querySelector('[data-comment-signin]').addEventListener('click', () => openAuth('login'));
      composer.querySelector('[data-comment-register]').addEventListener('click', () => openAuth('register'));
      return;
    }
    composer.innerHTML = `<form class="community-comment-form"><a class="community-author" href="${profileUrl(currentUser)}">${avatar(currentUser)}${escape(displayName(currentUser))}</a><label class="sr-only" for="community-comment-body">Твой комментарий</label><textarea id="community-comment-body" name="body" required maxlength="2000" rows="3" placeholder="Поделись впечатлением, задай вопрос или предложи идею…">${escape(messageDraft)}</textarea><div class="community-comment-form-footer"><span>До 2 000 символов</span><button class="button button-primary button-small" type="submit">Отправить комментарий${icon('arrow')}</button></div><p class="community-form-error" role="alert" hidden></p></form>`;
    composer.querySelector('textarea').addEventListener('input', (event) => { messageDraft = event.target.value; });
    composer.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (sending) return;
      const form = event.currentTarget;
      const body = form.elements.body.value.trim();
      if (!body) { form.elements.body.focus(); return; }
      sending = true;
      const button = form.querySelector('[type=submit]');
      button.disabled = true;
      form.elements.body.disabled = true;
      button.textContent = 'Отправляем…';
      const error = form.querySelector('[role=alert]');
      error.hidden = true;
      try {
        await request(`/models/${encodeURIComponent(modelId)}/comments`, { method: 'POST', body: { body } });
        if (disposed) return;
        form.elements.body.value = ''; messageDraft = '';
        await refresh();
        notify('Комментарий добавлен.');
      } catch (failure) { error.textContent = failure.message; error.hidden = false; }
      finally { sending = false; button.disabled = false; form.elements.body.disabled = false; button.innerHTML = `Отправить комментарий${icon('arrow')}`; }
    });
  }
  async function refresh(append = false) {
    if (disposed) return;
    const requestId = ++sequence;
    if (!append) offset = 0;
    status.textContent = 'Загружаем комментарии…';
    more.disabled = true;
    try {
      const result = await request(`/models/${encodeURIComponent(modelId)}/comments?offset=${offset}&limit=30`);
      if (requestId !== sequence) return;
      total = Number(result.total) || 0;
      element.querySelector('[data-comments-total]').textContent = String(total);
      const detailCount = document.querySelector('.community-detail-meta a[href="#comments"]');
      if (detailCount) detailCount.innerHTML = `${icon('comment')}${escape(plural(total, 'комментарий', 'комментария', 'комментариев'))}`;
      if (!append) list.innerHTML = '';
      list.insertAdjacentHTML('beforeend', (result.comments || []).map((comment) => `<article class="community-comment" data-comment-id="${escape(comment.id)}"><div class="community-comment-heading"><a class="community-author" href="${profileUrl(comment.author)}">${avatar(comment.author)}<span>${escape(displayName(comment.author))}</span></a><time datetime="${escape(comment.createdAt)}">${escape(date(comment.createdAt))}</time>${comment.canDelete ? '<button class="community-delete-comment" type="button" data-delete-comment>Удалить</button>' : ''}</div><p>${escape(comment.body)}</p><div class="community-comment-delete-check" hidden><span>Удалить этот комментарий?</span><button class="button button-small button-quiet" type="button" data-confirm-delete>Да, удалить</button><button class="button button-small button-quiet" type="button" data-cancel-delete>Отмена</button></div><p class="community-form-error" role="alert" hidden></p></article>`).join(''));
      offset += (result.comments || []).length;
      status.textContent = total ? '' : 'Пока тихо. Оставь первый комментарий.';
      more.hidden = offset >= total;
      more.textContent = 'Ещё комментарии';
    } catch (error) { if (requestId === sequence) { status.textContent = error.message; more.hidden = false; more.textContent = 'Повторить загрузку'; } }
    finally { if (requestId === sequence) more.disabled = false; }
  }
  list.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    const article = button?.closest('[data-comment-id]');
    if (!article) return;
    const confirmation = article.querySelector('.community-comment-delete-check');
    if (button.hasAttribute('data-delete-comment')) { confirmation.hidden = false; confirmation.querySelector('button').focus(); return; }
    if (button.hasAttribute('data-cancel-delete')) { confirmation.hidden = true; article.querySelector('[data-delete-comment]').focus(); return; }
    if (!button.hasAttribute('data-confirm-delete')) return;
    confirmation.querySelectorAll('button').forEach((control) => { control.disabled = true; });
    try { await request(`/comments/${encodeURIComponent(article.dataset.commentId)}`, { method: 'DELETE' }); await refresh(); }
    catch (error) { const message = article.querySelector('[role=alert]'); message.textContent = error.message; message.hidden = false; confirmation.querySelectorAll('button').forEach((control) => { control.disabled = false; }); }
  });
  more.addEventListener('click', () => refresh(offset > 0));
  const onAuthChanged = () => { renderComposer(); refresh(); };
  window.addEventListener('community:auth-changed', onAuthChanged);
  loadAuth().then(renderComposer).catch(renderComposer);
  refresh();
  return () => {
    disposed = true;
    sequence++;
    window.removeEventListener('community:auth-changed', onAuthChanged);
    element.replaceChildren();
  };
}

export async function mountCommunityPage() {
  document.getElementById('app').innerHTML = shell();
  mountCommunityHeader();
  const page = document.getElementById('community-page');
  const path = location.pathname.replace(/\/+$/, '');
  if (path === '/gallery') return mountCollectionPage(page, 'models');
  if (path === '/profiles') return mountCollectionPage(page, 'profiles');
  if (path === '/profile' || path.startsWith('/profile/')) {
    let username;
    try { username = path === '/profile' ? '' : decodeURIComponent(path.slice('/profile/'.length)); }
    catch { page.innerHTML = heading('ПРОФИЛЬ', 'Неверная ссылка на профиль', 'Найди автора через поиск.', '<a class="button button-primary" href="/profiles">К авторам</a>'); return; }
    return mountProfilePage(page, username);
  }
  if (path.startsWith('/model/')) {
    let id;
    try { id = decodeURIComponent(path.slice('/model/'.length)); }
    catch { page.innerHTML = heading('ГАЛЕРЕЯ', 'Неверная ссылка на модель', 'Найди модель через поиск.', '<a class="button button-primary" href="/gallery">В галерею</a>'); return; }
    return mountModelPage(page, id);
  }
  page.innerHTML = heading('MODELS STUDIO', 'Страница не найдена', 'Загляни в галерею — там есть на что посмотреть.', '<a class="button button-primary" href="/gallery">В галерею</a>');
}
