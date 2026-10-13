/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * stt-stream — локальное ПОТОКОВОЕ распознавание (задача 17, Performance Engineering).
 *
 * Архитектура (по мотивам ревью производительности):
 *   Микрофон (браузер, PCM int16 16кГц чанки ~128мс)
 *     → POST /api/voice/stream (action:'chunk')
 *       → Silero VAD (гейт речи) → пре-буфер 500мс (целый первый слог)
 *         → T-One Russian Streaming CTC (sherpa-onnx, CPU, greedy)
 *           → partial ТЕКСТ ВО ВРЕМЯ РЕЧИ (~30мс на обновление)
 *           → endpoint (0.6с тишины) → финал фразы
 *
 * КЛЮЧЕВЫЕ ПРИНЦИПЫ:
 *   - Модель грузится ОДИН раз и живёт в памяти (resident) — на команду не запускается ничего.
 *   - Никаких WAV-файлов: всё в памяти, чанки приходят по HTTP localhost.
 *   - Никакого Python/сервера: sherpa-onnx-node (нативный NAPI-модуль) работает
 *     внутри процесса встроенного сервера приложения.
 *   - Flush-паддинг 1с тишины: буфер внутреннего ресемплера T-One (16к→8к) иначе
 *     удерживает конец фразы (проверено бенчмарком).
 *   - Приватность (§31): текст не логируется без AVC_LOG_TRANSCRIPTS=1.
 *
 * Файлы модели (§27 — пути без хардкодов): env AVC_TONE_DIR →
 *   <cwd>/models/sherpa → <cwd>/../models/sherpa
 *   (model.onnx, tokens.txt, silero_vad.onnx)
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

interface StreamSession {
  id: string
  stream: any
  vad: any
  /** Кольцевой пре-буфер последних сэмплов (дописывается при старте речи) */
  preBuffer: Float32Array
  preFill: number
  speechStarted: boolean
  lastPartial: string
  finals: string[]
  lastActivity: number
  chunks: number
  decodeMs: number
}

interface StreamState {
  sherpa: any
  recognizer: any
  loading: Promise<boolean> | null
  loadMs: number | null
  error: string | null
  sessions: Map<string, StreamSession>
  lastChunkMs: number | null
  lastFinalText: string | null
  lastFinalMs: number | null
}

const SESSION_TTL_MS = 5 * 60_000
const PRE_BUFFER_SAMPLES = 8000 // 500 мс @16к
const SILENCE_1S = () => new Float32Array(16000)

const g = globalThis as unknown as { __avcSttStream?: StreamState }

function state(): StreamState {
  if (!g.__avcSttStream) {
    g.__avcSttStream = {
      sherpa: null,
      recognizer: null,
      loading: null,
      loadMs: null,
      error: null,
      sessions: new Map(),
      lastChunkMs: null,
      lastFinalText: null,
      lastFinalMs: null,
    }
  }
  return g.__avcSttStream
}

function log(msg: string): void {
  console.log(`[stt-stream] ${new Date().toISOString()} ${msg}`)
}

export interface StreamFiles {
  model: string
  tokens: string
  vad: string
}

/** Поиск файлов модели T-One + Silero VAD (без хардкода путей) */
export function resolveStreamFiles(): StreamFiles | null {
  const names = ['model.onnx', 'tokens.txt', 'silero_vad.onnx']
  const candidates: string[] = []
  if (process.env.AVC_TONE_DIR) candidates.push(process.env.AVC_TONE_DIR)
  const cwd = process.cwd()
  candidates.push(path.join(cwd, 'models', 'sherpa'))
  candidates.push(path.join(cwd, '..', 'models', 'sherpa'))
  for (const dir of candidates) {
    try {
      if (names.every((n) => fs.existsSync(path.join(dir, n)))) {
        return {
          model: path.join(dir, 'model.onnx'),
          tokens: path.join(dir, 'tokens.txt'),
          vad: path.join(dir, 'silero_vad.onnx'),
        }
      }
    } catch {
      // ignore
    }
  }
  return null
}

/** Ленивая одноразовая загрузка модели (resident) */
export async function ensureLoaded(): Promise<boolean> {
  const st = state()
  if (st.recognizer) return true
  if (st.loading) return st.loading
  st.loading = (async () => {
    const files = resolveStreamFiles()
    if (!files) {
      st.error = 'Файлы модели T-One не найдены (model.onnx/tokens.txt/silero_vad.onnx)'
      return false
    }
    try {
      if (!st.sherpa) st.sherpa = require('sherpa-onnx-node')
      const t0 = Date.now()
      st.recognizer = new st.sherpa.OnlineRecognizer({
        modelConfig: {
          toneCtc: { model: files.model },
          tokens: files.tokens,
          numThreads: Math.max(1, Math.min(2, os.cpus().length)),
          provider: 'cpu',
          debug: 0,
        },
        decodingMethod: 'greedy_search',
        enableEndpoint: 1,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 0.6,
        rule3MinUtteranceLength: 20,
      })
      st.loadMs = Date.now() - t0
      st.error = null
      log(`модель загружена за ${st.loadMs}мс (${files.model})`)
      return true
    } catch (e) {
      st.error = e instanceof Error ? e.message : String(e)
      log('ошибка загрузки: ' + st.error)
      st.recognizer = null
      return false
    } finally {
      st.loading = null
    }
  })()
  return st.loading
}

function createSession(): StreamSession {
  const st = state()
  const files = resolveStreamFiles()
  const vad = new st.sherpa.Vad(
    {
      sileroVad: {
        model: files!.vad,
        threshold: 0.5,
        minSpeechDuration: 0.2,
        minSilenceDuration: 0.55,
        windowSize: 512,
        maxSpeechDuration: 20,
      },
      sampleRate: 16000,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    60,
  )
  return {
    id: crypto.randomUUID(),
    stream: st.recognizer.createStream(),
    vad,
    preBuffer: new Float32Array(PRE_BUFFER_SAMPLES),
    preFill: 0,
    speechStarted: false,
    lastPartial: '',
    finals: [],
    lastActivity: Date.now(),
    chunks: 0,
    decodeMs: 0,
  }
}

function int16ToFloat32(buf: Buffer): Float32Array {
  const n = buf.length >> 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768
  return out
}

/** Декодировать всё готовое и вернуть текущий partial */
function decodePending(sess: StreamSession): string {
  const st = state()
  const t0 = performance.now()
  while (st.recognizer.isReady(sess.stream)) st.recognizer.decode(sess.stream)
  sess.decodeMs += performance.now() - t0
  const text = (st.recognizer.getResult(sess.stream).text ?? '').trim()
  if (text) sess.lastPartial = text
  return sess.lastPartial
}

/** Финализировать фразу: паддинг тишиной выталкивает буфер ресемплера */
function finalize(sess: StreamSession): string {
  const st = state()
  sess.stream.acceptWaveform({ samples: SILENCE_1S(), sampleRate: 16000 })
  decodePending(sess)
  const final = sess.lastPartial
  if (final) {
    sess.finals.push(final)
    st.lastFinalText = final
    st.lastFinalMs = Date.now()
    if (process.env.AVC_LOG_TRANSCRIPTS === '1') log(`final: «${final}»`)
  }
  // сброс к новому высказыванию
  st.recognizer.reset(sess.stream)
  sess.lastPartial = ''
  sess.speechStarted = false
  sess.preFill = 0
  sess.vad.clear()
  return final
}

export interface ChunkResponse {
  partial: string
  finals: string[]
  speech: boolean
  chunkMs: number
}

/** Обработка чанка PCM int16 (base64) */
export function feedChunk(sessionId: string, pcmBase64: string): ChunkResponse | null {
  const st = state()
  if (!st.recognizer) return null
  const sess = st.sessions.get(sessionId)
  if (!sess) return null
  sess.lastActivity = Date.now()
  sess.chunks++

  const t0 = performance.now()
  const buf = Buffer.from(pcmBase64, 'base64')
  const samples = int16ToFloat32(buf)

  // VAD-гейт (Silero)
  sess.vad.acceptWaveform(samples)
  const speech = sess.vad.isDetected()

  if (!sess.speechStarted && speech) {
    // старт речи: дописать пре-буфер (последние 500мс до VAD) — целиком первый слог
    if (sess.preFill > 0) {
      const pre = sess.preBuffer.slice(0, sess.preFill)
      sess.stream.acceptWaveform({ samples: pre, sampleRate: 16000 })
    }
    sess.speechStarted = true
  }
  // обновить кольцевой пре-буфер
  if (samples.length >= sess.preBuffer.length) {
    sess.preBuffer.set(samples.subarray(samples.length - sess.preBuffer.length))
    sess.preFill = sess.preBuffer.length
  } else {
    const remain = sess.preBuffer.length - sess.preFill
    if (samples.length < remain) {
      sess.preBuffer.set(samples, sess.preFill)
      sess.preFill += samples.length
    } else {
      sess.preBuffer.copyWithin(0, sess.preFill + samples.length - sess.preBuffer.length)
      sess.preBuffer.set(samples, sess.preBuffer.length - samples.length)
      sess.preFill = sess.preBuffer.length
    }
  }

  let partial = ''
  if (sess.speechStarted) {
    sess.stream.acceptWaveform({ samples, sampleRate: 16000 })
    partial = decodePending(sess)
    if (st.recognizer.isEndpoint(sess.stream)) {
      finalize(sess)
      partial = ''
    }
  }
  const chunkMs = performance.now() - t0
  st.lastChunkMs = chunkMs
  return { partial, finals: sess.finals.splice(0), speech: sess.speechStarted, chunkMs }
}

/** Старт сессии */
export async function startSession(): Promise<{ sessionId: string } | { error: string }> {
  const ok = await ensureLoaded()
  if (!ok) {
    const st = state()
    return { error: st.error ?? 'Стриминговый движок недоступен' }
  }
  const st = state()
  // подчистить протухшие сессии
  const now = Date.now()
  for (const [id, s] of st.sessions) {
    if (now - s.lastActivity > SESSION_TTL_MS) st.sessions.delete(id)
  }
  const sess = createSession()
  st.sessions.set(sess.id, sess)
  return { sessionId: sess.id }
}

/** Завершить сессию с финализацией фразы */
export function stopSession(sessionId: string): { final: string } | null {
  const st = state()
  const sess = st.sessions.get(sessionId)
  if (!sess) return null
  let final = ''
  if (sess.speechStarted || sess.lastPartial) {
    decodePending(sess)
    final = finalize(sess)
  }
  st.sessions.delete(sessionId)
  return { final }
}

export interface StreamStatus {
  available: boolean
  modelLoaded: boolean
  loadMs: number | null
  error: string | null
  sessions: number
  lastChunkMs: number | null
  lastFinalText: string | null
  lastFinalMs: number | null
}

export function getStatus(): StreamStatus {
  const st = state()
  return {
    available: resolveStreamFiles() !== null,
    modelLoaded: !!st.recognizer,
    loadMs: st.loadMs,
    error: st.error,
    sessions: st.sessions.size,
    lastChunkMs: st.lastChunkMs,
    lastFinalText: st.lastFinalText,
    lastFinalMs: st.lastFinalMs,
  }
}
