/**
 * ai-worker — изолированный процесс нативного AI-слоя AVC-Anime.
 *
 * Запускается из main.cjs через Electron utilityProcess.fork (§130: process isolation).
 * В utilityProcess доступен полный Node N-API (в отличие от main-процесса Electron,
 * где napi external arraybuffers запрещены — «External buffers are not allowed»).
 *
 * Протокол (structured clone):
 *   вход:  { id, type, args }  — запросы main-процесса
 *   выход: { id, ok, result?, error? } — ответы
 *   выход: { event, payload }  — события (stt-partial/stt-final/progress/services-status)
 *
 * Модуль НЕ импортирует electron — чистый Node.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const MODELS_DIR = process.env.AVC_MODELS_DIR || path.join(__dirname, '..', 'models')

let pipeline = null
try {
  const { VoicePipeline } = require('./voice-pipeline.cjs')
  pipeline = new VoicePipeline({ modelsDir: MODELS_DIR })
} catch (e) {
  send({ event: 'worker-fatal', payload: { error: e.message } })
  process.exit(1)
}

function send(msg) {
  // Два транспорта: utilityProcess (process.parentPort) и child_process.fork с
  // ELECTRON_RUN_AS_NODE=1 (process.send). Electron в СВОИХ процессах запрещает
  // napi external arraybuffers («External buffers are not allowed»), а чистый Node —
  // разрешает, поэтому нативный TTS/sherpa-onnx живёт в дочернем Node-процессе.
  if (process.parentPort) process.parentPort.postMessage(msg)
  else if (typeof process.send === 'function') process.send(msg)
}

pipeline.on('stt-partial', (payload) => send({ event: 'stt-partial', payload }))
pipeline.on('stt-final', (payload) => send({ event: 'stt-final', payload }))
pipeline.on('services-status', (payload) => send({ event: 'services-status', payload }))
pipeline.on('tts-speak-file', (payload) => send({ event: 'tts-speak-file', payload }))
pipeline.on('tts-cancel', () => send({ event: 'tts-cancel', payload: null }))
pipeline.manager.on('progress', (payload) => send({ event: 'model-progress', payload }))

const handlers = {
  status: () => pipeline.getStatus(),
  hardware: async () => {
    // GPU-информация недоступна вне main-процесса — main дополнит её сам (честно null)
    const hw = await pipeline.getHardware()
    hw.gpu = null
    return hw
  },
  install: async (args) => pipeline.installComponents(args?.keys || ['stt', 'vad', 'tts', 'llm'], { voiceId: args?.voiceId }),
  'cancel-install': (args) => pipeline.cancelInstall(args?.key),
  recover: () => pipeline.manager.recoverPending(),
  'set-enabled': (args) => {
    pipeline.enabled = !!args?.enabled
    return pipeline.enabled
  },
  'set-profile': (args) => {
    pipeline.profile = String(args?.profile || 'max_responsiveness')
    return pipeline.profile
  },
  'llm-route': async (args) => pipeline.llmRoute(String(args?.text || ''), args?.context || null, { timeoutMs: args?.timeoutMs }),
  'tts-speak': async (args) => {
    const res = await pipeline.ttsSpeak(String(args?.text || ''), {})
    if (!res) return null
    // рендерер не может читать файл:// из http-происхождения — отдаём WAV как data URL
    let dataUrl = null
    try {
      const b64 = fs.readFileSync(res.file).toString('base64')
      dataUrl = `data:audio/wav;base64,${b64}`
    } catch { /* файл мог исчезнуть — честный null */ }
    return { ...res, dataUrl }
  },
  'tts-cancel': () => pipeline.ttsCancel(),
  'set-voice': (args) => {
    pipeline.tts.setVoice(String(args?.voice || 'irina'))
    return pipeline.tts.voiceId
  },
  /** повторная инициализация после установки моделей (AI Setup) */
  initialize: async () => pipeline.initializeServices(),
  feed: (args) => {
    const samples = args?.samples
    if (!samples) return false
    pipeline.feedAudio(samples instanceof Int16Array ? samples : new Int16Array(samples))
    return true
  },
  flush: () => pipeline.flushAudio(),
}

if (process.parentPort) {
  process.parentPort.on('message', (e) => handleMessage(e.data))
  // поэтапная инициализация фоном после старта воркера (§49 + фаза 2 аудита):
  // сразу STT (голос готов ASAP), TTS/LLM — догрузка в фоне/по требованию
  setTimeout(() => {
    void pipeline.initializeCoreThenDeferred()
  }, 100)
} else if (typeof process.send === 'function') {
  process.on('message', (msg) => handleMessage(msg))
  // поэтапная инициализация фоном после старта воркера (§49 + фаза 2 аудита)
  setTimeout(() => {
    void pipeline.initializeCoreThenDeferred()
  }, 100)
}

async function handleMessage(msg) {
  const { id, type, args } = msg || {}
  if (!id || !type) return
  const handler = handlers[type]
  if (!handler) {
    send({ id, ok: false, error: `Неизвестный запрос: ${type}` })
    return
  }
  try {
    const result = await handler(args)
    send({ id, ok: true, result })
  } catch (err) {
    send({ id, ok: false, error: err.message })
  }
}

process.on('exit', () => {
  try { pipeline && pipeline.shutdown() } catch { /* ок */ }
})
