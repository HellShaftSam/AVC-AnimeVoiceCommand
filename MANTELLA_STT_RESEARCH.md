# MANTELLA STT RESEARCH — верифицированный отчёт по локальному Whisper-STT

**Проект-образец:** [art-from-the-machine/Mantella](https://github.com/art-from-the-machine/Mantella) (Skyrim/Fallout 4 мод: Speech-to-Text → LLM → TTS)
**Дата отчёта:** 2026-10-05 (14:33 UTC)
**Метод:** все факты получены из публичных исходников (raw.githubusercontent.com + официальный GitHub REST API + мелкий git-clone `--depth 1`) анонимно, без токена. Каждый факт снабжён URL и вербатим-цитатой.

| Параметр | Значение (верифицировано) | Источник |
|---|---|---|
| default_branch | `main` | https://api.github.com/repos/art-from-the-machine/Mantella |
| Latest release | `v0.14` (published `2026-04-21T16:12:17Z`, prerelease: false) | https://api.github.com/repos/art-from-the-machine/Mantella/releases/latest |
| Reference commit (HEAD main) | `c0c1ae6db01f3c2a14dbab8ec5c3e6419e4f6bac` — «Log time to tts response (#735)», 2026-07-16T06:15:51Z | https://api.github.com/repos/art-from-the-machine/Mantella/commits/main |
| repo pushed_at | `2026-07-16T06:15:54Z` | там же |
| stars / forks | 414 / 104 | там же |
| License (SPDX) | **AGPL-3.0** («GNU Affero General Public License v3.0», файл LICENSE = 34 523 байта) | API + https://raw.githubusercontent.com/art-from-the-machine/Mantella/main/LICENSE |
| Git-клон сверен | `git log -1` в клоне = `c0c1ae6…` — совпадает с API HEAD | локальный shallow clone |

> Все цитаты ниже — вербатим из файлов на `main` @ `c0c1ae6` (sha blob'ов сверены с официальным деревом `git/trees/main?recursive=1`, `truncated: false`, 275 записей).

---

## 1. Файловая карта STT (официальное дерево)

Источник: https://api.github.com/repos/art-from-the-machine/Mantella/git/trees/main?recursive=1

STT/речевые/конфиг-файлы, найденные по ключевым словам (speech, transcri, stt, whisper, moonshine, config, language, record, audio, microphone, requirements, vad, ptt):

| Файл | Размер | Роль |
|---|---|---|
| `src/stt/stt.py` | 30 065 B | **Весь STT: Whisper + Moonshine + VAD + микрофон** (blob `e3cbd39806`) |
| `src/stt/ptt_controller.py` | 2 371 B | Push-to-talk через Win32 `GetAsyncKeyState` (blob `e62fdcf236`) |
| `src/config/definitions/stt_definitions.py` | 13 191 B | **Конфиг-дефолты и списки моделей STT** (blob `6d314a797b`) |
| `src/config/config_loader.py` | 26 989 B | Чтение config.ini → свойства `config.stt_*` |
| `src/config/mantella_config_value_definitions_new.py` | 18 000 B | АКТИВНЫЙ набор конфиг-групп (импортируется в config_loader.py:10) |
| `src/config/mantella_config_value_definitions_classic.py` | 11 447 B | Легаси-набор (не используется config_loader'ом) |
| `src/config/config_values.py`, `src/config/config_file_writer.py` | — | Запись/чтение config.ini |
| `data/language_support.csv` | 578 B | Коды языков (включая `ru,Russian,Привет`) |
| `requirements.txt` | 765 B | Пины зависимостей (blob `75ff3b8d84`) |
| `tests/stt/test_ptt_controller.py` | 3 157 B | Единственный тест в tests/stt/ |

**НЕ НАЙДЕНО в репозитории:** `config.ini`, `default_config.ini`, `config_template.ini` — файла-шаблона НЕТ. config.ini **генерируется при первом запуске** из definitions:

```python
# src/config/config_loader.py:22,34-35
def __init__(self, mygame_folder_path: str, file_name='config.ini', game_override: GameEnum | None = None):
    ...
    if not os.path.exists(self.__file_name):
        logger.log(24,"Cannot find 'config.ini'. Assuming first time usage of MantellaSoftware and creating it.")
```

Единственная точка создания STT: `src/game_manager.py:244` → `self.__stt = Transcriber(self.__config)`.

---

## 2. Requirements-пины (вербатим)

Источник: https://raw.githubusercontent.com/art-from-the-machine/Mantella/main/requirements.txt (заголовок файла: `# python 3.11`)

```text
faster-whisper==1.0.3
pyaudio==0.2.13
soundfile==0.12.1
numpy==1.25.0
huggingface_hub<0.25
sounddevice==0.5.1
silero-vad-lite
git+https://github.com/usefulsensors/moonshine.git@2f6282347950c8d711bd7319287babb87ec5a92d#subdirectory=moonshine-onnx
```

| Пакет | Пин в requirements.txt Mantella | Комментарий (верифицировано) |
|---|---|---|
| faster-whisper | `==1.0.3` | прямой пин |
| **ctranslate2** | **НЕ ЗАПИНЕН (ОТСУТСТВУЕТ в файле)** | транзитивно через faster-whisper 1.0.3: `ctranslate2<5,>=4.0` (https://pypi.org/pypi/faster-whisper/1.0.3/json, requires_dist) |
| sounddevice | `==0.5.1` | используется STT-путём (InputStream) |
| soundfile | `==0.12.1` | в requirements; в src/stt/ не импортируется (см. §9) |
| numpy | `==1.25.0` | буферы float32 |
| **onnxruntime** | **НЕ ЗАПИНЕН напрямую** | транзитивно: faster-whisper 1.0.3 требует `onnxruntime<2,>=1.14` (PyPI metadata); также нужен moonshine-onnx |
| **silero-vad-lite** | **БЕЗ пина версии** | PyPI: `silero-vad-lite` 0.4.0 (https://pypi.org/pypi/silero-vad-lite/json); проект = https://github.com/daanzu/py-silero-vad-lite |
| moonshine-onnx | git-пин по коммиту `2f6282347950c8d711bd7319287babb87ec5a92d` | устанавливается из usefulsensors/moonshine, subdirectory `moonshine-onnx` |
| pyaudio | `==0.2.13` | **в src/ НЕ используется** — grep по всему клону `pyaudio` в src/ и main.py: 0 совпадений (легаси-остаток) |
| huggingface_hub | `<0.25` | ограничение версии hub-клиента |

Дополнительно: `tests/requirements-ci.txt` тоже пинует `faster-whisper==1.0.3` (https://raw.githubusercontent.com/art-from-the-machine/Mantella/main/tests/requirements-ci.txt).

---

## 3. Verified configuration (сводная таблица)

Источники: `src/config/definitions/stt_definitions.py` (дефолты), `src/stt/stt.py` (применение), `src/config/config_loader.py` (маппинг). Всё с main @ c0c1ae6.

| Параметр | Значение | Доказательство (вербатим) |
|---|---|---|
| **default Whisper model** | **`base`** | stt_definitions.py:100: `ConfigValueSelection("whisper_model_size", "Whisper Model", description, "base", options, allows_free_edit=True, ...)` |
| **supported model sizes** | `tiny, tiny.en, base, base.en, Numbat/faster-skyrim-whisper-base.en, small, small.en, distil-small.en, medium, medium.en, distil-medium.en, large-v1, large-v2, large-v3, distil-large-v2, distil-large-v3, whisper-1` + свободный ввод (любой HF id, `allows_free_edit=True`) | stt_definitions.py:94-99 |
| **STT service default** | **`Moonshine`** (!), options `["Moonshine", "Whisper"]` | stt_definitions.py:41: `ConfigValueSelection("stt_service", "STT Service", description, "Moonshine", options, allows_free_edit=False)` |
| **compute_type** | **CPU: явный `"float32"`; CUDA: НЕ передаётся** → faster-whisper default `"default"` | stt.py:113 vs stt.py:108 (цитаты в §4) |
| **device logic** | строка из конфига `process_device`, options `["cpu","cuda"]`, default **`"cpu"`**; без авто-детекта | stt_definitions.py:146: `ConfigValueSelection("process_device", "Whisper Process Device", description,"cpu",["cpu","cuda"], ...)` |
| **language** | **всегда явный ISO-код, НЕ auto**: `stt_language` default `"default"` → резолвится в главный `language` Mantella (default `"en"`); опции включают `"ru"` | stt_definitions.py:135 + config_loader.py:249-251 (цитата в §5) |
| task | `"translate"` если `stt_translate==1`, иначе `"transcribe"` (default False → transcribe) | stt.py:47 |
| **beam_size** | **`5`** (явно) | stt.py:253 |
| **vad_filter faster-whisper** | **`False`** (явно) — VAD внешний | stt.py:253 |
| **VAD** | **внешний Silero**: пакет `silero-vad-lite` (`from silero_vad_lite import SileroVAD`), `SileroVAD(16000)`, чанк 512 | stt.py:22,37-38,130 |
| initial_prompt | передаётся (строка-подсказка контекстом) | stt.py:253 |
| temperature | НЕ переопределён → дефолт faster-whisper 1.0.3 `[0.0, 0.2, 0.4, 0.6, 0.8, 1.0]` | faster_whisper/transcribe.py (v1.0.3) сигнатура |
| condition_on_previous_text | НЕ переопределён → дефолт `True` | там же |
| without_timestamps | НЕ передаётся → дефолт `False` | там же |
| **microphone** | **sounddevice.InputStream**: samplerate **16000**, channels **1**, blocksize **512**, dtype **float32**, latency `'low'` | stt.py:340-348 (цитата в §7) |
| endpointing | пауза тишины `pause_threshold` = **0.25 с** (default), порог VAD `audio_threshold` = **0.4**, hard-cap `listen_timeout` = **30 с**, pre-roll lookback 5×512 сэмплов (~0.16 с) | stt_definitions.py:20,49,72 + stt.py:40,451-508 |
| **download_root** | **НЕ ПЕРЕДАЁТСЯ** (ОТСУТСТВУЕТ в вызове) → дефолт faster-whisper `download_root=None` → стандартный HuggingFace-кэш | stt.py:108,113; faster_whisper/transcribe.py v1.0.3: `download_root: Optional[str] = None` |
| external whisper (server) | `external_whisper_service` default False; `whisper_url` default `"OpenAI"`, options `["OpenAI","Groq","whisper.cpp"]`, свободный URL | stt_definitions.py:119,130 |

Вербатим списка моделей (stt_definitions.py:87-100):

```python
@staticmethod
def get_whisper_model_size_config_value() -> ConfigValue:
    description = """The size of the Whisper model used. Some languages require larger models. The base.en model works well enough for English.
                    See here for a comparison of languages and their Whisper performance: 
                    https://github.com/openai/whisper#available-models-and-languages
                    
                    faster-skyrim-whisper-base.en is trained on Skyrim dialogue. It is more accurate in transcribing Skyrim names and locations:
                    https://github.com/mikastamm/skyrim-whisper-base.en"""
    options = ["tiny", "tiny.en", 
               "base", "base.en", "Numbat/faster-skyrim-whisper-base.en",
               "small", "small.en", "distil-small.en", 
               "medium", "medium.en", "distil-medium.en", 
               "large-v1", "large-v2", "large-v3", "distil-large-v2", "distil-large-v3", 
               "whisper-1"]
    return ConfigValueSelection("whisper_model_size", "Whisper Model", description, "base", options, allows_free_edit=True, tags=[ConfigValueTag.advanced,ConfigValueTag.share_row])
```

---

## 4. Инициализация модели — ВЕРБАТИМ (весь блок)

Источник: https://raw.githubusercontent.com/art-from-the-machine/Mantella/main/src/stt/stt.py (строки 94-131)

```python
if self.stt_service == 'whisper' or not has_moonshine:
    # if using faster_whisper, load model selected by player, otherwise skip this step
    if self.stt_service != 'whisper':
        logger.error("Moonshine selected but moonshine not installed, trying whisper")

    if not self.external_whisper_service:
        if self.process_device == 'cuda':
            logger.error(f'''Depending on your NVIDIA CUDA version, setting the Whisper process device to `cuda` may cause errors! For more information, see here: https://github.com/SYSTRAN/faster-whisper#gpu''')
            try:
                self.transcribe_model = WhisperModel(self.whisper_model, device=self.process_device)
            except Exception as e:
                utils.play_error_sound()
                raise e
        else:
            self.transcribe_model = WhisperModel(self.whisper_model, device=self.process_device, compute_type="float32")
else:
    # ... ветка Moonshine, см. §8
```

**Ключевые выводы (только из кода выше):**
- Вызов ровно **два** (grep по всему клону `WhisperModel(` — только stt.py:108 и stt.py:113).
- `model_size_or_path` = строка из конфига (`config.whisper_model` ← `whisper_model_size`, config_loader.py:247) — т.е. **HF model id** (например `base`), скачивается быстрее-whisper'ом с HF Hub.
- **CUDA:** `WhisperModel(model, device="cuda")` — `compute_type` НЕ указан. Дефолт faster-whisper 1.0.3 (https://raw.githubusercontent.com/SYSTRAN/faster-whisper/v1.0.3/faster_whisper/transcribe.py, строки 91-94):

  ```python
  compute_type: str = "default",
  cpu_threads: int = 0,
  num_workers: int = 1,
  download_root: Optional[str] = None,
  ```
  Семантика `"default"` по докам CTranslate2 (https://raw.githubusercontent.com/OpenNMT/CTranslate2/master/docs/quantization.md, строка 56): `* \`default\`: keep the same quantization that was used during model conversion` (+ задокументированные фолбэки типов на неподдерживаемых бэкендах, строка 79 того же файла).
- **CPU:** `WhisperModel(model, device="cpu", compute_type="float32")` — float32 задан явно.
- `download_root` НЕ передаётся ни в одном вызове → модели кэшируются стандартным HuggingFace-кэшем (`download_root=None` в faster-whisper = расположение по умолчанию HF Hub).
- Ошибка инициализации на CUDA: `utils.play_error_sound()` + `raise e` (см. §10).

---

## 5. Язык: явный, НЕ auto — вербатим цепочки

1) Конфиг (`stt_definitions.py:133-135`):

```python
@staticmethod
def get_stt_language_config_value() -> ConfigValue:
    description = """The player's spoken language."""
    return ConfigValueSelection("stt_language","Whisper STT Language",description,"default",["default","en", "ar", "cs", "da", "de", "el", "es", "fi", "fr", "hi", "hu", "it", "ja", "ko", "nl", "pl", "pt", "ro", "ru", "sv", "sw", "uk", "ha", "tr", "vi", "yo"], tags=[ConfigValueTag.advanced,ConfigValueTag.share_row])
```

2) Резолв `"default"` → главный язык Mantella (`config_loader.py:247-252`):

```python
self.whisper_model = self.__definitions.get_string_value("whisper_model_size")
self.whisper_process_device = self.__definitions.get_string_value("process_device")
self.stt_language = self.__definitions.get_string_value("stt_language")
if (self.stt_language == 'default'):
    self.stt_language = self.language
self.stt_translate = self.__definitions.get_bool_value("stt_translate")
```

где `self.language` (`config_loader.py:182`) — главный язык Mantella (`language_definitions.py`: default `"en"`, список включает `"ru"`).

3) Передача в инференс (`stt.py:47` и `stt.py:253`):

```python
self.task = "translate" if config.stt_translate == 1 else "transcribe"
...
segments, _ = self.transcribe_model.transcribe(audio, task=self.task, language=self.language, beam_size=5, vad_filter=False, initial_prompt=prompt)
```

**Вывод:** `language=None` (авто-детект faster-whisper) в Mantella **недостижим** — язык всегда явная строка ISO-639-1. `"ru"` поддержан и в списке `stt_language`, и в главном `language` (data/language_support.csv: `ru,Russian,Привет`).

---

## 6. Вызов транскрипции — параметры и дефолты

Mantella (`stt.py:250-257`):

```python
@utils.time_it
def whisper_transcribe(self, audio: np.ndarray, prompt: str):
    if self.transcribe_model: # local model
        segments, _ = self.transcribe_model.transcribe(audio, task=self.task, language=self.language, beam_size=5, vad_filter=False, initial_prompt=prompt)
        result_text = ' '.join(segment.text for segment in segments)
        if utils.clean_text(result_text) in self.__ignore_list: # common phrases hallucinated by Whisper
            return ''
        return result_text
```

| Параметр | Mantella | Дефолт faster-whisper 1.0.3 (https://raw.githubusercontent.com/SYSTRAN/faster-whisper/v1.0.3/faster_whisper/transcribe.py) |
|---|---|---|
| `task` | из конфига (transcribe/translate) | `"transcribe"` |
| `language` | явный ISO-код (см. §5) | `None` = авто-детект |
| `beam_size` | **5 (явно)** | `5` |
| `vad_filter` | **False (явно)** | `False` |
| `initial_prompt` | строка-промпт | `None` |
| `temperature` | не передан | `[0.0, 0.2, 0.4, 0.6, 0.8, 1.0]` |
| `condition_on_previous_text` | не передан | `True` |
| `without_timestamps` | не передан | `False` |
| `download_root` | не передан (и в конструкторе) | `None` |

`__ignore_list` — фильтр галлюцинаций Whisper (stt.py:92):

```python
self.__ignore_list = ['', 'thank you', 'thank you for watching', 'thanks for watching', 'the transcript is from the', 'the', 'thank you very much', "thank you for watching and i'll see you in the next video", "we'll see you in the next video", 'see you next time']
```

---

## 7. Audio flow (verbatim summary)

Константы (stt.py:37-41):

```python
SAMPLING_RATE = 16000
CHUNK_SIZE = 512  # Required chunk size for Silero VAD
CHUNK_DURATION = CHUNK_SIZE / SAMPLING_RATE  # Explicit calculation of chunk duration in seconds
LOOKBACK_CHUNKS = 5  # Number of chunks to keep in buffer when not recording
MIN_PTT_DURATION = 0.3  # Minimum seconds of audio to accept from a PTT press
```

Захват микрофона (stt.py:339-349) — **sounddevice.InputStream** (libportaudio), НЕ pyaudio:

```python
from sounddevice import InputStream
self._stream = InputStream(
    samplerate=self.SAMPLING_RATE,
    channels=1,
    blocksize=self.CHUNK_SIZE,
    dtype=np.float32,
    callback=self._create_input_callback(self._audio_queue),
    latency = 'low'
)
self._stream.start()
```

Колбэк кладёт `(chunk, status)` в `queue.Queue`; отдельный daemon-поток `_process_audio` разбирает очередь (stt.py:360-388) и дальше — два режима:

**A. VAD-режим (по умолчанию, `ptt_enabled=False`) — stt.py:451-508:**
1. Чанк конкатенируется в буфер; пока речь не начата, буфер обрезается до lookback `5×512 = 2560` сэмплов (~0.16 с pre-roll).
2. **Каждый чанк 512 сэмплов прогоняется через внешний Silero VAD**: `probability = self.vad.process(chunk)` (stt.py:471).
3. Старт речи: `probability > self.audio_threshold` (default **0.4**) → `_speech_detected = True`.
4. Конец речи: `probability <= threshold` непрерывно дольше `pause_threshold` (default **0.25 с**, `stt_definitions.py:49`: `ConfigValueFloat("pause_threshold","Pause Threshold", description, 0.25, 0, 999, ...)`) → `_finalize_transcription()`.
5. Hard-cap: буфер дольше `listen_timeout` (**30 с**, `stt_definitions.py:72`: `ConfigValueInt("listen_timeout","Listen Timeout", description, 30, 0, 999, ...)`) → принудительная финализация.
6. Proactive-режим (опция `proactive_mic_mode`, default False): промежуточная транскрипция каждые `refresh_freq = min_refresh_secs / CHUNK_DURATION` чанков (`min_refresh_secs` default **0.3**); 10 пустых подряд → `Could not transcribe input`.

**B. PTT-режим (`ptt_enabled`, default False, hotkey default `"V"`) — stt.py:413-448:**
- «When PTT is enabled, VAD-based detection is completely bypassed» (docstring stt.py:417).
- Пока клавиша зажата, аудио копится; на отпускании — транскрипция одним куском, если длительность ≥ 0.3 с (`MIN_PTT_DURATION`); таймаут зажатия — тот же `listen_timeout`. Проверка клавиши — Win32 `GetAsyncKeyState` (ptt_controller.py:76-84, вербатим):

```python
def is_pressed(self) -> bool:
    if not self._is_windows:
        return False
    if self._vk is None:
        return False
    try:
        return (ctypes.windll.user32.GetAsyncKeyState(self._vk) & 0x8000) != 0
    except Exception:
        return False
```

Финализация → `_transcribe(self._audio_buffer)` → whisper/moonshine (см. §6/§8) → `_transcription_ready.set()`; потребление — блокирующий `get_latest_transcription(silence_timeout)` (stt.py:550-591). Сохранение сырого буфера на диск — опция `save_mic_input` (default False), WAV 16 кГц/mono/int16 (stt.py:537-547).

**Внешний VAD: вербатим (stt.py:22, 129-130, 523-534):**

```python
from silero_vad_lite import SileroVAD
...
# Initialize VAD
self.vad = SileroVAD(self.SAMPLING_RATE)
...
def _reset_state(self) -> None:
    ...
    self.vad = SileroVAD(self.SAMPLING_RATE)
```

Встроенный `vad_filter` faster-whisper **выключен явно** (`vad_filter=False`, stt.py:253); `faster_whisper.vad` / `get_speech_timestamps` в репо не используются (grep по клону: 0 совпадений). Пакет — `silero-vad-lite` 0.4.0 (PyPI, без пина в requirements), автор-форк David Zurow (daanzu/py-silero-vad-lite). Оригинальный silero-vad (snakers4) версии не указывается нигде в репо.

---

## 8. Moonshine vs Whisper (как не перепутать)

**Точка выбора сервиса** — конфиг `stt_service` (default **"Moonshine"**, stt_definitions.py:41; в config_loader.py:240 `.lower()` → `"moonshine"`).

**Разветвление при инициализации** (stt.py:99, вербатим в §4): `if self.stt_service == 'whisper' or not has_moonshine:` → WhisperModel; иначе → Moonshine. Moonshine импортируется опционально (stt.py:26-31):

```python
try:
    from moonshine_onnx import MoonshineOnnxModel, load_tokenizer
    has_moonshine = True
except ModuleNotFoundError:
    has_moonshine = False
    logger.warning("moonshine_onnx is not available, Moonshine stt will not work")
```

**Разветвление при инференсе** (stt.py:224-231):

```python
def _transcribe(self, audio: np.ndarray) -> str:
    """Transcribe audio using Moonshine model."""
    # Count speech end time from when the last transcribe is called
    self._speech_end_time = time.time()
    if self.stt_service == 'moonshine':
        transcription = self.moonshine_transcribe(audio)
    else:
        transcription = self.whisper_transcribe(audio, self.prompt)
```

**Moonshine-путь** (stt.py:304-311): локальные ONNX-файлы (`{moonshine_folder}/{model}/encoder_model.onnx`) или HF; `generate(audio[...])` + `tokenizer.decode_batch`; пост-обработка `ensure_sentence_ending` (дописывает точку). **Moonshine только английский** — предупреждение (stt.py:115-116):

```python
if self.language != 'en':
    logger.warning(f"Selected language is '{self.language}', but Moonshine only supports English. Please change the selected speech-to-text model to Whisper in `Speech-to-Text`->`STT Service` in the Mantella UI")
```

**Whisper-путь**: faster-whisper, любой язык из списка (включая ru). Для AVC-Anime целевой путь — **whisper** (`stt_service == 'whisper'`), т.е. ветки stt.py:104-113 (иниц) и stt.py:252-257 (инференс). Параметры Moonshine (`moonshine_model_size`, `moonshine_folder`) к Whisper-пути отношения не имеют.

Внешние сервисы: `external_whisper_service=True` → `transcribe_model` остаётся `None` → HTTP-ветка (OpenAI/Groq/whisper.cpp, stt.py:259-301). К локальному Whisper это отношения не имеет.

---

## 9. Прочее по аудио

- `soundfile==0.12.1` в requirements есть, но в `src/stt/stt.py` не импортируется (WAV пишется модулем `wave`, stt.py:19,260-267,538-547). grep по клону: `sounddevice` импортируют только `src/stt/stt.py`, `src/tts/ttsable.py`, `src/utils.py`.
- `pyaudio==0.2.13` — мёртвый пин: в src/ и main.py совпадений нет.

---

## 10. Обработка ошибок и логирование STT

- **Инициализация CUDA в try/except** (stt.py:107-111, цитата в §4): при исключении `utils.play_error_sound()` + re-raise. CPU-ветка — без try/except.
- **Транскрипция через OpenAI-совместимый сервис — в try/except** (stt.py:273-286): 404/model_not_found → подсказка сменить модель; иначе `logger.error(f'STT error: {e}')`; `input("Press Enter to exit.")`.
- **Локальный `whisper_transcribe` — без try/except вокруг `transcribe_model.transcribe`** (stt.py:252-257): исключение инференса уйдёт выше (перехватывается только общий цикл обработки, см. ниже).
- **Три счётчика ошибок** с прореженными предупреждениями (stt.py:76-79: `self.__audio_input_error_count`, `self.__mic_input_process_error_count`, `self.__processing_audio_error_count`, `self.__warning_frequency = 5` — лог каждые 5 вхождений):
  - статус аудио-стрима: `logger.log(23, f"STT WARNING: Audio input error: {status}")` (stt.py:516);
  - статус обработки очереди: `f"STT WARNING: Processing audio error: {status}"` (stt.py:370);
  - общий перехват цикла `_process_audio` (stt.py:383-388): `f'STT WARNING: Error processing mic input: {str(e)}'` → `_reset_state()` + `time.sleep(0.1)` — **процесс не падает, слушание перезапускается**.
- `queue.Empty` → `logger.debug('Queue is empty')` (stt.py:380-382).
- Тайминги: `utils.time_it`-декораторы на всех ключевых методах; `logger.log(self.loglevel, f'STT took {round(...,5)} seconds to transcribe')` (stt.py:403); в proactive-режиме — предупреждение, если транскрипция дольше `min_refresh_secs` (stt.py:234-237).
- Пустая транскрипция/галлюцинации → `__ignore_list` (§6) и `_consecutive_empty_count` (max 10, stt.py:150-151).
- Упавшая модель-инициализация ( Moonshine не установлен) — graceful fallback: `logger.error("Moonshine selected but moonshine not installed, trying whisper")` (stt.py:102).

**Замечание (латентный баг Mantella, проверено grep по клону):** `set_temporary_pause` (stt.py:177) вызывает `self.vad_iterator = self._create_vad_iterator()`, но метод `_create_vad_iterator` в классе НЕ определён (единственное совпадение в файле — сама строка 177). Путь достижим только из Listen-action при уже активном слушании.

---

## 11. Tests, связанные со STT

Источник: официальное дерево (git/trees/main?recursive=1).

- `tests/stt/__init__.py` (пустой пакет)
- `tests/stt/test_ptt_controller.py` (3 157 B) — https://raw.githubusercontent.com/art-from-the-machine/Mantella/main/tests/stt/test_ptt_controller.py — ТОЛЬКО тесты маппинга клавиш PTT (`_normalize_key_to_vk`: буквы/цифры/F1-F24/спецклавиши/None). **Тестов WhisperModel/транскрипции/VAD НЕТ.**
- Интеграционных STT-тестов не существует; остальной tests/ — конфиг, LLM, TTS, games, http.

---

## 12. Последние коммиты по ключевым STT-файлам

Источник: https://api.github.com/repos/art-from-the-machine/Mantella/commits?path={path}&per_page=1 (на ветке main).

| Файл | Последний коммит | Дата | Сообщение |
|---|---|---|---|
| `src/stt/stt.py` | `505c83a5340650493756871c378066ef94341951` | 2026-07-11T21:54:51Z | «Improve interruptions and add streaming support to XTTS and OpenAI TTS (#734)» |
| `src/stt/ptt_controller.py` | `417378e0ad5926b92b25def4f7451aaa81163406` | 2026-02-26T06:57:53Z | «Add server side push to talk (#658)» |
| `src/config/definitions/stt_definitions.py` | `417378e0ad5926b92b25def4f7451aaa81163406` | 2026-02-26T06:57:53Z | «Add server side push to talk (#658)» |
| `requirements.txt` | `9142170c1e5531ce006dc378c0f3a17efcafda01` | 2026-03-26T12:00:31Z | «Prepare codebase for onedir exe (#700)» |

---

## 13. Licenses

| Компонент | SPDX | Доказательство |
|---|---|---|
| **Mantella** | **AGPL-3.0** | GitHub API `license.spdx_id = "AGPL-3.0"`; файл https://raw.githubusercontent.com/art-from-the-machine/Mantella/main/LICENSE — «GNU AFFERO GENERAL PUBLIC LICENSE, Version 3, 19 November 2007» |
| faster-whisper (SYSTRAN, ветка master) | MIT | https://raw.githubusercontent.com/SYSTRAN/faster-whisper/master/LICENSE — «MIT License / Copyright (c) 2023 SYSTRAN» |
| CTranslate2 | MIT | https://raw.githubusercontent.com/OpenNMT/CTranslate2/master/LICENSE — «MIT License / Copyright (c) 2018- SYSTRAN. / Copyright (c) 2019- The OpenNMT Authors.» ⚠️ Репо переехало: SYSTRAN/ctranslate2 на GitHub отдаёт 404; PyPI `project_urls` указывают на github.com/OpenNMT/CTranslate2 |
| silero-vad (оригинал, snakers4) | MIT | https://raw.githubusercontent.com/snakers4/silero-vad/master/LICENSE — «MIT License / Copyright (c) 2020-present Silero Team» |
| silero-vad-lite (фактически используется Mantella, daanzu) | MIT | https://raw.githubusercontent.com/daanzu/py-silero-vad-lite/master/LICENSE — «MIT License / Copyright (c) 2024 David Zurow» |

**Важно для AVC-Anime:** AGPL-3.0 — сильное копилефт-лицензирование СЕТИ (для десктопа фактически: распространение производных от кода Mantella — только под AGPL). Копирование **идей/параметров/архитектуры** безопасно; дословный перенос кода Mantella (AGPL) в проприетарный проект — риск. MIT-зависимости (faster-whisper/CTranslate2/silero) ограничений не накладывают.

---

## 14. Риски интеграции Whisper-пути Mantella в Electron/Node-приложение (AVC-Anime)

1. **Python-рантайм — главный архитектурный риск.** Mantella — чистое Python-приложение (Python 3.11, requirements.txt); faster-whisper — Python-библиотека поверх нативного CTranslate2. AVC-Anime — Node/Electron; потребуется боковой Python-процесс (bundled runtime/venv, ~200-400 МБ только рантайм+CTranslate2), IPC-мост (как текущий stt-worker) и жёсткая изоляция крашей (уже есть — pattern из v1.0.20). Альтернатива Node-нативного faster-whisper НЕ существует (whisper.cpp — другой стек, не «как в Mantella»).
2. **Внешний VAD обязателен, иначе архетектура не совпадает.** Mantella держит сегментацию на своей стороне (Silero per-512-чанк + pause_threshold 0.25 с + порог 0.4), а `vad_filter=False`. Прямой перенос должен включать silero-vad ONNX (сам по себе fail-fast при битом файле — тот же класс краша 0xC0000409, который уже лечили; silero-vad-lite без пина версии в Mantella — у нас пин обязательно).
3. **Первый запуск = загрузка модели из HF Hub.** `download_root` не задаётся → кэш HuggingFace в домашней папке; в оффлайн/прокси-средах и при стандартном EXE-дистрибутиве это тихий фейл. Для AVC-Anime нужно скачать модель (Systran/faster-whisper-* с HF, CTranslate2-формат) в свой `ai-models/` каталог с integrity-гейтом (уже построен в v1.0.20) и передавать `download_root`/локальный путь явно, а не полагаться на HF-кэш.
4. **CUDA-ветка — известный источник ошибок.** Mantella сам логирует error при `device='cuda'` (stt.py:106, цитата в §4) и требует установленного CUDA/cuDNN под CTranslate2; дефолт Mantella — `cpu`. Для Windows-EXE аудитории AVC безопасный дефолт — CPU (`compute_type="float32"` как в Mantella) или `int8` для скорости, но последний — уже отклонение от образца.
5. **CPU-инференс и скорость.** `base` @ float32 на CPU — заметная латентность на длинных буферах (Mantella буферизует до 30 с); Mantella даже рекомендует подстраивать Refresh Frequency под измеренное время транскрипции (stt.py:234-237). Нужно заложить float32→int8 фолбэк/лимиты длительности буфера.
6. **AGPL-3.0 Mantella** (§13): переносить можно архитектуру и параметры, не код.
7. (Мелочи, но учтённые в образце) фильтр галлюцинаций `__ignore_list`, `initial_prompt` под контекст, язык ВСЕГДА явный (для ru — `language="ru"`), пробуждение по VAD-вероятности, а не по RMS.

---

## 15. Честный список «НЕ НАЙДЕНО / ОТСУТСТВУЕТ»

- `config.ini` / шаблон конфига в репо — **ОТСУТСТВУЕТ** (генерируется в рантайме; дефолты живут в stt_definitions.py).
- `download_root` в вызовах WhisperModel — **ОТСУТСТВУЕТ** (HF-кэш по умолчанию).
- Пины `ctranslate2`, `onnxruntime`, версия `silero-vad-lite` в requirements.txt — **ОТСУТСТВУЮТ** (транзитивно/без пина; точные транзитивные диапазоны — §2).
- `temperature`, `condition_on_previous_text`, `without_timestamps` в вызове transcribe — **НЕ ПЕРЕДАЮТСЯ** (дефолты библиотеки, §6).
- Авто-детект языка (`language=None`) — **НЕДОСТИЖИМ** (§5).
- Тесты локального Whisper-инференса — **ОТСУТСТВУЮТ** (только PTT-keymap, §11).
- `soundfile` в STT-коде — **НЕ ИСПОЛЬЗУЕТСЯ**; `pyaudio` — **МЁРТВЫЙ пин** (§9).
- Внешний `silero onnx`-файл в репо Mantella — **ОТСУТСТВУЕТ** (VAD берётся из PyPI-пакета silero-vad-lite).
- Определение `_create_vad_iterator` — **ОТСУТСТВУЕТ** при живом вызове (латентный баг Mantella, §10).

---

## 16. Источники (полный список URL)

- Репо-метаданные: https://api.github.com/repos/art-from-the-machine/Mantella
- Релиз: https://api.github.com/repos/art-from-the-machine/Mantella/releases/latest
- Дерево: https://api.github.com/repos/art-from-the-machine/Mantella/git/trees/main?recursive=1
- Reference commit: https://api.github.com/repos/art-from-the-machine/Mantella/commits/main
- Последние коммиты по файлам: https://api.github.com/repos/art-from-the-machine/Mantella/commits?path=src/stt/stt.py&per_page=1 (и аналогично ptt_controller.py, stt_definitions.py, requirements.txt)
- Код (raw, main @ c0c1ae6): src/stt/stt.py, src/stt/ptt_controller.py, src/config/definitions/stt_definitions.py, src/config/config_loader.py, src/config/definitions/language_definitions.py, src/config/mantella_config_value_definitions_new.py, src/config/mantella_config_value_definitions_classic.py, requirements.txt, tests/stt/test_ptt_controller.py, tests/requirements-ci.txt, data/language_support.csv, LICENSE
- faster-whisper v1.0.3: https://raw.githubusercontent.com/SYSTRAN/faster-whisper/v1.0.3/faster_whisper/transcribe.py ; https://pypi.org/pypi/faster-whisper/1.0.3/json
- CTranslate2: https://raw.githubusercontent.com/OpenNMT/CTranslate2/master/LICENSE ; https://raw.githubusercontent.com/OpenNMT/CTranslate2/master/docs/quantization.md ; https://pypi.org/pypi/ctranslate2/json
- silero-vad: https://raw.githubusercontent.com/snakers4/silero-vad/master/LICENSE ; https://pypi.org/pypi/silero-vad-lite/json ; https://raw.githubusercontent.com/daanzu/py-silero-vad-lite/master/LICENSE
