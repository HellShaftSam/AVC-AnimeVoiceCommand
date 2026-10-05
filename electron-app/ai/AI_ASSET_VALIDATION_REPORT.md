# AI_ASSET_VALIDATION_REPORT

Дата: 2026-10-05T15:24:20.152Z
Манифест: /home/z/my-project/electron-app/ai/models-manifest.json (версия 5)
Режим: HEAD + частичная докачка (1 МБ)

| Ассет | Статус | HTTP | Content-Length | Accept-Ranges | Проба | Примечание |
|---|---|---|---|---|---|---|
| VAD: Silero VAD | **PASS** | 200 | 643854 | да | 643854 |  |
| STT: faster-whisper-base :: model.bin | **PASS** | 200 | 145217532 | да | 1051232 |  |
| STT: faster-whisper-base :: config.json | **PASS** | 200 | 2309 | да | 2309 |  |
| STT: faster-whisper-base :: tokenizer.json | **PASS** | 200 | 2203239 | да | 1060980 |  |
| STT: faster-whisper-base :: vocabulary.txt | **PASS** | 200 | 459861 | да | 459861 |  |
| STT: faster-whisper-tiny :: model.bin | **PASS** | 200 | 75538270 | да | 1063671 |  |
| STT: faster-whisper-tiny :: config.json | **PASS** | 200 | 2249 | да | 2249 |  |
| STT: faster-whisper-tiny :: tokenizer.json | **PASS** | 200 | 2203239 | да | 1053614 |  |
| STT: faster-whisper-tiny :: vocabulary.txt | **PASS** | 200 | 459861 | да | 459861 |  |
| STT: faster-whisper-small :: model.bin | **PASS** | 200 | 483546902 | да | 1050268 |  |
| STT: faster-whisper-small :: config.json | **PASS** | 200 | 2370 | да | 2370 |  |
| STT: faster-whisper-small :: tokenizer.json | **PASS** | 200 | 2203239 | да | 1063667 |  |
| STT: faster-whisper-small :: vocabulary.txt | **PASS** | 200 | 459861 | да | 459861 |  |
| STT: faster-whisper-medium :: model.bin | **PASS** | 200 | 1527906378 | да | 1057007 |  |
| STT: faster-whisper-medium :: config.json | **PASS** | 200 | 2257 | да | 2257 |  |
| STT: faster-whisper-medium :: tokenizer.json | **PASS** | 200 | 2203239 | да | 1052047 |  |
| STT: faster-whisper-medium :: vocabulary.txt | **PASS** | 200 | 459861 | да | 459861 |  |
| STT: faster-whisper-large-v3 :: model.bin | **PASS** | 200 | 3087284237 | да | 1053652 |  |
| STT: faster-whisper-large-v3 :: config.json | **PASS** | 200 | 2394 | да | 2394 |  |
| STT: faster-whisper-large-v3 :: tokenizer.json | **PASS** | 200 | 2480617 | да | 1062256 |  |
| STT: faster-whisper-large-v3 :: vocabulary.json | **PASS** | 200 | 1068114 | да | 1064960 |  |
| Runtime: python-runtime (faster-whisper) | **SKIP** | — | — | — | — | python-runtime не собран локально (в CI — отдельный шаг сборки) |

Итог: ВСЕ PASS

Правило (§117): продакшн-сборка останавливается при FAIL любого требуемого ассета.