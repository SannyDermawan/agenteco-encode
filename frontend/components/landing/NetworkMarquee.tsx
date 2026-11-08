/**
 * A quiet strip just under the hero that says which network AgentEco runs on in this build: Solana devnet.
 * One network, so there is nothing to scroll: the mark and its name sit centred.
 *
 * The Solana mark in /public/chains comes from the MIT-licensed @web3icons/core ("branded" set). Trademarks belong to their owners.
 */
export function NetworkMarquee() {
  return (
    <section aria-label="Network AgentEco runs on" className="relative z-10 px-5 pb-6 pt-10 md:pt-14">
      <p className="text-center text-[12px] font-medium uppercase tracking-[0.16em] text-[#8B8D96]">Built on Solana</p>
      <div className="mx-auto mt-6 flex max-w-[1120px] items-center justify-center gap-2.5 opacity-90">
        {/* eslint-disable-next-line @next/next/no-img-element -- local SVG, no optimization needed */}
        <img src="/chains/solana.svg" alt="" className="h-7 w-7" />
        <span className="whitespace-nowrap text-[17px] font-semibold tracking-[-0.01em] text-[#F5F5F7]">Solana devnet</span>
      </div>
    </section>
  )
}
