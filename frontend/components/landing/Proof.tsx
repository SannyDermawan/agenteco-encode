'use client'
import { useEffect, useRef } from 'react'
import { animate, motion, useInView, useReducedMotion } from 'framer-motion'
import { TOKEN_SYMBOL } from '@/lib/web3/landingNetwork'
import { SectionGlow, SpotlightCard } from './cinema'
import { fadeUp, REVEAL_VIEWPORT } from './scrollReveal'
import { SectionHeader } from './ui'

// Every number here is measured on the live build (see the README's load test).
const STATS = [
  { to: 85, prefix: '~', suffix: ' s', label: 'from a funded buyer agent to a settled escrow on BSC Testnet', accent: '#FFB45A', rgb: '255,180,90' },
  { to: 5, label: 'AI roles: negotiate, execute, verify, defend and arbitrate', accent: '#8B5CF6', rgb: '139,92,246' },
  { to: 67, label: 'Foundry tests on the escrow contract, fuzz and invariants included', accent: '#22A06B', rgb: '34,160,107' },
  { to: 4, label: 'real capabilities: translation, data analysis, crypto briefs, tx explainer', accent: '#7C9BFF', rgb: '124,155,255' },
]

function CountUp({ to, prefix = '', suffix = '' }: { to: number; prefix?: string; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.8 })
  const reduce = useReducedMotion()
  useEffect(() => {
    if (!inView || reduce) return
    const controls = animate(0, to, {
      duration: 1.6,
      ease: [0.2, 0.8, 0.2, 1],
      onUpdate: (v) => {
        if (ref.current) ref.current.textContent = `${prefix}${Math.round(v)}${suffix}`
      },
    })
    return () => controls.stop()
  }, [inView, reduce, to, prefix, suffix])
  return <span ref={ref}>{`${prefix}${to}${suffix}`}</span>
}

/* ---------- The network: buyer and seller agents, with payments flowing between them ---------- */

type AgentNode = { x: number; y: number; vx: number; vy: number; seller: boolean; pulse: number }
type Packet = { from: AgentNode; to: AgentNode; t: number }
type Tag = { x: number; y: number; age: number; text: string }

const LINK = 150
const PRICES = ['0.08', '0.10', '0.12', '0.15', '0.20', '0.25']

function AgentNetwork() {
  const ref = useRef<HTMLCanvasElement>(null)
  const reduce = useReducedMotion()

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let w = 0
    let h = 0
    let nodes: AgentNode[] = []
    const packets: Packet[] = []
    const tags: Tag[] = []
    const mouse = { x: -9999, y: -9999 }
    let frame = 0
    let last = performance.now()
    let spawnIn = 0.4
    let visible = false

    const seed = () => {
      const count = Math.max(26, Math.min(72, Math.round((w * h) / 20000)))
      nodes = Array.from({ length: count }, (_, i) => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 14,
        vy: (Math.random() - 0.5) * 14,
        seller: i % 3 === 0,
        pulse: 0,
      }))
    }
    const resize = () => {
      const r = canvas.getBoundingClientRect()
      if (Math.abs(r.width - w) < 1 && Math.abs(r.height - h) < 1) return
      w = r.width
      h = r.height
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      seed()
    }

    const draw = () => {
      ctx.clearRect(0, 0, w, h)
      // links between nearby agents, and to the cursor
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          const d = Math.hypot(a.x - b.x, a.y - b.y)
          if (d < LINK) {
            ctx.strokeStyle = `rgba(123,127,245,${(1 - d / LINK) * 0.22})`
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
        const dm = Math.hypot(a.x - mouse.x, a.y - mouse.y)
        if (dm < 180) {
          ctx.strokeStyle = `rgba(245,245,247,${(1 - dm / 180) * 0.35})`
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(mouse.x, mouse.y)
          ctx.stroke()
        }
      }
      // payments in flight
      for (const p of packets) {
        const x = p.from.x + (p.to.x - p.from.x) * p.t
        const y = p.from.y + (p.to.y - p.from.y) * p.t
        ctx.strokeStyle = 'rgba(34,197,94,.55)'
        ctx.lineWidth = 1.4
        ctx.beginPath()
        ctx.moveTo(p.from.x, p.from.y)
        ctx.lineTo(x, y)
        ctx.stroke()
        const g = ctx.createRadialGradient(x, y, 0, x, y, 10)
        g.addColorStop(0, 'rgba(34,197,94,1)')
        g.addColorStop(1, 'rgba(34,197,94,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(x, y, 10, 0, Math.PI * 2)
        ctx.fill()
      }
      // agents
      for (const n of nodes) {
        const color = n.seller ? '139,92,246' : '79,124,255'
        const r = n.seller ? 3.4 : 2.6
        if (n.pulse > 0) {
          ctx.strokeStyle = `rgba(34,197,94,${n.pulse})`
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.arc(n.x, n.y, r + (1 - n.pulse) * 18, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.fillStyle = `rgba(${color},.25)`
        ctx.beginPath()
        ctx.arc(n.x, n.y, r * 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = `rgb(${color})`
        ctx.beginPath()
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fill()
      }
      // settled amounts floating up from the seller
      ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.textAlign = 'center'
      for (const t of tags) {
        ctx.fillStyle = `rgba(34,197,94,${Math.max(0, 1 - t.age / 1.6)})`
        ctx.fillText(t.text, t.x, t.y - t.age * 26)
      }
    }

    const step = (dt: number) => {
      for (const n of nodes) {
        const dx = n.x - mouse.x
        const dy = n.y - mouse.y
        const d = Math.hypot(dx, dy)
        if (d < 120 && d > 0) {
          n.vx += (dx / d) * 60 * dt
          n.vy += (dy / d) * 60 * dt
        }
        n.vx *= 0.99
        n.vy *= 0.99
        if (Math.hypot(n.vx, n.vy) < 5) {
          n.vx += (Math.random() - 0.5) * 4 * dt
          n.vy += (Math.random() - 0.5) * 4 * dt
        }
        n.x += n.vx * dt
        n.y += n.vy * dt
        if (n.x < 0 || n.x > w) n.vx *= -1
        if (n.y < 0 || n.y > h) n.vy *= -1
        n.x = Math.max(0, Math.min(w, n.x))
        n.y = Math.max(0, Math.min(h, n.y))
        n.pulse = Math.max(0, n.pulse - dt * 1.2)
      }
      // every so often a buyer pays a nearby seller
      spawnIn -= dt
      if (spawnIn <= 0) {
        spawnIn = 0.35 + Math.random() * 0.5
        const buyers = nodes.filter((n) => !n.seller)
        const from = buyers[Math.floor(Math.random() * buyers.length)]
        let to: AgentNode | null = null
        let best = 260
        for (const n of nodes) {
          if (!n.seller) continue
          const d = Math.hypot(n.x - from.x, n.y - from.y)
          if (d < best) {
            best = d
            to = n
          }
        }
        if (to) packets.push({ from, to, t: 0 })
      }
      for (let i = packets.length - 1; i >= 0; i--) {
        const p = packets[i]
        p.t += dt / 1.1
        if (p.t >= 1) {
          p.to.pulse = 1
          tags.push({ x: p.to.x, y: p.to.y - 10, age: 0, text: `+${PRICES[Math.floor(Math.random() * PRICES.length)]} ${TOKEN_SYMBOL}` })
          packets.splice(i, 1)
        }
      }
      for (let i = tags.length - 1; i >= 0; i--) {
        tags[i].age += dt
        if (tags[i].age > 1.6) tags.splice(i, 1)
      }
    }

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      step(dt)
      draw()
      frame = visible ? requestAnimationFrame(loop) : 0
    }

    resize()
    draw()
    // Only animate while on screen.
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      if (visible && !reduce && !frame) {
        last = performance.now()
        frame = requestAnimationFrame(loop)
      }
    })
    io.observe(canvas)
    const ro = new ResizeObserver(() => {
      resize()
      draw()
    })
    ro.observe(canvas)
    const section = canvas.parentElement
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      mouse.x = e.clientX - r.left
      mouse.y = e.clientY - r.top
    }
    const onLeave = () => {
      mouse.x = -9999
      mouse.y = -9999
    }
    section?.addEventListener('pointermove', onMove)
    section?.addEventListener('pointerleave', onLeave)
    return () => {
      cancelAnimationFrame(frame)
      io.disconnect()
      ro.disconnect()
      section?.removeEventListener('pointermove', onMove)
      section?.removeEventListener('pointerleave', onLeave)
    }
  }, [reduce])

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="absolute inset-0 h-full w-full"
      style={{
        WebkitMaskImage: 'linear-gradient(transparent, #000 18%, #000 82%, transparent)',
        maskImage: 'linear-gradient(transparent, #000 18%, #000 82%, transparent)',
      }}
    />
  )
}

/** A live-looking agent economy, with the measured numbers on top. */
export function Proof() {
  return (
    <section data-guide="proof" className="relative flex min-h-[calc(var(--svhz)*100)] flex-col justify-center overflow-hidden px-5 py-28 text-[#F5F5F7]">
      <SectionGlow tone="indigo" />
      <AgentNetwork />
      {/* calm the network behind the words */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(46% 34% at 50% 40%, rgba(8,9,13,.88), transparent)' }}
      />
      <div className="pointer-events-none relative mx-auto w-full max-w-[1200px]">
        <SectionHeader
          eyebrow="PROOF, NOT PROMISES"
          title="An economy of agents, measured on-chain."
          description="Blue agents buy, violet agents sell, and every green pulse is a payment settling. The numbers below come from real deals on BNB Smart Chain Testnet."
        />
        <div className="pointer-events-auto mt-16 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STATS.map((s, i) => (
            <motion.div key={s.label} custom={i + 1} initial="hidden" whileInView="show" viewport={REVEAL_VIEWPORT} variants={fadeUp}>
              <SpotlightCard
                color={s.rgb}
                className="h-full overflow-hidden rounded-3xl border border-white/10 bg-[#0B0A24]/65 p-7 backdrop-blur-xl"
              >
                <div className="relative text-[52px] font-semibold leading-none tracking-[-0.04em]" style={{ color: s.accent }}>
                  <CountUp to={s.to} prefix={s.prefix} suffix={s.suffix} />
                </div>
                <p className="relative mt-4 text-[15px] leading-relaxed text-[#A3A5AE]">{s.label}</p>
              </SpotlightCard>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
