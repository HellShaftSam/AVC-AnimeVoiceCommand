/**
 * SttService — стриминговый офлайн-STT AVC-Anime (спека §5/§14/§15/§16/§31/§35/§36).
 *
 * ЕДИНСТВЕННЫЙ авторитетный STT-рантайм приложения. Живёт в Electron main-процессе:
 *   микрофон (скрытое capture-окно) → PCM 16 кГц → Silero VAD (шлюз речи) →
 *   стриминговый T-One (sherpa-onnx OnlineRecognizer) → партиалы/финалы → IPC → UI.
 *
 * Ключевые свойства:
 *  - модель грузится ОДИН раз; микрофон открывается ОДИН раз и держится открытым;
 *  - никаких WAV-файлов на диск, никакого поллинга, никакого глобального кулдауна;
 *  - партиалы каждые ~250 мс во время речи; финал — по сегменту VAD (≈0.6 с после
 *    конца речи), по release PTT, по endpoint-правилу или по таймауту тишины;
 *  - детерминированный автомат состояний; UI всегда знает текущее состояние;
 *  - восстановление: ошибки декода → пересоздание потока; серия ошибок →
 *    Recovering с экспоненциальным backoff; пропажа микрофона → ожидание возврата;
 *  - ни одного сетевого вызова в цикле распознавания (офлайн-first).
 */
const { EventEmitter } = require('events')
const path = require('path')
const modelManager = require('./model-manager.cjs')

const TARGET_SR = 16000
const VAD_WINDOW = 512 // сэмплов @16к (Silero)
const FRAME_SEC = 0.1
const PARTIAL_INTERVAL_MS = 250
/** Тишина, после которой VAD закрывает сегмент речи (сек) — задаёт задержку финала */
const DEFAULT_MIN_SILENCE = 0.6
const DEFAULT_MIN_SPEECH = 0.25
const DEFAULT_MAX_SPEECH = 30
/** Запасной финал: столько мс без речи/энергии → закрываем высказывание */
const IDLE_FINALIZE_MS = 1600
/** Одинаковый финальный текст в пределах этого окна считается дублем VAD
 *  (двойной сегмент VAD приходит в пределах ~300 мс; честный повтор команды
 *  пользователем должен выполняться — §16 без глобального кулдауна) */
const FINAL_DEDUP_MS = 700
/** Пред-буфер: сколько мс речи хранить ДО срабатывания VAD-гейта, чтобы не терять
 *  начало фразы (задержка срабатывания Silero ~250–400 мс) */
const PREROLL_MS = 1000
const MAX_QUEUED_FRAMES = 60

const STATES = [
  'Disabled', 'Checking', 'Initializing', 'DownloadingModel', 'InstallingModel',
  'LoadingModel', 'LoadingVAD', 'OpeningMicrophone', 'WarmingUp', 'Ready',
  'Listening', 'Recognizing', 'ProcessingCommand', 'Recovering', 'Error',
  'Stopping', 'Stopped',
]

function rmsOf(frame) {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / Math.max(1, frame.length))
}

class SttService extends EventEmitter {
  constructor({ userModelsDir, resourceModelsDir, sherpaDir, appVersion } = {}) {
    super()
    this.userModelsDir = userModelsDir || null
    this.resourceModelsDir = resourceModelsDir || null
    this.sherpaDir = sherpaDir || null
    this.appVersion = appVersion || ''

    this.state = 'Disabled'
    this.reason = 'not started'
    this.wantRunning = false
    this.paused = false
    this.mode = 'always' // 'always' | 'ptt'
    this.pttHeld = false

    this.config = {
      provider: 'auto', // auto | cpu | cuda (спека §18; auto → cpu, cuda при наличии пакета)
      numThreads: 2,
      vadThreshold: 0.5,
      minSilence: DEFAULT_MIN_SILENCE,
      minSpeech: DEFAULT_MIN_SPEECH,
      maxSpeech: DEFAULT_MAX_SPEECH,
      micId: '',
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }

    // рантайм
    this.sherpa = null
    this.recognizer = null
    this.vad = null
    this.model = null // {dir, origin, manifest}
    this.modelState = 'missing' // loaded | failed | missing
    this.nativeState = 'missing' // loaded | failed

    // capture-микрофон
    this.mic = null // MicService handle
    this.micStatus = 'closed' // closed | opening | open | ended | error
    this.micName = ''
    this.micDevices = []

    // текущее высказывание
    this.stream = null
    this.utteranceActive = false
    this.utteranceStartTs = 0
    this.lastVoiceTs = 0
    this.utteranceFrames = 0
    this.partialText = ''
    this.lastPartialEmitTs = 0
    this.lastFinalText = ''
    this.lastFinalTs = 0
    this.utteranceId = 0
    /** pre-roll: последние кадры до старта высказывания (не терять начало фразы) */
    this.preroll = []
    this.prerollFrames = Math.max(1, Math.round(PREROLL_MS / (FRAME_SEC * 1000)))

    // очередь кадров
    this.queue = []
    this.processing = false
    this.droppedFrames = 0

    // диагностика
    this.metrics = {
      initStartedTs: 0,
      initMs: 0,
      modelLoadMs: 0,
      vadLoadMs: 0,
      micOpenMs: 0,
      warmupMs: 0,
      decodeMsSum: 0,
      decodeMsCount: 0,
      decodeMsMax: 0,
      vadMsSum: 0,
      vadMsCount: 0,
      speechToFinalMs: 0,
      errors: 0,
      restarts: 0,
      utterances: 0,
      partials: 0,
      lastTranscript: '',
      lastFinalAt: 0,
      lastCommand: '',
      lastCommandMs: 0,
      lastCommandAt: 0,
    }
    this.errorTimestamps = []
    this.recovering = null // { timer, attempt }
    this.stopped = false
  }

  // --- служебные -----------------------------------------------------------------

  setState(state, reason) {
    if (!STATES.includes(state)) throw new Error(`unknown state: ${state}`)
    if (this.state === state && reason === undefined) return
    this.state = state
    if (reason !== undefined) this.reason = reason
    this.emit('state', this.getStatus())
  }

  setConfigError(reason) {
    this.setState('Error', reason)
  }

  // --- инициализация (спека §6/§34: асинхронно, UI не блокируем) -------------------

  /** Полная инициализация: модели → VAD → warm-up. Микрофон откроет start(). */
  async initialize() {
    if (this.state === 'Initializing' || this.state === 'Ready' || this.state === 'Listening' || this.state === 'Recognizing') return
    this.stopped = false
    this.metrics.initStartedTs = Date.now()
    this.setState('Checking', 'проверяю установку моделей')

    // 1) модели
    this.setState('LoadingModel', 'загружаю модель T-One')
    const resolved = await modelManager.resolveModels({
      userModelsDir: this.userModelsDir,
      resourceModelsDir: this.resourceModelsDir,
    })
    if (!resolved.dir) {
      this.modelState = 'missing'
      this.setConfigError('модели STT не найдены — установите голосовое управление в настройках')
      return
    }
    this.model = { dir: resolved.dir, origin: resolved.origin, manifest: resolved.manifest }

    if (!this.sherpa) {
      try {
        // eslint-disable-next-line global-require
        this.sherpa = this.sherpaDir
          ? require(path.join(this.sherpaDir, 'sherpa-onnx-node'))
          : require('sherpa-onnx-node')
        this.nativeState = 'loaded'
      } catch (e) {
        this.nativeState = 'failed'
        this.setConfigError(`нативный модуль sherpa-onnx не загружен: ${e.message}`)
        return
      }
    }

    const provider = this.resolveProvider()
    const t0 = Date.now()
    try {
      this.recognizer = new this.sherpa.OnlineRecognizer({
        modelConfig: {
          toneCtc: { model: path.join(this.model.dir, 't-one', 'model.onnx') },
          tokens: path.join(this.model.dir, 't-one', 'tokens.txt'),
          numThreads: this.config.numThreads,
          debug: 0,
          provider,
        },
        enableEndpoint: true,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.4,
        rule3MinUtteranceLength: 30,
      })
    } catch (e) {
      this.recognizer = null
      this.modelState = 'failed'
      this.setConfigError(`модель не загрузилась (${e.message})`)
      return
    }
    this.metrics.modelLoadMs = Date.now() - t0
    this.modelState = 'loaded'

    // 2) VAD
    this.setState('LoadingVAD', 'загружаю Silero VAD')
    const tv = Date.now()
    try {
      this.vad = this.createVad()
    } catch (e) {
      this.vad = null
      this.setConfigError(`Silero VAD не загрузился: ${e.message}`)
      return
    }
    this.metrics.vadLoadMs = Date.now() - tv

    // 3) warm-up (спека §35) — первая настоящая команда не должна ждать холодного старта
    this.setState('WarmingUp', 'прогреваю распознавание')
    const tw = Date.now()
    try {
      this.warmUp()
    } catch (e) {
      // прогрев не фатален — но помечаем в диагностике
      this.metrics.warmupMs = -1
      this.metrics.warmupError = e.message
    }
    this.metrics.warmupMs = Date.now() - tw
    this.metrics.initMs = Date.now() - this.metrics.initStartedTs
    this.modelState = 'loaded'
    this.setState(this.wantRunning ? 'OpeningMicrophone' : 'Ready', 'ok')
    if (this.wantRunning && !this.mic) await this.openMicrophone()
  }

  /** §18: auto → cpu (CUDA-пакет в сборку не входит; попытка cuda — только по явному выбору) */
  resolveProvider() {
    if (this.config.provider === 'cuda') return 'cuda' // упадёт честно, если пакет без CUDA
    return 'cpu'
  }

  createVad() {
    return new this.sherpa.Vad(
      {
        sileroVad: {
          model: path.join(this.model.dir, 'silero_vad.onnx'),
          threshold: this.config.vadThreshold,
          minSilenceDuration: this.config.minSilence,
          minSpeechDuration: this.config.minSpeech,
          maxSpeechDuration: this.config.maxSpeech,
          windowSize: VAD_WINDOW,
        },
        sampleRate: TARGET_SR,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      60,
    )
  }

  /** Прогрев: 0.7 с синтетического «речеподобного» сигнала через полный цикл decode */
  warmUp() {
    const stream = this.recognizer.createStream()
    const samples = new Float32Array(TARGET_SR * 0.7)
    for (let i = 0; i < samples.length; i++) {
      const t = i / TARGET_SR
      samples[i] = 0.25 * Math.sin(2 * Math.PI * 180 * t) * Math.sin(2 * Math.PI * 3.1 * t)
    }
    stream.acceptWaveform({ samples, sampleRate: TARGET_SR })
    while (this.recognizer.isReady(stream)) this.recognizer.decode(stream)
    stream.inputFinished()
    while (this.recognizer.isReady(stream)) this.recognizer.decode(stream)
    this.recognizer.getResult(stream)
  }

  // --- жизненный цикл -------------------------------------------------------------

  /** start() — включить голосовое управление: открыть микрофон и слушать. */
  async start() {
    this.wantRunning = true
    this.paused = false
    if (this.modelState !== 'loaded') {
      await this.initialize()
      if (this.modelState !== 'loaded') return
    }
    if (!this.mic || this.micStatus !== 'open') {
      await this.openMicrophone()
    }
    this.setState(this.utteranceActive ? 'Recognizing' : 'Listening', 'слушаю')
  }

  async stop() {
    this.wantRunning = false
    this.setState('Stopping', 'останавливаю')
    this.finishUtterance('stop', { silent: true })
    await this.closeMicrophone()
    this.setState('Stopped', 'остановлено')
  }

  pause() {
    if (!this.wantRunning) return
    this.paused = true
    this.finishUtterance('pause', { silent: true })
    this.setState('Ready', 'пауза')
  }

  resume() {
    if (!this.wantRunning) return
    this.paused = false
    this.setState('Listening', 'слушаю')
  }

  dispose() {
    this.stopped = true
    if (this.recovering) clearTimeout(this.recovering.timer)
    this.finishUtterance('dispose', { silent: true })
    if (this.mic) {
      try { this.mic.stop() } catch { /* уже закрыт */ }
      this.mic = null
    }
    this.vad = null
    this.recognizer = null
    this.sherpa = null
    this.setState('Stopped', 'disposed')
  }

  // --- конфигурация (зеркало настроек + IPC stt:configure) -------------------------

  configure(partial = {}) {
    let needVadRecreate = false
    let needMicReopen = false
    let needReinit = false

    if (typeof partial.vadThreshold === 'number' && partial.vadThreshold !== this.config.vadThreshold) {
      this.config.vadThreshold = Math.min(0.9, Math.max(0.05, partial.vadThreshold))
      needVadRecreate = true
    }
    if (typeof partial.minSilence === 'number' && partial.minSilence !== this.config.minSilence) {
      this.config.minSilence = Math.min(2, Math.max(0.3, partial.minSilence))
      needVadRecreate = true
    }
    if (typeof partial.minSpeech === 'number' && partial.minSpeech !== this.config.minSpeech) {
      this.config.minSpeech = Math.min(1, Math.max(0.05, partial.minSpeech))
      needVadRecreate = true
    }
    if (typeof partial.provider === 'string' && partial.provider !== this.config.provider) {
      this.config.provider = partial.provider
      needReinit = true
    }
    if (typeof partial.numThreads === 'number' && partial.numThreads !== this.config.numThreads) {
      this.config.numThreads = Math.min(4, Math.max(1, partial.numThreads))
      needReinit = true
    }
    if (typeof partial.micId === 'string' && partial.micId !== this.config.micId) {
      this.config.micId = partial.micId
      needMicReopen = true
    }
    for (const k of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
      if (typeof partial[k] === 'boolean' && partial[k] !== this.config[k]) {
        this.config[k] = partial[k]
        needMicReopen = true
      }
    }
    if (partial.mode === 'always' || partial.mode === 'ptt') {
      if (partial.mode !== this.mode) {
        this.mode = partial.mode
        if (this.mode === 'always') this.pttHeld = false
      }
    }

    if (needVadRecreate && this.vad && this.sherpa) {
      try {
        this.vad = this.createVad()
      } catch (e) {
        this.setConfigError(`VAD не пересоздан: ${e.message}`)
      }
    }
    if (needMicReopen && this.wantRunning) {
      void this.reopenMicrophone()
    }
    if (needReinit && this.modelState === 'loaded') {
      // полный рестарт распознавателя (новый provider/threads)
      this.recognizer = null
      this.vad = null
      this.modelState = 'missing'
      void this.initialize().then(() => {
        if (this.wantRunning) return this.openMicrophone()
        return undefined
      })
    }
    this.emit('state', this.getStatus())
  }

  setMode(mode) {
    this.configure({ mode })
  }

  // --- PTT (спека §20) --------------------------------------------------------------

  pttDown() {
    this.pttHeld = true
    if (!this.wantRunning) void this.start()
    this.emit('state', this.getStatus())
  }

  pttUp() {
    this.pttHeld = false
    // финализируем текущее высказывание немедленно — не ждём сегмент VAD
    if (this.utteranceActive) this.finishUtterance('ptt')
    this.emit('state', this.getStatus())
  }

  // --- микрофон ----------------------------------------------------------------------

  async openMicrophone() {
    if (this.micStatus === 'open') return
    const micService = this.micFactory ? this.micFactory() : null
    if (!micService) {
      this.micStatus = 'error'
      this.setConfigError('MicService недоступен (capture-окно не создано)')
      return
    }
    this.setState('OpeningMicrophone', 'открываю микрофон')
    this.micStatus = 'opening'
    const t0 = Date.now()
    try {
      this.mic = await micService.createCapture({
        deviceId: this.config.micId,
        sampleRate: TARGET_SR,
        echoCancellation: this.config.echoCancellation,
        noiseSuppression: this.config.noiseSuppression,
        autoGainControl: this.config.autoGainControl,
        onFrame: (int16Buffer, sampleRate) => this.pushPcmFromMic(int16Buffer, sampleRate),
        onDevices: (list) => {
          this.micDevices = list
          this.emit('devices', list)
        },
        onEnded: (reason) => this.handleMicEnded(reason),
        onError: (err) => this.handleMicError(err),
      })
      this.micStatus = 'open'
      this.metrics.micOpenMs = Date.now() - t0
      this.micOpenRetries = 0
      if (this.wantRunning && !this.paused) this.setState('Listening', 'слушаю')
    } catch (e) {
      this.micStatus = 'error'
      // Устройство может быть временно занято другим приложением — пару раз пробуем снова
      const attempt = (this.micOpenRetries = (this.micOpenRetries || 0) + 1)
      if (this.wantRunning && !this.stopped && attempt <= 3) {
        const delay = 2000 * attempt
        this.setState('Recovering', `микрофон не открыт (${e.message}); попытка ${attempt + 1} из 4 через ${delay / 1000} с`)
        setTimeout(() => {
          if (this.wantRunning && this.micStatus === 'error') void this.openMicrophone()
        }, delay)
      } else {
        this.setConfigError(`микрофон не открыт: ${e.message}`)
      }
    }
  }

  async closeMicrophone() {
    if (this.mic) {
      try { this.mic.stop() } catch { /* уже закрыт */ }
      this.mic = null
    }
    this.micStatus = 'closed'
  }

  async reopenMicrophone() {
    await this.closeMicrophone()
    if (this.wantRunning) await this.openMicrophone()
  }

  /** Пропажа микрофона (§31): ждём возврат устройства, не валим приложение */
  handleMicEnded(reason) {
    this.micStatus = 'ended'
    this.finishUtterance('mic-ended', { silent: true })
    if (!this.wantRunning || this.stopped) return
    this.setState('Recovering', `микрофон отключён (${reason}); ожидаю возврат`)
    let attempt = 0
    const tryReopen = () => {
      if (!this.wantRunning || this.stopped) return
      attempt += 1
      void this.openMicrophone().then(() => {
        if (this.micStatus === 'open') {
          this.setState('Listening', 'микрофон вернулся')
          this.metrics.restarts += 1
        } else if (attempt < 30) {
          const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5))
          this.recovering = { attempt, timer: setTimeout(tryReopen, delay) }
        } else {
          this.setConfigError('микрофон так и не вернулся — включите голосовое управление заново')
        }
      })
    }
    this.recovering = { attempt: 0, timer: setTimeout(tryReopen, 1500) }
  }

  handleMicError(err) {
    this.metrics.errors += 1
    // некритичные ошибки.capture пишем в диагностику и продолжаем
    if (this.wantRunning && this.state !== 'Error') {
      this.setState(this.utteranceActive ? 'Recognizing' : 'Listening', `ошибка захвата: ${err}`)
    }
  }

  // --- поток PCM → VAD → распознаватель -------------------------------------------------

  /** Кадр из capture-окна: Int16 mono @sampleRate */
  pushPcmFromMic(int16Buffer, sampleRate) {
    if (this.paused || this.stopped) return
    if (this.mode === 'ptt' && !this.pttHeld) return
    const n = int16Buffer.length >> 1
    const f32 = new Float32Array(n)
    for (let i = 0; i < n; i++) f32[i] = int16Buffer.readInt16LE(i * 2) / 32768
    if (sampleRate !== TARGET_SR) {
      // AudioContext обычно отдаёт 16к по constraint; страховка — линейный ресемплинг
      const ratio = TARGET_SR / sampleRate
      const out = new Float32Array(Math.floor(n * ratio))
      for (let i = 0; i < out.length; i++) {
        const pos = i / ratio
        const i0 = Math.floor(pos)
        const i1 = Math.min(i0 + 1, n - 1)
        const frac = pos - i0
        out[i] = f32[i0] * (1 - frac) + f32[i1] * frac
      }
      this.pushPcm(out)
      return
    }
    this.pushPcm(f32)
  }

  /** Тестовый/прямой вход: Float32 mono @16к */
  pushPcm(frame) {
    if (this.stopped || this.paused) return
    if (this.queue.length >= MAX_QUEUED_FRAMES) {
      this.queue.shift()
      this.droppedFrames += 1
    }
    this.queue.push(frame)
    if (!this.processing) void this.processQueue()
  }

  async processQueue() {
    this.processing = true
    try {
      while (this.queue.length > 0) {
        const frame = this.queue.shift()
        // событийный цикл должен дышать: yield между кадрами (политика не блокировать main)
        await new Promise((r) => setImmediate(r))
        if (this.stopped) return
        this.processFrame(frame)
      }
    } finally {
      this.processing = false
    }
  }

  processFrame(frame) {
    const now = Date.now()
    // --- VAD (512-сэмпловые окна) ---
    const v0 = performance.now()
    try {
      for (let w = 0; w + VAD_WINDOW <= frame.length; w += VAD_WINDOW) {
        this.vad.acceptWaveform(frame.subarray(w, w + VAD_WINDOW))
      }
    } catch (e) {
      this.handleRuntimeError(`VAD: ${e.message}`)
      return
    }
    this.metrics.vadMsSum += performance.now() - v0
    this.metrics.vadMsCount += 1

    // сегмент VAD закрыт → конец высказывания (основной триггер финала)
    let vadSegmentReady = false
    try {
      while (!this.vad.isEmpty()) {
        this.vad.pop()
        vadSegmentReady = true
      }
    } catch {
      /* гонка isEmpty/front — не критично */
    }

    const rms = rmsOf(frame)
    const speechGate = (() => {
      try {
        return this.vad.isDetected()
      } catch {
        return rms >= 0.006
      }
    })()
    if (speechGate) this.lastVoiceTs = now

    // --- старт/продолжение высказывания ---
    let consumedByPreroll = false
    if (!this.utteranceActive) {
      // pre-roll: копим последние кадры до гейта, чтобы начало фразы не терялось
      this.preroll.push(frame)
      if (this.preroll.length > this.prerollFrames) this.preroll.shift()
    }
    if (!this.utteranceActive && (speechGate || vadSegmentReady)) {
      this.startUtterance(now)
      // текущий кадр уже улетел в поток вместе с pre-roll — живой фид пропускаем,
      // иначе кадр задваивается (артефакты декода — лишние слоги)
      consumedByPreroll = true
    }

    if (this.utteranceActive) {
      this.setState('Recognizing')
      if (!consumedByPreroll) this.feedRecognizer(frame, now)
      if (vadSegmentReady) {
        this.finishUtterance('vad')
      } else if (this.mode === 'ptt' && !this.pttHeld) {
        this.finishUtterance('ptt')
      } else if (now - this.lastVoiceTs > IDLE_FINALIZE_MS && rms < 0.004) {
        this.finishUtterance('idle')
      } else if (now - this.utteranceStartTs > this.config.maxSpeech * 1000) {
        this.finishUtterance('max-duration')
      }
    } else if (this.state === 'Recognizing') {
      this.setState('Listening')
    }
  }

  startUtterance(now) {
    this.utteranceActive = true
    this.utteranceStartTs = now
    this.utteranceFrames = 0
    this.partialText = ''
    this.utteranceId += 1
    try {
      this.stream = this.recognizer.createStream()
    } catch (e) {
      this.handleRuntimeError(`createStream: ${e.message}`)
      this.utteranceActive = false
      return
    }
    // выливаем pre-roll в поток (начало фразы, которое VAD ещё не видел).
    // Ведущую тишину обрезаем (оставляем ~200 мс до первого «звукового» кадра):
    // декодирование чистой тишины порождает галлюцинации CTC («ну», «э»).
    const preroll = this.preroll.splice(0, this.preroll.length)
    let soundIdx = -1
    for (let i = 0; i < preroll.length; i++) {
      if (rmsOf(preroll[i]) > 0.0018) {
        soundIdx = i
        break
      }
    }
    const from = soundIdx < 0 ? Math.max(0, preroll.length - 1) : soundIdx
    for (let i = from; i < preroll.length; i++) {
      const frame = preroll[i]
      try {
        this.stream.acceptWaveform({ samples: frame, sampleRate: TARGET_SR })
        while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream)
      } catch (e) {
        this.handleRuntimeError(`preroll feed: ${e.message}`)
        return
      }
    }
  }

  feedRecognizer(frame, now) {
    if (!this.stream) return
    this.utteranceFrames += 1
    const d0 = performance.now()
    try {
      this.stream.acceptWaveform({ samples: frame, sampleRate: TARGET_SR })
      while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream)
    } catch (e) {
      this.handleRuntimeError(`decode: ${e.message}`)
      return
    }
    const dt = performance.now() - d0
    this.metrics.decodeMsSum += dt
    this.metrics.decodeMsCount += 1
    this.metrics.decodeMsMax = Math.max(this.metrics.decodeMsMax, dt)

    // --- партиалы (спека §15): троттлинг 250 мс, только при изменении текста ---
    if (now - this.lastPartialEmitTs >= PARTIAL_INTERVAL_MS) {
      this.lastPartialEmitTs = now
      let text = ''
      try {
        const res = this.recognizer.getResult(this.stream)
        text = String((res && res.text) || '').replace(/\s+/g, ' ').trim()
      } catch {
        text = ''
      }
      if (text && text !== this.partialText) {
        this.partialText = text
        this.metrics.partials += 1
        this.emit('partial', { text, utteranceId: this.utteranceId })
      }
    }
  }

  /**
   * Финал высказывания: сливаем хвост, забираем текст, эмитим 'final'.
   * trigger: vad | ptt | idle | endpoint | max-duration | stop | pause
   */
  finishUtterance(trigger, { silent } = {}) {
    if (!this.utteranceActive || !this.stream) {
      this.utteranceActive = false
      this.stream = null
      return
    }
    // §23: высказывание длиной больше ~15 c — это фоновая речь (диалоги аниме),
    // а не команда пользователю. Финал фиксируем в диагностике, но парсеру
    // в рендерер НЕ отправляем (защита от ложных срабатываний).
    const isAmbient = trigger === 'max-duration' && Date.now() - this.utteranceStartTs > 15000
    if (isAmbient) silent = true
    const stream = this.stream
    this.stream = null
    this.utteranceActive = false
    const started = this.utteranceStartTs
    try {
      stream.inputFinished()
      while (this.recognizer.isReady(stream)) this.recognizer.decode(stream)
      const res = this.recognizer.getResult(stream)
      const text = String((res && res.text) || '').replace(/\s+/g, ' ').trim()
      const now = Date.now()
      this.metrics.utterances += 1
      if (text) {
        const isDup = text === this.lastFinalText && now - this.lastFinalTs < FINAL_DEDUP_MS
        this.metrics.lastTranscript = text
        this.metrics.lastFinalAt = now
        this.metrics.speechToFinalMs = now - started
        this.lastFinalText = text
        this.lastFinalTs = now
        if (!isDup && !silent) {
          this.emit('final', { text, utteranceId: this.utteranceId, trigger, speechMs: now - started, ts: now })
        }
      }
    } catch (e) {
      this.handleRuntimeError(`finalize: ${e.message}`)
    }
    if (this.state === 'Recognizing') this.setState('Listening')
  }

  // --- восстановление (спека §31) ------------------------------------------------------

  handleRuntimeError(where) {
    this.metrics.errors += 1
    const now = Date.now()
    this.errorTimestamps = this.errorTimestamps.filter((t) => now - t < 60000)
    this.errorTimestamps.push(now)
    this.stream = null
    this.utteranceActive = false
    if (this.errorTimestamps.length >= 3) {
      this.scheduleRecovery()
    } else if (this.wantRunning) {
      this.setState('Listening', `восстановлено после ошибки (${where})`)
    }
  }

  scheduleRecovery() {
    if (this.recovering) return
    this.setState('Recovering', 'серия ошибок распознавания — перезапускаю STT')
    const attempt = (this.recovering && this.recovering.attempt) || 0
    const delay = Math.min(30000, 1000 * 2 ** attempt)
    const timer = setTimeout(async () => {
      this.recovering = null
      this.errorTimestamps = []
      this.metrics.restarts += 1
      await this.closeMicrophone()
      this.recognizer = null
      this.vad = null
      this.modelState = 'missing'
      try {
        await this.initialize()
        if (this.modelState === 'loaded' && this.wantRunning) {
          await this.openMicrophone()
          if (this.micStatus === 'open') this.setState('Listening', 'STT перезапущен')
        }
      } catch (e) {
        this.setConfigError(`перезапуск не удался: ${e.message}`)
      }
    }, delay)
    this.recovering = { attempt: attempt + 1, timer }
  }

  // --- команды из рендерера (диагностика §36) ---------------------------------------------

  /** Рендерер сообщает: какая команда получилась и сколько занял parse+execute */
  reportCommand({ text, commandMs, types }) {
    this.metrics.lastCommand = text
    this.metrics.lastCommandMs = commandMs
    this.metrics.lastCommandAt = Date.now()
    if (types && types.length) this.metrics.lastCommandTypes = types
    // мгновенный «ProcessingCommand» для UI
    this.emit('state', this.getStatus())
  }

  // --- установка/обновление моделей (спека §8/§11) ------------------------------------------

  async installModel(onProgress) {
    if (!this.userModelsDir) throw new Error('userData недоступен')
    const wrap = (p) => {
      this.setState(p.phase === 'download' ? 'DownloadingModel' : 'InstallingModel', `${p.file || ''} ${p.received || 0}/${p.total || '?'}`)
      onProgress && onProgress(p)
    }
    const res = await modelManager.installModels({ userModelsDir: this.userModelsDir, onProgress: wrap })
    if (res.ok) {
      // перечитываем модели (теперь приоритет у userDir)
      this.modelState = 'missing'
      this.recognizer = null
      this.vad = null
      await this.initialize()
      if (this.wantRunning && this.micStatus !== 'open') await this.openMicrophone()
      this.emit('modelChanged', this.getStatus())
    }
    return res
  }

  async checkUpdate() {
    return modelManager.checkUpdate({ userModelsDir: this.userModelsDir })
  }

  // --- статус/диагностика (спека §36) --------------------------------------------------------

  getStatus() {
    const avg = (s, c) => (c > 0 ? Math.round((s / c) * 100) / 100 : 0)
    const m = this.metrics
    return {
      state: this.state,
      reason: this.reason,
      version: this.appVersion,
      engine: 'sherpa-onnx-streaming',
      paused: this.paused,
      mode: this.mode,
      pttHeld: this.pttHeld,
      model: this.model
        ? {
            id: (this.model.manifest && this.model.manifest.asr.id) || 't-one-russian',
            title: (this.model.manifest && this.model.manifest.asr.title) || 'T-One Russian',
            version: (this.model.manifest && this.model.manifest.asr.version) || '',
            dir: this.model.dir,
            origin: this.model.origin,
            state: this.modelState,
          }
        : { state: this.modelState },
      vad: { model: 'silero-vad', threshold: this.config.vadThreshold, minSilence: this.config.minSilence },
      provider: this.resolveProvider(),
      numThreads: this.config.numThreads,
      sampleRate: TARGET_SR,
      nativeModule: this.nativeState,
      mic: { status: this.micStatus, name: this.micName, devices: this.micDevices.length },
      latency: {
        decodeMsAvg: avg(m.decodeMsSum, m.decodeMsCount),
        decodeMsMax: Math.round(m.decodeMsMax * 100) / 100,
        vadMsAvg: avg(m.vadMsSum, m.vadMsCount),
        speechToFinalMs: m.speechToFinalMs,
        initMs: m.initMs,
        modelLoadMs: m.modelLoadMs,
        warmupMs: m.warmupMs,
      },
      counters: {
        utterances: m.utterances,
        partials: m.partials,
        errors: m.errors,
        restarts: m.restarts,
        droppedFrames: this.droppedFrames,
      },
      lastTranscript: m.lastTranscript,
      lastCommand: m.lastCommand,
      lastCommandMs: m.lastCommandMs,
    }
  }

  getDiagnostics() {
    const status = this.getStatus()
    const mem = process.memoryUsage()
    return {
      ...status,
      diagnosticsOnly: true,
      memory: {
        rssMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
        modelBytes: (this.model && this.model.manifest && this.model.manifest.asr.files[0].bytes) || 0,
      },
      config: { ...this.config },
      utterance: {
        active: this.utteranceActive,
        id: this.utteranceId,
        queueLen: this.queue.length,
      },
      lastTranscriptAt: this.metrics.lastFinalAt,
      lastCommandAt: this.metrics.lastCommandAt,
    }
  }
}

module.exports = { SttService, STATES }
