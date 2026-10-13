/**
 * Speech engine (офлайн-STT) — Electron main process.
 *
 * МОДЕЛЬ: T-One (t-tech/T-one, русский, CTC conformer) — официальная стриминговая
 * экспорт-конверсия для sherpa-onnx: csukuangfj/sherpa-onnx-streaming-t-one-russian-2025-09-08
 * (файлы: model.onnx ~137MB + tokens.txt). Модель «телефонная»: внутри работает на 8 кГц
 * (sherpa-onnx сам ресемплирует вход 16 кГц → 8 кГц), поэтому качество на широкой полосе
 * остаётся высоким (см. worklog 16-b).
 *
 * ДВИЖОК: sherpa-onnx-node (OnlineRecognizer — модель стриминговая; распознаём
 * целевую фразу-высказывание: свежий поток на каждый вызов transcribe, фидим все
 * сэмплы, inputFinished, финальный результат). Модель грузится ОДИН раз в init().
 *
 * ДЕКОДИРОВАНИЕ АУДИО:
 *   - audio/wav (RIFF PCM/float) — чистый JS-парсер без внешних зависимостей
 *     (основной путь: рендерер шлёт WAV 16 кГц mono из encodeWav16kMono);
 *   - webm/opus и прочее — через ffmpeg (child_process, pipe, f32le 16k mono).
 *
 * Всё defensive: require/load в try/catch, честный статус (fail-safe коды),
 * приложение продолжает работать на облачном/браузерном STT.
 */
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const MODEL_ID =
  't-tech/T-one (sherpa-onnx streaming export: csukuangfj/sherpa-onnx-streaming-t-one-russian-2025-09-08)'
const TARGET_SR = 16000
const MAX_AUDIO_SEC = 120 // страховка от гигантских файлов
const DECODE_TIMEOUT_MS = 20000

const state = {
  initialized: false,
  loaded: false,
  nativeModule: 'failed', // loaded | failed
  modelState: 'failed', // loaded | failed
  model: 'unknown', // фактическое имя модели; после успешной загрузки = MODEL_ID, иначе 'failed'
  modelPath: null,
  provider: 'cpu',
  reason: 'not initialized',
  loadMs: 0,
  sampleRate: 8000, // внутренняя частота модели T-One (telephony)
}

let recognizer = null
let sherpa = null
let ffmpegChecked = false
let ffmpegOk = false

// --- поиск каталога модели -----------------------------------------------------

/**
 * Ищем models/t-one c model.onnx + tokens.txt.
 * 1) <modelsDir>/t-one (packaged: process.resourcesPath/models — штатный путь);
 * 2) обход предков modelsDir (dev-раскладка: app/electron-app/resources → app/models).
 */
function findModelDir(modelsDir) {
  const candidates = []
  if (modelsDir) candidates.push(path.join(modelsDir, 't-one'))
  let dir = modelsDir ? path.resolve(modelsDir) : process.cwd()
  for (let i = 0; i < 5 && dir !== path.parse(dir).root; i++) {
    dir = path.dirname(dir)
    candidates.push(path.join(dir, 'models', 't-one'))
  }
  const seen = new Set()
  for (const c of candidates) {
    if (!c || seen.has(c)) continue
    seen.add(c)
    try {
      if (fs.existsSync(path.join(c, 'model.onnx')) && fs.existsSync(path.join(c, 'tokens.txt'))) {
        return c
      }
    } catch {
      /* нет прав/битый путь — пробуем следующего кандидата */
    }
  }
  return null
}

// --- загрузка -------------------------------------------------------------------

function loadSherpa(sherpaDir) {
  // 1) явный каталог ресурсов (packaged Windows: resources/sherpa/sherpa-onnx-node
  //    + рядом sherpa-onnx-win-x64 с .node и DLL — addon.js находит сиблинга сам);
  // 2) обычный require (Linux/dev: node_modules с linux-пакетом).
  if (sherpaDir) {
    try {
      // eslint-disable-next-line global-require
      sherpa = require(path.join(sherpaDir, 'sherpa-onnx-node'))
      state.nativeModule = 'loaded'
      return true
    } catch {
      /* падаем в обычный require */
    }
  }
  try {
    // eslint-disable-next-line global-require
    sherpa = require('sherpa-onnx-node')
    state.nativeModule = 'loaded'
    return true
  } catch (e) {
    state.nativeModule = 'failed'
    state.reason = `sherpa-onnx-node: ${e.message}`
    return false
  }
}

function loadModel(modelsDir) {
  const t0 = Date.now()
  const modelDir = findModelDir(modelsDir)
  if (!modelDir) {
    state.modelState = 'failed'
    state.model = 'failed'
    state.reason = `модель не найдена: искал model.onnx + tokens.txt в ${modelsDir}/t-one и среди предков`
    return false
  }
  try {
    recognizer = new sherpa.OnlineRecognizer({
      modelConfig: {
        toneCtc: { model: path.join(modelDir, 'model.onnx') },
        tokens: path.join(modelDir, 'tokens.txt'),
        numThreads: 2,
        debug: 0,
        provider: 'cpu',
      },
      enableEndpoint: false, // целевая фраза приходит целиком — endpoint не нужен
    })
    state.modelPath = modelDir
    state.modelState = 'loaded'
    state.model = MODEL_ID
    state.loaded = true
    state.provider = 'cpu'
    state.reason = 'ok'
    state.loadMs = Date.now() - t0
    return true
  } catch (e) {
    recognizer = null
    state.modelState = 'failed'
    state.model = 'failed'
    state.reason = `не удалось загрузить модель (${modelDir}): ${e.message}`
    return false
  }
}

/** init({modelsDir, sherpaDir}) — вызывается main.cjs на старте. Синхронный, грузит модель ОДИН раз. */
function init({ modelsDir, sherpaDir } = {}) {
  state.initialized = true
  if (state.loaded) return // идемпотентность
  if (!loadSherpa(sherpaDir)) return
  loadModel(modelsDir)
}

// --- статус ----------------------------------------------------------------------

function status() {
  return {
    loaded: state.loaded,
    engine: 'sherpa-onnx',
    model: state.model, // фактическая модель (не подделываем)
    modelState: state.modelState, // loaded | failed
    nativeModule: state.nativeModule, // loaded | failed
    modelPath: state.modelPath,
    provider: state.provider,
    reason: state.reason,
    localOnly: true,
    loadMs: state.loadMs,
    sampleRate: state.sampleRate,
  }
}

// --- декодирование аудио ----------------------------------------------------------

function parseWavPcm(buf) {
  if (buf.length < 12) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let off = 12
  let fmt = null
  let dataOff = -1
  let dataLen = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ' && size >= 16) {
      const audioFormat = buf.readUInt16LE(body)
      let format = audioFormat
      // WAVE_FORMAT_EXTENSIBLE: реальный формат — первые 2 байта SubFormat GUID
      if (format === 0xfffe && size >= 40) format = buf.readUInt16LE(body + 24)
      fmt = {
        format,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      dataOff = body
      dataLen = Math.min(size, buf.length - body)
    }
    off = body + size + (size % 2) // чанки выровнены по 2 байтам
  }
  if (!fmt || dataOff < 0 || fmt.channels < 1 || fmt.sampleRate < 1000) return null
  const bytesPer = fmt.bits >> 3
  if (!bytesPer || bytesPer > 4) return null
  const frames = Math.floor(dataLen / (bytesPer * fmt.channels))
  if (frames < 1) return null
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let ch = 0; ch < fmt.channels; ch++) {
      const p = dataOff + (i * fmt.channels + ch) * bytesPer
      let v = 0
      if (fmt.format === 3 && fmt.bits === 32) {
        v = buf.readFloatLE(p)
      } else if (fmt.bits === 16) {
        v = buf.readInt16LE(p) / 32768
      } else if (fmt.bits === 32) {
        v = buf.readInt32LE(p) / 2147483648
      } else if (fmt.bits === 24) {
        v = buf.readInt8(p + 2) * 65536 + buf.readUInt16LE(p)
        v /= 8388608
      } else if (fmt.bits === 8) {
        v = (buf.readUInt8(p) - 128) / 128
      }
      sum += v
    }
    mono[i] = sum / fmt.channels
  }
  return { samples: mono, sampleRate: fmt.sampleRate }
}

function resampleTo16k(samples, sr) {
  if (sr === TARGET_SR) return samples
  const ratio = TARGET_SR / sr
  const outLen = Math.max(1, Math.floor(samples.length * ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, samples.length - 1)
    const frac = pos - i0
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac
  }
  return out
}

function hasFfmpeg() {
  if (!ffmpegChecked) {
    ffmpegChecked = true
    try {
      const r = spawnSync('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true })
      ffmpegOk = r.status === 0
    } catch {
      ffmpegOk = false
    }
  }
  return ffmpegOk
}

/** webm/opus и прочее → PCM f32le 16k mono через ffmpeg (pipe, без файлов на диске) */
function ffmpegDecode(buffer, mime) {
  return new Promise((resolve, reject) => {
    if (!hasFfmpeg()) {
      reject(new Error('ffmpeg не найден в системе (нужен для декодирования webm/opus)'))
      return
    }
    const args = [
      '-v', 'error',
      '-i', 'pipe:0',
      '-map', '0:a:0',
      '-ac', '1',
      '-ar', String(TARGET_SR),
      '-f', 'f32le',
      'pipe:1',
    ]
    const proc = spawn('ffmpeg', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        try { proc.kill('SIGKILL') } catch { /* уже мёртв */ }
        reject(new Error('ffmpeg: таймаут декодирования'))
      }
    }, DECODE_TIMEOUT_MS)
    proc.stdout.on('data', (c) => chunks.push(c))
    proc.stderr.on('data', (c) => {
      if (stderr.length < 4000) stderr += String(c)
    })
    proc.on('error', (e) => {
      if (!done) {
        done = true
        clearTimeout(timer)
        reject(new Error(`ffmpeg: ${e.message}`))
      }
    })
    proc.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const raw = Buffer.concat(chunks)
      if (code !== 0 || raw.length < 4) {
        reject(new Error(`ffmpeg: код ${code} ${stderr.slice(0, 300)}`))
        return
      }
      const samples = new Float32Array(raw.length >> 2)
      for (let i = 0; i < samples.length; i++) samples[i] = raw.readFloatLE(i * 4)
      resolve({ samples, sampleRate: TARGET_SR })
    })
    proc.stdin.on('error', () => { /* ffmpeg сам сообщит кодом выхода */ })
    try {
      proc.stdin.end(buffer)
    } catch (e) {
      if (!done) {
        done = true
        clearTimeout(timer)
        reject(new Error(`ffmpeg stdin: ${e.message}`))
      }
    }
  })
}

/**
 * buffer → { samples: Float32Array @16k mono }.
 * WAV — чистым JS (основной путь, без ffmpeg); остальное — ffmpeg.
 */
async function decodeAudio(buffer, mime) {
  const looksWav =
    buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF'
  const mimeWav = typeof mime === 'string' && /wav|wave|rf64|pcm/i.test(mime)
  if (looksWav || mimeWav) {
    try {
      const parsed = parseWavPcm(buffer)
      if (parsed) return parsed
    } catch {
      /* битый WAV — пробуем ffmpeg */
    }
  }
  return ffmpegDecode(buffer, mime || 'audio/webm')
}

// --- распознавание ------------------------------------------------------------------

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * transcribe(buffer, mime) → Promise<{ok:true, text} | {ok:false, error}>
 * Распознаёт ЦЕЛОЕ высказывание: новый поток на вызов, фидим все сэмплы,
 * inputFinished, финальный результат. Модель загружена один раз в init().
 */
async function transcribe(buffer, mime) {
  if (!state.initialized || (!recognizer && state.modelState === 'failed')) {
    return { ok: false, error: state.nativeModule === 'failed' ? 'SPEECH_NATIVE_UNAVAILABLE' : 'SPEECH_MODEL_UNAVAILABLE' }
  }
  if (!recognizer) {
    return { ok: false, error: 'SPEECH_MODEL_UNAVAILABLE' }
  }
  if (!buffer || buffer.length < 512) {
    return { ok: false, error: 'SPEECH_AUDIO_TOO_SHORT' }
  }

  let audio
  try {
    audio = await decodeAudio(buffer, mime)
  } catch (e) {
    return { ok: false, error: 'SPEECH_DECODE_FAILED', reason: e.message }
  }
  if (!audio || !audio.samples || audio.samples.length < TARGET_SR / 2) {
    return { ok: false, error: 'SPEECH_AUDIO_TOO_SHORT' }
  }

  const samples = resampleTo16k(audio.samples, audio.sampleRate)
  const maxLen = TARGET_SR * MAX_AUDIO_SEC
  const clipped = samples.length > maxLen ? samples.subarray(0, maxLen) : samples

  try {
    const stream = recognizer.createStream()
    // Фидим порциями ~0.5 c и отдаём event loop между декодами (main-процесс живёт)
    const chunk = TARGET_SR / 2
    for (let pos = 0; pos < clipped.length; pos += chunk) {
      stream.acceptWaveform({
        samples: clipped.subarray(pos, Math.min(pos + chunk, clipped.length)),
        sampleRate: TARGET_SR,
      })
      while (recognizer.isReady(stream)) recognizer.decode(stream)
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setImmediate(r))
    }
    stream.inputFinished()
    while (recognizer.isReady(stream)) recognizer.decode(stream)
    const result = recognizer.getResult(stream)
    const text = normalizeText(result && result.text)
    return { ok: true, text }
  } catch (e) {
    return { ok: false, error: 'SPEECH_RECOGNIZE_FAILED', reason: e.message }
  }
}

module.exports = { init, status, transcribe }
