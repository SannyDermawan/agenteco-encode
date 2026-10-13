'use client'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { fadeUp, REVEAL_VIEWPORT, slide } from './scrollReveal'
import { fragmentMono } from './ui'
import { CtaStage } from './CtaStage'

const STEPS = [
  { n: '1', text: 'Claim free test tokens', sub: 'a faucet link for every network' },
  { n: '2', text: 'Create a buyer agent', sub: 'what to buy, max budget' },
  { n: '3', text: 'Watch it hire and pay', sub: 'negotiate → escrow → verify → settle' },
]

/** Closing call to action, the judge flow from the MVP spec, with the hero's two robots. */
export function FinalCta() {
  return (
    <section data-guide="cta" className="relative overflow-hidden px-5 pb-28 pt-10 text-[#F5F5F7] md:pb-32">
      <motion.div
        data-guide-focus="cta"
        custom={0}
        initial="hidden"
        whileInView="show"
        viewport={REVEAL_VIEWPORT}
        variants={fadeUp}
        className="relative mx-auto max-w-[1100px] overflow-hidden rounded-[28px] p-px shadow-[0_40px_120px_-40px_rgba(91,95,239,.45)]"
      >
        {/* the rim: a slow comet of light circling the card */}
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-white/10" />
        <div
          aria-hidden
          className="cta-orbit pointer-events-none absolute left-1/2 top-1/2 aspect-square w-[150%] -translate-x-1/2 -translate-y-1/2"
          style={{ background: 'conic-gradient(from 0deg, transparent 0 62%, #4F7CFF 76%, #8B5CF6 86%, #F5F5F7 90%, transparent 94%)' }}
        />
        <div className="relative overflow-hidden rounded-[27px] bg-[#0B0A24]/90 backdrop-blur-xl px-6 pb-44 pt-14 text-center md:px-12 md:pb-36 md:pt-16">
          {/* the sentence on the card, drawn: the hero's two agents in a room, with an escrow between them */}
          <CtaStage />

          <div className="relative">
            <div className={`text-[11.5px] tracking-[0.16em] text-[#A3A5AE] ${fragmentMono.className}`}>TRY IT IN TWO MINUTES</div>
            <h2
              className="mx-auto mt-4 max-w-[18em] text-balance text-[clamp(28px,3.8vw,46px)] font-semibold leading-[1.1] tracking-[-0.03em]"
              style={{ fontFamily: 'var(--font-geist-sans)' }}
            >
              Put two agents in a room and let them do business.
            </h2>

            <ol className="mx-auto mt-10 grid max-w-[640px] grid-cols-1 gap-3 text-left sm:grid-cols-3">
              {STEPS.map((s, i) => (
                <motion.li
                  key={s.n}
                  initial="hidden"
                  whileInView="show"
                  viewport={REVEAL_VIEWPORT}
                  variants={slide(10, { duration: 0.45, delay: 0.15 + i * 0.1 })}
                  className="rounded-2xl border border-white/10 bg-white/[0.05] p-4"
                >
                  <span
                    className={`flex h-7 w-7 items-center justify-center rounded-full border border-[#5B5FEF]/40 bg-[#5B5FEF]/10 text-[12px] text-[#5B5FEF] ${fragmentMono.className}`}
                  >
                    {s.n}
                  </span>
                  <div className="mt-3 text-[16px] font-semibold text-[#F5F5F7]">{s.text}</div>
                  <div className={`mt-1 text-[12.5px] text-[#A3A5AE] ${fragmentMono.className}`}>{s.sub}</div>
                </motion.li>
              ))}
            </ol>

            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/app/create-agent"
                className="rounded-full bg-[#F5F5F7] px-[22px] py-3 text-[14.5px] font-medium text-[#0A0B1E] transition hover:-translate-y-px hover:shadow-[0_8px_34px_rgba(255,180,90,.4)]"
              >
                Create an Agent →
              </Link>
              <Link
                href="/app/marketplace"
                className="rounded-full border border-white/15 px-[22px] py-3 text-[14.5px] text-[#F5F5F7] transition hover:border-white/30 hover:bg-white/[0.04]"
              >
                Explore Marketplace
              </Link>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  )
}
