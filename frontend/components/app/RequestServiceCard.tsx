'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { useWallet } from '@/lib/wallet/useWallet'
import { NeumorphicCard } from './NeumorphicCard'
import { EXECUTION_WINDOW_SECONDS, REVIEW_WINDOW_SECONDS, formatDuration } from '@/lib/web3/constants'
import { useTokenDecimals } from '@/lib/chain/hooks'
import { InsufficientTokenError } from '@/lib/web3/usdtBalance'
import { HIRE_STEP_LABEL, hireWithTask, type HireStep } from '@/lib/chain/hire'
import { GetTestTokensCard } from './GetTestTokensCard'
import { EMPTY_BRIEF_DRAFT, TaskBriefForm, briefFromDraft, isBriefReady, type BriefDraft } from './TaskBriefForm'
import type { AgentSummary } from '@/lib/agenteco-data'
import { getAgent } from '@/lib/api/agents'
import { ArrowRightIcon } from './icons'
import { CHAIN_NAME, TOKEN_SYMBOL, explorerTxUrl } from '@/lib/web3/network'
import { fetchPricing } from '@/lib/x402/gateway'
import { payPerCall, type PaidCall } from '@/lib/x402/pay'
import { isCapabilityId } from '@shared/capabilities/definitions'
import { exampleFromSchema } from '@shared/capabilities/custom'
import { useCapabilities } from '@/lib/api/capabilities'
import { CustomBriefForm, parseCustomBrief } from './CustomBriefForm'
import { PlatformFeeRows } from './PlatformFee'

type Step = 'idle' | 'checking-status' | HireStep | 'done'

function stepLabel(step: Step): string {
  return step === 'checking-status' ? 'Checking agent availability…' : HIRE_STEP_LABEL[step as HireStep]
}

function Spinner() {
  return <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white" />
}

export function RequestServiceCard({ agent }: { agent: AgentSummary }) {
  const router = useRouter()
  const { family, address, isConnected, onSelectedNetwork, signer, txSigner } = useWallet()
  const { data: decimals } = useTokenDecimals()

  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)
  // Set when the wallet lacks the settlement token, shows the test-token card.
  const [needsTokens, setNeedsTokens] = useState(false)

  const seller = agent.walletAddress
  const capability = agent.capabilities.find(isCapabilityId)
  // No platform capability: a community one from the open registry, briefed as JSON.
  const { data: registry } = useCapabilities()
  const community = capability ? undefined : registry?.find((c) => c.source === 'community' && agent.capabilities.includes(c.id))
  // Prefilled with the capability's first worked example (or one shaped like its input schema) until the buyer edits it.
  const [editedJson, setCustomJson] = useState<string | null>(null)
  const customJson = editedJson ?? (community ? JSON.stringify(community.examples?.[0]?.input ?? exampleFromSchema(community.inputSchema), null, 2) : '')
  const [briefDraft, setBriefDraft] = useState<BriefDraft>(EMPTY_BRIEF_DRAFT)
  const [criteria, setCriteria] = useState('')
  const [showBriefErrors, setShowBriefErrors] = useState(false)
  // The contract itself will escrow for any address. "offline" is only
  // enforced here and in the registry, so an offline seller is never hired.
  const [isOfflineNow, setIsOfflineNow] = useState(false)
  const isOffline = agent.status === 'offline' || isOfflineNow
  const onCorrectChain = onSelectedNetwork
  const busy = step !== 'idle' && step !== 'done'

  // The size of the job picks how it is paid: under the gateway's threshold, and when the x402 gateway sells this
  // capability, the default is one payment per call; otherwise (or by choice) it is escrow with this seller.
  const pricing = useQuery({ queryKey: ['x402-pricing'], queryFn: ({ signal }) => fetchPricing(signal), retry: 1, staleTime: 60_000 })
  const capabilityId = capability ?? community?.id
  const perCallAgent = capabilityId ? pricing.data?.agents.find((a) => a.capability === capabilityId) : undefined
  const threshold = pricing.data?.escrow.thresholdUsd
  const underThreshold = threshold !== undefined && agent.price < threshold
  const x402Available = family === 'solana' && underThreshold && !!perCallAgent
  const [forceEscrow, setForceEscrow] = useState(false)
  const x402Mode = x402Available && !forceEscrow
  const [paying, setPaying] = useState(false)
  const [paid, setPaid] = useState<PaidCall | null>(null)

  async function handleBuyX402() {
    if (!txSigner || !capabilityId || !perCallAgent) return
    setError(null)
    setPaid(null)
    let brief: unknown
    if (capability) {
      const b = briefFromDraft(capability, briefDraft)
      if (!b.ok || !isBriefReady(capability, briefDraft, criteria)) {
        setShowBriefErrors(true)
        return
      }
      brief = b.brief
    } else {
      const b = parseCustomBrief(community!, customJson)
      if (!b.ok) {
        setShowBriefErrors(true)
        return
      }
      brief = b.brief
    }
    setPaying(true)
    try {
      setPaid(await payPerCall(txSigner, capabilityId, brief))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The payment did not go through. Nothing was charged.')
    } finally {
      setPaying(false)
    }
  }

  async function handleRequestService() {
    if (!seller || isOffline || !address || !signer || decimals === undefined || (!capability && !community)) return
    setError(null)
    setNeedsTokens(false)

    // Validated here, by the API, and by the seller before it starts (spec §7).
    let job: { capability: string; brief: unknown }
    if (capability) {
      const brief = briefFromDraft(capability, briefDraft)
      if (!brief.ok || !isBriefReady(capability, briefDraft, criteria)) {
        setShowBriefErrors(true)
        return
      }
      job = { capability, brief: brief.brief }
    } else {
      const brief = parseCustomBrief(community!, customJson)
      if (!brief.ok) {
        setShowBriefErrors(true)
        return
      }
      job = { capability: community!.id, brief: brief.brief }
    }

    try {
      // Re-check right before any money moves, this page may have been open
      // since before the seller went offline.
      setStep('checking-status')
      const latest = await getAgent(agent.id)
      if (latest && !latest.isOnline) {
        setStep('idle')
        setIsOfflineNow(true)
        return
      }

      // No negotiation on a direct hire: the price is the listing price (spec §8.2).
      const { escrowId } = await hireWithTask({
        signer,
        txSigner,
        decimals,
        seller,
        price: agent.price.toString(),
        capability: job.capability,
        brief: job.brief,
        criteria: criteria.trim(),
        onStep: setStep,
      })

      setStep('done')
      router.push(`/app/orders/onchain/${escrowId}`)
    } catch (err) {
      setStep('idle')
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setNeedsTokens(err instanceof InsufficientTokenError)
    }
  }

  return (
    <NeumorphicCard className="p-6">
      <h3 className="text-[15px] font-semibold text-[#F5F5F7]">Request Service</h3>

      {!seller ? (
        <p className="mt-4 text-[13px] leading-relaxed text-[#8B8D96]">
          This agent hasn&apos;t linked an on-chain wallet yet, so it can&apos;t be hired directly on-chain.
        </p>
      ) : !capability && !community ? (
        <p className="mt-4 text-[13px] leading-relaxed text-[#8B8D96]">
          {registry ? 'This agent offers a capability that is not in the registry, so it cannot be hired.' : 'Loading capability…'}
        </p>
      ) : (
        <>
          <div className="mt-4 space-y-3 text-[13px]">
            <div className="flex items-center justify-between">
              <span className="text-[#8B8D96]">Service</span>
              <span className="text-[#F5F5F7]">{agent.service}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#8B8D96]">{x402Mode ? 'Price per call (x402)' : 'Price'}</span>
              <span className="text-[#F5F5F7]">{x402Mode && perCallAgent ? `${perCallAgent.price.replace('$', '')} ${TOKEN_SYMBOL}` : `${agent.price.toFixed(2)} ${TOKEN_SYMBOL}`}</span>
            </div>
            {!x402Mode && (
              <>
            <PlatformFeeRows price={agent.price} decimals={decimals} />
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
              </>
            )}
          </div>

          {x402Available && (
            <div className="mt-5 rounded-xl border border-[#5B5FEF]/30 bg-[#5B5FEF]/[0.08] px-3.5 py-3 text-[12.5px] leading-relaxed text-[#C4C6CF]">
              {x402Mode ? (
                <>
                  A job under ${threshold} is paid per call with x402. This call runs on AgentEco&apos;s x402 gateway agent for {perCallAgent?.price}, not on {agent.service}: one signature, no escrow, and no refund or dispute step.{' '}
                  <button type="button" onClick={() => setForceEscrow(true)} className="font-medium text-[#8FA9FF] hover:underline">
                    Use escrow with this seller instead ({agent.price.toFixed(2)} {TOKEN_SYMBOL})
                  </button>
                </>
              ) : (
                <>
                  Paid through escrow with this seller: the price is locked until you accept the work.{' '}
                  <button type="button" onClick={() => setForceEscrow(false)} className="font-medium text-[#8FA9FF] hover:underline">
                    Pay per call with x402 instead ({perCallAgent?.price})
                  </button>
                </>
              )}
            </div>
          )}
          {family === 'solana' && underThreshold && !perCallAgent && pricing.data && (
            <p className="mt-5 rounded-xl border border-white/[0.06] bg-[#0D0F14] px-3 py-2.5 text-[12.5px] text-[#8B8D96]">
              The x402 gateway does not sell this capability per call, so it is paid through escrow with this seller.
            </p>
          )}

          {(!isOffline || x402Mode) && (
            <div className="mt-5 border-t border-white/[0.06] pt-5">
              <p className="mb-3 text-[13px] font-medium text-[#F5F5F7]">Task Brief</p>
              {capability ? (
                <TaskBriefForm
                  capability={capability}
                  draft={briefDraft}
                  onDraftChange={setBriefDraft}
                  criteria={criteria}
                  onCriteriaChange={setCriteria}
                  showErrors={showBriefErrors}
                />
              ) : (
                <CustomBriefForm
                  capability={community!}
                  json={customJson}
                  onJsonChange={setCustomJson}
                  criteria={criteria}
                  onCriteriaChange={setCriteria}
                  showErrors={showBriefErrors}
                />
              )}
            </div>
          )}

          {isOffline && !x402Mode ? (
            <p className="mt-5 rounded-xl border border-white/[0.06] bg-[#0D0F14] px-3 py-2.5 text-[12.5px] text-[#8B8D96]">
              This agent is offline and not accepting new requests right now.
            </p>
          ) : !isConnected ? (
            <p className="mt-5 rounded-xl border border-white/[0.06] bg-[#0D0F14] px-3 py-2.5 text-[12.5px] text-[#8B8D96]">
              Connect your wallet from the top bar to request this service.
            </p>
          ) : !onCorrectChain ? (
            <p className="mt-5 rounded-xl border border-[#F59E0B]/30 bg-[#F59E0B]/10 px-3 py-2.5 text-[12.5px] text-[#F59E0B]">
              Switch to {CHAIN_NAME} from the top bar to continue.
            </p>
          ) : (
            <button
              type="button"
              onClick={x402Mode ? handleBuyX402 : handleRequestService}
              disabled={x402Mode ? paying || !txSigner : busy || decimals === undefined}
              className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#5B5FEF] py-2.5 text-[13.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {x402Mode ? (
                paying ? (
                  <>
                    <Spinner />
                    Approve the payment in your wallet…
                  </>
                ) : (
                  <>
                    Buy per call with x402 ({perCallAgent?.price})
                    <ArrowRightIcon className="h-3.5 w-3.5" />
                  </>
                )
              ) : busy ? (
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

          {paid && (
            <div className="mt-4 space-y-3 rounded-xl border border-[#22C55E]/30 bg-[#22C55E]/[0.06] p-3.5">
              <div className="text-[12.5px] font-medium text-[#4ADE80]">{paid.replayed ? 'Already paid for this request: the stored answer' : 'Paid and delivered'}</div>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#08090D] p-3 text-[12px] leading-relaxed text-[#E5E7EB]">{JSON.stringify(paid.result, null, 2)}</pre>
              {paid.receipt ? (
                <a href={explorerTxUrl(paid.receipt.transaction)} target="_blank" rel="noreferrer" className="block break-all font-mono text-[11.5px] text-[#8FA9FF] hover:underline">
                  Settlement receipt: {paid.receipt.transaction}
                </a>
              ) : (
                <span className="block text-[11.5px] text-[#8B8D96]">No receipt came back with this answer.</span>
              )}
            </div>
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
