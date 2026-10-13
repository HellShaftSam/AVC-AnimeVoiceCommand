/**
 * Диагностика capture-конвейера на HTTP-origin: did-finish-load, порт, этапы страницы.
 * Запуск: DISPLAY=:99 electron scripts/test-mic-debug2.cjs
 */
const { app, BrowserWindow, MessageChannelMain } = require('electron')
const http = require('http')
const path = require('path')

app.whenReady().then(async () => {
  const { captureHtml } = require(path.join(__dirname, '..', 'speech', 'mic-service.cjs'))

  const server = http.createServer((req, res) => {
    console.log('[srv] request:', req.url)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(captureHtml())
  })
  await new Promise((r) => server.listen(3118, '127.0.0.1', r))

  const page = captureHtml()
  const win = new BrowserWindow({
    show: false,
    width: 8,
    height: 8,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, '..', 'mic-preload.cjs'),
    },
  })
  const { port1, port2 } = new MessageChannelMain()
  port1.on('message', (e) => {
    const m = e.data || {}
    console.log('[main-port]', m.type, JSON.stringify(m).slice(0, 110))
    if (m.type === 'ready') {
      console.log('[main] → отправляю start')
      port1.postMessage({ type: 'start', deviceId: 'deadbeef', echoCancellation: true, noiseSuppression: true, autoGainControl: true })
    }
  })
  port1.start()

  win.webContents.on('did-finish-load', () => {
    console.log('[main] did-finish-load → postMessage port2')
    win.webContents.postMessage('mic-port', null, [port2])
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    console.log('[main] did-fail-load:', code, desc, url, 'isMain=', isMain)
  })
  win.webContents.on('console-message', (_e, level, message) => {
    console.log('[page-console]', level, String(message).slice(0, 140))
  })

  console.log('[main] loading http://127.0.0.1:3118/mic-capture')
  await win.loadURL('http://127.0.0.1:3118/mic-capture')
  console.log('[main] loadURL resolved')

  setTimeout(() => {
    void (async () => {
      try {
        const info = await win.webContents.executeJavaScript(
          `JSON.stringify({
            avcMic: typeof window.avcMic,
            scripts: document.scripts.length,
            bodyLen: document.body ? document.body.innerHTML.length : -1,
            first40: document.body ? document.body.innerHTML.slice(0, 40) : '',
          })`,
        )
        console.log('[main] DOM info:', info)
      } catch (e) {
        console.log('[main] executeJavaScript failed:', e.message)
      }
      server.close()
      app.exit(0)
    })()
  }, 5000)

})
