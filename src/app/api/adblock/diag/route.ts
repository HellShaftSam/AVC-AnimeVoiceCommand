/**
 * Диагностика AdBlock (Task 16-c).
 *
 * GET /api/adblock/diag → { enabled, attached, events[] [, offline, message] }
 *
 * AdBlock-движок живёт в main-процессе Electron (adblock/engine.cjs) и выставляет
 * состояние на локальном bridge (127.0.0.1:3010/adblock/diag, см. main.cjs).
 * В веб-режиме (браузер без EXE) bridge недоступен — отдаём offline-заглушку.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

interface AdblockDiagEvent {
  ts: number
  url: string
  resourceType: string
  decision: 'BLOCK' | 'ALLOW' | 'ALLOWLIST' | 'OFF'
  rule: string
  sourceKind: string
}

interface AdblockDiag {
  enabled: boolean
  attached: boolean
  events: AdblockDiagEvent[]
  offline?: boolean
  message?: string
}

const OFFLINE_ENABLED_FALSE = {
  attached: false,
  events: [],
  offline: true,
  message: 'AdBlock живёт в приложении AVC (EXE); в веб-режиме недоступен',
}

export async function GET() {
  const base = process.env.AVC_BRIDGE_URL?.replace(/\/+$/, '')
  const candidates = base ? [`${base}/adblock/diag`] : ['http://127.0.0.1:3010/adblock/diag']

  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(2500) })
      if (!res.ok) continue
      const data = (await res.json()) as AdblockDiag
      if (typeof data?.attached !== 'boolean' || !Array.isArray(data?.events)) continue
      return NextResponse.json(data)
    } catch {
      // bridge не отвечает — пробуем следующего кандидата
    }
  }

  // Веб-режим: показываем НАСТРОЕНОЕ значение тумблера (сам фильтр при этом неактивен)
  let enabled = true
  try {
    const row = await db.appSetting.findUnique({ where: { key: 'adblockEnabled' } })
    if (row) enabled = row.value === 'true'
  } catch {
    /* БД недоступна — оставляем дефолт */
  }
  return NextResponse.json({ ...OFFLINE_ENABLED_FALSE, enabled })
}
