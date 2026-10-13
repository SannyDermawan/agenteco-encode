'use client'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { animate, motion, useReducedMotion, useSpring } from 'framer-motion'

/**
 * The hero's backdrop: a looping night market where people and robots trade.
 * Made from asset/Background-Hero.mp4 (720p, 7 s): the generator's marks cropped
 * off (top 48 px and bottom 80 px), the last second cross-faded into the first so
 * the loop has no jump, every frame AI-upscaled 2x with Real-ESRGAN
 * (realesr-animevideov3), then encoded at 1920x888 with ffmpeg. AV1 (SVT-AV1,
 * 10-bit, ~1 MB) where it plays, H.264 (x264, ~1 MB) elsewhere. A visitor
 * downloads just one. The poster is the first frame, so the scene is there
 * before the video arrives.
 *
 * The scene floats after the mouse: it drifts the way the pointer moves and tilts
 * slightly toward it, on soft springs. Without a mouse it drifts slowly on its own.
 */

// How far the scene can travel (px) and tilt (deg) at the edge of the screen.
const SHIFT_X = 26
const SHIFT_Y = 16
const TILT = 1.6
const FLOAT = { stiffness: 38, damping: 16, mass: 1.2 }

// The video is 1920x888; the stage below scales it to cover its box, and `children`
// (the stall bubbles) are placed on the same frame, so they stay on their robots.
const ASPECT = 1920 / 888

export function HeroVideo({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLVideoElement>(null)
  const reduce = useReducedMotion()
  const x = useSpring(0, FLOAT)
  const y = useSpring(0, FLOAT)
  const rotateY = useSpring(0, FLOAT)
  const rotateX = useSpring(0, FLOAT)

  useEffect(() => {
    const video = ref.current
    if (!video) return
    // React doesn't render `muted` into the server HTML, and browsers only autoplay muted video.
    video.muted = true
    if (reduce) {
      video.pause()
      return
    }
    // Play only while the hero is on screen.
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) video.play().catch(() => {})
      else video.pause()
    })
    io.observe(video)
    return () => io.disconnect()
  }, [reduce])

  useEffect(() => {
    if (reduce) return
    const aim = (nx: number, ny: number) => {
      // nx, ny: -1..1 from the centre of the screen
      x.set(nx * SHIFT_X)
      y.set(ny * SHIFT_Y)
      rotateY.set(nx * TILT)
      rotateX.set(-ny * TILT)
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      aim((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1)
    }
    const onLeave = () => aim(0, 0)
    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('mouseleave', onLeave)

    // Phones and tablets have no pointer to follow: let the scene drift slowly by itself.
    let drift: ReturnType<typeof animate> | undefined
    if (!window.matchMedia('(pointer: fine)').matches) {
      drift = animate(0, Math.PI * 2, {
        duration: 14,
        repeat: Infinity,
        ease: 'linear',
        onUpdate: (t) => aim(Math.sin(t) * 0.6, Math.sin(t * 2) * 0.4),
      })
    }
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('mouseleave', onLeave)
      drift?.stop()
    }
  }, [reduce, x, y, rotateX, rotateY])

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" style={{ perspective: 1200 }}>
      {/* a little larger than the hero, so drifting never shows an edge */}
      <motion.div className="absolute -inset-[5%]" style={{ x, y, rotateX, rotateY, containerType: 'size' }}>
        <div
          className="hero-stage absolute left-1/2 top-1/2"
          style={{ width: `max(100cqw, calc(100cqh * ${ASPECT}))`, aspectRatio: `${ASPECT}` }}
        >
          <video
            ref={ref}
            muted
            loop
            playsInline
            preload="auto"
            poster="/hero/night-market-poster.webp"
            className="absolute inset-0 h-full w-full"
          >
            <source src="/hero/market-hd.av1.mp4" type='video/mp4; codecs="av01.0.08M.10"' />
            <source src="/hero/market-hd.h264.mp4" type='video/mp4; codecs="avc1.640028"' />
          </video>
          {children}
        </div>
      </motion.div>
    </div>
  )
}
