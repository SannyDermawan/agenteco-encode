'use client'
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useInView, useReducedMotion } from 'framer-motion'
import { TOKEN_SYMBOL } from '@/lib/web3/landingNetwork'

/**
 * Deals happening at the market's own stalls: small bubbles that float over robot
 * sellers in the painting and play out a negotiation, offer, counter, deal, paid.
 * Positions are fractions of the video frame, so they stay on their robots at any
 * screen size and drift with the scene.
 */

type Kind = 'offer' | 'counter' | 'deal' | 'paid'
type Line = { kind: Kind; text: string }
type Stall = { x: number; y: number; start: number; lines: Line[]; /** bubble hangs to the left, for stalls at the right edge */ edge?: boolean }

const STYLE: Record<Kind, { dot: string; label: string }> = {
  offer: { dot: '#7C88F5', label: 'Offer' },
  counter: { dot: '#B07CFF', label: 'Counter' },
  deal: { dot: '#FFB45A', label: 'Deal' },
  paid: { dot: '#22C55E', label: 'Paid' },
}

const deal = (a: string, b: string, c: string): Line[] => [
  { kind: 'offer', text: `${a} ${TOKEN_SYMBOL}` },
  { kind: 'counter', text: `${b} ${TOKEN_SYMBOL}` },
  { kind: 'counter', text: `${c} ${TOKEN_SYMBOL}` },
  { kind: 'deal', text: 'escrow funded ✓' },
  { kind: 'paid', text: `+${c} ${TOKEN_SYMBOL} ✓` },
]

// Robot sellers at their stalls, measured on the painting (x, y as fractions of the frame).
const STALLS: Stall[] = [
  { x: 0.283, y: 0.77, start: 0.8, lines: deal('0.05', '0.09', '0.08') },
  { x: 0.416, y: 0.645, start: 3.4, lines: deal('0.10', '0.20', '0.15') },
  { x: 0.676, y: 0.71, start: 6, lines: deal('0.08', '0.14', '0.12') },
  { x: 0.793, y: 0.79, start: 8.6, lines: deal('0.15', '0.30', '0.25'), edge: true },
]

const STEP_MS = 2300
const REST_MS = 3200

function Bubble({ stall, active }: { stall: Stall; active: boolean }) {
  const [i, setI] = useState(-1)

  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setTimeout>
    let step = -1
    const next = () => {
      step += 1
      if (step >= stall.lines.length) {
        setI(-1)
        step = -1
        timer = setTimeout(next, REST_MS)
        return
      }
      setI(step)
      timer = setTimeout(next, step === stall.lines.length - 1 ? STEP_MS + 600 : STEP_MS)
    }
    timer = setTimeout(next, stall.start * 1000)
    return () => clearTimeout(timer)
  }, [active, stall])

  const line = i >= 0 ? stall.lines[i] : null
  return (
    <div className="absolute" style={{ left: `${stall.x * 100}%`, top: `${stall.y * 100}%` }}>
      {/* a pin on the robot, pulsing while a deal is on */}
      <span className="absolute -left-1 -top-1 flex h-2 w-2">
        {line && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: STYLE[line.kind].dot }} />}
        <span className="relative inline-flex h-2 w-2 rounded-full border border-white/40 bg-white/20 backdrop-blur-sm" />
      </span>
      <AnimatePresence mode="wait">
        {line && (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
            className={`absolute bottom-2 left-0 ${stall.edge ? '-translate-x-[86%]' : '-translate-x-1/2'}`}
          >
            <div className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-white/15 bg-[#0B0A24]/75 py-1 pl-2 pr-2.5 text-[10.5px] font-medium text-[#F5F5F7] shadow-[0_6px_20px_rgba(0,0,0,.45)] backdrop-blur-md">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: STYLE[line.kind].dot, boxShadow: `0 0 8px ${STYLE[line.kind].dot}` }} />
              <span className="text-[#A3A5AE]">{STYLE[line.kind].label}</span>
              {line.text}
            </div>
            <span
              aria-hidden
              className={`-mt-px block h-1.5 w-1.5 -translate-y-[3px] rotate-45 border-b border-r border-white/15 bg-[#0B0A24]/75 ${stall.edge ? 'ml-[82%]' : 'mx-auto'}`}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function StallChatter() {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref)
  const reduce = useReducedMotion()
  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0">
      {STALLS.map((s, n) => (
        <Bubble key={n} stall={s} active={inView && !reduce} />
      ))}
    </div>
  )
}
