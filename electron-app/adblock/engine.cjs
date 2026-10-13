/**
 * AdBlock engine (преролл-реклама YummyAnime) — Electron main process.
 *
 * РЕАЛЬНЫЙ МЕХАНИЗМ РЕКЛАМЫ (исследование Task 16-c, см. worklog):
 *  1. Сайт грузит https://cdn.adfinity.pro/code/1617/adfinity.js?5 (ад-SDK, 1.3 МБ) и
 *     создаёт контейнеры adfinity_block_4033 / adfinity_block_4417 (banner-main и пр.).
 *  2. Внутри adfinity.js — конфиг из 6 блоков, включая ПРЕРОЛЛ «PreR» (id 16499) и
 *     мидролл «MidR» (id 16500): VAST/VPAID-видео-реклама с источников:
 *       https://an.yandex.ru/meta/18059015   (Яндекс VAST, imp-id 1 и 2)
 *       https://ads.adtec.ru/vpaid?id=1910|1905|1900
 *       https://widget.adplay.ru/vp/2287674.xml
 *       https://exad.smi2.ru/vast/102172
 *       https://ad.moe.video/vast?pid=12053  (MoeVideo, sticky VPAID)
 *  3. adfinity.js динамически грузит адаптеры: inplayer.ru/player/inplayer2.js
 *     (SovaAdapter — видеоплеер прероллов), videoroll.net/js/vid_vpaut_script_adfinity.js,
 *     cdn.viqeo.tv/js/vq_starter.js, ad.mail.ru/static/vk-adman.js, cdn1.moe.video/p/*.js,
 *     yandex.ru/ads/system/context.js|adsdk.js|header-bidding.js (Яндекс/AdFox),
 *     ads.betweendigital.com, acint.net (sync-пиксели).
 *  4. Плеер Aksor (player.aksor.tv) грузит Google IMA (imasdk.googleapis.com/js/sdkloader/ima3.js)
 *     и делает requestPreroll(adTagUrl) — преролл ВНУТРИ iframe плеера. Реальный контент
 *     грузится через hls.js НЕЗАВИСИМО от IMA: без ima3.js P=null и requestPreroll не вызывается.
 *  5. Kodik получает vast/reserve_vast из своего API (URL динамический — блокируется
 *     только домен-хост огромных сетей, свой /adsbygoogle.js kodik остаётся: домен в allowlist).
 *  6. Alloha: "ads":{"enabled":true,"preroll":"jsf:rotateP",...} + rmp-vast.min.js —
 *     VAST-URL вычисляется в рантайме (безопасно заблокировать нельзя, честное ограничение).
 *
 * КОНВЕЙЕР РЕШЕНИЙ (порядок важен!):
 *   OFF- fast-path      → handler: если тумблер выключен — вернуть {} (никогда не блокировать)
 *   1. не-http(s) схемы (data:, blob:, ws:, chrome-*, devtools:) → ALLOW
 *   2. mainFrame        → ALLOW (навигацию документа не блокируем никогда)
 *   3. localhost/127.x  → ALLOW (собственный сервер приложения и AVC bridge)
 *   4. ALLOWLIST        → ALLOW (домены-плееры и видео-CDN — ПЕРЕД любыми ад-правилами,
 *                          чтобы ни одно ад-правило не задело реальное видео)
 *   5. AD_DOMAINS       → BLOCK (точные/суффикс-домены рекламной инфраструктуры)
 *   6. yandex.ru/ads/*  → BLOCK (загрузчики Яндекс Ads/AdFox на самом yandex.ru)
 *   7. path /vast|/vpaid|/pagead/ на НЕ allowlisted хостах → BLOCK (defense-in-depth)
 *   8. 'adfinity' в URL → BLOCK (пиксели/биконы сети adfinity на чужих хостах)
 *   9. default          → ALLOW (никогда не блокируем «всё Media» — эпизод тоже media)
 *
 * КОНТРАКТ (используется main.cjs):
 *   attach(session, getConfig) — вешает session.webRequest.onBeforeRequest фильтр
 *   setEnabled(bool)           — вкл/выкл без пересоздания окна
 *   attached() → bool          — фильтр активен
 *   diagnostics(n) → events[]  — кольцевой буфер решений (cap 500)
 *   classify(url, resourceType)→ чистая функция решения (без electron, для тестов)
 */
'use strict'

// --- Правила, скомпилированные при инициализации ------------------------------
// (без regex в горячем пути — только Set/Map и строковые операции)

/**
 * ALLOWLIST — ДОМЕНЫ РЕАЛЬНОГО ВИДЕО/ПЛЕЕРОВ. Проверяются ПЕРЕД ад-правилами:
 *  - yummyani.me (+ зеркала из конфига adfinity: yummy-anime.ru, yummyani.meme, yummy-ani.me)
 *    — сам сайт, API (/api/*) и iframeCVH-плеер (ru.yummyani.me);
 *  - yani.tv — инфраструктура сайта (alloha.yani.tv);
 *  - aksor.tv — плеер Aksor и его видео;
 *  - kodikplayer.com — плеер Kodik; kodik-cdn.com — видео-CDN Kodik
 *    (в бандле: atob('Ly8oPzpnZXR8Y2xvdWQpLmtvZGlrLWNkbi5jb20=') = //(?:get|cloud).kodik-cdn.com);
 *    kodikres.com, solodcdn.com — видео-хранилища/стримы Kodik (наблюдается в живых страницах);
 *  - alloha.tv — видео-CDN Alloha;
 *  - sibnet.ru — video.sibnet.ru (shell + mp4).
 */
const ALLOW_DOMAINS = new Set([
  'yummyani.me',
  'yummy-anime.ru',
  'yummyani.meme',
  'yummy-ani.me',
  'yani.tv',
  'aksor.tv',
  'kodikplayer.com',
  'kodik-cdn.com',
  'kodikres.com',
  'solodcdn.com',
  'alloha.tv',
  'sibnet.ru',
])

/**
 * AD_DOMAINS — рекламная инфраструктура (точный хост или суффикс-домен).
 * Каждая запись подтверждена исследованием (см. шапку файла). Полный блок
 * doubleclick.net/googlesyndication.com безопасен: это только реклама/трекинг,
 * реальное видео никогда не проходит через них; ima3.js нужен только чтобы
 * ПОКАЗАТЬ преролл (без него плеер просто сразу играет эпизод).
 */
const AD_DOMAINS = new Set([
  // сеть adfinity (сам SDK и его зеркала)
  'adfinity.pro',
  // адаптеры преролл/видео-рекламы из adfinity.js
  'inplayer.ru',
  'videoroll.net',
  'viqeo.tv',
  'moe.video', // покрывает ad.moe.video и cdn1.moe.video
  'ad.mail.ru', // vk-adman (VK InPage)
  // VAST/VPAID-источники из конфига блоков
  'adplay.ru',
  'smi2.ru',
  'adtec.ru',
  'an.yandex.ru', // Яндекс VAST meta
  'adfox.ru', // покрывает ads.adfox.ru
  // видео-ад-сети из biddersMap/config
  'buzzoola.com',
  'videonow.ru',
  'gnezdo.ru',
  'adriver.ru',
  // SSP/sync-пиксели
  'betweendigital.com',
  'acint.net',
  // Google IMA (преролл плеера Aksor) + Google ad serving
  'imasdk.googleapis.com',
  'doubleclick.net', // googleads/pubads/securepubads.g.doubleclick.net
  'googlesyndication.com', // pagead2 и др.
  'adservice.google.com',
])

/** Path-правила для НЕ allowlisted хостов (защита от ротации ад-хостов). */
const PATH_VAST_VPAID = /\/vast[/?]|\/vpaid[/?]|\/vast$|\/vpaid$/i
const PATH_PAGEAD = /\/pagead\//
const ADFINITY_MARKER = 'adfinity'

// --- состояние ----------------------------------------------------------------

const DIAG_CAP = 500
const state = {
  attached: false,
  enabled: true,
  events: [], // кольцевой буфер решений (массив с shift, cap мал — ок)
  degradedReason: '', // почему фильтр снят (проба не прошла)
}

// --- утилиты (быстрые строковые операции, без regex в горячем пути) -----------

/** Хост из URL без new URL(): scheme://[user@]host[:port]/… или //host/… (protocol-relative) */
function hostOf(url) {
  let rest
  const schemeEnd = url.indexOf('://')
  if (schemeEnd > 0) rest = url.slice(schemeEnd + 3)
  else if (url.startsWith('//')) rest = url.slice(2)
  else return ''
  const slash = rest.search(/[/?#]/)
  if (slash >= 0) rest = rest.slice(0, slash)
  const at = rest.lastIndexOf('@')
  if (at >= 0) rest = rest.slice(at + 1)
  // IPv6 [::1]:port
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    return close > 0 ? rest.slice(1, close) : ''
  }
  const colon = rest.indexOf(':')
  if (colon >= 0) rest = rest.slice(0, colon)
  return rest.toLowerCase()
}

/** true, если host совпадает с domain или является его поддоменом (суффикс-матч) */
function suffixMatch(host, set) {
  let h = host
  while (h) {
    if (set.has(h)) return h
    const dot = h.indexOf('.')
    if (dot < 0) return null
    h = h.slice(dot + 1)
  }
  return null
}

function isLocalHost(host) {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.startsWith('127.')
  )
}

/**
 * Диагностика не должна содержать токены (они в query: alloha/kodik/aksor token=…),
 * поэтому URL сохраняется без query и hash. Cookies/headers не логируются никогда.
 */
function sanitizeUrl(url) {
  const q = url.indexOf('?')
  const h = url.indexOf('#')
  let end = url.length
  if (q >= 0) end = q
  if (h >= 0 && h < end) end = h
  return url.slice(0, end)
}

function pushEvent(url, resourceType, decision, rule, sourceKind) {
  const events = state.events
  events.push({
    ts: Date.now(),
    url: sanitizeUrl(url),
    resourceType,
    decision,
    rule,
    sourceKind,
  })
  if (events.length > DIAG_CAP) events.shift()
}

// --- чистая классификация (без electron — можно тестировать из bun) -----------

/**
 * classify(url, resourceType) →
 *   { decision: 'BLOCK'|'ALLOW'|'ALLOWLIST', rule, sourceKind }
 * Чистая функция: не зависит от тумблера setEnabled (OFF-логика в обработчике attach).
 */
function classify(url, resourceType) {
  const rt = resourceType || 'other'

  // 1. Только http(s) классифицируем; данные/блобы/сокеты/расширения не трогаем
  const schemeEnd = url.indexOf('://')
  if (!(schemeEnd > 0 && (url.startsWith('http://') || url.startsWith('https://'))) && !url.startsWith('//')) {
    return { decision: 'ALLOW', rule: 'non-http', sourceKind: 'scheme' }
  }

  // 2. Навигацию основного документа не блокируем никогда
  if (rt === 'mainFrame') {
    return { decision: 'ALLOW', rule: 'main-frame', sourceKind: 'protected' }
  }

  const host = hostOf(url)
  if (!host) return { decision: 'ALLOW', rule: 'no-host', sourceKind: 'scheme' }

  // 3. Собственный сервер приложения и AVC bridge
  if (isLocalHost(host)) {
    return { decision: 'ALLOW', rule: 'local', sourceKind: 'protected' }
  }

  // 4. ALLOWLIST — реальное видео и плееры проверяются ДО любых ад-правил
  const allowedBy = suffixMatch(host, ALLOW_DOMAINS)
  if (allowedBy) {
    return { decision: 'ALLOWLIST', rule: allowedBy, sourceKind: 'allowlist' }
  }

  // 5. Точные/суффикс-домены рекламной инфраструктуры
  const adBy = suffixMatch(host, AD_DOMAINS)
  if (adBy) {
    return { decision: 'BLOCK', rule: adBy, sourceKind: 'ad-domain' }
  }

  // 6. Загрузчики Яндекс Ads на самом yandex.ru (mc.yandex.ru — метрика — не задета)
  if (host === 'yandex.ru') {
    const path = url.slice(schemeEnd + 3)
    const slash = path.indexOf('/')
    const query = path.indexOf('?')
    const pathPart = slash >= 0 ? path.slice(slash, query >= 0 ? query : undefined) : '/'
    if (pathPart === '/ads/' || pathPart.startsWith('/ads/')) {
      return { decision: 'BLOCK', rule: 'yandex-ads-path', sourceKind: 'ad-path' }
    }
  }

  // 7. Path-паттерны на неизвестных хостах (до них видео-CDN уже пропущены allowlist'ом)
  let path = url.slice(url.indexOf(host) + host.length)
  const query = path.indexOf('?')
  if (query >= 0) path = path.slice(0, query)
  if (PATH_VAST_VPAID.test(path)) {
    return { decision: 'BLOCK', rule: 'vast-vpaid-path', sourceKind: 'ad-path' }
  }
  if (PATH_PAGEAD.test(path)) {
    return { decision: 'BLOCK', rule: 'pagead-path', sourceKind: 'ad-path' }
  }

  // 8. Пиксели/биконы adfinity на чужих хостах
  if (url.indexOf(ADFINITY_MARKER) >= 0) {
    return { decision: 'BLOCK', rule: 'adfinity-marker', sourceKind: 'ad-path' }
  }

  // 9. По умолчанию — разрешить (НИКОГДА не блокируем «всё Media»: эпизод тоже media)
  return { decision: 'ALLOW', rule: 'default-allow', sourceKind: 'default' }
}

// --- публичный API ------------------------------------------------------------

/**
 * Вешает webRequest-фильтр на сессию. getConfig() опрашивается на КАЖДЫЙ запрос —
 * тумблер из настроек веб-приложения (electronConfig.adblockEnabled) применяется live.
 */
function attach(netSession, getConfig) {
  if (state.attached) return // идемпотентно: фильтр один на сессию

  const filter = { urls: ['http://*/*', 'https://*/*'] }

  const beforeRequestListener = (details) => {
    const url = details.url || ''
    const rt = details.resourceType || 'other'
    const verdict = classify(url, rt)

    // Тумблер выключен: короткое замыкание — НИКОГДА не блокируем.
    // В диагностику OFF попадает только то, что БЫЛО БЫ заблокировано
    // (видно, что фильтр сделал бы, без спама по всем запросам).
    if (!getConfig()) {
      if (verdict.decision === 'BLOCK') pushEvent(url, rt, 'OFF', verdict.rule, verdict.sourceKind)
      return {}
    }

    if (verdict.decision === 'BLOCK') {
      pushEvent(url, rt, 'BLOCK', verdict.rule, verdict.sourceKind)
      return { cancel: true }
    }

    // Не блокируем, но видим в диагностике только интересное:
    // ALLOWLIST — video/xhr реальных плееров (аудит безопасности), ALLOW — неизвестное media.
    if (verdict.decision === 'ALLOWLIST') {
      if (rt === 'media' || rt === 'xhr') pushEvent(url, rt, 'ALLOWLIST', verdict.rule, verdict.sourceKind)
    } else if (rt === 'media') {
      pushEvent(url, rt, 'ALLOW', verdict.rule, verdict.sourceKind)
    }
    return {}
  }

  netSession.webRequest.onBeforeRequest(filter, beforeRequestListener)

  // Редирект-цепочки: только запись (медиа/xhr), решение не меняем
  try {
    netSession.webRequest.onBeforeRedirect(filter, (details) => {
      const rt = details.resourceType || 'other'
      if (rt === 'media' || rt === 'xhr') {
        pushEvent(details.url || '', rt, 'ALLOW', 'redirect', 'redirect')
      }
    })
  } catch {
    /* onBeforeRedirect недоступен — не критично */
  }

  state.attached = true
  state.degradedReason = ''
}

/**
 * Полностью снимает webRequest-фильтр (onBeforeRequest(null)) и помечает
 * причину деградации. Нужен для пробы-гейта: на части систем широкий
 * шаблон фильтра ломает загрузку документов в рендерере — тогда приложение
 * честно работает БЕЗ блокировщика, вместо чёрного экрана (EXE 1.3.1).
 */
function detach(netSession, reason) {
  try {
    const filter = { urls: ['http://*/*', 'https://*/*'] }
    netSession.webRequest.onBeforeRequest(filter, null)
  } catch {
    /* уже снят */
  }
  state.attached = false
  state.degradedReason = String(reason || 'filter removed')
}

function setEnabled(v) {
  state.enabled = Boolean(v)
}

function attached() {
  return state.attached
}

function diagnostics(n) {
  const list = state.events
  const count = Math.max(0, Math.min(n | 0, list.length))
  return count === 0 ? [] : list.slice(list.length - count)
}

function degradedReason() {
  return state.degradedReason
}

module.exports = {
  attach,
  detach,
  setEnabled,
  attached,
  degradedReason,
  diagnostics,
  classify,
  // для тестов/отладки правил
  _rules: {
    ALLOW_DOMAINS: [...ALLOW_DOMAINS],
    AD_DOMAINS: [...AD_DOMAINS],
  },
}
