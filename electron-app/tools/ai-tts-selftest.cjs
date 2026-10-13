/**
 * ai-tts-selftest — РЕАЛЬНАЯ проверка локального TTS (спецификация §22–§29):
 *   1. Загрузка VITS ru-голоса (irina), warm-up, метрики.
 *   2. Синтез стандартных ответов приложения (шаблоны §88): короткие фразы, числа, названия.
 *   3. Кэш: повторный синтез той же фразы → cache-hit (§24).
 *   4. ЗАМКНУТЫЙ КОНТУР: TTS → WAV → STT должно распознать фразу обратно
 *      (полный локальный цикл без интернета, §3/§111).
 *   5. Регресс: после TTS в процессе STT и LLM продолжают работать.
 * Запуск: node tools/ai-tts-selftest.cjs
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { TTSService } = require('../ai/tts-service.cjs')
const { STTService, readWavAsFloat32 } = require('../ai/stt-service.cjs')

const MODELS_DIR = process.env.AVC_MODELS_DIR || path.join(__dirname, '..', 'models')

const PHRASES = [
  'Следующая серия.',
  'Пауза.',
  'Включаю шестую серию.',
  'Добавил в планы.',
  'Оценка восемь.',
  'Не удалось найти такую серию.',
]

async function main() {
  const report = { ranAt: new Date().toISOString(), tests: [] }
  const step = (name, status, detail) => {
    report.tests.push({ name, status, detail })
    console.log(`[${status}] ${name} — ${detail}`)
  }

  // 1) инициализация
  const tts = new TTSService({ modelsDir: MODELS_DIR })
  await tts.initialize()
  step('initialize', tts.isReady() ? 'PASS' : 'FAIL', `state=${tts.state}, modelLoadMs=${tts.metrics.modelLoadMs}, warmupMs=${tts.metrics.warmupMs}, err=${tts.error || '—'}`)
  if (!tts.isReady()) return process.exit(1)

  // 2) синтез шаблонов
  const outDir = path.join(MODELS_DIR, 'tts-cache')
  let okCount = 0
  for (const phrase of PHRASES) {
    try {
      const r = await tts.synthesize(phrase)
      const size = fs.existsSync(r.file) ? fs.statSync(r.file).size : 0
      if (r.file && size > 1000) okCount++
      console.log(`  [${size > 1000 ? 'PASS' : 'FAIL'}] «${phrase}» → ${path.basename(r.file)} (${size} байт, ${r.ms} мс)`)
    } catch (e) {
      console.log(`  [FAIL] «${phrase}» → ${e.message}`)
    }
  }
  step('synthesis', okCount === PHRASES.length ? 'PASS' : 'FAIL', `${okCount}/${PHRASES.length} фраз синтезированы в WAV`)

  // 3) кэш (§24)
  const again = await tts.synthesize(PHRASES[0])
  step('cache-hit', again.cached ? 'PASS' : 'FAIL', `повторный синтез «${PHRASES[0]}» → ${again.cached ? 'из кэша (0 мс)' : 'заново (' + again.ms + ' мс)'}`)

  // 4) ЗАМКНУТЫЙ КОНТУР: TTS → STT (§3, §111)
  // Ресемпл 22050→8000: FIR low-pass (анти-алиасинг) + линейная интерполяция,
  // + отступы тишины по краям (VITS-файл кончается резко — фичам нужен хвост).
  // В живом приложении это не нужно: микрофон течёт непрерывно (16к→8к децимация в _feedStt).
  function firLowpass(src, rate, cutoff = 3400, taps = 63) {
    const fc = cutoff / (rate / 2)
    const h = new Float32Array(taps)
    let sum = 0
    const M = taps - 1
    for (let i = 0; i < taps; i++) {
      const x = i - M / 2
      const s = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / M)
      h[i] = s * w
      sum += h[i]
    }
    for (let i = 0; i < taps; i++) h[i] /= sum
    const out = new Float32Array(src.length)
    for (let i = 0; i < src.length; i++) {
      let acc = 0
      for (let j = 0; j < taps; j++) {
        const idx = i - j + (taps >> 1)
        if (idx >= 0 && idx < src.length) acc += src[idx] * h[j]
      }
      out[i] = acc
    }
    return out
  }

  function resampleHQ(src, from, to) {
    const filtered = firLowpass(src, from, Math.min(3400, to / 2 - 100))
    const n = Math.floor(src.length * to / from)
    const out = new Float32Array(n)
    const step = from / to
    for (let i = 0; i < n; i++) {
      const t = i * step
      const i0 = Math.floor(t)
      const frac = t - i0
      const a = filtered[Math.min(i0, filtered.length - 1)]
      const b = filtered[Math.min(i0 + 1, filtered.length - 1)]
      out[i] = a + (b - a) * frac
    }
    return out
  }

  const stt = new STTService({ modelsDir: MODELS_DIR })
  await stt.initialize()
  if (!stt.isReady()) {
    step('tts-stt-loop', 'FAIL', `STT не инициализировался: ${stt.error}`)
  } else {
    const phrase = 'Следующая серия.'
    const wav = await tts.synthesize(phrase, { noCache: true })
    const info = readWavAsFloat32(wav.file)
    const s8 = resampleHQ(info.samples, info.sampleRate, 8000)
    const head = new Float32Array(Math.round(8000 * 0.4))
    const tail = new Float32Array(Math.round(8000 * 0.8))
    const padded = new Float32Array(head.length + s8.length + tail.length)
    padded.set(head, 0)
    padded.set(s8, head.length)
    padded.set(tail, head.length + s8.length)
    const stream = stt._recognizer.createStream()
    stream.acceptWaveform({ sampleRate: 8000, samples: padded })
    stream.inputFinished()
    while (stt._recognizer.isReady(stream)) stt._recognizer.decode(stream)
    const recognized = stt._recognizer.getResult(stream).text.trim().toLowerCase()
    const ok = recognized.includes('следующ') && recognized.includes('сер')
    step('tts-stt-loop', ok ? 'PASS' : 'FAIL', `TTS: «${phrase}» (${info.sampleRate} Гц → 8000 Гц, FIR+pad) → STT: «${recognized}»`)
  }

  // 5) регресс: LLM в том же процессе (D-регресс после TTS) — лёгкий прогон латентности без генерации
  let llmState = 'не запускался'
  try {
    const { LLMService } = require('../ai/llm-service.cjs')
    const llm = new LLMService({ modelsDir: MODELS_DIR })
    await llm.initialize()
    llmState = llm.state
    if (llm.isReady()) {
      const r = await llm.route('стоп', { timeoutMs: Number(process.env.AVC_LLM_TEST_TIMEOUT || 60000) })
      step('regression-llm-with-tts', r && r.commands && r.commands[0].type ? 'PASS' : 'FAIL', `после TTS: LLM ${llmState}, «стоп» → ${r ? r.commands[0].type : 'null'} (${r ? r.ms : 0} мс)`)
    } else {
      step('regression-llm-with-tts', 'FAIL', `LLM: ${llmState}, err=${llm.error}`)
    }
  } catch (e) {
    step('regression-llm-with-tts', 'FAIL', e.message)
  }

  report.metrics = { tts: tts.getMetrics() }
  fs.writeFileSync(path.join(__dirname, 'ai-tts-selftest-report.json'), JSON.stringify(report, null, 2))
  const failed = report.tests.filter((t) => t.status === 'FAIL').length
  console.log(`\nИтог: ${report.tests.length - failed}/${report.tests.length} PASS; exit=${failed ? 1 : 0}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('tts-selftest crashed:', e)
  process.exit(1)
})
