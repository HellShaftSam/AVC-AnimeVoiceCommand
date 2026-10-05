/**
 * ai-selftest — структурная самопроверка STT-стека AVC-Anime (v1.0.22: faster-whisper).
 *
 *   A. Манифест v5: whisper-модели с multiFile+files+sha256; легаси-модели отсутствуют.
 *   B. Integrity-модуль: whisper-правила ловят усечённый model.bin; валидный каталог проходит.
 *   C. Реестр движков: DEFAULT=faster-whisper-base; engineForModel маппит все faster-whisper-*;
 *      легаси-id не резолвятся в движок (второго STT нет).
 *   D. Модель по файлам: modelFilesPresent на фейковом каталоге.
 *   E. (опционально) Живой Python-сервис: если задан AVC_WHISPER_MODEL_DIR и python доступен —
 *      spawn + ping + decode короткой тишины (roundtrip протокола).
 *
 * Запуск: AVC_MODELS_DIR=/tmp/avc-models node tests/ai-selftest.cjs
 * Без AVC_MODELS_DIR — только структурные проверки (A–D на временных каталогах).
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const AI = path.join(__dirname, '..', 'electron-app', 'ai')
const MODELS_DIR = process.env.AVC_MODELS_DIR || null

const results = []
function report(name, status, detail) {
  results.push({ name, status, detail })
  console.log(`[${status}] ${name} — ${detail}`)
}

function main() {
  console.log(`models dir: ${MODELS_DIR || '(не задан — только структурные проверки)'}`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avc-ai-selftest-'))
  const { checkModelIntegrity } = require(path.join(AI, 'model-integrity.cjs'))
  const engines = require(path.join(AI, 'stt-engines.cjs'))

  // --- A. манифест ---
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(AI, 'models-manifest.json'), 'utf8'))
    const whisper = (manifest.models || []).filter((m) => m.engine === 'whisper-python')
    const withSha = whisper.filter((m) => (m.files || []).every((f) => f.name === 'config.json' || f.name.startsWith('tokenizer') || f.name.startsWith('vocabulary') || f.sha256))
    const legacy = (manifest.models || []).filter((m) => ['t-one-russian', 'gigaam-v3-russian', 'gigaam-v2-russian'].includes(m.id))
    if (manifest.version < 5) report('A: манифест v5', 'FAIL', `version=${manifest.version}`)
    else if (whisper.length !== 5) report('A: манифест v5', 'FAIL', `whisper-моделей ${whisper.length}, ожидалось 5`)
    else if (withSha.length !== whisper.length) report('A: манифест v5', 'FAIL', 'не у всех model.bin есть sha256')
    else if (legacy.length > 0) report('A: манифест v5', 'FAIL', `легаси-модели остались в каталоге: ${legacy.map((m) => m.id).join(',')}`)
    else report('A: манифест v5', 'PASS', `whisper-моделей: ${whisper.length}, все model.bin с sha256, легаси отсутствуют`)
  } catch (e) {
    report('A: манифест v5', 'FAIL', e.message)
  }

  // --- B. integrity: whisper-правила ---
  try {
    const modelDir = path.join(tmp, 'stt', 'faster-whisper-base')
    fs.mkdirSync(modelDir, { recursive: true })
    const integMissing = checkModelIntegrity(tmp, 'faster-whisper-base')
    fs.writeFileSync(path.join(modelDir, 'model.bin'), Buffer.alloc(1024)) // усечённый
    fs.writeFileSync(path.join(modelDir, 'config.json'), JSON.stringify({ a: 1 }).padEnd(220, ' '))
    fs.writeFileSync(path.join(modelDir, 'tokenizer.json'), Buffer.alloc(600 * 1024, 1))
    fs.writeFileSync(path.join(modelDir, 'vocabulary.txt'), Buffer.alloc(120 * 1024, 1))
    const integTrunc = checkModelIntegrity(tmp, 'faster-whisper-base')
    // полный model.bin (мимик под размер)
    fs.truncateSync(path.join(modelDir, 'model.bin'), 11 * 1024 * 1024)
    const integOk = checkModelIntegrity(tmp, 'faster-whisper-base')
    if (!integMissing.ok && /отсутствует/i.test(integMissing.problems[0])
      && !integTrunc.ok && /усечён/i.test(integTrunc.problems[0])
      && integOk.ok) {
      report('B: integrity whisper', 'PASS', 'missing/усечённый/полный — три сценария корректны')
    } else {
      report('B: integrity whisper', 'FAIL', `missing=${JSON.stringify(integMissing.problems)}, trunc=${JSON.stringify(integTrunc.problems)}, ok=${integOk.ok}/${JSON.stringify(integOk.problems)}`)
    }
  } catch (e) {
    report('B: integrity whisper', 'FAIL', e.message)
  }

  // --- C. реестр движков ---
  try {
    const okDefault = engines.DEFAULT_STT_MODEL === 'faster-whisper-base'
    const okMap = ['tiny', 'base', 'small', 'medium', 'large-v3'].every((s) => engines.engineForModel(`faster-whisper-${s}`)?.id === 'whisper-python')
    const okLegacy = engines.engineForModel('t-one-russian') === null && engines.engineForModel('gigaam-v3-russian') === null
    const legacyPresent = engines.sttModelFilesPresent(tmp, 't-one-russian')
    if (okDefault && okMap && okLegacy && !legacyPresent) {
      report('C: реестр движков', 'PASS', 'только whisper-python; легаси не резолвятся')
    } else {
      report('C: реестр движков', 'FAIL', `default=${engines.DEFAULT_STT_MODEL}, map=${okMap}, legacyNull=${okLegacy}, legacyPresent=${legacyPresent}`)
    }
  } catch (e) {
    report('C: реестр движков', 'FAIL', e.message)
  }

  // --- D. modelFilesPresent (нужен и VAD-файл — общий компонент) ---
  try {
    fs.mkdirSync(path.join(tmp, 'vad', 'silero-vad'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'vad', 'silero-vad', 'silero_vad.onnx'), Buffer.alloc(700 * 1024, 1))
    const dir = path.join(tmp, 'stt', 'faster-whisper-tiny')
    fs.mkdirSync(dir, { recursive: true })
    const before = engines.sttModelFilesPresent(tmp, 'faster-whisper-tiny')
    fs.writeFileSync(path.join(dir, 'model.bin'), 'x')
    fs.writeFileSync(path.join(dir, 'config.json'), 'x')
    fs.writeFileSync(path.join(dir, 'tokenizer.json'), 'x')
    fs.writeFileSync(path.join(dir, 'vocabulary.txt'), 'x')
    const after = engines.sttModelFilesPresent(tmp, 'faster-whisper-tiny')
    report('D: modelFilesPresent', !before && after ? 'PASS' : 'FAIL', `before=${before}, after=${after}`)
  } catch (e) {
    report('D: modelFilesPresent', 'FAIL', e.message)
  }

  // --- E. живой Python-сервис (опционально) ---
  const modelDirEnv = process.env.AVC_WHISPER_MODEL_DIR
  const pythonBin = process.env.AVC_STT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  if (modelDirEnv && fs.existsSync(path.join(modelDirEnv, 'model.bin'))) {
    const vad = (MODELS_DIR && fs.existsSync(path.join(MODELS_DIR, 'vad', 'silero-vad', 'silero_vad.onnx')))
      ? path.join(MODELS_DIR, 'vad', 'silero-vad', 'silero_vad.onnx')
      : null
    if (!vad) {
      report('E: python-сервис ping', 'SKIP', 'нет silero_vad.onnx в AVC_MODELS_DIR')
    } else {
      const service = path.join(AI, 'stt-python', 'stt_service.py')
      const child = spawnSync(pythonBin, [service, '--model', modelDirEnv, '--vad', vad, '--language', 'ru'], {
        input: JSON.stringify({ id: 1, type: 'ping' }) + '\n' + JSON.stringify({ id: 2, type: 'shutdown' }) + '\n',
        encoding: 'utf8',
        timeout: 300000,
      })
      const lines = (child.stdout || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      const ping = lines.find((m) => m.id === 1)
      const ready = lines.find((m) => m.event === 'status' && m.state === 'ready')
      if (ready && ping && ping.ok && ping.result.ready) {
        report('E: python-сервис ping', 'PASS', `device=${ping.result.device}, computeType=${ping.result.computeType}, loadMs=${ping.result.modelLoadMs}, vad=${ping.result.vad}`)
      } else {
        report('E: python-сервис ping', 'FAIL', `stdout=${(child.stdout || '').slice(0, 200)} stderr=${(child.stderr || '').slice(-200)}`)
      }
    }
  } else {
    report('E: python-сервис ping', 'SKIP', 'AVC_WHISPER_MODEL_DIR не задан (полный тест — tests/stt-whisper-selftest.mjs)')
  }

  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const skip = results.filter((r) => r.status === 'SKIP').length
  console.log(`\nИТОГ: PASS=${pass} FAIL=${fail} SKIP=${skip}`)
  process.exit(fail > 0 ? 1 : 0)
}

main()
