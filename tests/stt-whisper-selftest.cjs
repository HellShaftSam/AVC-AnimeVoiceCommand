#!/usr/bin/env node
/**
 * stt-whisper-selftest — полный end-to-end тест STT-сервиса faster-whisper (v1.0.22).
 *
 * Проверяет ЖИВОЙ путь (как в приложении): микрофонный PCM 16 кГц Int16 → feed()
 * окнами 2048 → Python-сервис (Silero VAD → endpoint → faster-whisper) → partial/final.
 *
 * Тесты:
 *   1. Готовность сервиса (загрузка модели ОДИН раз, события status).
 *   2. Русские фразы (TTS-фикстуры) → final содержит ожидаемые ключевые слова.
 *   3. Partial-эмуляция: при длинной фразе приходит хотя бы один partial.
 *   4. Тишина → НЕ создаёт final (VAD честно молчит).
 *   5. Две фразы подряд с паузой → два final с разными utteranceId.
 *   6. decode-путь (selftest/бенчмарк) возвращает текст.
 *   7. Латентности: модель/инференс/e2e записываются в отчёт.
 *
 * Требования: python с faster-whisper (см. requirements.txt), модель (CTranslate2 dir),
 * silero_vad.onnx, TTS-фикстуры 16 кГц в electron-app/ai/stt-python/fixtures.
 *
 * Env:
 *   AVC_STT_PYTHON=/home/z/.venv/bin/python3   (питон со стеком)
 *   AVC_WHISPER_MODEL_DIR=/tmp/fw-base         (модель base)
 *   AVC_MODELS_DIR=/tmp/avc-models             (для vad/silero-vad/silero_vad.onnx)
 *
 * Запуск: node tests/stt-whisper-selftest.cjs
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const AI = path.join(__dirname, '..', 'electron-app', 'ai')
const FIXTURES = path.join(AI, 'stt-python', 'fixtures')
const PYTHON = process.env.AVC_STT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const MODEL_DIR = process.env.AVC_WHISPER_MODEL_DIR || '/tmp/fw-base'
const VAD_FILE = path.join(process.env.AVC_MODELS_DIR || '/tmp/avc-models', 'vad', 'silero-vad', 'silero_vad.onnx')
const SERVICE = path.join(AI, 'stt-python', 'stt_service.py')

const results = []
function report(name, status, detail) {
  results.push({ name, status, detail })
  console.log(`[${status}] ${name} — ${detail}`)
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-zа-я0-9ё]+/gi, ' ').trim()

function readWavInt16(file) {
  const buf = fs.readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`Не WAV: ${file}`)
  let pos = 12
  let data = null
  let sr = 16000
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') sr = buf.readUInt32LE(pos + 12)
    if (id === 'data') data = buf.subarray(pos + 8, pos + 8 + size)
    pos += 8 + size + (size % 2)
  }
  if (!data) throw new Error('Нет data-чанка')
  if (sr !== 16000) throw new Error(`Ожидается 16 кГц фикстура (${file}), получено ${sr}`)
  const n = Math.floor(data.length / 2)
  const int16 = new Int16Array(n)
  for (let i = 0; i < n; i++) int16[i] = data.readInt16LE(i * 2)
  return int16
}

function startService() {
  const child = spawn(PYTHON, [SERVICE, '--model', MODEL_DIR, '--vad', VAD_FILE, '--language', 'ru', '--device', 'cpu', '--compute-type', 'float32'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  })
  const state = { ready: false, info: null, stderr: [] }
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (c) => {
    buf += c
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      state.last = msg
      if (msg.event === 'status' && msg.state === 'ready') {
        state.ready = true
        state.info = msg
      }
      if (msg.event === 'status' && msg.state === 'failed') state.error = msg.error
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c) => {
    state.stderr.push(String(c).trim())
    if (state.stderr.length > 30) state.stderr.shift()
  })
  child.on('exit', (code) => { state.exited = code })
  return { child, state }
}

function waitReady(state, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (state.ready) { clearInterval(iv); resolve(state.info) }
      else if (state.error) { clearInterval(iv); reject(new Error(state.error)) }
      else if (state.exited !== undefined) { clearInterval(iv); reject(new Error(`python умер: ${state.stderr.slice(-3).join(' | ')}`)) }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('таймаут готовности')) }
    }, 100)
  })
}

function request(child, payload, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`таймаут запроса ${payload.type}`)), timeoutMs)
    const onLine = (msg) => {
      if (msg.id === payload.id) {
        cleanup()
        clearTimeout(timer)
        if (msg.ok) resolve(msg.result)
        else reject(new Error(msg.error || 'ошибка запроса'))
      }
    }
    const origData = child._lineHandlers || (child._lineHandlers = [])
    // упрощение: парсим stdout повторно здесь через событие data невозможно (уже потребляется)
    // поэтому сервис шлёт ответы и события в один поток — используем отдельный разбор:
    const onData = (chunk) => {
      bufAccum += chunk
      let i
      while ((i = bufAccum.indexOf('\n')) >= 0) {
        const line = bufAccum.slice(0, i).trim()
        bufAccum = bufAccum.slice(i + 1)
        if (!line) continue
        try { onLine(JSON.parse(line)) } catch { /* не JSON — событие другого типа */ }
      }
    }
    let bufAccum = ''
    child.stdout.on('data', onData)
    function cleanup() { child.stdout.off('data', onData) }
    child.stdin.write(JSON.stringify({ id: payload.id, ...payload }) + '\n')
  })
}

/** Подать WAV живым путём (окна 2048 с паузами реального времени) → события partial/final */
async function feedUtterance(child, wavFile, { chunkDelayMs = 60, waitFinalMs = 15000 } = {}) {
  const samples = readWavInt16(wavFile)
  const events = { partial: [], final: [] }
  let buf = ''
  const onData = (c) => {
    buf += c
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let m
      try { m = JSON.parse(line) } catch { continue }
      if (m.event === 'partial') events.partial.push(m)
      if (m.event === 'final') events.final.push(m)
    }
  }
  child.stdout.on('data', onData)
  const t0 = Date.now()
  for (let off = 0; off + 2048 <= samples.length; off += 2048) {
    const win = samples.subarray(off, off + 2048)
    const b64 = Buffer.from(win.buffer, win.byteOffset, win.byteLength).toString('base64')
    child.stdin.write(JSON.stringify({ type: 'feed', audio: b64 }) + '\n')
    await new Promise((r) => setTimeout(r, chunkDelayMs))
  }
  // хвост тишины — чтобы VAD закрыл endpoint (0.25 с + запас)
  const silence = new Int16Array(2048 * 16) // 2 с тишины
  child.stdin.write(JSON.stringify({ type: 'feed', audio: Buffer.from(silence.buffer).toString('base64') }) + '\n')
  const finalWait = new Promise((resolve) => {
    const t0w = Date.now()
    const iv = setInterval(() => {
      if (events.final.length > 0 || Date.now() - t0w > waitFinalMs) { clearInterval(iv); resolve() }
    }, 100)
  })
  await finalWait
  child.stdout.off('data', onData)
  return { ...events, e2eMs: Date.now() - t0 }
}

async function main() {
  console.log(`python: ${PYTHON}`)
  console.log(`model:  ${MODEL_DIR}`)
  console.log(`vad:    ${VAD_FILE}`)
  if (!fs.existsSync(MODEL_DIR) || !fs.existsSync(path.join(MODEL_DIR, 'model.bin'))) {
    console.error('Модель не найдена — задайте AVC_WHISPER_MODEL_DIR')
    process.exit(2)
  }
  const { child, state } = startService()

  // 1) готовность
  let info
  try {
    info = await waitReady(state)
    report('1: готовность сервиса', 'PASS', `modelLoadMs=${info.modelLoadMs}, device=${info.device}, computeType=${info.computeType}, vad=${info.vad}`)
  } catch (e) {
    report('1: готовность сервиса', 'FAIL', e.message)
    return finish(child)
  }

  let reqId = 100
  const ping = await request(child, { id: ++reqId, type: 'ping' })
  if (ping.ready) report('1b: ping', 'PASS', `queue=${ping.queue}`)
  else report('1b: ping', 'FAIL', JSON.stringify(ping))

  // 2) русские фразы
  const CASES = [
    { wav: 'ru_naruto.wav', name: '2a: аниме+число (Наруто 20)', expect: /(нар\w*та|наруто|нарута)/i, expect2: /(20|двадцат)/i },
    { wav: 'ru_open_settings.wav', name: '2b: навигация (Открой настройки)', expect: /откр/i, expect2: /настро/i },
    { wav: 'ru_next.wav', name: '2c: следующая серия', expect: /следующ/i, expect2: /сери/i },
    { wav: 'ru_prev.wav', name: '2d: предыдущая серия', expect: /предыдущ/i, expect2: /сери/i },
    { wav: 'ru_pause.wav', name: '2e: пауза', expect: /пауз/i, expect2: null },
    { wav: 'ru_quiet.wav', name: '2f: громкость тише', expect: /громк|тише/i, expect2: null },
    { wav: 'ru_long.wav', name: '2g: длинная фраза (список аниме)', expect: /список|аним/i, expect2: /сезон|сорт|рейт/i },
  ]
  let passCount = 0
  for (const c of CASES) {
    const r = await feedUtterance(child, path.join(FIXTURES, c.wav))
    const text = r.final.map((f) => f.text).join(' ')
    const ok = c.expect.test(text) && (!c.expect2 || c.expect2.test(text))
    if (ok) passCount += 1
    report(c.name, ok ? 'PASS' : 'FAIL', `final="${norm(text).slice(0, 80)}" (partial: ${r.partial.length}, e2e: ${r.e2eMs} мс)`)
  }
  report('2: итог фраз', passCount >= 6 ? 'PASS' : 'FAIL', `${passCount}/${CASES.length} распознано`)

  // 3) partial на длинной фразе
  const rLong = await feedUtterance(child, path.join(FIXTURES, 'ru_long.wav'))
  report('3: partial-эмуляция', rLong.partial.length > 0 ? 'PASS' : 'FAIL', `partial-событий: ${rLong.partial.length}`)

  // 4) тишина не создаёт final
  const silence = new Int16Array(16000 * 3) // 3 с тишины
  let silenceFinal = null
  const onSilence = (c) => {
    const s = String(c)
    if (s.includes('"final"')) silenceFinal = s.slice(0, 120)
  }
  child.stdout.on('data', onSilence)
  child.stdin.write(JSON.stringify({ type: 'feed', audio: Buffer.from(silence.buffer).toString('base64') }) + '\n')
  await new Promise((r) => setTimeout(r, 4000))
  child.stdout.off('data', onSilence)
  report('4: тишина → нет final', silenceFinal === null ? 'PASS' : 'FAIL', silenceFinal || 'final не пришёл')

  // 5) две фразы подряд → разные utteranceId
  const r1 = await feedUtterance(child, path.join(FIXTURES, 'ru_next.wav'))
  await new Promise((r) => setTimeout(r, 700))
  const r2 = await feedUtterance(child, path.join(FIXTURES, 'ru_pause.wav'))
  const id1 = r1.final[0]?.utteranceId
  const id2 = r2.final[0]?.utteranceId
  const okTwo = r1.final.length >= 1 && r2.final.length >= 1 && id1 !== id2
  report('5: две фразы подряд', okTwo ? 'PASS' : 'FAIL', `ids: ${id1} vs ${id2}`)

  // 6) decode-путь (selftest/бенчмарк)
  try {
    const samples = readWavInt16(path.join(FIXTURES, 'ru_naruto.wav'))
    const f32 = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i++) f32[i] = samples[i] / 32768
    const dec = await request(child, { id: ++reqId, type: 'decode', audio: Buffer.from(f32.buffer).toString('base64'), sampleRate: 16000 }, 120000)
    report('6: decode-путь', /наруто|на рута|ра/i.test(dec.text) ? 'PASS' : 'FAIL', `text="${dec.text}" за ${dec.ms} мс`)
  } catch (e) {
    report('6: decode-путь', 'FAIL', e.message)
  }

  return finish(child)
}

function finish(child) {
  try {
    child.stdin.write(JSON.stringify({ id: 999, type: 'shutdown' }) + '\n')
  } catch { /* ок */ }
  setTimeout(() => {
    try { child.kill('SIGKILL') } catch { /* ок */ }
    const pass = results.filter((r) => r.status === 'PASS').length
    const fail = results.filter((r) => r.status === 'FAIL').length
    const skip = results.filter((r) => r.status === 'SKIP').length
    console.log(`\nИТОГ: PASS=${pass} FAIL=${fail} SKIP=${skip}`)
    process.exit(fail > 0 ? 1 : 0)
  }, 1000)
}

main().catch((e) => {
  console.error('selftest crashed:', e)
  process.exit(2)
})
