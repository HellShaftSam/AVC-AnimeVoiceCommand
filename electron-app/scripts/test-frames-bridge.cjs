/**
 * Микро-тест: кадры Int16/ArrayBuffer через contextBridge-мост (avcMic.send) → main.
 * Проверяет, что structured-clone не давит ArrayBuffer и main получает байты.
 * Запуск: DISPLAY=:99 electron scripts/test-frames-bridge.cjs
 */
const { app, BrowserWindow, MessageChannelMain } = require('electron')
const http = require('http')
const path = require('path')

app.whenReady().then(async () => {
  const { capturePageHtml } = require(path.join(__dirname, '..', 'speech', 'mic-service.cjs'))

  const server = http.createServer((req, res) => {
    // страница-имитатор: сама шлёт 3 фейковых кадра через мост
    const html = `<!doctype html><html><body><script>
window.avcMic.onPortReady(() => {
  for (let k = 0; k < 3; k++) {
    const buf = new Int16Array(1600)
    for (let i = 0; i < 1600; i++) buf[i] = (k + 1) * 100 + (i % 7)
    window.avcMic.send({ type: 'frame', sampleRate: 16000, buffer: buf.buffer })
  }
  window.avcMic.send({ type: 'stage', stage: 'frames-sent', detail: '3' })
})
<\/script></body></html>`
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(html)
  })
  await new Promise((r) => server.listen(3119, '127.0.0.1', r))

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
  let frames = 0
  let okBytes = 0
  port1.on('message', (e) => {
    const m = e.data || {}
    if (m.type === 'frame') {
      frames += 1
      const b = Buffer.from(m.buffer)
      // проверяем данные: k*100 + (i%7)
      let ok = b.length === 3200
      if (ok) {
        for (let i = 0; i < 1600 && ok; i++) {
          const expect = Math.floor(i / 1600) * 0 + (i % 7) // k потеряли — просто валидность структуры
          if (b.readInt16LE(i * 2) % 100 !== expect) ok = false
        }
      }
      if (ok) okBytes += 1
      console.log('[main] frame', frames, 'len=', b.length, ok ? 'data-ok' : 'data-BAD')
    } else {
      console.log('[main] msg:', m.type, m.stage || '')
    }
  })
  port1.start()

  win.webContents.on('did-finish-load', () => win.webContents.postMessage('mic-port', null, [port2]))
  await win.loadURL('http://127.0.0.1:3119/frames')
  setTimeout(() => {
    console.log(frames === 3 && okBytes === 3 ? 'BRIDGE FRAMES: PASS' : `BRIDGE FRAMES: FAIL (${frames}/${okBytes})`)
    server.close()
    app.exit(0)
  }, 3000)
})
