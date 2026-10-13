/**
 * Runtime-миграция таблиц аккаунт-интеграции YummyAnime (Task 17).
 *
 * Зачем: portable-EXE копирует seed-БД ТОЛЬКО при первом запуске
 * (main.cjs prepareDatabase). Пользователи, обновляющиеся с 1.0.4,
 * сохраняют старую avc.db без моделей Yummy*. Server-стендолон не умеет
 * запускать `prisma db push`, поэтому применяем аддитивную миграцию
 * (CREATE TABLE IF NOT EXISTS) лениво при первом обращении к /api/yummy/*.
 *
 * Миграция идемпотентна и только добавляет объекты — существующие данные
 * не трогаются. Выполняется один раз на процесс (module-level promise).
 */
import { db } from '@/lib/db'

let migratePromise: Promise<void> | null = null

async function runMigration(): Promise<void> {
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "YummySession" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "siteId" TEXT NOT NULL DEFAULT 'yummyanime',
      "cookieName" TEXT NOT NULL DEFAULT '',
      "cookieValue" TEXT NOT NULL DEFAULT '',
      "yummyUserId" INTEGER,
      "yummyNickname" TEXT,
      "avatarUrl" TEXT,
      "authState" TEXT NOT NULL DEFAULT 'unknown',
      "lastCheckAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )
  `)
  await db.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "YummySession_siteId_yummyUserId_key"
     ON "YummySession"("siteId", "yummyUserId")`,
  )

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "YummyListCache" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "sessionId" TEXT NOT NULL,
      "animeId" INTEGER NOT NULL,
      "animeUrl" TEXT,
      "title" TEXT NOT NULL,
      "poster" TEXT,
      "listId" INTEGER NOT NULL,
      "year" INTEGER,
      "rating" REAL,
      "siteDate" INTEGER,
      "updatedAt" DATETIME NOT NULL
    )
  `)
  await db.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "YummyListCache_sessionId_animeId_listId_key"
     ON "YummyListCache"("sessionId", "animeId", "listId")`,
  )
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "YummyListCache_sessionId_listId_idx"
     ON "YummyListCache"("sessionId", "listId")`,
  )

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "YummySyncMeta" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "lastSync" DATETIME,
      "lastDuration" INTEGER,
      "contentHash" TEXT,
      "failCount" INTEGER NOT NULL DEFAULT 0,
      "lastError" TEXT,
      "requests" INTEGER NOT NULL DEFAULT 0,
      "cacheHits" INTEGER NOT NULL DEFAULT 0,
      "updatedAt" DATETIME NOT NULL
    )
  `)
}

/** Гарантирует наличие таблиц Yummy*; ошибки логируются, но не крэшат роут. */
export function ensureYummyTables(): Promise<void> {
  if (!migratePromise) {
    migratePromise = runMigration().catch((e) => {
      // сброс, чтобы следующая попытка могла повторить миграцию
      migratePromise = null
      console.error(
        '[YummyAnime] runtime migration failed:',
        e instanceof Error ? e.message : String(e),
      )
      throw e
    })
  }
  return migratePromise
}
