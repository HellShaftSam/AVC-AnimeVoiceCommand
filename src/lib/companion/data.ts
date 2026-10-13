/**
 * Anime Companion — аккаунт и нормализация записей Хроник (заметки/цитаты/моменты/впечатления).
 *
 * accountKey — ТОТ ЖЕ принцип изоляции, что у рекомендаций (/api/recs) и RecFeedback:
 *   числовой userId сайта из серверной сессии (loadWebSession → fetchProfile → parseProfile)
 *   либо 'anon' для гостя. Это НЕ-секретный слот: пароли/cookie идентификаторами не используются.
 *
 * Отступление от recs-схемы здесь одно и оно честное: Companion работает и БЕЗ
 * аккаунта (гость пишет в 'anon'), поэтому при недоступности сайта мы не падаем,
 * а краткосрочно (60 с) переиспользуем последний подтверждённый numericId той же
 * сессии — данные залогиненного пользователя не смешиваются с гостевыми.
 */
import { loadWebSession } from '@/lib/sites/yummy/web-session'
import { fetchProfile, parseProfile } from '@/lib/sites/yummy/web-auth'
import type { ViewerNote as ViewerNoteRow } from '@prisma/client'

// --- accountKey ------------------------------------------------------------------

export const ANON_ACCOUNT_KEY = 'anon'

export interface AccountKeyResolution {
  /** Числовой userId сайта либо 'anon' */
  accountKey: string
  /** true — аккаунт подтверждён сессией сайта (сейчас или из краткого кэша) */
  siteAccount: boolean
  /** Честная причина, если аккаунт сайта определить не удалось (гость/сайт недоступен) */
  reason: string | null
}

/** Краткий мемо последнего подтверждённого аккаунта (одна запись, 60 с) */
let lastResolved: { cookieHash: string; numericId: string; at: number } | null = null
const RESOLVE_TTL = 60 * 1000

function hashCookie(cookie: string): string {
  let h = 0
  for (let i = 0; i < cookie.length; i++) {
    h = (h * 31 + cookie.charCodeAt(i)) | 0
  }
  return String(h)
}

/**
 * Определить accountKey запроса ровно тем же путём, что и рекомендационный движок:
 * серверная сессия сайта → профиль → числовой userId. Гость → 'anon'.
 */
export async function resolveAccountKey(): Promise<AccountKeyResolution> {
  try {
    const session = await loadWebSession()
    if (!session) {
      lastResolved = null
      return {
        accountKey: ANON_ACCOUNT_KEY,
        siteAccount: false,
        reason: null, // гость — нормальный режим Хроник, не ошибка
      }
    }
    const cookieHash = hashCookie(session.cookie)
    const profile = await fetchProfile(session.cookie)
    if (profile.status === 200) {
      const numericId = parseProfile(profile.body)?.userId?.match(/^(\d+)$/)?.[1] ?? null
      if (numericId) {
        lastResolved = { cookieHash, numericId, at: Date.now() }
        return { accountKey: numericId, siteAccount: true, reason: null }
      }
      return {
        accountKey: ANON_ACCOUNT_KEY,
        siteAccount: false,
        reason: 'Не удалось определить id пользователя из профиля сайта',
      }
    }
    // Сайт не подтвердил профиль: если ТОЙ ЖЕ сессии недавно удавалось — не смешиваем с 'anon'
    if (lastResolved && lastResolved.cookieHash === cookieHash && Date.now() - lastResolved.at < RESOLVE_TTL) {
      return { accountKey: lastResolved.numericId, siteAccount: true, reason: null }
    }
    return {
      accountKey: ANON_ACCOUNT_KEY,
      siteAccount: false,
      reason: 'Сайт YummyAnime недоступен — аккаунт не подтверждён, данные запишутся как гостевые',
    }
  } catch {
    return {
      accountKey: ANON_ACCOUNT_KEY,
      siteAccount: false,
      reason: 'Не удалось прочитать сессию сайта',
    }
  }
}

// --- Хроники: типы и нормализация --------------------------------------------------

export const NOTE_KINDS = ['note', 'quote', 'moment', 'impression'] as const
export type NoteKind = (typeof NOTE_KINDS)[number]

export const NOTE_KIND_LABELS: Record<NoteKind, string> = {
  note: 'Заметка',
  quote: 'Цитата',
  moment: 'Момент',
  impression: 'Впечатление',
}

export function isNoteKind(v: unknown): v is NoteKind {
  return typeof v === 'string' && (NOTE_KINDS as readonly string[]).includes(v)
}

const TEXT_MAX = 4000
const TITLE_MAX = 300
const TAG_MAX = 40
const TAGS_MAX = 10

export interface NoteDto {
  id: string
  kind: NoteKind
  animeId: number
  slug: string
  title: string
  poster: string | null
  episode: number | null
  text: string
  positionSec: number | null
  durationSec: number | null
  tags: string[]
  createdAt: string
  updatedAt: string
}

/** Тело POST /api/companion/notes (поле kind опционально → 'note') */
export interface NewNoteValues {
  kind: NoteKind
  animeId: number
  slug: string
  title: string
  poster: string | null
  episode: number | null
  text: string
  positionSec: number | null
  durationSec: number | null
  tags: string // CSV (колонка БД)
}

/** Тело PATCH /api/companion/notes/[id] — только владелец, только эти поля */
export interface NotePatchValues {
  kind?: NoteKind
  text?: string
  tags?: string // CSV
  episode?: number | null
}

type Ok<T> = { ok: true; value: T }
type Fail = { ok: false; error: string }

function asTrimmedString(v: unknown): string | null {
  return typeof v === 'string' ? v.trim() : null
}

function asOptionalInt(v: unknown): { ok: boolean; value: number | null } {
  if (v === undefined || v === null) return { ok: true, value: null }
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return { ok: false, value: null }
  return { ok: true, value: n }
}

function asOptionalFloat(v: unknown): { ok: boolean; value: number | null } {
  if (v === undefined || v === null) return { ok: true, value: null }
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n) || n < 0) return { ok: false, value: null }
  return { ok: true, value: Math.round(n * 10) / 10 }
}

/**
 * Теги: строка CSV или массив строк → нормализованный CSV.
 * Правила: трим, схлопывание пробелов, дедупликация без регистра,
 * максимум 10 тегов по 40 символов — остальное честно отбрасывается.
 */
export function normalizeTags(input: unknown): { csv: string; list: string[] } {
  const raw: string[] = Array.isArray(input)
    ? input.filter((t): t is string => typeof t === 'string')
    : typeof input === 'string'
      ? input.split(',')
      : []
  const seen = new Set<string>()
  const list: string[] = []
  for (const r of raw) {
    const tag = r.replace(/\s+/g, ' ').trim().slice(0, TAG_MAX)
    if (tag === '') continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    list.push(tag)
    if (list.length >= TAGS_MAX) break
  }
  return { csv: list.join(', '), list }
}

/** Нормализация и валидация тела POST (создание записи Хроник) */
export function normalizeNoteInput(body: unknown): Ok<NewNoteValues> | Fail {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Ожидался JSON-объект' }
  }
  const b = body as Record<string, unknown>

  const kind = b.kind === undefined ? 'note' : b.kind
  if (!isNoteKind(kind)) {
    return { ok: false, error: `kind должен быть одним из: ${NOTE_KINDS.join(', ')}` }
  }

  const animeId = asOptionalInt(b.animeId)
  if (!animeId.ok || animeId.value === null) {
    return { ok: false, error: 'animeId обязателен (целое число > 0)' }
  }

  const title = asTrimmedString(b.title)
  if (!title || title.length > TITLE_MAX) {
    return { ok: false, error: `title обязателен (1..${TITLE_MAX} символов)` }
  }

  const text = asTrimmedString(b.text)
  if (!text || text.length > TEXT_MAX) {
    return { ok: false, error: `text обязателен (1..${TEXT_MAX} символов)` }
  }

  const slug = (asTrimmedString(b.slug) ?? '').slice(0, 200)
  const posterRaw = asTrimmedString(b.poster)
  const poster = posterRaw ? posterRaw.slice(0, 500) : null

  const episode = asOptionalInt(b.episode)
  if (!episode.ok) return { ok: false, error: 'episode должен быть целым числом > 0' }

  const positionSec = asOptionalFloat(b.positionSec)
  if (!positionSec.ok) return { ok: false, error: 'positionSec должен быть числом ≥ 0' }

  const durationSec = asOptionalFloat(b.durationSec)
  if (!durationSec.ok) return { ok: false, error: 'durationSec должен быть числом ≥ 0' }

  const tags = normalizeTags(b.tags)

  return {
    ok: true,
    value: {
      kind,
      animeId: animeId.value,
      slug,
      title,
      poster,
      episode: episode.value,
      text,
      positionSec: positionSec.value,
      durationSec: durationSec.value,
      tags: tags.csv,
    },
  }
}

/** Нормализация и валидация тела PATCH (частичное обновление) */
export function normalizeNotePatch(body: unknown): Ok<NotePatchValues> | Fail {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Ожидался JSON-объект' }
  }
  const b = body as Record<string, unknown>
  const patch: NotePatchValues = {}
  let hasAny = false

  if (b.kind !== undefined) {
    if (!isNoteKind(b.kind)) {
      return { ok: false, error: `kind должен быть одним из: ${NOTE_KINDS.join(', ')}` }
    }
    patch.kind = b.kind
    hasAny = true
  }
  if (b.text !== undefined) {
    const text = asTrimmedString(b.text)
    if (!text || text.length > TEXT_MAX) {
      return { ok: false, error: `text обязателен (1..${TEXT_MAX} символов)` }
    }
    patch.text = text
    hasAny = true
  }
  if (b.tags !== undefined) {
    patch.tags = normalizeTags(b.tags).csv
    hasAny = true
  }
  if (b.episode !== undefined) {
    // null = очистить серию; число > 0 = установить
    if (b.episode === null) {
      patch.episode = null
    } else {
      const episode = asOptionalInt(b.episode)
      if (!episode.ok || episode.value === null) {
        return { ok: false, error: 'episode должен быть целым числом > 0 либо null' }
      }
      patch.episode = episode.value
    }
    hasAny = true
  }

  if (!hasAny) return { ok: false, error: 'Нет полей для обновления (text, tags, episode, kind)' }
  return { ok: true, value: patch }
}

/** Строка ViewerNote → DTO (tags CSV → массив; kind защитно приводится к белому списку) */
export function noteToDto(row: ViewerNoteRow): NoteDto {
  const kind = isNoteKind(row.kind) ? row.kind : 'note'
  return {
    id: row.id,
    kind,
    animeId: row.animeId,
    slug: row.slug,
    title: row.title,
    poster: row.poster,
    episode: row.episode,
    text: row.text,
    positionSec: row.positionSec,
    durationSec: row.durationSec,
    tags: normalizeTags(row.tags).list,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Честная обрезка длинного текста для превью (Обзор, 160 символов) */
export function truncateText(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return clean.slice(0, max - 1).trimEnd() + '…'
}
