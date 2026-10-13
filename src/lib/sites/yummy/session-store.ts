/**
 * YummySessionStore — серверное хранилище cookie-сессии yummyani.me.
 *
 * АРХИТЕКТУРА (спецификация «YummyAnime Real-Site Account Integration»):
 *   1. Пользователь входит на РЕАЛЬНОМ сайте (hCaptcha/2FA обходит только сайт).
 *   2. Electron-оболочка после входа читает cookie из persistent-профиля webview
 *      и передаёт их сюда: POST /api/yummy/session { cookie }.
 *   3. Серверный адаптер ходит на сайт с этими cookie — сайт остаётся
 *      источником истины (remote-first, секция 10).
 *
 * БЕЗОПАСНОСТЬ (секция 37):
 *   - пароли НЕ принимаются и НЕ хранятся — только cookie-строка сессии;
 *   - cookie нигде не логируется;
 *   - файл хранилища db/yummy-session.json, права 0600.
 *
 * Это кеш СЕССИИ сайта, а не отдельная система аутентификации.
 */
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync, rmSync } from 'fs'
import path from 'path'

interface YummySessionData {
  /** Сырая cookie-строка для заголовка Cookie (секрет, наружу не отдаётся) */
  cookie: string
  savedAt: string
}

const STORE_PATH = path.join(process.cwd(), 'db', 'yummy-session.json')

let cached: YummySessionData | null = null

function loadFromDisk(): YummySessionData | null {
  try {
    if (!existsSync(STORE_PATH)) return null
    const raw = readFileSync(STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as YummySessionData
    if (typeof parsed?.cookie === 'string' && parsed.cookie.trim() !== '') return parsed
    return null
  } catch {
    return null
  }
}

function persist(data: YummySessionData | null): void {
  try {
    if (!data) {
      try {
        rmSync(STORE_PATH, { force: true })
      } catch {
        /* файла могло не быть */
      }
      return
    }
    const dir = path.dirname(STORE_PATH)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(STORE_PATH, JSON.stringify(data), { mode: 0o600 })
    try {
      chmodSync(STORE_PATH, 0o600)
    } catch {
      /* не все FS поддерживают */
    }
  } catch {
    /* диск может быть read-only — работаем в памяти */
  }
}

/** Есть ли сохранённая сессия (без раскрытия содержимого) */
export function hasYummySession(): boolean {
  if (cached) return true
  return loadFromDisk() !== null
}

/** Получить cookie-строку (для заголовка Cookie адаптером). null — сессии нет */
export function getYummySessionCookie(): string | null {
  if (!cached) cached = loadFromDisk()
  return cached?.cookie ?? null
}

/** Сохранить cookie-строку сессии (мост из Electron/webview) */
export function setYummySessionCookie(cookie: string): void {
  const clean = cookie.trim()
  cached = { cookie: clean, savedAt: new Date().toISOString() }
  persist(cached)
}

/** Очистить сессию (выход) */
export function clearYummySession(): void {
  cached = null
  persist(null)
}

/** Время сохранения сессии (для UI), ISO или null */
export function getYummySessionSavedAt(): string | null {
  if (!cached) cached = loadFromDisk()
  return cached?.savedAt ?? null
}
