/**
 * stt-engines — реестр движков распознавания (hexagonal: SttEngineRegistry).
 *
 * Ядро пайплайна (VAD → сегментация → результат) зависит только от интерфейса:
 *
 *   engine = {
 *     id, capabilities: { streaming, hotwords, nbest, punctuation },
 *     initialize() -> state,        // 'ready' | 'failed' (не бросает)
 *     feed(int16Samples),           // 16 кГц mono Int16
 *     flush(), resetUtterance(),
 *     isReady(), getMetrics(), shutdown(),
 *     on('partial' { utteranceId, text, ms }), on('final' { utteranceId, text, reason, ms })
 *   }
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА (v1.0.22): полная замена STT на верифицированную архитектуру
 * Mantella — faster-whisper + внешний Silero-VAD в изолированном Python-сервисе
 * (JSON-lines over stdio). Старые движки (t-one-streaming, gigaam-offline на
 * sherpa-onnx) УДАЛЕНЫ: в системе ровно один авторитетный локальный STT.
 * История: T-One давал мусор на русской речи (issue #1), sherpa-onnx — нативные
 * краши 0xC0000409 на битых ONNX (issue #2); faster-whisper/CTranslate2 — Python
 * исключения вместо fail-fast + изоляция в отдельном процессе.
 *
 * Движок:
 *  - whisper-python: faster-whisper (CTranslate2), модели faster-whisper-{tiny,base,
 *    small,medium,large-v3}; дефолт — base (Mantella default, MANTELLA_STT_RESEARCH.md).
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { WhisperPythonEngine } = require('./whisper-python-engine.cjs')
const { checkModelIntegrity } = require('./model-integrity.cjs')

/** Модель по умолчанию = Mantella default («base»), верифицировано из исходников. */
const DEFAULT_STT_MODEL = 'faster-whisper-base'

/** Все модели движка whisper-python (каталог манифеста v5). */
const WHISPER_MODEL_IDS = [
  'faster-whisper-tiny',
  'faster-whisper-base',
  'faster-whisper-small',
  'faster-whisper-medium',
  'faster-whisper-large-v3',
]

/** Легаси-модели удалённых движков (t-one/gigaam) — считаются НЕ установленными. */
const LEGACY_MODEL_IDS = ['t-one-russian', 'gigaam-v3-russian', 'gigaam-v2-russian']

/**
 * Разрешение модели учитывает целостность, а не только существование файлов
 * (урок 0xC0000409). Цепочка: предпочитаемая → base → tiny → small → medium.
 *
 * @param {string} modelsDir
 * @param {string} preferred
 * @param {string|null} exclude модель-исключение (безопасный режим)
 */
function resolveSttModelId(modelsDir, preferred, exclude) {
  const chain = [preferred, DEFAULT_STT_MODEL, 'faster-whisper-tiny', 'faster-whisper-small', 'faster-whisper-medium'].filter(
    (id, i, a) => id && a.indexOf(id) === i,
  )
  for (const id of chain) {
    if (exclude && id === exclude) continue
    if (sttModelFilesPresent(modelsDir, id) && checkModelIntegrity(modelsDir, id).ok) return id
  }
  // ничего здорового не установлено — возвращаем предпочитаемый (ошибка будет честной при initialize)
  return preferred || DEFAULT_STT_MODEL
}

// ---------------------------------------------------------------------------
// Реестр движков (SttEngineRegistry): новый движок = одна запись + adapter
// ---------------------------------------------------------------------------

const ENGINES = {
  'whisper-python': {
    id: 'whisper-python',
    title: 'Whisper (faster-whisper, локально)',
    capabilities: { streaming: true, hotwords: false, nbest: false, punctuation: false },
    modelIds: WHISPER_MODEL_IDS,
    create: (opts) => new WhisperPythonEngine(opts),
  },
}

/** Каталог → движок: какая модель какой движок загружает */
function engineForModel(modelId) {
  for (const engine of Object.values(ENGINES)) {
    if (engine.modelIds.includes(modelId)) return engine
  }
  return null
}

/**
 * Создать движок по активной модели. Неизвестная/легаси-модель → дефолт Mantella
 * (faster-whisper-base). Легаси-движков больше нет — второй STT не создаётся.
 */
function createSttEngine(opts = {}) {
  const modelId = opts.modelId || DEFAULT_STT_MODEL
  const engineSpec = engineForModel(modelId) || ENGINES['whisper-python']
  const engine = engineSpec.create({ ...opts, engineId: engineSpec.id, modelId: engineSpec.modelIds.includes(modelId) ? modelId : DEFAULT_STT_MODEL })
  engine.capabilities = engineSpec.capabilities
  return engine
}

/**
 * Установлены ли файлы модели и VAD (без загрузки рантайма).
 * Единая точка проверки присутствия для pipeline/UI/инициализации.
 * Легаси-id (t-one/gigaam) — false: движки удалены, их каталоги игнорируются.
 */
function sttModelFilesPresent(modelsDir, modelId) {
  if (!modelId || LEGACY_MODEL_IDS.includes(modelId)) return false
  if (!WHISPER_MODEL_IDS.includes(modelId)) return false
  const vad = fs.existsSync(path.join(modelsDir, 'vad', 'silero-vad', 'silero_vad.onnx'))
  if (!vad) return false
  return WhisperPythonEngine.modelFilesPresent(modelsDir, modelId)
}

module.exports = {
  ENGINES,
  WhisperPythonEngine,
  createSttEngine,
  engineForModel,
  sttModelFilesPresent,
  resolveSttModelId,
  DEFAULT_STT_MODEL,
  WHISPER_MODEL_IDS,
  LEGACY_MODEL_IDS,
  EventEmitter,
}
