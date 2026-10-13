'use client'
/**
 * CosmosBackground — звёздное небо позади интерфейса (fixed, z-0).
 *
 * Celestial Dark Fantasy (ТЗ §20.2): ночная синева, мягкая туманность,
 * статичные звёзды. УРОК РЕЛИЗА 1.0.11 (действует): никаких анимаций,
 * filter/mix-blend/backdrop-filter — слои рисуются один раз, нулевая
 * постоянная нагрузка на GPU в браузере и в EXE.
 * pointer-events-none + aria-hidden: фон не мешает interaction/скринридерам.
 */
export function CosmosBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden>
      {/* Ночная синева: золотой горизонт + млечные дымки + глубина */}
      <div className="cosmos-bg absolute inset-0" />
      {/* Звёзды: три статичные плитки с точками разной крупности */}
      <div className="cosmos-stars absolute inset-0" />
      {/* Виньетка: края темнее, контент читается */}
      <div className="cosmos-vignette absolute inset-0" />
    </div>
  )
}
