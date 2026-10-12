/**
 * A slow, endless strip of the networks AgentEco is deployed on, just under the hero (the same idea as a
 * partner-logo strip). Pure CSS: the list is drawn twice and the track slides by exactly one copy, so the loop
 * has no seam. It pauses under the cursor and stands still for visitors who ask for less motion
 * (see .network-marquee in globals.css).
 *
 * The white marks in /public/chains come from the MIT-licensed @web3icons/core ("mono" set); the BOT Chain
 * mark is the project's own /logo-white-botchain.svg. Trademarks belong to their owners.
 */
const NETWORKS: { name: string; icon: string; wordmark?: boolean }[] = [
  { name: 'BNB Smart Chain', icon: '/chains/bnb.svg' },
  { name: 'Base', icon: '/chains/base.svg' },
  { name: 'Ethereum', icon: '/chains/ethereum.svg' },
  { name: 'Arbitrum', icon: '/chains/arbitrum.svg' },
  { name: 'Tempo', icon: '/chains/tempo.svg' },
  { name: 'Solana', icon: '/chains/solana.svg' },
  { name: 'BOT Chain', icon: '/logo-white-botchain.svg', wordmark: true },
]

export function NetworkMarquee() {
  return (
    <section aria-label="Networks AgentEco is deployed on" className="relative z-10 px-5 pb-6 pt-10 md:pt-14">
      <p className="text-center text-[12px] font-medium uppercase tracking-[0.16em] text-[#8B8D96]">One escrow, seven networks</p>
      <div className="network-marquee relative mx-auto mt-6 max-w-[1120px] overflow-hidden">
        <div className="network-marquee-track flex w-max">
          {[0, 1].map((copy) => (
            <ul key={copy} aria-hidden={copy === 1} className="flex shrink-0 items-center gap-14 pr-14 md:gap-20 md:pr-20">
              {NETWORKS.map((n) => (
                <li key={n.name} className="flex shrink-0 items-center gap-2.5 opacity-55 transition-opacity duration-300 hover:opacity-100">
                  {n.wordmark ? (
                    // eslint-disable-next-line @next/next/no-img-element -- local SVG, no optimization needed
                    <img src={n.icon} alt={n.name} className="h-[22px] w-auto" />
                  ) : (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element -- local SVG, no optimization needed */}
                      <img src={n.icon} alt="" className="h-7 w-7" />
                      <span className="whitespace-nowrap text-[17px] font-semibold tracking-[-0.01em] text-[#F5F5F7]">{n.name}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ))}
        </div>
      </div>
    </section>
  )
}
