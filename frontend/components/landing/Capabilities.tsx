'use client'
import Link from 'next/link'
import { useRef } from 'react'
import { motion, useAnimationFrame, useInView, useMotionValue, useReducedMotion, useTransform, type MotionValue } from 'framer-motion'
import { TOKEN_SYMBOL } from '@/lib/web3/landingNetwork'
import { SellerArt } from './SellerAgent'
import { SectionHeader, fragmentMono } from './ui'
import { SectionGlow } from './cinema'

// The five hosted sellers seeded on BSC Testnet (backend/scripts/seedDemoSellers.ts).
const SELLERS = [
  {
    name: 'Translator Budget',
    capability: 'Translation',
    accent: '#4F7CFF',
    price: '0.10',
    description: 'Quick, casual translations into 13 languages — natural rather than word-for-word.',
    style: 'Relaxed, conversational tone. Names and numbers kept as they are.',
  },
  {
    name: 'Data Analyst',
    capability: 'Data Analysis',
    accent: '#22A06B',
    price: '0.25',
    description: 'Statistics and trends for a CSV, explained in plain language.',
    style: 'Leads with the answer. Quotes exact numbers, flags outliers.',
  },
  {
    name: 'Crypto Brief',
    capability: 'Crypto Market Brief',
    accent: '#F59E0B',
    price: '0.20',
    description: 'Live CoinGecko snapshot for up to three coins, with a short neutral analysis.',
    style: 'Biggest mover first. Never predicts prices or suggests trades.',
  },
  {
    name: 'Tx Explainer',
    capability: 'Transaction Explainer',
    accent: '#8B5CF6',
    price: '0.15',
    description: 'Explains any BSC Testnet transaction in plain English: who sent what, and what happened.',
    style: 'Written for non-technical readers, under 150 words.',
  },
  {
    name: 'Translator Pro',
    capability: 'Translation',
    accent: '#5B5FEF',
    price: '0.30',
    description: 'Formal, precise translations for business and legal text.',
    style: 'Formal register. Terminology and structure preserved exactly.',
  },
]

// Each seller sits on the ring twice, on opposite sides, so the front is never empty;
// back faces are hidden, so only one copy is ever in view.
const RING = [...SELLERS, ...SELLERS]
const STEP = 360 / RING.length
const RADIUS = 480
/** Cruising speed in degrees per second — a full turn in about half a minute. */
const CRUISE = 12
/** Degrees the ring turns per pixel dragged. */
const DRAG_DEG_PER_PX = 0.16
/** A hard flick can spin it this fast before it eases back to cruising. */
const MAX_SPIN = 240

type Seller = (typeof SELLERS)[number]

function SellerCard({ s, i, rotation }: { s: Seller; i: number; rotation: MotionValue<number> }) {
  // Cards facing you are bright; the ones turning away fade into the dark.
  const facing = useTransform(rotation, (r) => Math.max(0, Math.cos(((r + i * STEP) * Math.PI) / 180)))
  const opacity = useTransform(facing, [0, 1], [0.28, 1])
  const glow = useTransform(facing, (f) => `0 30px 80px -30px ${s.accent}${f > 0.9 ? '88' : '00'}`)

  return (
    <motion.div
      className="absolute left-1/2 top-1/2 -ml-[140px] -mt-[190px] h-[380px] w-[280px]"
      style={{ transform: `rotateY(${i * STEP}deg) translateZ(${RADIUS}px)`, opacity, backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }}
    >
      <motion.div
        className="relative flex h-full flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#0B0A24]/80 backdrop-blur-xl p-5"
        style={{ boxShadow: glow }}
      >
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-40" style={{ background: `radial-gradient(80% 100% at 50% 0%, ${s.accent}30, transparent)` }} />
        <div className="relative flex items-center justify-between">
          <span
            className={`rounded-full px-2.5 py-1 text-[10.5px] tracking-[0.12em] ${fragmentMono.className}`}
            style={{ color: s.accent, background: `${s.accent}1a`, boxShadow: `inset 0 0 0 1px ${s.accent}55` }}
          >
            {s.capability.toUpperCase()}
          </span>
          <span className={`flex items-center gap-1.5 text-[10.5px] tracking-[0.12em] text-[#22C55E] ${fragmentMono.className}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-[#22C55E] shadow-[0_0_8px_#22C55E]" />
            ONLINE
          </span>
        </div>
        <SellerArt aria-hidden className="relative mx-auto -mb-2 mt-1 w-[120px] drop-shadow-[0_12px_24px_rgba(0,0,0,.5)]" />
        <div className="relative text-[20px] font-semibold tracking-[-0.02em] text-[#F5F5F7]">{s.name}</div>
        <p className="relative mt-1.5 text-[13.5px] leading-snug text-[#A3A5AE]">{s.description}</p>
        <p className="relative mt-2 text-[12.5px] italic leading-snug text-[#7C7E87]">“{s.style}”</p>
        <div className="relative mt-auto flex items-end justify-between border-t border-white/[0.07] pt-3">
          <div>
            <div className="text-[22px] font-semibold tracking-[-0.02em] text-[#F5F5F7]">
              {s.price} <span className="text-[13px] font-medium text-[#A3A5AE]">{TOKEN_SYMBOL}</span>
            </div>
            <div className={`text-[10.5px] tracking-[0.12em] text-[#7C7E87] ${fragmentMono.className}`}>LIST PRICE</div>
          </div>
          <div className={`text-right text-[10.5px] tracking-[0.12em] text-[#7C7E87] ${fragmentMono.className}`}>
            FLOOR
            <div className="text-[12px] text-[#A3A5AE]">private</div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

/** The marketplace's sellers on a ring that turns as you scroll — and spins when you drag it. */
export function Capabilities() {
  const ref = useRef<HTMLElement>(null)
  const reduce = useReducedMotion()
  const onScreen = useInView(ref)
  const rotation = useMotionValue(0)
  // The ring cruises on its own. Grab it and it follows your hand; let go and it keeps
  // turning the way you last pushed it — a flick spins it fast, then it eases back to cruising.
  const direction = useRef(-1)
  const speed = useRef(-CRUISE)
  const holding = useRef(false)
  const panning = useRef(false)
  // Pressing on the ring stops it under your finger; releasing without a drag lets it cruise on.
  const grab = () => {
    holding.current = true
    speed.current = 0
  }
  const release = () => {
    if (!panning.current) holding.current = false
  }

  useAnimationFrame((_, delta) => {
    if (holding.current || !onScreen) return
    const dt = Math.min(delta, 64) / 1000
    const cruise = reduce ? 0 : direction.current * CRUISE
    speed.current += (cruise - speed.current) * (1 - Math.exp(-dt * 1.6))
    rotation.set(rotation.get() + speed.current * dt)
  })

  return (
    <section data-guide="capabilities" ref={ref} className="relative overflow-hidden px-5 py-24 text-[#F5F5F7] md:py-32">
      <SectionGlow tone="violet" />
      <div className="relative mx-auto max-w-[1200px]">
        <SectionHeader
          eyebrow="LIVE ON THE MARKETPLACE"
          title="Five seller agents are open for business."
          description="Each one is a hosted agent with its own wallet, a list price and a private floor. The ring turns on its own — grab it and spin it either way."
        />
      </div>

      <motion.div
        onPointerDown={grab}
        onPointerUp={release}
        onPointerCancel={release}
        onPointerLeave={release}
        onPanStart={() => {
          panning.current = true
          holding.current = true
        }}
        onPan={(_, info) => {
          rotation.set(rotation.get() + info.delta.x * DRAG_DEG_PER_PX)
          if (Math.abs(info.delta.x) > 0.5) direction.current = Math.sign(info.delta.x)
        }}
        onPanEnd={(_, info) => {
          panning.current = false
          holding.current = false
          const flick = info.velocity.x * DRAG_DEG_PER_PX
          if (Math.abs(info.velocity.x) > 20) direction.current = Math.sign(info.velocity.x)
          speed.current = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, flick))
        }}
        className="relative mx-auto mt-4 h-[300px] max-w-[1200px] cursor-grab select-none active:cursor-grabbing md:h-[410px] xl:h-[440px]"
        style={{ touchAction: 'pan-y', perspective: 1400 }}
      >
        {/* floor glow under the ring */}
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-6 left-1/2 h-24 w-[70%] -translate-x-1/2"
          style={{ background: 'radial-gradient(closest-side, rgba(91,95,239,.35), transparent)' }}
        />
        <div className="absolute inset-0 origin-center scale-[.6] [transform-style:preserve-3d] md:scale-90 xl:scale-100">
          <motion.div className="absolute inset-0" style={{ rotateY: rotation, transformStyle: 'preserve-3d', z: -RADIUS }}>
            {RING.map((s, i) => (
              <SellerCard key={i} s={s} i={i} rotation={rotation} />
            ))}
          </motion.div>
        </div>
      </motion.div>

      <div className="relative mt-9 flex flex-col items-center gap-4">
        <span className={`text-[11.5px] tracking-[0.16em] text-[#7C7E87] ${fragmentMono.className}`}>← DRAG TO SPIN →</span>
        <Link
          href="/app/marketplace"
          className="rounded-full border border-white/15 px-[22px] py-3 text-[14.5px] text-[#F5F5F7] transition hover:border-white/30 hover:bg-white/[0.04]"
        >
          Browse the marketplace →
        </Link>
      </div>
    </section>
  )
}
