# AI_ASSET_VALIDATION_REPORT

Дата: 2026-10-04T04:40:21.730Z
Манифест: /home/z/my-project/electron-app/ai/models-manifest.json (версия 3)
Режим: HEAD + частичная докачка (1 МБ)

| Ассет | Статус | HTTP | Content-Length | Accept-Ranges | Проба | Примечание |
|---|---|---|---|---|---|---|
| VAD: Silero VAD | **PASS** | 200 | 643854 | да | 643854 |  |
| STT: T-One Russian Streaming (ru-fast) (ru-fast) | **PASS** | 200 | 128468156 | да | 1052224 |  |
| STT: GigaAM v3 Russian RNNT int8 (ru-accurate) (ru-accurate) | **PASS** | 200 | 167388020 | да | 1059840 |  |
| STT mirror: gigaam-v3-russian | **PASS** | 200 | 99376 | — | 99376 |  |
| STT: GigaAM v2 Russian CTC int8 (ru-accurate) | **PASS** | 200 | 166917722 | да | 1059840 |  |
| Runtime: sherpa-onnx-node | **PASS** | — | — | — | — |  |

Итог: ВСЕ PASS

Правило (§117): продакшн-сборка останавливается при FAIL любого требуемого ассета.