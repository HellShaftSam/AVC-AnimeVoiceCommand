'use client'
/**
 * SectionPagination — нумерованная пагинация секций («1 … 5 6 7 … 435»).
 *
 * ТЗ п.5: номер страниц должен быть доступен В ЛЮБОЙ момент скролла —
 * sticky=true липнет к верху скролл-контейнера (#avc-content) и остаётся
 * видимым, пока листаешь сетку. Дублируется снизу (полный набор страниц).
 */
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** Окно страниц: 1, последняя, ±1 вокруг текущей; «…» в разрывах */
function pageWindow(current: number, total: number): Array<number | '…'> {
  const uniq = new Set<number>([1, total, current - 1, current, current + 1])
  const pages = [...uniq].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b)
  const out: Array<number | '…'> = []
  let prev = 0
  for (const p of pages) {
    if (p - prev > 1) out.push('…')
    out.push(p)
    prev = p
  }
  return out
}

export function SectionPagination({
  page,
  totalPages,
  onGo,
  sticky = false,
}: {
  page: number
  totalPages: number
  onGo: (p: number) => void
  /** Липкая панель к верху скролл-контейнера (видна при любом скролле) */
  sticky?: boolean
}) {
  return (
    <nav
      aria-label="Страницы секции"
      className={cn(
        'flex flex-wrap items-center justify-center gap-1.5',
        sticky &&
          'sticky top-0 z-20 -mx-3 mb-4 border-b border-border/60 bg-background/85 px-3 py-2 backdrop-blur-md sm:-mx-4 sm:px-4',
      )}
      data-testid={sticky ? 'pagination-sticky' : 'pagination-bottom'}
    >
      <Button
        variant="outline"
        size="icon"
        aria-label="Предыдущая страница"
        disabled={page <= 1}
        onClick={() => onGo(page - 1)}
        className="h-11 w-11 border-border bg-card/60"
      >
        <ChevronLeft className="h-5 w-5" />
      </Button>
      {pageWindow(page, totalPages).map((p, i) =>
        p === '…' ? (
          <span key={`gap-${i}`} aria-hidden className="px-1 text-sm text-muted-foreground">
            …
          </span>
        ) : (
          <Button
            key={p}
            variant={p === page ? 'default' : 'outline'}
            aria-label={`Страница ${p}`}
            aria-current={p === page ? 'page' : undefined}
            data-testid={`page-${p}`}
            onClick={() => {
              if (p !== page) onGo(p)
            }}
            className={cn(
              'h-11 min-w-11 px-2 text-sm tabular-nums',
              p === page
                ? 'font-bold'
                : 'border-border bg-card/60 text-foreground hover:border-gold-400/40 hover:text-gold-300',
            )}
          >
            {p}
          </Button>
        ),
      )}
      <Button
        variant="outline"
        size="icon"
        aria-label="Следующая страница"
        disabled={page >= totalPages}
        onClick={() => onGo(page + 1)}
        className="h-11 w-11 border-border bg-card/60"
      >
        <ChevronRight className="h-5 w-5" />
      </Button>
      <span className="ml-1 hidden min-w-20 text-center text-sm text-muted-foreground sm:inline">
        {page} из {totalPages}
      </span>
    </nav>
  )
}
