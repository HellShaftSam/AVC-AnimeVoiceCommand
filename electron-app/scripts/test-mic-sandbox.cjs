/**
 * Тест MicService в песочнице (полный путь как в EXE):
 *  - capture-страница раздаётся с http://127.0.0.1:<port>/mic-capture (secure context);
 *  - createCapture должен быстро дойти до getUserMedia и честно упасть
 *    («нет микрофона в песочнице»), а НЕ висеть 15 с.
 * Запуск: DISPLAY=:99 electron scripts/test-mic-sandbox.cjs
 */
const { app } = require('electron')
const http = require('http')
const path = require('path')

app.whenReady().then(async () => {
  const { MicService, capturePageHtml } = require(path.join(__dirname, '..', 'speech', 'mic-service.cjs'))

  // мини-bridge с capture-страницей (secure context, как в main.cjs)
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(capturePageHtml())
  })
  await new Promise((r) => server.listen(3117, '127.0.0.1', r))

  const mic = new MicService()
  mic.onLog = (m) => console.log('[mic-log]', m)
  mic.captureUrl = 'http://127.0.0.1:3117/mic-capture'

  const t0 = Date.now()
  try {
    const handle = await mic.createCapture({
      deviceId: 'deadbeef-stale-id', // несуществующее устройство — как у пользователя
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      onFrame: () => {},
      onDevices: (l) => console.log('[devices]', l.length),
      onEnded: (r) => console.log('[ended]', r),
      onError: (e) => console.log('[err]', e),
    })
    console.log('CAPTURE OPENED за', Date.now() - t0, 'мс, deviceId=', handle.deviceId || '(пусто)')
    setTimeout(() => {
      handle.stop()
      setTimeout(() => app.exit(0), 400)
    }, 1500)
  } catch (e) {
    console.log('EXPECTED FAIL за', Date.now() - t0, 'мс:', e.message)
    server.close()
    app.exit(0)
  }
  setTimeout(() => {
    console.error('TEST HUNG — MicService не завершился за 25 с')
    app.exit(1)
  }, 25000).unref()
})
