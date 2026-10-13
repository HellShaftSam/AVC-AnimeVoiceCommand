/**
 * Рекомендации — снапшот последнего удачного расчёта (Prisma AppSetting).
 *
 * Зачем (ТЗ §10–§12): открыть вкладку мгновенно при неизменных данных
 * (фингерпринт совпал) и честно отдать прошлый результат со stale-меткой,
 * когда сайт недоступен. Минимальный локальный кэш: одна запись на аккаунт.
 * Ключ включает accountKey → рекомендации другого аккаунта не утечут (ТЗ §11).
 */
import { db } from '@/lib/db'
import type { RecsResponse } from '@/app/api/recs/route'

const SNAPSHOT_PREFIX = 'recs:snapshot:'

export interface RecsSnapshotPayload {
  fingerprint: string
  computedAt: string
  response: Omit<RecsResponse, 'stale' | 'cached'>
}

export async function loadRecsSnapshot(accountKey: string): Promise<RecsSnapshotPayload | null> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: SNAPSHOT_PREFIX + accountKey } })
    if (!row) return null
    const p = JSON.parse(row.value) as RecsSnapshotPayload
    if (!p || typeof p.fingerprint !== 'string' || !Array.isArray(p.response?.items)) return null
    return p
  } catch {
    return null
  }
}

export async function saveRecsSnapshot(
  accountKey: string,
  payload: RecsSnapshotPayload,
): Promise<void> {
  try {
    await db.appSetting.upsert({
      where: { key: SNAPSHOT_PREFIX + accountKey },
      create: { key: SNAPSHOT_PREFIX + accountKey, value: JSON.stringify(payload) },
      update: { value: JSON.stringify(payload) },
    })
  } catch {
    // снапшот — оптимизация; не удалось сохранить — работаем без него
  }
}

/** Инвалидация ВСЕХ снапшотов рекомендаций (логаут/смена аккаунта — ТЗ §11) */
export async function invalidateRecsSnapshots(): Promise<void> {
  try {
    await db.appSetting.deleteMany({ where: { key: { startsWith: SNAPSHOT_PREFIX } } })
  } catch {
    /* не критично */
  }
}
