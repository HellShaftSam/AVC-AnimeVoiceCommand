'use client'
/**
 * Время по-казахстански (ТЗ п.7): все абсолютные времена в UI — в часовом
 * поясе Астаны (Asia/Almaty, UTC+5) независимо от настроек машины.
 * «через N минут» — от clocks машины (разность времён от пояса не зависит).
 */
import { useEffect, useState } from 'react'

export const KZ_TZ = 'Asia/Almaty'

/** Тикает каждые intervalMs — для честных «через N минут» на плитках */
export function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/** «07:00» — всегда по Астане */
export function formatKzTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: KZ_TZ,
  })
}

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

/** Части даты В ПОЯСЕ АСТАНЫ (для календаря и группировки по дням) */
export function kzDateParts(unixSec: number): {
  y: number
  /** 1..12 */
  m: number
  d: number
  hh: number
  mm: number
  /** 0=Вс … 6=Сб (как Date.getDay) */
  weekday: number
} {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: KZ_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  })
  const parts: Record<string, string> = {}
  for (const p of dtf.formatToParts(new Date(unixSec * 1000))) parts[p.type] = p.value
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    y: parseInt(parts.year, 10),
    m: parseInt(parts.month, 10),
    d: parseInt(parts.day, 10),
    hh: parseInt(parts.hour, 10) % 24,
    mm: parseInt(parts.minute, 10),
    weekday: wdMap[parts.weekday] ?? 0,
  }
}

/** Ключ дня в поясе Астаны: «2026-10-19» (стабильные ключи календаря) */
export function kzDayKey(unixSec: number): string {
  const p = kzDateParts(unixSec)
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

/** «19 октября» (без года) — по Астане */
export function formatKzDate(unixSec: number): string {
  const p = kzDateParts(unixSec)
  return `${p.d} ${MONTHS_GEN[p.m - 1]}`
}

/** «19 окт, 07:00» — по Астане (для плиток анонсов/онгоингов) */
export function formatKzDateTimeShort(unixSec: number): string {
  const p = kzDateParts(unixSec)
  const monShort = MONTHS_GEN[p.m - 1].slice(0, 3)
  return `${p.d} ${monShort}, ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`
}

/** «через 2 ч 15 мин» / «через 40 мин» / «через 4 дн 12 ч» / «серия вышла» */
export function formatRelative(unixSec: number, nowMs: number): string {
  const diffMin = Math.round(unixSec - nowMs / 1000) / 60
  if (!Number.isFinite(diffMin)) return ''
  if (diffMin <= -5) return 'серия вышла'
  if (diffMin < 60) return `через ${Math.max(1, Math.round(diffMin))} мин`
  const h = Math.floor(diffMin / 60)
  const m = Math.round(diffMin % 60)
  if (h < 24) return m > 0 ? `через ${h} ч ${m} мин` : `через ${h} ч`
  const d = Math.floor(h / 24)
  const restH = h % 24
  return restH > 0 ? `через ${d} дн ${restH} ч` : `через ${d} дн`
}

/**
 * Честная подпись даты выхода по её ТОЧНОСТИ (ТЗ: не выдавать «в 2027 году»
 * за точную дату и наоборот). Самодостаточная фраза с предлогом.
 * Все времена — Астана.
 */
export function formatReleaseDate(date: {
  precision: 'day' | 'month' | 'year' | 'unknown'
  unix: number | null
  y: number | null
  m: number | null
}): string {
  if (date.precision === 'day' && date.unix !== null) {
    const p = kzDateParts(date.unix)
    return `${p.d} ${MONTHS_GEN[p.m - 1]} ${p.y}`
  }
  if (date.precision === 'month' && date.y !== null && date.m !== null) {
    return `с ${MONTHS_GEN[date.m - 1]} ${date.y}`
  }
  if (date.precision === 'year' && date.y !== null) return `в ${date.y} году`
  return 'дата не объявлена'
}
