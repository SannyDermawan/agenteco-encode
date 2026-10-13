'use client'
import { useEffect, type ReactNode } from 'react'
import {
  animate, motion, useMotionTemplate, useMotionValue, useReducedMotion, useTransform,
  type MotionValue,
} from 'framer-motion'

export type Lit = 'idle' | 'active' | 'dim' | 'bright'
export type AgentShellProps = {
  role: 'buyer' | 'seller'
  /** 0 = far apart, 1 = facing each other (shared by both agents) */
  progress: MotionValue<number>
  lit: Lit
  children: ReactNode
}

const RGB = { buyer: '79,124,255', seller: '139,92,246' } as const
// [brightness, rim-glow alpha]
const LIGHT: Record<Lit, [number, number]> = {
  idle: [0.88, 0.28], active: [1, 0.55], dim: [0.7, 0.14], bright: [1.06, 0.7],
}
const SHADOW_GAIN: Record<Lit, number> = { idle: 0.85, active: 1, dim: 0.55, bright: 1 }
const LIFT = 14 // px of idle float
const HOP = 9 // px of extra lift while approaching

export function AgentShell({ role, progress, lit, children }: AgentShellProps) {
  const reduce = useReducedMotion()
  const dir = role === 'buyer' ? -1 : 1
  const rgb = RGB[role]

  // vertical float, the neon shadow is derived from this same value
  const float = useMotionValue(0)
  useEffect(() => {
    if (reduce) return
    const c = animate(float, [0, -LIFT, 0], {
      duration: 3.4, repeat: Infinity, ease: ['easeOut', 'easeIn'],
      delay: role === 'seller' ? 1.2 : 0,
    })
    return () => c.stop()
  }, [float, reduce, role])

  const hop = useTransform(progress, (v) => -HOP * Math.sin(Math.PI * v))
  const y = useTransform([float, hop], ([a, b]) => (a as number) + (b as number))
  const gap = useTransform(progress, (v) => 10.5 * v) // cqw closed so far
  const nudge = dir * 0.055 // robot body sits slightly off the svg centre

  const agentT = useMotionTemplate`translate3d(calc(${dir} * (31cqw - ${gap} * 1cqw)), ${y}px, 0)`

  const range = [-(LIFT + HOP), 0]
  const sx = useTransform(y, range, [0.72, 1.16])
  const sy = useTransform(y, range, [0.6, 1])
  const so = useTransform(y, range, [0.5, 0.95])
  const sb = useTransform(y, range, ['blur(5px)', 'blur(10px)'])
  const shadowT = useMotionTemplate`translate3d(calc(${dir} * (31cqw - ${gap} * 1cqw) + ${nudge} * var(--aw)), 0, 0) scale(${sx}, ${sy})`

  const [br, gl] = LIGHT[lit]
  return (
    <>
      <motion.div
        aria-hidden
        className="pointer-events-none absolute left-1/2"
        style={{ bottom: 'calc(var(--g) - 14px)', height: 28, width: 'calc(var(--aw) * .8)', marginLeft: 'calc(var(--aw) * -.4)' }}
        animate={{ opacity: SHADOW_GAIN[lit] }}
        transition={{ duration: 0.5 }}
      >
        <motion.div
          className="h-full w-full rounded-[50%]"
          style={{
            transform: shadowT, opacity: so, filter: sb,
            background: `radial-gradient(closest-side, rgba(${rgb},.9), rgba(${rgb},.3) 55%, transparent)`,
          }}
        />
      </motion.div>

      <motion.div
        role="img"
        aria-label={`${role} agent`}
        className="absolute left-1/2 will-change-transform"
        style={{
          width: 'var(--aw)', marginLeft: 'calc(var(--aw) / -2)',
          bottom: 'calc(var(--g) + 20px - var(--aw) * .147)', transform: agentT,
        }}
      >
        <motion.div
          initial={false}
          animate={{ filter: `brightness(${br}) drop-shadow(0 0 22px rgba(${rgb},${gl}))` }}
          transition={{ duration: 0.5 }}
        >
          {children}
        </motion.div>
      </motion.div>
    </>
  )
}
