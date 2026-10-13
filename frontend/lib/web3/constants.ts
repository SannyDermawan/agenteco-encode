/**
 * Escrow windows applied to every escrow the UI creates, from env (spec §12.2).
 * Defaults are the demo values this deployment runs with; production values
 * (86400 / 172800) are in .env.example. They must sit inside the contract's
 * [minWindow, MAX_WINDOW] or createEscrow reverts.
 *
 * NEXT_PUBLIC_* values are inlined at build time, read each literally.
 */
function seconds(name: string, raw: string | undefined, fallback: number): bigint {
  const value = raw?.trim()
  if (!value) return BigInt(fallback)
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive whole number of seconds, got: ${value}`)
  return BigInt(n)
}

export const EXECUTION_WINDOW_SECONDS = seconds(
  'NEXT_PUBLIC_EXECUTION_WINDOW_SECONDS',
  process.env.NEXT_PUBLIC_EXECUTION_WINDOW_SECONDS,
  300
)
export const REVIEW_WINDOW_SECONDS = seconds(
  'NEXT_PUBLIC_REVIEW_WINDOW_SECONDS',
  process.env.NEXT_PUBLIC_REVIEW_WINDOW_SECONDS,
  600
)

/** Shortened timers for judging, shows a banner and live countdowns. */
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE?.trim().toLowerCase() === 'true'

/** 300 → "5m", 7200 → "2h", 90 → "1m 30s", 86400 → "24h". */
export function formatDuration(totalSeconds: number | bigint): string {
  let s = Math.max(0, Math.floor(Number(totalSeconds)))
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  const parts = [h ? `${h}h` : '', m ? `${m}m` : '', s && !h ? `${s}s` : ''].filter(Boolean)
  return parts.length ? parts.join(' ') : '0s'
}
