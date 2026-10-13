/**
 * whisper-local — менеджер локального офлайн-распознавания (whisper.cpp), задача 16.
 *
 * Архитектура (мастер-промпт §4, §28, §29):
 *   Next.js API (процесс приложения)
 *     → WhisperLocalManager (синглтон, полностью управляемый хелпер)
 *       → whisper.cpp whisper-server (native, 127.0.0.1:порт, HTTP /inference)
 *         → модель ggml-medium-q5_0.bin (или выбранная)
 *
 * Пользователь НИЧЕГО не запускает вручную: хелпер стартует лениво при первом
 * распознавании/опросе статуса, здоровье мониторится, при падении — авто-рестарт
 * (с лимитом попыток против бесконечного цикла, §30), при выходе из приложения
 * процесс убивается вместе с деревом встроенного сервера (main.cjs taskkill /T).
 *
 * ПУТИ (§27 — никаких захардкоженных пользовательских путей):
 *   Бинарник:  AVC_WHISPER_BIN → <cwd>/whisper/whisper-server(.exe) → <cwd>/../whisper/...
 *              (в EXE: resources/whisper/, cwd сервера = resources/server)
 *   Модели:    AVC_MODELS_DIR → <cwd>/models → <cwd>/../models →
 *              %LOCALAPPDATA%/AnimeVoiceControl/models (Windows)
 *
 * ПРИВАТНОСТЬ (§31): текст распознанной речи НЕ логируется по умолчанию
 * (только метрики). Включить можно переменной AVC_LOG_TRANSCRIPTS=1.
 */
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

export const WHISPER_ENGINE_NAME = 'whisper.cpp v1.7.6'
const DEFAULT_PORT = 9871
const READY_TIMEOUT_MS = 120_000
const READY_POLL_MS = 500
/** Лимит авто-рестартов: не более 3 аварийных падений за 10 минут (§30) */
const RESTART_WINDOW_MS = 10 * 60_000
const RESTART_MAX = 3
/** Командный словарь в initial prompt (§26 — подсказка, не принуждение) */
const COMMAND_PROMPT =
  'включи, открой, запусти, пауза, продолжи, следующая серия, предыдущая серия, ' +
  'громче, тише, громкость, включи звук, выключи звук, перемотай, качество, 1080, ' +
  'случайное аниме, фэнтези, комедия, романтика.'

export interface WhisperModelInfo {
  /** Имя файла, например ggml-medium-q5_0.bin */
  file: string
  /** Красивое имя, например medium-q5_0 */
  name: string
  size: number
}

export interface WhisperLocalStatus {
  /** false — это не Windows/Linux x64 c бинарником или бинарник не найден */
  supported: boolean
  binaryPath: string | null
  modelsDir: string | null
  models: WhisperModelInfo[]
  /** Модель, загруженная/выбранная для загрузки */
  activeModel: string | null
  modelSize: number
  /** null — проверка ещё не выполнялась */
  checksumOk: boolean | null
  backend: 'cpu' | 'cuda'
  ready: boolean
  starting: boolean
  lastError: string | null
  lastLatencyMs: number | null
  /** Заполняется только при AVC_LOG_TRANSCRIPTS=1 (§31) */
  lastText: string | null
  restarts: number
  pid: number | null
  port: number
}

interface WhisperState {
  child: ChildProcess | null
  starting: boolean
  ready: boolean
  intentionalStop: boolean
  activeModel: string | null
  checksumOk: boolean | null
  lastError: string | null
  lastLatencyMs: number | null
  lastText: string | null
  restarts: number
  restartTimestamps: number[]
  bootLog: string[]
}

// Синглтон переживает HMR-перезагрузки модуля
const g = globalThis as unknown as { __avcWhisperState?: WhisperState }
function state(): WhisperState {
  if (!g.__avcWhisperState) {
    g.__avcWhisperState = {
      child: null,
      starting: false,
      ready: false,
      intentionalStop: false,
      activeModel: null,
      checksumOk: null,
      lastError: null,
      lastLatencyMs: null,
      lastText: null,
      restarts: 0,
      restartTimestamps: [],
      bootLog: [],
    }
  }
  return g.__avcWhisperState
}

function log(msg: string): void {
  const s = state()
  const line = `[whisper-local] ${new Date().toISOString()} ${msg}`
  console.log(line)
  s.bootLog.push(line)
  if (s.bootLog.length > 200) s.bootLog.shift()
}

const IS_WIN = process.platform === 'win32'
const BIN_NAME = IS_WIN ? 'whisper-server.exe' : 'whisper-server'

/** Поиск бинарника хелпера (§27): env → cwd/whisper → cwd/../whisper */
export function resolveBinary(): string | null {
  const candidates: string[] = []
  if (process.env.AVC_WHISPER_BIN) candidates.push(process.env.AVC_WHISPER_BIN)
  const cwd = process.cwd()
  candidates.push(path.join(cwd, 'whisper', BIN_NAME))
  candidates.push(path.join(cwd, '..', 'whisper', BIN_NAME))
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // ignore
    }
  }
  return null
}

/** CUDA-сборка определяется по наличию ggml-cuda.dll рядом с бинарником */
function detectBackend(binaryPath: string | null): 'cpu' | 'cuda' {
  if (!binaryPath) return 'cpu'
  try {
    const dir = path.dirname(binaryPath)
    return fs.existsSync(path.join(dir, 'ggml-cuda.dll')) ? 'cuda' : 'cpu'
  } catch {
    return 'cpu'
  }
}

/** Поиск каталога моделей (§27): env → cwd/models → cwd/../models → %LOCALAPPDATA% */
export function resolveModelsDir(): string | null {
  const candidates: string[] = []
  if (process.env.AVC_MODELS_DIR) candidates.push(process.env.AVC_MODELS_DIR)
  const cwd = process.cwd()
  candidates.push(path.join(cwd, 'models'))
  candidates.push(path.join(cwd, '..', 'models'))
  if (IS_WIN && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'AnimeVoiceControl', 'models'))
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // ignore
    }
  }
  return null
}

/** Список моделей (ggml-*.bin) в каталоге */
export function listModels(): WhisperModelInfo[] {
  const dir = resolveModelsDir()
  if (!dir) return []
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^ggml-.*\.bin$/i.test(f))
      .map((f) => {
        let size = 0
        try {
          size = fs.statSync(path.join(dir, f)).size
        } catch {
          // ignore
        }
        return { file: f, name: f.replace(/^ggml-/, '').replace(/\.bin$/i, ''), size }
      })
      .sort((a, b) => b.size - a.size)
  } catch {
    return []
  }
}

/** SHA-256 файла модели с кэшированием в <file>.sha256 (§10) */
async function checksumModel(modelPath: string): Promise<boolean> {
  const sidecar = modelPath + '.sha256'
  let expected: string | null = null
  try {
    if (fs.existsSync(sidecar)) {
      expected = (fs.readFileSync(sidecar, 'utf-8').trim().split(/\s+/)[0] ?? '').toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(expected)) expected = null
    }
  } catch {
    // ignore
  }
  return new Promise((resolve) => {
    try {
      const h = crypto.createHash('sha256')
      const stream = fs.createReadStream(modelPath)
      stream.on('data', (d) => h.update(d))
      stream.on('end', () => {
        const actual = h.digest('hex')
        if (!expected) {
          // вычислили впервые — сохраняем эталон (модель проверена целостностью чтения)
          try {
            fs.writeFileSync(sidecar, actual + '\n')
          } catch {
            // ignore
          }
          resolve(true)
        } else {
          resolve(actual === expected)
        }
      })
      stream.on('error', () => resolve(false))
    } catch {
      resolve(false)
    }
  })
}

function port(): number {
  const p = Number(process.env.AVC_WHISPER_PORT ?? DEFAULT_PORT)
  return Number.isFinite(p) && p > 0 ? p : DEFAULT_PORT
}

function threads(): number {
  const raw = Number(process.env.AVC_WHISPER_THREADS ?? '')
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  return Math.max(2, Math.min(8, os.cpus().length))
}

/** Старт хелпера с моделью (§14: модель грузится ОДИН раз и живёт в памяти) */
async function startHelper(modelFile: string): Promise<void> {
  const s = state()
  const binary = resolveBinary()
  if (!binary) {
    s.lastError = 'Бинарник whisper-server не найден'
    return
  }
  const dir = resolveModelsDir()
  if (!dir) {
    s.lastError = 'Каталог моделей не найден'
    return
  }
  const modelPath = path.join(dir, modelFile)
  if (!fs.existsSync(modelPath)) {
    s.lastError = `Модель не найдена: ${modelFile}`
    return
  }
  const size = fs.statSync(modelPath).size
  log(`checksum ${modelFile} (${(size / 1024 / 1024).toFixed(0)} MB)...`)
  const ok = await checksumModel(modelPath)
  s.checksumOk = ok
  if (!ok) {
    s.lastError = `Модель повреждена (SHA-256 не совпал): ${modelFile}`
    log(s.lastError)
    return
  }

  stopHelper()
  s.intentionalStop = false
  s.starting = true
  s.ready = false
  s.activeModel = modelFile
  s.lastError = null
  const args = [
    '-m',
    modelPath,
    '-t',
    String(threads()),
    '--host',
    '127.0.0.1',
    '--port',
    String(port()),
    '--prompt',
    COMMAND_PROMPT,
  ]
  log(`spawn: ${binary} ${args.join(' ')}`)
  const started = Date.now()
  const child = spawn(binary, args, {
    cwd: path.dirname(binary),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  s.child = child
  child.stdout?.on('data', (d: Buffer) => log('[server] ' + d.toString().trim().slice(0, 300)))
  child.stderr?.on('data', (d: Buffer) => log('[server:err] ' + d.toString().trim().slice(0, 300)))
  child.on('exit', (code) => {
    const st = state()
    if (st.child === child) st.child = null
    st.ready = false
    st.starting = false
    if (st.intentionalStop) return
    // §30: авто-восстановление с лимитом
    const now = Date.now()
    st.restartTimestamps = st.restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS)
    st.restartTimestamps.push(now)
    st.restarts = st.restartTimestamps.length
    if (st.restarts > RESTART_MAX) {
      st.lastError = `whisper-server аварийно завершился (код ${code}); авто-рестарт отключён после ${RESTART_MAX} попыток`
      log(st.lastError)
      return
    }
    log(`аварийный выход (код ${code}) → авто-рестарт ${st.restarts}/${RESTART_MAX}`)
    st.lastError = null
    void startHelper(st.activeModel ?? modelFile).catch(() => undefined)
  })

  // ожидание готовности (§29: READY-событие через poll)
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (s.child !== child) return // рестарт/останов уже произошёл
    try {
      const res = await fetch(`http://127.0.0.1:${port()}/`, { signal: AbortSignal.timeout(1500) })
      if (res.status < 500) {
        s.ready = true
        s.starting = false
        log(`READY за ${((Date.now() - started) / 1000).toFixed(1)}с (pid ${child.pid})`)
        return
      }
    } catch {
      // ещё не поднялся
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS))
  }
  s.starting = false
  s.lastError = 'Хелпер не ответил за таймаут'
  log(s.lastError)
  stopHelper()
}

export function stopHelper(): void {
  const s = state()
  s.intentionalStop = true
  const child = s.child
  s.child = null
  s.ready = false
  s.starting = false
  if (child && child.exitCode === null) {
    try {
      child.kill()
    } catch {
      // ignore
    }
  }
}

/** Гарантировать готовность хелпера (ленивый старт при первом обращении) */
export async function ensureReady(preferredModel?: string): Promise<boolean> {
  const s = state()
  if (s.ready && s.child) return true
  if (s.starting) return false
  const binary = resolveBinary()
  if (!binary) return false
  const models = listModels()
  if (models.length === 0) return false
  // сохранённая в настройках модель имеет приоритет над значением по умолчанию
  const preferred =
    preferredModel && models.some((m) => m.file === preferredModel)
      ? models.find((m) => m.file === preferredModel)!
      : null
  const wanted = preferred ?? getWantedModel(models)
  s.activeModel = wanted.file
  await startHelper(wanted.file)
  return state().ready
}

function getWantedModel(models: WhisperModelInfo[]): WhisperModelInfo {
  const s = state()
  if (s.activeModel) {
    const found = models.find((m) => m.file === s.activeModel)
    if (found) return found
  }
  // По умолчанию medium-q5_0 (мастер-промпт §2), иначе первая (самая большая)
  return models.find((m) => m.file === 'ggml-medium-q5_0.bin') ?? models[0]
}

export interface InferenceResult {
  text: string
  latencyMs: number
  model: string
}

/** Распознавание: WAV-буфер → /inference хелпера (§15: без запуска процессов на команду) */
export async function inference(
  wav: Buffer,
  language: string,
): Promise<{ ok: true; result: InferenceResult } | { ok: false; error: string }> {
  const s = state()
  if (!s.child || !s.ready) {
    const up = await ensureReady()
    if (!up || !s.child) {
      return { ok: false, error: s.lastError ?? 'Локальный Whisper не готов' }
    }
  }
  const started = Date.now()
  try {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
    form.append('language', language)
    form.append('response_format', 'json')
    form.append('temperature', '0')
    form.append('beam_size', '1')
    const res = await fetch(`http://127.0.0.1:${port()}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      return { ok: false, error: `whisper-server HTTP ${res.status}` }
    }
    const data = (await res.json()) as { text?: string }
    const latencyMs = Date.now() - started
    s.lastLatencyMs = latencyMs
    const text = (data.text ?? '').trim()
    if (process.env.AVC_LOG_TRANSCRIPTS === '1') s.lastText = text
    return { ok: true, result: { text, latencyMs, model: s.activeModel ?? '' } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    s.lastError = `Ошибка инференса: ${msg}`
    return { ok: false, error: msg }
  }
}

/** Полный статус (§33) */
export function getStatus(): WhisperLocalStatus {
  const s = state()
  const binary = resolveBinary()
  const models = listModels()
  const wanted = models.length > 0 ? getWantedModel(models) : null
  return {
    supported: !!binary && models.length > 0,
    binaryPath: binary,
    modelsDir: resolveModelsDir(),
    models,
    activeModel: s.activeModel ?? wanted?.file ?? null,
    modelSize: wanted?.size ?? 0,
    checksumOk: s.checksumOk,
    backend: detectBackend(binary),
    ready: s.ready && !!s.child,
    starting: s.starting,
    lastError: s.lastError,
    lastLatencyMs: s.lastLatencyMs,
    lastText: s.lastText,
    restarts: s.restarts,
    pid: s.child?.pid ?? null,
    port: port(),
  }
}

/** Смена модели (§32): остановить хелпер, следующий вызов поднимет с новой моделью */
export async function switchModel(modelFile: string): Promise<WhisperLocalStatus> {
  const models = listModels()
  if (!models.some((m) => m.file === modelFile)) {
    return getStatus()
  }
  const s = state()
  if (s.activeModel === modelFile && (s.ready || s.starting)) return getStatus()
  stopHelper()
  s.activeModel = modelFile
  s.checksumOk = null
  // старт в фоне — статус придёт готовым позже; UI опрашивает local-status
  void startHelper(modelFile).catch(() => undefined)
  return getStatus()
}
