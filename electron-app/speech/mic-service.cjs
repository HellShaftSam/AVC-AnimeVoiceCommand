/**
 * MicService — непрерывный захват микрофона для SttService (спека §13).
 *
 * Electron main-процесс не имеет собственного API захвата микрофона, поэтому
 * используется служебное СКРЫТОЕ окно Electron (show:false, backgroundThrottling off):
 * оно открывает устройство ОДИН раз (WASAPI/Chromium), конвертирует поток в Int16
 * mono 16 кГц и порциями по 100 мс отправляет в main через MessagePort.
 *
 * Надёжность (уроки EXE 1.3.1 — «таймаут открытия микрофона 15 с» у пользователя):
 *  - устаревший deviceId из БД больше не может зависнуть: список устройств
 *    проверяется ДО getUserMedia, неизвестный id молча отбрасывается;
 *  - getUserMedia под таймаутом 8 с: зависание → повтор с минимальными
 *    constraints {audio:true}; второй таймаут → повтор на устройстве по умолчанию;
 *  - AudioWorklet под таймаутом: не загрузился → фолбэк на ScriptProcessorNode
 *    (deprecated, но работает везде и не требует загрузки blob-модуля);
 *  - каждый этап репортится в main ('stage') и попадает в avc-main.log —
 *    если у пользователя что-то зависнет, в журнале будет ВИДНО где;
 *  - did-fail-load/did-finish-load/консольные ошибки capture-окна фейлят старт
 *    быстро и с настоящей причиной, а не немым 15-секундным таймаутом.
 *
 * Микрофон НЕ открывается на каждую команду (§13/§14): окно живёт, пока включено
 * голосовое управление. Наблюдение за устройствами (enumerateDevices раз в 3 с):
 * смена/отключение устройства сообщаются в SttService (§31).
 *
 * Безопасность: окно грузит data:-страницу без сети; contextIsolation; preload
 * отдаёт ТОЛЬКО MessagePort; доступ к media разрешён main.cjs только для наших окон.
 */
const { BrowserWindow, MessageChannelMain, session } = require('electron')
const path = require('path')

let permissionHooked = false

function hookMediaPermissions() {
  if (permissionHooked) return
  permissionHooked = true
  try {
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      if (permission === 'media') {
        // Разрешаем только собственным окнам приложения (capture + главное)
        callback(true)
        return
      }
      callback(false)
    })
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')
  } catch {
    /* старые версии API — не критично */
  }
}

/** Инлайн-страница захвата: getUserMedia → AudioWorklet (или ScriptProcessor) → MessagePort */

function captureWorkletCode() {
  return `
class AvcCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.size = 1600 // 100 мс @ 16 кГц
    this.buf = new Float32Array(this.size)
    this.fill = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.fill++] = ch[i]
      if (this.fill === this.size) {
        const out = new Int16Array(this.size)
        for (let j = 0; j < this.size; j++) {
          const v = Math.max(-1, Math.min(1, this.buf[j]))
          out[j] = v < 0 ? v * 0x8000 : v * 0x7fff
        }
        this.port.postMessage({ type: 'frame', sampleRate: 16000, buffer: out.buffer }, [out.buffer])
        this.fill = 0
      }
    }
    return true
  }
}
registerProcessor('avc-capture', AvcCapture)
`
}

/** СЫРОЙ HTML capture-страницы — для раздачи с локального bridge (secure context) */
function capturePageHtml() {
  const worklet = captureWorkletCode()
  const page = `<!doctype html><html><body><script>
try { console.log('[mic-page] script top, avcMic=', typeof window.avcMic) } catch (e) {}
window.onerror = function (m) { try { console.log('[mic-page] onerror: ' + m) } catch (e) {} }
const workletCode = ${JSON.stringify(worklet)}
let stream = null
let ctx = null
let node = null
let watchTimer = null
let activeDeviceId = ''
let framesSent = 0

// Отправка через мост preload (MessagePort не пересекает contextBridge — см. mic-preload.cjs)
function send(msg) { try { window.avcMic.send(msg) } catch (e) {} }
function stage(name, detail) { send({ type: 'stage', stage: name, detail: detail || '' }) }

async function listMics() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices()
    return devs.filter(d => d.kind === 'audioinput').map(d => ({ deviceId: d.deviceId, label: d.label || 'Микрофон' }))
  } catch (e) { return [] }
}

/** getUserMedia под таймаутом: Chromium может висеть молча (битый exact-id, драйвер) */
function gumWithTimeout(constraints, ms) {
  return new Promise((resolve, reject) => {
    let done = false
    const t = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error('getUserMedia не ответил за ' + ms + ' мс'))
    }, ms)
    navigator.mediaDevices.getUserMedia(constraints).then(
      (s) => { if (done) { s.getTracks().forEach(x => x.stop()); return } done = true; clearTimeout(t); resolve(s) },
      (e) => { if (done) return; done = true; clearTimeout(t); reject(e) },
    )
  })
}

async function openStream(cfg) {
  const known = (await listMics()).map(d => d.deviceId)
  const idOk = cfg.deviceId && known.indexOf(cfg.deviceId) >= 0
  if (cfg.deviceId && !idOk) {
    stage('stale-device', 'deviceId из настроек отсутствует в системе — использую микрофон по умолчанию')
  }

  const attempts = []
  if (cfg.deviceId && idOk) {
    attempts.push({ name: 'exact', audio: { channelCount: 1, echoCancellation: !!cfg.echoCancellation, noiseSuppression: !!cfg.noiseSuppression, autoGainControl: !!cfg.autoGainControl, deviceId: { exact: cfg.deviceId } } })
  }
  attempts.push({ name: 'default+processing', audio: { channelCount: 1, echoCancellation: !!cfg.echoCancellation, noiseSuppression: !!cfg.noiseSuppression, autoGainControl: !!cfg.autoGainControl } })
  attempts.push({ name: 'minimal', audio: true })

  let lastErr = null
  for (const a of attempts) {
    try {
      stage('gum', a.name)
      const s = await gumWithTimeout({ audio: a.audio }, 8000)
      stage('gum-ok', a.name)
      return { stream: s, via: a.name }
    } catch (e) {
      lastErr = e
      stage('gum-fail', a.name + ': ' + String((e && e.message) || e))
    }
  }
  throw lastErr || new Error('getUserMedia не удался')
}

/** Подключение источника к контексту: AudioWorklet, при отказе — ScriptProcessor */
async function connectCapture(ctxLocal, stream, onChunk) {
  const src = ctxLocal.createMediaStreamSource(stream)
  try {
    stage('worklet', 'load')
    const blob = new Blob([workletCode], { type: 'application/javascript' })
    await Promise.race([
      ctxLocal.audioWorklet.addModule(URL.createObjectURL(blob)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('addModule не ответил за 5000 мс')), 5000)),
    ])
    const wnode = new AudioWorkletNode(ctxLocal, 'avc-capture')
    wnode.port.onmessage = (e) => onChunk(e.data)
    src.connect(wnode)
    stage('worklet-ok', '')
    return
  } catch (e) {
    stage('worklet-fail', String((e && e.message) || e) + ' — фолбэк на ScriptProcessor')
  }
  // Фолбэк: ScriptProcessorNode (deprecated, но работает всегда и без blob-модуля)
  const sp = ctxLocal.createScriptProcessor(1600, 1, 1)
  let buf = new Float32Array(0)
  sp.onaudioprocess = (e) => {
    const ch = e.inputBuffer.getChannelData(0)
    const merged = new Float32Array(buf.length + ch.length)
    merged.set(buf, 0)
    merged.set(ch, buf.length)
    const whole = Math.floor(merged.length / 1600) * 1600
    for (let off = 0; off + 1600 <= whole; off += 1600) {
      const slice = merged.subarray(off, off + 1600)
      const out = new Int16Array(1600)
      for (let j = 0; j < 1600; j++) {
        const v = Math.max(-1, Math.min(1, slice[j]))
        out[j] = v < 0 ? v * 0x8000 : v * 0x7fff
      }
      onChunk({ type: 'frame', sampleRate: 16000, buffer: out.buffer })
    }
    buf = merged.slice(whole)
  }
  src.connect(sp)
  // пустой destination — иначе ScriptProcessor в скрытом окне не тикает
  const sink = ctxLocal.createGain()
  sink.gain.value = 0
  sp.connect(sink)
  sink.connect(ctxLocal.destination)
  stage('sp-ok', 'ScriptProcessor активен')
}
async function start(cfg) {
  try {
    const { stream: s } = await openStream(cfg)
    stream = s
    const track = stream.getAudioTracks()[0]
    activeDeviceId = track && track.getSettings ? (track.getSettings().deviceId || '') : ''
    const settings = (track && track.getSettings) ? track.getSettings() : {}
    stage('ctx', 'create')
    try {
      ctx = new AudioContext({ sampleRate: 16000 })
    } catch (e) {
      ctx = new AudioContext()
      stage('ctx-fallback', 'sampleRate не поддержан, контекст ' + ctx.sampleRate)
    }
    await connectCapture(ctx, stream, (data) => {
      framesSent++
      send(data, data && data.buffer ? [data.buffer] : undefined)
    })
    track.addEventListener('ended', () => send({ type: 'ended', reason: 'track ended' }))
    send({ type: 'started', deviceId: activeDeviceId, label: (track && track.label) || '', contextRate: ctx.sampleRate, trackRate: settings.sampleRate || 0 })
    send({ type: 'devices', devices: await listMics() })
    // наблюдение за устройствами (§13: отключение/смена дефолтного)
    let last = JSON.stringify((await listMics()).map(d => d.deviceId).sort())
    watchTimer = setInterval(async () => {
      const list = await listMics()
      const key = JSON.stringify(list.map(d => d.deviceId).sort())
      if (key !== last) { last = key; send({ type: 'devices', devices: list }) }
      const alive = list.some(d => d.deviceId === activeDeviceId)
      if (!alive && stream) send({ type: 'ended', reason: 'device removed' })
    }, 3000)
  } catch (e) {
    send({ type: 'error', message: String((e && e.message) || e) })
  }
}

function stopAll() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null }
  if (node) { try { node.disconnect() } catch (e) {} node = null }
  if (ctx) { try { ctx.close() } catch (e) {} ctx = null }
  activeDeviceId = ''
}

window.avcMic.onMessage((m) => {
  const msg = m || {}
  if (msg.type === 'start') start(msg)
  else if (msg.type === 'stop') { stopAll(); send({ type: 'stopped' }) }
  else if (msg.type === 'enumerate') send({ type: 'devices', devices: null, needList: true })
})
window.avcMic.onPortReady(() => {
  send({ type: 'ready' })
})
<\/script></body></html>`
  return page
}

/** data:-URL фолбэк (без secure context — getUserMedia недоступен; только для тестов) */
function captureHtml() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(capturePageHtml())}`
}

class MicService {
  constructor() {
    this.win = null
    this.port = null
    this.handle = null
    /** Колбэк журнала этапов (ставит SttService/main для avc-main.log) */
    this.onLog = null
    /**
     * URL capture-страницы (http://127.0.0.1:<bridgePort>/mic-capture).
     * localhost — secure context: только там существует navigator.mediaDevices.
     * На data:-странице getUserMedia недоступен (молча undefined) — потому раздаём
     * страницу с локального bridge. Если URL не задан — фолбэк на data:-URL.
     */
    this.captureUrl = null
  }

  log(msg) {
    try {
      if (this.onLog) this.onLog(msg)
    } catch {
      /* журнал не должен ронять захват */
    }
  }

  /**
   * createCapture({deviceId, sampleRate, echoCancellation, noiseSuppression,
   *   autoGainControl, onFrame(int16Buffer, sampleRate), onDevices(list),
   *   onEnded(reason), onError(message)}) → Promise<{stop(), deviceId, label}>
   */
  createCapture(opts) {
    hookMediaPermissions()
    return new Promise((resolve, reject) => {
      try {
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
        win.setBackgroundThrottling(false)
        this.win = win

        const { port1, port2 } = new MessageChannelMain()
        this.port = port1

        let settled = false
        let startSent = false
        const sendStart = () => {
          if (startSent) return
          startSent = true
          try {
            port1.postMessage({
              type: 'start',
              deviceId: opts.deviceId || '',
              echoCancellation: !!opts.echoCancellation,
              noiseSuppression: !!opts.noiseSuppression,
              autoGainControl: !!opts.autoGainControl,
            })
          } catch (e) { fail(e.message) }
        }
        const fail = (err) => {
          if (settled) return
          settled = true
          clearTimeout(startTimer)
          try { win.destroy() } catch { /* уже */ }
          try { port1.close() } catch { /* уже */ }
          this.win = null
          this.port = null
          reject(new Error(err))
        }
        const okStart = (info) => {
          if (settled) return
          settled = true
          clearTimeout(startTimer)
          const handle = {
            stop: () => {
              try {
                if (port1) port1.postMessage({ type: 'stop' })
              } catch { /* уже закрыт */ }
              setTimeout(() => {
                try { win.destroy() } catch { /* уже */ }
                try { port1.close() } catch { /* уже */ }
              }, 250)
              if (this.win === win) {
                this.win = null
                this.port = null
                this.handle = null
              }
            },
            deviceId: info.deviceId || '',
            label: info.label || '',
          }
          this.handle = handle
          resolve(handle)
        }

        port1.on('message', (e) => {
          const m = e.data || {}
          switch (m.type) {
            case 'frame':
              try {
                if (opts.onFrame && m.buffer) opts.onFrame(Buffer.from(m.buffer), m.sampleRate || 16000)
              } catch { /* обработчик сам защищается */ }
              break
            case 'ready':
              sendStart()
              break
            case 'stage':
              this.log(`mic: ${m.stage}${m.detail ? ` — ${m.detail}` : ''}`)
              break
            case 'started':
              okStart(m)
              break
            case 'devices':
              if (opts.onDevices && m.devices) opts.onDevices(m.devices)
              break
            case 'ended':
              if (opts.onEnded) opts.onEnded(m.reason || 'unknown')
              break
            case 'error':
              if (!settled) fail(m.message || 'ошибка захвата микрофона')
              else if (opts.onError) opts.onError(m.message)
              break
            case 'stopped':
            default:
              break
          }
        })
        port1.start()

        win.webContents.on('did-finish-load', () => {
          try {
            win.webContents.postMessage('mic-port', null, [port2])
          } catch (e) {
            fail(`не удалось передать порт: ${e.message}`)
          }
        })
        // страница capture не загрузилась — раньше это висело до немого 15-с таймаута
        win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
          if (isMain) fail(`capture-страница не загрузилась: ${code} ${desc}`)
        })
        win.webContents.on('console-message', (_e, level, message) => {
          if (level >= 2) this.log(`mic-page: ${message}`)
        })
        win.webContents.on('render-process-gone', (_e, details) => fail(`capture-процесс упал (${details && details.reason})`))
        win.on('closed', () => {
          if (!settled) fail('capture-окно закрыто')
        })

        // Общий таймаут старта 15 с (страховка; обычные зависания фейлятся раньше
        // — поэтапно: порт 5 с внутри страницы, getUserMedia 8 с, worklet 5 с)
        const startTimer = setTimeout(() => fail('таймаут открытия микрофона (15 с)'), 15000)
        if (startTimer.unref) startTimer.unref()

        win.loadURL(this.captureUrl || captureHtml())
      } catch (e) {
        reject(e)
      }
    })
  }
}

module.exports = { MicService, captureHtml, capturePageHtml }
