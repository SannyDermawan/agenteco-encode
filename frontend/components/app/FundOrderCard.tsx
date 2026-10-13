'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useSignMessage } from 'wagmi'
import { NeumorphicCard } from './NeumorphicCard'
import { appChain } from '@/lib/web3/chain'
import { EXECUTION_WINDOW_SECONDS, REVIEW_WINDOW_SECONDS, formatDuration } from '@/lib/web3/constants'
import { useUsdtDecimals } from '@/lib/web3/hooks'
import { InsufficientTokenError } from '@/lib/web3/usdtBalance'
import { HIRE_STEP_LABEL, hireWithTask, type HireStep } from '@/lib/web3/hireWithTask'
import { GetTestTokensCard } from './GetTestTokensCard'
import { TaskBriefForm, briefFromDraft, draftFromBrief, isBriefReady, type BriefDraft } from './TaskBriefForm'
import { fundOrder, type ApiOrder } from '@/lib/api/orders'
import { ArrowRightIcon } from './icons'
import { TOKEN_SYMBOL } from '@/lib/web3/network'
import { isCapabilityId } from '@shared/capabilities/definitions'

type Step = 'idle' | HireStep | 'linking-order' | 'done'

function stepLabel(step: Step): string {
  return step === 'linking-order' ? 'Linking escrow to order…' : HIRE_STEP_LABEL[step as HireStep]
}

function Spinner() {
  return <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white" />
}

/** Funds the agreed price from a Negotiation, not the seller's listed price. */
export function FundOrderCard({ order }: { order: ApiOrder }) {
  const router = useRouter()
  const { address, isConnected, chainId } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const { data: decimals } = useUsdtDecimals()

  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)
  // Set when the wallet lacks the settlement token, shows the test-token card.
  const [needsTokens, setNeedsTokens] = useState(false)

  const seller = order.sellerAgent.walletAddress as `0x${string}` | null
  const capability = isCapabilityId(order.capability) ? order.capability : null
  // Starts from the buyer agent's own brief when it has one.
  const [briefDraft, setBriefDraft] = useState<BriefDraft>(() => draftFromBrief(order.buyerAgent.taskBrief))
  const [criteria, setCriteria] = useState(order.buyerAgent.acceptanceCriteria ?? '')
  const [showBriefErrors, setShowBriefErrors] = useState(false)
  const onCorrectChain = chainId === appChain.id
  const busy = step !== 'idle' && step !== 'done'
  const isBuyerOwner = !!address && address.toLowerCase() === order.buyerAgent.ownerWallet.toLowerCase()

  async function handleFund() {
    if (!seller || !address || decimals === undefined || !capability) return
    setError(null)
    setNeedsTokens(false)

    const brief = briefFromDraft(capability, briefDraft)
    if (!brief.ok || !isBriefReady(capability, briefDraft, criteria)) {
      setShowBriefErrors(true)
      return
    }

    try {
      const signer = { address, signMessageAsync }
      const { escrowId } = await hireWithTask({
        signer,
        decimals,
        seller,
        price: order.price,
        capability,
        brief: brief.brief,
        criteria: criteria.trim(),
        onStep: setStep,
      })

      setStep('linking-order')
      await fundOrder(order.id, signer, escrowId.toString())

      setStep('done')
      router.push(`/app/orders/${order.id}`)
    } catch (err) {
      setStep('idle')
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setNeedsTokens(err instanceof InsufficientTokenError)
    }
  }

  return (
    <NeumorphicCard className="p-6">
      <h3 className="text-[15px] font-semibold text-[#F5F5F7]">Fund This Order</h3>

      {!seller ? (
        <p className="mt-4 text-[13px] leading-relaxed text-[#8B8D96]">
          The seller agent hasn&apos;t linked an on-chain wallet yet, so this order can&apos;t be funded on-chain.
        </p>
      ) : !capability ? (
        <p className="mt-4 text-[13px] leading-relaxed text-[#8B8D96]">
          This order is for a capability that is no longer supported, so it can&apos;t be funded.
        </p>
      ) : (
        <>
          <div className="mt-4 space-y-3 text-[13px]">
            <div className="flex items-center justify-between">
              <span className="text-[#8B8D96]">Agreed price</span>
              <span className="text-[#F5F5F7]">{Number(order.price).toFixed(2)} {TOKEN_SYMBOL}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="shrink-0 text-[#8B8D96]">Seller wallet</span>
              <span className="truncate font-mono text-[11.5px] text-[#F5F5F7]" title={seller}>
                {seller}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#8B8D96]">Execution window</span>
              <span className="text-[#F5F5F7]">{formatDuration(EXECUTION_WINDOW_SECONDS)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#8B8D96]">Review window</span>
              <span className="text-[#F5F5F7]">{formatDuration(REVIEW_WINDOW_SECONDS)}</span>
            </div>
          </div>

          {isBuyerOwner && (
            <div className="mt-5 border-t border-white/[0.06] pt-5">
              <p className="mb-3 text-[13px] font-medium text-[#F5F5F7]">Task Brief</p>
              <TaskBriefForm
                capability={capability}
                draft={briefDraft}
                onDraftChange={setBriefDraft}
                criteria={criteria}
                onCriteriaChange={setCriteria}
                showErrors={showBriefErrors}
              />
            </div>
          )}

          {!isConnected ? (
            <p className="mt-5 rounded-xl border border-white/[0.06] bg-[#0D0F14] px-3 py-2.5 text-[12.5px] text-[#8B8D96]">
              Connect your wallet from the top bar to fund this order.
            </p>
          ) : !onCorrectChain ? (
            <p className="mt-5 rounded-xl border border-[#F59E0B]/30 bg-[#F59E0B]/10 px-3 py-2.5 text-[12.5px] text-[#F59E0B]">
              Switch to {appChain.name} from the top bar to continue.
            </p>
          ) : !isBuyerOwner ? (
            <p className="mt-5 rounded-xl border border-[#F59E0B]/30 bg-[#F59E0B]/10 px-3 py-2.5 text-[12.5px] text-[#F59E0B]">
              Connect the wallet that owns the buyer agent ({order.buyerAgent.name}) to fund this order.
            </p>
          ) : (
            <button
              type="button"
              onClick={handleFund}
              disabled={busy || decimals === undefined}
              className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#5B5FEF] py-2.5 text-[13.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? (
                <>
                  <Spinner />
                  {stepLabel(step)}
                </>
              ) : (
                <>
                  Create &amp; Fund Escrow
                  <ArrowRightIcon className="h-3.5 w-3.5" />
                </>
              )}
            </button>
          )}

          {error && <p className="mt-3 text-[12px] leading-relaxed text-[#EF4444]">{error}</p>}
          {needsTokens && (
            <div className="mt-4">
              <GetTestTokensCard reason="Your wallet does not hold enough test tokens for this. Claim some, then try again." />
            </div>
          )}
        </>
      )}
    </NeumorphicCard>
  )
}
