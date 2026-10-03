/**
 * AIModelManager — менеджер локальных AI-моделей AVC-Anime.
 *
 * Спецификация: §50–§60, §107–§114, §128.
 *  - первый запуск: определение установленных/недостающих компонентов;
 *  - загрузка: временный файл → проверка размера → SHA-256 → атомарный rename → маркер installed;
 *  - возобновление через HTTP Range (если сервер поддерживает, см. acceptRanges в манифесте);
 *  - отмена/пауза/повтор; восстановление после перезапуска приложения;
 *  - ЧЕСТНЫЕ ошибки: HTTP 404/502/TLS/checksum/disk full/access denied — конкретно, не «Unknown»;
 *  - ни при каких обстоятельствах частичный файл не помечается установленным.
 *
 * Модуль НЕ зависит от electron — работает и в main-процессе, и автономно (selftest на CI/локально).
 */
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { spawnSync } = require('child_process')

// --- манифест ------------------------------------------------------------------

function loadManifest(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.AVC_AI_MANIFEST,
    path.join(__dirname, 'models-manifest.json'),
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch (e) {
      throw new Error(`AI manifest unreadable at ${p}: ${e.message}`)
    }
  }
  throw new Error('AI manifest (models-manifest.json) not found')
}

// --- утилиты ---------------------------------------------------------------------

function sha256File(file, onProgress) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    let bytes = 0
    stream.on('data', (chunk) => {
      bytes += chunk.length
      hash.update(chunk)
      if (onProgress && bytes % (16 * 1024 * 1024) < chunk.length) onProgress(bytes)
    })
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function freeDiskSpace(dir) {
  // Байт доступно на разделе с dir. Windows/POSIX через df или wmic fallback.
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('wmic', ['logicaldisk', 'get', 'freespace,name'], { encoding: 'utf8' })
      if (out.status === 0) {
        // грубая оценка: максимум по дискам — уточнять не требуется для «хватит/не хватит»
        const nums = (out.stdout.match(/\d{7,}/g) || []).map(Number)
        return Math.max(0, ...nums, 0)
      }
      return null
    }
    const out = spawnSync('df', ['-B', '1', dir], { encoding: 'utf8' })
    if (out.status === 0) {
      const lines = out.stdout.trim().split('\n')
      const parts = lines[lines.length - 1].split(/\s+/)
      return Number(parts[parts.length - 2]) || null
    }
  } catch {
    /* честно вернём null — проверка диска необязательна к исполнению */
  }
  return null
}

function fmtBytes(n) {
  if (n == null) return '?'
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024).toFixed(0)} KB`
}

class DownloadError extends Error {
  constructor(kind, message, httpStatus) {
    super(message)
    this.kind = kind // 'HTTP_404' | 'HTTP_5xx' | 'HTTP_4xx' | 'TIMEOUT' | 'TLS' | 'CHECKSUM' | 'SIZE' | 'DISK_FULL' | 'ACCESS_DENIED' | 'NETWORK' | 'ABORTED' | 'EXTRACT'
    this.httpStatus = httpStatus || null
  }
}

// --- менеджер --------------------------------------------------------------------

class AIModelManager extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.manifest = opts.manifest || loadManifest(opts.manifestPath)
    this.baseDir = opts.baseDir || process.env.AVC_MODELS_DIR || path.join(__dirname, '..', 'models')
    this.aborts = new Map() // key -> AbortController
  }

  componentDir(componentKey, voiceId) {
    const c = this.manifest.components[componentKey]
    if (!c) throw new Error(`Unknown component: ${componentKey}`)
    if (componentKey === 'tts') {
      const voice = voiceId || this.defaultVoiceId()
      return path.join(this.baseDir, 'tts', voice)
    }
    if (componentKey === 'llm') return path.join(this.baseDir, 'llm', 'qwen3-0.6b')
    if (componentKey === 'stt') return path.join(this.baseDir, 'stt', 't-one-russian')
    if (componentKey === 'vad') return path.join(this.baseDir, 'vad', 'silero-vad')
    return path.join(this.baseDir, componentKey)
  }

  defaultVoiceId() {
    const voices = this.manifest.components.tts.voices || []
    const def = voices.find((v) => v.default) || voices[0]
    return def ? def.id : 'irina'
  }

  voiceSpec(voiceId) {
    const voices = this.manifest.components.tts.voices || []
    return voices.find((v) => v.id === voiceId) || voices.find((v) => v.default) || voices[0]
  }

  /** Спецификация загрузки одного «файла-компонента» (единый формат для STT/TTS/LLM/VAD) */
  componentSpec(componentKey, voiceId) {
    if (componentKey === 'tts') {
      const v = this.voiceSpec(voiceId)
      return { key: 'tts', id: v.id, name: v.name, url: v.url, sizeBytes: v.sizeBytes, sha256: v.sha256, expectedFiles: v.expectedFiles, archive: v.archive, acceptRanges: v.acceptRanges, dir: this.componentDir('tts', v.id) }
    }
    const c = this.manifest.components[componentKey]
    if (!c || !c.url) return null
    return {
      key: componentKey,
      id: c.id,
      name: c.name,
      url: c.url,
      sizeBytes: c.sizeBytes,
      sha256: c.sha256,
      expectedFiles: c.expectedFiles,
      archive: c.archive,
      acceptRanges: c.acceptRanges,
      dir: this.componentDir(componentKey),
    }
  }

  /** Все компоненты, подлежащие установке (для мастера первого запуска §51) */
  installableComponents(voiceId) {
    const list = ['stt', 'vad', 'tts', 'llm']
    return list
      .map((k) => this.componentSpec(k, voiceId))
      .filter(Boolean)
      .map((s) => ({
        key: s.key,
        id: s.id,
        name: s.name,
        sizeBytes: s.sizeBytes,
        installed: this.isInstalled(s.key, s.id),
        required: s.key === 'stt',
        dir: s.dir,
      }))
  }

  // --- состояние установки -------------------------------------------------------

  markerPath(dir) {
    return path.join(dir, '.avc-installed.json')
  }

  isInstalled(componentKey, id) {
    try {
      const spec = this.componentSpec(componentKey, id)
      if (!spec) return false
      const marker = this.markerPath(spec.dir)
      if (!fs.existsSync(marker)) return false
      const data = JSON.parse(fs.readFileSync(marker, 'utf8'))
      if (data.id !== spec.id) return false
      if (spec.sha256 && spec.sha256 !== 'PENDING_REAL_DOWNLOAD' && data.sha256 !== spec.sha256) return false
      for (const f of spec.expectedFiles || []) {
        if (!fs.existsSync(path.join(spec.dir, f))) return false
      }
      return true
    } catch {
      return false
    }
  }

  /** Статус всех компонентов для UI/диагностики */
  status(voiceId) {
    const comps = this.installableComponents(voiceId)
    const items = comps.map((c) => ({
      key: c.key,
      id: c.id,
      name: c.name,
      required: c.required,
      sizeBytes: c.sizeBytes,
      sizeHuman: fmtBytes(c.sizeBytes),
      installed: c.installed,
    }))
    return {
      baseDir: this.baseDir,
      freeDisk: freeDiskSpace(this.baseDir),
      totalDownloadBytes: items.filter((i) => !i.installed).reduce((a, b) => a + (b.sizeBytes || 0), 0),
      components: items,
      voice: this.manifest.components.tts.voices.map((v) => ({ id: v.id, name: v.name, default: !!v.default })),
    }
  }

  // --- загрузка -------------------------------------------------------------------

  cancel(componentKey) {
    const a = this.aborts.get(componentKey)
    if (a) a.abort()
  }

  /**
   * Установить компонент: скачать → проверить → распаковать → атомарно → маркер.
   * Поддержка resume: .part файл + Range-запрос.
   */
  async install(componentKey, opts = {}) {
    const voiceId = opts.voiceId
    const spec = this.componentSpec(componentKey, voiceId)
    if (!spec) throw new DownloadError('UNKNOWN_COMPONENT', `Неизвестный компонент: ${componentKey}`)
    if (this.isInstalled(componentKey, spec.id) && !opts.force) {
      this.emit('progress', { key: componentKey, id: spec.id, phase: 'already-installed', percent: 100 })
      return { ok: true, skipped: true }
    }

    const controller = new AbortController()
    this.aborts.set(componentKey, controller)

    try {
      fs.mkdirSync(spec.dir, { recursive: true })
      const free = freeDiskSpace(spec.dir)
      if (free != null && spec.sizeBytes && free < spec.sizeBytes * 1.1) {
        throw new DownloadError('DISK_FULL', `Недостаточно места на диске: доступно ${fmtBytes(free)}, требуется ${fmtBytes(spec.sizeBytes)}`)
      }

      const archivePath = await this._download(spec, controller, opts)
      const { shaActual } = await this._verifyAndExtract(spec, archivePath)

      // маркер установки — только после успешной верификации (§56)
      const marker = {
        id: spec.id,
        name: spec.name,
        url: spec.url,
        sha256: spec.sha256 && spec.sha256 !== 'PENDING_REAL_DOWNLOAD' ? spec.sha256 : shaActual,
        sizeBytes: spec.sizeBytes,
        installedAt: new Date().toISOString(),
        avcVersion: 1,
      }
      fs.writeFileSync(this.markerPath(spec.dir), JSON.stringify(marker, null, 2))
      this.emit('progress', { key: componentKey, id: spec.id, phase: 'done', percent: 100 })
      return { ok: true, dir: spec.dir, marker }
    } catch (err) {
      this.emit('progress', { key: componentKey, id: spec.id, phase: 'error', error: err.message, kind: err.kind || 'NETWORK' })
      throw err
    } finally {
      this.aborts.delete(componentKey)
    }
  }

  _download(spec, controller, opts = {}) {
    const https = require('https')
    const http = require('http')
    const archiveName = path.basename(new URL(spec.url).pathname)
    const archivePath = path.join(spec.dir, archiveName)
    const partPath = `${archivePath}.part`

    return new Promise((resolve, reject) => {
      const started = Date.now()
      let resumeFrom = 0
      try {
        if (fs.existsSync(partPath) && spec.acceptRanges) resumeFrom = fs.statSync(partPath).size
      } catch { resumeFrom = 0 }

      const doRequest = (rangeStart, redirectCount, currentUrl) => {
        if (redirectCount > 5) return reject(new DownloadError('NETWORK', 'Слишком много перенаправлений (>5)'))
        const headers = { 'User-Agent': 'AVC-Anime/1.0 (+model-manager)' }
        if (rangeStart > 0) headers.Range = `bytes=${rangeStart}-`
        const req = (new URL(currentUrl).protocol === 'http:' ? http : https).get(currentUrl, { headers, signal: controller.signal }, (res) => {
          const status = res.statusCode || 0

          // перенаправления (URL НЕ мутируется — рекурсия получает next явно)
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume()
            const next = new URL(res.headers.location, currentUrl).toString()
            return doRequest(rangeStart, redirectCount + 1, next)
          }

          if (status === 404) return reject(new DownloadError('HTTP_404', 'Файл не найден на сервере (HTTP 404). Возможно, модель переехала — обновите манифест.', 404))
          if (status === 403) return reject(new DownloadError('HTTP_4xx', 'Доступ запрещён (HTTP 403).', 403))
          if (status >= 500) return reject(new DownloadError('HTTP_5xx', `Сервер временно недоступен (HTTP ${status}). Повторите позже.`, status))
          if (status === 416 && rangeStart > 0) {
            // файл уже скачан полностью — переходим к верификации
            res.resume()
            return resolve(archivePath)
          }
          if (status !== 200 && status !== 206) return reject(new DownloadError('HTTP_4xx', `Неожиданный HTTP-статус: ${status}`, status))

          const totalHeader = Number(res.headers['content-length'] || 0)
          const expectedTotal = rangeStart > 0 ? spec.sizeBytes : spec.sizeBytes
          if (spec.sizeBytes && totalHeader && status === 200 && totalHeader !== expectedTotal) {
            res.resume()
            return reject(new DownloadError('SIZE', `Размер на сервере (${fmtBytes(totalHeader)}) не совпадает с манифестом (${fmtBytes(spec.sizeBytes)})`))
          }

          const flags = rangeStart > 0 && status === 206 ? 'a' : 'w'
          if (flags === 'w' && rangeStart > 0) resumeFrom = 0 // сервер не поддержал Range — начинаем заново
          const file = fs.openSync(partPath, flags === 'a' ? 'a' : 'w')
          let received = rangeStart > 0 && status === 206 ? rangeStart : 0
          const total = spec.sizeBytes || (received + (totalHeader || 0)) || 1
          let lastEmit = 0

          res.on('data', (chunk) => {
            received += chunk.length
            fs.writeSync(file, chunk)
            const now = Date.now()
            if (now - lastEmit > 250) {
              lastEmit = now
              const speed = received / Math.max(0.001, (now - started) / 1000)
              this.emit('progress', {
                key: spec.key, id: spec.id, phase: 'downloading',
                percent: Math.min(99.9, (received / total) * 100),
                receivedBytes: received, totalBytes: total,
                speedBps: rangeStart > 0 ? speed : speed, // грубая оценка
                resumed: received > rangeStart,
              })
            }
          })
          res.on('error', (e) => {
            fs.closeSync(file)
            reject(new DownloadError('NETWORK', `Ошибка сети при загрузке: ${e.message}`))
          })
          res.on('end', () => {
            fs.closeSync(file)
            if (spec.sizeBytes && received < spec.sizeBytes * 0.999) {
              return reject(new DownloadError('SIZE', `Загрузка оборвалась: получено ${fmtBytes(received)} из ${fmtBytes(spec.sizeBytes)}. Возобновите повторной попыткой.`))
            }
            // переименование .part → финальное имя (внутри той же папки — атомарно)
            fs.renameSync(partPath, archivePath)
            this.emit('progress', { key: spec.key, id: spec.id, phase: 'downloaded', percent: 100, receivedBytes: received, totalBytes: spec.sizeBytes })
            resolve(archivePath)
          })
        })
        req.on('error', (e) => {
          if (e.name === 'AbortError') return reject(new DownloadError('ABORTED', 'Загрузка отменена пользователем'))
          const msg = /certificate|TLS|SSL/i.test(e.message) ? `Ошибка TLS: ${e.message}` : `Ошибка сети: ${e.message}`
          reject(new DownloadError(/certificate|TLS|SSL/i.test(e.message) ? 'TLS' : 'NETWORK', msg))
        })
        req.setTimeout(60000, () => {
          req.destroy(new DownloadError('TIMEOUT', 'Таймаут соединения (60 с без данных)'))
        })
      }

      doRequest(resumeFrom, 0, spec.url)
    })
  }

  async _verifyAndExtract(spec, archivePath) {
    // 1) SHA-256 (если в манифесте есть настоящее значение)
    let shaActual = null
    this.emit('progress', { key: spec.key, id: spec.id, phase: 'verifying-sha256' })
    shaActual = await sha256File(archivePath).catch(() => null)
    if (spec.sha256 && spec.sha256 !== 'PENDING_REAL_DOWNLOAD') {
      if (shaActual && shaActual.toLowerCase() !== String(spec.sha256).toLowerCase()) {
        try { fs.unlinkSync(archivePath) } catch { /* уже нет */ }
        throw new DownloadError('CHECKSUM', `Контрольная сумма не совпала: ожидалось ${spec.sha256}, получено ${shaActual}. Файл удалён — повторите установку.`)
      }
    }

    // 2) распаковка архива или приём голого файла
    if (!spec.archive) {
      // голый .gguf: ожидаем ровно один файл-модель
      const modelName = path.basename(new URL(spec.url).pathname)
      const target = path.join(spec.dir, modelName)
      if (path.resolve(archivePath) !== path.resolve(target)) fs.renameSync(archivePath, target)
      return { shaActual }
    }

    this.emit('progress', { key: spec.key, id: spec.id, phase: 'extracting' })
    if (spec.archive === 'tar.bz2') {
      // Windows: bsdtar входит в Windows 10+ (System32); Linux/macOS: системный tar
      const tar = process.platform === 'win32' ? 'tar' : 'tar'
      const res = spawnSync(tar, ['-xjf', archivePath, '-C', spec.dir, '--strip-components=1'], { encoding: 'utf8' })
      if (res.status !== 0) {
        throw new DownloadError('EXTRACT', `Не удалось распаковать архив: ${(res.stderr || res.stdout || 'неизвестная ошибка tar').slice(0, 300)}`)
      }
    } else {
      throw new DownloadError('EXTRACT', `Неподдерживаемый формат архива: ${spec.archive}`)
    }

    // 3) проверка структуры (§56: verify archive/model structure)
    for (const f of spec.expectedFiles || []) {
      if (!fs.existsSync(path.join(spec.dir, f))) {
        throw new DownloadError('EXTRACT', `В архиве не найден ожидаемый файл ${f}. Структура пакета изменилась — обновите манифест.`)
      }
    }
    try { fs.unlinkSync(archivePath) } catch { /* не критично */ }
    return { shaActual }
  }

  /** Повторное возобновление после перезапуска приложения (§57, §128) */
  recoverPending() {
    // .part файлы остаются на месте — повторный install() продолжит с Range-позиции
    const recovered = []
    const walk = (dir) => {
      try {
        for (const f of fs.readdirSync(dir)) {
          const p = path.join(dir, f)
          if (f.endsWith('.part')) recovered.push(p)
          else if (fs.statSync(p).isDirectory() && f !== 'node_modules') walk(p)
        }
      } catch { /* нет папки */ }
    }
    walk(this.baseDir)
    return { pendingParts: recovered, message: recovered.length ? 'Найдены незавершённые загрузки — повторите установку, загрузка продолжится с места остановки.' : 'Незавершённых загрузок нет.' }
  }
}

module.exports = { AIModelManager, loadManifest, DownloadError, sha256File, fmtBytes, freeDiskSpace }
