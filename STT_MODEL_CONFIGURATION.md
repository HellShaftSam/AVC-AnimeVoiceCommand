# STT Model Configuration — верифицированная конфигурация (Mantella → AVC-Anime)

Источник: `MANTELLA_STT_RESEARCH.md` (Mantella main @ c0c1ae6db01f, release v0.14). Все параметры ниже либо воспроизводят Mantella 1:1, либо являются ЗАДОКУМЕНТИРОВАННЫМ отклонением.

## 1. Инференс (faster-whisper)

| Параметр | Mantella (исходник) | AVC-Anime | Отклонение |
|---|---|---|---|
| Библиотека | `faster_whisper.WhisperModel` | то же | нет |
| Модель по умолчанию | `base` (`whisper_model_size`, stt_definitions.py) | `faster-whisper-base` | нет (тот же размер, локальный каталог) |
| device | строка конфига, default `cpu`, опции `cpu/cuda`, без авто-детекта | `cpu` (env `AVC_STT_DEVICE`, опция `cuda`) | нет |
| compute_type (CPU) | `"float32"` явно | `"float32"` | нет |
| compute_type (CUDA) | не передаётся (= "default") | не передаётся | нет |
| language | явный ISO-код (stt_language='default' → язык приложения) | `ru` (язык приложения ru) | нет (та же механика) |
| beam_size | 5 | 5 | нет |
| vad_filter (faster-whisper) | `False` (внешний VAD) | `False` | нет |
| task | `transcribe` | `transcribe` | нет |
| condition_on_previous_text / temperature | не переопределяются (дефолты fw) | не переопределяются | нет |
| initial_prompt | промпт с игровым контекстом Mantella | `None` | **ДА**: источника игрового контекста в AVC-Anime нет; добавление промпта — отдельная задача |
| download_root | не задаётся (HF-кэш) | локальный каталог модели (`userData/ai-models/stt/<id>`) | **ДА**: офлайн-гарантия + persistence между апдейтами; модель скачает наш model-manager с SHA-256 |
| Фильтр галлюцинаций | ignore-list сегментов | минимальный ru/en список на тишине («Спасибо за просмотр» и т.п.) | аналог (список наш) |

## 2. VAD и сегментация (Silero — внешний, как в Mantella)

| Параметр | Mantella | AVC-Anime |
|---|---|---|
| Движок | `silero-vad-lite` (ONNX) | onnxruntime + `silero_vad.onnx` **v4** (тот же файл уже в дистрибутиве) |
| Sample rate | 16000 | 16000 |
| Чанк | 512 сэмплов (32 мс) | 512 |
| Порог речи | 0.4 (`audio_threshold`) | 0.4 |
| Конец речи | 0.25 с тишины (`pause_threshold`) | 0.25 с |
| Кап непрерывной фразы | 30 с (`listen_timeout`) | 30 с |
| Pre-roll | 5×512 сэмплов | 5×512 |
| Мин. длительность фразы | — | 300 мс (наследие пайплайна, защита от щелчков) |

## 3. Каталог моделей (манифест v5, пиновые ревизии HuggingFace)

| id | HF repo @ revision | model.bin (size, sha256) | Всего | Назначение |
|---|---|---|---|---|
| faster-whisper-tiny | Systran/faster-whisper-tiny @ d90ca5fe… | 75 538 270, dcb76c65… | ~78 МБ | быстрый/слабый ПК |
| **faster-whisper-base** | Systran/faster-whisper-base @ ebe41f70… | 145 217 532, d01c3014… | ~148 МБ | **дефолт (Mantella)** |
| faster-whisper-small | Systran/faster-whisper-small @ 536b0662… | 483 546 902, 3e305921… | ~486 МБ | качество |
| faster-whisper-medium | Systran/faster-whisper-medium @ 08e178d4… | 1 527 906 378, 9b45e100… | ~1.53 ГБ | максимум на CPU |
| faster-whisper-large-v3 | Systran/faster-whisper-large-v3 @ edaa852e… | 3 087 284 237, 69f74147… | ~3.09 ГБ | энтузиаст/CUDA |

Проверка целостности: SHA-256 для LFS-файлов (model.bin) при скачивании + размеры в маркере `.avc-installed.json` + пред-полётная проверка перед загрузкой. Для мелких git-файлов (config/tokenizer/vocabulary) — размер (LFS-sha у HF отсутствует; НЕ выдумываем checksum'и).

Исключены из каталога (с обоснованием): `*.en`, `distil-*` (только английский), `Numbat/faster-skyrim-whisper-base.en` (en-only, игровой), `whisper-1` (удалённый OpenAI API — нарушает офлайн-требование).

## 4. Зависимости (requirements.txt)

| Пакет | Версия | Основание |
|---|---|---|
| faster-whisper | **1.0.3** | пин Mantella (requirements.txt) |
| ctranslate2 | **4.4.0** | Mantella не пинует (диапазон fw 1.0.3: >=4.0,<5); последний стабильный 4.x |
| onnxruntime | **1.17.3** | Mantella не пует (>=1.14,<2); выбран для silero v4 + py3.11/3.12 wheels |
| huggingface_hub | **0.24.7** | пин Mantella `<0.25` |
| numpy | **1.26.4** | Mantella пинует 1.25.0; **отклонение**: 1.25.0 не имеет cp312-колёс (dev-среда py3.12); API 1.x идентичен |
| tokenizers | **0.19.1** | диапазон fw 1.0.3 (>=0.13,<1) |
| av | **12.3.0** | зависимость fw (>=11); нужен только для decode файлов, у нас PCM-протокол |

Python-рантайм: **embeddable CPython 3.11.9 (win-amd64)** в EXE; dev — системный python3.

## 5. Аудио-вход

Без изменений по аудиту: рендерер отдаёт Int16 PCM 16 кГц mono (ScriptProcessor 2048 ≈ 128 мс). Python получает b64(Int16LE), конвертирует во float32 `/32768` (нормировка faster-whisper). Ресемплинг НЕ выполняется нигде: 16 кГц — родной формат и VAD, и Whisper.

## 6. Что НЕ трогаем

LLM/TTS (убраны в 1.0.12), парсер команд, early-command паттерны, история, алиасы, аккаунт, updater, тему.
