import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Самопроверка после `db:push`: долгоживущий dev-процесс может держать
 * PrismaClient, сгенерированный ДО появления новых моделей (например User) —
 * у такого клиента `db.user` undefined и все новые маршруты падают с 500.
 * Если глобальный клиент устарел — гасим его и создаём свежий по текущей схеме.
 */
function isStaleClient(c: PrismaClient | undefined): boolean {
  return !!c && !((c as unknown as Record<string, unknown>).user)
}

if (isStaleClient(globalForPrisma.prisma)) {
  void globalForPrisma.prisma!.$disconnect().catch(() => undefined)
  globalForPrisma.prisma = undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
