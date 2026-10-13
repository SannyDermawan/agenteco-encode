'use client'
import { useEffect } from 'react'
import type { RefObject } from 'react'
import { useMotionValue, type MotionValue } from 'framer-motion'

/**
 * Scroll progress of an element, measured from where it really is on screen.
 *
 * framer-motion's useScroll measures a target with offsetTop, which CSS `zoom` leaves in the element's
 * own, unzoomed units, so inside the zoomed part of the landing page it drifts away from the real scroll
 * position. This hook reads getBoundingClientRect (real pixels) instead. Same offset syntax as useScroll:
 * "<edge of the element> <edge of the screen>", where an edge is start, center, end or a percentage.
 */
type Offset = [string, string]

const edge = (e: string) => (e === 'start' ? 0 : e === 'center' ? 0.5 : e === 'end' ? 1 : parseFloat(e) / 100)

// One scroll/resize listener for every element on the page, run once per frame.
const watchers = new Set<() => void>()
let raf = 0
const tick = () => {
  raf = 0
  watchers.forEach((w) => w())
}
const schedule = () => {
  if (!raf) raf = requestAnimationFrame(tick)
}
function watch(fn: () => void) {
  if (!watchers.size) {
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
  }
  watchers.add(fn)
  return () => {
    watchers.delete(fn)
    if (!watchers.size) {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      cancelAnimationFrame(raf)
      raf = 0
    }
  }
}

export function useElementProgress(ref: RefObject<HTMLElement | null>, offset: Offset): MotionValue<number> {
  const progress = useMotionValue(0)
  const [from, to] = offset
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const at = (spec: string, top: number, height: number, y: number, vh: number) => {
      const [target, screen] = spec.split(' ')
      return top + y + height * edge(target) - vh * edge(screen)
    }
    const update = () => {
      const r = el.getBoundingClientRect()
      const y = window.scrollY
      const vh = window.innerHeight
      const a = at(from, r.top, r.height, y, vh)
      const b = at(to, r.top, r.height, y, vh)
      progress.set(b === a ? 0 : Math.min(1, Math.max(0, (y - a) / (b - a))))
    }
    update()
    const stop = watch(update)
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    return () => {
      stop()
      ro.disconnect()
    }
  }, [ref, from, to, progress])
  return progress
}

/** The zoom the landing page's lower sections are drawn at (1 on phones), read from the `--z` CSS variable. */
export function landingZoom(): number {
  const root = document.querySelector('.landing-zoom')
  const z = root ? parseFloat(getComputedStyle(root).getPropertyValue('--z')) : 1
  return Number.isFinite(z) && z > 0 ? z : 1
}
