# PROJECT_STATE — AVC-Anime (Anime Voice Control)

> Дата снимка: 2026-07 (версия кода 1.3.2 + Task 23 «парсер серий»)
> Репозиторий: https://github.com/HellShaftSam/AVC-AnimeVoiceCommand (приватный)

## Что это

Настольное Windows-приложение (Electron portable EXE) голосового управления
встроенным аниме-плеером сайта **old.yummyani.me**. Полностью офлайн
распознавание русской речи (sherpa-onnx + T-One Streaming CTC + Silero VAD),
голосовые и текстовые команды, вкладки-каталог, плеер с overlay-управлением,
аккаунт YummyAnime (списки/любимые/оценки), «Порядок просмотра» франшизы.

## Состав репозитория

| Каталог           | Что это                                                                 |
|-------------------|-------------------------------------------------------------------------|
| `src/app`         | Next.js 16 App Router: страница `/` и API-маршруты (`/api/site/*`, `/api/voice/*`, `/api/auth/yummy`, `/api/settings`, `/api/aliases`, `/api/history`, `/api/session`, `/api/maintenance`) |
| `src/lib/sites/yummy` | Адаптер сайта: детали/поиск/секции + **парсер серий** (`episodes.ts`) + аккаунт/сессия/фолбэк |
| `src/lib/avc`     | Контракты и клиентская логика: executor команд, store (zustand), API-клиент, player-bridge, голос |
| `src/lib/voice`   | Парсер русских голосовых команд, нормализация числительных, fuzzy, фонетика, алиасы |
| `src/components/avc` | UI: шапка, вкладки, каталог, anime-view (сетка серий + Порядок просмотра), плеер, настройки, debug-панель |
| `electron-app/`   | Источник EXE: `main.cjs`, `preload.cjs`, `mic-preload.cjs`, `speech/` (STT-движок, mic-service, model-manager), `adblock/engine.cjs` |
| `scripts/`        | Самотесты: `episode-parser-selftest.ts` (51 проверка), sanitize-packaged-db, make-icons |
| `prisma/`         | Схема БД (SQLite): настройки, сессии, алиасы, история                    |
| `public/releases/README.txt` | Описание последнего релиза (сам EXE в git не хранится — собирается) |

## Версия

- Веб-часть: Next.js 16 + React 19 + TS5 + Tailwind 4 + shadcn/ui (New York)
- Electron 31.7.7, electron-builder 24.13.3, sherpa-onnx-node 1.13.8
- Парсер серий: `EPISODE_PARSER_VERSION = 3` (`src/lib/avc/types.ts`)

## Последние изменения (Task 23 — корректный парсинг серий)

Полный отчёт в `CHANGELOG.md` и `AI_HANDOFF.md`. Кратко:
- каноническая модель серий (метка сайта + варианты озвучек/плееров);
- грязное поле `episodes.aired` сайта больше не является счётчиком (Шиппуден: aired=58 при матрице 1..500);
- сетка серий = серии выбранной озвучки (семантика плеера сайта);
- метки «1168.5» и «119+120» сохраняются как есть (без parseInt-порчи);
- «Порядок просмотра» из structured `viewing_order` + UI-секция с переходами;
- диагностика `/api/site/debug/{id}` + секция в debug-панели + экспорт JSON;
- кэш с TTL и версией парсера (адаптер и клиент).

## Честные ограничения

- В песочнице нет Windows: EXE собирается и проверяется упаковка/сервер/движок,
  но «живой» прогон на Windows делает пользователь.
- Счётчик «Вышло серий» сайта бывает грязным — приложение показывает его ТОЛЬКО
  как справку («Вышло X из Y») вместе с предупреждением и реальным числом
  доступных серий из видео-матрицы.
- Точная позиция просмотра недоступна через API сайта (только last video_id).
