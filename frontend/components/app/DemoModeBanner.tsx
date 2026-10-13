import { DEMO_MODE, EXECUTION_WINDOW_SECONDS, REVIEW_WINDOW_SECONDS, formatDuration } from '@/lib/web3/constants'

/** Shown app-wide when NEXT_PUBLIC_DEMO_MODE=true (spec §12.2): every timer is minutes, not days. */
export function DemoModeBanner() {
  if (!DEMO_MODE) return null
  return (
    <div className="border-b border-[#F59E0B]/20 bg-[#F59E0B]/[0.07] px-4 py-2 text-center text-[12px] text-[#F5C26B] md:px-7">
      <span className="font-medium">Demo mode: timers shortened.</span>{' '}
      <span className="text-[#C9A15A]">
        Execution {formatDuration(EXECUTION_WINDOW_SECONDS)}, review {formatDuration(REVIEW_WINDOW_SECONDS)}; production uses days.
      </span>
    </div>
  )
}
