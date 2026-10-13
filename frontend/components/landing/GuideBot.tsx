'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  useVelocity,
  type AnimationPlaybackControls,
  type MotionValue,
} from 'framer-motion'
import { GuideBotArt } from './GuideBotArt'
import type { NegotiationFinished } from './NegotiationSimulator'
import { BACK_LINES, ESCROW_LINE, FAQ_LINES, PET_LINES, TOUR, greeting, hoverLine, liveLine, markVisit, readMs, simLine } from './guideTalk'

/**
 * Eco, the landing page's guide: the blue AgentEco robot floats along as you scroll, flies to a
 * new spot at every section — beside what people look at first, at eye height — and says a line about it. Left alone it explores: it drifts to other
 * empty parts of the page and points out buttons and sliders worth trying. It never sits on text,
 * buttons or cards (it measures what is on screen and steps aside after you scroll). It looks at
 * your cursor, dodges a fast-approaching cursor for a game of tag, reacts when you click it, can be
 * picked up and thrown around, falls asleep if left alone, and can be sent away with the × (for
 * this visit; a refresh brings it back). Landing page only.
 *
 * It also reacts to the page: it cheers or sulks at the negotiation simulator's result, perks up when you
 * hover a button into the app and waves when you press one, nods at FAQ questions, throws confetti at the
 * end of the page, blushes when you pet it (stroke the cursor back and forth over it), hums, looks around
 * and stretches when idle, yawns before it sleeps, says hello when you come back to the tab, greets you by
 * the time of day (and remembers you), shares the marketplace's live numbers, and has a menu (double-click
 * or Enter) with a guided tour of the page.
 */

type Mood = 'idle' | 'happy' | 'surprised' | 'wink' | 'love' | 'dizzy' | 'sleep' | 'lifted' | 'falling' | 'flying' | 'blush' | 'sad' | 'yawn'
/** What scrolling makes it do while it stays put: drop (scrolling down) or soar (scrolling up). */
type Scroll = 'falling' | 'flying'
/** A spot on screen as a fraction of the viewport (x from the left, y from the top). */
type Spot = { x: number; y: number }

// `at` is where people's eyes already are: just beside the headline or the visual of each section, at eye
// height, not down in a corner. (If something is there, the guide settles on the nearest empty spot.)
const GUIDE: Record<string, { at: Spot; line: string }> = {
  hero: { at: { x: 0.13, y: 0.4 }, line: "Hi, I'm Eco! I'll show you around. Scroll down — I'll tag along!" },
  product: { at: { x: 0.87, y: 0.36 }, line: 'This is where AI agents get hired. You only pay when the work is right!' },
  capabilities: { at: { x: 0.11, y: 0.4 }, line: "So many jobs to pick from — translate, analyze, explain… which one's yours?" },
  roles: { at: { x: 0.89, y: 0.34 }, line: "Buyer or seller? I'd be a buyer. I love a bargain!" },
  'how-it-works': { at: { x: 0.1, y: 0.42 }, line: "They haggle, lock the money, then check the work. Try the sliders — it's fun!" },
  proof: { at: { x: 0.87, y: 0.4 }, line: 'Real deals on a real chain. No fibbing here!' },
  developers: { at: { x: 0.1, y: 0.4 }, line: "Want to build your own agent? The SDK makes it easy. You've got this!" },
  faq: { at: { x: 0.88, y: 0.38 }, line: 'Got a question? Somebody here has an answer. Maybe me!' },
  cta: { at: { x: 0.12, y: 0.42 }, line: "Ready? Let's go!" },
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))


type Dim = { vw: number; vh: number; w: number; h: number }
function measure(): Dim {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = vw < 640 ? 72 : 96
  return { vw, vh, w, h: Math.round((w * 560) / 640) }
}

// ---------------------------------------------------------------- finding room to hover

type Box = { l: number; t: number; r: number; b: number }
const CONTENT = 'main :is(h1,h2,h3,h4,h5,h6,p,li,label,button,a,input,select,textarea,img,svg,summary,[role="button"],[data-guide-avoid])'

/** Everything the guide should not sit on, as rectangles in viewport pixels. */
function obstacles(d: Dim): Box[] {
  const out: Box[] = [{ l: 0, t: 0, r: d.vw, b: 84 }] // the navbar
  document.querySelectorAll(CONTENT).forEach((el) => {
    if (el.closest('[data-guide-bot]')) return
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > d.vh || r.right < 0 || r.left > d.vw) return
    if (r.width * r.height > d.vw * d.vh * 0.45) return // a backdrop, not content
    out.push({ l: r.left, t: r.top, r: r.right, b: r.bottom })
  })
  return out
}

// The robot's head and body, without the empty corners of its box.
const bodyBox = (x: number, y: number, d: Dim, m: number): Box => ({
  l: x + d.w * 0.12 - m,
  t: y + d.h * 0.06 - m,
  r: x + d.w * 0.88 + m,
  b: y + d.h * 0.86 + m,
})
function isFree(x: number, y: number, d: Dim, obs: Box[], m = 14): boolean {
  const b = bodyBox(x, y, d, m)
  return !obs.some((o) => o.l < b.r && o.r > b.l && o.t < b.b && o.b > b.t)
}
function sampleSpots(d: Dim, obs: Box[], n = 70): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const x = 8 + Math.random() * Math.max(1, d.vw - d.w - 16)
    // Mostly at eye height (the middle of the screen); only now and then up near the menu or down low.
    const y = Math.random() < 0.8 ? clamp(d.vh * (0.2 + Math.random() * 0.5) - d.h / 2, 88, d.vh - d.h - 8) : 88 + Math.random() * Math.max(1, d.vh - d.h - 96)
    if (isFree(x, y, d, obs)) out.push({ x, y })
  }
  return out
}

const shuffle = <T,>(a: T[]): T[] => [...a].sort(() => Math.random() - 0.5)
const pickOne = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)]

/** Things on screen worth pointing at, each with what Eco says about it. */
function pointOuts(d: Dim): { rect: DOMRect; line: string }[] {
  const found: { rect: DOMRect; line: string }[] = []
  const add = (els: Element[], lines: string[]) =>
    els.slice(0, 4).forEach((el) => {
      if (el.closest('[data-guide-bot]')) return
      const r = el.getBoundingClientRect()
      if (r.top > 100 && r.bottom < d.vh - 30 && r.left > 10 && r.right < d.vw - 10 && r.width > 20 && r.height > 12) found.push({ rect: r, line: pickOne(lines) })
    })
  add([...document.querySelectorAll('a[href="/app/marketplace"]')], ['This button opens the marketplace. Go on, press it!'])
  add([...document.querySelectorAll('input[type="range"]')].slice(0, 1), ['Drag these sliders and watch the deal change!'])
  add([...document.querySelectorAll('button')].filter((b) => /replay/i.test(b.textContent ?? '')), ['Press Replay to watch the haggling again!'])
  add([...document.querySelectorAll('[class*="cursor-grab"]')], ['Grab the ring and give it a spin!'])
  add([...document.querySelectorAll('a[href^="/app/"]:not([href="/app/marketplace"])')], ['This link takes you into the app.'])
  add([...document.querySelectorAll('main h2')], ['Psst — this part is a good one!', "Read this bit. I'll wait!", 'Ooh, I like this section!'])
  return found
}

/** A free spot right beside a rectangle (so the guide points at it without covering it). */
function spotBeside(r: DOMRect, d: Dim, obs: Box[]): { x: number; y: number } | null {
  const clampX = (x: number) => clamp(x, 8, d.vw - d.w - 8)
  const clampY = (y: number) => clamp(y, 88, d.vh - d.h - 8)
  const tries = shuffle([
    { x: r.right + 10 - d.w * 0.12, y: r.top + r.height / 2 - d.h / 2 },
    { x: r.left - d.w * 0.88 - 10, y: r.top + r.height / 2 - d.h / 2 },
    { x: r.left + r.width / 2 - d.w / 2, y: r.bottom + 8 - d.h * 0.06 },
    { x: r.left + r.width / 2 - d.w / 2, y: r.top - d.h * 0.86 - 8 },
  ])
  for (const t of tries) {
    const x = clampX(t.x)
    const y = clampY(t.y)
    if (isFree(x, y, d, obs, 6)) return { x, y }
  }
  return null
}

const WANDER = ["Just exploring!", "Don't mind me, I'm looking around.", 'La la la…', 'So much to see here!']

// ---------------------------------------------------------------- the face

const EYE_GLOW = 'drop-shadow(0 0 6px rgba(79,124,255,.95))'
const PINK = '#FF8FB5'
const ARC = '#9DB0FF'
const MOUTH = '#7182D7'
const HEART = 'M0 15 C-16 3 -20 -9 -12 -16 C-6 -21 0 -18 0 -12 C0 -18 6 -21 12 -16 C20 -9 16 3 0 15 Z'
const SPIRAL = 'M0 0 a3 3 0 0 1 6 0 a7 7 0 0 1 -14 0 a11 11 0 0 1 22 0 a15 15 0 0 1 -30 0'
const SPIN = { animate: { rotate: 360 }, transition: { duration: 0.9, repeat: Infinity, ease: 'linear' as const } }
const SPIN_STYLE = { transformBox: 'fill-box' as const, transformOrigin: 'center' }

function Eyes({ mood, blink }: { mood: Mood; blink: boolean }) {
  switch (mood) {
    case 'love':
      return (
        <>
          <path d={HEART} transform="translate(378 247)" fill={PINK} />
          <path d={HEART} transform="translate(426 243)" fill={PINK} />
        </>
      )
    case 'blush':
    case 'happy':
      return (
        <>
          <path d="M363 255 Q378 228 393 255" stroke={ARC} strokeWidth="9" strokeLinecap="round" />
          <path d="M411 251 Q426 224 441 251" stroke={ARC} strokeWidth="9" strokeLinecap="round" />
        </>
      )
    case 'wink':
      return (
        <>
          <rect x="365" y="224" width="25" height="47" rx="13" fill="url(#guide-guide-accent)" transform="rotate(-5 352 255)" />
          <ellipse cx="380" cy="243" rx="5" ry="8" fill="#FFFFFF" opacity="0.78" />
          <path d="M411 251 Q426 224 441 251" stroke={ARC} strokeWidth="9" strokeLinecap="round" />
        </>
      )
    case 'surprised':
    case 'lifted': {
      const rx = mood === 'surprised' ? 16 : 14
      const ry = mood === 'surprised' ? 28 : 24
      return (
        <>
          <ellipse cx="378" cy="247" rx={rx} ry={ry} fill="url(#guide-guide-accent)" />
          <ellipse cx="383" cy="236" rx="5" ry="8" fill="#FFFFFF" opacity="0.85" />
          <ellipse cx="426" cy="243" rx={rx} ry={ry} fill="url(#guide-guide-accent)" />
          <ellipse cx="431" cy="232" rx="5" ry="8" fill="#FFFFFF" opacity="0.85" />
        </>
      )
    }
    case 'dizzy':
      return (
        <>
          <g transform="translate(378 247)">
            <motion.path d={SPIRAL} stroke={ARC} strokeWidth="4" strokeLinecap="round" {...SPIN} style={SPIN_STYLE} />
          </g>
          <g transform="translate(426 243)">
            <motion.path d={SPIRAL} stroke={ARC} strokeWidth="4" strokeLinecap="round" {...SPIN} style={SPIN_STYLE} />
          </g>
        </>
      )
    case 'falling':
      // eyes wide open, blown back by the wind
      return (
        <>
          <ellipse cx="378" cy="244" rx="17" ry="30" fill="url(#guide-guide-accent)" />
          <ellipse cx="383" cy="230" rx="5" ry="8" fill="#FFFFFF" opacity="0.9" />
          <ellipse cx="426" cy="240" rx="17" ry="30" fill="url(#guide-guide-accent)" />
          <ellipse cx="431" cy="226" rx="5" ry="8" fill="#FFFFFF" opacity="0.9" />
        </>
      )
    case 'flying':
      // narrowed, determined eyes: it knows where it is going
      return (
        <>
          <ellipse cx="379" cy="252" rx="14" ry="15" fill="url(#guide-guide-accent)" />
          <ellipse cx="383" cy="247" rx="4" ry="5" fill="#FFFFFF" opacity="0.85" />
          <path d="M358 232 L394 245" stroke={ARC} strokeWidth="7" strokeLinecap="round" />
          <ellipse cx="426" cy="248" rx="14" ry="15" fill="url(#guide-guide-accent)" />
          <ellipse cx="430" cy="243" rx="4" ry="5" fill="#FFFFFF" opacity="0.85" />
          <path d="M447 228 L411 241" stroke={ARC} strokeWidth="7" strokeLinecap="round" />
        </>
      )
    case 'sad':
      // drooping eyes under worried brows
      return (
        <>
          <ellipse cx="378" cy="254" rx="11" ry="17" fill="url(#guide-guide-accent)" />
          <ellipse cx="381" cy="247" rx="3.5" ry="5" fill="#FFFFFF" opacity="0.8" />
          <path d="M360 233 L392 222" stroke={ARC} strokeWidth="6" strokeLinecap="round" />
          <ellipse cx="426" cy="250" rx="11" ry="17" fill="url(#guide-guide-accent)" />
          <ellipse cx="429" cy="243" rx="3.5" ry="5" fill="#FFFFFF" opacity="0.8" />
          <path d="M412 218 L444 229" stroke={ARC} strokeWidth="6" strokeLinecap="round" />
        </>
      )
    case 'yawn':
      // squeezed shut: > <
      return (
        <>
          <path d="M365 241 L390 251 L365 261" stroke={ARC} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M441 237 L416 247 L441 257" stroke={ARC} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )
    case 'sleep':
      return (
        <>
          <path d="M364 248 Q378 261 392 248" stroke={ARC} strokeWidth="7" strokeLinecap="round" />
          <path d="M412 244 Q426 257 440 244" stroke={ARC} strokeWidth="7" strokeLinecap="round" />
        </>
      )
    default:
      return (
        <g style={{ transformBox: 'fill-box', transformOrigin: 'center', transform: blink ? 'scaleY(0.1)' : 'scaleY(1)', transition: 'transform 90ms' }}>
          <rect x="365" y="224" width="25" height="47" rx="13" fill="url(#guide-guide-accent)" transform="rotate(-5 352 255)" />
          <ellipse cx="380" cy="243" rx="5" ry="8" fill="#FFFFFF" opacity="0.78" />
          <rect x="414" y="222" width="22" height="42" rx="13.5" fill="url(#guide-guide-accent)" transform="rotate(-4 410 247)" />
          <ellipse cx="427" cy="238" rx="5" ry="8" fill="#FFFFFF" opacity="0.84" />
        </g>
      )
  }
}

function Mouth({ mood }: { mood: Mood }) {
  switch (mood) {
    case 'happy':
      return <path d="M386 298 Q405 328 424 298 Z" fill="#1B2447" stroke={MOUTH} strokeWidth="4" strokeLinejoin="round" />
    case 'love':
      return <path d="M390 301 Q405 320 420 301" stroke={MOUTH} strokeWidth="4" strokeLinecap="round" />
    case 'wink':
      return <path d="M388 305 Q406 318 425 299" stroke={MOUTH} strokeWidth="4" strokeLinecap="round" />
    case 'surprised':
      return <ellipse cx="405" cy="314" rx="7" ry="9" fill="#1B2447" stroke={MOUTH} strokeWidth="4" />
    case 'lifted':
      return <ellipse cx="405" cy="312" rx="5" ry="7" fill="#1B2447" stroke={MOUTH} strokeWidth="4" />
    case 'dizzy':
      return <path d="M386 307 q5 -7 10 0 t10 0 t10 0" stroke={MOUTH} strokeWidth="4" strokeLinecap="round" />
    case 'falling':
      // a long scream, cheeks flapping
      return (
        <motion.g
          style={{ transformBox: 'fill-box', transformOrigin: 'center top' }}
          animate={{ scaleY: [1, 0.82, 1], scaleX: [1, 1.06, 1] }}
          transition={{ duration: 0.16, repeat: Infinity }}
        >
          <path d="M383 294 Q405 346 427 294 Z" fill="#1B2447" stroke={MOUTH} strokeWidth="4" strokeLinejoin="round" />
          <path d="M395 320 Q405 330 415 320 Q405 312 395 320 Z" fill="#E8798F" opacity="0.8" />
        </motion.g>
      )
    case 'flying':
      return <path d="M384 297 Q405 332 426 297 Z" fill="#1B2447" stroke={MOUTH} strokeWidth="4" strokeLinejoin="round" />
    case 'blush':
      return <path d="M392 303 Q405 316 418 303" stroke={MOUTH} strokeWidth="4" strokeLinecap="round" />
    case 'sad':
      return <path d="M390 316 Q405 303 420 316" stroke={MOUTH} strokeWidth="4" strokeLinecap="round" />
    case 'yawn':
      return <ellipse cx="405" cy="317" rx="11" ry="16" fill="#1B2447" stroke={MOUTH} strokeWidth="4" />
    case 'sleep':
      return <path d="M398 308 Q405 313 412 308" stroke={MOUTH} strokeWidth="3" strokeLinecap="round" />
    default:
      return (
        <>
          <path d="M388 302 C397 309 411 311 422 304" stroke={MOUTH} strokeWidth="4" strokeLinecap="round" />
          <path d="M396 305 C403 308 410 308 416 305" stroke="#AAB5EE" strokeWidth="1.5" opacity="0.62" />
        </>
      )
  }
}

function Face({ mood, blink, lookX, lookY }: { mood: Mood; blink: boolean; lookX: MotionValue<number>; lookY: MotionValue<number> }) {
  return (
    <>
      <motion.g style={{ x: lookX, y: lookY, filter: EYE_GLOW }}>
        <Eyes mood={mood} blink={blink} />
      </motion.g>
      <g>
        <Mouth mood={mood} />
      </g>
      {(mood === 'blush' || mood === 'love') && (
        <g opacity="0.55">
          <ellipse cx="362" cy="292" rx="13" ry="7" fill={PINK} />
          <ellipse cx="449" cy="286" rx="12" ry="7" fill={PINK} />
        </g>
      )}
    </>
  )
}

// ---------------------------------------------------------------- bits that float off the head

type Spark = { id: number; glyph: string; color: string; dx: number; confetti?: { dy: number; rot: number } }

function SparkView({ spark, onDone }: { spark: Spark; onDone: (id: number) => void }) {
  if (spark.confetti) {
    // a paper scrap: shoots up and out, then flutters down
    const { dy, rot } = spark.confetti
    return (
      <motion.span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[35%] h-[5px] w-[9px] rounded-[1px]"
        style={{ background: spark.color }}
        initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
        animate={{ x: spark.dx, y: [0, dy, dy + 170], rotate: rot, opacity: [1, 1, 0] }}
        transition={{ duration: 1.9, ease: 'easeOut', y: { duration: 1.9, times: [0, 0.3, 1], ease: ['easeOut', 'easeIn'] } }}
        onAnimationComplete={() => onDone(spark.id)}
      />
    )
  }
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-[8%] text-[18px] font-bold leading-none"
      style={{ color: spark.color, marginLeft: spark.dx, textShadow: '0 0 10px currentColor' }}
      initial={{ opacity: 0, y: 0, scale: 0.5 }}
      animate={{ opacity: [0, 1, 1, 0], y: -52, scale: [0.5, 1.15, 1, 0.9] }}
      transition={{ duration: 1.5, ease: 'easeOut' }}
      onAnimationComplete={() => onDone(spark.id)}
    >
      {spark.glyph}
    </motion.span>
  )
}

// ---------------------------------------------------------------- the guide

// ---------------------------------------------------------------- wind

// Air streaks rush past while the page scrolls: up past a falling bot, down past a flying one.
const STREAKS = Array.from({ length: 16 }, (_, i) => ({
  x: -34 + ((i * 41) % 168),
  top: 4 + ((i * 29) % 70),
  len: 24 + ((i * 13) % 34),
  dur: 0.36 + ((i * 7) % 6) * 0.04,
  delay: ((i * 0.083) % 0.5),
  back: i % 2 === 0,
}))

function Wind({ mode, power, layer }: { mode: Scroll | null; power: MotionValue<number>; layer: 'back' | 'front' }) {
  return (
    <motion.div aria-hidden className="pointer-events-none absolute inset-0" style={{ opacity: power }}>
      <AnimatePresence>
        {mode && (
          <motion.div
            key={mode}
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {STREAKS.filter((s) => (layer === 'back') === s.back).map((s, i) => (
              <motion.span
                key={i}
                className="absolute w-[3px] rounded-full"
                style={{
                  left: `${s.x}%`,
                  top: `${s.top}%`,
                  height: s.len,
                  background: 'linear-gradient(to bottom, transparent, rgba(235,242,255,1), transparent)',
                }}
                initial={{ y: mode === 'falling' ? 100 : -100 }}
                animate={{ y: mode === 'falling' ? -100 : 100 }}
                transition={{ duration: s.dur, delay: s.delay, repeat: Infinity, ease: 'linear' }}
              />
            ))}
            {mode === 'flying' && layer === 'back' && (
              // thrust: a warm glow pulsing under the body
              <motion.span
                className="absolute bottom-[-10px] left-[18%] h-[34px] w-[64%] rounded-full"
                style={{ background: 'radial-gradient(closest-side, rgba(255,196,120,.7), rgba(255,140,80,.25) 60%, transparent)', filter: 'blur(5px)' }}
                animate={{ scaleY: [1, 1.35, 1], opacity: [0.75, 1, 0.75] }}
                transition={{ duration: 0.22, repeat: Infinity }}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function MenuItem({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="rounded-xl px-3 py-1.5 text-left transition hover:bg-white/[0.08] focus-visible:bg-white/[0.08] focus-visible:outline-none"
    >
      <span className="block text-[13px] font-medium text-[#F5F5F7]">{label}</span>
      <span className="block text-[11px] text-[#7C7E87]">{hint}</span>
    </button>
  )
}

const REACTIONS = ['happy', 'surprised', 'wink', 'love', 'spin'] as const

type Touch = {
  id: number
  sx: number
  sy: number
  bx: number
  by: number
  moved: boolean
  held: boolean
  holdTimer?: ReturnType<typeof setTimeout>
  trail: { x: number; y: number; t: number }[]
  /** how dizzy the shaking has made it: sharp reversals add up, and it fades while held still */
  dizz: number
  dir: { x: number; y: number }
  lastT: number
}

/** Release speed (px/s) from which a thrown Eco bounces around; slower releases just glide. */
const BOUNCE_FROM = 750

export function GuideBot() {
  const reduce = useReducedMotion()
  const [hidden, setHidden] = useState(false) // hiding lasts for this visit only: a refresh brings Eco back
  const [dim, setDim] = useState(measure)
  const dimRef = useRef(dim)
  const [mood, setMoodState] = useState<Mood>('idle')
  const moodRef = useRef<Mood>('idle')
  const [blink, setBlink] = useState(false)
  const [bubble, setBubble] = useState<{ text: string; key: number; below: boolean; right: boolean; maxW: number } | null>(null)
  const [sparks, setSparks] = useState<Spark[]>([])
  const [dragging, setDragging] = useState(false)
  const [scrollMode, setScrollMode] = useState<Scroll | null>(null)
  const [calming, setCalming] = useState(false)
  const [faceDone, setFaceDone] = useState(false)

  // Where the bot is (top-left of its box, in viewport pixels) and how its body moves.
  const posX = useMotionValue(-400)
  const posY = useMotionValue(0)
  const bobY = useMotionValue(0)
  const bodyY = useMotionValue(0)
  const bodyRot = useMotionValue(0)
  const shake = useMotionValue(0)
  // How strongly the scroll effect grips the body (0 at rest, 1 at full speed). Everything about the squash
  // and shudder is derived from it, so starting and stopping are eased, never a jump.
  const fxPower = useMotionValue(0)
  const dirMix = useMotionValue(1) // eases between 1 (falling) and 0 (flying), so a change of direction never jumps
  const windFade = useRef<AnimationPlaybackControls | null>(null)
  const windPower = useMotionValue(0.6)
  const scaleX = useSpring(1, { stiffness: 260, damping: 12 })
  const scaleY = useSpring(1, { stiffness: 260, damping: 12 })
  // Looks, leans and drifts toward the cursor.
  const lookX = useSpring(0, { stiffness: 120, damping: 18 })
  const lookY = useSpring(0, { stiffness: 120, damping: 18 })
  const lean = useSpring(0, { stiffness: 70, damping: 16 })
  const pullX = useSpring(0, { stiffness: 30, damping: 14 })
  const pullY = useSpring(0, { stiffness: 30, damping: 14 })
  // Tilts with its own speed: forward when it flies, back when it brakes.
  const velX = useVelocity(posX)
  const tiltRaw = useTransform(velX, (v) => clamp(v / 70, -22, 22))
  const tilt = useSpring(tiltRaw, { stiffness: 120, damping: 14 })
  const rotate = useTransform([lean, bodyRot, tilt], ([a, b, c]) => (a as number) + (b as number) + (c as number))
  // Falling: the air presses up on its underside, squashing it from below (shorter, wider) around its top edge.
  // Flying: it stretches a little upward from its base.
  const bodyScaleX = useTransform([scaleX, fxPower, dirMix], ([a, p, m]) => (a as number) * (1 + (-0.05 + 0.14 * (m as number)) * (p as number)))
  const bodyScaleY = useTransform([scaleY, fxPower, dirMix], ([a, p, m]) => (a as number) * (1 + (0.09 - 0.23 * (m as number)) * (p as number)))
  const originY = useTransform([fxPower, dirMix], ([p, m]) => 0.85 + (0.9 - 0.8 * (m as number) - 0.85) * (p as number))
  const bodyX = useTransform([shake, fxPower, dirMix], ([sh, p, m]) => (sh as number) * 1.8 * (p as number) * (m as number))

  const flyX = useRef<AnimationPlaybackControls | null>(null)
  const flyY = useRef<AnimationPlaybackControls | null>(null)
  // the frame loop of a thrown bounce (see throwIt); stopped wherever a flight is stopped
  const bounceRaf = useRef(0)
  const moodTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const bubbleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const homeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const sleepTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const sparkId = useRef(0)
  const bubbleId = useRef(0)
  const home = useRef<Spot>({ x: 0.13, y: 0.4 })
  const sectionKey = useRef('hero')
  const seen = useRef(new Set<string>())
  const clicks = useRef<number[]>([])
  const reactions = useRef(0)
  const touch = useRef<Touch | null>(null)
  const scheduleRoamRef = useRef<(ms?: number) => void>(() => {})
  const dodge = useRef({ count: 0, until: 0, last: 0, first: 0 })
  const [menu, setMenu] = useState<{ below: boolean; right: boolean } | null>(null)
  const [touring, setTouring] = useState(false)
  const menuRef = useRef(false)
  const tourRef = useRef(false)
  const startTourRef = useRef<() => void>(() => {})
  const stopTourRef = useRef<(interrupted: boolean) => void>(() => {})
  const lastSaid = useRef(0)
  // a line that stays up while the page scrolls (normally scrolling clears the bubble)
  const sticky = useRef(false)
  const taps = useRef<number[]>([])
  const lastTap = useRef(0)
  const tapTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const live = useRef<string | null>(null)
  const botEl = useRef<HTMLDivElement>(null)

  const setMood = useCallback((m: Mood, ms?: number) => {
    clearTimeout(moodTimer.current)
    moodRef.current = m
    setMoodState(m)
    if (ms) {
      moodTimer.current = setTimeout(() => {
        // still in someone's hand: back to the "lifted" face, not the idle one
        const next = touch.current && (touch.current.moved || touch.current.held) ? 'lifted' : 'idle'
        moodRef.current = next
        setMoodState(next)
      }, ms)
    }
  }, [])

  const say = useCallback(
    (text: string, ms = 3200, keep = false) => {
      clearTimeout(bubbleTimer.current)
      sticky.current = keep
      const d = dimRef.current
      const bx = posX.get()
      const by = posY.get()
      // Put the bubble where it covers nothing: try above/below, left/right-aligned, wide to narrow.
      const obs = obstacles(d)
      const preferRight = bx + d.w / 2 > d.vw / 2
      const sides = preferRight ? [true, false] : [false, true]
      // How many things a bubble placed this way would sit on (Infinity: it would leave the screen).
      const overlap = (below: boolean, right: boolean, maxW: number) => {
        const w = Math.min(maxW, 28 + text.length * 6.6)
        const lines = Math.ceil((text.length * 6.6) / Math.max(40, w - 28))
        const h = lines * 18 + 22
        const l = right ? bx + d.w - w : bx
        const t = below ? by + d.h - 4 : by + 6 - h
        if (l < 4 || l + w > d.vw - 4 || t < 4 || t + h > d.vh - 4) return Infinity
        return obs.filter((o) => o.l < l + w + 4 && o.r > l - 4 && o.t < t + h + 4 && o.b > t - 4).length
      }
      let pick = { below: by < 150, right: preferRight, maxW: Math.min(240, d.vw - 24) }
      let least = Infinity
      search: for (const maxW of [240, 200, 160]) {
        for (const below of by < 150 ? [true, false] : [false, true]) {
          for (const right of sides) {
            const n = overlap(below, right, maxW)
            if (n < least) {
              least = n
              pick = { below, right, maxW }
              if (n === 0) break search
            }
          }
        }
      }
      lastSaid.current = Date.now()
      bubbleId.current += 1
      setBubble({ text, key: bubbleId.current, ...pick })
      bubbleTimer.current = setTimeout(() => {
        sticky.current = false
        setBubble(null)
      }, ms)
    },
    [posX, posY]
  )

  // Lines nobody asked for (reactions to the page, musings) wait their turn: at most one every 7 s, and
  // never while it is held, the menu is open or the tour is running.
  const chat = useCallback(
    (text: string, ms?: number) => {
      if (menuRef.current || tourRef.current || touch.current) return false
      if (Date.now() - lastSaid.current < 7000) return false
      say(text, ms ?? readMs(text))
      return true
    },
    [say]
  )
  const burst = useCallback((glyph: string, color: string, count = 3) => {
    const made = Array.from({ length: count }, (_, i) => ({
      id: (sparkId.current += 1),
      glyph,
      color,
      dx: (i - (count - 1) / 2) * 26 + (Math.random() * 10 - 5),
    }))
    setSparks((s) => [...s, ...made])
  }, [])
  const dropSpark = useCallback((id: number) => setSparks((s) => s.filter((x) => x.id !== id)), [])
  const confetti = useCallback(() => {
    if (reduce) return
    const colors = ['#FFD27A', '#7C88F5', '#B07CFF', '#22C55E', '#FF8FB5', '#5EC8FF']
    const made: Spark[] = Array.from({ length: 22 }, (_, i) => ({
      id: (sparkId.current += 1),
      glyph: '',
      color: colors[i % colors.length],
      dx: (Math.random() - 0.5) * 230,
      confetti: { dy: -60 - Math.random() * 90, rot: (Math.random() - 0.5) * 720 },
    }))
    setSparks((s) => [...s, ...made])
  }, [reduce])

  const fx = useCallback(
    (kind: 'hop' | 'jump' | 'tilt' | 'spin' | 'wobble' | 'nod' | 'sway') => {
      if (reduce) return
      switch (kind) {
        case 'hop':
          animate(bodyY, [0, -20, 0, -9, 0], { duration: 0.7, ease: 'easeOut' })
          break
        case 'jump':
          animate(bodyY, [0, -30, 0], { duration: 0.55, ease: 'easeOut' })
          scaleX.set(1.12)
          scaleY.set(1.12)
          setTimeout(() => {
            scaleX.set(1)
            scaleY.set(1)
          }, 260)
          break
        case 'tilt':
          animate(bodyRot, [0, -13, 11, 0], { duration: 0.7, ease: 'easeInOut' })
          break
        case 'spin':
          animate(bodyRot, [0, 360], { duration: 0.85, ease: [0.3, 0, 0.2, 1] }).then(() => bodyRot.set(0))
          animate(bodyY, [0, -16, 0], { duration: 0.85, ease: 'easeOut' })
          break
        case 'nod':
          animate(bodyY, [0, 7, 0, 7, 0], { duration: 0.7, ease: 'easeInOut' })
          break
        case 'sway':
          animate(bodyRot, [0, -6, 6, -6, 6, 0], { duration: 2.2, ease: 'easeInOut' })
          break
        case 'wobble':
          animate(bodyRot, [0, -10, 10, -8, 8, -5, 5, 0], { duration: 1.8 })
          break
      }
    },
    [reduce, bodyY, bodyRot, scaleX, scaleY]
  )

  // ---- moving around

  const bounds = useCallback(() => {
    const d = dimRef.current
    return { minX: 0, maxX: d.vw - d.w, minY: 72, maxY: d.vh - d.h }
  }, [])

  const anchor = useCallback((at: Spot) => {
    const { vw, vh, w, h } = dimRef.current
    return { x: clamp(at.x * vw - w / 2, 8, vw - w - 8), y: clamp(at.y * vh - h / 2, 88, vh - h - 8) }
  }, [])

  // The corner a section prefers, or the nearest spot to it that no text, button or card is under.
  const placeNear = useCallback(
    (at: Spot) => {
      const a = anchor(at)
      const d = dimRef.current
      const obs = obstacles(d)
      if (isFree(a.x, a.y, d, obs)) return a
      const spots = sampleSpots(d, obs, 90)
      if (!spots.length) return a
      spots.sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y))
      return spots[0]
    },
    [anchor]
  )

  const flyTo = useCallback(
    (x: number, y: number, fast = false) => {
      flyX.current?.stop()
      flyY.current?.stop()
      cancelAnimationFrame(bounceRaf.current)
      if (reduce) {
        posX.set(x)
        posY.set(y)
        return
      }
      flyX.current = animate(posX, x, fast ? { type: 'spring', stiffness: 90, damping: 14, mass: 1 } : { type: 'spring', stiffness: 34, damping: 12, mass: 1.1 })
      flyY.current = animate(posY, y, fast ? { type: 'spring', stiffness: 110, damping: 14, mass: 1 } : { type: 'spring', stiffness: 48, damping: 11, mass: 1 })
    },
    [reduce, posX, posY]
  )

  const goHome = useCallback(() => {
    const a = placeNear(home.current)
    flyTo(a.x, a.y)
  }, [placeNear, flyTo])

  const scheduleHome = useCallback(
    (ms: number) => {
      clearTimeout(homeTimer.current)
      homeTimer.current = setTimeout(goHome, ms)
    },
    [goHome]
  )

  // ---- sleeping

  const bump = useCallback(() => {
    clearTimeout(sleepTimer.current)
    if (moodRef.current === 'yawn') setMood('idle')
    const doze = () => {
      if (moodRef.current === 'sleep') return
      // busy right now (a reaction, a drag, the menu or the tour): try again in a moment
      if (moodRef.current !== 'idle' || menuRef.current || tourRef.current || touch.current) {
        sleepTimer.current = setTimeout(doze, 5000)
        return
      }
      // a big yawn and a stretch first, then off to sleep
      setMood('yawn')
      setBubble(null)
      if (!reduce) {
        scaleY.set(1.1)
        scaleX.set(0.95)
        setTimeout(() => {
          scaleX.set(1)
          scaleY.set(1)
        }, 900)
      }
      sleepTimer.current = setTimeout(() => {
        if (moodRef.current === 'yawn') setMood('sleep')
      }, 1900)
    }
    sleepTimer.current = setTimeout(doze, 20000)
  }, [setMood, reduce, scaleX, scaleY])

  const wake = useCallback(
    (line?: string) => {
      if (moodRef.current !== 'sleep') return
      setMood('surprised', 1400)
      fx('jump')
      burst('!', '#FFD27A', 1)
      if (line) say(line, 2800)
    },
    [setMood, fx, burst, say]
  )

  // ---- reacting

  const dizzy = useCallback(() => {
    setMood('dizzy', 2800)
    fx('wobble')
    burst('★', '#FFD27A', 3)
    say('Okay, okay… I’m dizzy! x_x', 2600)
  }, [setMood, fx, burst, say])

  const react = useCallback(() => {
    bump()
    scheduleRoamRef.current(11000)
    const now = Date.now()
    clicks.current = clicks.current.filter((t) => now - t < 1500)
    clicks.current.push(now)
    if (moodRef.current === 'sleep') return wake('Oh! I wasn’t sleeping… much.')
    if (clicks.current.length >= 5) {
      clicks.current = []
      return dizzy()
    }
    const n = reactions.current++
    if (n % 6 === 5) {
      setMood('happy', 1800)
      fx('hop')
      return say(`Need a reminder? ${GUIDE[sectionKey.current]?.line ?? ''}`, 4200)
    }
    switch (REACTIONS[n % REACTIONS.length]) {
      case 'happy':
        setMood('happy', 1800)
        fx('hop')
        burst('✦', '#FFD27A', 2)
        return say('Hehe, that tickles!', 2200)
      case 'surprised':
        setMood('surprised', 1400)
        fx('jump')
        burst('!', '#FFD27A', 1)
        return say('Whoa! Hi there!', 2200)
      case 'wink':
        setMood('wink', 1800)
        fx('tilt')
        burst('✦', '#FFD27A', 2)
        return say('Psst — your money is safe in escrow!', 3000)
      case 'love':
        setMood('love', 2200)
        fx('hop')
        burst('♥', PINK, 3)
        return say('You’re my favorite human!', 2600)
      case 'spin':
        setMood('happy', 1600)
        fx('spin')
        return say('Wheee!', 1800)
    }
  }, [bump, wake, dizzy, setMood, fx, burst, say])

  // ---- the menu (double-click, or Enter)

  const openMenu = useCallback(() => {
    const d = dimRef.current
    const bx = posX.get()
    const by = posY.get()
    const w = 200
    const h = 214
    const fits = (o: { below: boolean; right: boolean }) => {
      const l = o.right ? bx + d.w - w : bx
      const t = o.below ? by + d.h - 4 : by + 6 - h
      // below the navbar (92 px), inside the screen
      return l >= 4 && l + w <= d.vw - 4 && t >= 92 && t + h <= d.vh - 4
    }
    const right = bx + d.w / 2 > d.vw / 2
    const options = [
      { below: false, right },
      { below: true, right },
      { below: false, right: !right },
      { below: true, right: !right },
    ]
    clearTimeout(bubbleTimer.current)
    setBubble(null)
    menuRef.current = true
    setMenu(options.find(fits) ?? options[0])
    setMood('happy', 1200)
    fx('hop')
  }, [posX, posY, setMood, fx])

  const closeMenu = useCallback(() => {
    menuRef.current = false
    setMenu(null)
  }, [])

  // ---- pointer: click, hold, drag, throw

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.currentTarget.setPointerCapture(e.pointerId)
    flyX.current?.stop()
    flyY.current?.stop()
      cancelAnimationFrame(bounceRaf.current)
    clearTimeout(homeTimer.current)
    bump()
    scheduleRoamRef.current(14000)
    const t: Touch = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      bx: posX.get(),
      by: posY.get(),
      moved: false,
      held: false,
      trail: [{ x: e.clientX, y: e.clientY, t: performance.now() }],
      dizz: 0,
      dir: { x: 0, y: 0 },
      lastT: performance.now(),
    }
    t.holdTimer = setTimeout(() => {
      if (touch.current !== t || t.moved) return
      t.held = true
      setMood('lifted')
      scaleX.set(1.06)
      scaleY.set(0.9)
    }, 180)
    touch.current = t
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    const dx = e.clientX - t.sx
    const dy = e.clientY - t.sy
    if (!t.moved && Math.hypot(dx, dy) > 6) {
      t.moved = true
      clearTimeout(t.holdTimer)
      setDragging(true)
      setBubble(null)
      setMood('lifted')
      scaleX.set(1.06)
      scaleY.set(0.9)
    }
    if (!t.moved) return
    const b = bounds()
    posX.set(clamp(t.bx + dx, b.minX - 20, b.maxX + 20))
    posY.set(clamp(t.by + dy, b.minY, b.maxY))
    const now = performance.now()
    const prev = t.trail[t.trail.length - 1]
    t.trail.push({ x: e.clientX, y: e.clientY, t: now })
    while (t.trail.length > 2 && now - t.trail[0].t > 700) t.trail.shift()
    // Shaking makes it dizzy: every sharp change of direction (side to side or up and down) adds up,
    // and the feeling fades while it is held still. Keep shaking and it stays dizzy.
    t.dizz = Math.max(0, t.dizz - (now - t.lastT) / 450)
    t.lastT = now
    for (const axis of ['x', 'y'] as const) {
      const v = axis === 'x' ? e.clientX - prev.x : e.clientY - prev.y
      if (Math.abs(v) > 3) {
        const sign = Math.sign(v)
        if (t.dir[axis] && sign !== t.dir[axis]) t.dizz += 1
        t.dir[axis] = sign
      }
    }
    if (t.dizz >= 3.5) {
      t.dizz = 2.5
      if (moodRef.current !== 'dizzy') dizzy()
      else setMood('dizzy', 2200)
    }
  }

  // A hard throw is a ball: gravity pulls it down, it bounces off the walls, the ceiling and the floor
  // (losing some speed each time, squashing against whatever it hits), and rolls to a stop on the floor.
  // A gentle release keeps the soft glide instead (see onPointerEnd).
  const throwIt = (vx0: number, vy0: number) => {
    const GRAVITY = 1700
    const WALL = 0.8 // speed kept after a wall or the ceiling
    const FLOOR = 0.72 // speed kept after the floor
    const AIR = 0.45 // air drag, per second
    const MAX_SPEED = 4200
    const sp = Math.hypot(vx0, vy0)
    let vx = (vx0 * Math.min(1, MAX_SPEED / sp)) | 0
    let vy = (vy0 * Math.min(1, MAX_SPEED / sp)) | 0
    let x = posX.get()
    let y = posY.get()
    const t0 = performance.now()
    let last = t0
    let loudest = 0
    const squash = (axis: 'x' | 'y', speed: number) => {
      if (speed < 260) return
      const k = clamp(speed / 2400, 0.06, 0.3)
      loudest = Math.max(loudest, speed)
      // flatten against the surface it hit, bulge a little sideways, then spring back
      if (axis === 'x') {
        scaleX.set(1 - k)
        scaleY.set(1 + k * 0.6)
      } else {
        scaleY.set(1 - k)
        scaleX.set(1 + k * 0.6)
      }
      setTimeout(() => {
        scaleX.set(1)
        scaleY.set(1)
      }, 70)
    }
    const done = () => {
      cancelAnimationFrame(bounceRaf.current)
      if (loudest > 1800) fx('wobble')
      scheduleHome(2200)
    }
    const step = (now: number) => {
      const dt = Math.min(0.034, (now - last) / 1000)
      last = now
      vy += GRAVITY * dt
      const drag = Math.exp(-AIR * dt)
      vx *= drag
      vy *= drag
      x += vx * dt
      y += vy * dt
      const b = bounds()
      if (x < b.minX) {
        x = b.minX
        if (vx < 0) {
          squash('x', -vx)
          vx = -vx * WALL
        }
      } else if (x > b.maxX) {
        x = b.maxX
        if (vx > 0) {
          squash('x', vx)
          vx = -vx * WALL
        }
      }
      if (y < b.minY) {
        y = b.minY
        if (vy < 0) {
          squash('y', -vy)
          vy = -vy * WALL
        }
      } else if (y >= b.maxY) {
        y = b.maxY
        if (vy > 0) {
          squash('y', vy)
          vy = vy * FLOOR < 170 ? 0 : -vy * FLOOR
        }
      }
      const onFloor = y >= b.maxY - 0.5 && vy === 0
      if (onFloor) vx *= Math.exp(-5 * dt) // rolling friction
      posX.set(x)
      posY.set(y)
      if ((onFloor && Math.abs(vx) < 30) || now - t0 > 8000) return done()
      bounceRaf.current = requestAnimationFrame(step)
    }
    bounceRaf.current = requestAnimationFrame(step)
  }

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    touch.current = null
    clearTimeout(t.holdTimer)
    scaleX.set(1)
    scaleY.set(1)
    setDragging(false)
    if (!t.moved) {
      if (t.held) {
        setMood('happy', 1500)
        fx('hop')
        say('Phew! Thanks for putting me down gently.', 2800)
      } else tap()
      return
    }
    // Let go: carry on with the speed it was thrown at, bounce off the screen edges, then glide home.
    const last = t.trail[t.trail.length - 1]
    const first = t.trail.find((s) => last.t - s.t < 90) ?? t.trail[0]
    const dt = Math.max(16, last.t - first.t) / 1000
    const vx = (last.x - first.x) / dt
    const vy = (last.y - first.y) / dt
    const b = bounds()
    let bounced = false
    if (moodRef.current === 'dizzy') {
      posX.set(clamp(posX.get(), b.minX, b.maxX))
      posY.set(clamp(posY.get(), b.minY, b.maxY))
    } else {
      const speed = Math.hypot(vx, vy)
      setMood('happy', 2600)
      if (speed > 600) say('Wheee! Again, again!', 2200)
      if (!reduce && speed > BOUNCE_FROM) {
        bounced = true
        throwIt(vx, vy)
      } else {
        const spring = { type: 'inertia' as const, power: 0.6, timeConstant: 320, bounceStiffness: 320, bounceDamping: 18 }
        flyX.current = animate(posX, posX.get(), { ...spring, velocity: vx, min: b.minX, max: b.maxX })
        flyY.current = animate(posY, posY.get(), { ...spring, velocity: vy, min: b.minY, max: b.maxY })
      }
    }
    // a bounce schedules its own trip home once it comes to rest
    if (!bounced) scheduleHome(4200)
    scheduleRoamRef.current(12000)
  }

  // One tap reacts (a beat later, in case a second tap makes it a double-click); a double tap opens the
  // menu; five quick taps make it dizzy; a tap during the tour ends the tour.
  const tap = () => {
    const now = Date.now()
    taps.current = taps.current.filter((x) => now - x < 1600)
    taps.current.push(now)
    if (tourRef.current) return stopTourRef.current(true)
    if (taps.current.length >= 5) {
      taps.current = []
      clearTimeout(tapTimer.current)
      closeMenu()
      return dizzy()
    }
    if (menuRef.current) {
      lastTap.current = 0
      return closeMenu()
    }
    if (now - lastTap.current < 320) {
      clearTimeout(tapTimer.current)
      lastTap.current = 0
      return openMenu()
    }
    lastTap.current = now
    clearTimeout(tapTimer.current)
    tapTimer.current = setTimeout(react, 300)
  }

  const explainEscrow = () => {
    closeMenu()
    setMood('wink', 1800)
    fx('tilt')
    say(ESCROW_LINE, readMs(ESCROW_LINE))
  }

  const tellLive = async () => {
    closeMenu()
    setMood('happy', 1500)
    fx('hop')
    const line = live.current ?? (await liveLine())
    if (line) live.current = line
    say(line ?? 'I can’t reach the network right now — try again in a bit!', line ? readMs(line) : 3200)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      return menuRef.current ? closeMenu() : openMenu()
    }
    if (e.key === ' ') {
      e.preventDefault()
      react()
    }
    if (e.key === 'Escape') {
      closeMenu()
      stopTourRef.current(true)
    }
  }

  const hideGuide = () => {
    stopTourRef.current(false)
    closeMenu()
    setBubble(null)
    setHidden(true)
  }
  const showGuide = () => {
    seen.current.clear()
    setHidden(false)
  }

  // ---- life: arriving, following the page, watching the cursor, blinking, sleeping

  useEffect(() => {
    if (hidden) return
    let arrived = false
    let roamT: ReturnType<typeof setTimeout> | undefined
    // Opening line: by the visitor's local time, and whether they have been here before.
    const opening = greeting(markVisit())
    // The marketplace's live numbers, fetched once in the background (said in the Proof section and from the menu).
    const liveT = setTimeout(() => {
      liveLine().then((l) => {
        if (l) live.current = l
      })
    }, 2500)

    // Exploring: while nobody is playing with it, it drifts to another empty part of the page, now and
    // then stopping beside a button or slider to say what it is.
    const roam = () => {
      if (touch.current || document.hidden || moodRef.current !== 'idle' || menuRef.current || tourRef.current) return scheduleRoam(4000)
      const d = dimRef.current
      const obs = obstacles(d)
      const here = { x: posX.get(), y: posY.get() }
      const stops = Math.random() < 0.6 ? shuffle(pointOuts(d)) : []
      for (const p of stops) {
        const spot = spotBeside(p.rect, d, obs)
        if (!spot) continue
        flyTo(spot.x, spot.y)
        setTimeout(() => {
          if (touch.current || moodRef.current !== 'idle') return
          lookX.set(clamp((p.rect.left + p.rect.width / 2 - (spot.x + d.w / 2)) / 120, -1, 1) * 9)
          lookY.set(clamp((p.rect.top + p.rect.height / 2 - (spot.y + d.h / 2)) / 120, -1, 1) * 6)
          if (!chat(p.line, 4600)) return
          setMood('happy', 1400)
          fx('hop')
        }, 1900)
        return scheduleRoam()
      }
      const spots = sampleSpots(d, obs, 80).filter((s) => Math.hypot(s.x - here.x, s.y - here.y) > 180)
      if (spots.length) {
        const s = pickOne(spots)
        flyTo(s.x, s.y)
        if (Math.random() < 0.35) setTimeout(() => moodRef.current === 'idle' && !touch.current && chat(pickOne(WANDER), 2600), 1700)
      }
      scheduleRoam()
    }
    const scheduleRoam = (ms = 7000 + Math.random() * 5000) => {
      clearTimeout(roamT)
      if (reduce) return
      roamT = setTimeout(roam, ms)
    }
    scheduleRoamRef.current = scheduleRoam

    // After scrolling stops, step aside if the page has moved something under it.
    const relocateIfCovered = () => {
      if (touch.current || moodRef.current === 'lifted') return
      const d = dimRef.current
      const obs = obstacles(d)
      const cx = posX.get()
      const cy = posY.get()
      if (isFree(cx, cy, d, obs)) return scheduleRoam()
      const spots = sampleSpots(d, obs, 90)
      if (!spots.length) return
      spots.sort((p, q) => Math.hypot(p.x - cx, p.y - cy) - Math.hypot(q.x - cx, q.y - cy))
      flyTo(spots[0].x, spots[0].y)
      scheduleRoam()
    }

    // Tag: dash at it with the cursor and it scoots away — twice, then it lets you catch it.
    const tryDodge = (m: { x: number; y: number }) => {
      const now = Date.now()
      const dg = dodge.current
      if (now < dg.until || now - dg.last < 1500) return
      if (now - dg.first > 15000) {
        dg.count = 0
        dg.first = now
      }
      dg.last = now
      if (dg.count >= 2) {
        dg.until = now + 25000
        dg.count = 0
        setMood('happy', 1800)
        fx('hop')
        say('Okay, okay — you got me!', 2600)
        return
      }
      dg.count++
      const d = dimRef.current
      const obs = obstacles(d)
      const spots = sampleSpots(d, obs, 90)
        .filter((s) => Math.hypot(s.x + d.w / 2 - m.x, s.y + d.h / 2 - m.y) > 260)
        .sort((p, q) => Math.hypot(q.x - posX.get(), q.y - posY.get()) - Math.hypot(p.x - posX.get(), p.y - posY.get()))
      if (!spots.length) return
      const s = pickOne(spots.slice(0, 5))
      flyTo(s.x, s.y, true)
      setMood('wink', 1500)
      say(dg.count === 1 ? "Can't catch me!" : 'Hehe, too slow!', 1800)
      scheduleRoam()
    }

    const arrive = (key: string, first = false) => {
      const stop = GUIDE[key]
      if (!stop) return
      sectionKey.current = key
      home.current = stop.at
      arrived = true
      const a = placeNear(stop.at)
      if (first) {
        posX.set(-dimRef.current.w - 60)
        posY.set(a.y)
      }
      clearTimeout(homeTimer.current)
      flyTo(a.x, a.y)
      scheduleRoam(first ? 9000 : undefined)
      bump()
      if (moodRef.current === 'sleep') setMood('idle')
      if (!seen.current.has(key)) {
        seen.current.add(key)
        const line = first ? opening : stop.line
        setTimeout(
          () => {
            if (sectionKey.current !== key || touch.current || tourRef.current) return
            setMood('happy', 1500)
            fx('hop')
            say(line, Math.max(4800, readMs(line)))
            // the end of the page: a little party
            if (key === 'cta') confetti()
            // the on-chain proof: follow up with the live numbers
            if (key === 'proof')
              setTimeout(() => {
                if (live.current && sectionKey.current === 'proof') chat(live.current)
              }, 7600)
          },
          first ? 2200 : 1700
        )
      }
    }

    const keyOf = () => {
      const els = document.querySelectorAll<HTMLElement>('[data-guide]')
      const mid = window.innerHeight * 0.55
      let key = els[0]?.dataset.guide ?? 'hero'
      els.forEach((el) => {
        if (el.getBoundingClientRect().top <= mid) key = el.dataset.guide ?? key
      })
      return key
    }

    let pending = keyOf()
    let settle = setTimeout(() => arrive(pending, true), 1600)
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        pending = keyOf()
        clearTimeout(settle)
        clearTimeout(roamT)
        // the page is moving under it: whatever it was saying no longer fits where it was said
        if (!sticky.current) {
          clearTimeout(bubbleTimer.current)
          setBubble(null)
        }
        settle = setTimeout(() => (!arrived || pending !== sectionKey.current ? arrive(pending, !arrived) : relocateIfCovered()), 1500)
        if (moodRef.current === 'sleep') setMood('idle')
        bump()
      })
    }

    const onResize = () => {
      const d = measure()
      dimRef.current = d
      setDim(d)
      const a = placeNear(home.current)
      posX.set(a.x)
      posY.set(a.y)
    }

    // Petting: the cursor strokes back and forth over it without pressing. It blushes and sends hearts.
    const strokes = { dir: 0, flips: [] as number[], last: -1e9, line: -1e9 }
    const pet = (m: { x: number; y: number }, p: { x: number; y: number }, speed: number, now: number) => {
      const r = botEl.current?.getBoundingClientRect()
      if (!r) return
      const inside = m.x > r.left + r.width * 0.12 && m.x < r.right - r.width * 0.12 && m.y > r.top && m.y < r.bottom - r.height * 0.1
      if (!inside) {
        strokes.flips = []
        strokes.dir = 0
        return
      }
      const dx = m.x - p.x
      if (Math.abs(dx) < 1.5 || speed > 1400) return
      const dir = Math.sign(dx)
      if (strokes.dir && dir !== strokes.dir) strokes.flips.push(now)
      strokes.dir = dir
      strokes.flips = strokes.flips.filter((t) => now - t < 2500)
      if (strokes.flips.length < 4 || now - strokes.last < 3500 || touch.current || menuRef.current || tourRef.current) return
      if (!['idle', 'happy', 'blush', 'sleep', 'yawn'].includes(moodRef.current)) return
      strokes.flips = []
      strokes.last = now
      bump()
      setMood('blush', 2800)
      if (!reduce) animate(bodyRot, [0, -7, 7, -4, 0], { duration: 1.1, ease: 'easeInOut' })
      burst('♥', PINK, 2)
      // a line the first time, then just hearts while the petting goes on
      if (now - strokes.line > 12000) {
        strokes.line = now
        say(pickOne(PET_LINES), 2400)
      }
    }
    // Eyes, lean and drift follow the cursor.
    let mouse: { x: number; y: number } | null = null
    let prev: { x: number; y: number; t: number } | null = null
    let outsideAt = 0
    let mRaf = 0
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      mouse = { x: e.clientX, y: e.clientY }
      const now = performance.now()
      if (prev && now > prev.t) {
        const speed = (Math.hypot(mouse.x - prev.x, mouse.y - prev.y) / (now - prev.t)) * 1000
        const d = dimRef.current
        const dist = Math.hypot(mouse.x - (posX.get() + d.w / 2), mouse.y - (posY.get() + d.h / 2))
        if (dist > 140) outsideAt = now
        // a quick dash in from outside starts a game of tag; moving about on top of it (petting) does not
        if (dist < 85 && now - outsideAt < 250 && speed > 1000 && moodRef.current === 'idle' && !touch.current && !menuRef.current && !tourRef.current) tryDodge(mouse)
        if (e.buttons === 0) pet(mouse, prev, speed, now)
      }
      prev = { x: mouse.x, y: mouse.y, t: now }
      if (mRaf) return
      mRaf = requestAnimationFrame(() => {
        mRaf = 0
        if (!mouse) return
        const d = dimRef.current
        const dx = mouse.x - (posX.get() + d.w / 2)
        const dy = mouse.y - (posY.get() + d.h * 0.52)
        lookX.set(clamp(dx / 260, -1, 1) * 9)
        lookY.set(clamp(dy / 260, -1, 1) * 6)
        lean.set(clamp(dx / 600, -1, 1) * 8)
        pullX.set(clamp(dx * 0.06, -34, 34))
        pullY.set(clamp(dy * 0.04, -20, 20))
      })
    }

    let blinkTimer: ReturnType<typeof setTimeout>
    const scheduleBlink = () => {
      blinkTimer = setTimeout(
        () => {
          setBlink(true)
          setTimeout(() => setBlink(false), 130)
          scheduleBlink()
        },
        2600 + Math.random() * 3200
      )
    }
    scheduleBlink()

    // Gentle float while it hovers.
    const bob = reduce ? undefined : animate(bobY, [0, -8, 0], { duration: 3.4, repeat: Infinity, ease: 'easeInOut' })

    // How fast the page is scrolling decides whether it drops or soars, and how hard the wind blows.
    let lastY = window.scrollY
    let lastT = performance.now()
    let speed = 0
    let calm: ReturnType<typeof setTimeout> | undefined
    let done: ReturnType<typeof setTimeout> | undefined
    let faceT: ReturnType<typeof setTimeout> | undefined
    let active = false
    let slowSince = 0
    // Scrolling stopped (or slowed to a crawl): the wind and the squash fade over ~0.8 s, the expression
    // goes back a moment later, and only then is the effect switched off.
    const startCalm = () => {
      if (!active || done) return
      setCalming(true)
      faceT = setTimeout(() => setFaceDone(true), 380)
      done = setTimeout(() => {
        done = undefined
        active = false
        speed = 0
        setScrollMode(null)
        setCalming(false)
        setFaceDone(false)
      }, 950)
    }
    const onScrollSpeed = () => {
      if (reduce) return
      const now = performance.now()
      const y = window.scrollY
      speed = speed * 0.7 + (((y - lastY) / Math.max(8, now - lastT)) * 1000) * 0.3
      lastY = y
      lastT = now
      if (Math.abs(speed) > 450) {
        // still (or again) at speed: cancel any easing-out in progress
        clearTimeout(done)
        clearTimeout(faceT)
        done = undefined
        active = true
        windFade.current?.stop()
        windPower.set(clamp(Math.abs(speed) / 2000, 0.45, 1))
        setCalming(false)
        setFaceDone(false)
        setScrollMode(speed > 0 ? 'falling' : 'flying')
        slowSince = 0
      } else if (Math.abs(speed) < 250) {
        // a slow crawl only counts as stopped once it has lasted a moment: a change of direction passes through zero
        if (!slowSince) slowSince = now
        else if (now - slowSince > 300) startCalm()
      } else slowSince = 0
      clearTimeout(calm)
      calm = setTimeout(startCalm, 320)
    }

    // ---- reacting to the page

    const look = (r: DOMRect) => {
      const d = dimRef.current
      lookX.set(clamp((r.left + r.width / 2 - (posX.get() + d.w / 2)) / 120, -1, 1) * 9)
      lookY.set(clamp((r.top + r.height / 2 - (posY.get() + d.h / 2)) / 120, -1, 1) * 6)
    }
    const busy = () => touch.current !== null || menuRef.current || tourRef.current

    // The negotiation simulator finished a run: cheer at a deal, sulk at none.
    let simAt = 0
    const onSim = (e: Event) => {
      const r = (e as CustomEvent<NegotiationFinished>).detail
      const line = simLine(r.kind, r.price, r.byUser)
      if (!line || busy() || Date.now() - simAt < 5000) return
      const pane = document.querySelector('#how-it-works [aria-live="polite"]')
      if (pane) look(pane.getBoundingClientRect())
      if (r.byUser) {
        simAt = Date.now()
        bump()
        if (r.kind === 'deal') {
          setMood('happy', 2400)
          fx('hop')
          burst('✦', '#FFD27A', 3)
        } else setMood('sad', 2600)
        say(line, readMs(line))
      } else if (chat(line)) {
        simAt = Date.now()
        setMood('happy', 1500)
        fx('hop')
      }
    }

    // A button into the app: perk up on hover (once in a while), wave when it is pressed.
    const appLink = (t: EventTarget | null) => (t instanceof Element ? t.closest('a[href^="/app"]') : null)
    const hovered = new Map<string, number>()
    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      const a = appLink(e.target)
      if (!a || a.closest('[data-guide-bot]') || moodRef.current !== 'idle') return
      const href = a.getAttribute('href') ?? ''
      if (Date.now() - (hovered.get(href) ?? 0) < 20000) return
      if (!chat(hoverLine(href), 2600)) return
      hovered.set(href, Date.now())
      setMood('happy', 1400)
      fx('hop')
    }
    const onDocDown = (e: PointerEvent) => {
      const inBot = e.target instanceof Element && e.target.closest('[data-guide-bot]') !== null
      if (menuRef.current && !inBot) closeMenu()
      if (inBot || !appLink(e.target)) return
      setMood('happy', 2000)
      burst('👋', '#FFD27A', 1)
      say('See you inside!', 2000, true)
    }

    // FAQ: a nod for every question opened.
    let faqAt = 0
    const onClick = (e: MouseEvent) => {
      const b = e.target instanceof Element ? e.target.closest('#faq button[aria-expanded]') : null
      if (!b) return
      setTimeout(() => {
        if (b.getAttribute('aria-expanded') !== 'true' || busy() || Date.now() - faqAt < 4000) return
        faqAt = Date.now()
        bump()
        setMood('happy', 1500)
        fx('nod')
        say(pickOne(FAQ_LINES), 2200)
      }, 60)
    }

    // Back to the tab after a while: it missed you.
    let awayAt = 0
    const onVisibility = () => {
      if (document.hidden) {
        awayAt = Date.now()
        return
      }
      const away = awayAt ? Date.now() - awayAt : 0
      awayAt = 0
      if (away < 4000 || busy()) return
      bump()
      setMood('happy', 2000)
      fx('jump')
      burst('♥', PINK, 2)
      say(pickOne(BACK_LINES), 2800)
    }

    // Idle: every so often it looks around, hums or stretches.
    let idleT: ReturnType<typeof setTimeout> | undefined
    const idle = () => {
      idleT = setTimeout(idle, 9000 + Math.random() * 7000)
      if (reduce || document.hidden || moodRef.current !== 'idle' || busy() || active || Date.now() - lastSaid.current < 4000) return
      const act = pickOne(['look', 'hum', 'stretch'] as const)
      if (act === 'look') {
        lookX.set(-9)
        setTimeout(() => lookX.set(9), 900)
        setTimeout(() => lookX.set(0), 1900)
      } else if (act === 'hum') {
        fx('sway')
        for (const ms of [0, 700, 1400]) setTimeout(() => burst('♪', '#B9C6FF', 1), ms)
      } else {
        setMood('happy', 900)
        scaleY.set(1.12)
        scaleX.set(0.93)
        setTimeout(() => {
          scaleX.set(1)
          scaleY.set(1)
        }, 520)
      }
    }
    idleT = setTimeout(idle, 12000)

    // ---- the guided tour: it scrolls the page section by section and explains each one

    let tourT: ReturnType<typeof setTimeout> | undefined
    let tourPoll: ReturnType<typeof setInterval> | undefined
    const SCROLL_KEYS = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ']
    const onTourInterrupt = (e: Event) => {
      if (e instanceof KeyboardEvent && !SCROLL_KEYS.includes(e.key)) return
      stopTour(true)
    }
    const endTour = () => {
      tourRef.current = false
      clearTimeout(tourT)
      clearInterval(tourPoll)
      window.removeEventListener('wheel', onTourInterrupt)
      window.removeEventListener('touchmove', onTourInterrupt)
      window.removeEventListener('keydown', onTourInterrupt)
    }
    const stopTour = (interrupted: boolean) => {
      if (!tourRef.current) return
      endTour()
      setTouring(false)
      scheduleRoam()
      if (interrupted) {
        setMood('happy', 1500)
        say('Okay, you drive! Double-click me if you want the tour again.', 3800, true)
      }
    }
    const tourStep = (i: number) => {
      if (!tourRef.current) return
      if (i >= TOUR.length) return stopTour(false)
      const tourStop = TOUR[i]
      const el = document.querySelector(`[data-guide="${tourStop.key}"]`)
      if (!el) return tourStep(i + 1)
      // a step of the pinned product slides: press its tab and the page glides there (no tab on phones: skip)
      const tab = tourStop.step === undefined ? null : document.querySelector<HTMLButtonElement>(`[data-guide-step="${tourStop.step}"]`)
      if (tourStop.step !== undefined && !tab) return tourStep(i + 1)
      // some stops bring a specific part into view (and not just the top of the section): the product's
      // pinned steps, the call-to-action card. Hidden on phones, where it falls back to the section.
      const focusEl = tourStop.focus ? document.querySelector(tourStop.focus) : null
      const useFocus = focusEl !== null && focusEl.getBoundingClientRect().height > 0
      if (tab) tab.click()
      else (useFocus ? focusEl : el).scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: useFocus ? (tourStop.block ?? 'start') : 'start' })
      // wait for the page to stop moving, then for Eco to land (it moves 1.5 s after scrolling stops), then talk
      let prevY = -1
      let still = 0
      clearInterval(tourPoll)
      tourPoll = setInterval(() => {
        const y = window.scrollY
        still = y === prevY ? still + 1 : 0
        prevY = y
        if (still < 3) return
        clearInterval(tourPoll)
        tourT = setTimeout(() => {
          if (!tourRef.current) return
          const text = `(${i + 1}/${TOUR.length}) ${tourStop.line}`
          setMood('happy', 1500)
          fx('hop')
          say(text, tourStop.ms)
          if (tourStop.key === 'cta') confetti()
          tourT = setTimeout(() => tourStep(i + 1), tourStop.ms + 250)
          // a pinned product step only glides a little: Eco is nearly in place, so it waits less than after a long scroll
        }, tourStop.step !== undefined ? 900 : 1550)
      }, 120)
    }
    startTourRef.current = () => {
      if (tourRef.current) return
      tourRef.current = true
      setTouring(true)
      closeMenu()
      clearTimeout(roamT)
      bump()
      window.addEventListener('wheel', onTourInterrupt, { passive: true })
      window.addEventListener('touchmove', onTourInterrupt, { passive: true })
      window.addEventListener('keydown', onTourInterrupt)
      setMood('happy', 1500)
      fx('jump')
      say('Let’s go! I’ll scroll for you.', 1700)
      tourT = setTimeout(() => tourStep(0), 1500)
    }
    stopTourRef.current = stopTour

    window.addEventListener('agenteco:negotiation', onSim)
    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerdown', onDocDown)
    document.addEventListener('click', onClick)
    document.addEventListener('visibilitychange', onVisibility)

    window.addEventListener('scroll', onScrollSpeed, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize)
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      clearTimeout(settle)
      clearTimeout(roamT)
      clearTimeout(blinkTimer)
      clearTimeout(homeTimer.current)
      clearTimeout(sleepTimer.current)
      clearTimeout(bubbleTimer.current)
      clearTimeout(moodTimer.current)
      cancelAnimationFrame(raf)
      cancelAnimationFrame(mRaf)
      bob?.stop()
      flyX.current?.stop()
      flyY.current?.stop()
      cancelAnimationFrame(bounceRaf.current)
      clearTimeout(calm)
      clearTimeout(done)
      clearTimeout(faceT)
      clearTimeout(liveT)
      clearTimeout(idleT)
      clearTimeout(tapTimer.current)
      endTour()
      window.removeEventListener('agenteco:negotiation', onSim)
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerdown', onDocDown)
      document.removeEventListener('click', onClick)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('scroll', onScrollSpeed)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onMove)
    }
  }, [hidden, reduce, placeNear, flyTo, bump, say, chat, fx, burst, confetti, setMood, closeMenu, posX, posY, bobY, bodyRot, scaleX, scaleY, lookX, lookY, lean, pullX, pullY, windPower])

  // The illusion: the bot never leaves its spot. While the page rushes by, the effect's strength rises to full;
  // when it stops, strength, wind and lean all ease back to rest together.
  useEffect(() => {
    if (reduce || !scrollMode) return
    const turn = animate(dirMix, scrollMode === 'falling' ? 1 : 0, { duration: 0.45, ease: [0.4, 0, 0.2, 1] })
    const on = !calming
    const grip = animate(fxPower, on ? 1 : 0, on ? { duration: 0.2, ease: 'easeOut' } : { duration: 0.9, ease: 'easeInOut' })
    const lean = animate(bodyRot, on && scrollMode === 'flying' ? -9 : 0, { type: 'spring', stiffness: on ? 120 : 55, damping: 14 })
    if (!on) windFade.current = animate(windPower, 0, { duration: 0.85, ease: 'easeOut' })
    const rattle = animate(shake, [-1, 1], { duration: 0.05, repeat: Infinity, repeatType: 'mirror' })
    return () => {
      turn.stop()
      grip.stop()
      lean.stop()
      rattle.stop()
    }
  }, [scrollMode, calming, reduce, fxPower, dirMix, bodyRot, shake, windPower])

  // Dreams: a "z" drifts up every so often while it sleeps.
  useEffect(() => {
    if (mood !== 'sleep') return
    const id = setInterval(() => burst('z', '#A9B6F5', 1), 1800)
    return () => clearInterval(id)
  }, [mood, burst])

  if (hidden) {
    return (
      <button
        type="button"
        data-guide-bot
        onClick={showGuide}
        className="fixed bottom-5 left-5 z-40 rounded-full border border-white/10 bg-[#0B0A24]/80 px-3.5 py-2 text-[12px] text-[#A3A5AE] backdrop-blur-md transition hover:border-white/25 hover:text-[#F5F5F7] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5B5FEF]"
      >
        ✦ Show guide
      </button>
    )
  }

  // Scrolling takes over the face (even from a click reaction), except while it is held, dizzy or asleep.
  const shown: Mood = !reduce && scrollMode && !faceDone && mood !== 'lifted' && mood !== 'dizzy' && mood !== 'sleep' ? scrollMode : mood
  const bubbleAlign = bubble?.right ? 'right-0 items-end' : 'left-0 items-start'
  return (
    <motion.div data-guide-bot className={`pointer-events-none fixed left-0 top-0 ${menu ? 'z-[60]' : 'z-40'} select-none`} style={{ x: posX, y: posY, width: dim.w, height: dim.h }}>
      {bubble && (
        <motion.div
          key={bubble.key}
          initial={{ opacity: 0, y: bubble.below ? -6 : 6, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
          className={`absolute flex flex-col ${bubbleAlign} ${bubble.below ? 'top-full -mt-1' : 'bottom-[calc(100%-6px)]'}`}
          style={{ width: 'max-content', maxWidth: bubble.maxW }}
        >
          <div className="relative rounded-2xl border border-[#4F7CFF]/45 bg-[#0B0A24]/85 px-3.5 py-2.5 text-[13px] font-medium leading-snug text-[#F5F5F7] shadow-[0_8px_26px_rgba(0,0,0,.45)] backdrop-blur-md">
            {bubble.text}
            <span
              aria-hidden
              className={`absolute h-[9px] w-[9px] rotate-45 border-[#4F7CFF]/45 bg-[#0B0A24] ${bubble.below ? '-top-[5px] border-l border-t' : '-bottom-[5px] border-b border-r'} ${bubble.right ? 'right-8' : 'left-8'}`}
            />
          </div>
        </motion.div>
      )}

      {menu && (
        <motion.div
          data-guide-menu
          role="menu"
          aria-label="Eco's menu"
          initial={{ opacity: 0, y: menu.below ? -6 : 6, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          onKeyDown={(e) => e.key === 'Escape' && closeMenu()}
          className={`pointer-events-auto absolute flex w-[200px] flex-col gap-0.5 rounded-2xl border border-[#4F7CFF]/45 bg-[#0B0A24]/90 p-1.5 shadow-[0_8px_26px_rgba(0,0,0,.45)] backdrop-blur-md ${menu.below ? 'top-full -mt-1' : 'bottom-[calc(100%-6px)]'} ${menu.right ? 'right-0' : 'left-0'}`}
        >
          <MenuItem label="Take the tour" hint="I’ll scroll you through it" onClick={() => startTourRef.current()} />
          <MenuItem label="What’s escrow?" hint="Explained in one breath" onClick={explainEscrow} />
          <MenuItem label="What’s live now?" hint="Fresh from the marketplace" onClick={() => void tellLive()} />
          <MenuItem label="Hide me" hint="Bring me back any time" onClick={hideGuide} />
        </motion.div>
      )}

      <motion.div className="h-full w-full" style={{ x: pullX, y: pullY }}>
        <motion.div className="h-full w-full" style={{ y: bobY }}>
          <Wind mode={scrollMode} power={windPower} layer="back" />
          <motion.div
            ref={botEl}
            role="button"
            tabIndex={0}
            aria-label="Eco, the AgentEco guide. Click to say hi, double-click or press Enter for the menu, drag to move."
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onPointerEnter={(e) => e.pointerType === 'mouse' && wake('Oh! I was just resting my eyes.')}
            onKeyDown={onKeyDown}
            className={`pointer-events-auto relative h-full w-full touch-none rounded-3xl outline-none focus-visible:ring-2 focus-visible:ring-[#5B5FEF] ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
            style={{
              x: bodyX,
              y: bodyY,
              rotate,
              scaleX: bodyScaleX,
              scaleY: bodyScaleY,
              originX: 0.5,
              originY,
              filter: `drop-shadow(0 10px 18px rgba(8,9,30,.45)) drop-shadow(0 0 22px rgba(79,124,255,${mood === 'sleep' ? 0.12 : 0.4}))`,
            }}
          >
            <GuideBotArt className="block h-full w-full overflow-visible" face={<Face mood={shown} blink={blink} lookX={lookX} lookY={lookY} />} />
            {sparks.map((s) => (
              <SparkView key={s.id} spark={s} onDone={dropSpark} />
            ))}
            <Wind mode={scrollMode} power={windPower} layer="front" />
          </motion.div>
          <button
            type="button"
            onClick={hideGuide}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="Hide the guide"
            title="Hide the guide"
            className="pointer-events-auto absolute right-2 top-3 flex h-5 w-5 items-center justify-center rounded-full border border-white/15 bg-[#0B0A24]/80 text-[11px] leading-none text-[#A3A5AE] opacity-60 transition hover:opacity-100 focus-visible:opacity-100"
          >
            ×
          </button>
          {touring && (
            <button
              type="button"
              onClick={() => stopTourRef.current(true)}
              onPointerDown={(e) => e.stopPropagation()}
              className="pointer-events-auto absolute left-1/2 top-[88%] -translate-x-1/2 whitespace-nowrap rounded-full border border-white/15 bg-[#0B0A24]/85 px-2.5 py-1 text-[11px] text-[#A3A5AE] backdrop-blur-md transition hover:text-[#F5F5F7]"
            >
              Stop tour
            </button>
          )}
        </motion.div>
      </motion.div>
    </motion.div>
  )
}
