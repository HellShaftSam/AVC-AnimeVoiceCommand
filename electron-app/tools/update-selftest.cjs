#!/usr/bin/env node
/**
 * update-selftest.cjs — проверка цепочки автообновления БЕЗ Electron.
 *
 * Что проверяет (данные живого GitHub):
 *   T1-T5: compareVersions/parseVersion — юнит (копия логики main.cjs §3.3)
 *   T6:    releases/latest отвечает, структура корректна (tag_name, assets)
 *   T7:    EXE-ассет найден по правилу апдейтера (/\.exe$/i)
 *   T8:    целостность БЕЗ SHA-файла: assets[].digest = "sha256:<64hex>" от GitHub;
 *          юнит-проверки парсера digest и sanity-правила (размер/PE "MZ")
 *   T9:    «доступно обновление» для заведомо старой версии = true, для новой = false
 *
 * Запуск: node tools/update-selftest.cjs
 *   GITHUB_TOKEN=… — опционально: анонимный лимит GitHub API 60/час на IP
 *   (в песочнице IP общий — без токена возможен 403; сам EXE токена не требует)
 */
const https = require('https')

const REPO = 'HellShaftSam/AVC-AnimeVoiceCommand'
let pass = 0
let fail = 0
const results = []
const t = (id, name, ok, detail = '') => {
  results.push({ id, name, ok, detail })
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ` — ${detail}` : ''}`)
}

// --- копия логики main.cjs (§3.3) ---------------------------------------------
const parseVersion = (s) => {
  const m = String(s || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/i)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
const compareVersions = (a, b) => {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va || !vb) return null
  for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i] > vb[i] ? 1 : -1
  return 0
}

// Копия логики main.cjs §3.9: парсинг digest ассета
const parseAssetDigest = (raw) => {
  if (typeof raw !== 'string') return null
  const m = raw.trim().match(/^sha256:([a-fA-F0-9]{64})$/i)
  return m ? m[1].toLowerCase() : null
}

// Копия sanity-правил main.cjs (fallback без digest)
const isPlausibleExe = (sizeBytes, head) =>
  sizeBytes >= 10 * 1024 * 1024 && head.slice(0, 2).toString('ascii') === 'MZ'

// --- T1..T5: версии + юнит правил целостности -----------------------------------
t('T1', 'равные версии = up-to-date', compareVersions('v1.0.28', '1.0.28') === 0)
t('T2', 'новее (патч)', compareVersions('v1.0.29', '1.0.28') === 1)
t('T3', 'новее (минор, 1.10 > 1.9)', compareVersions('v1.10.0', 'v1.9.0') === 1)
t('T4', 'старее', compareVersions('v1.0.27', '1.0.28') === -1)
t('T5', 'мусор = null (не качаем)', compareVersions('garbage', '1.0.28') === null)
t(
  'T5b',
  'digest парсится: "sha256:<64hex>" → hex, мусор → null',
  parseAssetDigest('sha256:7825005f2b63ebc91fc36ce26f5cfbed2481a1d44d0ab7d6f932a5fa57e533eb') === '7825005f2b63ebc91fc36ce26f5cfbed2481a1d44d0ab7d6f932a5fa57e533eb' &&
    parseAssetDigest('sha256:xyz') === null &&
    parseAssetDigest('md5:7825005f2b63ebc91fc36ce26f5cfbed2481a1d44d0ab7d6f932a5fa57e533eb') === null,
)
t(
  'T5c',
  'sanity EXE: ≥10 МБ + "MZ" проходит, без MZ/малый — нет',
  isPlausibleExe(20 * 1024 * 1024, Buffer.from('MZ\x90\x00', 'ascii')) &&
    !isPlausibleExe(20 * 1024 * 1024, Buffer.from('NO', 'ascii')) &&
    !isPlausibleExe(1024, Buffer.from('MZ', 'ascii')),
)

// --- https helper ---------------------------------------------------------------
function httpsGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'))
    // Токен опционален: песочница/CI упираются в анонимный лимит 60/час на IP;
    // пользовательский EXE ходит без токена — здесь токен только для проверки данных.
    const headers = { 'User-Agent': 'AVC-Anime-Updater-Selftest', Accept: 'application/vnd.github+json' }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          return resolve(httpsGet(new URL(res.headers.location, url).toString(), redirects + 1))
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
      })
      .on('error', reject)
  })
}

// --- T6..T9: живой GitHub --------------------------------------------------------
async function main() {
  let info = null
  try {
    const { status, body } = await httpsGet(`https://api.github.com/repos/${REPO}/releases/latest`)
    t('T6', 'releases/latest доступен', status === 200, `HTTP ${status}`)
    if (status !== 200) return summary()
    const rel = JSON.parse(body.toString('utf8'))
    const latest = String(rel.tag_name || '')
    const assets = Array.isArray(rel.assets) ? rel.assets : []
    const exe = assets.find((a) => /\.exe$/i.test(a.name)) || null
    info = { latest, exe }
    t(
      'T7',
      'EXE-ассет найден и имеет browser_download_url',
      !!exe && typeof exe.browser_download_url === 'string' && exe.size > 1_000_000,
      `${exe ? `${exe.name} (${Math.round(exe.size / 1048576)} МБ)` : 'нет'}`,
    )
    // Целостность БЕЗ SHA-файла: GitHub API возвращает digest ассета сам
    const digest = parseAssetDigest(exe ? exe.digest : null)
    t(
      'T8',
      'digest ассета от GitHub API валиден (sha256:64hex)',
      !!digest,
      digest ? `sha256:${digest.slice(0, 12)}…` : `digest=${exe ? JSON.stringify(exe.digest) : 'нет ассета'}`,
    )
    const relOlder = compareVersions(latest, '1.0.1')
    const relNewer = compareVersions(latest, '99.0.0')
    t(
      'T9',
      'доступность обновления считается верно',
      relOlder === 1 && relNewer === -1,
      `latest=${latest}: vs 1.0.1 → ${relOlder}, vs 99.0.0 → ${relNewer}`,
    )
  } catch (e) {
    t('T6', 'releases/latest доступен', false, e.message)
  }
  summary()
}

function summary() {
  const report = {
    ranAt: new Date().toISOString(),
    repo: REPO,
    pass,
    fail,
    results,
  }
  const fs = require('fs')
  const path = require('path')
  const out = path.join(__dirname, 'update-selftest-report.json')
  try {
    fs.writeFileSync(out, JSON.stringify(report, null, 2))
    console.log(`\nОтчёт: ${out}`)
  } catch { /* не критично */ }
  console.log(`\nИТОГО: PASS=${pass} FAIL=${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
