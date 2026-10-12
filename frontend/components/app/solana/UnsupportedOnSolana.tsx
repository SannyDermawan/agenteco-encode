import Link from 'next/link'
import { NeumorphicCard } from '../NeumorphicCard'
import { PageFade } from '../PageFade'
import { CHAIN_NAME } from '@/lib/web3/network'

/**
 * What a page that only works on the EVM networks shows while a Solana network is selected: what it is,
 * why it is not here, and where to go instead. Nothing on this page is pretended to work.
 */
export function UnsupportedOnSolana({ title, why, instead }: { title: string; why: string; instead?: { href: string; label: string } }) {
  return (
    <PageFade>
      <NeumorphicCard className="mx-auto max-w-[620px] p-7">
        <h2 className="text-[18px] font-semibold text-[#F5F5F7]">{title}</h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[#8B8D96]">
          This is not available on {CHAIN_NAME} yet. {why}
        </p>
        {instead && (
          <Link href={instead.href} className="mt-4 inline-block rounded-xl bg-[#5B5FEF] px-4 py-2 text-[13px] font-medium text-white transition hover:brightness-110">
            {instead.label} →
          </Link>
        )}
        <p className="mt-4 text-[12px] text-[#54565F]">Switch network from the top bar to use it on an EVM network.</p>
      </NeumorphicCard>
    </PageFade>
  )
}
