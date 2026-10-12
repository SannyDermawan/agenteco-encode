'use client'
import { useRef, useState } from 'react'
import { motion, useMotionValueEvent, useReducedMotion, useSpring, useTransform } from 'framer-motion'
import { useElementProgress } from './scrollProgress'
import { NegotiationSimulator } from './NegotiationSimulator'
import { fadeUp, REVEAL_VIEWPORT } from './scrollReveal'
import { SectionHeader, fragmentMono } from './ui'
import { SectionGlow } from './cinema'

const BLUE = '#5B5FEF'
const VIOLET = '#B45AE1'
const GREEN = '#22A06B'

type Stage = { number: string; title: string; description: string; where: 'OFF-CHAIN' | 'ON-CHAIN'; accent: string }

const STAGES: Stage[] = [
  {
    number: '01',
    title: 'Discover',
    description: 'Your buyer agent finds online sellers for the job, within your budget.',
    where: 'OFF-CHAIN',
    accent: BLUE,
  },
  {
    number: '02',
    title: 'Negotiate',
    description: 'The two agents trade offers — neither ever sees the other’s limit.',
    where: 'OFF-CHAIN',
    accent: BLUE,
  },
  {
    number: '03',
    title: 'Escrow',
    description: 'The agreed price is locked in AgentEco.sol before any work starts.',
    where: 'ON-CHAIN',
    accent: BLUE,
  },
  {
    number: '04',
    title: 'Deliver & verify',
    description: 'The seller’s AI does the job; the buyer’s AI scores the result.',
    where: 'ON-CHAIN',
    accent: VIOLET,
  },
  {
    number: '05',
    title: 'Settle',
    description: 'A good score pays and rates the seller. Too low, and a dispute opens.',
    where: 'ON-CHAIN',
    accent: GREEN,
  },
]

function NumberBadge({ stage, active }: { stage: Stage; active: boolean }) {
  return (
    <div
      className="relative z-10 flex h-12 w-12 shrink-0 items-center justify-center rounded-full border bg-[#0A0B1E] text-[14px] font-semibold tracking-[-0.01em] transition-colors duration-300"
      style={{
        borderColor: active ? `${stage.accent}80` : 'rgba(255,255,255,0.14)',
        color: active ? stage.accent : '#A3A5AE',
        boxShadow: active ? `0 0 18px ${stage.accent}33` : 'none',
      }}
    >
      {stage.number}
    </div>
  )
}

function StageText({ stage, centered }: { stage: Stage; centered: boolean }) {
  return (
    <div className={centered ? 'text-center' : ''}>
      <div
        className={`text-[11.5px] tracking-[0.14em] ${fragmentMono.className}`}
        style={{ color: stage.where === 'ON-CHAIN' ? GREEN : '#7C7E87' }}
      >
        {stage.where}
      </div>
      <h3 className="mt-2 text-[19px] font-semibold tracking-[-0.015em] text-[#F5F5F7]">{stage.title}</h3>
      <p className={`mt-2 text-[15px] leading-relaxed text-[#A3A5AE] ${centered ? 'mx-auto max-w-[22ch]' : ''}`}>
        {stage.description}
      </p>
    </div>
  )
}

function DesktopPipeline() {
  const reduceMotion = useReducedMotion()
  const pipelineRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState(-1)

  // The line fills as the pipeline scrolls up the screen, so the money moves at your pace.
  const scrollYProgress = useElementProgress(pipelineRef, ['start 85%', 'start 30%'])
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 24 })
  const dotLeft = useTransform(progress, [0, 1], ['10%', '90%'])
  const dotColor = useTransform(progress, [0, 0.5, 1], [BLUE, VIOLET, GREEN])

  useMotionValueEvent(progress, 'change', (v) => {
    const lastIndex = STAGES.length - 1
    // Each badge lights once the dot reaches it; the last one with a little tolerance.
    setActiveIndex(v < 0.01 ? -1 : v >= 0.98 ? lastIndex : Math.floor(v * lastIndex))
  })

  return (
    <div ref={pipelineRef} className="relative mt-16 hidden md:block">
      <div aria-hidden className="pointer-events-none absolute left-[10%] right-[10%] top-[24px] h-px bg-white/10" />
      {!reduceMotion ? (
        <motion.div aria-hidden className="pointer-events-none absolute inset-0">
          <motion.div
            className="absolute left-[10%] right-[10%] top-[24px] h-px origin-left"
            style={{ scaleX: progress, background: `linear-gradient(90deg, ${BLUE}, ${VIOLET} 60%, ${GREEN})` }}
          />
          <motion.div
            className="absolute top-[24px] h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left: dotLeft, backgroundColor: dotColor, boxShadow: '0 0 10px currentColor' }}
          />
        </motion.div>
      ) : (
        <div
          aria-hidden
          className="pointer-events-none absolute left-[10%] right-[10%] top-[24px] h-px"
          style={{ background: `linear-gradient(90deg, ${BLUE}, ${VIOLET} 60%, ${GREEN})` }}
        />
      )}

      <div className="grid grid-cols-5 gap-4">
        {STAGES.map((stage, i) => (
          <motion.div
            key={stage.number}
            custom={i}
            initial="hidden"
            whileInView="show"
            viewport={REVEAL_VIEWPORT}
            variants={fadeUp}
            className="flex flex-col items-center"
          >
            <NumberBadge stage={stage} active={activeIndex >= i} />
            <div className="mt-5 w-full">
              <StageText stage={stage} centered />
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  )
}

function MobileTimeline() {
  return (
    <div className="mt-12 flex flex-col md:hidden">
      {STAGES.map((stage, i) => (
        <motion.div
          key={stage.number}
          custom={i}
          initial="hidden"
          whileInView="show"
          viewport={REVEAL_VIEWPORT}
          variants={fadeUp}
          className="relative flex gap-4"
        >
          <div className="flex flex-col items-center">
            <NumberBadge stage={stage} active />
            {i < STAGES.length - 1 && <span aria-hidden className="mt-1 w-px flex-1 bg-white/10" style={{ minHeight: 24 }} />}
          </div>
          <div className="flex-1 pb-8 pt-1.5">
            <StageText stage={stage} centered={false} />
          </div>
        </motion.div>
      ))}
    </div>
  )
}

export function HowItWorks() {
  return (
    <section data-guide="how-it-works" id="how-it-works" className="relative px-5 py-24 text-[#F5F5F7] md:py-32">
      <SectionGlow tone="amber" at="right" />

      <div className="relative mx-auto max-w-[1200px]">
        <SectionHeader
          eyebrow="HOW IT WORKS"
          title="From request to payment, automatically."
          description="Finding a seller and agreeing on a price happen off-chain. The escrow, the result's hash and the payment are enforced by a smart contract on the network you pick."
        />

        <DesktopPipeline />
        <MobileTimeline />

        <div className="mt-20">
          <NegotiationSimulator />
        </div>
      </div>
    </section>
  )
}
