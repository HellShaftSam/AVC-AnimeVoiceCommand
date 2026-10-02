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
const { app, BrowserWindow, ipcMain, session, shell } = require('electron')
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')
const fs = require('fs')
const { AuthenticationService, PARTITION } = require('./auth/authentication-service.cjs')

// --- структурированный лог (секция 21): без секретов ---------------------------

const LOG_MAX_BYTES = 512 * 1024
let logStream = null

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
  const stream = app.isReady() ? logFile() : null
  if (stream) stream.write(`${stamped}\n`)
}

/** Редактирование секретов из любых диагностических строк (секция 15) */
function redact(text) {
  return String(text)
    .replace(/(cookie|token|authorization|password)=[^;\s"']+/gi, '$1=[REDACTED]')
    .replace(/PHPSESSID=[^;\s"']+/gi, 'PHPSESSID=[REDACTED]')
}

process.on('uncaughtException', (err) => log(`[Main] Uncaught exception: ${redact(err.stack || err.message)}`))

// --- режим самопроверки ---------------------------------------------------------

const SELFTEST = process.argv.includes('--auth-selftest')
if (SELFTEST) {
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

function waitForServer(url, timeoutMs = 30000) {
  const started = Date.now()
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
      if (Date.now() - started > timeoutMs) return reject(new Error('Next server did not start'))
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
  nextProcess.stdout.on('data', () => {})
  nextProcess.stderr.on('data', (d) => log(`[Next] ${redact(String(d))}`))
  const url = `http://127.0.0.1:${port}`
  await waitForServer(url)
  return url
}

// --- основная сборка --------------------------------------------------------------

let mainWindow = null
let authService = null

async function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'AVC-Anime',
    autoHideMenuBar: true,
    backgroundColor: '#09090b',
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

  await mainWindow.loadURL(url)
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

app.whenReady().then(async () => {
  log('[Auth] Initializing YummyAnime session (persistent partition)')

  if (SELFTEST) {
    await runSelftest()
    return
  }

  setupAdShield()

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

  setupIpc(authService)

  const url = await startNextServer()
  await createMainWindow(url)
  log(`[Main] UI ready at ${url}`)

  // Фоновая сверка состояния аккаунта при старте (одна проверка, без поллинга)
  void authService.verify().catch(() => undefined)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow(url)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (authService) authService.shutdown()
  if (nextProcess && !nextProcess.killed) nextProcess.kill()
})

// Защита единственного экземпляра
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}
