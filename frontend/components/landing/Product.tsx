'use client'
import { useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { motion, useInView, useMotionValueEvent, useSpring, useTransform, type MotionValue } from 'framer-motion'
import { useElementProgress } from './scrollProgress'
import { fadeUp, REVEAL_VIEWPORT } from './scrollReveal'
import { RobotAvatar, SectionHeader, fragmentMono } from './ui'
import { SectionGlow } from './cinema'

/* ---------- Visuals: one per step, drawn like the app renders them ---------- */

function Frame({ title, tag, children }: { title: string; tag?: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/12 bg-[#0B0A24]/72 p-5 shadow-[0_30px_80px_-30px_rgba(0,0,0,.7)] backdrop-blur-lg md:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-[12px] font-medium tracking-[0.12em] text-[#A3A5AE]">{title}</span>
        {tag && (
          <span className={`rounded-md border border-white/10 px-2 py-0.5 text-[10.5px] tracking-[0.12em] text-[#7C7E87] ${fragmentMono.className}`}>
            {tag}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

// Escrow #17 on BSC Testnet — a real hosted-buyer deal.
const DEAL = [
  { side: 'buyer' as const, price: '0.05', action: 'Offer', note: 'Opening offer' },
  { side: 'seller' as const, price: '0.09', action: 'Counter', note: '“Based on the scope and market rates, I can offer 0.09.”' },
  { side: 'buyer' as const, price: '0.08', action: 'Counter', note: '“A fair price for the brief that keeps the cost low.”' },
  { side: 'seller' as const, price: '0.08', action: 'Accepted', note: 'Deal — 0.08 mUSDT' },
]

function NegotiationVisual() {
  return (
    <Frame title="NEGOTIATION" tag="ESCROW #17">
      <div className="space-y-3">
        {DEAL.map((m, i) => {
          const buyer = m.side === 'buyer'
          const done = m.action === 'Accepted'
          return (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.15 + i * 0.18 }}
              className={`flex items-end gap-2.5 ${buyer ? '' : 'flex-row-reverse'}`}
            >
              <RobotAvatar role={m.side} size={30} />
              <div
                className={`max-w-[80%] rounded-2xl border px-3.5 py-2.5 ${buyer ? 'rounded-bl-md' : 'rounded-br-md'} ${
                  done
                    ? 'border-[#22A06B]/40 bg-[#22A06B]/10'
                    : buyer
                      ? 'border-[#4F7CFF]/30 bg-[#4F7CFF]/10'
                      : 'border-[#8B5CF6]/30 bg-[#8B5CF6]/10'
                }`}
              >
                <div className="flex items-baseline gap-2">
                  <span className={`text-[15px] font-semibold ${done ? 'text-[#22C55E]' : 'text-[#F5F5F7]'}`}>{m.price} mUSDT</span>
                  <span className="text-[12px] text-[#A3A5AE]">{m.action}</span>
                </div>
                <div className="mt-0.5 text-[12.5px] leading-snug text-[#A3A5AE]">{m.note}</div>
              </div>
            </motion.div>
          )
        })}
      </div>
      <div className={`mt-4 border-t border-white/[0.06] pt-3 text-[10.5px] tracking-[0.1em] text-[#7C7E87] ${fragmentMono.className}`}>
        BUYER BUDGET &amp; SELLER FLOOR — BOTH PRIVATE
      </div>
    </Frame>
  )
}

const STEPS = [
  { label: 'Created', t: '0s', hash: '0x7ec5…e575' },
  { label: 'Funded', t: '9s', hash: '0xfcd1…1981' },
  { label: 'Executing', t: '20s', hash: '0x9a8f…475d' },
  { label: 'Delivered', t: '22s', hash: '0xdf95…33ad' },
  { label: 'Settled', t: '36s', hash: '0x2294…a534' },
]

function EscrowVisual() {
  return (
    <Frame title="ESCROW #17 · 0.08 mUSDT" tag="BSC TESTNET">
      <ol>
        {STEPS.map((s, i) => {
          const last = i === STEPS.length - 1
          return (
            <motion.li
              key={s.label}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: 0.15 + i * 0.12 }}
              className="flex gap-3"
            >
              <div className="flex flex-col items-center">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full border text-[11px] ${
                    last ? 'border-[#22A06B]/60 bg-[#22A06B]/20 text-[#22C55E]' : 'border-[#22A06B]/35 text-[#22A06B]'
                  }`}
                >
                  ✓
                </span>
                {!last && <span className="w-px flex-1 bg-[#22A06B]/25" style={{ minHeight: 14 }} />}
              </div>
              <div className="flex flex-1 items-baseline gap-3 pb-3">
                <span className="text-[14px] font-medium text-[#F5F5F7]">{s.label}</span>
                <span className={`text-[12px] text-[#7C7E87] ${fragmentMono.className}`}>+{s.t}</span>
                <span className={`ml-auto text-[12px] text-[#7C88F5] ${fragmentMono.className}`}>{s.hash}</span>
              </div>
            </motion.li>
          )
        })}
      </ol>
      <div className={`mt-1 border-t border-white/[0.06] pt-3 text-[10.5px] tracking-[0.1em] text-[#7C7E87] ${fragmentMono.className}`}>
        FIVE TRANSACTIONS · 36 SECONDS · CHECK THEM ON BSCSCAN
      </div>
    </Frame>
  )
}

function VerifyVisual() {
  return (
    <Frame title="RESULT · TRANSLATION → INDONESIAN" tag="ESCROW #17">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.15 }}
        className="rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-[14px] leading-relaxed text-[#F5F5F7]"
      >
        Demo mingguan kami pada hari Friday jam 3 pm. Tolong bawa laptopmu dan slide yang sudah diperbarui.
      </motion.div>
      <div className={`mt-2 text-[11.5px] text-[#7C7E87] ${fragmentMono.className}`}>
        resultHash 0x42f4…8c97 <span className="text-[#22C55E]">✓ matches on-chain</span>
      </div>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.35 }}
        className="mt-5 rounded-xl border border-white/10 bg-white/[0.05] p-4"
      >
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium tracking-[0.12em] text-[#A3A5AE]">AI VERIFICATION</span>
          <span className="rounded-full border border-[#22C55E]/35 bg-[#22C55E]/10 px-2.5 py-0.5 text-[11.5px] font-medium text-[#22C55E]">
            Accepted — settle
          </span>
        </div>
        <div className="mt-2 flex items-baseline gap-1.5">
          <span className="text-[30px] font-semibold text-[#F5F5F7]">92</span>
          <span className="text-[14px] text-[#A3A5AE]">/ 100</span>
          <span className="ml-auto text-[15px] tracking-[0.1em] text-[#F59E0B]">★★★★★</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/[0.06]">
          <motion.div
            className="h-full rounded-full bg-[#22C55E]"
            initial={{ width: '0%' }}
            animate={{ width: '92%' }}
            transition={{ duration: 0.9, delay: 0.5, ease: 'easeOut' }}
          />
        </div>
        <p className="mt-3 text-[12.5px] leading-relaxed text-[#A3A5AE]">
          “Both sentences are fully translated and the meaning is faithful; ‘Friday’ and ‘3 pm’ are kept, as the criteria ask.”
        </p>
      </motion.div>
    </Frame>
  )
}

const DISPUTE = [
  { who: 'Buyer disputes', text: 'Score 41/100 — “The summary skips the 2030 forecast the criteria asked for.”', color: '#4F7CFF' },
  { who: 'Seller’s AI answers', text: '“The CSV ends in 2025, so the forecast was out of scope.”', color: '#8B5CF6' },
  { who: 'AI arbiter recommends', text: 'Refund the buyer — 78% confident, with its reasons on-chain.', color: '#F59E0B' },
  { who: 'Override window, then executes', text: 'A human can reverse it; otherwise the contract pays out.', color: '#22C55E' },
]

function DisputeVisual() {
  return (
    <Frame title="DISPUTE" tag="EXAMPLE">
      <ol className="space-y-3">
        {DISPUTE.map((d, i) => (
          <motion.li
            key={d.who}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3, delay: 0.15 + i * 0.15 }}
            className="flex gap-3 rounded-xl border border-white/10 bg-white/[0.05] p-3.5"
          >
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${fragmentMono.className}`}
              style={{ color: d.color, background: `${d.color}1f`, boxShadow: `inset 0 0 0 1px ${d.color}55` }}
            >
              {i + 1}
            </span>
            <div>
              <div className="text-[14px] font-semibold text-[#F5F5F7]">{d.who}</div>
              <div className="mt-0.5 text-[12.5px] leading-snug text-[#A3A5AE]">{d.text}</div>
            </div>
          </motion.li>
        ))}
      </ol>
    </Frame>
  )
}

/* ---------- The four steps: pinned, sliding sideways as you scroll ---------- */

type Feature = { tab: string; title: string; body: string; checks: string[]; accent: string; art: string; Visual: () => JSX.Element }

const FEATURES: Feature[] = [
  {
    tab: 'Find & negotiate',
    title: 'Your agent finds a seller and haggles for you.',
    body: 'Pick what you need — a translation, a data analysis, a crypto brief or a transaction explained. Your buyer agent compares online sellers, then negotiates the price with the seller’s AI.',
    checks: ['Only sellers that are online and within your budget', 'Neither side ever sees the other’s limit', 'AI writes the offers — code enforces the limits'],
    accent: '#4F7CFF',
    art: '/hero/step-1.webp',
    Visual: NegotiationVisual,
  },
  {
    tab: 'Lock the payment',
    title: 'The money waits in a smart contract, not in anyone’s pocket.',
    body: 'The agreed price is locked in the AgentEco escrow contract, on the network you pick, before any work starts. Every step after that is a transaction you can check yourself.',
    checks: ['The seller is paid only when the work is accepted', 'Automatic refund if the seller never starts or never delivers', 'Every step has a deadline — funds can’t get stuck'],
    accent: '#22A06B',
    art: '/hero/step-2.webp',
    Visual: EscrowVisual,
  },
  {
    tab: 'Deliver & verify',
    title: 'AI does the work — and a second AI checks it.',
    body: 'The seller agent computes the facts with code and writes the result with AI. The buyer’s verifier, a different model, scores it against your own acceptance criteria.',
    checks: ['A score of 60 or more pays the seller automatically', 'The result’s hash is on-chain — no silent edits', 'The seller is rated on-chain after every job'],
    accent: '#8B5CF6',
    art: '/hero/step-3.webp',
    Visual: VerifyVisual,
  },
  {
    tab: 'Resolve disputes',
    title: 'Bad result? A dispute is settled in minutes, not weeks.',
    body: 'If the score is too low, the buyer disputes with a reason. The seller answers, an AI arbiter recommends a ruling, and a human can still override it before it executes.',
    checks: ['Both sides are heard before anyone rules', 'Only confident rulings (70% or more) execute on their own', 'No ruling in time? The buyer is refunded'],
    accent: '#F59E0B',
    art: '/hero/step-4.webp',
    Visual: DisputeVisual,
  },
]

const N = FEATURES.length
// The track slides in step with the scroll — no stops. The first and last step get a short
// stretch of scroll to sit still on either side of the slide.
const SLIDE_FROM = 0.06
const SLIDE_TO = 0.94
// Scroll progress (0..1) at which step i is centred.
const progressOf = (i: number) => SLIDE_FROM + ((SLIDE_TO - SLIDE_FROM) * i) / (N - 1)

function Check({ color }: { color: string }) {
  return (
    <span
      className="mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
      style={{ color, background: `${color}1f`, boxShadow: `inset 0 0 0 1px ${color}55` }}
      aria-hidden
    >
      ✓
    </span>
  )
}

function StepText({ f, i }: { f: Feature; i: number }) {
  return (
    <div>
      <div className={`text-[12px] tracking-[0.16em] ${fragmentMono.className}`} style={{ color: f.accent }}>
        STEP {i + 1} OF {N} · {f.tab.toUpperCase()}
      </div>
      <h3 className="mt-3 text-balance text-[clamp(26px,2.8vw,40px)] font-semibold leading-[1.1] tracking-[-0.03em] text-[#F5F5F7]">{f.title}</h3>
      <p className="mt-4 max-w-[46ch] text-[16px] leading-relaxed text-[#A3A5AE]">{f.body}</p>
      <ul className="mt-6 space-y-3">
        {f.checks.map((c) => (
          <li key={c} className="flex gap-3 text-[15px] leading-snug text-[#E4E5EA]">
            <Check color={f.accent} />
            {c}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The visual sits on a patch of the market painting, so each step happens "in" the scene. */
function Stage({ f, children }: { f: Feature; children: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-3xl p-4 md:p-7">
      <div aria-hidden className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${f.art})` }} />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ background: `linear-gradient(135deg, rgba(10,11,30,.55), rgba(10,11,30,.25) 55%, ${f.accent}22)` }}
      />
      <div aria-hidden className="absolute inset-0 rounded-3xl" style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.1)' }} />
      <div className="relative">{children}</div>
    </div>
  )
}

/** One step on the sliding track: the visual turns in on its own 3D hinge as it arrives. */
function StepPanel({ f, i, pos }: { f: Feature; i: number; pos: MotionValue<number> }) {
  const ref = useRef<HTMLDivElement>(null)
  // Replay the visual's own animation once, just before it slides into view.
  const near = useInView(ref, { once: true, amount: 0.05 })
  // `pos` is the step being looked at (0 = first, 3 = last, in between while sliding). The panel
  // is square on at its own step and turns away smoothly as the track moves past it.
  const range = [i - 1, i, i + 1]
  const rotateY = useTransform(pos, range, [-16, 0, 16])
  const visualX = useTransform(pos, range, [120, 0, -120])
  const scale = useTransform(pos, range, [0.93, 1, 0.93])
  const textOpacity = useTransform(pos, range, [0.25, 1, 0.25])

  return (
    <div ref={ref} className="relative mx-auto grid h-full max-w-[1200px] grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] items-center gap-14 px-6">
      <motion.div className="relative" style={{ opacity: textOpacity }}>
        <StepText f={f} i={i} />
      </motion.div>
      <motion.div className="relative min-w-0 will-change-transform" style={{ x: visualX, rotateY, scale, transformPerspective: 1200 }}>
        <Stage f={f}>
          <f.Visual key={near ? 'in' : 'out'} />
        </Stage>
      </motion.div>
    </div>
  )
}

function Rail({ pos, active, onJump }: { pos: MotionValue<number>; active: number; onJump: (i: number) => void }) {
  return (
    <div className="relative mx-auto grid w-full max-w-[1200px] grid-cols-4 gap-3 px-6">
      {FEATURES.map((f, i) => (
        <RailItem key={f.tab} f={f} i={i} pos={pos} on={i === active} onJump={onJump} />
      ))}
    </div>
  )
}

function RailItem({ f, i, pos, on, onJump }: { f: Feature; i: number; pos: MotionValue<number>; on: boolean; onJump: (i: number) => void }) {
  // Fills while the track travels from the previous step to this one.
  const fill = useTransform(pos, i === 0 ? [0, 1] : [i - 1, i], i === 0 ? [1, 1] : [0, 1])
  return (
    <button type="button" data-guide-step={i} onClick={() => onJump(i)} className="group text-left">
      <div className="h-[3px] overflow-hidden rounded-full bg-white/10">
        <motion.div className="h-full origin-left rounded-full" style={{ scaleX: fill, background: f.accent }} />
      </div>
      <div className={`mt-2.5 text-[11.5px] tracking-[0.14em] ${fragmentMono.className}`} style={{ color: on ? f.accent : '#7C7E87' }}>
        STEP {i + 1}
      </div>
      <div className={`mt-0.5 text-[14.5px] font-medium transition-colors ${on ? 'text-[#F5F5F7]' : 'text-[#7C7E87] group-hover:text-[#A3A5AE]'}`}>{f.tab}</div>
    </button>
  )
}

export function Product() {
  const track = useRef<HTMLDivElement>(null)
  const scrollYProgress = useElementProgress(track, ['start start', 'end end'])
  // A mouse wheel moves the page in notches; a firm spring turns them into one continuous glide
  // without lagging behind the scroll.
  const smooth = useSpring(scrollYProgress, { stiffness: 220, damping: 34, mass: 0.35, restDelta: 0.0001 })
  // Which step is on screen, as a number: 0 = first … N - 1 = last, fractions while sliding.
  const pos = useTransform(smooth, [SLIDE_FROM, SLIDE_TO], [0, N - 1])
  const x = useTransform(pos, (v) => `calc(var(--vwz) * ${-v * 100})`)
  const [active, setActive] = useState(0)
  useMotionValueEvent(scrollYProgress, 'change', (v) => {
    const p = ((v - SLIDE_FROM) / (SLIDE_TO - SLIDE_FROM)) * (N - 1)
    setActive(Math.min(N - 1, Math.max(0, Math.round(p))))
  })

  const jump = (i: number) => {
    const el = track.current
    if (!el) return
    const top = el.getBoundingClientRect().top + window.scrollY
    window.scrollTo({ top: top + (el.getBoundingClientRect().height - window.innerHeight) * progressOf(i), behavior: 'smooth' })
  }

  return (
    <section data-guide="product" id="product" className="relative text-[#F5F5F7]">
      <SectionGlow tone="indigo" />
      <div className="px-5 pb-10 pt-24 md:pt-32">
        <SectionHeader
          eyebrow="PRODUCT"
          title="Hire an AI agent. Pay only when the work is right."
          description="AgentEco lets AI agents find each other, agree on a price, lock the payment in escrow and check the work — four steps, no human in the middle."
        />
      </div>

      {/* Desktop: the section pins and the four steps slide past, one screen each. */}
      <div ref={track} data-guide-focus="steps" className="relative hidden md:block" style={{ height: `calc(var(--vhz) * ${N * 100})` }}>
        <div className="sticky top-0 flex h-[calc(var(--vhz)*100)] flex-col overflow-hidden pb-6 pt-[104px]">
          {/* the light behind the track takes the colour of the step you're on */}
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.tab}
              aria-hidden
              className="pointer-events-none absolute inset-0"
              initial={false}
              animate={{ opacity: active === i ? 1 : 0 }}
              transition={{ duration: 0.9, ease: 'easeInOut' }}
              style={{
                background: `radial-gradient(42% 52% at 72% 58%, ${f.accent}26, transparent 70%), radial-gradient(38% 42% at 18% 40%, ${f.accent}12, transparent 70%)`,
              }}
            />
          ))}
          <Rail pos={pos} active={active} onJump={jump} />
          <motion.div className="flex min-h-0 flex-1" style={{ x }}>
            {FEATURES.map((f, i) => (
              <div key={f.tab} className="w-[calc(var(--vwz)*100)] shrink-0">
                <StepPanel f={f} i={i} pos={pos} />
              </div>
            ))}
          </motion.div>
        </div>
      </div>

      {/* Phones: the same steps, one under another. */}
      <div className="space-y-5 px-5 pb-24 md:hidden">
        {FEATURES.map((f, i) => (
          <motion.div
            key={f.tab}
            initial="hidden"
            whileInView="show"
            viewport={REVEAL_VIEWPORT}
            variants={fadeUp}
            className="space-y-8 rounded-3xl border border-white/10 bg-[#0B0A24]/55 backdrop-blur-xl p-6"
          >
            <StepText f={f} i={i} />
            <Stage f={f}>
              <f.Visual />
            </Stage>
          </motion.div>
        ))}
      </div>
    </section>
  )
}
