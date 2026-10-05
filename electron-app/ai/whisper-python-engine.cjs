/**
 * WhisperPythonEngine — локальный STT-движок AVC-Anime на faster-whisper.
 *
 * РЕФЕРЕНС: верифицированная архитектура Mantella (v0.14, main @ c0c1ae6db01f):
 *   - faster-whisper (CTranslate2), модель загружается ОДИН раз;
 *   - ВНЕШНИЙ Silero-VAD (16 кГц, окно 512, порог 0.4, пауза 0.25 с, cap 30 с);
 *   - transcribe(language, beam_size=5, vad_filter=False); CPU → float32;
 *   - язык явный (механика Mantella: язык приложения → ru).
 * Python-сервис: ./stt-python/stt_service.py (JSON-lines over stdio).
 * Код Mantella (AGPL) не копируется — см. STT_LICENSE_AND_ATTRIBUTION.md.
 *
 * Интерфейс движка (шов ENGINES в stt-engines.cjs) — прежний:
 *   initialize() → 'ready'|'failed' (не бросает), feed(Int16), flush(),
 *   resetUtterance(), setCaptureMode(on), isReady(), getMetrics(), shutdown(),
 *   on('partial'|'final'|'status'), decodeFileForTest(wavPath).
 *
 * Краш-политика (урок 0xC0000409): Python умирает МОЛЧА не может — exit/ошибка
 * запуска ловится здесь и честно переводит движок в failed (воркер жив).
 * Авто-перезапусков нет: повторная инициализация — через restart-worker/Настройки.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const { checkModelIntegrity, checkVadIntegrity } = require('./model-integrity.cjs')

const SAMPLE_RATE = 16000

/** Ищем python: бандл EXE → env-оверрайд → системный. */
function resolvePythonBin() {
  if (process.env.AVC_STT_PYTHON) return process.env.AVC_STT_PYTHON
  const name = process.platform === 'win32' ? 'python.exe' : 'bin/python3'
  // packaged: воркер живёт в <resources>/ai/, python-runtime — в <resources>/python-runtime
  const bundled = path.join(__dirname, '..', 'python-runtime', name)
  try {
    if (fs.existsSync(bundled)) return bundled
  } catch { /* нет доступа — уходим в системный */ }
  // dev: electron-app/ai/../python-runtime (может быть собран локально) или системный
  return process.platform === 'win32' ? 'python' : 'python3'
}

class WhisperPythonEngine extends EventEmitter {
  /**
   * @param {object} opts { modelsDir, profile, modelId: 'faster-whisper-*' }
   */
  constructor(opts = {}) {
    super()
    this.modelsDir = opts.modelsDir || path.join(__dirname, '..', 'models')
    this.modelId = opts.modelId || 'faster-whisper-base'
    this.id = 'whisper-python'
    this.capabilities = { streaming: true, hotwords: false, nbest: false, punctuation: false }
    this.state = 'uninitialized' // uninitialized | loading | ready | failed
    this.error = null
    this.metrics = {
      modelLoadMs: null,
      warmupMs: null,
      lastPartialMs: null,
      lastFinalMs: null,
      lastEndpointMs: null,
      utterances: 0,
      pythonRestarts: 0,
    }
    this.utteranceSeq = 0
    // конфиг инференса (Mantella-верифицированная база)
    this.device = process.env.AVC_STT_DEVICE || 'cpu'
    this.computeType = this.device === 'cpu' ? 'float32' : null // CUDA: не передаётся
    // пути
    this.serviceScript = path.join(__dirname, 'stt-python', 'stt_service.py')
    this.pythonBin = resolvePythonBin()
    // процесс/протокол
    this.child = null
    this.reqSeq = 0
    this.pending = new Map() // id -> {resolve, reject, timer}
    this.readyWaiter = null
    this.stderrTail = []
    this.dead = false
  }

  get modelDir() {
    return path.join(this.modelsDir, 'stt', this.modelId)
  }

  get vadFile() {
    return path.join(this.modelsDir, 'vad', 'silero-vad', 'silero_vad.onnx')
  }

  /** Установлены ли файлы модели (без загрузки; маркер-осведомлённость не требуется) */
  static modelFilesPresent(modelsDir, modelId) {
    const dir = path.join(modelsDir, 'stt', modelId)
    if (!fs.existsSync(path.join(dir, 'model.bin'))) return false
    if (!fs.existsSync(path.join(dir, 'config.json'))) return false
    if (!fs.existsSync(path.join(dir, 'tokenizer.json'))) return false
    return fs.existsSync(path.join(dir, 'vocabulary.txt')) || fs.existsSync(path.join(dir, 'vocabulary.json'))
  }

  _spawnPython() {
    const args = [this.serviceScript, '--model', this.modelDir, '--vad', this.vadFile, '--language', 'ru', '--device', this.device]
    if (this.computeType) args.push('--compute-type', this.computeType)
    const child = spawn(this.pythonBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    this.child = child
    this.stderrTail = []
    this.dead = false

    // stdout → JSON-lines
    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line) this._onLine(line)
      }
      if (buf.length > 8 * 1024 * 1024) buf = '' // защита от мусора без \n
    })

    // stderr → кольцевой буфер для честных диагностик
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      for (const l of String(chunk).split('\n')) {
        if (l.trim()) {
          this.stderrTail.push(l.trim())
          if (this.stderrTail.length > 40) this.stderrTail.shift()
        }
      }
    })

    child.on('exit', (code, signal) => {
      const wasReady = this.state === 'ready'
      this.child = null
      // отклоняем ожидающие запросы
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('Python-процесс STT завершился'))
      }
      this.pending.clear()
      if (this.state === 'loading') {
        this.state = 'failed'
        this.error = `Python-процесс STT завершился до готовности (code=${code}, signal=${signal}). ${this._stderrSummary()}`
        this.emit('status', { state: this.state, error: this.error })
        if (this.readyWaiter) { this.readyWaiter(); this.readyWaiter = null }
      } else if (wasReady) {
        // движок был готов — честный отказ (воркер НЕ убиваем; restart-worker сделает чистый ре-спавн)
        this.state = 'failed'
        this.error = `Python-процесс STT завершился (code=${code}, signal=${signal}). ${this._stderrSummary()}`
        this.emit('status', { state: this.state, error: this.error })
      }
    })
    child.on('error', (e) => {
      if (this.state === 'loading') {
        this.state = 'failed'
        this.error = `Не удалось запустить Python (${this.pythonBin}): ${e.message}`
        this.emit('status', { state: this.state, error: this.error })
        if (this.readyWaiter) { this.readyWaiter(); this.readyWaiter = null }
      }
    })
    return child
  }

  _stderrSummary() {
    const tail = this.stderrTail.slice(-5).join(' | ')
    return tail ? `Python stderr: ${tail.slice(0, 400)}` : ''
  }

  _onLine(line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error || 'Ошибка STT-сервиса'))
      return
    }
    if (msg.event === 'status') {
      if (msg.state === 'ready') {
        this.metrics.modelLoadMs = msg.modelLoadMs ?? this.metrics.modelLoadMs
        this.state = 'ready'
        this.error = null
        this.emit('status', { state: this.state, modelLoadMs: this.metrics.modelLoadMs })
        if (this.readyWaiter) { this.readyWaiter(); this.readyWaiter = null }
      } else if (msg.state === 'failed') {
        this.state = 'failed'
        this.error = msg.error || 'Модель Whisper не загрузилась'
        this.emit('status', { state: this.state, error: this.error })
        if (this.readyWaiter) { this.readyWaiter(); this.readyWaiter = null }
      } else if (msg.state === 'loading-model') {
        this.emit('status', { state: 'loading', message: 'Загрузка модели Whisper' })
      }
      return
    }
    if (msg.event === 'partial') {
      this.metrics.lastPartialMs = msg.ms ?? null
      this.emit('partial', { utteranceId: msg.utteranceId, text: msg.text || '', ms: msg.ms || 0 })
      return
    }
    if (msg.event === 'final') {
      this.utteranceSeq = Math.max(this.utteranceSeq, Number(msg.utteranceId) || 0)
      this.metrics.utterances += 1
      this.metrics.lastFinalMs = msg.ms ?? null
      if (msg.reason === 'endpoint') this.metrics.lastEndpointMs = msg.ms ?? null
      this.emit('final', {
        utteranceId: msg.utteranceId,
        text: msg.text || '',
        reason: msg.reason || 'endpoint',
        ms: msg.ms || 0,
      })
      return
    }
    if (msg.event === 'log') {
      // структурные логи сервиса — в общий поток diagnostics (stderr воркера пишет main)
      if (msg.level === 'error') this.stderrTail.push(`[stt] ${msg.message}`)
    }
  }

  _request(payload, timeoutMs = 30000) {
    if (!this.child || this.child.stdin.destroyed) return Promise.reject(new Error('STT-сервис не запущен'))
    const id = ++this.reqSeq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Таймаут запроса STT-сервиса (${payload.type})`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(JSON.stringify({ id, ...payload }) + '\n')
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  async initialize() {
    if (this.state === 'ready' || this.state === 'loading') return this.state
    this.state = 'loading'
    this.error = null
    try {
      // 1) пред-полётная проверка файлов (урок 0xC0000409: битое — НЕ грузим)
      if (!WhisperPythonEngine.modelFilesPresent(this.modelsDir, this.modelId)) {
        throw new Error(`Модель ${this.modelId} не установлена — скачайте её в Настройках → AI`)
      }
      const integ = checkModelIntegrity(this.modelsDir, this.modelId)
      if (!integ.ok) {
        throw new Error(`Файлы модели ${this.modelId} повреждены (${integ.problems[0]}) — удалите и скачайте заново в Настройках → AI`)
      }
      const vadInteg = checkVadIntegrity(this.modelsDir)
      if (!vadInteg.ok) {
        throw new Error(`Silero VAD повреждён/не установлен (${vadInteg.problems[0]}) — скачайте его в Настройках → AI`)
      }
      if (!fs.existsSync(this.serviceScript)) {
        throw new Error(`Скрипт STT-сервиса не найден: ${this.serviceScript}`)
      }
      if (this.pythonBin !== 'python' && this.pythonBin !== 'python3' && !fs.existsSync(this.pythonBin)) {
        throw new Error(`Python-рантайм не найден: ${this.pythonBin}`)
      }

      // 2) спавн + ожидание 'ready' от сервиса
      const t0 = Date.now()
      this._spawnPython()
      this.metrics.pythonRestarts += 1
      await new Promise((resolve) => {
        this.readyWaiter = resolve
        const failSafe = setTimeout(() => {
          if (this.readyWaiter) {
            this.readyWaiter = null
            resolve()
          }
        }, 240000) // большие модели (medium/large) грузятся долго на слабом ПК
        this.readyWaiterFailSafe = failSafe
      })
      if (this.readyWaiterFailSafe) { clearTimeout(this.readyWaiterFailSafe); this.readyWaiterFailSafe = null }
      this.metrics.warmupMs = Date.now() - t0
      if (this.state !== 'ready') {
        const err = this.error || 'STT-сервис не подтвердил готовность (таймаут)'
        this._fail(err)
        return this.state
      }
      return this.state
    } catch (e) {
      this._fail(e.message)
      return this.state
    }
  }

  _fail(message) {
    this.state = 'failed'
    this.error = message
    try { this.child && this.child.kill() } catch { /* ок */ }
    this.emit('status', { state: this.state, error: this.error })
  }

  isReady() {
    return this.state === 'ready' && !!this.child
  }

  feed(int16Samples) {
    if (!this.isReady()) return
    try {
      const buf = Buffer.from(int16Samples.buffer, int16Samples.byteOffset, int16Samples.byteLength)
      this.child.stdin.write(JSON.stringify({ type: 'feed', audio: buf.toString('base64') }) + '\n')
    } catch { /* сервис умер — exit-обработчик переведёт в failed */ }
  }

  flush() {
    if (!this.isReady()) return
    this.child.stdin.write(JSON.stringify({ type: 'flush' }) + '\n')
  }

  resetUtterance() {
    if (!this.isReady()) return
    this.child.stdin.write(JSON.stringify({ type: 'reset' }) + '\n')
  }

  setCaptureMode(on) {
    if (!this.isReady()) return
    this.child.stdin.write(JSON.stringify({ type: 'capture-mode', on: !!on }) + '\n')
  }

  /** Прямое декодирование файла (selftest/бенчмарк) — НЕ путь живого микрофона */
  decodeFileForTest(wavPath) {
    if (!this.isReady()) throw new Error('STT не инициализирован')
    const { readWavAsFloat32 } = require('./audio-wav.cjs')
    const { samples, sampleRate } = readWavAsFloat32(wavPath)
    if (sampleRate !== 16000) throw new Error(`Неподдерживаемая частота в тесте: ${sampleRate}`)
    const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
    return this._request({ type: 'decode', audio: buf.toString('base64'), sampleRate }, 120000)
      .then((r) => ({ text: (r && r.text) || '', ms: (r && r.ms) || 0 }))
  }

  getMetrics() {
    return {
      ...this.metrics,
      state: this.state,
      error: this.error,
      device: this.device,
      computeType: this.computeType || 'default',
      model: this.modelId,
      pythonBin: this.pythonBin,
      pythonPid: this.child ? this.child.pid : null,
    }
  }

  shutdown() {
    this.dead = true
    try {
      if (this.child) {
        try { this.child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n') } catch { /* уже мёртв */ }
        const c = this.child
        setTimeout(() => { try { c.kill('SIGKILL') } catch { /* ок */ } }, 1500).unref()
        try { c.kill() } catch { /* ок */ }
      }
    } catch { /* ок */ }
    this.child = null
    this.state = 'uninitialized'
  }
}

module.exports = { WhisperPythonEngine, resolvePythonBin, SAMPLE_RATE }
