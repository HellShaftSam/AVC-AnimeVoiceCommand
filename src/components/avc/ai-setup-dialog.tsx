'use client'
/**
 * AiSetupDialog — мастер первого запуска AI (спецификация §50–§53, §59, §107–§110, §128).
 *
 * Показывается в EXE, когда модели не установлены и пользователь ещё не пропустил установку.
 * Честно отображает: железо (§50–§51), состав и размеры пакетов (из манифеста),
 * прогресс загрузок по фазам (§56), конкретные ошибки (§58), варианты «Установить
 * рекомендованное / Настроить / Пропустить AI» (§52, §59).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { getElectronBridge, type AiHardwareInfo, type AiModelProgress, type AiStatusSnapshot } from '@/lib/avc/api'

const DISMISS_KEY = 'avc-ai-setup-dismissed'

type Phase = 'loading' | 'ready' | 'installing' | 'done' | 'error'

export function AiSetupDialog() {
  const [open, setOpen] = useState(false)
  const [supported, setSupported] = useState(false)
  const [status, setStatus] = useState<AiStatusSnapshot | null>(null)
  const [hardware, setHardware] = useState<AiHardwareInfo | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [customizing, setCustomizing] = useState(false)
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [progress, setProgress] = useState<Record<string, AiModelProgress>>({})
  const [error, setError] = useState<string | null>(null)
  const [installingKeys, setInstallingKeys] = useState<string[]>([])
  const dismissedRef = useRef(false)

  const refreshStatus = useCallback(async () => {
    const ai = getElectronBridge()?.ai
    if (!ai?.available) return null
    const st = await ai.getStatus()
    setStatus(st)
    return st
  }, [])

  useEffect(() => {
    const ai = getElectronBridge()?.ai
    if (!ai?.available) return
    setSupported(true)
    let cancelled = false
    void (async () => {
      const st = await refreshStatus()
      if (cancelled || !st) return
      const missing = st.models.filter((m) => !m.installed)
      if (missing.length > 0 && !localStorage.getItem(DISMISS_KEY)) {
        setPhase('ready')
        setSelected(Object.fromEntries(st.models.map((m) => [m.key, true])))
        setOpen(true)
        void ai.getHardware().then((hw) => !cancelled && setHardware(hw))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshStatus])

  // прогресс загрузок
  useEffect(() => {
    const ai = getElectronBridge()?.ai
    if (!ai?.available) return
    const off = ai.onModelProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.key]: p }))
    })
    return off
  }, [])

  const install = useCallback(
    async (keys: string[]) => {
      const ai = getElectronBridge()?.ai
      if (!ai?.available || keys.length === 0) return
      setPhase('installing')
      setError(null)
      setInstallingKeys(keys)
      try {
        const results = await ai.install(keys)
        const failed = results.filter((r) => !r.ok)
        if (failed.length > 0) {
          setError(failed.map((f) => `${f.key}: ${f.kind || ''} ${f.message || 'ошибка'}`).join('; '))
          setPhase('error')
        } else {
          await ai.initialize()
          await refreshStatus()
          setPhase('done')
          setOpen(false)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setPhase('error')
      } finally {
        setInstallingKeys([])
      }
    },
    [refreshStatus],
  )

  if (!supported) return null

  const models = status?.models ?? []
  const missingModels = models.filter((m) => !m.installed)
  const totalMissing = missingModels.reduce((a, b) => a + (b.sizeBytes || 0), 0)
  const freeDisk = hardware?.freeDisk ?? null
  const busy = phase === 'installing'

  const fmtPct = (p?: AiModelProgress) => (p?.percent != null ? Math.round(p.percent) : null)

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v && phase !== 'installing') localStorage.setItem(DISMISS_KEY, '1')
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" aria-describedby="ai-setup-desc">
        <DialogHeader>
          <DialogTitle>AVC-Anime AI Setup</DialogTitle>
          <DialogDescription id="ai-setup-desc">
            Локальный голосовой AI: распознавание речи, семантический роутер команд и озвучка ответов
            работают полностью офлайн. Модели скачиваются один раз и проверяются по SHA-256.
          </DialogDescription>
        </DialogHeader>

        {hardware && (
          <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            <div className="mb-1 font-medium text-foreground">Ваш ПК:</div>
            <div>CPU: {hardware.cpu}</div>
            <div>RAM: {hardware.ramHuman}</div>
            <div>
              Диск: {freeDisk != null ? `${(freeDisk / 1024 / 1024 / 1024).toFixed(1)} ГБ свободно` : 'н/д'}
            </div>
            {hardware.gpu?.name && <div>GPU: {hardware.gpu.name}</div>}
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          {models.map((m) => {
            const prog = progress[m.key]
            const pct = fmtPct(prog)
            const isInstalling = installingKeys.includes(m.key)
            const phaseText =
              prog?.phase === 'downloading'
                ? `загрузка ${pct}%`
                : prog?.phase === 'verifying-sha256'
                  ? 'проверка SHA-256…'
                  : prog?.phase === 'extracting'
                    ? 'распаковка…'
                    : prog?.phase === 'done'
                      ? 'готово'
                      : null
            return (
              <div key={m.key} className="rounded-md border p-3">
                <div className="flex items-center gap-3">
                  {!m.installed && !busy ? (
                    <Checkbox
                      id={`ai-${m.key}`}
                      checked={selected[m.key] ?? false}
                      onCheckedChange={(v) => setSelected((s) => ({ ...s, [m.key]: v === true }))}
                      disabled={customizing === false}
                    />
                  ) : (
                    <span aria-hidden>{m.installed ? '✓' : '⬇'}</span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <label htmlFor={`ai-${m.key}`} className="truncate text-sm font-medium">
                        {m.name}
                      </label>
                      <span className="shrink-0 text-xs text-muted-foreground">{m.sizeHuman}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {m.key.toUpperCase()}
                      {m.required ? ' · требуется для голосового ввода' : ' · опционально'}
                      {m.installed ? ' · установлено' : ''}
                      {isInstalling && phaseText ? ` · ${phaseText}` : ''}
                      {prog?.error ? ` · ошибка: ${prog.error}` : ''}
                    </div>
                  </div>
                </div>
                {isInstalling && prog?.percent != null && (
                  <Progress value={Math.min(100, Math.max(0, prog.percent))} className="mt-2 h-1.5" />
                )}
              </div>
            )
          })}
        </div>

        {missingModels.length > 0 && (
          <div className="text-xs text-muted-foreground">
            Всего к загрузке: {(totalMissing / 1024 / 1024).toFixed(0)} МБ
            {freeDisk != null && freeDisk < totalMissing * 1.2 ? ' — возможно недостаточно места на диске' : ''}
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2">
          {phase !== 'installing' && (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  localStorage.setItem(DISMISS_KEY, '1')
                  setOpen(false)
                }}
              >
                Пропустить AI
              </Button>
              <Button variant="outline" onClick={() => setCustomizing((v) => !v)}>
                {customizing ? 'Скрыть настройку' : 'Настроить'}
              </Button>
              <Button
                onClick={() =>
                  install(
                    (customizing ? models.filter((m) => !m.installed && selected[m.key]) : missingModels).map(
                      (m) => m.key,
                    ),
                  )
                }
                disabled={missingModels.length === 0}
              >
                Установить
              </Button>
            </>
          )}
          {phase === 'installing' && (
            <Button disabled>Установка…</Button>
          )}
        </DialogFooter>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Детерминированные голосовые команды работают и без AI-моделей. Пропуск установки можно
          отменить в Настройки → AI.
        </p>
      </DialogContent>
    </Dialog>
  )
}
