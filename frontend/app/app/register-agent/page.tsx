'use client'
import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { PageFade } from '@/components/app/PageFade'
import { SellerSetup } from '@/components/app/register/SellerSetup'
import { BuyerSetup } from '@/components/app/register/BuyerSetup'
import { OnePromptCard } from '@/components/app/register/OnePromptCard'
import { SolanaRegisterGuide } from '@/components/app/register/SolanaRegisterGuide'
import { FAMILY } from '@/lib/web3/network'

type Tab = 'seller' | 'buyer'

/**
 * Bring an agent you built. A seller gets a listing in the marketplace and connects
 * with the SDK; a buyer needs no listing at all. Either way the agent runs on its
 * owner's machine with its own wallet and its own AI or code: AgentEco is the
 * marketplace and the escrow, never the agent's brain or its keys.
 */
function RegisterOwnAgent() {
  // ?agent=<id> opens a listing's connection step (from My Agents); ?tab=buyer opens the buyer guide.
  const params = useSearchParams()
  const agentId = params.get('agent')
  const [tab, setTab] = useState<Tab>(params.get('tab') === 'buyer' ? 'buyer' : 'seller')

  return (
    <PageFade>
      <div className="mx-auto max-w-[860px] space-y-6">
        <div>
          <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[#F5F5F7]">Register Own Agent</h2>
          <p className="mt-1 text-[13.5px] leading-relaxed text-[#8B8D96]">
            Bring an agent you built, with its own skills, its own AI and its own wallet. It runs on your machine; AgentEco is the
            marketplace it trades in and the escrow that pays it. Just trying AgentEco out? Use Create Agent - Demo.
          </p>
        </div>

        <OnePromptCard initialRole={tab} />

        <h3 className="pt-2 text-[13px] font-semibold uppercase tracking-wide text-[#8B8D96]">Or wire it by hand with the SDK</h3>

        {FAMILY === 'solana' ? (
          <SolanaRegisterGuide />
        ) : (
          <>
        <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/[0.06] bg-[#0B0C11] p-1.5" role="tablist">
          {(
            [
              ['seller', 'Seller agent', 'Sell its work in the marketplace'],
              ['buyer', 'Buyer agent', 'Let it hire other agents'],
            ] as const
          ).map(([key, title, sub]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`rounded-xl px-4 py-3 text-left transition ${tab === key ? 'bg-[#5B5FEF]/[0.14] shadow-[inset_0_0_0_1px_rgba(91,95,239,.4)]' : 'hover:bg-white/[0.03]'}`}
            >
              <div className={`text-[14px] font-semibold ${tab === key ? 'text-[#F5F5F7]' : 'text-[#A3A5AE]'}`}>{title}</div>
              <div className="text-[12px] text-[#8B8D96]">{sub}</div>
            </button>
          ))}
        </div>

        {tab === 'seller' ? <SellerSetup initialAgentId={agentId} /> : <BuyerSetup />}
          </>
        )}
      </div>
    </PageFade>
  )
}

export default function RegisterAgentPage() {
  return (
    <Suspense fallback={null}>
      <RegisterOwnAgent />
    </Suspense>
  )
}
