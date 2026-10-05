# AVC-Anime — полный аудит текущего STT-стека (Task 2)

Дата аудита: 2026-10-05. Метод: построчное чтение кода (факты + пути + номера строк). Цель — подготовка замены движков **T-One streaming + GigaAM v3 (sherpa-onnx-node в Node-воркере)** на **faster-whisper через встраиваемый Python-рантайм**, минимально инвазивно.

Ключевой факт верхнего уровня: **захват микрофона живёт в рендерере** (getUserMedia + ScriptProcessorNode), а не в воркере. Воркер получает уже готовый Int16 PCM 16 кГц mono по IPC. Значит замена движка в воркере не затрагивает захват аудио вообще.

---

## 1. Карта компонентов

| Компонент | Файл(ы) | Роль | Классификация | Комментарий по миграции на faster-whisper |
|---|---|---|---|---|
| Оркестратор воркера (протокол req/resp + события) | `electron-app/ai/ai-worker.cjs` (127 строк) | Протокол `{id,type,args}`→`{id,ok,result}`; события `stt-partial/stt-final/services-status/model-progress`; хендлеры `status/hardware/install/feed/flush/set-capture-mode/...` (строки 48–91) | **Reuse** | Движко-агностичен: `feed` (80–85) просто передаёт Int16Array в pipeline. Не меняется. |
| Голосовой пайплайн | `electron-app/ai/voice-pipeline.cjs` (427 строк) | Оркестрация: выбор модели, карантин битых моделей, install/каталог/бенчмарк, EarlyCommandDetector (36–48, 373–396), мостинг событий движка (`_wireStt` 108–119) | **Reuse** | Работает через интерфейс движка `createSttEngine` (68, 259, 305). Early-команды зависят от **partial**-событий — у Whisper их нет «из коробки», см. риски R1. |
| Реестр движков (hexagonal-шов) | `electron-app/ai/stt-engines.cjs` (строки 369–408: `ENGINES`, `engineForModel`, `createSttEngine`) | Движок выбирается по id модели из манифеста; «новый движок = один adapter + запись» (комментарий 1–23) | **Adapt** (шов оставить) | **Главная точка подсадки Python-движка**: добавить запись `whisper-python` в `ENGINES` + adapter-класс. Пайплайн/воркер не меняются. |
| Движок GigaAM offline (v2 CTC / v3 transducer) | `electron-app/ai/stt-engines.cjs` (85–354) | sherpa `OfflineRecognizer` + sherpa `Vad` (окно 512 @16 кГц), декод фразы целиком по endpoint (222–292), `decodeFileForTest` (321–341) | **Replace** (удалить класс) | Логика VAD/сегментации переезжает в Python-сервис (faster-whisper `vad_filter=True` или свой Silero). `setCaptureMode`-семантику PTT (295–307) нужно воспроизвести в Python. |
| Движок T-One streaming | `electron-app/ai/stt-service.cjs` (STTService, 48–387) | sherpa `OnlineRecognizer` CTC 8 кГц + Silero VAD 16 кГц, partial каждые ≥120 мс (239), ресемпл 16→8 кГц усреднением пар (253–267), endpoint-правила (149–155) | **Replace** (удалить; см. R10 про selftest) | Единственный источник частичных результатов в текущем стеке. При удалении partial-UX (interimText + ранние команды) исчезает, если Python-сервис не эмулирует partial. |
| Менеджер моделей | `electron-app/ai/model-manager.cjs` (613 строк) | Скачивание (mirrors+retry×3+Range-resume, 373–404), SHA-256, tar.bz2-распаковка (530–539), голый файл (521–527), маркер `.avc-installed.json` c `files{имя→байт}` (342–356), `verify`/`remove`/`recoverPending` | **Reuse / Adapt** | Вся машина скачивания переиспользуется для Whisper-моделей с HF. Нужно: (а) поддержка multi-file модели (CTranslate2 = model.bin+config+tokenizer+vocabulary) — сейчас только `tar.bz2` или ровно один файл (521–527); (б) zip при необходимости. |
| Целостность моделей | `electron-app/ai/model-integrity.cjs` (306 строк) | Пред-полётная проверка БЕЗ нативного кода: min-размеры (33–44), ONNX-заголовок (70–90), protobuf-обход (113–170), токены (92–101), сверка с маркером; `quarantineModel` (249–266), `resolveHealthyModelId` (285–294) | **Adapt** | Урок 0xC0000409 сохраняет силу, но `onnxProtobufWalkOk` не применим к CTranslate2 `model.bin` — нужны новые `CATALOG_FILES`/`MIN_FILE_BYTES` (48–52) и проверка формата Whisper-файлов. `checkVadIntegrity` (231–241) остаётся валидным, если Silero VAD сохраняется (Python тоже умеет есть тот же `silero_vad.onnx`). |
| Манифест моделей | `electron-app/ai/models-manifest.json` (v4) | VAD: silero 643854 B sha 9e2449e1… (15–32); t-one-russian 128468156 B sha b9c90745… (34–67); gigaam-v3-russian 167388020 B sha 20a43949… default=true (68–104); gigaam-v2-russian 166917722 B sha 777be871… (105–137) | **Adapt** | Заменить записи `models[]` на Whisper (HF URL, размеры, sha256, `engine: 'whisper-python'`); VAD-запись оставить. Схема (`key/id/url/mirrors/archive/expectedFiles/acceptRanges/license/minRamBytes`) уже вся нужна. |
| Main: спавн воркера, crash-policy, конфиги | `electron-app/main.cjs` 565–875, 939–1001, 1284–1363, 1412–1516, 1541–1569 | `startAiWorker` (734–863), `NATIVE_CRASH_CODES` (580), карантин/safe-mode (799–854, 599–611), `aiWorkerRequest` (613), IPC-мост (878–1001), модели-каталог конфиг (653–708) | **Reuse** | Движко-агностично. Отлично переживает замену. |
| Preload-мост | `electron-app/preload.cjs` (ai-объект 75–194) | `feedAudio` (110), `flushStt` (113), `setCaptureMode` (115), `onSttPartial/onSttFinal` (118–129), `catalog/setSttModel/benchmark/...` (163–178) | **Reuse** | Полностью движко-агностичен. |
| Клиент голоса рендерера | `src/lib/avc/use-voice.ts` (959 строк) | Движки `browser/server/local`; локальная сессия: AudioContext 16 кГц (599), ScriptProcessor 2048 (603), лимитер+gain (610–621), `feedAudio` (622), подписки partial/final (664–723), PTT (725–857) | **Reuse** | Не знает про T-One/GigaAM (только статусы `engineName: 'local'`). Меняется только, если хотим partial-UX от Whisper. |
| Типы/настройки | `src/lib/avc/api.ts` (204–281), `src/lib/avc/types.ts` (400–500) | `SttEngine='auto'|'browser'|'server'|'local'`, `AiProfile`, bridge-типы `ai.*` | **Reuse** | Ничего не ломается. |
| UI: Настройки → AI | `src/components/avc/settings-dialog.tsx` (1790 строк) | `AiSettingsPanel` (927+), `SttCatalogCard` (1130–1430), `SttLiveTestCard` (1438–1646), `AiWorkerStatusCard` (1654–1790), MicSettings (453–774) | **Adapt** (частично) | Карточки движко-агностичны, но есть хардкод текстов/маппингов (см. §6). |
| UI: мастер первого запуска | `src/components/avc/ai-setup-dialog.tsx` (77–91, 160–166) | Предвыбор по железу: `stt:gigaam-v3-russian`/`stt:t-one-russian` жёстко (88–89) | **Adapt** | Заменить id моделей на Whisper-записи манифеста. |
| UI: панель голоса | `src/components/avc/voice-panel.tsx` (43, 59, 169–177) | Бейдж готовности STT; текст `engine === 'gigaam-offline' ? 'GigaAM' : 'T-One'` (176) | **Adapt** | Использовать `catalog.name`/`manifest.name` вместо хардкода. |
| Скрипт сборки AI-пака | `scripts/assemble-ai-pack.mjs` (105 строк) | Копирует `ai/*.cjs` (51–63), `node_modules/sherpa-onnx-node` + `sherpa-onnx-win-x64` (31–35, 65–79), `runtime-node` (81–88) | **Replace** | sherpa-пакеты убрать; добавить этап «встраиваемый Python» (portable CPython + faster-whisper/ctranslate2/onnxruntime wheels) → `ai-pack/runtime-python`. |
| Упаковка EXE | `electron-app/electron-builder.json` (40–46) | `extraResources`: `ai-pack` → `ai/**`, `runtime-node/**` в resources | **Adapt** | Добавить `runtime-python/**` в filter. `files` (8–17) не включает `ai/**` в asar — урок v1.0.21 сохраняется (см. `scripts/check-packaged-layout.mjs`). |
| Node-рантайм для воркера | `main.cjs` `findSystemNode` (633–651) | `AVC_NODE_EXE` → `resources/runtime-node/node.exe` → PATH | **Reuse / Adapt** | Добавить аналогичный резолвер для `python.exe` (env → `resources/runtime-python/python.exe` → PATH). Причина существования отдельного Node (запрет napi external arraybuffers в Electron, `ai-worker.cjs` 34–40) перестаёт действовать для Python, но воркер-изоляция крашей остаётся ценной. |
| Selftest: полный цикл STT | `tests/ai-selftest.cjs` (A–D, 196 строк) | A: GigaAM init+decode; B: integrity-гейт (дочерний процесс должен ВЫЖИТЬ); C: карантин+fallback; D: T-One | **Replace** кейсов A/B/D, **Adapt** C | Идея B (битый файл → честный отказ, процесс жив) обязана пережить миграцию на Python. C — fallback-цель станет Whisper. |
| Selftest: стриминговый путь | `electron-app/tools/ai-stt-selftest.cjs` (117 строк) | T-One: feed окнами 512, silence-no-final, dedup-final | **Replace** | Тесты перенаправить на Python-сервис (те же инварианты). |
| Selftest: менеджер моделей | `electron-app/tools/ai-model-selftest.cjs` (111 строк) | install('stt') по манифесту, Range-resume, битый маркер | **Reuse** | Заработает для Whisper после обновления манифеста (использует legacy-ключ `components.stt`, строки 40/56 — потребует синхронизации). |
| Selftest: main-интеграция | `electron-app/tools/ai-main-selftest.cjs` | VoicePipeline вне Electron | **Уже сломан** | Строка 26 требует `svc.tts`/`svc.llm` — слои удалены в 1.0.12 → всегда FAIL. Реальный main-selftest — `--ai-selftest` в `main.cjs` (1484–1516), он Reuse. |
| SHA-инструмент и валидатор ассетов | `electron-app/tools/ai-sha-update.cjs`, `scripts/validate-ai-assets.mjs` | Снятие реальных sha256; HEAD/content-length проверка URL манифеста (см. `electron-app/ai/AI_ASSET_VALIDATION_REPORT.md`) | **Reuse** | Прямо пригодны для HF-URL Whisper-моделей. |
| Web-движки (не EXE) | `use-voice.ts` (browser/server), `src/app/api/voice/asr/route.ts` (z-ai SDK, облако) | Web Speech API / облачный ASR | **Remove из объёма миграции** | Не связаны с локальным STT; не трогаем. |
| Мусор в ai/ | `electron-app/ai/llm-service.cjs`, `tts-service.cjs` | Остатки удалённых слоёв (не входят в пак, `assemble-ai-pack.mjs` 53) | **Unknown-нужно-исследовать** (вне объёма) | Удаление несвязанных систем не в рамках задачи 2. |

---

## 2. Путь аудио (EXE, движок «local») — шаг за шагом

**Захват — рендерер. Sherpa Microphone в воркере НЕ используется.**

1. **getUserMedia** — `src/lib/avc/use-voice.ts:411–424` (`ensureStream`), constraints из `buildAudioConstraints` (`src/lib/voice/audio-utils.ts:22`): deviceId, echoCancellation/noiseSuppression/autoGainControl из настроек.
2. **AudioContext с принудительными 16 кГц** — `use-voice.ts:599` `new AudioContext({ sampleRate: 16000 })`; `createMediaStreamSource` (600).
3. **ScriptProcessorNode(2048, 1, 1)** — `use-voice.ts:603` → чанк = 2048 сэмплов = **128 мс @ 16 кГц mono Float32** (релиз 1.0.15; ранее 4096/256 мс). Подключён через mute-Gain к destination (641–644), чтобы работал.
4. **Конверсия + мягкий лимитер** — `use-voice.ts:610–621`: `onaudioprocess` берёт `getChannelData(0)` (Float32), применяет `settings.micGain` и soft-limiter (насыщение после 0.7, экспоненциальное сжатие) → **Int16Array(2048), 16 кГц, mono**. Тот же алгоритм дублирован в живом тесте настроек (`settings-dialog.tsx:1527–1534`).
5. **IPC renderer→main** — `use-voice.ts:622` `ai.feedAudio(int16)` → `preload.cjs:110` `ipcRenderer.invoke('avc:ai:stt-feed', { samples: Int16Array })`.
6. **IPC main→worker** — `main.cjs:928–932` хендлер `avc:ai:stt-feed` → `aiWorkerRequest('feed', { samples })` (613–630) → `aiWorker.send` с `serialization: 'advanced'` (760–771) — typed array переживает structured clone.
7. **Воркер** — `ai-worker.cjs:80–85` хендлер `feed` → `pipeline.feedAudio(int16)` → `voice-pipeline.cjs:404–407` → `this.stt.feed(int16Samples)`.
8. **VAD + сегментация (движковая, в Node сегодня)**:
   - **T-One** (`stt-service.cjs:190–250`): Int16 → окна **512 сэмплов (32 мс)** → Float32/32768 → `sherpa.Vad.acceptWaveform` (16 кГц, threshold по профилю, `PROFILES` 33–37). Предыстория: кольцо **38 окон ≈ 1.2 с** (193, 232–236) подмешивается в распознаватель при старте речи. Хвост тишины **200 мс** → `_finishUtterance('endpoint')` (227–230); кулдаун **250 мс** (307). Речь → `_feedStt` (253–267): **ресемпл 16→8 кГц усреднением пар** → `acceptWaveform({sampleRate:8000})` → `OnlineRecognizer.decode`. Partial не чаще **120 мс** (239–248). T-One = **CTC 8 кГц** (`SAMPLE_RATE_STT=8000`, строка 26).
   - **GigaAM** (`stt-engines.cjs:222–259`): те же VAD-окна 512 @16 кГц; копит Float32-фразу целиком (`_utteranceSamples`); endpoint по хвосту **200 мс** (253) → `_finishUtterance` (268–292): фраза < **300 мс** отбрасывается (275), кулдаун **250 мс** (274), `OfflineRecognizer` декодирует **всю фразу разом** (279–283). Частичных результатов НЕТ. GigaAM = **16 кГц** (`SAMPLE_RATE_GIGAAM=16000`, строка 33).
9. **События движка → pipeline** — `voice-pipeline.cjs:108–119` `_wireStt`: `partial` → детект ранней команды (`_detectEarly` 373–396, `EARLY_SAFE_PATTERNS` 36–45, `UNSAFE_PATTERN` 48) → `emit('stt-partial', {utteranceId, text, ms, earlyCommand})`; `final` → `{utteranceId, text, reason, ms, earlyCommandType}`.
10. **Воркер → main** — `ai-worker.cjs:43–44` `{event:'stt-partial'|'stt-final', payload}` через `process.send` (39–41; в проде это чистый Node `child_process.fork`, а не utilityProcess).
11. **main → renderer** — `main.cjs:776–788` маппинг `AI_EVENT_CHANNELS` (565–571) → `webContents.send('avc:ai:stt-partial' | 'avc:ai:stt-final', payload)`.
12. **Рендерер: потребление** — `use-voice.ts:667–718`: partial → `setInterimText` + раннее исполнение безопасной команды через `executeEarlyCommand` (670–682); final → дедупликация по `utteranceId`/`earlyCommandType` → `handleRecognizedText` → `executeText(text,'voice',{correlationId})` (341–344) — существующий детерминированный парсер. Финальный payload события — **строка текста**, после этого границы аудио не существуют.
13. **PTT-вариант**: удержание кнопки → `startPushToTalk` (`use-voice.ts:725`) → `startLocalSession` (588–661) + `ai.setCaptureMode(true)` (763 → `avc:ai:stt-capture` → `main.cjs:935` → `voice-pipeline.cjs:414–418` → движок `setCaptureMode`: VAD обходится, всё считается речью; T-One: `stt-service.cjs:318–337`, GigaAM: `stt-engines.cjs:295–307`). Отпускание → `stopPushToTalkAndProcess` (806–837): `setCaptureMode(false)` + `flushStt()` (820–823) → `flush` → финал; страховка 10 с на финал (827–835). Кап длины фразы `maxUtteranceMs` → авто-flush (653–656).

**Форматы по шагам (сводка):** рендерер: Float32 16кГц/2048 → Int16 16кГц mono (мягкий лимит) → IPC (advanced serialization) → воркер: окна 512 (32 мс) → VAD Silero 16кГц → T-One: 8кГц Float32 через усреднение пар, стриминговый CTC; GigaAM: 16кГц Float32, офлайн-декод фразы. Пользователю — только строки partial/final.

---

## 3. IPC-инвентарь

### 3.1 Renderer → main (`ipcRenderer.invoke`, preload.cjs 75–194)

| Канал | preload | main.cjs | Payload | Потребитель в UI |
|---|---|---|---|---|
| `avc:ai:status` | 80 | 879–888 | — | `AiSettingsPanel.refresh` (settings-dialog 935–946), `voice-panel.tsx:67` |
| `avc:ai:hardware` | 83 | 889–897 | — | AI Setup мастер (`ai-setup-dialog.tsx:81`), диагностика |
| `avc:ai:install` | 86 | 898 (таймаут 1 ч) | `{keys, voiceId}` | SttCatalogCard «Скачать» (settings-dialog 1213–1217), мастер (ai-setup 119), «Переустановить» (1690) |
| `avc:ai:cancel-install` | 89 | 899 | `{key}` | (кнопка отмены мастера) |
| `avc:ai:recover` | 92 | 900 | — | восстановление .part после перезапуска |
| `avc:ai:set-enabled` | 95 | 901 | `{enabled}` | (флаг AI-слоя) |
| `avc:ai:set-profile` | 98 | 902 | `{profile}` | профиль «Максимальная отзывчивость/…» (settings-dialog 1000–1016) |
| `avc:ai:initialize` | 104 | 906 (таймаут 600 с) | — | «Перезапустить сервисы» (1087), мастер (ai-setup 125) |
| `avc:ai:catalog` | 163 | 909 | — | SttCatalogCard (1155–1164) |
| `avc:ai:benchmark` | 166 | 910 (300 с) | — | «Проверить скорость» (1241–1255) |
| `avc:ai:set-stt-model` | 169 | 911–925 | `{modelId}` (валидация `^[a-z0-9-]{1,64}$` 913); при ok пишет models-dir.json с `sttModelChosen=true` (922) | «Сделать активной» (1219) |
| `avc:ai:remove-component` | 172 | 926 | `{key}` | «Удалить» (1226) |
| `avc:ai:verify-component` | 175 | 927 (300 с) | `{key}` | «Проверить» (1223) |
| `avc:ai:stt-feed` | 110 | 928–932 | `{samples: Int16Array}` | use-voice локальная сессия (622), SttLiveTestCard (1535) |
| `avc:ai:stt-flush` | 113 | 933 | — | PTT-стоп (822), автокап (654), live-test stop (1559) |
| `avc:ai:stt-capture` | 115 | 935 | `{enabled}` | PTT вкл/выкл (763, 821) |
| `avc:ai:models:get-config` | 148 | 939–954 | — | ModelsManagerCard |
| `avc:ai:models:pick-dir` | 151 | 1295–1304 | — | выбор папки моделей |
| `avc:ai:models:set-dir` | 157 | 1318–1363 | `{dir}` (валидация→место→копирование→сверка→конфиг→`startAiWorker()` 1361) | миграция каталога |
| `avc:ai:models:open-dir` | 160 | 1306–1311 | — | открыть каталог |
| `avc:ai:restart-worker` | 178 | 990–1001 | — | AiWorkerStatusCard «Перезапустить» (1757), reinstallSuspect (1691) |
| `avc:ai:open-logs` | 181 | 1284–1293 | — | «Открыть папку с логами» |
| `avc:debug:appinfo` | 184 | 958–969 | — | diagnostics-dialog (workerRunning/modelsDir) |
| `avc:debug:logs` | 186 | 972–988 | `{lines}` | diagnostics-dialog |

### 3.2 Main → Renderer (webContents.send; маппинг `AI_EVENT_CHANNELS` main.cjs 565–571)

| Канал | Payload | Источник | Потребитель в UI |
|---|---|---|---|
| `avc:ai:stt-partial` | `{utteranceId, text, ms, earlyCommand?}` | движок `partial` → voice-pipeline 109–112 → ai-worker 43 → main 784–787 | use-voice 667 (interim + ранние команды), SttLiveTestCard 1571 |
| `avc:ai:stt-final` | `{utteranceId, text, reason, ms, earlyCommandType?}` | движок `final` → voice-pipeline 113–117 → ai-worker 44 | use-voice 684 (исполнение команды), SttLiveTestCard 1574 |
| `avc:ai:services-status` | `getStatus().ready` | voice-pipeline 118/264/275/280/309 → ai-worker 45 | подписчики onServicesStatus |
| `avc:ai:model-progress` | `{key,id,phase,percent,receivedBytes,totalBytes,speedBps,message,error}` | model-manager `progress` → ai-worker 46 | SttCatalogCard 1170–1199, мастер ai-setup 102–109 |
| `avc:ai:worker-state` | `{running, error, quarantine, safeMode}` | `notifyWorkerState()` main 866–875 | AiWorkerStatusCard 1670–1674 |

### 3.3 Main ↔ Worker (child_process.fork IPC; типы запросов в `ai-worker.cjs` handlers 48–91)

Запросы: `status`, `hardware`, `install`, `cancel-install`, `recover`, `set-enabled`, `set-profile`, `initialize`, `catalog`, `set-stt-model`, `benchmark`, `remove-component`, `verify-component`, `feed`, `flush`, `set-capture-mode`. Ответы `{id, ok, result|error}`; события `stt-partial/stt-final/services-status/model-progress` и `worker-fatal` (ai-worker 30 — **не** входит в `AI_EVENT_CHANNELS`, т.е. до рендерера не доходит, только потеря; фикс — одна строка в 565–571).

---

## 4. Модельный слой

**Манифест** `electron-app/ai/models-manifest.json` (версия 4, storage.dirName `ai-models`, layout `stt/<modelId>/`, `vad/silero-vad/`):

| Ключ | URL | Размер | sha256 | Архив | Примечание |
|---|---|---|---|---|---|
| `components.vad` (silero-vad) | github k2-fsa `silero_vad.onnx` | 643 854 B | `9e2449e1…` | нет (голый файл) | required, runtime sherpa Vad |
| `stt:t-one-russian` | k2-fsa `sherpa-onnx-streaming-t-one-russian-2025-09-08.tar.bz2` | 128 468 156 B | `b9c90745…` | tar.bz2 | required=false, minRam 4 ГБ, профиль ru-fast |
| `stt:gigaam-v3-russian` | k2-fsa `…nemo-transducer-giga-am-v3-russian-2025-12-16.tar.bz2` | 167 388 020 B | `20a43949…` | tar.bz2 | **default=true**, minRam 6 ГБ, expectedFiles: tokens/encoder.int8/decoder/joiner |
| `stt:gigaam-v2-russian` | k2-fsa `…nemo-ctc-giga-am-v2-russian-2025-04-19.tar.bz2` | 166 917 722 B | `777be871…` | tar.bz2 | запасной |

**Скачивание** (`model-manager.cjs`):
- `install(key)` 316–365: mkdir → проверка диска (331–333, `freeDiskSpace` 58–80) → `_downloadWithMirrors` (373–404): перебор `[url, ...mirrors]`, до 3 попыток на URL, паузы 1.5/3 с, retry только для HTTP_404/5xx/NETWORK/TLS/TIMEOUT/SIZE; `ABORTED`/`CHECKSUM` не повторяются.
- `_download` 406–506: редиректы ≤5 (428–432), честные ошибки 404/403/5xx (434–436), HTTP 416 → переименование .part (437–446, урок фиксa resume), сверка content-length с манифестом (449–454), запись в `.part` (Range-resume, 417–418, 456–459), прогресс каждые 250 мс (466–478), таймаут 60 с (499–501), финальный rename `.part`→архив (489).
- `_verifyAndExtract` 508–549: SHA-256 (513–518; несовпадение → файл удалён, `CHECKSUM`); `archive: 'tar.bz2'` → системный `tar -xjf --strip-components=1` (530–539); **без `archive` — «голый файл» ровно один** (521–527, сейчас используется .gguf-путём); проверка `expectedFiles` (542–546).
- **Маркер** `.avc-installed.json` {id, name, url, sha256, sizeBytes, **files{имя→байт}**, installedAt, avcVersion: 2} (342–356) — основа последующей дешёвой проверки усечений.

**Целостность** (`model-integrity.cjs`): `checkModelIntegrity` 176–228 = существование + min-размеры (`MIN_FILE_BYTES` 33–44) + санитарность ONNX-заголовка (`onnxHeaderLooksSane` 70–90: не HTML/JSON/нули) + **структурный protobuf-обход** (`onnxProtobufWalkOk` 113–170 — ловит ЛЮБОЕ усечение, lesson: min-size пропускал 50% усечённый encoder) + sane tokens (92–101) + сверка размеров с маркером (216–218). VAD: `checkVadIntegrity` 231–241. Карантин: `quarantineModel` 249–266 (rename → `*.corrupt-<stamp>` + `QUARANTINE.txt`), `listQuarantined` 269–278. Каталог повреждений в UI: `model-manager.cjs:211–217` (`damaged`/`damageReason` для `key==='stt'`).

**Карантин/safe-mode/crash-policy** (`main.cjs`): `NATIVE_CRASH_CODES = {134, 3221225477, 3221226505, 3221225786, 3221226019}` (580); exit-обработчик 799–854: нативный краш <30 с жизни → `checkModelIntegrity` → битая модель в карантин + рестарт (811–827); файлы целы, а краш повторился ≥2 → **safe-mode** в `userData/ai-safe-mode.json` (828–839; read/write/clear 599–611), модель уходит в `AVC_EXCLUDE_MODEL` env (767). Снятие: успешный `set-stt-model` (915–919) или `model-progress phase=done` по карантинной модели (780–783). Прочее: `avcVersion: 2` маркера, `verify()` сверяет размеры файлов с маркером (564–592).

**Что переиспользуется для Whisper с HuggingFace**: весь конвейер скачивания/верификации/резюма/маркера/прогресса/карантина — целиком; `tools/ai-sha-update.cjs` и `scripts/validate-ai-assets.mjs` для снятия sha и проверки HF-URL.
**Что требует адаптации**: (1) `expectedFiles`-структура CTranslate2-модели (model.bin + config.json + tokenizer.json + vocabulary.*) — сейчас либо tar.bz2, либо ровно один файл (521–527); нужен `zip`/multi-file или упаковка в tar.bz2 при сборке манифеста; (2) `MIN_FILE_BYTES`/`CATALOG_FILES` (model-integrity 33–52) под имена файлов Whisper; (3) ONNX-protobuf-обход не применим к `model.bin` (CTranslate2) — нужен аналог (например, проверка «не HTML/не JSON + min-size + маркерные размеры», для VAD остаётся protobuf-обход); (4) `resolveSttModelId`-цепочка (stt-engines 47–58) и миграция старого дефолта (main.cjs 663–678) — обновить id-шники (Whisper-модель станет новым дефолтом).

---

## 5. Жизненный цикл

**Старт**: `app.whenReady` → `boot()` (`main.cjs:1412`): `setupAiIpc()` (1439, до окна) → `startAiWorker()` (1441). `startAiWorker` (734–863):
- `resolveModelsDir()` 702–708: конфиг `userData/models-dir.json` → dev `<appPath>/models` (если есть `models/stt`) → `userData/ai-models`;
- `requestedModel` = конфиг `sttModel` || `STT_MODEL_DEFAULT='gigaam-v3-russian'` (661, 737);
- `safeMode` из `userData/ai-safe-mode.json` (738);
- скрипт воркера: **packaged** `path.join(process.resourcesPath,'ai','ai-worker.cjs')`, **dev** `path.join(__dirname,'ai','ai-worker.cjs')` (740–742);
- Node: `findSystemNode()` 633–651: `AVC_NODE_EXE` → `resources/runtime-node/node.exe` (win) / `runtime-node/bin/node` → PATH;
- спавн: `child_process.fork(workerScript, [], { execPath: nodeExe, env: {AVC_MODELS_DIR, AVC_STT_MODEL, AVC_EXCLUDE_MODEL}, stdio:['ignore','pipe','pipe','ipc'], serialization:'advanced' })` (760–771) — т.е. в проде воркер = **чистый Node-процесс** (Electron запрещает napi external arraybuffers в своих процессах, `ai-worker.cjs:34–40`).

**Готовность**: воркер при загрузке модуля создаёт `VoicePipeline` (ai-worker 26–32; фейл → `worker-fatal` + exit(1)), через 100 мс — `initializeCoreThenDeferred()` (97–106) = `initializeServices()` (voice-pipeline 247–282): integrity-гейт запрошенной модели → карантин+fallback; integrity VAD; `stt.initialize()` (нативная загрузка). Статус летит событием `services-status`.

**Рестарты**: не-нативный краш → авто-ретрай до 3 попыток с бэкоффом 2/4 с (846–852); нативный краш <30 с → ветка карантина/safe-mode с рестартом через 1 с (825, 837); ручной `avc:ai:restart-worker` (990–1001); смена каталога моделей → `startAiWorker()` (1361). При `exit` все pending-запросы получают отказ (800–806).

**Shutdown**: `before-quit`: `app.isQuitting=true` (гасит автоперезапуски и уведомления) → `killProcessTree(aiWorker)` = **`taskkill /PID <pid> /T /F`** на Windows, group-kill на POSIX (1541–1550, урок 1.0.13 об осиротевших процессах) → `will-quit` страховка (1566–1569). В самом воркере `process.on('exit')` → `pipeline.shutdown()` (ai-worker 124–126).

**Orphan-риски**: main падает жёстко (не через quit) — воркер-Node осиротеет (windows: без taskkill дети не умирают автоматически); сегодня это купировано single-instance lock (1574–1585) и тем, что воркер без main рано или поздно получает закрытый IPC-канал. При добавлении Python-субпроцесса (ребёнок воркера) дерево углубляется: taskkill /T из main накрывает и внука (Python), но при аварийной смерти самого воркера Python должен уметь завершаться сам (стандартное решение: контроль закрытия stdin/родительского пайпа).

**Dev vs packaged**: dev — скрипты из `electron-app/ai/`, модели из `<appPath>/models`, Node из PATH; packaged — `resources/ai/**` + `resources/runtime-node/**` (extraResources из `ai-pack`, electron-builder.json 40–46), модели в `userData/ai-models`, Node из `resources/runtime-node/node.exe`. Урок v1.0.21: **никаких `require('./ai/...')` из asar** — `modelIntegrityPath` резолвится через `process.resourcesPath` (main.cjs 594–597); страж `scripts/check-packaged-layout.mjs` в CI ловит регресс. Сборка пака: `scripts/assemble-ai-pack.mjs` копирует `ai/*.cjs` (кроме llm/tts), `node_modules/sherpa-onnx-node` + `sherpa-onnx-<platform>-x64` (31–35, 65–79) и `runtime-node` (81–88).

---

## 6. UI-слой: что завязано на T-One/GigaAM

**Переживёт замену без изменений** (движко-агностично):
- `SttLiveTestCard` (`settings-dialog.tsx:1438–1646`): только `feedAudio/onSttPartial/onSttFinal/flushStt`; 16 кГц AudioContext (1499), ScriptProcessor 2048 (1501), автостоп 10 с (1519), честные ошибки. Работает с любым движком.
- `SttCatalogCard` (1130–1430): всё из `catalog()` (имя/описание/лицензия/размер/статусы/действия) — движко-агностично.
- `AiWorkerStatusCard` (1654–1790): статус/карантин/safe-mode/restart/reinstall — механика движко-агностична.
- MicSettings (453–774): движковый Select, устройства, gain, чувствительность, тест микрофона.
- `use-voice.ts`, `api.ts`, `preload.cjs` — см. §1.

**Завязано конкретно (нужно обновить):**
1. `settings-dialog.tsx:569` — hint: «В EXE «Авто» = локальный офлайн-движок **(T-One)**…».
2. `settings-dialog.tsx:582` — пункт Select «Локальный **(T-One, офлайн)**».
3. `settings-dialog.tsx:958–961` — web-режим: «офлайн-распознавание русской речи: **T-One Streaming или GigaAM, Silero VAD**…».
4. `settings-dialog.tsx:1044–1052` — диагностика: `activeModel === 'gigaam-v3-russian' || 'gigaam-v2-russian' ? 'GigaAM (точный)' : 'T-One Streaming (быстрый)'` — хардкод-маппинг id→название; для Whisper покажет «T-One». Правильнее читать `status.engine`/каталог.
5. `settings-dialog.tsx:1287–1292` — бейджи профилей только для `ru-fast`/`ru-accurate` (значения из манифеста; новые профили Whisper просто не получат бейджей — косметика).
6. `settings-dialog.tsx:1783` — `status?.engine === 'gigaam-offline' ? 'GigaAM (точный, офлайн)' : 'T-One Streaming (быстрый)'` — тот же хардкод.
7. `settings-dialog.tsx:1718` — текст карантина «…чтобы вернуть точность **GigaAM**».
8. `ai-setup-dialog.tsx:88–89` — предвыбор по железу по жёстким ключам `stt:gigaam-v3-russian` / `stt:t-one-russian`; 164–165 — описание «точная модель GigaAM v3… стриминговая T-One».
9. `voice-panel.tsx:176` — `localStt.engine === 'gigaam-offline' ? 'GigaAM' : 'T-One'`.
10. Дефолт/миграция дефолта — `main.cjs:661` (`STT_MODEL_DEFAULT`), `stt-engines.cjs:36` (`DEFAULT_STT_MODEL`), миграция «старого дефолта t-one» в `readModelsDirConfig` (670) — при смене дефолта на Whisper потребуется новая миграционная ветка (старый «gigaam-v3-russian» без `sttModelChosen` → сброс).

**Состояния/пропсы, которые сохраняются**: `settings.sttEngine` ('auto'|'browser'|'server'|'local'), `settings.aiProfile`, `voiceStatus`, `interimText`, `engineName`, `status.quarantine/safeMode/modelFallback/benchmark` — семантика не меняется.

---

## 7. Selftest-инфраструктура

| Файл | Что проверяет | Что будет при удалении `stt-engines.cjs`/`stt-service.cjs` |
|---|---|---|
| `tests/ai-selftest.cjs` | A: GigaAM init+decode (50–70); B: усечённый encoder → дочерний процесс ЖИВ, честный отказ (72–122, spawnSync); C: карантин+fallback через VoicePipeline (124–168); D: T-One init+decode (170–184) | A, B, D сломаются (require `stt-engines`/`stt-service` → SKIP/FAIL). C поломается частично: fallback-цель станет Whisper. Инвариант B (битый файл ⇒ процесс выживает) — обязательно перенести на Python-сервис. |
| `electron-app/tools/ai-stt-selftest.cjs` | инициализация T-One, decode 0.wav, стриминговый feed окнами 512, silence-no-final, dedup-final (30–105) | Поломается (прямой require `stt-service.cjs`, строка 15). Все 5 инвариантов переносимы на Python-сервис 1:1. |
| `electron-app/tools/ai-model-selftest.cjs` | install('stt') по манифесту, Range-resume (54–75), битый маркер (83–87) | Переживёт обновление манифеста; но использует legacy-ключ `components.stt` (40, 56) — в манифесте v4 этого компонента уже нет (только `models[]`), т.е. частично устарел уже сейчас. |
| `electron-app/tools/ai-main-selftest.cjs` | VoicePipeline вне Electron | **Уже сломан**: строка 26 требует `svc.tts`/`svc.llm` (удалены в 1.0.12) → всегда FAIL. |
| `electron-app/main.cjs --ai-selftest` (1484–1516) | спавн воркера как в проде + поллинг `status.ready.stt` до 120 с, отчёт в `tools/ai-main-selftest-report.json` | Переживёт замену движка полностью — это правильный интеграционный selftest. |
| `electron-app/tools/ai-sha-update.cjs` | снятие реальных sha256 в манифест | Reuse для Whisper. |
| `scripts/validate-ai-assets.mjs` + `ai/AI_ASSET_VALIDATION_REPORT.md` | HEAD/content-length всех URL манифеста, CI-гейт | Reuse для HF-URL. |
| `scripts/check-packaged-layout.mjs` | раскладка `resources/ai/*` + запрет `require('./ai/...')` в asar | Переживёт; потребует дополнения на `runtime-python` раскладку. |

Также: бенчмарк `voice-pipeline.cjs:318–354` использует `stt.decodeFileForTest` и тестовый WAV `models/stt/t-one-russian/0.wav` (319) — при удалении T-One нужен новый референсный WAV и `decodeFileForTest` в Python-адаптере (иначе ветка 333–340 деградирует до feed/flush-замера).

---

## 8. Риски миграции (топ-10)

1. **Потеря частичных результатов (partial) и ранних команд.** Единственный partial-источник сегодня — T-One (`stt-service.cjs:239–248`); early-команды (`voice-pipeline.cjs:36–48, 373–396`) и interimText (`use-voice.ts:667–682`) питаются от `stt-partial`. GigaAM их не даёт, faster-whisper — тоже (не стриминговый). Без компенсации тихо деградирует UX: нет промежуточного текста, «пауза/громче» не срабатывают до конца фразы. Нужна эмуляция partial (например, транскрипция накопленного буфера по таймеру ~200–400 мс) в Python-сервисе.
2. **Краш-политика не сработает для Python-фейлов.** `NATIVE_CRASH_CODES` + окно 30 с (`main.cjs:580, 808–811`) рассчитаны на смерть Node-воркера при загрузке модели. Краш Python-процесса воркер НЕ убивает — хендлер `feed` (ai-worker 80–85) вернёт `true`, а финал просто не придёт; пользователь увидит ошибку только через 10-секундный flush-guard PTT (`use-voice.ts:827–835`) или никогда (always-listening). Нужны health-check/таймауты на стыке воркер↔Python и проброс статуса в `services-status`.
3. **Целостностный слой ONNX-специфичен.** `CATALOG_FILES`/`MIN_FILE_BYTES` (`model-integrity.cjs:33–52`) и `onnxProtobufWalkOk` (113–170) не покрывают CTranslate2 `model.bin`; `catalogStatus.damaged` (`model-manager.cjs:211–217`) вызывает `checkModelIntegrity` только по старым правилам → Whisper-модель не пометится «повреждена», а значит урок 0xC0000409 (не давать битое рантайму) не переносится автоматически. VAD-проверку сохранить.
4. **Multi-file модель не лезет в загрузчик.** `_verifyAndExtract` поддерживает `tar.bz2` либо ровно один «голый» файл (`model-manager.cjs:521–539`); faster-whisper с HF — набор файлов. Без поддержки zip/multi-file `expectedFiles`-проверка (542–546) будет валить установку.
5. **Хардкоды id/движков в UI и дефолт-миграция.** `settings-dialog.tsx:1044–1048, 1783`, `voice-panel.tsx:176`, `ai-setup-dialog.tsx:88–89` покажут неверные названия/предвыбор; дефолт-логика `main.cjs:661, 670` и `stt-engines.cjs:36` — миграция «gigaam-v3-russian → whisper» требует новой ветки (иначе fallback-цепочка `resolveSttModelId`, `stt-engines.cjs:47–58,` будет выбирать несуществующие модели и ронять `initializeServices` в честный failed).
6. **RAM/минимальные ПК.** У текущих моделей `minRamBytes` 4/6 ГБ (`models-manifest.json:58, 94, 128`) и мастер учитывает это (`ai-setup-dialog.tsx:84–91`); faster-whisper small/medium потребует новых порогов и честной рекомендации, иначе на 4 ГБ-машинах получим OOM-краши Python (поведение вне защит Node-краш-политики — см. риск 2).
7. **Сборка/размер/антивирус.** Замена `sherpa-onnx-*` на встраиваемый CPython + wheels (`assemble-ai-pack.mjs:31–35, 65–79`) увеличивает пак и добавляет CI-шаги; свежераспакованный `python.exe` может попасть под тот же антивирусный шторм, что node.exe (урок 1.0.12, `main.cjs:729–733`) — нужен резолвер пути Python с ретраями (аналог `findSystemNode` 633–651) и диагностикой в `worker-state`.
8. **Гранд-чилд процесс и orphan-риск.** Python станет ребёнком воркера-Node. `killProcessTree` (`main.cjs:1541–1550`) накрывает дерево при штатном выходе, но при аварийной смерти воркера Python-субпроцесс должен завершаться сам (stdin-close/PID-мониторинг), иначе возврат «много процессов в диспетчере» (урок 1.0.13).
9. **Смена владельца VAD и таймингов.** VAD/хвосты/кулдауны/кольцо 1.2 с (`stt-service.cjs:192–236`, `stt-engines.cjs:105–256`) выверены релизом 1.0.15 (финал ≈0.5 с). Перенос VAD в Python (faster-whisper `vad_filter` или Silero) меняет задержки и семантику endpoint; PTT-режим `setCaptureMode` (`stt-service.cjs:318–337`) обязан быть воспроизведён в Python-адаптере, иначе регресс «STT работает через раз» (урок из кода, строки 71–75).
10. **Selftest/бенчмарк отвалятся и занизят доверие к релизу.** `tests/ai-selftest.cjs` A/B/D, `tools/ai-stt-selftest.cjs`, бенчмарк с `0.wav` (`voice-pipeline.cjs:319`) зависят от удаляемых модулей и файлов; при этом `tools/ai-main-selftest.cjs` уже сломан (строка 26). Без заблаговременного переноса golden-теста («Наруто двадцать серия» → final) приёмка релиза останется без автоматической проверки точности.

Бонус-наблюдение (мелочь): событие `worker-fatal` (`ai-worker.cjs:30`) не входит в `AI_EVENT_CHANNELS` (`main.cjs:565–571`) и молча теряется — при миграции стоит либо прокинуть, либо убрать.

---

## 9. Точки интеграции Python-сервиса (JSON-lines over stdio)

**Минимально инвазивный шов — реестр движков `electron-app/ai/stt-engines.cjs` (373–408)**, спроектированный ровно для этого («новый движок = один adapter + запись», строки 1–23):

1. **Новый адаптер `WhisperPythonEngine`** (новый файл, например `electron-app/ai/stt-whisper-python.cjs`), реализующий существующий интерфейс движка (`initialize/feed(int16 16кГц)/flush/resetUtterance/setCaptureMode/isReady/getMetrics/shutdown` + события `partial/final`; контракт описан в шапке `stt-engines.cjs:4–13`). Внутри:
   - спавн `python.exe -u stt_service.py` (резолвер пути: env `AVC_PYTHON_EXE` → `resources/runtime-python/python.exe` → PATH — копия паттерна `findSystemNode`, `main.cjs:633–651`; сам спавн из воркера, не из main);
   - протокол по stdin/stdout: воркер→Python `{type:'init', modelsDir, modelId, profile}` / `{type:'feed', pcm: <base64 Int16LE 16кГц mono>}` / `{type:'flush'}` / `{type:'capture', enabled}` / `{type:'shutdown'}`; Python→воркер `{type:'ready', modelLoadMs}` / `{type:'partial', utteranceId, text, ms}` / `{type:'final', utteranceId, text, reason, ms}` / `{type:'metrics', ...}` / `{type:'fatal', error}`. PCM-чанки 4 КБ (128 мс) → base64 ≈ 5.5 КБ — приемлемо; при необходимости буферизация/батчинг на стороне адаптера.
   - Python-сервис: буферизация PCM, VAD (Silero — можно переиспользовать уже скачиваемый `vad/silero-vad/silero_vad.onnx`, integrity-проверка та же), faster-whisper-инференс, эмуляция partial (таймер), PTT-режим, метрики.
2. **Регистрация**: запись в `ENGINES` (`stt-engines.cjs:373–388`) `whisper-python: { create: (opts) => new WhisperPythonEngine(opts) }` + `modelIds: ['whisper-…']`; `engineForModel`/`createSttEngine` (391–408) подхватят автоматически.
3. **Манифест**: заменить записи `models[]` в `models-manifest.json` на Whisper (URL HF, размеры, sha256, `engine:'whisper-python'`, `expectedFiles` CTranslate2, `minRamBytes`); `voice-pipeline.setSttModel`/`installComponents`/`getCatalog` не меняются (288–311, 172–209, 231–233).
4. **Главные вызовы `createSttEngine`** — `voice-pipeline.cjs:68, 259, 305` — не трогаются.
5. **main.cjs / preload / use-voice** — не трогаются (движко-агностичны). Только мелочи: новая миграция дефолта в `readModelsDirConfig` (663–678) и, опционально, `worker-fatal` в `AI_EVENT_CHANNELS` (565–571).

**Разделение ответственности после миграции:**
- Остаётся в **Node** (воркер): оркестрация, IPC-мост main↔worker↔renderer, скачивание/верификация/маркеры/карантин моделей (`model-manager` + `model-integrity`), конфиги (`models-dir.json`, `ai-safe-mode.json`), каталог/бенчмарк/статусы, EarlyCommandDetector, краш-политика Node-процесса.
- Уходит в **Python**: захват не трогаем (он в рендерере); VAD, сегментация/endpoint-тайминги, инференс faster-whisper, partial-эмуляция, PTT-семантика, собственные метрики.
- Удаляется: `GigaamOfflineEngine` (`stt-engines.cjs:85–354`), `STTService` (`stt-service.cjs:48–387`), sherpa-зависимости из пака (`assemble-ai-pack.mjs:31–35, 65–79`).

---

## Приложение: точные ответы на контрольные вопросы аудита

- **Где захватывается микрофон?** В рендерере: `use-voice.ts:418` (getUserMedia) + `use-voice.ts:599–644` (AudioContext 16 кГц → ScriptProcessor 2048) и `settings-dialog.tsx:1489–1542` (live-test). Воркер только потребляет Int16 PCM через `avc:ai:stt-feed`. Sherpa `Microphone` не используется.
- **Формат PCM на границе IPC**: Int16LE, mono, 16 000 Гц, чанки 2048 сэмплов (128 мс), мягкий лимитер micGain применён в рендерере.
- **Что произойдёт с удалением `stt-engines.cjs`**: `voice-pipeline.cjs:28` (require) упадёт при загрузке воркера → `worker-fatal` + exit(1) (`ai-worker.cjs:26–32`) → main покажет «воркер завершился» и исчерпает 3 ретрая; SttCatalogCard/live-test/master останутся, но всё локальное распознавание умрёт (web-движки не затронуты).
