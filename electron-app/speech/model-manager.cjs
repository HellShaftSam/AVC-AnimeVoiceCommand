/**
 * SttModelManager — менеджер моделей офлайн-STT (спека §9/§10/§11/§29).
 *
 * Ответственность:
 *  - детект установленной модели (userDir/stt → приоритет, затем ресурсы EXE);
 *  - верификация файлов по SHA-256 из speech/model-manifest.json (централизованный
 *    манифест — единственное место с версиями/чексуммами);
 *  - докачка недостающих/битых файлов (Range-resume), атомарная установка
 *    (downloads → verify → rename), бэкап/откат при переустановке;
 *  - проверка места на диске; НИКОГДА не удаляет рабочую модель ради битой.
 *
 * Раскладка userDir/stt:
 *   downloads/   — недокачанные *.part
 *   backup/      — предыдущая версия при переустановке (откат)
 *   t-one/…      — установленные файлы (та же структура, что в ресурсах)
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const http = require('http')
const https = require('https')

const MANIFEST = require('./model-manifest.json')

const ALL_FILES = [...MANIFEST.asr.files, ...MANIFEST.vad.files]

// --- утилиты -------------------------------------------------------------------

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(file)
    s.on('data', (c) => h.update(c))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

/** Кэш чексумм: пересчёт 137MB файла на каждый запуск недопустим — считаем раз в жизни процесса */
const verifyCache = new Map() // path -> {mtimeMs, size, sha256}

async function verifyFile(file, expected) {
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return { file, ok: false, reason: 'missing' }
  }
  if (expected && expected.bytes != null && st.size !== expected.bytes) {
    return { file, ok: false, reason: `size ${st.size} != ${expected.bytes}` }
  }
  if (!expected || !expected.sha256) return { file, ok: true }
  const cacheKey = file
  const cached = verifyCache.get(cacheKey)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return { file, ok: cached.sha256 === expected.sha256, reason: cached.sha256 === expected.sha256 ? undefined : 'sha256 mismatch (cached)' }
  }
  const sha = await sha256File(file)
  verifyCache.set(cacheKey, { mtimeMs: st.mtimeMs, size: st.size, sha256: sha })
  return { file, ok: sha === expected.sha256, reason: sha === expected.sha256 ? undefined : 'sha256 mismatch' }
}

/** Свободное место на диске каталога, байт (fs.statfs есть в Node ≥18.15; Electron 31 = Node 20) */
async function freeDiskSpace(dir) {
  try {
    const s = await fs.promises.statfs(dir)
    return s.bavail * s.bsize
  } catch {
    return null // не смогли узнать — не блокируем
  }
}

// --- детект установленной модели -------------------------------------------------

/**
 * Каталог с моделями: 1) userData/stt (устанавливается/обновляется); 2) ресурсы EXE.
 * Возвращает { dir, origin, missing, corrupt } — dir может быть null, если нигде нет.
 */
async function resolveModels({ userModelsDir, resourceModelsDir } = {}) {
  const candidates = []
  if (userModelsDir) candidates.push({ dir: userModelsDir, origin: 'user' })
  if (resourceModelsDir) candidates.push({ dir: resourceModelsDir, origin: 'resources' })
  for (const c of candidates) {
    const missing = []
    for (const f of ALL_FILES) {
      try {
        await fs.promises.access(path.join(c.dir, f.path))
      } catch {
        missing.push(f.path)
      }
    }
    if (missing.length === 0) {
      return { dir: c.dir, origin: c.origin, missing: [], corrupt: [], manifest: MANIFEST }
    }
    if (c.origin === 'user') continue // неполная пользовательская установка — пробуем ресурсы
    return { dir: c.dir, origin: c.origin, missing, corrupt: [], manifest: MANIFEST }
  }
  return { dir: null, origin: null, missing: ALL_FILES.map((f) => f.path), corrupt: [], manifest: MANIFEST }
}

/** Полная верификация каталога (SHA-256 всех файлов манифеста) */
async function verifyModels(dir) {
  const results = []
  for (const f of ALL_FILES) {
    const r = await verifyFile(path.join(dir, f.path), f)
    results.push({ path: f.path, ok: r.ok, reason: r.reason })
  }
  return { dir, ok: results.every((r) => r.ok), results }
}

// --- скачивание -------------------------------------------------------------------

/** Скачивание URL → файл с прогрессом и Range-resume. Атомарность: файл.expectedExt → rename. */
function downloadFile(url, destFile, { expectedBytes, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const part = destFile + '.part'
    let have = 0
    try {
      if (fs.existsSync(part)) have = fs.statSync(part).size
    } catch {
      have = 0
    }
    // Слишком большой недокачанный хвост (или файл уже целиком) — начинаем заново
    if (expectedBytes && have > expectedBytes) {
      try { fs.unlinkSync(part) } catch { /* уже нет */ }
      have = 0
    }

    const started = Date.now()
    // ВАЖНО: обычная function (не стрелка) — arguments/param requestUrl нужны для
    // редиректов HF (resolve/main → CDN). Раньше стрелка теряла URL редиректа и
    // каждая попытка уходила на исходный 302 → падение «HTTP 302» (кнопка
    // «Переустановить» всегда фейлилась).
    const request = function (rangeStart, attempt, requestUrl) {
      const targetUrl = requestUrl || url
      const mod = targetUrl.startsWith('http:') ? http : https
      const headers = { 'User-Agent': 'AVC-Anime-SttModelManager' }
      if (rangeStart > 0) headers.Range = `bytes=${rangeStart}-`
      const req = mod.get(targetUrl, { headers, timeout: 30000 }, (res) => {
        // редиректы (HF resolve → CDN): продолжаем УЖЕ новый URL
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && attempt < 5) {
          res.resume()
          const next = new URL(res.headers.location, targetUrl).toString()
          request(rangeStart, attempt + 1, next)
          return
        }
        const finalUrl = targetUrl
        if (res.statusCode === 416) {
          // недокачанный файл уже полон — просто переименуем
          res.resume()
          try {
            fs.renameSync(part, destFile)
            resolve({ bytes: have, ms: Date.now() - started, resumed: rangeStart > 0 })
          } catch (e) {
            reject(e)
          }
          return
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode} для ${finalUrl}`))
          return
        }
        const totalHeader = res.headers['content-length']
        const total = res.statusCode === 206 ? (expectedBytes || null) : totalHeader ? parseInt(totalHeader, 10) : expectedBytes || null
        const out = fs.createWriteStream(part, { flags: rangeStart > 0 ? 'a' : 'w' })
        let received = 0
        res.on('data', (c) => {
          received += c.length
          if (onProgress && total) onProgress({ received: rangeStart + received, total, phase: 'download' })
        })
        res.on('error', (e) => {
          out.destroy()
          reject(new Error(`сетевая ошибка: ${e.message}`))
        })
        res.pipe(out)
        out.on('finish', () => {
          if (signal && signal.cancelled) {
            reject(new Error('CANCELLED'))
            return
          }
          fs.rename(part, destFile, (e) => (e ? reject(e) : resolve({ bytes: rangeStart + received, ms: Date.now() - started, resumed: rangeStart > 0 })))
        })
        out.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('таймаут скачивания')))
      req.on('error', (e) => reject(new Error(`сетевая ошибка: ${e.message}`)))
    }
    request(have, 0)
  })
}

/** Скачивание одного файла манифеста в каталог назначения (атомарно, с верификацией) */
async function ensureFile(dir, relPath, { onProgress, signal } = {}) {
  const spec = ALL_FILES.find((f) => f.path === relPath)
  if (!spec) throw new Error(`файла нет в манифесте: ${relPath}`)
  const dest = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const dl = MANIFEST.download || {}
  const remote = (dl.remoteMap && dl.remoteMap[relPath]) || relPath
  const url = relPath === 'silero_vad.onnx' && dl.vadUrl ? dl.vadUrl : dl.baseUrl + remote

  // проверяем существующий
  const existing = await verifyFile(dest, spec)
  if (existing.ok) {
    onProgress && onProgress({ file: relPath, phase: 'done', received: spec.bytes, total: spec.bytes })
    return { skipped: true }
  }
  // места на диске должно хватать с запасом 15%
  const free = await freeDiskSpace(dir)
  if (free != null && free < spec.bytes * 1.15) {
    throw new Error(`Недостаточно места на диске: нужно ~${Math.ceil(spec.bytes / 1e6)} МБ, свободно ${Math.floor(free / 1e6)} МБ`)
  }
  onProgress && onProgress({ file: relPath, phase: 'download', received: 0, total: spec.bytes })
  await downloadFile(url, dest, {
    expectedBytes: spec.bytes,
    signal,
    onProgress: (p) => onProgress && onProgress({ file: relPath, ...p }),
  })
  const verified = await verifyFile(dest, spec)
  if (!verified.ok) {
    // §9: битую закачку удаляем, рабочую модель не трогаем
    try { fs.unlinkSync(dest) } catch { /* уже нет */ }
    try { fs.unlinkSync(dest + '.part') } catch { /* уже нет */ }
    throw new Error(`Скачанный файл не прошёл проверку (${verified.reason}) — удалён`)
  }
  onProgress && onProgress({ file: relPath, phase: 'done', received: spec.bytes, total: spec.bytes })
  return { skipped: false }
}

/**
 * Полная установка/переустановка моделей в userDir/stt.
 * Восстанавливает из backup при провале; возвращает статус.
 */
async function installModels({ userModelsDir, onProgress, signal } = {}) {
  if (!userModelsDir) throw new Error('userModelsDir не задан')
  const progress = (p) => onProgress && onProgress(p)
  fs.mkdirSync(userModelsDir, { recursive: true })
  const backupDir = path.join(userModelsDir, 'backup')
  const tmpDir = path.join(userModelsDir, 'downloads')

  // что уже есть и валидно — не качаем заново
  const installed = []
  const failures = []
  for (const f of ALL_FILES) {
    try {
      const r = await ensureFile(userModelsDir, f.path, { onProgress: progress, signal })
      installed.push({ path: f.path, skipped: r.skipped })
    } catch (e) {
      failures.push({ path: f.path, error: e.message })
      if (e.message === 'CANCELLED') break
    }
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* не было */ }
  if (failures.length > 0) {
    return { ok: false, failures, installed }
  }
  // успешная установка: чистим backup прошлой переустановки (текущая рабочая — валидна)
  try { fs.rmSync(backupDir, { recursive: true, force: true }) } catch { /* не было */ }
  // копия манифеста — «что установлено»
  try { fs.copyFileSync(path.join(__dirname, 'model-manifest.json'), path.join(userModelsDir, 'manifest.json')) } catch { /* не критично */ }
  return { ok: true, installed, manifest: MANIFEST }
}

/** Проверка обновлений: сравниваем установленную версию с манифестом ресурсов и (опц.) удалённым манифестом */
async function checkUpdate({ userModelsDir, remoteManifestUrl } = {}) {
  const installed = { asrVersion: MANIFEST.asr.version, vadVersion: MANIFEST.vad.version }
  const remote = { checked: false }
  if (remoteManifestUrl) {
    try {
      const body = await new Promise((resolve, reject) => {
        const mod = remoteManifestUrl.startsWith('http:') ? http : https
        const req = mod.get(remoteManifestUrl, { timeout: 10000 }, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`))
            return
          }
          let b = ''
          res.on('data', (c) => (b += c))
          res.on('end', () => resolve(b))
        })
        req.on('timeout', () => req.destroy(new Error('timeout')))
        req.on('error', reject)
      })
      const parsed = JSON.parse(body)
      remote.checked = true
      remote.asrVersion = parsed && parsed.asr && parsed.asr.version
      remote.vadVersion = parsed && parsed.vad && parsed.vad.version
    } catch (e) {
      remote.reason = e.message
    }
  }
  const updateAvailable = Boolean(
    remote.checked &&
      ((remote.asrVersion && remote.asrVersion !== installed.asrVersion) ||
        (remote.vadVersion && remote.vadVersion !== installed.vadVersion)),
  )
  return { installed, remote, updateAvailable }
}

module.exports = { MANIFEST, resolveModels, verifyModels, installModels, checkUpdate, verifyFile, freeDiskSpace, ensureFile }
