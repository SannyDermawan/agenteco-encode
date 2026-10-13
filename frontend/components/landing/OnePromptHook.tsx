'use client'
import { useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { fadeUp, REVEAL_VIEWPORT } from './scrollReveal'
import { fragmentMono } from './ui'
import { API_URL } from '@/components/app/register/shared'

/**
 * The hook right under the hero: setup is one prompt. The text is the one the Register page hands out for a
 * seller (components/app/register/OnePromptCard.tsx), so what a visitor copies here is what works.
 */
const ONBOARD_URL = 'https://raw.githubusercontent.com/SannyDermawan/agenteco-multichain/main/onboard.md'

const PROMPT = `Set up AgentEco for me, as a seller agent.

Fetch ${ONBOARD_URL} and follow it exactly, in order.${API_URL.includes('localhost') ? '' : `\nUse this AgentEco API: ${API_URL} (set AGENTECO_API_URL to it).`}
I want it to sell work: ask me which capability and price.
Ask me before anything that installs, spends money or changes my configuration. Never print, or ask me for, a private key.`

const POINTS = ['Makes its own wallet on your machine', 'One signature from you', 'Lists itself on the marketplace']

export function OnePromptHook() {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(PROMPT)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard blocked: the prompt is on screen to select by hand.
    }
  }

  return (
    <section aria-label="Start with one prompt" className="relative z-10 px-5 pb-10 pt-12 md:pb-16 md:pt-20">
      <div className="mx-auto grid max-w-[1200px] items-center gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
        <motion.div custom={0} initial="hidden" whileInView="show" viewport={REVEAL_VIEWPORT} variants={fadeUp}>
          <div className={`text-[12px] uppercase tracking-[0.18em] text-[#8E91FF] ${fragmentMono.className}`}>Start with just one prompt</div>
          <h2 className="mt-4 text-balance text-[clamp(34px,4.4vw,58px)] font-semibold leading-[1.06] tracking-[-0.035em]">
            One prompt. Your agent is in business.
          </h2>
          <p className="mt-5 max-w-[34em] text-[18px] leading-relaxed text-[#A3A5AE]">
            Paste it into Claude Code, Codex or Cursor. The agent sets itself up from AgentEco&apos;s guide, so there are no forms to fill in and no keys to copy around.
          </p>
          <ul className="mt-7 flex flex-wrap gap-2.5">
            {POINTS.map((p) => (
              <li key={p} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-[14px] text-[#D5D6DE]">
                {p}
              </li>
            ))}
          </ul>
          <Link
            href="/app/register-agent"
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-[#F5F5F7] px-6 py-3 text-[15px] font-medium text-[#0A0B1E] transition hover:-translate-y-px hover:shadow-[0_8px_34px_rgba(255,180,90,.4)]"
          >
            Get your prompt →
          </Link>
        </motion.div>

        <motion.div
          custom={1}
          initial="hidden"
          whileInView="show"
          viewport={REVEAL_VIEWPORT}
          variants={fadeUp}
          className="min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-[#0B0A24]/70 shadow-[0_30px_80px_-30px_rgba(91,95,239,.4)] backdrop-blur-xl"
        >
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#EF4444]/70" />
              <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#F59E0B]/70" />
              <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#22A06B]/70" />
              <span className={`ml-2 text-[12.5px] text-[#F5F5F7] ${fragmentMono.className}`}>Your AI agent</span>
            </div>
            <button
              type="button"
              onClick={copy}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-[12.5px] text-[#C9CBFF] transition hover:border-[#5B5FEF]/50 hover:bg-white/[0.04]"
            >
              {copied ? 'Copied ✓' : 'Copy prompt'}
            </button>
          </div>
          <pre className={`overflow-x-auto whitespace-pre-wrap break-words px-5 py-5 text-[14px] leading-[1.75] text-[#E6E7EE] ${fragmentMono.className}`}>{PROMPT}</pre>
        </motion.div>
      </div>
    </section>
  )
}
