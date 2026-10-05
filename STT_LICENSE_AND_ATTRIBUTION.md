# STT License and Attribution

Дата: 2026-10-05. Относится к замене STT в v1.0.22 (faster-whisper по образцу Mantella).

## 1. Что использовано от Mantella и что нет

- Mantella (art-from-the-machine/Mantella) лицензирована **AGPL-3.0**.
- AVC-Anime **НЕ копирует и НЕ адаптирует исходный код Mantella** (ни Python, ни конфигов).
- Из Mantella взяты **поведенческий контракт и значения параметров** (верифицированы из её исходников и задокументированы в `MANTELLA_STT_RESEARCH.md`): выбор faster-whisper как локального движка, модель `base` по умолчанию, внешний Silero-VAD (окно 512 @16кГц, порог 0.4, пауза 0.25 с, cap 30 с, pre-roll), `beam_size=5`, `vad_filter=False`, явный язык, CPU → `compute_type="float32"`, CUDA без передачи compute_type.
- Реализация (Python-сервис `stt_service.py`, Node-адаптер `whisper-python-engine.cjs`) написана независимо. Использование одних и тех же открытых зависимостей и совместимого поведения не является копированием исходного кода Mantella (см. спецификацию владельца, Phase 10).

Вывод: лицензионных обязательств AGPL-3.0 перед Mantella у AVC-Anime НЕ возникает. Атрибуция-ссылка на источник вдохновения приведена в `MANTELLA_STT_RESEARCH.md`.

## 2. Лицензии зависимостей STT-слоя

| Компонент | Версия (пин) | Лицензия | Назначение |
|---|---|---|---|
| faster-whisper | 1.0.3 | MIT | обёртка Whisper на CTranslate2 |
| CTranslate2 | 4.4.0 | MIT | инференс (нативный) |
| onnxruntime | 1.17.3 | MIT | Silero VAD |
| silero_vad.onnx (файл) | — | MIT | модель VAD (snakers4/silero-vad, распространяется в т.ч. через релизы sherpa-onnx) |
| huggingface_hub | 0.24.7 | Apache-2.0 | скачивание модели (selftest/CI) |
| tokenizers | 0.19.1 | Apache-2.0 | токенизатор Whisper |
| numpy | 1.26.4 | BSD-3-Clause | аудио-массивы |
| PyAV | 12.3.0 | BSD-2-Clause | декодер аудио (не используется нашим протоколом, зависимость fw) |
| Модели Whisper (OpenAI, конвертация Systran) | — | MIT | веса моделей faster-whisper-tiny/base/small/medium/large-v3 |

Все компоненты допускают коммерческое распространение в составе приложения.

## 3. Obligations

- MIT/BSD/Apache: сохранение copyright-уведомлений — обеспечивается тем, что все пакеты распространяются через pip/папки авторов (мы не перераспространяем исходники в бинарной документации); файл LICENSE внутри пакетов сохраняется pip-установкой.
- Модели Whisper: лицензия MIT (репозиторий openai/whisper); конвертированные CTranslate2-версии (Systran) — MIT. Мы скачиваем их с пиновой ревизии HuggingFace при установке через наш model-manager (SHA-256 контроль) — модель НЕ бандлится в EXE.
- Silero VAD: MIT (silero-vad, snakers4).

## 4. Не использовано

- Код Mantella (AGPL-3.0) — полностью.
- OpenAI Whisper API (удалённый) — исключён требованием офлайна.
- Moonshine (дефолтный STT Mantella, англоцентричный) — не применим к русскому.
