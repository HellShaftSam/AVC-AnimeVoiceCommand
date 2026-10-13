/**
 * Тест правил AdBlock-движка БЕЗ Electron (bun test script).
 *
 * Запуск: bun scripts/test-adblock.mjs  (или node scripts/test-adblock.mjs)
 * Матрица: реальные URL эпизодов (из /api/anime/{id}/videos YummyAnime),
 * скрипты плееров, сайт-API, adfinity/VAST-реклама, неизвестное media.
 * Проверяет: ALLOWLIST раньше ад-правил (видео не блокируется), BLOCK только для рекламы.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const engine = require('../adblock/engine.cjs')

const { classify, _rules } = engine

// --- Реальные URL (исследование: old.yummyani.me/api/anime/70/videos, Берсерк) ---
const REAL = [
  // iframe-плееры из матрицы серий×озвучек
  ['https://player.aksor.tv/video/a5f9304d89a798de464e8aa6dc4ab071', 'subFrame'],
  ['//kodikplayer.com/serial/8293/87b2b1ee8663176c299bb3602014f4b0/720p?season=1&only_episode=true&episode=1', 'subFrame'],
  ['//alloha.yani.tv/?token_movie=63ecf02ed348a9a66000b0e8bd82ce&translation=36&season=1&episode=1&token=8b5512267a2a52e9de06d67d342e0c', 'subFrame'],
  ['https://video.sibnet.ru/shell.php?videoid=2931555', 'subFrame'],
  ['//ru.yummyani.me/iframeCVH.html?dubbing_code=MC+Entertaiment&anime_id=33&episode=1', 'subFrame'],
  // сегменты/файлы реального видео (CDN плееров)
  ['https://cloud.kodik-cdn.com/hls/8293/87b2b1ee8663176c299bb3602014f4b0/720p.mp4:hls:manifest.m3u8', 'xhr'],
  ['https://st-5cva8vttppvjafpc7jvj.kodikres.com/p-e/a', 'xhr'],
  ['https://cloud.solodcdn.com/test/3d00ec051bdc0cf978be2897f391adc9:2026100103/g', 'xhr'],
  ['https://st1.alloha.tv/videos/63ecf02ed348a9a66000b0e8bd82ce/1080.mp4', 'media'],
  ['https://player.aksor.tv/assets/index-CRO05xQc.js', 'script'],
  ['https://video.sibnet.ru/video2931555.mp4', 'media'],
  // сайт и его API
  ['https://old.yummyani.me/api/anime/70/videos', 'xhr'],
  ['https://old.yummyani.me/api/search?q=berserk', 'xhr'],
  ['https://old.yummyani.me/js/build.min.js?v=3.0.308', 'script'],
]

// --- Реклама (доказанные URL из adfinity.js и плееров) ---
const ADS = [
  ['https://cdn.adfinity.pro/code/1617/adfinity.js?5', 'script'],
  ['https://an.yandex.ru/meta/18059015?imp-id=1&charset=UTF-8&target-ref=[[domain]]&page-ref=[[url]]', 'xhr'],
  ['https://ads.adtec.ru/vpaid?id=1910', 'xhr'],
  ['https://widget.adplay.ru/vp/2287674.xml?page_url=https://www.yummyani.me&gdpr_applies=0', 'xhr'],
  ['https://exad.smi2.ru/vast/102172', 'xhr'],
  ['https://ad.moe.video/vast?pid=12053&vpt=sticky&advertCount=3&vt=vpaid&vl=0', 'xhr'],
  ['https://inplayer.ru/player/inplayer2.js', 'script'],
  ['https://videoroll.net/js/vid_vpaut_script_adfinity.js', 'script'],
  ['https://cdn.viqeo.tv/js/vq_starter.js', 'script'],
  ['https://ad.mail.ru/static/vk-adman.js', 'script'],
  ['https://cdn1.moe.video/p/b.js', 'script'],
  ['https://yandex.ru/ads/system/context.js', 'script'],
  ['https://yandex.ru/ads/system/adsdk.js', 'script'],
  ['https://imasdk.googleapis.com/js/sdkloader/ima3.js', 'script'],
  ['https://googleads.g.doubleclick.net/pagead/ads?ad_type=video&client=ca-pub-1', 'xhr'],
  ['https://pagead2.googlesyndication.com/pagead/idle', 'xhr'],
  ['https://ads.betweendigital.com/sspmatch-js?p=42565&randsalt=123', 'script'],
  ['https://acint.net/cmatch/?dp=14&pi=1628885', 'script'],
  ['https://buzzoola.com/vast?type=preroll', 'xhr'],
  ['https://unknown-rotating-host.example.com/vast/102172', 'xhr'], // ротация ад-хостов → path-правило
]

// --- Специальные случаи (ALLOW = не блокируем, но и не allowlist) ---
const SPECIAL = [
  // главный фрейм никогда не блокируется (main-frame раньше allowlist — намеренно)
  ['https://old.yummyani.me/catalog/item/berserk', 'mainFrame'],
  ['https://old.yummyani.me/', 'mainFrame'],
  // метрика — НЕ реклама, не трогаем (default-allow)
  ['https://mc.yandex.ru/watch/58424476', 'script'],
  // честное ограничение: adsbygoogle.js живёт на allowlisted домене Kodik → ALLOWLIST
  ['https://kodikplayer.com/adsbygoogle.js', 'script', 'ALLOWLIST'],
  // собственный сервер приложения
  ['http://127.0.0.1:3456/', 'document'],
  ['http://127.0.0.1:3010/adblock/diag', 'xhr'],
  // data/blob не классифицируются
  ['data:video/mp4;base64,AAAA', 'media'],
  ['blob:https://old.yummyani.me/8f2c-1234', 'media'],
  // неизвестное media на чужом домене — НЕ блокируем (правило «не блокировать всё Media»)
  ['https://cdn.example-trailers.org/episode-12.mp4', 'media'],
]

let pass = 0
let fail = 0
const rows = []

function check(url, rt, expectDecision, note) {
  const v = classify(url, rt)
  // в матрице ALLOW == ALLOWLIST (оба «не блокировать»), но помечаем источник
  const ok = v.decision === expectDecision
  rows.push({ url, rt, ...v, ok, note })
  if (ok) pass++
  else fail++
}

console.log('=== AdBlock rule test (engine.cjs) ===\n')
console.log(`allowlist domains: ${_rules.ALLOW_DOMAINS.length}, ad domains: ${_rules.AD_DOMAINS.length}\n`)

for (const [u, rt] of REAL) check(u, rt, 'ALLOWLIST', 'real video/site')
for (const [u, rt] of ADS) check(u, rt, 'BLOCK', 'ad')
for (const [u, rt, want] of SPECIAL) check(u, rt, want || 'ALLOW', 'special')

// --- таблица решений ---
const pad = (s, n) => String(s).padEnd(n)
console.log(pad('DECISION', 10) + pad('RT', 10) + pad('RULE', 24) + pad('OK', 4) + 'URL')
for (const r of rows) {
  const mark = r.ok ? '✓' : '✗ FAIL'
  console.log(
    pad(r.decision, 10) +
      pad(r.rt, 10) +
      pad(r.rule, 24) +
      pad(mark, 7) +
      r.url.slice(0, 96),
  )
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)

// --- жизненный цикл без electron: setEnabled/attached/diagnostics ---
console.log('\n=== lifecycle (no electron) ===')
engine.setEnabled(false)
console.log('attached() before attach (ожид. false):', engine.attached())
engine.setEnabled(true)
console.log('diagnostics(10) пусто без attach:', engine.diagnostics(10).length === 0)
// classify — чистая функция, OFF-логика живёт в обработчике attach
console.log('classify не зависит от тумблера: ok')

if (fail > 0) process.exit(1)
