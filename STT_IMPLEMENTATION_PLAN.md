# STT Implementation Plan — faster-whisper по верифицированной архитектуре Mantella

Статус: ПРИНЯТ К ИСПОЛНЕНИЮ. Ссылки на факты — `MANTELLA_STT_RESEARCH.md` (верифицирован из исходников Mantella main @ c0c1ae6db01f, v0.14) и `AVC_STT_AUDIT.md` (аудит текущего стека v1.0.21).

## 0. Принципы

1. **AGPL-безопасность**: Mantella — AGPL-3.0. Мы НЕ копируем её код. Мы независимо реализуем тот же поведенческий контракт поверх тех же MIT-зависимостей (faster-whisper, CTranslate2, silero-vad onnx, onnxruntime).
2. **Один авторитетный локальный STT**: `whisper-python` (faster-whisper + внешний Silero-VAD). Старые движки (t-one-streaming, gigaam-offline) удаляются из реестра и каталога — не остаются «параллельно».
3. **Минимальная интеграция**: шов `ENGINES`/`createSttEngine` в `stt-engines.cjs` спроектирован для замены движка без изменения voice-pipeline/ai-worker/main/preload/use-voice.
4. **Локально и офлайн** после установки модели: никаких удалённых API; HuggingFace нужен только на этапе скачивания модели.
5. **Честность**: состояния/ошибки не приукрашиваются; все отклонения от Mantella задокументированы и бенчмарятся.

## 1. Архитектура

```
Рендерер (getUserMedia 16кГц mono Int16)          ← БЕЗ ИЗМЕНЕНИЙ (аудит: use-voice.ts)
  → avc:ai:stt-feed → main → utilityProcess ai-worker.cjs   ← БЕЗ ИЗМЕНЕНИЙ
    → VoicePipeline.feedAudio (Int16)                       ← БЕЗ ИЗМЕНЕНИЙ
      → WhisperPythonEngine (Node-adapter)                  ← НОВЫЙ (шов ENGINES)
        ↕ JSON-lines over stdio (b64 PCM16 16кГц)
        Python-сервис stt_service.py                        ← НОВЫЙ
          - Silero VAD streaming (onnxruntime, тот же silero_vad.onnx v4)
            параметры Mantella: chunk 512, threshold 0.4, pause 0.25 с, cap 30 с, pre-roll 5×512
          - faster-whisper WhisperModel (загружается ОДИН раз)
            transcribe(language='ru', beam_size=5, vad_filter=False) — как Mantella
          - partial-эмуляция: лёгкий декод (beam_size=1) раз в ≥1 с во время речи
        → события partial/final → существующий EarlyCommandDetector → парсер рендерера
```

Node сохраняет: оркестрацию, IPC, скачивание моделей, SHA-256, карантин, safe-mode.
Python забирает: VAD + инференс (там, где живёт faster-whisper).

## 2. Компоненты (что делаем)

| # | Компонент | Файл | Действие |
|---|-----------|------|----------|
| 1 | Python-сервис STT | `electron-app/ai/stt-python/stt_service.py` | **Создать**: JSON-lines протокол, VAD, инференс, partial, selftest-режим |
| 2 | requirements | `electron-app/ai/stt-python/requirements.txt` | **Создать**: пины Mantella + совместимые (см. STT_MODEL_CONFIGURATION.md) |
| 3 | Node-адаптер движка | `electron-app/ai/whisper-python-engine.cjs` | **Создать**: спавн python, протокол, метрики, краш-политика |
| 4 | Реестр движков | `electron-app/ai/stt-engines.cjs` | **Заменить**: только `whisper-python`; удалить T-One/GigaAM-классы; DEFAULT=`faster-whisper-base` |
| 5 | Целостность | `electron-app/ai/model-integrity.cjs` | **Дополнить**: правила для CTranslate2-моделей (marker files + мин-размеры), reuse checkVadIntegrity |
| 6 | Менеджер моделей | `electron-app/ai/model-manager.cjs` | **Дополнить**: multiFile-установка (по-файлово с SHA-256), манифест v5 |
| 7 | Манифест | `electron-app/ai/models-manifest.json` | **Заменить**: faster-whisper tiny/base/small/medium/large-v3 (пиновые ревизии HF, реальные sha256), vad остаётся |
| 8 | Голосовой пайплайн | `electron-app/ai/voice-pipeline.cjs` | **Адаптировать**: бенчмарк- wav, дефолты; остальное без изменений |
| 9 | Воркер | `electron-app/ai/ai-worker.cjs` | **Адаптировать**: дефолт модели |
| 10 | Main | `electron-app/main.cjs` | **Адаптировать**: дефолт env-переменной модели |
| 11 | UI | `src/components/avc/settings-dialog.tsx` (+ voice-panel/ai-setup тексты) | **Адаптировать**: каталог уже манифест-управляемый; хардкоды движков |
| 12 | Упаковка | `scripts/assemble-ai-pack.mjs`, `electron-app/electron-builder.json` | **Дополнить**: stt-python в ai-pack; python-runtime как extraResources |
| 13 | CI | `.github/workflows/build-exe.yml` | **Дополнить**: сборка embeddable Python 3.11 + pip-пины; selftest сервиса на реальном Windows до публикации |
| 14 | Selftest | `tests/stt-whisper-selftest.mjs` | **Создать**: прогон TTS-датасета через сервис, латентность |
| 15 | Документы | 7 файлов по спецификации | **Создать** |

## 3. Протокол Node ↔ Python (JSON-lines по stdio)

Запросы (stdin): `{id, type:'feed', audio:<b64 int16le>}` | `{id,type:'flush'}` | `{id,type:'capture-mode',on:bool}` | `{id,type:'decode',audio:<b64 f32le>,sampleRate}` | `{id,type:'ping'}` | `{id,type:'shutdown'}`
События (stdout): `{event:'ready',...}` | `{event:'partial',utteranceId,text,ms}` | `{event:'final',utteranceId,text,reason,ms}` | `{event:'status',state,error?}` | `{event:'log',level,message}`
Ответы: `{id, ok, result?|error?}`.
Гарантии: одна строка JSON на сообщение; python буферизует stdin; при смерти процесса Node-адаптер получает 'exit' и честно переводит движок в failed (краш-политика воркера видит это через status, воркер НЕ умирает).

## 4. Краеугольные параметры (верифицированы в Mantella)

- Модель по умолчанию: **base** (`faster-whisper-base`), каталог: tiny/base/small/medium/large-v3 (мультиязычные; .en/distil-варианты Mantella исключены — не применимы к русскому; whisper-1 — удалённый API, исключён по требованию офлайна).
- CPU: `compute_type="float32"` (Mantella); CUDA: параметр не передаётся (= "default"); устройство из конфига, дефолт **cpu**, без авто-детекта (как в Mantella).
- `transcribe(audio, language='ru', beam_size=5, vad_filter=False)`; language явный (механика Mantella: stt_language='default' → язык приложения; у AVC-Anime это ru — отклонения НЕТ).
- VAD: silero, 16кГц, окно 512, порог 0.4, конец речи 0.25 с тишины, cap 30 с, pre-roll 5×512.
- Отклонения (все задокументированы): partial-эмуляция для UI-совместимости (beam_size=1, ≥1 c интервал), initial_prompt=None (в Mantella — игровой контекст, у нас его источника нет), небольшая ru/en-антисписок галлюцинаций на тишине (в Mantella аналогичный ignore-list), numpy 1.26.4 вместо 1.25.0 (py3.12 dev-среда), offline-модели из пинового каталога вместо HF-кэша по умолчанию.

## 5. Этапы

1. Манифест v5 + multiFile в model-manager (пин-ревизии, реальные sha256 model.bin).
2. Python-сервис + requirements.
3. Node-движок + реестр + integrity-правила.
4. Песочница: pip install, TTS-датасет (русский), selftest, латентность, подбор длительности partial.
5. UI-адаптация + тексты.
6. CI: python-runtime сборка + Windows-selftest до публикации; extraResources.
7. Документы + отчёт; релиз.

## 6. Критерии готовности (см. Фазу 13 спецификации владельца)

- EXE запускается, Настройки → AI показывает Whisper-модели, установка с прогрессом, живой тест распознаёт русский.
- Песочница: протокол/VAD/инференс PASS на реальном faster-whisper (TTS-датасет), латентности записаны.
- CI Windows: bundled python + сервис + базовая модель транскрибируют фикстуру PASS (до публикации релиза).
- Честно помечено: live-микрофонные 30+ прогонов в песочнице — BLOCKED (нет микрофона), 1-часовая стабильность — BLOCKED/сокращённая, финальная проверка на машине владельца — за владельцем.
