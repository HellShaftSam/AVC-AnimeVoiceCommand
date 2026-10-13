'use client'
/**
 * AquariumBackground — «подводный мир» позади интерфейса (fixed, z-0).
 *
 * Слои (сверху вниз по z внутри компонента):
 *  1. aq-depth  — вертикальный градиент глубины: светлее у «поверхности»,
 *                 тёмная бездна внизу (как на референсе).
 *  2. aq-blob   — крупные каустические свечения (cyan/teal), медленно дрейфуют,
 *                 mix-blend: screen — «биолюминесцентные разводы» на воде.
 *  3. aq-ray    — наклонные световые лучи (god rays) из-под поверхности,
 *                 плавно покачиваются.
 *  4. aq-wave   — три светящиеся волны (SVG, бесшовный горизонтальный дрейф):
 *                 яркая «поверхность» под шапкой + два глубинных течения.
 *  5. aq-bubble — пузырьки, поднимающиеся со дна (чистый CSS, без JS-таймеров).
 *  6. aq-vignette — затемнение краёв, чтобы контент читался.
 *
 * Всё анимируется transform/opacity (compositor-friendly, без reflow).
 * prefers-reduced-motion: анимации отключаются в globals.css.
 * pointer-events-none + aria-hidden: фон не мешает interaction/скринридерам.
 */

/** Детерминированный набор пузырьков (без Math.random → нет hydration-мисматчей) */
const BUBBLES: Array<{
  left: number
  size: number
  duration: number
  delay: number
  sway: number
  opacity: number
}> = [
  { left: 3, size: 9, duration: 19, delay: 0, sway: 16, opacity: 0.28 },
  { left: 9, size: 5, duration: 14, delay: 4.2, sway: -12, opacity: 0.22 },
  { left: 15, size: 12, duration: 24, delay: 9.5, sway: 22, opacity: 0.3 },
  { left: 22, size: 6, duration: 16, delay: 2.1, sway: -18, opacity: 0.24 },
  { left: 29, size: 8, duration: 21, delay: 12.8, sway: 14, opacity: 0.26 },
  { left: 37, size: 4, duration: 13, delay: 6.4, sway: -10, opacity: 0.2 },
  { left: 46, size: 11, duration: 26, delay: 1.2, sway: 20, opacity: 0.3 },
  { left: 55, size: 6, duration: 15, delay: 15.3, sway: -14, opacity: 0.22 },
  { left: 63, size: 9, duration: 22, delay: 7.7, sway: 18, opacity: 0.27 },
  { left: 72, size: 5, duration: 14, delay: 10.9, sway: -16, opacity: 0.21 },
  { left: 81, size: 13, duration: 28, delay: 3.6, sway: 24, opacity: 0.3 },
  { left: 90, size: 7, duration: 18, delay: 13.4, sway: -20, opacity: 0.25 },
  { left: 96, size: 5, duration: 15, delay: 5.8, sway: 12, opacity: 0.2 },
]

/** Световая волна: 4 периода по 720px, viewBox 2880 — бесшовный цикл при translateX(-50%) */
function WaveBand({
  idPrefix,
  className,
  fillFrom,
  fillTo,
  crest,
  crestOpacity,
}: {
  idPrefix: string
  className: string
  fillFrom: string
  fillTo: string
  crest?: boolean
  crestOpacity?: number
}) {
  // Форма гребня: гладкая синусоида Q/T-сегментами, L-замыкание вниз
  const wavePath =
    'M0 64 Q 180 24 360 64 T 720 64 T 1080 64 T 1440 64 T 1800 64 T 2160 64 T 2520 64 T 2880 64 L 2880 200 L 0 200 Z'
  return (
    <svg
      className={className}
      viewBox="0 0 2880 200"
      preserveAspectRatio="none"
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient id={`${idPrefix}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fillFrom} />
          <stop offset="100%" stopColor={fillTo} />
        </linearGradient>
      </defs>
      <path d={wavePath} fill={`url(#${idPrefix}-fill)`} />
      {crest && (
        <path
          d="M0 64 Q 180 24 360 64 T 720 64 T 1080 64 T 1440 64 T 1800 64 T 2160 64 T 2520 64 T 2880 64"
          fill="none"
          stroke="rgba(125,211,252,0.85)"
          strokeWidth={2.5}
          opacity={crestOpacity ?? 0.35}
        />
      )}
    </svg>
  )
}

export function AquariumBackground() {
  return (
    <div
      className="aq pointer-events-none fixed inset-0 z-0 overflow-hidden"
      aria-hidden
    >
      {/* 1. Глубина: светлее у поверхности, бездна внизу */}
      <div className="aq-depth absolute inset-0" />

      {/* 2. Каустика — крупные дрейфующие свечения */}
      <div className="aq-blob aq-blob-1 absolute -left-[10%] top-[8%] h-[46vmax] w-[52vmax]" />
      <div className="aq-blob aq-blob-2 absolute left-[30%] top-[38%] h-[40vmax] w-[44vmax]" />
      <div className="aq-blob aq-blob-3 absolute -right-[12%] top-[4%] h-[38vmax] w-[40vmax]" />
      <div className="aq-blob aq-blob-4 absolute bottom-[-14%] left-[18%] h-[42vmax] w-[48vmax]" />

      {/* 3. Световые лучи из-под поверхности */}
      <div className="absolute inset-x-0 top-0 h-[62%]" aria-hidden>
        <div className="aq-ray aq-ray-1 absolute left-[14%] top-0 h-full w-40" />
        <div className="aq-ray aq-ray-2 absolute left-[42%] top-0 h-full w-56" />
        <div className="aq-ray aq-ray-3 absolute left-[71%] top-0 h-full w-32" />
      </div>

      {/* 4. Волны: «поверхность» под шапкой + два глубинных течения */}
      <div className="absolute inset-x-0 top-[52px] h-32">
        <WaveBand
          idPrefix="aq-wave-a"
          className="aq-wave aq-wave-a absolute inset-x-0 top-0 h-full w-[200%]"
          fillFrom="rgba(56,189,248,0.20)"
          fillTo="rgba(56,189,248,0)"
          crest
          crestOpacity={0.42}
        />
        <WaveBand
          idPrefix="aq-wave-b"
          className="aq-wave aq-wave-b absolute inset-x-0 top-3 h-full w-[200%]"
          fillFrom="rgba(45,212,191,0.13)"
          fillTo="rgba(45,212,191,0)"
        />
      </div>
      <div className="absolute inset-x-0 top-[52%] h-40">
        <WaveBand
          idPrefix="aq-wave-c"
          className="aq-wave aq-wave-c absolute inset-x-0 top-0 h-full w-[200%]"
          fillFrom="rgba(56,189,248,0.09)"
          fillTo="rgba(56,189,248,0)"
        />
      </div>
      <div className="absolute inset-x-0 bottom-[84px] h-36">
        <WaveBand
          idPrefix="aq-wave-d"
          className="aq-wave aq-wave-d absolute inset-x-0 top-0 h-full w-[200%]"
          fillFrom="rgba(103,232,249,0.07)"
          fillTo="rgba(103,232,249,0)"
        />
      </div>

      {/* 5. Пузырьки */}
      {BUBBLES.map((b, i) => (
        <span
          key={i}
          className="aq-bubble absolute bottom-[-4%] rounded-full"
          style={{
            left: `${b.left}%`,
            width: b.size,
            height: b.size,
            animationDuration: `${b.duration}s`,
            animationDelay: `-${b.delay}s`,
            ['--aq-sway' as string]: `${b.sway}px`,
            ['--aq-bubble-o' as string]: String(b.opacity),
          }}
        />
      ))}

      {/* 6. Виньетка: края темнее, контент «выпрыгивает» */}
      <div className="aq-vignette absolute inset-0" />
    </div>
  )
}
