/**
 * VoicePipeline — оркестратор локального голосового слоя AVC-Anime.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА (релиз 1.0.12): LLM и TTS УБРАНЫ из релиза.
 * Остался только рабочий слой распознавания речи:
 *   STT (sherpa-onnx, T-One Russian + Silero VAD) — частичные/финальные
 *   транскрипты + EarlyCommandDetector (безопасные частичные фразы).
 *
 * Архитектура (единая точка исполнения):
 *   ЭКСПУАТАЦИЯ: детерминированный парсер рендерера (parser.ts) остаётся единственным
 *   исполнителем команд. Main-процесс добавляет:
 *     1. STT-события (partial/final) → рендерер → СУЩЕСТВУЮЩИЙ парсер → СУЩЕСТВУЮЩИЙ executor;
 *     2. EarlyCommandDetector: безопасные ЧАСТИЧНЫЕ фразы → рендереру как
 *        'early-command' { type } — рендерер исполняет через ТОТ ЖЕ executor;
 *        опасное (удали/оценка/аккаунт) рано НЕ исполняется никогда.
 *
 * Слои LLM/TTS были удалены честно: контракт status/IPC сохранён (готовность = false),
 * чтобы main-процесс и UI не ломались, но воркер больше НЕ содержит их код и
 * пак с нативными зависимостями llama.cpp/sherpa-TTS не собирается (§113).
 */
'use strict'

const path = require('path')
const { EventEmitter } = require('events')
const { AIModelManager } = require('./model-manager.cjs')
const { STTService } = require('./stt-service.cjs')

/** Честная причина недоступности убранных слоёв (для UI/диагностики) */
const REMOVED_REASON = 'Убрано из релиза (решение владельца, 1.0.12)'

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

/** Метрики убранного слоя — честный «disabled» вместо выдуманных чисел */
function removedMetrics() {
  return { state: 'disabled', enabled: false, reason: REMOVED_REASON }
}

class VoicePipeline extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.modelsDir = opts.modelsDir || path.join(__dirname, '..', 'models')
    this.profile = opts.profile || 'max_responsiveness'
    this.enabled = opts.enabled !== false // §0/§129: AI — модульное расширение, можно отключить

    this.manager = new AIModelManager({ baseDir: this.modelsDir })
    this.stt = new STTService({ modelsDir: this.modelsDir, profile: this.profile })

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
  }

  /** Общий статус для AI Setup/диагностики (§97) */
  getStatus() {
    const st = this.manager.status()
    return {
      enabled: this.enabled,
      profile: this.profile,
      modelsDir: this.modelsDir,
      models: st.components,
      freeDisk: st.freeDisk,
      voices: [],
      stt: this.stt.getMetrics(),
      llm: removedMetrics(),
      tts: removedMetrics(),
      ready: {
        stt: this.stt.isReady(),
        llm: false,
        tts: false,
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

  /** §50–§53: установка компонентов (кнопка Install в AI Setup) — только STT+VAD */
  async installComponents(keys, opts = {}) {
    const allowed = ['stt', 'vad']
    const wanted = keys.filter((k) => allowed.includes(k))
    const results = []
    for (const key of wanted) {
      try {
        const r = await this.manager.install(key, opts)
        results.push({ key, ok: true, skipped: !!r.skipped })
      } catch (e) {
        results.push({ key, ok: false, kind: e.kind || 'ERROR', message: e.message })
      }
    }
    for (const key of keys.filter((k) => !allowed.includes(k))) {
      results.push({ key, ok: false, kind: 'REMOVED', message: REMOVED_REASON })
    }
    return results
  }

  cancelInstall(key) {
    this.manager.cancel(key)
  }

  /**
   * Инициализация STT (единственный оставшийся AI-сервис).
   * UI не блокируется: вызывается фоном после создания окна.
   */
  async initializeServices() {
    const out = {}
    if (STTService.modelsPresent(this.modelsDir)) out.stt = await this.stt.initialize()
    this.emit('services-status', this.getStatus().ready)
    return out
  }

  /**
   * Поэтапная инициализация: сейчас только STT (голос готов ASAP).
   * Имя сохранено для совместимости вызовов (§49 + фаза 2 аудита).
   */
  async initializeCoreThenDeferred() {
    return this.initializeServices()
  }

  /** Совместимость со старыми вызовами (больше нечего догружать) */
  async initializeDeferred() {
    return this.initializeServices()
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
   * LLM-роутер УБРАН из релиза: всегда null (рендерер честно использует
   * только детерминированный парсер).
   */
  async llmRoute() {
    return null
  }

  /**
   * TTS УБРАН из релиза: всегда null (голосовой ответ выключен).
   */
  async ttsSpeak() {
    return null
  }

  ttsCancel() { /* TTS убран — no-op */ }

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
    } catch { /* ок */ }
  }
}

module.exports = { VoicePipeline, EARLY_SAFE_PATTERNS, UNSAFE_PATTERN, REMOVED_REASON }
