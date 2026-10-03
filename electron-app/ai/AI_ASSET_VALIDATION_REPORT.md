# AI_ASSET_VALIDATION_REPORT

Дата: 2026-10-03T17:26:42.770Z
Манифест: /home/z/my-project/electron-app/ai/models-manifest.json
Режим: HEAD + частичная докачка (1 МБ)

| Ассет | Статус | HTTP | Content-Length | Accept-Ranges | Проба | Примечание |
|---|---|---|---|---|---|---|
| STT: T-One Russian Streaming CTC | **PASS** | 200 | 128468156 | да | 1059840 |  |
| TTS: Ирина (женский) | **PASS** | 200 | 67153308 | да | 1059840 |  |
| TTS: Руслан (мужской) | **PASS** | 200 | 67210684 | да | 1059840 |  |
| TTS: Дмитрий (мужской) | **PASS** | 200 | 67188551 | да | 1052224 |  |
| LLM: Qwen3-0.6B (семантический роутер команд) Q4_K_M | **PASS** | 200 | 484220320 | да | 1064960 |  |
| LLM alt: Qwen3-0.6B Q8_0 (официальный репозиторий Qwen) | **PASS** | 200 | 639446688 | да | 1053652 |  |
| Runtime: sherpa-onnx-node | **FAIL** | — | — | — | — | sherpa-onnx-node не установлен |
| Runtime: node-llama-cpp (llama.cpp) | **FAIL** | — | — | — | — | node-llama-cpp не установлен в electron-app |

Итог: 2 FAIL, 0 BLOCKED

Правило (§117): продакшн-сборка останавливается при FAIL любого требуемого ассета.