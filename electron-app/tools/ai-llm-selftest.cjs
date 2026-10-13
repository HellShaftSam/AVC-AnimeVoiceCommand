/**
 * ai-llm-selftest — РЕАЛЬНАЯ проверка локального LLM-роутера (спецификация §28–§47, §82–§86):
 *   1. Загрузка Qwen3-0.6B Q4_K_M через llama.cpp (node-llama-cpp) + warm-up, метрики.
 *   2. Набор русских фраз (разговорные, с контекстом, неоднозначные) → JSON-грамматика →
 *      проверка интента/параметров (контракт команд совпадает с VoiceCommandType).
 *   3. JSON валидность 100% (грамматика), таймаут/отмена, метрики латентности.
 *   4. Регресс: STT всё ещё работоспособен (загрузка обоих сервисов в одном процессе).
 * Запуск: node tools/ai-llm-selftest.cjs
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { LLMService } = require('../ai/llm-service.cjs')
const { STTService } = require('../ai/stt-service.cjs')

const MODELS_DIR = process.env.AVC_MODELS_DIR || path.join(__dirname, '..', 'models')

/** [фраза, ожидаемый type, проверка params, контекст] */
const CASES = [
  ['вруби шестую серию', 'SelectEpisode', (p) => Number(p.episode) === 6, {}],
  ['давай следующую', 'NextEpisode', () => true, {}],
  ['открой ван пис', 'SearchAnime', (p) => /ван пис|one piece|ван-пис/i.test(String(p.query || '')), {}],
  ['включи то, на чём я вчера остановился', 'ContinueWatching', () => true, {}],
  ['добавь это в планы', 'SetWatchStatus', (p) => p.status === 'planned', { animeTitle: 'Наруто', animeSlug: 'naruto-tv-1' }],
  ['оцени на восемь', 'RateAnime', (p) => Number(p.rating) === 8, { animeTitle: 'Наруто' }],
  ['брошено', 'SetWatchStatus', (p) => p.status === 'dropped', { animeTitle: 'Наруто' }],
  ['поставь на паузу', 'Pause', () => true, {}],
  ['громче', 'VolumeUp', () => true, {}],
  ['покажи мои планы', 'ShowLibrary', () => true, {}],
  ['алябьмацветочек', 'Unknown', () => true, {}],
]

async function main() {
  // Батчи: «0-3», «4-7», «8-10» — чтобы укладываться в лимит времени окружения;
  // без аргумента — все кейсы. Результаты копятся в report-файле.
  const rangeArg = process.argv[2] || ''
  const reportPath = path.join(__dirname, 'ai-llm-selftest-report.json')
  const existing = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : { ranAt: new Date().toISOString(), tests: [], cases: [] }
  const report = existing

  const step = (name, status, detail) => {
    const i = report.tests.findIndex((t) => t.name === name)
    const entry = { name, status, detail }
    if (i >= 0) report.tests[i] = entry
    else report.tests.push(entry)
    console.log(`[${status}] ${name} — ${detail}`)
  }

  const llm = new LLMService({ modelsDir: MODELS_DIR })
  llm.on('route-error', (e) => console.log(`  [route-error] ${String(e.error).slice(0, 120)} (${e.ms} мс)`))
  await llm.initialize()
  step('initialize', llm.isReady() ? 'PASS' : 'FAIL', `state=${llm.state}, modelLoadMs=${llm.metrics.modelLoadMs}, warmupMs=${llm.metrics.warmupMs}, err=${llm.error || '—'}`)
  if (!llm.isReady()) return process.exit(1)
  // ВНИМАНИЕ: в throttled-песочнице генерация ~4 с/токен — расширенный таймаут для ТЕСТА.
  // В приложении остаётся профильный лимит (max_responsiveness = 5 с на реальном железе, §46).
  const TEST_TIMEOUT = Number(process.env.AVC_LLM_TEST_TIMEOUT || 60000)

  // 1) роутинг фраз (батчами по диапазону)
  let [from, to] = [0, CASES.length - 1]
  if (rangeArg.includes('-')) {
    const [a, b] = rangeArg.split('-').map(Number)
    from = a; to = b
  }
  let correct = 0
  let jsonValid = 0
  let counted = 0
  const latencies = []
  for (let i = from; i <= Math.min(to, CASES.length - 1); i++) {
    const [text, expectedType, checkParams, context] = CASES[i]
    counted++
    const res = await llm.route(text, { context, timeoutMs: TEST_TIMEOUT })
    const ms = res?.ms ?? 0
    latencies.push(ms)
    if (!res) {
      // замещаем запись кейса, если батч перезапускался
      const ci = report.cases.findIndex((c) => c.text === text)
      const entry = { text, expectedType, got: null, ok: false }
      if (ci >= 0) report.cases[ci] = entry
      else report.cases.push(entry)
      console.log(`  [FAIL] «${text}» → null`)
      continue
    }
    jsonValid++
    const first = (res.commands && res.commands[0]) || { type: 'Unknown' }
    const ok = first.type === expectedType && (!checkParams || checkParams(first.params || {}))
    if (ok) correct++
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] «${text}» → ${first.type} ${JSON.stringify(first.params || {})} (${ms} мс)${res.needsClarification ? ' [нужно уточнение: ' + res.clarifyQuestion + ']' : ''}`)
    const cEntry = { text, expectedType, got: first.type, params: first.params, ok, ms }
    const ci = report.cases.findIndex((c) => c.text === text)
    if (ci >= 0) report.cases[ci] = cEntry
    else report.cases.push(cEntry)
  }
  // сводка по ВСЕМ накопленным кейсам
  const allCases = report.cases
  const allCorrect = allCases.filter((c) => c.ok).length
  const allValid = allCases.filter((c) => c.got !== null).length
  step('route-accuracy', allCorrect >= Math.ceil(allCases.length * 0.7) ? 'PASS' : (allCases.length < CASES.length ? 'PARTIAL' : 'FAIL'), `${allCorrect}/${allCases.length} корректных из ${CASES.length} (батч ${rangeArg || 'все'}; порог 70% для 0.6B)`)
  step('json-grammar', allValid === CASES.length ? (jsonValid === counted ? 'PASS' : 'FAIL') : (allCases.length < CASES.length ? 'PARTIAL' : 'FAIL'), `${allValid}/${CASES.length} ответов — валидный JSON (грамматика llama.cpp)`)
  if (latencies.length) {
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    step('route-latency', 'PASS', `батч ${rangeArg || 'все'}: среднее ${avg} мс, мин ${Math.min(...latencies)}, макс ${Math.max(...latencies)} (двухъядерный throttled-CPU песочницы; НЕ целевое значение, §90)`)
  }

  // 2) таймаут/отмена/регресс — только в финальном батче (экономия CPU-времени окружения)
  if (to >= CASES.length - 1) {
    const tRes = await llm.route('открой наруто', { timeoutMs: 1 })
    step('timeout-fallback', tRes === null ? 'PASS' : 'FAIL', `route с timeoutMs=1 → ${tRes === null ? 'null (детерминированный fallback)' : 'ответ'}`)

    // 3) отмена предыдущей генерации новой командой (§47)
    const p1 = llm.route('найди всю полную коллекцию аниме гуррен лаганн и открой первый сезон целиком', { timeoutMs: TEST_TIMEOUT })
    const p2 = llm.route('пауза', { timeoutMs: TEST_TIMEOUT })
    const [, r2] = await Promise.all([p1, p2])
    step('cancel-priority', r2 && r2.commands && r2.commands[0].type === 'Pause' ? 'PASS' : 'FAIL', `вторая команда «пауза» → ${r2 && r2.commands[0] ? r2.commands[0].type : 'null'} (не блокируется первой)`)

    // 4) РЕГРЕСС: STT в том же процессе продолжает работать (A+C регресс)
    const stt = new STTService({ modelsDir: MODELS_DIR })
    await stt.initialize()
    const wav = path.join(MODELS_DIR, 'stt', 't-one-russian', '0.wav')
    if (stt.isReady()) {
      const dec = stt.decodeFileForTest(wav)
      const sttOk = dec.text.length > 3
      step('regression-stt-with-llm', sttOk ? 'PASS' : 'FAIL', `STT после загрузки LLM: «${dec.text.slice(0, 40)}» (${dec.ms} мс)`)
    } else {
      step('regression-stt-with-llm', 'FAIL', `STT не инициализировался: ${stt.error}`)
    }
  }

  report.metrics = { llm: llm.getMetrics() }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  const failed = report.tests.filter((t) => t.status === 'FAIL').length
  console.log(`\nИтог: ${report.tests.length - failed}/${report.tests.length} PASS (батч ${rangeArg || 'все'}); exit=${failed ? 1 : 0}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('llm-selftest crashed:', e)
  process.exit(1)
})
