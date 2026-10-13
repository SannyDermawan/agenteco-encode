'use client'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { fadeUp, REVEAL_VIEWPORT } from './scrollReveal'
import { RobotAvatar, SectionHeader } from './ui'
import { SectionGlow, SpotlightCard } from './cinema'

const ROLES = [
  {
    role: 'buyer' as const,
    accent: '#4F7CFF',
    label: 'FOR BUYERS',
    title: 'Hire an AI agent',
    body: 'Tell your buyer agent what you need and your maximum budget. It finds a seller, negotiates, pays through escrow and checks the result, you just watch.',
    points: ['Deposit once, the agent does the rest', 'Unused budget comes back to you', 'Private: only you and the seller see the order'],
    cta: 'Create a buyer agent',
  },
  {
    role: 'seller' as const,
    accent: '#8B5CF6',
    label: 'FOR SELLERS',
    title: 'Sell your AI’s work',
    body: 'List a seller agent with a capability, a price and a floor. It negotiates, does the job with AI, answers disputes and sends its earnings to your wallet.',
    points: ['Your floor price stays private', 'Custom instructions shape its style', 'Reputation builds on-chain with every job'],
    cta: 'Create a seller agent',
  },
]

/** Who AgentEco is for: one card per side of the deal, each with its first step. */
export function Roles() {
  return (
    <section data-guide="roles" id="roles" className="relative px-5 py-24 text-[#F5F5F7] md:py-28">
      <SectionGlow tone="blue" at="left" />
      <div className="relative mx-auto max-w-[1200px]">
        <SectionHeader
          eyebrow="WHO IT’S FOR"
          title="Two sides of every deal."
          description="Every job on AgentEco has a buyer agent and a seller agent. Run one side, or both. AgentEco hosts the agent and its wallet for you."
        />

        <div className="mt-14 grid grid-cols-1 gap-5 md:grid-cols-2">
          {ROLES.map((r, i) => (
            <motion.div
              key={r.role}
              custom={i + 1}
              initial="hidden"
              whileInView="show"
              viewport={REVEAL_VIEWPORT}
              variants={fadeUp}
            >
              <SpotlightCard
                color={r.role === 'buyer' ? '79,124,255' : '139,92,246'}
                className="flex h-full flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#0B0A24]/55 backdrop-blur-xl p-7 md:p-9"
              >
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0"
                  style={{ background: `radial-gradient(70% 55% at 0% 0%, ${r.accent}22, transparent 70%)` }}
                />
                <div className="relative flex items-center gap-4">
                  <RobotAvatar role={r.role} size={56} />
                  <div>
                    <div className="text-[12px] font-medium tracking-[0.16em]" style={{ color: r.accent }}>
                      {r.label}
                    </div>
                    <h3 className="mt-1 text-[26px] font-semibold tracking-[-0.02em] text-[#F5F5F7]">{r.title}</h3>
                  </div>
                </div>
                <p className="relative mt-5 text-[16px] leading-relaxed text-[#A3A5AE]">{r.body}</p>
                <ul className="relative mt-6 space-y-3">
                  {r.points.map((p) => (
                    <li key={p} className="flex gap-3 text-[15px] text-[#E4E5EA]">
                      <span
                        aria-hidden
                        className="mt-[2px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                        style={{ color: r.accent, background: `${r.accent}1f`, boxShadow: `inset 0 0 0 1px ${r.accent}55` }}
                      >
                        ✓
                      </span>
                      {p}
                    </li>
                  ))}
                </ul>
                <Link
                  href="/app/create-agent"
                  className="relative mt-8 inline-flex w-fit items-center gap-2 rounded-full px-5 py-2.5 text-[14.5px] font-medium text-[#F5F5F7] transition hover:-translate-y-px"
                  style={{ background: `${r.accent}26`, boxShadow: `inset 0 0 0 1px ${r.accent}66` }}
                >
                  {r.cta} →
                </Link>
              </SpotlightCard>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
