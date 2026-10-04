/**
 * AVC-Anime — Electron main process.
 *
 * РОЛИ:
 *   1. Владелец ПОСТОЯННОЙ браузерной сессии YummyAnime
 *      (partition 'persist:yummyanime' — cookie живут на диске в userData и
 *      переживают перезапуск приложения и ПК; спецификация, секция 3).
 *   2. Хост Next.js UI (packaged: standalone-сервер; dev: localhost:3000).
 *   3. IPC-шлюз аутентификации: рендерер получает ТОЛЬКО не-секретные снимки
 *      (cookie/пароли/токены никогда не пересекают границу — секция 15).
 *
 * РЕЖИМЫ ЗАПУСКА:
 *   electron .                 — обычное приложение
 *   electron . --auth-selftest — диагностический прогон (JSON-отчёт в stdout,
 *                                секции 9/20/24), окно UI не открывается
 */
const { app, BrowserWindow, ipcMain, session, shell, dialog } = require('electron')
const { spawn, fork: childFork } = require('child_process')
const childProcess = { fork: childFork }
const http = require('http')
const path = require('path')
const fs = require('fs')
const { performance } = require('perf_hooks')
const { AuthenticationService, PARTITION } = require('./auth/authentication-service.cjs')

// --- стартовая телеметрия (фаза 2 аудита: измеряем, а не «кажется быстрее») ---
// Монотонные метки от загрузки модуля до готового UI и готового AI; JSON-отчёт
// пишется в userData/logs/startup-report.json (для сравнения сборок до/после).
const START_T0 = performance.now()
const STARTUP_MARKS = [{ mark: 'main-module-loaded', ms: 0 }]
function markStartup(name) {
  STARTUP_MARKS.push({ mark: name, ms: Math.round(performance.now() - START_T0) })
  log(`[Startup] ${name}: +${STARTUP_MARKS[STARTUP_MARKS.length - 1].ms} мс`)
}
function writeStartupReport(extra = {}) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const report = {
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
      writtenAt: new Date().toISOString(),
      totalMs: Math.round(performance.now() - START_T0),
      marks: STARTUP_MARKS,
      ...extra,
    }
    fs.writeFileSync(path.join(dir, 'startup-report.json'), JSON.stringify(report, null, 2))
  } catch {
    /* телеметрия не должна ломать запуск */
  }
}

// Локальный AI-слой (спецификация §4–§134) — модульный: при отсутствии пакетов/моделей
// приложение продолжает работать (§0, §129). Загружаем лениво и честно отражаем статус.
let VoicePipeline = null
let voicePipeline = null
try {
  VoicePipeline = require('./ai/voice-pipeline.cjs').VoicePipeline
} catch (e) {
  log(`[AI] voice-pipeline недоступен: ${e.message}`)
}

// --- структурированный лог (секция 21): без секретов ---------------------------

const LOG_MAX_BYTES = 512 * 1024
let logStream = null
// Ранний буфер: до app ready писать некуда (portable EXE не имеет консоли) —
// копим и дописываем в файл сразу после ready, чтобы не терять ошибки старта
const EARLY_LOG_LINES = []
let fileLogEnabled = false

function logFile() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'avc.log')
    try {
      const st = fs.statSync(file)
      if (st.size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`)
    } catch {
      /* файла могло не быть */
    }
    if (!logStream) logStream = fs.createWriteStream(file, { flags: 'a' })
    return logStream
  } catch {
    return null
  }
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`
  console.log(stamped)
  if (!fileLogEnabled) {
    EARLY_LOG_LINES.push(stamped)
    if (EARLY_LOG_LINES.length > 1500) EARLY_LOG_LINES.shift()
    return
  }
  const stream = logFile()
  if (stream) stream.write(`${stamped}\n`)
}

function flushEarlyLogs() {
  fileLogEnabled = true
  const stream = logFile()
  if (stream && EARLY_LOG_LINES.length) stream.write(`${EARLY_LOG_LINES.join('\n')}\n`)
  EARLY_LOG_LINES.length = 0
}

/** Редактирование секретов из любых диагностических строк (секция 15) */
function redact(text) {
  return String(text)
    .replace(/(cookie|token|authorization|password)=[^;\s"']+/gi, '$1=[REDACTED]')
    .replace(/PHPSESSID=[^;\s"']+/gi, 'PHPSESSID=[REDACTED]')
}

process.on('uncaughtException', (err) => reportFatal(err, 'uncaughtException'))
process.on('unhandledRejection', (reason) => reportFatal(reason, 'unhandledRejection'))

// --- режим самопроверки ---------------------------------------------------------

const SELFTEST = process.argv.includes('--auth-selftest')
if (SELFTEST) {
  app.disableHardwareAcceleration()
}

/** Режим самопроверки AI-слоя в РЕАЛЬНОМ main-процессе (§120, §121) — без UI */
const AI_SELFTEST = process.argv.includes('--ai-selftest')
if (AI_SELFTEST) {
  app.disableHardwareAcceleration()
}

// --- Next.js сервер для packaged-сборки -----------------------------------------

let nextProcess = null

function findFreePort(start) {
  return new Promise((resolve) => {
    const srv = http.createServer()
    srv.listen(start, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', () => resolve(findFreePort(start + 1)))
  })
}

function waitForServer(url, timeoutMs = 90000, onTick) {
  const started = Date.now()
  let lastTick = 0
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(url, (res) => {
        res.resume()
        if (res.statusCode && res.statusCode < 500) return resolve()
        retry()
      })
      req.on('error', retry)
      req.setTimeout(2000, () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Локальный сервер интерфейса не ответил за ${Math.round(timeoutMs / 1000)} с (подробности в логе [Next] выше)`))
      }
      if (onTick && Date.now() - lastTick > 5000) {
        lastTick = Date.now()
        onTick(Math.round((Date.now() - started) / 1000))
      }
      setTimeout(probe, 300)
    }
    probe()
  })
}

async function startNextServer() {
  // Dev-режим: используем уже запущенный сервер разработки
  const devUrl = process.env.AVC_APP_URL || 'http://localhost:3000'
  const resourcesDir = process.env.AVC_RESOURCES_DIR || (app.isPackaged ? process.resourcesPath : null)
  const standaloneDir = resourcesDir ? path.join(resourcesDir, 'next-app') : null

  if (!standaloneDir || !fs.existsSync(path.join(standaloneDir, 'server.js'))) {
    log(`[Main] Packaged Next server not found — using dev URL ${devUrl}`)
    return devUrl
  }

  const port = await findFreePort(3010)
  const dataDir = app.getPath('userData')
  const dbDir = path.join(dataDir, 'db')
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })
  // Первичный перенос локальной БД (Prisma/SQLite) в стабильное userData
  const dbTarget = path.join(dbDir, 'custom.db')
  const devDb = path.join(app.getAppPath(), '..', 'db', 'custom.db')
  try {
    if (!fs.existsSync(dbTarget) && fs.existsSync(devDb)) fs.copyFileSync(devDb, dbTarget)
  } catch (e) {
    log(`[Main] DB copy skipped: ${e.message}`)
  }

  const serverEntry = path.join(standaloneDir, 'server.js')
  log(`[Main] Starting packaged Next server on port ${port}`)
  nextProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      // Windows-пути с "\" ломают file:-URL Prisma — всегда прямые слэши
      DATABASE_URL: `file:${dbTarget.split(path.sep).join('/')}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  nextProcess.stdout.on('data', (d) => {
    const s = String(d).trim()
    if (s) log(`[Next] ${redact(s.slice(0, 400))}`)
  })
  nextProcess.stderr.on('data', (d) => {
    const s = String(d).trim()
    if (s) log(`[Next:err] ${redact(s.slice(0, 400))}`)
  })
  const url = `http://127.0.0.1:${port}`
  // Если серверный процесс умер ДО готовности — падаем сразу с понятной причиной,
  // а не ждём таймаут «в тишине»
  let serverReady = false
  nextProcess.once('exit', (code, signal) => {
    if (!serverReady) {
      const why = code !== null ? `код ${code}` : `сигнал ${signal}`
      log(`[Main] Next server exited before ready (${why})`)
      setSplashStage(`Сервер интерфейса неожиданно завершился (${why}) — смотрите окно ошибки`)
      fatalPromise = Promise.resolve(showFatalError(new Error(`Сервер интерфейса завершился до готовности (${why}). Подробности в логе ([Next]/[Next:err] строки выше).`)))
    }
  })
  await waitForServer(url, 90000, (sec) => {
    setSplashStage(`Запуск локального сервера… ${sec} с (первый запуск может занять дольше)`)
  })
  serverReady = true
  return url
}

// --- основная сборка --------------------------------------------------------------

let mainWindow = null
let authService = null

// --- окно запуска (splash) и окно ошибки запуска --------------------------------
// Проблема, которую они решают: до готовности Next-сервера у приложения НЕ БЫЛО ни
// одного окна — при долгой распаковке portable EXE (минуты) или сбое старта
// пользователь видел «висит в процессах и ничего не происходит».

let splashWindow = null
let fatalWindow = null
let fatalPromise = null

function createSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) return
  try {
    splashWindow = new BrowserWindow({
      width: 470,
      height: 250,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: true,
      fullscreenable: false,
      show: false,
      center: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      backgroundColor: '#07111F',
      title: 'AVC-Anime',
      webPreferences: {
        preload: path.join(__dirname, 'splash-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    splashWindow.once('ready-to-show', () => {
      try { splashWindow.show() } catch { /* окно могли закрыть */ }
    })
    splashWindow.on('closed', () => { splashWindow = null })
    splashWindow.loadFile(path.join(__dirname, 'splash.html')).catch(() => { /* не критично */ })
    log('[Splash] окно запуска показано')
  } catch (e) {
    log(`[Splash] не удалось показать окно запуска: ${e.message}`)
    splashWindow = null
  }
}

function setSplashStage(text) {
  const win = splashWindow && !splashWindow.isDestroyed() ? splashWindow : null
  if (!win) return
  win.webContents.executeJavaScript(`window.__stage(${JSON.stringify(String(text || ''))})`).catch(() => { /* окно закрыли */ })
}

function closeSplash() {
  try {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy()
  } catch { /* уже закрыто */ }
  splashWindow = null
}

/** Последние n строк журнала — для окна ошибки */
function readLogTail(n = 80) {
  try {
    const file = path.join(app.getPath('userData'), 'logs', 'avc.log')
    const raw = fs.readFileSync(file, 'utf8')
    return raw.split('\n').slice(-n).join('\n')
  } catch {
    return '(лог ещё не создан)'
  }
}

/** Окно фатальной ошибки запуска: сообщение + хвост лога + перезапуск/выход */
async function showFatalError(err) {
  if (SELFTEST || AI_SELFTEST) return
  closeSplash()
  if (fatalWindow && !fatalWindow.isDestroyed()) return
  const message = String((err && (err.stack || err.message)) || err || 'Неизвестная ошибка').slice(0, 3000)
  log(`[Boot] FATAL: ${redact(message)}`)
  try {
    fatalWindow = new BrowserWindow({
      width: 780,
      height: 620,
      title: 'AVC-Anime — ошибка запуска',
      backgroundColor: '#0b1626',
      resizable: true,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'splash-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    fatalWindow.on('closed', () => {
      fatalWindow = null
      // Окно ошибки закрыли без перезапуска — если главного окна нет, завершаем приложение
      if (!mainWindow || mainWindow.isDestroyed()) app.exit(1)
    })
    await fatalWindow.loadFile(path.join(__dirname, 'splash.html'), { search: 'mode=fatal' })
    fatalWindow.webContents
      .executeJavaScript(`window.__fatal(${JSON.stringify({ message, logTail: readLogTail(80) })})`)
      .catch(() => { /* окно закрыли до загрузки */ })
  } catch (e) {
    // Последний рубеж — нативный диалог, чтобы приложение НИКОГДА не висело молча
    log(`[Boot] не удалось показать окно ошибки: ${e.message}`)
    try { dialog.showErrorBox('AVC-Anime — ошибка запуска', message) } catch { /* ignore */ }
    app.exit(1)
  }
}

/**
 * Единый обработчик фатальных ошибок (uncaughtException/unhandledRejection).
 * Пока интерфейс не открыт — ЛЮБАЯ ошибка старта показывается пользователю,
 * чтобы приложение никогда не «висело в процессах молча».
 */
function reportFatal(err, origin) {
  const text = redact(String((err && (err.stack || err.message)) || err || 'unknown'))
  try { log(`[Main] ${origin}: ${text}`) } catch { /* слишком рано даже для лога */ }
  if (SELFTEST || AI_SELFTEST) return
  if (mainWindow && !mainWindow.isDestroyed()) return // рабочее приложение — не пугаем пользователя
  if (fatalPromise) return
  fatalPromise = showFatalError(new Error(`${origin}\n\n${text}`)).catch(() => { /* уже залогировано */ })
}

function setupSplashIpc() {
  ipcMain.on('avc:splash:open-logs', async () => {
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const err = await shell.openPath(dir)
      if (err) log(`[Splash] открыть папку логов не удалось: ${err}`)
    } catch (e) {
      log(`[Splash] открыть папку логов не удалось: ${e.message}`)
    }
  })
  ipcMain.on('avc:splash:quit', () => app.exit(1))
  ipcMain.on('avc:splash:relaunch', () => {
    try { app.relaunch() } catch { /* не получилось — просто выходим */ }
    app.exit(0)
  })
}

async function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'AVC-Anime',
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#07111F',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Главный экран приложения не улетает на сторонние сайты
  mainWindow.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) e.preventDefault()
  })
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target) // внешние ссылки — в системный браузер
    return { action: 'deny' }
  })

  // Загрузка с повторами: transient-сбои старта сервера не должны убивать запуск
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await mainWindow.loadURL(url)
      lastErr = null
      break
    } catch (e) {
      lastErr = e
      log(`[Main] loadURL попытка ${attempt} не удалась: ${e.message}`)
      if (attempt < 3) {
        setSplashStage(`Подключение к интерфейсу… (попытка ${attempt + 1})`)
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
  }
  if (lastErr) {
    try { mainWindow.destroy() } catch { /* уже закрыто */ }
    mainWindow = null
    throw lastErr
  }
  mainWindow.once('ready-to-show', () => {
    try { mainWindow.show() } catch { /* окно могли закрыть */ }
  })
  closeSplash()
  markStartup('ui-loaded')
  mainWindow.webContents.once('did-finish-load', () => {
    markStartup('ui-usable')
    writeStartupReport()
  })
  return mainWindow
}

function setupIpc(service) {
  ipcMain.handle('avc:auth:getState', (_e, args) => service.verify({ force: !!args?.refresh }))
  ipcMain.handle('avc:auth:open-login', () => service.startLogin())
  ipcMain.handle('avc:auth:verify', () => service.verify({ force: true }))
  ipcMain.handle('avc:auth:logout', () => service.logout())
  ipcMain.handle('avc:auth:favorites', (_e, args) => service.getFavorites({ refresh: !!args?.refresh }))
  ipcMain.handle('avc:auth:reset-session', (_e, args) =>
    service.resetSession({ confirmed: !!args?.confirmed }),
  )
  ipcMain.handle('avc:auth:selftest', () => service.selftest())
  // РЕАЛЬНОЕ действие аккаунта ВНУТРИ сессии сайта (список/оценка/избранное)
  ipcMain.handle('avc:anime:action', (_e, req) => service.animeAction(req))
}

/**
 * Мост IPC ⇔ AI-воркер (utilityProcess, §130 process isolation).
 * В main-процессе Electron N-API external arraybuffers запрещены («External buffers
 * are not allowed») — нативный sherpa-onnx TTS требует их, поэтому весь нативный AI
 * живёт в изолированном utilityProcess (полный Node), а main только пересылает сообщения.
 */
const AI_EVENT_CHANNELS = {
  'stt-partial': 'avc:ai:stt-partial',
  'stt-final': 'avc:ai:stt-final',
  'services-status': 'avc:ai:services-status',
  'model-progress': 'avc:ai:model-progress',
  'tts-speak-file': 'avc:ai:tts-speak-file',
  'tts-cancel': 'avc:ai:tts-cancel',
}

let aiWorker = null
let aiWorkerReqId = 0
const aiWorkerPending = new Map()
let aiWorkerFailed = null

function aiWorkerRequest(type, args) {
  if (!aiWorker) return Promise.reject(new Error(aiWorkerFailed || 'AI-воркер не запущен'))
  return new Promise((resolve, reject) => {
    const id = `req-${++aiWorkerReqId}`
    const timer = setTimeout(() => {
      aiWorkerPending.delete(id)
      reject(new Error(`AI-воркер: таймаут запроса ${type}`))
    }, args?.__timeoutMs || 300000)
    aiWorkerPending.set(id, { resolve, reject, timer })
    try {
      aiWorker.send({ id, type, args })
    } catch (e) {
      clearTimeout(timer)
      aiWorkerPending.delete(id)
      reject(e)
    }
  })
}

/** Путь к чистому Node для AI-воркера: packaged → bundled runtime, dev → PATH */
function findSystemNode() {
  if (process.env.AVC_NODE_EXE && fs.existsSync(process.env.AVC_NODE_EXE)) return process.env.AVC_NODE_EXE
  try {
    const resourcesDir = process.resourcesPath || null
    if (resourcesDir) {
      const cand =
        process.platform === 'win32'
          ? path.join(resourcesDir, 'runtime-node', 'node.exe')
          : path.join(resourcesDir, 'runtime-node', 'bin', 'node')
      if (fs.existsSync(cand)) return cand
    }
  } catch { /* dev-режим */ }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const p = process.platform === 'win32' ? path.join(dir, 'node.exe') : path.join(dir, 'node')
    try { if (fs.existsSync(p)) return p } catch { /* ок */ }
  }
  return null
}

/** Конфиг каталога моделей (фаза 5 аудита): userData/models-dir.json */
function modelsDirConfigPath() {
  return path.join(app.getPath('userData'), 'models-dir.json')
}

function readModelsDirConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(modelsDirConfigPath(), 'utf8'))
    const dir = typeof raw.modelsDir === 'string' ? raw.modelsDir.trim() : ''
    return dir && path.isAbsolute(dir) ? dir : null
  } catch {
    return null
  }
}

function writeModelsDirConfig(dir) {
  fs.writeFileSync(modelsDirConfigPath(), JSON.stringify({ modelsDir: dir }, null, 2))
}

/** Каталог моделей: конфиг пользователя → dev-models → userData/ai-models */
function resolveModelsDir() {
  const configured = readModelsDirConfig()
  if (configured) return configured
  const devModels = path.join(app.getAppPath(), 'models')
  if (fs.existsSync(path.join(devModels, 'stt'))) return devModels
  return path.join(app.getPath('userData'), 'ai-models')
}

/** Размер каталога в байтах и число файлов (для проверки миграции) */
function dirStats(dir) {
  let bytes = 0
  let files = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        bytes += fs.statSync(p).size
        files++
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

function startAiWorker() {
  try {
    // Фаза 5 (аудит №4): каталог моделей можно переопределить пользователем
    // (Настройки → AI-модели → Изменить папку); конфиг living в userData.
    const modelsDir = resolveModelsDir()
    const workerScript = app.isPackaged
      ? path.join(process.resourcesPath, 'ai', 'ai-worker.cjs')
      : path.join(__dirname, 'ai', 'ai-worker.cjs')
    if (aiWorker) {
      // перезапуск (миграция моделей): гасим старый воркер и ждём его выхода
      try { aiWorker.kill() } catch { /* уже мёртв */ }
      aiWorker = null
    }
    // Нативный sherpa-onnx возвращает Float32Array через napi external arraybuffer —
    // Electron запрещает их В ЛЮБЫХ своих процессах, поэтому AI-воркер работает
    // на ЧИСТОМ Node: packaged — resources/runtime-node, dev — системный node.
    const nodeExe = findSystemNode()
    if (!nodeExe) {
      aiWorkerFailed = 'Node-рантайм для AI-воркера не найден (ожидался resources/runtime-node или node в PATH)'
      log(`[AI] ${aiWorkerFailed}`)
      return
    }
    aiWorker = childFork(workerScript, [], {
      execPath: nodeExe,
      env: { ...process.env, AVC_MODELS_DIR: modelsDir },
      // stdout/stderr воркера — в pipe: логи нативных моделей не смешиваются с выводом main
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // structured clone: Int16Array аудио доезжает до воркера как типизированный массив
      serialization: 'advanced',
    })
    aiWorker.stdout && aiWorker.stdout.on('data', (d) => log(`[AIWorker] ${String(d).trim().slice(0, 300)}`))
    aiWorker.stderr && aiWorker.stderr.on('data', (d) => log(`[AIWorker] ${String(d).trim().slice(0, 300)}`))
    aiWorker.on('message', (msg) => {
      if (msg && msg.event) {
        if (msg.event === 'services-status') markStartup('ai-worker-services-status')
        const channel = AI_EVENT_CHANNELS[msg.event]
        if (channel && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(channel, msg.payload)
        }
        return
      }
      if (msg && msg.id) {
        const pending = aiWorkerPending.get(msg.id)
        if (!pending) return
        aiWorkerPending.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.ok) pending.resolve(msg.result)
        else pending.reject(new Error(msg.error || 'ошибка AI-воркера'))
      }
    })
    aiWorker.on('exit', () => {
      aiWorker = null
      // честно отклоняем зависшие запросы
      for (const [id, p] of aiWorkerPending) {
        clearTimeout(p.timer)
        p.reject(new Error('AI-воркер завершился'))
        aiWorkerPending.delete(id)
      }
    })
    log('[AI] Node-процесс воркера запущен (изолированный нативный AI, §130)')
    markStartup('ai-worker-spawned')
  } catch (e) {
    aiWorkerFailed = e.message
    log(`[AI] Не удалось запустить AI-воркер (AI недоступен): ${e.message}`)
  }
}

/** IPC локального AI-слоя (наружу — только не-секретные данные) */
function setupAiIpc() {
  ipcMain.handle('avc:ai:status', async () => {
    try {
      const st = await aiWorkerRequest('status')
      return { ...st, worker: 'ok' }
    } catch (e) {
      return { enabled: false, worker: 'failed', reason: e.message, ready: { stt: false, llm: false, tts: false } }
    }
  })
  ipcMain.handle('avc:ai:hardware', async () => {
    const hw = await aiWorkerRequest('hardware')
    try {
      const info = await app.getGPUInfo('basic')
      const dev = info && info.gpuDevice && info.gpuDevice[0]
      if (dev) hw.gpu = { vendor: dev.vendorId, device: dev.deviceId, name: dev.deviceString || null }
    } catch { /* gpu остаётся null — честно */ }
    return hw
  })
  ipcMain.handle('avc:ai:install', (_e, args) => aiWorkerRequest('install', { ...args, __timeoutMs: 3600000 }))
  ipcMain.handle('avc:ai:cancel-install', (_e, args) => aiWorkerRequest('cancel-install', args))
  ipcMain.handle('avc:ai:recover', () => aiWorkerRequest('recover'))
  ipcMain.handle('avc:ai:set-enabled', (_e, args) => aiWorkerRequest('set-enabled', args))
  ipcMain.handle('avc:ai:set-profile', (_e, args) => aiWorkerRequest('set-profile', args))
  ipcMain.handle('avc:ai:llm-route', (_e, args) =>
    aiWorkerRequest('llm-route', { ...args, __timeoutMs: (args?.timeoutMs || 8000) + 30000 }),
  )
  ipcMain.handle('avc:ai:tts-speak', (_e, args) => aiWorkerRequest('tts-speak', { ...args, __timeoutMs: 60000 }))
  ipcMain.handle('avc:ai:tts-cancel', () => aiWorkerRequest('tts-cancel'))
  ipcMain.handle('avc:ai:set-voice', (_e, args) => aiWorkerRequest('set-voice', args))
  ipcMain.handle('avc:ai:initialize', () => aiWorkerRequest('initialize', { __timeoutMs: 600000 }))
  ipcMain.handle('avc:ai:stt-feed', (_e, args) => {
    const samples = args?.samples
    if (!samples) return false
    return aiWorkerRequest('feed', { samples })
  })
  ipcMain.handle('avc:ai:stt-flush', () => aiWorkerRequest('flush'))

  // --- Фаза 5 (аудит №4): каталог AI-моделей — выбор, миграция, открытие ---

  ipcMain.handle('avc:ai:models:get-config', () => {
    const current = resolveModelsDir()
    let usedBytes = null
    try {
      if (fs.existsSync(current)) usedBytes = dirStats(current).bytes
    } catch { /* каталог мог быть пуст/недоступен */ }
    return {
      currentDir: current,
      configured: readModelsDirConfig(),
      defaultDir: path.join(app.getPath('userData'), 'ai-models'),
      usedBytes,
      workerReady: !!aiWorker,
    }
  })

  ipcMain.handle('avc:ai:models:pick-dir', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Папка для AI-моделей AVC-Anime',
      buttonLabel: 'Выбрать папку',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: resolveModelsDir(),
    })
    if (res.canceled || !res.filePaths?.[0]) return null
    return res.filePaths[0]
  })

  ipcMain.handle('avc:ai:models:open-dir', async () => {
    const dir = resolveModelsDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const err = await shell.openPath(dir)
    return { ok: !err, error: err || null }
  })

  /**
   * Безопасная смена каталога моделей (фаза 5.4):
   * валидация → свободное место → копирование → сверка → конфиг → рестарт воркера.
   * Старый каталог НЕ удаляется; при ошибке конфиг не меняется (откат = ничего не делаем).
   */
  ipcMain.handle('avc:ai:models:set-dir', async (_e, args) => {
    const target = String(args?.dir || '').trim()
    if (!target || !path.isAbsolute(target)) {
      return { ok: false, error: 'Нужен абсолютный путь к папке' }
    }
    const source = resolveModelsDir()
    if (path.resolve(target) === path.resolve(source)) {
      return { ok: true, migrated: false, dir: target, message: 'Каталог не изменился' }
    }
    try {
      fs.mkdirSync(target, { recursive: true })
      // пробная запись: права доступа (сетевые/съёмные диски, юникод-пути)
      const probe = path.join(target, `.avc-write-test-${Date.now()}`)
      fs.writeFileSync(probe, 'ok')
      fs.rmSync(probe, { force: true })

      const srcExists = fs.existsSync(source)
      const srcStats = srcExists ? dirStats(source) : { bytes: 0, files: 0 }
      if (srcStats.files > 0) {
        // свободное место на целевом диске
        try {
          const stfs = await fs.promises.statfs(target)
          const free = stfs.bavail * stfs.bsize
          if (free < srcStats.bytes * 1.05) {
            return {
              ok: false,
              error: `Недостаточно места: доступно ${Math.floor(free / 1048576)} МБ, нужно ${Math.ceil(srcStats.bytes / 1048576)} МБ`,
            }
          }
        } catch { /* statfs недоступен — проверим сверкой после копирования */ }
        log(`[Models] Миграция моделей: ${source} → ${target} (${srcStats.files} файлов)`)
        await fs.promises.cp(source, target, { recursive: true, force: false, errorOnExist: false })
        // сверка: количество файлов и суммарный размер должны совпасть
        const dstStats = dirStats(target)
        if (dstStats.files < srcStats.files || dstStats.bytes < srcStats.bytes) {
          return {
            ok: false,
            error: `Сверка после копирования не сошлась: было ${srcStats.files} файлов/${srcStats.bytes} байт, стало ${dstStats.files}/${dstStats.bytes}. Конфиг не изменён, старый каталог сохранён.`,
          }
        }
      }
      writeModelsDirConfig(target)
      // перезапуск воркера с новым каталогом (модели подхватятся с места)
      startAiWorker()
      log(`[Models] Каталог моделей переключён: ${target}`)
      return {
        ok: true,
        migrated: srcStats.files > 0,
        dir: target,
        copiedFiles: srcStats.files,
        copiedBytes: srcStats.bytes,
        message: 'Каталог моделей обновлён',
      }
    } catch (err) {
      log(`[Models] Ошибка миграции: ${err.message}`)
      return {
        ok: false,
        error: `Миграция не удалась: ${err.message}. Конфиг не изменён, старый каталог сохранён.`,
      }
    }
  })
}

/** Минимальная блокировка рекламных доменов в сессии сайта (не мешает входу) */
function setupAdShield() {
  const ses = session.fromPartition(PARTITION)
  const adHosts = /(^|\.)adfinity\.pro$/i
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    try {
      const host = new URL(details.url).hostname
      cb({ cancel: adHosts.test(host) })
    } catch {
      cb({ cancel: false })
    }
  })
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    // В сессии сайта разрешения не нужны (микрофон живёт в основном окне приложения)
    cb(['fullscreen', 'clipboard-read'].includes(permission))
  })
}

async function runSelftest() {
  log('[Auth] Initializing YummyAnime session (selftest mode)')
  authService = new AuthenticationService({ log, userDataDir: app.getPath('userData') })
  const report = await authService.selftest()
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  authService.shutdown()
  app.exit(report.network === 'ONLINE' ? 0 : 2)
}

/**
 * Основная последовательность запуска. ЛЮБОЕ исключение здесь больше не «умирает
 * молча»: whenReady оборачивает вызов в try/catch и показывает окно ошибки.
 */
async function boot() {
  setupAdShield()

  setSplashStage('Инициализация сессии сайта…')
  authService = new AuthenticationService({
    log,
    userDataDir: app.getPath('userData'),
    onStatus: (msg) => {
      // Статусы входа (капча/ошибка/успех) — в UI приложения как toast-сообщения
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('avc:auth-status', msg)
      }
    },
  })

  authService.subscribe((snap) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('avc:account-changed', snap)
    }
  })

  markStartup('auth-service-ready')

  setupIpc(authService)

  // Локальный AI-слой: utilityProcess запускается сразу, IPC ставится до окна (§49):
  // модели могут отсутствовать — детерминированный голос остаётся рабочим (§0/§129)
  setupAiIpc()
  setSplashStage('Запуск голосового AI-слоя…')
  startAiWorker()

  setSplashStage('Запуск локального сервера…')
  const url = await startNextServer()
  markStartup('next-server-ready')

  setSplashStage('Открытие интерфейса…')
  await createMainWindow(url)
  markStartup('window-created')
  log(`[Main] UI ready at ${url}`)

  // Фоновая сверка состояния аккаунта при старте (одна проверка, без поллинга)
  void authService.verify().catch(() => undefined)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow(url)
  })
}

app.whenReady().then(async () => {
  flushEarlyLogs() // дальше логи сразу пишутся в файл
  markStartup('app-ready')
  log('[Auth] Initializing YummyAnime session (persistent partition)')

  if (SELFTEST) {
    await runSelftest()
    return
  }

  // AI-самопроверка в реальном main-процессе: ЧЕРЕЗ utilityProcess-воркер (как в продакшне)
  if (AI_SELFTEST) {
    try {
      setupAiIpc()
      startAiWorker()
      const report = {
        ranAt: new Date().toISOString(),
        platform: process.platform,
        electron: process.versions.electron,
        workerStarted: !!aiWorker,
      }
      if (!aiWorker) throw new Error(aiWorkerFailed || 'воркер не запустился')
      // ждём готовности сервисов (worker инициализирует их сам, ждём до 120 с)
      let status = null
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        status = await aiWorkerRequest('status')
        if (status.ready.stt && status.ready.tts && status.ready.llm) break
      }
      report.models = status.models.map((m) => ({ key: m.key, installed: m.installed }))
      report.services = status.ready
      // мини-прогон TTS→STT→early (§121, Test A) через воркер
      if (status.ready.stt && status.ready.tts) {
        const events = { partials: 0, finalText: '', early: null, partialTexts: [], rawFirst: null }
        aiWorker.on('message', (msg) => {
          if (msg && msg.event === 'stt-partial') {
            events.partials++
            if (!events.rawFirst) events.rawFirst = JSON.stringify(msg.payload)
            events.partialTexts.push(msg.payload && msg.payload.text)
            if (msg.payload && msg.payload.earlyCommand) events.early = msg.payload.earlyCommand
          }
          if (msg && msg.event === 'stt-final') events.finalText = (msg.payload && msg.payload.text) || ''
        })
        await aiWorkerRequest('tts-speak', { text: 'Пауза.' })
        // TTS отдаёт файл через событие tts-speak-file; для самопроверки читаем последний кэш-файл фразы
        const { TTSService } = require('./ai/tts-service.cjs')
        const tts = new TTSService({ modelsDir: path.join(__dirname, 'models') })
        const wav = tts.cachePath('Пауза.')
        const { readWavAsFloat32 } = require('./ai/stt-service.cjs')
        const info = readWavAsFloat32(wav)
        const n = Math.floor(info.samples.length * 16000 / info.sampleRate)
        const s16 = new Float32Array(n)
        for (let i = 0; i < n; i++) {
          const t = i * (info.sampleRate / 16000)
          const i0 = Math.floor(t)
          const a = info.samples[Math.min(i0, info.samples.length - 1)]
          const b = info.samples[Math.min(i0 + 1, info.samples.length - 1)]
          s16[i] = a + (b - a) * (t - i0)
        }
        const headPad = new Int16Array(16000 * 0.4)
        const tailPad = new Int16Array(16000 * 0.8)
        const int16 = new Int16Array(headPad.length + s16.length + tailPad.length)
        for (let i = 0; i < s16.length; i++) int16[headPad.length + i] = Math.round(s16[i] * 32768)
        const CH = 512
        for (let off = 0; off + CH <= int16.length; off += CH) {
          await aiWorkerRequest('feed', { samples: int16.subarray(off, off + CH) })
          // реальный темп микрофона: окно 512 сэмплов @16 кГц = 32 мс —
          // иначе частичные результаты не успевают появляться (§11/§12)
          await new Promise((r) => setTimeout(r, 30))
        }
        await aiWorkerRequest('flush')
        await new Promise((r) => setTimeout(r, 800))
        status = await aiWorkerRequest('status')
        report.loopTest = { partials: events.partials, partialTexts: events.partialTexts, rawFirst: events.rawFirst, finalText: events.finalText, earlyCommand: events.early, sttUtterances: status.stt.utterances, sttLastFinalMs: status.stt.lastFinalMs, sttError: status.stt.error }
      }
      process.stdout.write(`[AI-SELFTEST] report: ${path.join(__dirname, 'tools', 'ai-main-selftest-report.json')}\n`)
      try {
        fs.writeFileSync(path.join(__dirname, 'tools', 'ai-main-selftest-report.json'), JSON.stringify(report, null, 2))
      } catch { /* ок */ }
      const ok = report.workerStarted && status.ready.stt && status.ready.tts && status.ready.llm && report.loopTest && report.loopTest.earlyCommand === 'Pause'
      app.exit(ok ? 0 : 2)
    } catch (e) {
      process.stdout.write(`${JSON.stringify({ error: e.message })}\n`)
      app.exit(3)
    }
    return
  }

  // Обычный запуск: сначала окно запуска (обратная связь с первой секунды),
  // затем вся последовательность старта под watchdog'ом — ЛЮБОЕ исключение
  // показывается в окне ошибки, приложение никогда не «висит молча».
  setupSplashIpc()
  createSplashWindow()
  setSplashStage('Инициализация…')
  try {
    await boot()
  } catch (e) {
    await showFatalError(e)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (authService) authService.shutdown()
  if (aiWorker) {
    try { aiWorker.kill() } catch { /* ок */ }
    aiWorker = null
  }
  if (nextProcess && !nextProcess.killed) nextProcess.kill()
})

// Защита единственного экземпляра.
// ВАЖНО: молчаливый app.quit() выглядел для пользователя как «EXE не запускается» —
// теперь второй экземпляр ЧЕСТНО сообщает о первом (возможно зависшем) экземпляре.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  try {
    dialog.showErrorBox(
      'AVC-Anime уже запущен',
      'Приложение уже работает — возможно, его окно сейчас скрыто, либо предыдущий '
        + 'экземпляр завершился некорректно.\n\n'
        + 'Если окна нет: закройте AVC-Anime.exe в Диспетчере задач (Ctrl+Shift+Esc → '
        + 'вкладка «Подробности») и запустите приложение заново.',
    )
  } catch { /* ignore */ }
  app.exit(0)
} else {
  app.on('second-instance', () => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : splashWindow
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}
