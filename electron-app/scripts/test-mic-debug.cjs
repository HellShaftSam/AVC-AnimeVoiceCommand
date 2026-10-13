/**
 * Диагностика рукопожатия capture-окна: где рвётся цепочка
 * did-finish-load → postMessage(port) → preload onPortReady → page 'ready' → main?
 * Запуск: DISPLAY=:99 electron scripts/test-mic-debug.cjs
 */
const { app, BrowserWindow, MessageChannelMain } = require('electron')
const path = require('path')

app.whenReady().then(async () => {
  const page = `<!doctype html><html><body><script>
console.log('[page] script start, avcMic=', typeof window.avcMic)
window.avcMic.onPortReady((p) => {
  console.log('[page] onPortReady fired, port=', !!p)
  try {
    p.postMessage({ type: 'ready' })
    console.log('[page] ready sent')
  } catch (e) { console.log('[page] ready FAILED: ' + e.message) }
  p.onmessage = (e) => {
    console.log('[page] got message: ' + JSON.stringify(e.data || {}).slice(0, 80))
    if (e.data && e.data.type === 'ping') p.postMessage({ type: 'pong' })
  }
})
console.log('[page] onPortReady registered')
<\/script></body></html>`

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
    console.log('[main] port1 message:', JSON.stringify(e.data || {}).slice(0, 100))
    if (e.data && e.data.type === 'ready') {
      console.log('[main] handshake OK — sending ping')
      port1.postMessage({ type: 'ping' })
    }
  })
  port1.start()

  win.webContents.on('did-start-loading', () => console.log('[main] did-start-loading'))
  win.webContents.on('did-finish-load', () => {
    console.log('[main] did-finish-load → posting port2')
    try {
      win.webContents.postMessage('mic-port', null, [port2])
      console.log('[main] postMessage OK')
    } catch (e) {
      console.log('[main] postMessage FAILED:', e.message)
    }
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    console.log('[main] did-fail-load:', code, desc, 'isMain=', isMain)
  })
  win.webContents.on('console-message', (_e, level, message) => {
    console.log('[page-console]', message)
  })

  console.log('[main] loading data-url…')
  await win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(page)}`,
  )
  console.log('[main] loadURL resolved')

  setTimeout(() => {
    console.log('[main] 8s elapsed — test end')
    app.exit(0)
  }, 8000)
})
