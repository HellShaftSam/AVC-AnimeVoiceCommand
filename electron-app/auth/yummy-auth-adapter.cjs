/**
 * YummyAnimeAuthenticationAdapter — ВСЯ сайт-специфичная детекция аутентификации
 * в одном месте (спецификация, секция 23). Ничего site-specific вне этого файла.
 *
 * ВСЕ СЕЛЕКТОРЫ И ЭНДПОИНТЫ ПРОВЕРЕНЫ ПРОТИВ ЖИВОГО САЙТА (2026-10-02):
 *
 * ПРОВЕРЕНО ЖИВЫМИ ЗАПРОСАМИ (curl + реальный Chromium):
 *   - GET /login                → 404. Отдельной страницы входа НЕТ:
 *     форма «Вход» встроена в ГЛАВНУЮ (form action="/login/" method=post,
 *     input[name=email] «E-mail или логин», input[name=password], submit «Войти»).
 *     Альтернативы на форме: Telegram (t.me/yummy_animeBot), VK (#auth-vk-button),
 *     Shikimori OAuth (shikimori.io/oauth/authorize → /api/profile/authShiki).
 *   - GET /api/profile          → 401 {error:"You need to authorize to perform this action"}
 *     для гостя; 200 + JSON-профиль для залогиненных (проверка состояния).
 *   - /register, /login/reset-password → 200.
 *
 * ПРОВЕРЕНО ПО СОБСТВЕННОМУ КОДУ САЙТА (public /js/build.min.js v3.0.308):
 *   - выход: элемент .logout-btn → POST /api/profile/logout;
 *   - маркеры авторизованного DOM: input#current_user_id (id пользователя),
 *     input#user_nickname (ник) — читаются самим сайтом;
 *   - после УСПЕШНОГО входа сайт показывает «Вы успешно авторизовались в аккаунт»
 *     и делает location.reload() → событие навигации = сигнал для проверки;
 *   - ошибка входа: текст «Неправильный логин!»;
 *   - hCaptcha: meta#hcaptcha-key есть всегда; виджет #h-captcha/.h-captcha
 *     рендерится по требованию (появляется при вызове капчи).
 *
 * ЛОВУШКИ (не использовать как сигналы):
 *   - img[src*="static.yani.tv/users/"] встречается У ГОСТЯ — это аватары АВТОРОВ
 *     ОЗВУЧЕК на карточках (.author-img), НЕ признак входа;
 *   - URL-паттерны (типа location.pathname==='/profile') — запрещены спекой (секция 5).
 */

const SITE = {
  origin: 'https://old.yummyani.me',
  /** Вход открывает ГЛАВНУЮ (форма «Вход» вверху); /login = 404 — проверено */
  loginUrl: 'https://old.yummyani.me/',
  profileApiPath: '/api/profile',
  logoutApiPath: '/api/profile/logout',
  favoritesPath: '/actions/export-favorites.php?format=json&vote=0',
}

/** Все селекторы в одном месте (мастер-правило проекта) */
const SELECTORS = {
  currentUserId: '#current_user_id',
  userNickname: '#user_nickname',
  logoutBtn: '.logout-btn',
  loginForm: 'form.login-form',
  loginEmailInput: 'form.login-form input[name="email"]',
  loginPasswordInput: 'form.login-form input[name="password"]',
  authBlock: '.auth-block',
  hcaptchaKey: '#hcaptcha-key',
  hcaptchaVisible: '.h-captcha iframe, iframe[src*="hcaptcha"], div#h-captcha iframe',
  loginErrorText: 'Неправильный логин',
  loginSuccessText: 'Вы успешно авторизовались',
}

/**
 * Скрипт детекции, исполняемый В КОНТЕКСТЕ страницы сайта
 * (webContents.executeJavaScript). Same-origin fetch выполняют САМИ куки
 * браузера — значения cookie нигде не читаются и не покидают профиль.
 * Возвращает ТОЛЬКО не-секретные сигналы (профиль пользователя — не секрет).
 */
const DETECTION_SCRIPT = `(async () => {
  const q = (s) => document.querySelector(s)
  const signals = {
    url: location.href,
    currentUserId: (q(${JSON.stringify(SELECTORS.currentUserId)}) || {}).value || null,
    userNickname: (q(${JSON.stringify(SELECTORS.userNickname)}) || {}).value || null,
    logoutBtns: document.querySelectorAll(${JSON.stringify(SELECTORS.logoutBtn)}).length,
    loginForm: !!q(${JSON.stringify(SELECTORS.loginForm)}),
    loginInputs: !!(q(${JSON.stringify(SELECTORS.loginEmailInput)}) && q(${JSON.stringify(SELECTORS.loginPasswordInput)})),
    authBlock: !!q(${JSON.stringify(SELECTORS.authBlock)}),
    captchaVisible: !!q(${JSON.stringify(SELECTORS.hcaptchaVisible)}),
    loginErrorText: (document.body ? document.body.innerText : '').indexOf(${JSON.stringify(SELECTORS.loginErrorText)}) !== -1,
    loginSuccessText: (document.body ? document.body.innerText : '').indexOf(${JSON.stringify(SELECTORS.loginSuccessText)}) !== -1,
    profileApi: null,
  }
  try {
    const r = await fetch(${JSON.stringify(SITE.profileApiPath)}, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
    })
    let body = null
    try { body = await r.json() } catch (_) { body = null }
    signals.profileApi = { status: r.status, body }
  } catch (e) {
    signals.profileApi = { status: 0, error: String((e && e.message) || e) }
  }
  return signals
})()`

/** Выход ЧЕРЕЗ САЙТ в контексте сессии (спецификация, секция 10) */
const LOGOUT_SCRIPT = `(async () => {
  try {
    const r = await fetch(${JSON.stringify(SITE.logoutApiPath)}, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    return { status: r.status }
  } catch (e) {
    return { status: 0, error: String((e && e.message) || e) }
  }
})()`

/** Избранное изнутри сессии (аутентифицированный эндпоинт сайта) */
const FAVORITES_SCRIPT = `(async () => {
  try {
    const r = await fetch(${JSON.stringify(SITE.favoritesPath)}, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
    })
    const text = await r.text()
    return { status: r.status, contentType: r.headers.get('content-type') || '', text: String(text).slice(0, 2000000) }
  } catch (e) {
    return { status: 0, error: String((e && e.message) || e) }
  }
})()`

/**
 * Защитная нормализация JSON профиля сайта. Формат точно не документирован —
 * перебираем известные варианты имён полей; не нашли — null (ничего не выдумываем).
 */
function parseProfile(body) {
  if (typeof body !== 'object' || body === null) return null
  const root = body
  const u = root.response ?? root.user ?? root
  if (typeof u !== 'object' || u === null) return null

  const texts = u.texts ?? null
  const avatars = u.avatars ?? null
  const ids = u.ids ?? null

  const rawId = u.id ?? u.user_id ?? u.userId ?? null
  const id = rawId !== null && rawId !== undefined ? String(rawId) : null

  const nameCandidates = [
    u.name,
    u.login,
    u.username,
    u.nickname,
    ids && typeof ids === 'object' ? ids.tg_nickname : null,
    texts && typeof texts === 'object' ? texts.left : null,
    texts && typeof texts === 'object' ? texts.right : null,
  ]
  const name = nameCandidates.find((v) => typeof v === 'string' && v.trim() !== '')

  const avatarCandidates = [
    u.avatar,
    u.avatar_url,
    avatars && typeof avatars === 'object' ? avatars.small : null,
    avatars && typeof avatars === 'object' ? avatars.big : null,
  ]
  const avatarRaw = avatarCandidates.find((v) => typeof v === 'string' && v.trim() !== '')
  const avatarUrl = avatarRaw
    ? avatarRaw.startsWith('//')
      ? `https:${avatarRaw}`
      : avatarRaw
    : null

  if (id === null && !name) return null
  return {
    userId: id,
    username: typeof name === 'string' ? name.trim() : null,
    displayName: typeof name === 'string' ? name.trim() : null,
    avatarUrl,
  }
}

/**
 * Решение по сигналам (multi-signal confidence, секция 5).
 * Приоритет: /api/profile (same-origin, куки самого браузера) → DOM-маркеры сайта.
 * Никогда не используем URL как единственный сигнал.
 */
function decide(signals) {
  const api = signals.profileApi || { status: 0 }

  // Сайт/сеть недоступны — решение принять нельзя (секция 25: не портим кеш)
  if (api.status === 0) {
    return { kind: 'networkError', message: api.error || 'Сайт недоступен' }
  }

  if (api.status === 200) {
    let user = parseProfile(api.body)
    // Профиль не распознали, но DOM-маркеры сайта говорят «вход выполнен»
    // (секция 6: надёжные индикаторы = успешная аутентификация)
    if (!user && (signals.currentUserId || signals.logoutBtns > 0)) {
      user = {
        userId: signals.currentUserId ? String(signals.currentUserId) : null,
        username: signals.userNickname || null,
        displayName: signals.userNickname || null,
        avatarUrl: null,
      }
    }
    const confidence = user ? 'high' : signals.currentUserId || signals.logoutBtns > 0 ? 'medium' : 'low'
    return { kind: 'authenticated', user, confidence, method: 'yummyani-web-session' }
  }

  if (api.status === 401 || api.status === 403) {
    return {
      kind: 'notAuthenticated',
      confidence: signals.loginForm ? 'high' : 'medium',
      loginFormVisible: signals.loginForm,
    }
  }

  // Неожиданный статус — считаем сайтом/структурой, не выдумываем состояние
  return { kind: 'unexpected', status: api.status }
}

/** Защитный парсинг export-favorites (формат сайтом не документирован) */
function parseFavorites(bodyRaw) {
  const tryParse = (v) => {
    if (typeof v === 'string') {
      try {
        return JSON.parse(v)
      } catch {
        return null
      }
    }
    return v
  }

  let list = null
  let body = bodyRaw
  if (typeof body === 'string') {
    const parsed = tryParse(body)
    if (parsed === null) return null
    body = parsed
  }
  if (Array.isArray(body)) list = body
  else if (typeof body === 'object' && body !== null) {
    const root = body
    const data = tryParse(root.data)
    if (Array.isArray(data)) list = data
    else if (Array.isArray(root.items)) list = root.items
    else if (Array.isArray(root.response)) list = root.response
    else if (data && typeof data === 'object') {
      const inner = data
      if (Array.isArray(inner.favorites)) list = inner.favorites
      else if (Array.isArray(inner.items)) list = inner.items
    }
  }
  if (!Array.isArray(list)) return null

  const out = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const it = raw
    const title = [it.title, it.name, it.anime_title].find(
      (v) => typeof v === 'string' && v.trim() !== '',
    )
    const rawId = it.anime_id ?? it.animeId ?? it.id
    const rawSlug =
      typeof it.slug === 'string'
        ? it.slug
        : typeof it.url === 'string'
          ? it.url.match(/\/catalog\/item\/([a-z0-9-]+)/i)?.[1] ?? it.url
          : null
    if (title === undefined && rawId === undefined && !rawSlug) continue
    const posterRaw =
      typeof it.poster === 'string'
        ? it.poster
        : it.poster && typeof it.poster === 'object' && typeof it.poster.medium === 'string'
          ? it.poster.medium
          : null
    out.push({
      animeId: typeof rawId === 'number' ? rawId : null,
      slug: typeof rawSlug === 'string' && rawSlug.trim() !== '' ? rawSlug : null,
      title: title ?? `Аниме #${String(rawId ?? '?')}`,
      poster: posterRaw ? (posterRaw.startsWith('//') ? `https:${posterRaw}` : posterRaw) : null,
    })
  }
  return out
}

module.exports = {
  SITE,
  SELECTORS,
  DETECTION_SCRIPT,
  LOGOUT_SCRIPT,
  FAVORITES_SCRIPT,
  parseProfile,
  parseFavorites,
  decide,
}
