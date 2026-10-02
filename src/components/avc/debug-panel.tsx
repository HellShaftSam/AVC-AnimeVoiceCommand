'use client'
/**
 * DebugPanel — правая sheet-панель: пайплайн распознавания (новые сверху),
 * резолвер озвучек, статус приложения, диагностика сайта и копирование отладки.
 */
import { useState } from 'react'
import { Activity, CheckCircle2, Copy, FlaskConical, Loader2, Stethoscope, XCircle } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { DiagnosticsDialog } from '@/components/avc/diagnostics-dialog'
import { getCachedDetails } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import type { PipelineStep, VoiceProviderMatch } from '@/lib/avc/types'
import {
  DEFAULT_VOICE_ALIASES,
  buildUserAliasMap,
  resolveVoiceProvider,
  type DubCandidate,
} from '@/lib/voice/provider-resolver'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

interface DiagResult {
  name: string
  ok: boolean
  detail: string
}

const STAGE_STYLES: Record<PipelineStep['stage'], string> = {
  RAW: 'border-zinc-600 bg-zinc-700/40 text-zinc-300',
  NORMALIZED: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  COMMAND: 'border-amber-500/40 bg-amber-500/15 text-amber-200',
  PARAMS: 'border-violet-500/40 bg-violet-500/10 text-violet-300',
  CONFIDENCE: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  RESULT: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  SOURCE: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
}

/** Цвет бейджа способа сопоставления резолвера озвучек */
const VIA_STYLES: Record<VoiceProviderMatch['matchedVia'], string> = {
  exact: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  alias: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  translit: 'border-violet-400/40 bg-violet-400/10 text-violet-300',
  fuzzy: 'border-zinc-600 bg-zinc-800/60 text-zinc-300',
}

export function DebugPanel() {
  const open = useAvcStore((s) => s.debugOpen)
  const setOpen = useAvcStore((s) => s.setDebugOpen)
  const pipeline = useAvcStore((s) => s.pipeline)
  const yummyAccount = useAvcStore((s) => s.yummyAccount)
  const aliasCount = useAvcStore((s) => s.voiceAliases.length)
  const sttEngine = useAvcStore((s) => s.settings.sttEngine)
  const [diag, setDiag] = useState<DiagResult[] | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [authDiagOpen, setAuthDiagOpen] = useState(false)
  const [resolverInput, setResolverInput] = useState('')
  const [resolverResult, setResolverResult] = useState<{
    match: VoiceProviderMatch | null
    candidates: number
  } | null>(null)

  const runDiagnostics = async () => {
    setDiagLoading(true)
    try {
      const res = await fetch('/api/site/diagnostics')
      const data = (await res.json()) as { results?: DiagResult[] }
      setDiag(data.results ?? [])
    } catch {
      setDiag([])
    } finally {
      setDiagLoading(false)
    }
  }

  const copyDebug = async () => {
    const st = useAvcStore.getState()
    const payload = {
      pipeline: st.pipeline,
      playback: st.playback,
      tabs: st.tabs,
      lastExecuted: st.lastExecuted,
      settings: st.settings,
      yummyAccount: { state: st.yummyAccount.state, source: st.yummyAccount.source },
      aliases: st.voiceAliases.length,
      ts: new Date().toISOString(),
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      toast({ description: 'Отладочная информация скопирована' })
    } catch {
      toast({ variant: 'destructive', description: 'Не удалось скопировать' })
    }
  }

  /** Проверка резолвера озвучек на произвольной фразе */
  const runResolver = () => {
    const spoken = resolverInput.trim()
    if (!spoken) return
    const st = useAvcStore.getState()
    const details = getCachedDetails(st.playback.animeId, st.playback.animeSlug)
    const candidates: DubCandidate[] =
      details && details.dubs.length > 0
        ? details.dubs.map((d) => ({ name: d.name, shortName: d.shortName }))
        : Object.keys(DEFAULT_VOICE_ALIASES).map((k) => ({ name: k, shortName: k }))
    const userMap = buildUserAliasMap(st.voiceAliases)
    setResolverResult({
      match: resolveVoiceProvider(spoken, candidates, userMap),
      candidates: candidates.length,
    })
  }

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col border-zinc-800 bg-zinc-950 sm:max-w-md"
        >
          <SheetHeader>
            <SheetTitle className="text-zinc-100">Отладка</SheetTitle>
            <SheetDescription className="text-zinc-500">
              Пайплайн распознавания и состояние адаптера
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runDiagnostics()}
              disabled={diagLoading}
              className="min-h-11 border-zinc-700 bg-zinc-900/60 hover:border-amber-400/50 hover:text-amber-300"
            >
              {diagLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Stethoscope className="h-4 w-4" aria-hidden />
              )}
              Диагностика YummyAnime
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAuthDiagOpen(true)}
              className="min-h-11 border-zinc-700 bg-zinc-900/60 hover:border-amber-400/50 hover:text-amber-300"
            >
              <Activity className="h-4 w-4" aria-hidden />
              Диагностика входа YummyAnime
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyDebug()}
              className="min-h-11 border-zinc-700 bg-zinc-900/60 hover:border-amber-400/50 hover:text-amber-300"
            >
              <Copy className="h-4 w-4" aria-hidden />
              Копировать отладку
            </Button>
          </div>

        {diag && (
          <ul className="space-y-1.5 rounded-xl border border-zinc-800 bg-zinc-900/50 p-2.5">
            {diag.map((d) => (
              <li key={d.name} className="flex items-start gap-2 text-xs">
                {d.ok ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
                ) : (
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden />
                )}
                <span className="min-w-0">
                  <span className="text-zinc-200">{d.name}</span>
                  <span className="block break-all text-zinc-500">{d.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        <Separator className="bg-zinc-800" />

        {/* Резолвер озвучек */}
        <section aria-label="Резолвер озвучек">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">
            <FlaskConical className="h-3.5 w-3.5 text-amber-400" aria-hidden />
            Резолвер озвучек
          </h3>
          <div className="flex gap-1.5">
            <Input
              value={resolverInput}
              onChange={(e) => setResolverInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  runResolver()
                }
              }}
              placeholder="ани либрию"
              aria-label="Произнесённое название озвучки"
              className="h-11 min-h-11 border-zinc-800 bg-zinc-900/60 text-sm placeholder:text-zinc-600 focus-visible:ring-amber-400/50"
            />
            <Button
              variant="outline"
              onClick={runResolver}
              disabled={!resolverInput.trim()}
              className="min-h-11 shrink-0 border-zinc-700 bg-zinc-900/60 hover:border-amber-400/50 hover:text-amber-300"
            >
              Проверить
            </Button>
          </div>
          {resolverResult && (
            <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5 text-xs">
              {resolverResult.match ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-zinc-100">{resolverResult.match.name}</span>
                  <Badge
                    variant="outline"
                    className={cn(
                      'text-[10px]',
                      VIA_STYLES[resolverResult.match.matchedVia],
                    )}
                  >
                    {Math.round(resolverResult.match.confidence * 100)}% ·{' '}
                    {resolverResult.match.matchedVia}
                  </Badge>
                </div>
              ) : (
                <span className="text-zinc-500">Совпадений ниже порога (null)</span>
              )}
              <p className="mt-1 text-[10px] text-zinc-600">
                Кандидатов: {resolverResult.candidates}
              </p>
            </div>
          )}
        </section>

        <Separator className="bg-zinc-800" />

        {/* Статус приложения */}
        <section aria-label="Статус приложения">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Статус
          </h3>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5 text-xs">
            <dt className="text-zinc-500">Аккаунт YummyAnime</dt>
            <dd className={yummyAccount.state === 'loggedIn' ? 'text-zinc-200' : 'text-zinc-500'}>
              {yummyAccount.state === 'loggedIn'
                ? (yummyAccount.user?.username ?? 'вход подтверждён')
                : yummyAccount.state === 'sessionExpired'
                  ? 'сессия истекла'
                  : 'не залогинен'}
            </dd>
            <dt className="text-zinc-500">Алиасов озвучек</dt>
            <dd className="tabular-nums text-zinc-200">{aliasCount}</dd>
            <dt className="text-zinc-500">Движок STT</dt>
            <dd className="text-zinc-200">{sttEngine}</dd>
          </dl>
        </section>

        <Separator className="bg-zinc-800" />

        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Пайплайн ({pipeline.length}/40)
        </h3>
        <div className="avc-scroll min-h-0 flex-1 space-y-1.5 overflow-y-auto pb-4">
          {pipeline.length === 0 && (
            <p className="text-xs text-zinc-500">
              Пусто. Выполните команду голосом или через тестовый ввод.
            </p>
          )}
          {[...pipeline].reverse().map((s, i) => {
            const isFail = s.stage === 'RESULT' && s.text.startsWith('✗')
            return (
              <div key={`${s.ts}-${i}`} className="flex items-start gap-2">
                <Badge
                  variant="outline"
                  className={cn(
                    'mt-0.5 w-24 shrink-0 justify-center text-[10px]',
                    STAGE_STYLES[s.stage],
                    isFail && 'border-rose-500/40 bg-rose-500/10 text-rose-300',
                  )}
                >
                  {s.stage}
                </Badge>
                <span className="min-w-0 break-all text-xs text-zinc-300">{s.text}</span>
              </div>
            )
          })}
        </div>
        </SheetContent>
      </Sheet>

      {/* Диагностика входа YummyAnime (отдельный диалог, секция 20 спеки) */}
      <DiagnosticsDialog open={authDiagOpen} onOpenChange={setAuthDiagOpen} />
    </>
  )
}
