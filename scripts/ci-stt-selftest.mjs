#!/usr/bin/env node
/**
 * ci-stt-selftest — Windows-CI проверка STT-сервиса faster-whisper на РЕАЛЬНОМ
 * бандленном python-рантайме (до публикации релиза).
 *
 * Шаги:
 *   1. Скачивает модель Systran/faster-whisper-base с ПИНОВОЙ ревизии (как в
 *      манифесте v5) в temp через huggingface_hub из бандленного python.
 *   2. Запускает stt_service.py --wav <фикстура> --expect <текст> тем же python.
 *   3. Проверяет: exit 0, JSON-результат pass=true, латентность записана.
 *
 * Env: AVC_PYTHON (путь к python.exe), AVC_SERVICE, AVC_FIXTURE, AVC_HF_MODEL,
 *      AVC_HF_REVISION, AVC_EXPECT.
 * Exit: 0 — PASS; 1 — FAIL (блокирует публикацию релиза в workflow).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const PYTHON = process.env.AVC_PYTHON || path.join('electron-app', 'dist', 'win-unpacked', 'resources', 'python-runtime', 'python.exe')
const SERVICE = process.env.AVC_SERVICE || path.join('electron-app', 'ai', 'stt-python', 'stt_service.py')
const FIXTURE = process.env.AVC_FIXTURE || path.join('electron-app', 'ai', 'stt-python', 'fixtures', 'benchmark-ru.wav')
const HF_MODEL = process.env.AVC_HF_MODEL || 'Systran/faster-whisper-base'
const HF_REVISION = process.env.AVC_HF_REVISION || 'ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66'
const EXPECT = process.env.AVC_EXPECT || 'нар'

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 600000, ...opts.spawnOpts })
  return r
}

function main() {
  const t0 = Date.now()
  for (const f of [PYTHON, SERVICE, FIXTURE]) {
    if (!fs.existsSync(f)) {
      console.error(`FAIL: не найден ${f} (cwd=${process.cwd()})`)
      process.exit(1)
    }
  }

  // --- 1) модель с пиновой ревизии ---
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avc-fw-model-'))
  console.log(`[ci-stt] скачивание ${HF_MODEL}@${HF_REVISION.slice(0, 8)} → ${modelDir}`)
  const dl = sh(PYTHON, ['-c',
    `from huggingface_hub import snapshot_download; p = snapshot_download('${HF_MODEL}', revision='${HF_REVISION}', local_dir=r'${modelDir}'); print('MODEL_DIR=' + p)`])
  const dlOut = `${dl.stdout || ''}`
  if (dl.status !== 0 || !dlOut.includes('MODEL_DIR=')) {
    console.error('FAIL: snapshot_download:', (dl.stderr || dl.stdout || '').slice(-800))
    process.exit(1)
  }
  if (!fs.existsSync(path.join(modelDir, 'model.bin'))) {
    console.error('FAIL: model.bin не скачался')
    process.exit(1)
  }

  // --- 2) selftest сервиса на реальном Windows + бандленном рантайме ---
  console.log(`[ci-stt] selftest: ${FIXTURE} (expect="${EXPECT}")`)
  const run = sh(PYTHON, [SERVICE, '--model', modelDir, '--wav', FIXTURE, '--expect', EXPECT], { timeout: 300000, spawnOpts: { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } } })
  const lines = (run.stdout || '').split('\n').filter((l) => l.trim().startsWith('{'))
  let result = null
  try { result = JSON.parse(lines[lines.length - 1]) } catch { /* ниже честный FAIL */ }
  if (run.status !== 0 || !result || result.pass !== true) {
    console.error('FAIL: selftest:', (run.stderr || '').slice(-600), (run.stdout || '').slice(-400))
    process.exit(1)
  }
  console.log(`[ci-stt] PASS: text="${result.text}" | transcribeMs=${result.transcribeMs} | modelLoadMs=${result.modelLoadMs} | computeType=${result.computeType} | device=${result.device}`)
  console.log(`[ci-stt] total ${Math.round((Date.now() - t0) / 1000)}s`)
  process.exit(0)
}

main()
