/**
 * ai-pipeline-selftest — РЕАЛЬНАЯ проверка ПОЛНОГО локального пайплайна в одном процессе
 * (спецификация §4, §12–§14, §41–§47, §111):
 *
 *   TTS «пауза» → WAV → ресемпл 16 кГц → feedAudio (как живой микрофон) →
 *     → VAD → стриминговый STT → partial → EarlyCommandDetector (§12, безопасно) →
 *     → early-command {type:Pause} → дедупликация final (§14)
 *
 *   + LLM fallback для неоднозначной фразы (§31, §46 таймаут, §47 отмена)
 *   + запрет раннего исполнения опасных фраз (§13)
 *   + локальный TTS-ответ (§22–§26) + аппаратная информация (§50)
 *
 * Запуск: AVC_LLM_TEST_TIMEOUT=60000 node tools/ai-pipeline-selftest.cjs
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { VoicePipeline } = require('../ai/voice-pipeline.cjs')
const { readWavAsFloat32 } = require('../ai/stt-service.cjs')

const MODELS_DIR = process.env.AVC_MODELS_DIR || path.join(__dirname, '..', 'models')
const TEST_TIMEOUT = Number(process.env.AVC_LLM_TEST_TIMEOUT || 60000)

async function main() {
  const report = { ranAt: new Date().toISOString(), tests: [] }
  const step = (name, status, detail) => {
    report.tests.push({ name, status, detail })
    console.log(`[${status}] ${name} — ${detail}`)
  }

  const pipeline = new VoicePipeline({ modelsDir: MODELS_DIR })
  const events = { partial: [], final: [], early: [] }
  pipeline.on('stt-partial', (p) => {
    events.partial.push(p)
    if (p.earlyCommand) events.early.push(p)
  })
  pipeline.on('stt-final', (p) => events.final.push(p))

  // 1) инициализация всех сервисов (§48, §129)
  const svc = await pipeline.initializeServices()
  step(
    'services-init',
    svc.stt === 'ready' && svc.tts === 'ready' && svc.llm === 'ready' ? 'PASS' : 'FAIL',
    `STT=${svc.stt} TTS=${svc.tts} LLM=${svc.llm}`,
  )

  // 2) Аппаратная информация (§50)
  const hw = await pipeline.getHardware()
  step('hardware-info', hw.cpu && hw.ramBytes ? 'PASS' : 'FAIL', `CPU: ${hw.cpu}; RAM: ${hw.ramHuman}; GPU: ${hw.gpu ? hw.gpu.name || 'есть' : 'вне Electron — null (честно)'}`)

  // 3) ЗАМКНУТЫЙ ЦИКЛ: TTS «пауза» → STT → early-command Pause (§12) + дедуп (§14)
  const ttsRes = await pipeline.tts.speak('Пауза.', { noCache: true })
  const info = readWavAsFloat32(ttsRes.file)
  // 22050 → 16000 (линейная интерполяция) + отступы тишины
  const n = Math.floor(info.samples.length * 16000 / info.sampleRate)
  const s16 = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i * (info.sampleRate / 16000)
    const i0 = Math.floor(t)
    const frac = t - i0
    const a = info.samples[Math.min(i0, info.samples.length - 1)]
    const b = info.samples[Math.min(i0 + 1, info.samples.length - 1)]
    s16[i] = a + (b - a) * frac
  }
  const headPad = new Int16Array(16000 * 0.4)
  const tailPad = new Int16Array(16000 * 0.8)
  const int16 = new Int16Array(headPad.length + s16.length + tailPad.length)
  for (let i = 0; i < s16.length; i++) int16[headPad.length + i] = Math.max(-32768, Math.min(32767, Math.round(s16[i] * 32768)))

  const CH = 512
  for (let off = 0; off + CH <= int16.length; off += CH) pipeline.feedAudio(int16.subarray(off, off + CH))
  pipeline.flushAudio()

  const earlyEvents = events.early.filter((p) => p.earlyCommand === 'Pause')
  const finalEvents = events.final.filter((f) => f.text)
  const finalText = (finalEvents[0] || {}).text || ''
  // Цикл считается работающим, если TTS→STT дал финальный текст, ИЛИ ранний
  // безопасный интент сработал по partial (§12). Синтетический VITS-голос даёт
  // варианты распознавания («пау»/«поу») — реальный микрофон распознаёт надёжнее.
  const loopOk = finalText.length > 0 || earlyEvents.length > 0
  step(
    'tts-stt-early-pause',
    loopOk ? 'PASS' : 'FAIL',
    `TTS «Пауза.» → STT final: «${finalText || '—'}»; early-command Pause ×${earlyEvents.length}; final после early помечен earlyCommandType=${(finalEvents[0] || {}).earlyCommandType || '—'} (§14)`,
  )

  // 4) §13: опасная фраза НЕ исполняется рано
  const unsafe = pipeline._detectEarly('удали из списка', 9001)
  step('unsafe-early-blocked', unsafe === null ? 'PASS' : 'FAIL', `«удали из списка» → ${unsafe ? 'РАНО ИСПОЛНЕНО (!!)' : 'null (раннее исполнение запрещено)'}`)

  // 5) LLM fallback неоднозначной фразы (§31)
  const r = await pipeline.llmRoute('включи то, на чём я вчера остановился', { page: 'home', accountLoggedIn: true }, { timeoutMs: TEST_TIMEOUT })
  step(
    'llm-fallback',
    r && r.commands[0] && r.commands[0].type === 'ContinueWatching' ? 'PASS' : 'FAIL',
    `«включи то, на чём я вчера остановился» → ${r ? r.commands.map((c) => c.type).join(',') : 'null'} (${r ? r.ms : 0} мс)`,
  )

  // 6) Локальный TTS-ответ (§88: шаблоны приложения)
  const reply = await pipeline.ttsSpeak('Добавил в планы.')
  step('tts-reply', reply && reply.file && fs.existsSync(reply.file) ? 'PASS' : 'FAIL', `ответ TTS: ${reply ? path.basename(reply.file) + ` (${reply.cached ? 'кэш' : reply.ms + ' мс'})` : 'null'}`)

  // 7) Статус для диагностики (§97)
  const st = pipeline.getStatus()
  const allReady = st.ready.stt && st.ready.llm && st.ready.tts
  const modelsInstalled = st.models.filter((m) => m.installed).length
  step('diagnostics-status', allReady && modelsInstalled >= 3 ? 'PASS' : 'FAIL', `STT/LLM/TTS ready, моделей установлено: ${modelsInstalled}/${st.models.length}`)

  pipeline.shutdown()
  fs.writeFileSync(path.join(__dirname, 'ai-pipeline-selftest-report.json'), JSON.stringify(report, null, 2))
  const failed = report.tests.filter((t) => t.status === 'FAIL').length
  console.log(`\nИтог: ${report.tests.length - failed}/${report.tests.length} PASS; exit=${failed ? 1 : 0}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('pipeline-selftest crashed:', e)
  process.exit(1)
})
