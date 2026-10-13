/**
 * mic-preload — минимальный мост для служебного capture-окна (спека §24/§30).
 *
 * ВАЖНО (урок EXE 1.3.1): MessagePort НЕ проходит через contextBridge — страница
 * получала объект-клон без методов («p.postMessage is not a function»), рукопожатие
 * молча рвалось и микрофон «открывался» ровно до 15-секундного таймаута.
 * Поэтому порт живёт ЗДЕСЬ, в preload, а наружу отдаются только простые функции:
 *
 *   window.avcMic.onPortReady(cb) — cb(), когда порт получен (сразу, если готов);
 *   window.avcMic.send(msg)       — отправка в main (объект клонируется, это дёшево);
 *   window.avcMic.onMessage(cb)   — подписка на сообщения из main.
 *
 * Никаких node-API, файлов, shell — только этот мост.
 */
const { contextBridge, ipcRenderer } = require('electron')

let port = null
let messageHandler = null
const readyWaiters = []

ipcRenderer.on('mic-port', (e) => {
  try {
    console.log('[mic-preload] mic-port received, ports=', (e.ports || []).length)
  } catch {}
  port = e.ports[0]
  try {
    port.start()
  } catch (err) {
    console.log('[mic-preload] port.start failed: ' + err.message)
  }
  port.onmessage = (ev) => {
    if (!messageHandler) return
    try {
      messageHandler(ev.data)
    } catch {
      /* обработчик страницы сам защищается */
    }
  }
  console.log('[mic-preload] flushing waiters:', readyWaiters.length)
  readyWaiters.splice(0).forEach((cb) => {
    try {
      cb()
    } catch (err) {
      console.log('[mic-preload] waiter failed: ' + err.message)
    }
  })
})

contextBridge.exposeInMainWorld('avcMic', {
  onPortReady: (cb) => {
    if (typeof cb !== 'function') return
    try {
      console.log('[mic-preload] onPortReady: port=', !!port)
    } catch {}
    if (port) cb()
    else readyWaiters.push(cb)
  },
  send: (msg) => {
    if (!port) {
      try {
        console.log('[mic-preload] send: порт ещё не готов, msg=', (msg && msg.type) || '?')
      } catch {}
      return
    }
    try {
      // массив-буфер передаём копией (structured clone) — 100-мс кадр ~3 КБ, копия бесплатна
      port.postMessage(msg)
    } catch (err) {
      try {
        console.log('[mic-preload] postMessage failed: ' + err.message)
      } catch {}
      try {
        port.postMessage(String(msg))
      } catch {
        /* порт умер — main увидит таймаут/обрыв */
      }
    }
  },
  onMessage: (cb) => {
    messageHandler = typeof cb === 'function' ? cb : null
  },
})
