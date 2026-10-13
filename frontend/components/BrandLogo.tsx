/**
 * The AgentEco mark shown beside the "AgentEco" wordmark. Source art lives in
 * asset/agenteco-logo.png; public/agenteco-logo.png is a trimmed 175×96 copy.
 * Size it by height (e.g. `h-6`), the width follows the logo's aspect ratio.
 */
export function BrandLogo({ className = 'h-[26px]' }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- small local PNG, no optimization needed
    <img src="/agenteco-logo.png" alt="" width={175} height={96} className={`w-auto shrink-0 ${className}`} />
  )
}
