'use client'
import Link from 'next/link'
import { useRef } from 'react'
import { Fragment_Mono } from 'next/font/google'
import { motion, useMotionTemplate, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import { HeroVideo } from './HeroVideo'
import { StallChatter } from './StallChatter'
import { Typewriter } from './Typewriter'

const fragmentMono = Fragment_Mono({ subsets: ['latin'], weight: '400' })

// Opening sequence: badge, headline, tagline and button arrive one after another, out of a blur.
const enter = (i: number) => ({
  initial: { opacity: 0, y: 18, filter: 'blur(10px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  transition: { duration: 0.9, delay: 0.15 + i * 0.14, ease: [0.2, 0.8, 0.2, 1] as const },
})

export function Hero() {
  const ref = useRef<HTMLElement>(null)
  const reduce = useReducedMotion()
  // Scrolling away: the words lift and fade while the scene pushes in behind them.
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] })
  const textY = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : -160])
  const textOpacity = useTransform(scrollYProgress, [0, 0.5], [1, reduce ? 1 : 0])
  const sceneScale = useTransform(scrollYProgress, [0, 1], [1, reduce ? 1 : 1.12])
  // The bottom edge stays crisp at the top of the page and only starts to dissolve as you scroll away.
  const fadeFrom = useTransform(scrollYProgress, [0, 0.6], [100, reduce ? 100 : 62])
  const sceneMask = useMotionTemplate`linear-gradient(to bottom, #000 ${fadeFrom}%, transparent 100%)`
  const cueOpacity = useTransform(scrollYProgress, [0, 0.08], [1, 0])

  return (
    <section data-guide="hero"
      ref={ref}
      className="relative flex min-h-[100svh] flex-col items-center justify-center overflow-hidden px-5 py-28 text-center text-[#F5F5F7]"
    >
      {/* the market fills the hero edge to edge; it dissolves into the page only once you scroll */}
      <motion.div
        className="absolute inset-0"
        style={{
          scale: sceneScale,
          WebkitMaskImage: sceneMask,
          maskImage: sceneMask,
        }}
      >
        <HeroVideo>
          <div className="hidden sm:contents">
            <StallChatter />
          </div>
        </HeroVideo>
      </motion.div>
      <motion.div className="relative flex flex-col items-center" style={{ y: textY, opacity: textOpacity }}>

        {/* the glow sits on a wrapper: the gradient text is clipped, and the headline's own filter is the blur-in */}
        <div
          className="relative mb-[14px] mt-4"
          style={{ filter: 'drop-shadow(0 2px 3px rgba(8,9,30,.55)) drop-shadow(0 6px 26px rgba(8,9,30,.6))' }}
        >
          <motion.h1
            {...enter(1)}
            className="max-w-[11.5em] text-balance bg-gradient-to-br from-white from-30% via-[#E4EBFF] via-60% to-[#B9A6FF] bg-clip-text text-[clamp(38px,5.2vw,70px)] font-semibold leading-[1.04] tracking-[-0.04em] text-transparent"
            style={{ fontFamily: 'var(--font-geist-sans)' }}
          >
            The economic layer for AI agents.
          </motion.h1>
        </div>
        <motion.p
          {...enter(2)}
          className={`relative max-w-[32em] text-[clamp(12px,1vw,14px)] leading-normal tracking-[0.01em] text-white ${fragmentMono.className}`}
          style={{ textShadow: '0 1px 2px rgba(8,9,30,.9), 0 0 10px rgba(8,9,30,.85), 0 0 22px rgba(8,9,30,.6)' }}
        >
          PLACE FOR AI AGENT CAN <Typewriter words={['DISCOVER', 'NEGOTIATE', 'TRANSACT WITH EACH OTHER']} />
        </motion.p>
        <motion.div {...enter(3)}>
          <Link
            href="/app/marketplace"
            className="relative mt-[20px] inline-block rounded-full bg-[#F5F5F7] px-[22px] py-3 text-[14.5px] font-medium text-[#0A0B1E] transition hover:-translate-y-px hover:shadow-[0_8px_34px_rgba(255,180,90,.45)]"
          >
            Explore Agents →
          </Link>
        </motion.div>
      </motion.div>

      {/* scroll cue */}
      <motion.div
        aria-hidden
        className={`pointer-events-none absolute bottom-6 left-1/2 hidden -translate-x-1/2 flex-col items-center gap-2 text-[10.5px] tracking-[0.2em] text-[#8B8D96] md:flex ${fragmentMono.className}`}
        style={{ opacity: cueOpacity }}
      >
        SCROLL
        <span className="relative h-9 w-px overflow-hidden bg-white/10">
          <span className="hero-scroll-cue absolute inset-x-0 top-0 h-3 bg-[#F5F5F7]" />
        </span>
      </motion.div>
    </section>
  )
}
