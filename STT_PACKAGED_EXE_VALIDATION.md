# STT Packaged EXE Validation — v1.0.22

Статус: CI-уровень проверки; финальная проверка на машине владельца — за владельцем (после релиза).

## 1. Что изменилось в упаковке

| Компонент | Как пакуется | Где лежит в EXE-раскладке |
|---|---|---|
| Python 3.11.9 embeddable + pip-стек (faster-whisper 1.0.3, ctranslate2 4.4.0, onnxruntime 1.17.3 и пины из requirements.txt) | CI-шаг «Assemble bundled Python runtime» → extraResources | `resources/python-runtime/` |
| Python-сервис STT + фикстуры + requirements | ai-pack (assemble-ai-pack.mjs) → extraResources | `resources/ai/stt-python/` |
| Node-воркер (оркестрация, IPC, скачивание) | ai-pack | `resources/ai/` |
| Модели Whisper | НЕ бандлятся — скачиваются model-manager'ом в `userData/ai-models/stt/<id>` при установке через UI (SHA-256, прогресс, resume) | вне приложения (переживают обновления) |
| silero_vad.onnx | скачивается model-manager'ом (общий компонент vad) | `userData/ai-models/vad/silero-vad/` |

Размер EXE вырастает примерно на 60–80 МБ сжатых (python-рантайм ~110 МБ распакованных + стоп-книга pip). Старый sherpa-onnx (~40–60 МБ) из пака УДАЛЁН — частично компенсирует.

## 2. Автоматические проверки в CI (до публикации релиза)

1. **Validate AI asset URLs** — каждый URL манифеста v5 (5 моделей × 4 файла + VAD): HEAD → Content-Length сверка с манифестом → реальная докачка 1 МБ. Зафиксировано: 21/21 PASS (2026-10-05).
2. **Assemble bundled Python runtime** — сборка embeddable python 3.11.9 + pip install пинов + контроль `import faster_whisper, onnxruntime, numpy` на реальном Windows.
3. **Verify packaged AI layer layout** (страж v1.0.20-урока) — раскладка win-unpacked: `resources/ai/stt-python/stt_service.py`, `resources/python-runtime/python.exe` и ai-файлы на месте; «голых» require('./ai/...') в asar-файлах нет (acorn-скан).
4. **STT service selftest (Windows, bundled runtime)** — scripts/ci-stt-selftest.mjs: скачивает модель base с ПИНОВОЙ ревизии манифеста через huggingface_hub из бандленного python и запускает `stt_service.py --wav benchmark-ru.wav --expect нар` ТЕМ ЖЕ python.exe из win-unpacked. Exit≠0 блокирует публикацию релиза.
5. **SHA256SUMS.txt** — как раньше; обновлятор сверяет перед установкой.

## 3. Классы крашей старого STT — закрыты конструктивно

| Старый класс (sherpa/T-One/GigaAM) | Новый статус |
|---|---|
| 0xC0000409: необработанное C++ исключение ONNX (битая модель) убивало воркер | CTranslate2/onnxruntime в Python кидают ИСКЛЮЧЕНИЯ (не fail-fast); сервис честно отвечает status:failed; воркер жив; поверх — pre-flight integrity (маркерные размеры, минимумы) до загрузки |
| Усечённые файлы «установлены» | модель multiFile: SHA-256 model.bin при скачивании + маркерные размеры + пред-полётная проверка; при повреждении — честная ошибка «переустановите» |
| Карантин/fallback/safe-mode | сохранены (model-integrity.cjs: whisper-ветка + checkVadIntegrity) |

## 4. Ручная проверка владельцем (чек-лист после установки v1.0.22+)

1. EXE запускается (python-рантайм бандлится отдельно от asar — краш «Cannot find module» v1.0.20 здесь не воспроизводим; страж CI ловит такие раскладки до релиза).
2. Настройки → AI: в каталоге 5 моделей Whisper; установка base проходит с прогрессом по файлам.
3. После установки: живой тест (кнопка записи в Настройках → AI) распознаёт русскую фразу; interim-текст появляется во время речи.
4. Повторные фразы подряд работают (нет « permanent listening»); пауза 0.25 с закрывает фразу.
5. Отключить интернет → распознавание продолжает работать (офлайн-режим после установки модели).
6. Логи: `userData/logs/` — события STT без ошибок; при проблеме — приложить лог в issue.
