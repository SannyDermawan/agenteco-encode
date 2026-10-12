'use client'
import { useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { motion, useMotionTemplate, useMotionValue, useReducedMotion, useTransform, type MotionValue } from 'framer-motion'
import { landingZoom, useElementProgress } from './scrollProgress'

/**
 * Cinematic layer for the landing page: a stage light over each section,
 * headlines that light up word by word, and cards that catch a light under
 * the cursor. The palette stays the app's own blue / violet on #08090D.
 */

const TONES = { blue: '79,124,255', violet: '139,92,246', indigo: '91,95,239', amber: '255,160,70' } as const
const SPOTS = { center: '50%', left: '20%', right: '80%' } as const

/**
 * A section's backdrop on the plain #08090D page: a stage light from above and a fine grid that fades out
 * of it. Both fade in and out along the section's top and bottom edges, and there is no hairline, so the
 * sections run into one another instead of being cut by a line. Tone and position vary from section to
 * section so the page has rhythm.
 */
export function SectionGlow({ tone = 'indigo', at = 'center' }: { tone?: keyof typeof TONES; at?: keyof typeof SPOTS }) {
  const rgb = TONES[tone]
  const x = SPOTS[at]
  const fade = `radial-gradient(52% 42% at ${x} 0%, #000, transparent 75%)`
  const edges = 'linear-gradient(180deg, transparent 0, #000 220px, #000 calc(100% - 220px), transparent 100%)'
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" style={{ WebkitMaskImage: edges, maskImage: edges }}>
      <div className="absolute inset-0" style={{ background: `radial-gradient(58% 46% at ${x} 0%, rgba(${rgb},.17), transparent 70%)` }} />
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.04) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          WebkitMaskImage: fade,
          maskImage: fade,
        }}
      />
    </div>
  )
}

/**
 * A headline whose words brighten one after another as it scrolls into the
 * middle of the screen — tied to the scroll, so it plays at the reader's pace.
 */
export function WordReveal({ text, className = '', style }: { text: string; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLHeadingElement>(null)
  const reduce = useReducedMotion()
  const scrollYProgress = useElementProgress(ref, ['start 95%', 'start 58%'])
  const words = text.split(' ')
  return (
    <h2 ref={ref} className={className} style={style} aria-label={text}>
      {words.map((word, i) => (
        <Word key={i} progress={scrollYProgress} range={[i / words.length, (i + 1) / words.length]} still={!!reduce}>
          {word}
          {i < words.length - 1 ? ' ' : ''}
        </Word>
      ))}
    </h2>
  )
}

function Word({ children, progress, range, still }: { children: ReactNode; progress: MotionValue<number>; range: [number, number]; still: boolean }) {
  const opacity = useTransform(progress, range, [0.14, 1])
  return (
    <motion.span aria-hidden style={still ? undefined : { opacity }}>
      {children}
    </motion.span>
  )
}

/** A card that lights up where the cursor is, rim included. */
export function SpotlightCard({
  children,
  className = '',
  style,
  color = '91,95,239',
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
  /** rgb triplet of the light */
  color?: string
}) {
  const x = useMotionValue(-400)
  const y = useMotionValue(-400)
  const fill = useMotionTemplate`radial-gradient(360px circle at ${x}px ${y}px, rgba(${color},.14), transparent 45%)`
  const rim = useMotionTemplate`radial-gradient(260px circle at ${x}px ${y}px, rgba(${color},.75), transparent 45%)`
  return (
    <div
      onPointerMove={(e) => {
        // the card is drawn inside the zoomed part of the page: its own pixels are 1/zoom of real ones
        const z = landingZoom()
        const r = e.currentTarget.getBoundingClientRect()
        x.set((e.clientX - r.left) / z)
        y.set((e.clientY - r.top) / z)
      }}
      onPointerLeave={() => {
        x.set(-400)
        y.set(-400)
      }}
      className={`group relative ${className}`}
      style={style}
    >
      {/* the rim: a 1px ring masked out of the light */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] p-px"
        style={{
          background: rim,
          WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
          WebkitMaskComposite: 'xor',
          maskComposite: 'exclude',
        }}
      />
      <motion.div aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit]" style={{ background: fill }} />
      {children}
    </div>
  )
}
