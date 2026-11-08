'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { NeumorphicCard } from './NeumorphicCard'
import { PageFade } from './PageFade'
import { ArrowRightIcon } from './icons'
import { useWallet } from '@/lib/wallet/useWallet'
import { listAgents } from '@/lib/api/agents'
import { GATEWAY_URL, fetchPlan, fetchPricing, parseBudgetInput, type RoutePlan } from '@/lib/x402/gateway'
import { payPerCall, type PaidCall } from '@/lib/x402/pay'
import { explorerTxUrl } from '@/lib/web3/network'

const TRACE = 'text-[#8B8D96]'

/** The two ways to pay, side by side. The one the job's size picks is lit; the other says why it was not chosen. */
function Lane({ chosen, title, tag, price, lines, why }: { chosen: boolean; title: string; tag: string; price: string; lines: string[]; why: string }) {
  return (
    <div
      className={`rounded-2xl border p-5 transition ${
        chosen ? 'border-[#5B5FEF]/60 bg-[#5B5FEF]/[0.08] shadow-[0_0_0_1px_rgba(91,95,239,.25),0_12px_40px_rgba(91,95,239,.15)]' : 'border-white/[0.06] bg-[#0B0C11] opacity-60'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-semibold text-[#F5F5F7]">{title}</span>
        {chosen && <span className="rounded-full bg-[#5B5FEF] px-2.5 py-0.5 text-[10.5px] font-medium text-white">Chosen for this job</span>}
      </div>
      <div className="mt-1 text-[12px] text-[#8FA9FF]">{tag}</div>
      <div className="mt-3 text-[20px] font-semibold tracking-[-0.01em] text-[#F5F5F7]">{price}</div>
      <ul className="mt-3 space-y-1.5 text-[12.5px] leading-relaxed text-[#C4C6CF]">
        {lines.map((l) => (
          <li key={l} className="flex gap-2">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#5B5FEF]" />
            {l}
          </li>
        ))}
      </ul>
      {!chosen && <p className="mt-3 border-t border-white/[0.06] pt-3 text-[12px] leading-relaxed text-[#8B8D96]">{why}</p>}
    </div>
  )
}

export function SmartHire() {
  const { family, address, isConnected, txSigner } = useWallet()
  const [capability, setCapability] = useState('sentiment_score')
  const [budgetText, setBudgetText] = useState('0.01')
  const [text, setText] = useState('The agent was fast, helpful and easy to use. I recommend it.')
  const [language, setLanguage] = useState('Indonesian')
  const budget = parseBudgetInput(budgetText)

  // What can be hired: what the gateway sells per call, and what online sellers list.
  const pricing = useQuery({ queryKey: ['x402-pricing'], queryFn: ({ signal }) => fetchPricing(signal), retry: 1, staleTime: 60_000 })
  const sellers = useQuery({ queryKey: ['smart-hire-sellers'], queryFn: () => listAgents({ role: 'seller' }), staleTime: 30_000 })
  const capabilities = useMemo(() => {
    const set = new Set<string>()
    pricing.data?.agents.forEach((a) => set.add(a.capability))
    sellers.data?.forEach((s) => s.capabilities.forEach((c) => set.add(c)))
    return [...set].sort()
  }, [pricing.data, sellers.data])

  // The route for this job: asked from the gateway, which applies the rule and lists the sellers (debounced while typing).
  const [plan, setPlan] = useState<RoutePlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  useEffect(() => {
    if (budget === null) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetchPlan(capability, budget, controller.signal)
        .then((p) => {
          setPlan(p)
          setPlanError(null)
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return
          setPlan(null)
          setPlanError(e instanceof Error ? e.message : 'The gateway did not answer.')
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [capability, budget])

  const mode = plan?.recommendedMode ?? null
  const threshold = plan?.thresholdUsd ?? pricing.data?.escrow.thresholdUsd ?? 0.05
  const perCall = plan?.x402?.price ?? pricing.data?.agents.find((a) => a.capability === capability)?.price ?? null

  const [paying, setPaying] = useState(false)
  const [paid, setPaid] = useState<PaidCall | null>(null)
  const [payError, setPayError] = useState<string | null>(null)
  useEffect(() => {
    setPaid(null)
    setPayError(null)
  }, [capability, budgetText])

  const brief = capability === 'translate' ? { text, targetLanguage: language } : { text }
  const briefReady = text.trim().length > 0 && text.length <= 2000 && (capability !== 'translate' || language.trim().length >= 2)

  async function payAndRun() {
    if (!txSigner || mode !== 'x402') return
    setPaying(true)
    setPaid(null)
    setPayError(null)
    try {
      setPaid(await payPerCall(txSigner, capability, brief))
    } catch (e) {
      setPayError(e instanceof Error ? e.message : 'The payment did not go through. Nothing was charged.')
    } finally {
      setPaying(false)
    }
  }

  const input = 'w-full rounded-xl border border-white/[0.08] bg-[#08090D] px-3 py-2.5 text-[13.5px] text-[#F5F5F7] outline-none transition focus:border-[#5B5FEF]/70'

  return (
    <PageFade>
      <div className="space-y-6">
        <div>
          <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-[#F5F5F7]">Hire an agent</h2>
          <p className={`mt-1 max-w-[62ch] text-[13.5px] leading-relaxed ${TRACE}`}>
            Say what you need and what the job is worth. AgentEco picks how it is paid: a small job is paid per call with x402, a bigger one is locked in escrow until you accept the result. Both settle in USDC on Solana devnet.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <NeumorphicCard className="p-6">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-[12px] font-medium tracking-[0.06em] text-[#8B8D96]">WHAT DO YOU NEED?</span>
                  <select value={capability} onChange={(e) => setCapability(e.target.value)} className={input}>
                    {(capabilities.length ? capabilities : [capability]).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[12px] font-medium tracking-[0.06em] text-[#8B8D96]">WHAT IS THE JOB WORTH? (USD)</span>
                  <input value={budgetText} onChange={(e) => setBudgetText(e.target.value)} inputMode="decimal" className={input} aria-invalid={budget === null} />
                  {budget === null && <span className="mt-1 block text-[11.5px] text-[#EF4444]">Enter an amount in dollars, for example 0.01 or 1.</span>}
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[11.5px]">
                {['0.01', '0.04', '0.06', '1'].map((v) => (
                  <button key={v} type="button" onClick={() => setBudgetText(v)} className={`rounded-full border px-3 py-1 transition ${budgetText === v ? 'border-[#5B5FEF]/60 text-[#F5F5F7]' : 'border-white/[0.08] text-[#8B8D96] hover:text-[#F5F5F7]'}`}>
                    ${v}
                  </button>
                ))}
              </div>
            </NeumorphicCard>

            <NeumorphicCard className="p-6">
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[12px] font-medium tracking-[0.1em] text-[#8B8D96]">HOW THIS JOB IS PAID</h3>
                <span className="text-[12px] text-[#8B8D96]">The rule: under ${threshold} is paid per call, ${threshold} and up goes through escrow.</span>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Lane
                  chosen={mode === 'x402'}
                  title="Pay per call"
                  tag="x402 · for small jobs"
                  price={perCall ?? 'not sold per call'}
                  lines={['One signature, and the answer comes back in the same request.', 'You are charged only after the agent answers. A failed call costs nothing.', 'No refund or dispute step, which is why it is for small jobs.']}
                  why={perCall === null ? 'The gateway does not sell this per call.' : `This job is worth $${budget ?? '…'}, at or above $${threshold}, so it needs a refund path.`}
                />
                <Lane
                  chosen={mode === 'escrow'}
                  title="Escrow"
                  tag="AgentEco escrow · for bigger jobs"
                  price={budget === null ? '—' : `$${budget}`}
                  lines={['Your USDC is locked on Solana until you accept the result.', 'The seller never delivers: you get it back. The work is bad: you can dispute it.', 'Every step is an on-chain transaction anyone can check.']}
                  why={`This job is worth $${budget ?? '…'}, below $${threshold}, and the gateway sells it per call for ${perCall ?? '—'}: no escrow needed.`}
                />
              </div>
              {planError && <p className="mt-4 text-[12.5px] text-[#F59E0B]">Could not ask the gateway ({planError}). Try again in a moment.</p>}
              {plan && <p className="mt-4 rounded-xl border border-white/[0.06] bg-[#0B0C11] px-3.5 py-3 text-[12.5px] leading-relaxed text-[#C4C6CF]">{plan.notes[0]}</p>}
              <p className="mt-3 text-[11.5px] text-[#54565F]">
                The route comes from <span className="font-mono">{GATEWAY_URL.replace(/^https?:\/\//, '')}/v1/escrow/plan</span>, the same answer an AI agent gets over HTTP.
              </p>
            </NeumorphicCard>
          </div>

          <div className="space-y-4">
            <NeumorphicCard className="p-6">
              <h3 className="text-[15px] font-semibold text-[#F5F5F7]">{mode === 'escrow' ? 'Choose a seller' : mode === 'x402' ? 'Pay and run' : 'Your job'}</h3>

              {family !== 'solana' ? (
                <p className={`mt-4 text-[13px] leading-relaxed ${TRACE}`}>Paying per call runs on Solana devnet. Switch the app to the Solana network from the top bar.</p>
              ) : mode === null ? (
                <p className={`mt-4 text-[13px] leading-relaxed ${TRACE}`}>{budget === null ? 'Enter what the job is worth.' : planError ? 'Waiting for the gateway…' : 'Choosing the route…'}</p>
              ) : mode === 'x402' ? (
                <>
                  <label className="mt-4 block">
                    <span className="mb-1.5 block text-[12px] font-medium tracking-[0.06em] text-[#8B8D96]">TEXT</span>
                    <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={2000} className={`${input} resize-y`} />
                  </label>
                  {capability === 'translate' && (
                    <label className="mt-3 block">
                      <span className="mb-1.5 block text-[12px] font-medium tracking-[0.06em] text-[#8B8D96]">TRANSLATE INTO</span>
                      <input value={language} onChange={(e) => setLanguage(e.target.value)} className={input} />
                    </label>
                  )}
                  {!isConnected || !address ? (
                    <p className="mt-4 rounded-xl border border-white/[0.06] bg-[#0D0F14] px-3 py-2.5 text-[12.5px] text-[#8B8D96]">Connect your wallet from the top bar to pay.</p>
                  ) : (
                    <button
                      type="button"
                      onClick={payAndRun}
                      disabled={paying || !briefReady || !txSigner}
                      className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#5B5FEF] py-2.5 text-[13.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {paying ? 'Approve the payment in your wallet…' : <>Pay {perCall} and run <ArrowRightIcon className="h-3.5 w-3.5" /></>}
                    </button>
                  )}
                  {payError && <p className="mt-3 text-[12px] leading-relaxed text-[#EF4444]">{payError}</p>}
                  {paid && (
                    <div className="mt-4 space-y-3 rounded-xl border border-[#22C55E]/30 bg-[#22C55E]/[0.06] p-3.5">
                      <div className="text-[12.5px] font-medium text-[#4ADE80]">{paid.replayed ? 'Already paid for this request: the stored answer' : 'Paid and delivered'}</div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#08090D] p-3 text-[12px] leading-relaxed text-[#E5E7EB]">{JSON.stringify(paid.result, null, 2)}</pre>
                      {paid.receipt ? (
                        <a href={explorerTxUrl(paid.receipt.transaction)} target="_blank" rel="noreferrer" className="block break-all font-mono text-[11.5px] text-[#8FA9FF] hover:underline">
                          Settlement receipt: {paid.receipt.transaction}
                        </a>
                      ) : (
                        <span className={`block text-[11.5px] ${TRACE}`}>No receipt came back with this answer.</span>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="mt-4 space-y-3">
                  {plan && plan.escrow.sellers.length > 0 ? (
                    plan.escrow.sellers.map((s) => (
                      <Link key={s.id} href={`/app/agents/${s.id}`} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#0B0C11] px-3.5 py-3 transition hover:border-[#5B5FEF]/50">
                        <span className="min-w-0">
                          <span className="block truncate text-[13.5px] text-[#F5F5F7]">{s.name}</span>
                          <span className={`text-[12px] ${s.isOnline ? 'text-[#4ADE80]' : TRACE}`}>{s.isOnline ? 'Online' : 'Offline'} · {s.price.toFixed(2)} USDC</span>
                        </span>
                        <ArrowRightIcon className="h-3.5 w-3.5 shrink-0 text-[#8B8D96]" />
                      </Link>
                    ))
                  ) : (
                    <p className={`text-[13px] leading-relaxed ${TRACE}`}>{plan?.notes.at(-1) ?? 'No seller lists this right now.'}</p>
                  )}
                  <p className={`text-[12px] leading-relaxed ${TRACE}`}>Open a seller to write the brief and lock the payment in escrow.</p>
                </div>
              )}
            </NeumorphicCard>
          </div>
        </div>
      </div>
    </PageFade>
  )
}
