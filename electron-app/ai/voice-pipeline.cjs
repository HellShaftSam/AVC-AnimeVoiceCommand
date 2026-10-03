/**
 * VoicePipeline — оркестратор локального голосового слоя AVC-Anime (спецификация §4, §12–§14, §40–§47).
 *
 * Архитектура (единая точка исполнения, §41):
 *   ЭКСПЛУАТАЦИЯ: детерминированный парсер рендерера (parser.ts) остаётся единственным
 *   исполнителем команд. Main-процесс добавляет:
 *     1. STT-события (partial/final) → рендерер → СУЩЕСТВУЮЩИЙ парсер → СУЩЕСТВУЮЩИЙ executor;
 *     2. EarlyCommandDetector: безопасные ЧАСТИЧНЫЕ фразы (§12) → рендереру как
 *        'early-command' { type } — рендерер исполняет через ТОТ ЖЕ executor;
 *        опасное (удали/оценка/аккаунт — §13) рано НЕ исполняется никогда;
 *     3. Локальный LLM-роутер (§28–§47) — ТОЛЬКО когда парсер вернул Unknown/низкую
 *        уверенность; тот же контракт команд, что у /api/voice/interpret;
 *     4. Локальный TTS с кэшем (§22–§29) — рендерер получает WAV и проигрывает с ducking.
 *   Дедупликация (§14): early-command и final для одной фразы не исполняются дважды —
 *   main помечает utteranceId исполненным; рендерер дополнительно помечает executedIds.
 */
'use strict'

const path = require('path')
const { EventEmitter } = require('events')
const { AIModelManager } = require('./model-manager.cjs')
const { STTService } = require('./stt-service.cjs')
const { LLMService } = require('./llm-service.cjs')
const { TTSService } = require('./tts-service.cjs')

/** §12: безопасные ранние команды — только очевидные и обратимые действия плеера/навигации.
 *  Частичные фразы STT обрезают окончания, поэтому допускаются НЕПОЛНЫЕ слова,
 *  но только для тех команд, где ложное срабатывание безвредно (пауза/громкость). */
const EARLY_SAFE_PATTERNS = [
  { re: /^(следующ\w*|дальше|вперёд|next)\b.*$/, type: 'NextEpisode' },
  { re: /^(предыдущ\w*|назад|previous)\b.*$/, type: 'PreviousEpisode' },
  { re: /^(пау|пауз\w*|стоп|останови\w*)\s*\.?$/, type: 'Pause' },
  { re: /^(продолж\w*|плей|играть|play)\s*\.?$/, type: 'Play' },
  { re: /^громче\s*\.?$/, type: 'VolumeUp' },
  { re: /^тише\s*\.?$/, type: 'VolumeDown' },
  { re: /^(без звука|выключи звук)\s*\.?$/, type: 'Mute' },
  { re: /^(со звуком|включи звук)\s*\.?$/, type: 'Unmute' },
]

/** §13: опасные намерения — НИКОГДА не исполняются по частичной фразе */
const UNSAFE_PATTERN = /(удал|убер|сн[иь]м|оцен|выйд|войд|аккаунт|списк|загрузк|коммент)/i

class VoicePipeline extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.modelsDir = opts.modelsDir || path.join(__dirname, '..', 'models')
    this.profile = opts.profile || 'max_responsiveness'
    this.enabled = opts.enabled !== false // §0/§129: AI — модульное расширение, можно отключить

    this.manager = new AIModelManager({ baseDir: this.modelsDir })
    this.stt = new STTService({ modelsDir: this.modelsDir, profile: this.profile })
    this.llm = new LLMService({ modelsDir: this.modelsDir, profile: this.profile })
    this.tts = new TTSService({ modelsDir: this.modelsDir })

    /** исполненные ранние команды (§14): utteranceId → type */
    this._executedEarly = new Map()
    this._lastEarlyText = ''

    // мостим события STT наружу с проверкой ранних команд
    this.stt.on('partial', (p) => {
      const early = this._detectEarly(p.text, p.utteranceId)
      this.emit('stt-partial', { ...p, earlyCommand: early ? early.type : null })
    })
    this.stt.on('final', (p) => {
      // если раннее исполнение уже произошло для этой фразы — помечаем final как дедуплицированный
      const alreadyEarly = this._executedEarly.get(p.utteranceId) || null
      this.emit('stt-final', { ...p, earlyCommandType: alreadyEarly })
    })
    this.tts.on('speak-file', (p) => this.emit('tts-speak-file', p))
    this.tts.on('cancel-speech', () => this.emit('tts-cancel'))
  }

  /** Общий статус для AI Setup/диагностики (§97) */
  getStatus() {
    const st = this.manager.status()
    return {
      enabled: this.enabled,
      profile: this.profile,
      models: st.components,
      freeDisk: st.freeDisk,
      voices: st.voice,
      stt: this.stt.getMetrics(),
      llm: this.llm.getMetrics(),
      tts: this.tts.getMetrics(),
      ready: {
        stt: this.stt.isReady(),
        llm: this.llm.isReady(),
        tts: this.tts.isReady(),
      },
    }
  }

  /** Аппаратная информация для первого запуска (§50) */
  async getHardware() {
    const os = require('os')
    const { freeDiskSpace, fmtBytes } = require('./model-manager.cjs')
    let gpu = null
    try {
      // В Electron main: app.getGPUInfo; вне electron — null (честно)
      const electron = require('electron')
      if (electron && electron.app && electron.app.getGPUInfo) {
        const info = await electron.app.getGPUInfo('basic')
        const dev = info && info.gpuDevice && info.gpuDevice[0]
        gpu = dev ? { vendor: dev.vendorId, device: dev.deviceId, name: dev.deviceString || null } : null
      }
    } catch { /* не electron — gpu null */ }
    return {
      cpu: `${os.cpus()[0]?.model || 'unknown'} ×${os.cpus().length}`,
      cpuCount: os.cpus().length,
      ramBytes: os.totalmem(),
      ramHuman: fmtBytes(os.totalmem()),
      freeDisk: freeDiskSpace(this.modelsDir),
      platform: `${os.platform()} ${os.arch()}`,
      gpu,
    }
  }

  /** §50–§53: установка компонентов (кнопка Install в AI Setup) */
  async installComponents(keys, opts = {}) {
    const results = []
    for (const key of keys) {
      try {
        const r = await this.manager.install(key, opts)
        results.push({ key, ok: true, skipped: !!r.skipped })
      } catch (e) {
        results.push({ key, ok: false, kind: e.kind || 'ERROR', message: e.message })
      }
    }
    return results
  }

  cancelInstall(key) {
    this.manager.cancel(key)
  }

  /**
   * Инициализация всех доступных AI-сервисов (§48–§49).
   * Каждый сервис независим (§129): отказ одного не мешает остальным.
   * UI не блокируется: вызывается фоном после создания окна.
   */
  async initializeServices({ stt = true, tts = true, llm = true } = {}) {
    const out = {}
    if (stt && STTService.modelsPresent(this.modelsDir)) out.stt = await this.stt.initialize()
    if (tts && TTSService.modelPresent(this.modelsDir)) out.tts = await this.tts.initialize()
    if (llm && LLMService.modelPresent(this.modelsDir)) out.llm = await this.llm.initialize()
    this.emit('services-status', out)
    return out
  }

  /**
   * Фаза 2 (аудит №3, «медленный запуск»): поэтапная инициализация.
   * Сразу — только STT (голос готов ASAP); TTS/LLM — отложенно в фоне,
   * чтобы старт воркера не тянул тяжёлые модели, а первая команда не ждала LLM.
   */
  async initializeCoreThenDeferred({ deferredDelayMs = 8000 } = {}) {
    const out = {}
    if (STTService.modelsPresent(this.modelsDir)) out.stt = await this.stt.initialize()
    this.emit('services-status', this.getStatus().ready)
    if (this._deferredTimer) clearTimeout(this._deferredTimer)
    this._deferredTimer = setTimeout(() => {
      void this.initializeDeferred().catch(() => undefined)
    }, deferredDelayMs)
    return out
  }

  /** Догрузка TTS и LLM (фон после старта или по требованию перед первым использованием) */
  async initializeDeferred() {
    const out = {}
    if (this._deferredTimer) {
      clearTimeout(this._deferredTimer)
      this._deferredTimer = null
    }
    if (TTSService.modelPresent(this.modelsDir) && !this.tts.isReady()) {
      out.tts = await this.tts.initialize().catch((e) => ({ error: e.message }))
    }
    if (LLMService.modelPresent(this.modelsDir) && !this.llm.isReady()) {
      out.llm = await this.llm.initialize().catch((e) => ({ error: e.message }))
    }
    this.emit('services-status', this.getStatus().ready)
    return out
  }

  /**
   * §12: EarlyCommandDetector — распознавание безопасных намерений по ЧАСТИЧНОЙ транскрипции.
   * Возвращает { type } или null. Дедупликация: одна ранне-исполненная команда на utterance.
   */
  _detectEarly(partialText, utteranceId) {
    if (!partialText) return null
    const t = String(partialText).trim().toLowerCase().replace(/\s+/g, ' ')
    if (t.length < 3) return null
    if (UNSAFE_PATTERN.test(t)) return null // §13
    if (t === this._lastEarlyText) return null // тот же partial — не дублируем
    for (const p of EARLY_SAFE_PATTERNS) {
      if (p.re.test(t)) {
        const prev = this._executedEarly.get(utteranceId)
        if (prev && prev !== p.type) return null // на одну фразу — одно раннее исполнение
        if (!prev) {
          this._executedEarly.set(utteranceId, p.type)
          // ограничиваем память реестра
          if (this._executedEarly.size > 200) {
            const firstKey = this._executedEarly.keys().next().value
            this._executedEarly.delete(firstKey)
          }
        }
        this._lastEarlyText = t
        return { type: p.type, matched: t }
      }
    }
    return null
  }

  /** §14: пометка рендерером исполненного final (текст уже исполнился по partial) */
  markUtteranceHandled(utteranceId, type) {
    this._executedEarly.set(Number(utteranceId), type || 'handled')
  }

  /**
   * §28–§47: локальный LLM-роутер. Вызывается рендерером ТОЛЬКО когда
   * детерминированный парсер не смог распознать фразу. Контракт ответа —
 * как у /api/voice/interpret: { commands, needsClarification, clarifyQuestion }.
   */
  async llmRoute(text, context, opts = {}) {
    if (!this.enabled) return null
    // ленивая догрузка: первая команда не должна падать только потому,
    // что фоновая инициализация ещё не дошла до LLM (фаза 2.2)
    if (LLMService.modelPresent(this.modelsDir) && !this.llm.isReady()) {
      await this.initializeDeferred().catch(() => undefined)
    }
    if (!this.llm.isReady()) return null
    return this.llm.route(text, { context, ...opts })
  }

  /** §22–§29: локальный TTS. Рендерер получает WAV-файл + длительность для ducking. */
  async ttsSpeak(text, opts = {}) {
    if (!this.enabled) return null
    if (TTSService.modelPresent(this.modelsDir) && !this.tts.isReady()) {
      await this.initializeDeferred().catch(() => undefined)
    }
    if (!this.tts.isReady()) return null
    if (opts.cancelPrevious !== false) this.tts.cancelCurrentSpeech()
    return this.tts.speak(text, opts)
  }

  ttsCancel() {
    this.tts.cancelCurrentSpeech()
  }

  /** Подача аудио из рендерера (Int16Array 16 кГц) — путь живого микрофона (§6, §8) */
  feedAudio(int16Samples) {
    if (!this.enabled) return
    this.stt.feed(int16Samples)
  }

  flushAudio() {
    this.stt.flush()
  }

  shutdown() {
    try {
      this.stt.shutdown()
      this.llm.shutdown()
      this.tts.shutdown()
    } catch { /* ок */ }
  }
}

module.exports = { VoicePipeline, EARLY_SAFE_PATTERNS, UNSAFE_PATTERN }
