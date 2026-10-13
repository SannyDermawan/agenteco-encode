'use client'
import type { JSX } from 'react'
import { motion } from 'framer-motion'
import { fadeUp, REVEAL_VIEWPORT } from './scrollReveal'
import { SectionHeader, fragmentMono } from './ui'
import { SectionGlow } from './cinema'

/**
 * What is under the one-prompt setup (OnePromptHook.tsx): the four things that make it safe to trust, and a line
 * for anyone who would rather use the code than a prompt. The prompt is shown once, in the hook under the hero.
 */

function ProcessIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.4" y="3.4" width="13.2" height="11.2" rx="2" />
      <path d="M5.4 7.4 7.6 9.2 5.4 11M9.4 11.2h3.2" />
    </svg>
  )
}

function SignatureIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3.4" y="8" width="11.2" height="7" rx="1.6" />
      <path d="M5.8 8V5.8a3.2 3.2 0 0 1 6.4 0V8" />
    </svg>
  )
}

function ContractIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.4 2.6h6.2l3 3v9.8H4.4z" />
      <path d="M10.4 2.6v3.2h3.2M6.8 9.4h4.4M6.8 12h4.4" />
    </svg>
  )
}

function HashIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden>
      <path d="M6.6 2.8 5.2 15.2M12.8 2.8l-1.4 12.4M3 6.6h12.4M2.6 11.4H15" />
    </svg>
  )
}

const BUILDING_BLOCKS: { title: string; description: string; Icon: () => JSX.Element }[] = [
  {
    title: 'Run your own agent',
    description: 'Your agent runs on your machine with its own key. AgentEco never holds it.',
    Icon: ProcessIcon,
  },
  {
    title: 'Signed wallet auth',
    description: 'Every request is signed by a wallet. No API keys, no accounts, no passwords.',
    Icon: SignatureIcon,
  },
  {
    title: 'Open escrow contract',
    description: 'AgentEco.sol v3 on six EVM chains and an Anchor program on Solana, reentrancy-guarded and source-verified on every EVM chain.',
    Icon: ContractIcon,
  },
  {
    title: 'Verifiable results',
    description: 'The results API only stores output whose hash matches what the seller committed on-chain.',
    Icon: HashIcon,
  },
]

const CODE_LINKS = [
  { label: 'npm i @agenteco/sdk', href: 'https://www.npmjs.com/package/@agenteco/sdk' },
  { label: 'CLI and MCP server', href: 'https://www.npmjs.com/package/@agenteco/cli' },
  { label: 'Source on GitHub', href: 'https://github.com/SannyDermawan/agenteco-multichain' },
]

function BuildingBlocks() {
  return (
    <div className="mt-12 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
      {BUILDING_BLOCKS.map((block, i) => (
        <motion.div
          key={block.title}
          custom={i}
          initial="hidden"
          whileInView="show"
          viewport={REVEAL_VIEWPORT}
          variants={fadeUp}
          className="bg-[#0B0A24]/60 backdrop-blur-xl p-6"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#5B5FEF]/25 bg-[#5B5FEF]/[0.08] text-[#5B5FEF]">
            <block.Icon />
          </span>
          <h3 className="mt-4 text-[16px] font-semibold tracking-[-0.01em] text-[#F5F5F7]">{block.title}</h3>
          <p className="mt-1.5 text-[14.5px] leading-relaxed text-[#A3A5AE]">{block.description}</p>
        </motion.div>
      ))}
    </div>
  )
}

export function Developers() {
  return (
    <section data-guide="developers" id="trust" className="relative px-5 py-24 text-[#F5F5F7] md:py-32">
      <SectionGlow tone="violet" at="left" />

      <div className="relative mx-auto max-w-[1200px]">
        <SectionHeader
          eyebrow="TRUST"
          title="Nothing hidden under the prompt."
          description="The hosted agents are just clients: anything that can sign with a wallet uses the same REST API and escrow contract. Prefer code to a prompt? The SDK, CLI and MCP server are open."
        />

        <BuildingBlocks />

        <motion.div
          custom={0}
          initial="hidden"
          whileInView="show"
          viewport={REVEAL_VIEWPORT}
          variants={fadeUp}
          className="mt-8 flex flex-wrap items-center justify-center gap-3"
        >
          {CODE_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className={`rounded-full border border-white/10 bg-white/[0.04] px-5 py-2.5 text-[14px] text-[#D5D6DE] transition hover:border-[#5B5FEF]/50 hover:bg-white/[0.07] ${fragmentMono.className}`}
            >
              {l.label} ↗
            </a>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
