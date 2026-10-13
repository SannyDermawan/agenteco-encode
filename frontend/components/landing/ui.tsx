'use client'
import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Fragment_Mono } from 'next/font/google'
import { BuyerArt } from './BuyerAgent'
import { SellerArt } from './SellerAgent'
import { fadeUp, REVEAL_VIEWPORT } from './scrollReveal'
import { WordReveal } from './cinema'

export const fragmentMono = Fragment_Mono({ subsets: ['latin'], weight: '400' })

/** Landing palette, body copy is a notch brighter than the app's #8B8D96 so it survives a projector. */
export const C = {
  bg: '#0A0B1E',
  panel: '#0D0F16',
  primary: '#F5F5F7',
  body: '#A3A5AE',
  muted: '#7C7E87',
  blue: '#5B5FEF',
  buyer: '#4F7CFF',
  seller: '#8B5CF6',
  green: '#22A06B',
} as const

export function SectionHeader({
  eyebrow,
  title,
  description,
  align = 'center',
  children,
}: {
  eyebrow: string
  title: string
  description: string
  align?: 'center' | 'left'
  children?: ReactNode
}) {
  const centered = align === 'center'
  return (
    <div className={centered ? 'mx-auto max-w-[46em] text-center' : 'max-w-[40em]'}>
      <motion.div
        custom={0}
        initial="hidden"
        whileInView="show"
        viewport={REVEAL_VIEWPORT}
        variants={fadeUp}
        className="inline-flex items-center gap-2 text-xs font-medium tracking-[0.18em] text-[#A3A5AE]"
      >
        <i className="h-1.5 w-1.5 rounded-full bg-[#FFB45A] shadow-[0_0_10px_#FFB45A]" />
        {eyebrow}
      </motion.div>
      <WordReveal
        text={title}
        className="mt-4 text-balance text-[clamp(30px,4.2vw,54px)] font-semibold leading-[1.08] tracking-[-0.035em] text-[#F5F5F7]"
        style={{ fontFamily: 'var(--font-geist-sans)' }}
      />
      <motion.p
        custom={2}
        initial="hidden"
        whileInView="show"
        viewport={REVEAL_VIEWPORT}
        variants={fadeUp}
        className={`mt-4 text-[17px] leading-relaxed text-[#A3A5AE] ${centered ? 'mx-auto max-w-[40em]' : ''}`}
      >
        {description}
      </motion.p>
      {children}
    </div>
  )
}

/** The hero's buyer/seller robots as small circular avatars, so the characters carry through the page. */
export function RobotAvatar({ role, size = 36 }: { role: 'buyer' | 'seller'; size?: number }) {
  const Art = role === 'buyer' ? BuyerArt : SellerArt
  const ring = role === 'buyer' ? 'rgba(79,124,255,.45)' : 'rgba(139,92,246,.45)'
  return (
    <span
      aria-hidden
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#141722]"
      style={{ width: size, height: size, boxShadow: `inset 0 0 0 1px ${ring}, 0 0 14px ${ring.replace('.45', '.18')}` }}
    >
      <Art style={{ width: size * 1.25, height: size * 1.25, marginTop: size * 0.12 }} />
    </span>
  )
}

export function formatUsdt(value: number): string {
  return value.toFixed(2)
}
