'use client'
import type { Transition, Variants } from 'framer-motion'

/**
 * Direction-aware scroll reveals for the landing page.
 *
 * Every reveal replays each time its element enters the viewport. The key is
 * where an element "parks" while hidden: one that scrolled out through the
 * top (user scrolling down) parks slightly above its spot, so scrolling back
 * up brings it in moving down; one that left through the bottom parks below
 * and comes back moving up, mirroring the first-time reveal.
 *
 * Only an element with its own `initial="hidden"` gets this: when it leaves
 * view, framer-motion re-resolves its initial variant (calling the functions
 * below) and uses that variant's transition. Variant children without their
 * own `initial` keep the pose cached at mount, so put the movement on the
 * container and let children only fade.
 */

// Last scroll direction for the whole page, tracked once. Variant functions
// read it at the moment an element leaves the viewport.
let scrollingDown = false
if (typeof window !== 'undefined') {
  let lastY = window.scrollY
  window.addEventListener(
    'scroll',
    () => {
      const y = window.scrollY
      if (y !== lastY) scrollingDown = y > lastY
      lastY = y
    },
    { passive: true }
  )
}

/** Vertical offset for a hidden element: above its spot if it left through the top, below otherwise. */
export function hiddenOffset(distance: number): number {
  return scrollingDown ? -distance : distance
}

/**
 * Counts as "in view" from the first visible pixel and "out of view" only once
 * fully off-screen, so an element never fades out while still visible.
 */
export const REVEAL_VIEWPORT = { once: false, amount: 0 } as const

// Parking happens off-screen, so it should be instant rather than animated.
const PARK: Transition = { duration: 0 }
const EASE = [0.2, 0.8, 0.2, 1] as const

/** Section-level reveal; `custom` is the stagger index. */
export const fadeUp: Variants = {
  hidden: () => ({ opacity: 0, y: hiddenOffset(22), transition: PARK }),
  show: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.55, delay: i * 0.08, ease: EASE },
  }),
}

/** A one-off vertical reveal of `distance` px, for small elements inside a card. */
export function slide(distance: number, transition: Transition): Variants {
  return {
    hidden: () => ({ opacity: 0, y: hiddenOffset(distance), transition: PARK }),
    show: { opacity: 1, y: 0, transition },
  }
}
