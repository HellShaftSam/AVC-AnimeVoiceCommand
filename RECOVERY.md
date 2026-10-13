# RECOVERY — восстановление проекта в чистом окружении

## 1. Клонировать репозиторий

```bash
git clone https://github.com/HellShaftSam/AVC-AnimeVoiceCommand.git avc
cd avc
```

Репозиторий приватный: нужен доступ к аккаунту HellShaftSam
(`gh auth login` → браузер, либо SSH-ключ, либо PAT через credential manager).

## 2. Веб-часть (Next.js)

```bash
bun install                 # или npm install / pnpm install
cp .env.example .env        # поправить DATABASE_URL при необходимости
bun run db:push             # создать db/custom.db (пустую)
bun run dev                 # http://localhost:3000
```

Проверка: `bun run lint`, `bunx tsc --noEmit` (ошибки только в examples/skills —
это песочница, не проект), самотест парсера:
`bun run scripts/episode-parser-selftest.ts` → «SELFTEST OK».

## 3. Electron-оболочка (EXE)

Источник оболочки лежит в `electron-app/` внутри этого репозитория.
Рабочая директория сборки — отдельная (в песочнице: `/home/z/exe-build/app`),
но всё нужное восстанавливается так:

```bash
mkdir -p build && cd build
# 1) скопировать исходники оболочки
cp -r ../electron-app/* .
# 2) поставить зависимости
bun install                 # electron 31.7.7, electron-builder, sherpa-onnx-node
# 3) собрать Next-сервер из корня репозитория
cd .. && bun run build      # standalone → dist/server  (или npm run build)
# 4) собрать EXE
cd build && bun run dist    # electron-builder --win portable --x64
```

`electron-app/resources/` в рабочей копии сборки — симлинки на артефакты
(`dist/win-unpacked/resources/{server,models,sherpa,ai-config}`); в git они не
хранятся, их создаёт сборка.

## 4. STT-модели и бинарники (вне git)

| Файл | Размер | Источник |
|---|---|---|
| T-One Streaming CTC `model.onnx` + `tokens.txt` | ~138 МБ | URL и SHA-256 в `electron-app/speech/model-manifest.json` (HuggingFace raw) |
| Silero VAD `silero_vad.onnx` | 643 КБ | URL и SHA-256 там же (GitHub) |
| sherpa-onnx нативные DLL/`.node` (win-x64) | ~23 МБ | `node_modules/sherpa-onnx-node` (+ `sherpa-onnx-win-x64` пакет) |

Модель можно не скачивать руками: EXE при старте сам ставит модель в
`%APPDATA%/avc-anime/stt` через model-manager (с прогрессом и resume).
Для оффлайн-сборки в образ: положить файлы по путям из манифеста.

## 5. Данные пользователя (переносятся отдельно)

- `db/custom.db` — настройки, алиасы, история, сессия Yummy (СОДЕРЖИТ COOKIE —
  не публикуйте). В git нет намеренно.
- `%APPDATA%/avc-anime/` (userData) — сессии EXE, `avc-main.log`, стт-модели.

## 6. Проверка после восстановления

1. `bun run dev` → главная открывается, «Диагностика сайта» зелёная.
2. Открыть Шиппудена → сетка «531 эп.», предупреждение про aired=58, счётчик
   «Вышло серий: 58 из 500 · доступно 531 · счётчик по видео-матрице».
3. Открыть Наруто → 220 серий; Ван-Пис → при выборе «Субтитры» сетка 1157.
4. Debug-панель → «Парсер серий» показывает v3 и предупреждения.

## 7. Известное локальное ответвление

Ветка `sandbox-history-local` (если присутствует) — исторические авто-снимки
песочницы. СОДЕРЖИТ старые снапшоты БД с session-cookie. НЕ пушить. Можно
удалить после сверки: `git branch -D sandbox-history-local`.
