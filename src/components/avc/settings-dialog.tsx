'use client'
/**
 * SettingsDialog — настройки приложения. Каждое изменение мгновенно в store,
 * затем debounce 600 мс -> PUT /api/settings.
 */
import { useEffect, useRef } from 'react'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { useAvcStore } from '@/lib/avc/store'
import type { AppSettings } from '@/lib/avc/types'

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-amber-400/90">
      {children}
    </h3>
  )
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm text-zinc-200">{label}</div>
        {hint && <div className="text-xs text-zinc-500">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function SettingsDialog() {
  const open = useAvcStore((s) => s.settingsOpen)
  const setOpen = useAvcStore((s) => s.setSettingsOpen)
  const settings = useAvcStore((s) => s.settings)
  const updateSettings = useAvcStore((s) => s.updateSettings)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const change = (partial: Partial<AppSettings>) => {
    updateSettings(partial)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      void fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(useAvcStore.getState().settings),
      }).catch(() => undefined)
    }, 600)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto avc-scroll sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Настройки</DialogTitle>
          <DialogDescription>
            Изменения применяются сразу и сохраняются автоматически.
          </DialogDescription>
        </DialogHeader>

        <section>
          <SectionTitle>Общие</SectionTitle>
          <div className="py-1">
            <div className="text-sm text-zinc-200">Режим микрофона</div>
            <RadioGroup
              value={settings.voiceMode}
              onValueChange={(v: string) =>
                change({ voiceMode: v === 'always-listening' ? 'always-listening' : 'push-to-talk' })
              }
              className="mt-2 gap-2"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="push-to-talk" id="vm-ptt" />
                <Label htmlFor="vm-ptt" className="text-sm text-zinc-300">
                  Рация — удерживать кнопку / Ctrl+Space
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="always-listening" id="vm-always" />
                <Label htmlFor="vm-always" className="text-sm text-zinc-300">
                  Постоянное слушание (с автоостановкой по тишине)
                </Label>
              </div>
            </RadioGroup>
          </div>
          <SettingRow label="Wake word" hint="Команды только после слова-активатора">
            <div className="flex items-center gap-2">
              <Switch
                checked={settings.wakeWordEnabled}
                onCheckedChange={(v: boolean) => change({ wakeWordEnabled: v })}
                aria-label="Включить wake word"
              />
              <Input
                value={settings.wakeWord}
                onChange={(e) => change({ wakeWord: e.target.value })}
                disabled={!settings.wakeWordEnabled}
                aria-label="Слово-активатор"
                className="h-9 w-28 border-zinc-800 bg-zinc-900"
              />
            </div>
          </SettingRow>
          <SettingRow label="Режим дивана" hint="Крупный интерфейс с дивана">
            <Switch
              checked={settings.couchMode}
              onCheckedChange={(v: boolean) => change({ couchMode: v })}
              aria-label="Режим дивана"
            />
          </SettingRow>
        </section>

        <Separator className="bg-zinc-800" />

        <section>
          <SectionTitle>Голос</SectionTitle>
          <div className="py-2">
            <div className="flex items-center justify-between text-sm text-zinc-200">
              <span>Порог уверенности</span>
              <span className="tabular-nums text-amber-300">
                {Math.round(settings.confidenceThreshold * 100)}%
              </span>
            </div>
            <Slider
              value={[settings.confidenceThreshold]}
              min={0.3}
              max={0.9}
              step={0.05}
              aria-label="Порог уверенности распознавания"
              className="mt-3 [&_[data-slot=slider-range]]:bg-amber-400 [&_[data-slot=slider-thumb]]:border-amber-400"
              onValueChange={(v: number[]) => {
                const val = Array.isArray(v) ? v[0] : undefined
                if (typeof val === 'number') change({ confidenceThreshold: val })
              }}
            />
          </div>
          <SettingRow label="Голосовые ответы" hint="Озвучивать результаты команд (TTS)">
            <Switch
              checked={settings.ttsEnabled}
              onCheckedChange={(v: boolean) => change({ ttsEnabled: v })}
              aria-label="Голосовые ответы"
            />
          </SettingRow>
        </section>

        <Separator className="bg-zinc-800" />

        <section>
          <SectionTitle>Воспроизведение</SectionTitle>
          <SettingRow label="Шаг перемотки">
            <Select
              value={String(settings.seekStep)}
              onValueChange={(v: string) => change({ seekStep: Number(v) })}
            >
              <SelectTrigger aria-label="Шаг перемотки" className="h-9 w-24 border-zinc-800 bg-zinc-900">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900">
                <SelectItem value="5">5 сек</SelectItem>
                <SelectItem value="10">10 сек</SelectItem>
                <SelectItem value="30">30 сек</SelectItem>
                <SelectItem value="60">60 сек</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow label="Шаг громкости">
            <Select
              value={String(settings.volumeStep)}
              onValueChange={(v: string) => change({ volumeStep: Number(v) })}
            >
              <SelectTrigger aria-label="Шаг громкости" className="h-9 w-24 border-zinc-800 bg-zinc-900">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900">
                <SelectItem value="5">5%</SelectItem>
                <SelectItem value="10">10%</SelectItem>
                <SelectItem value="20">20%</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <div className="py-2">
            <div className="flex items-center justify-between text-sm text-zinc-200">
              <span>Громкость по умолчанию</span>
              <span className="tabular-nums text-amber-300">{settings.defaultVolume}%</span>
            </div>
            <Slider
              value={[settings.defaultVolume]}
              min={0}
              max={100}
              step={5}
              aria-label="Громкость по умолчанию"
              className="mt-3 [&_[data-slot=slider-range]]:bg-amber-400 [&_[data-slot=slider-thumb]]:border-amber-400"
              onValueChange={(v: number[]) => {
                const val = Array.isArray(v) ? v[0] : undefined
                if (typeof val === 'number') change({ defaultVolume: val })
              }}
            />
          </div>
          <SettingRow label="Автопереход к следующей серии">
            <Switch
              checked={settings.autoplayNext}
              onCheckedChange={(v: boolean) => change({ autoplayNext: v })}
              aria-label="Автопереход к следующей серии"
            />
          </SettingRow>
        </section>

        <Separator className="bg-zinc-800" />

        <section>
          <SectionTitle>Сайт</SectionTitle>
          <SettingRow label="Базовый URL" hint="Адрес аниме-сайта для адаптера">
            <Input
              value={settings.baseUrl}
              onChange={(e) => change({ baseUrl: e.target.value })}
              aria-label="Базовый URL сайта"
              className="h-9 w-56 border-zinc-800 bg-zinc-900 text-xs"
            />
          </SettingRow>
        </section>

        <Separator className="bg-zinc-800" />

        <section>
          <SectionTitle>Приватность</SectionTitle>
          <SettingRow label="Сохранять историю команд">
            <Switch
              checked={settings.saveHistory}
              onCheckedChange={(v: boolean) => change({ saveHistory: v })}
              aria-label="Сохранять историю"
            />
          </SettingRow>
          <SettingRow
            label="LLM-fallback"
            hint="Если локальный парсер не уверен — фраза уходит в LLM"
          >
            <Switch
              checked={settings.llmFallback}
              onCheckedChange={(v: boolean) => change({ llmFallback: v })}
              aria-label="LLM-fallback"
            />
          </SettingRow>
        </section>
      </DialogContent>
    </Dialog>
  )
}
