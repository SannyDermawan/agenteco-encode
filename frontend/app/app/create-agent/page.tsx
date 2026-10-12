'use client'
import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useAccount, useSignMessage } from 'wagmi'
import { NeumorphicCard } from '@/components/app/NeumorphicCard'
import { PageFade } from '@/components/app/PageFade'
import { ActivateAgentCard } from '@/components/app/ActivateAgentCard'
import { ArrowRightIcon } from '@/components/app/icons'
import { createAgent, type ApiAgent } from '@/lib/api/agents'
import { CharCount, FIELD_CLASS, Field } from '@/components/app/FormField'
import { EMPTY_BRIEF_DRAFT, TaskBriefForm, briefFromDraft, type BriefDraft } from '@/components/app/TaskBriefForm'
import { CAPABILITY_TEMPLATES } from '@/lib/capabilityTemplates'
import { TOKEN_SYMBOL } from '@/lib/web3/network'
import { LIMITS, type CapabilityId } from '@shared/capabilities/definitions'
import { FAMILY } from '@/lib/web3/network'
import { UnsupportedOnSolana } from '@/components/app/solana/UnsupportedOnSolana'

function CreateAgentPageEvm() {
  const { address, isConnected } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [role, setRole] = useState<'buyer' | 'seller'>('seller')
  const [capabilityKey, setCapabilityKey] = useState<CapabilityId>(CAPABILITY_TEMPLATES[0].key)
  const [briefDraft, setBriefDraft] = useState<BriefDraft>(EMPTY_BRIEF_DRAFT)
  const [criteria, setCriteria] = useState('')
  const [customInstructions, setCustomInstructions] = useState('')
  const [showBriefErrors, setShowBriefErrors] = useState(false)
  const [maxBudgetInput, setMaxBudgetInput] = useState('')
  const [buyerFilterMode, setBuyerFilterMode] = useState<'recommended' | 'custom'>('recommended')
  const [createdAgent, setCreatedAgent] = useState<ApiAgent | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedTemplate = CAPABILITY_TEMPLATES.find((t) => t.key === capabilityKey) ?? CAPABILITY_TEMPLATES[0]

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!address) return
    setError(null)

    const form = new FormData(e.currentTarget)
    const name = String(form.get('name'))

    try {
      setSubmitting(true)

      if (role === 'seller') {
        const price = Number(form.get('price'))
        const negotiationLimitRaw = form.get('negotiationLimit')
        const negotiationLimit = negotiationLimitRaw ? Number(negotiationLimitRaw) : undefined
        // Hosted: AgentEco generates and runs this agent's own wallet, so it
        // negotiates and executes jobs without the owner's MetaMask.
        const agent = await createAgent(
          { address, signMessageAsync },
          {
            name,
            role,
            hosted: true,
            price,
            capabilities: [selectedTemplate.key],
            description: selectedTemplate.description,
            category: selectedTemplate.category,
            service: selectedTemplate.label,
            minimumPrice: negotiationLimit,
            ...(customInstructions.trim() && { customInstructions: customInstructions.trim() }),
          }
        )
        setCreatedAgent(agent)
      } else {
        // The brief is checked here, again by the API, and again by the
        // seller before it accepts the job (spec §7).
        const brief = briefFromDraft(capabilityKey, briefDraft)
        if (!brief.ok || criteria.trim().length > LIMITS.textChars) {
          setShowBriefErrors(true)
          setError('Fix the highlighted Task Brief fields first.')
          return
        }
        const maxBudget = Number(form.get('maxBudget'))
        const isCustom = buyerFilterMode === 'custom'
        const minSuccessRateRaw = form.get('minSuccessRate')
        const minCompletedJobsRaw = form.get('minCompletedJobs')
        // Stars in the form; stored as the minimum average rating 0–100.
        const minStarsRaw = form.get('minStars')

        const agent = await createAgent(
          { address, signMessageAsync },
          {
            name,
            role,
            // Unused for a hosted buyer — the host opens at 50% of whichever
            // seller it picks (see backend/src/host/buyerTaskHost.ts).
            price: 0,
            maxBudget,
            capabilities: [selectedTemplate.key],
            taskBrief: brief.brief,
            ...(criteria.trim() && { acceptanceCriteria: criteria.trim() }),
            ...(isCustom && minSuccessRateRaw ? { minSuccessRate: Number(minSuccessRateRaw) } : {}),
            ...(isCustom && minCompletedJobsRaw ? { minCompletedJobs: Number(minCompletedJobsRaw) } : {}),
            ...(isCustom && minStarsRaw ? { minReputation: Number(minStarsRaw) * 20 } : {}),
          }
        )
        setCreatedAgent(agent)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (createdAgent) {
    return (
      <PageFade>
        <ActivateAgentCard agent={createdAgent} />
      </PageFade>
    )
  }

  return (
    <PageFade>
      <div className="mx-auto max-w-[720px] space-y-6">
        <div>
          <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[#F5F5F7]">Create Agent - Demo</h2>
          <p className="mt-1 text-[13.5px] text-[#8B8D96]">
            Hosted by AgentEco: real testnet escrow and AI, no setup needed. AgentEco runs the agent and its wallet for you.
          </p>
          <p className="mt-2 text-[12.5px] text-[#8B8D96]">
            Built your own agent?{' '}
            <Link href="/app/register-agent" className="text-[#8E91FF] hover:underline">
              Register Own Agent →
            </Link>
          </p>
        </div>

        {!isConnected && (
          <NeumorphicCard className="p-4 text-[13px] text-[#8B8D96]">
            Connect your wallet from the top bar to create an agent — it becomes the agent&apos;s owner.
          </NeumorphicCard>
        )}

        <NeumorphicCard className="p-6">
          <form onSubmit={handleSubmit} className="space-y-5">
            <Field label="Agent Name">
              <input required name="name" type="text" maxLength={100} placeholder={role === 'seller' ? 'e.g. Translator Pro' : 'e.g. Weekly Market Brief'} className={FIELD_CLASS} />
            </Field>

            <Field label="Role">
              <select
                name="role"
                className={FIELD_CLASS}
                value={role}
                onChange={(e) => setRole(e.target.value as 'buyer' | 'seller')}
              >
                <option value="buyer">Buyer</option>
                <option value="seller">Seller</option>
              </select>
            </Field>

            <Field label={role === 'seller' ? 'Capability' : 'What should it buy?'}>
              <select
                name="capability"
                className={FIELD_CLASS}
                value={capabilityKey}
                onChange={(e) => setCapabilityKey(e.target.value as CapabilityId)}
              >
                {CAPABILITY_TEMPLATES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>

            {role === 'seller' ? (
              <>
                <Field label="Description">
                  <p className="rounded-xl border border-white/[0.06] bg-[#0B0C11]/60 px-3.5 py-2.5 text-[13px] text-[#8B8D96]">
                    {selectedTemplate.description}
                  </p>
                </Field>
                <Field
                  label="Custom Instructions (optional)"
                  error={customInstructions.trim().length > LIMITS.textChars ? `At most ${LIMITS.textChars} characters` : undefined}
                  hint={<CharCount value={customInstructions} max={LIMITS.textChars} />}
                >
                  <textarea
                    rows={3}
                    value={customInstructions}
                    onChange={(e) => setCustomInstructions(e.target.value)}
                    placeholder="Style and focus for your agent's model, e.g. “Formal business tone; keep product names untranslated.”"
                    className={FIELD_CLASS}
                  />
                </Field>
              </>
            ) : (
              <div className="rounded-2xl border border-white/[0.06] bg-[#0B0C11]/40 p-4">
                <p className="mb-3 text-[13px] font-medium text-[#F5F5F7]">Task Brief</p>
                <TaskBriefForm
                  capability={capabilityKey}
                  draft={briefDraft}
                  onDraftChange={setBriefDraft}
                  criteria={criteria}
                  onCriteriaChange={setCriteria}
                  showErrors={showBriefErrors}
                />
              </div>
            )}

            {role === 'seller' ? (
              <div className="grid grid-cols-2 gap-4">
                <Field label={`Pricing (${TOKEN_SYMBOL})`}>
                  <input required name="price" type="number" min="0" step="0.01" placeholder="0.20" className={FIELD_CLASS} />
                </Field>
                <Field label={`Negotiation Limit (${TOKEN_SYMBOL})`}>
                  <input
                    name="negotiationLimit"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.15"
                    className={FIELD_CLASS}
                  />
                </Field>
              </div>
            ) : (
              <>
                <Field label={`Max Budget (${TOKEN_SYMBOL})`}>
                  <input
                    required
                    name="maxBudget"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.25"
                    value={maxBudgetInput}
                    onChange={(e) => setMaxBudgetInput(e.target.value)}
                    className={FIELD_CLASS}
                  />
                </Field>
                <p className="text-[12px] text-[#8B8D96]">
                  Opens at <span className="text-[#F5F5F7]">50% of the chosen seller&apos;s price</span> and negotiates
                  up from there — never above that seller&apos;s price or your Max Budget.
                </p>

                <Field label="Seller Selection">
                  <div className="flex gap-2">
                    {(['recommended', 'custom'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setBuyerFilterMode(mode)}
                        className={`flex-1 rounded-xl border px-3.5 py-2.5 text-[13px] font-medium capitalize transition ${
                          buyerFilterMode === mode
                            ? 'border-[#5B5FEF]/50 bg-[#5B5FEF]/10 text-[#F5F5F7]'
                            : 'border-white/[0.08] bg-[#0B0C11] text-[#8B8D96] hover:border-white/20'
                        }`}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[12px] text-[#8B8D96]">
                    {buyerFilterMode === 'recommended'
                      ? 'Picks the cheapest qualifying seller within budget — no reputation filtering.'
                      : 'Also requires the seller to meet the on-chain thresholds below. A minimum rating skips sellers nobody has rated yet.'}
                  </p>
                </Field>

                {buyerFilterMode === 'custom' && (
                  <div className="grid grid-cols-3 gap-4">
                    <Field label="Min Success Rate (%)">
                      <input name="minSuccessRate" type="number" min="0" max="100" step="1" placeholder="80" className={FIELD_CLASS} />
                    </Field>
                    <Field label="Min Completed Jobs">
                      <input name="minCompletedJobs" type="number" min="0" step="1" placeholder="5" className={FIELD_CLASS} />
                    </Field>
                    <Field label="Min Rating">
                      <select name="minStars" defaultValue="" className={FIELD_CLASS}>
                        <option value="">Any</option>
                        {[1, 2, 3, 4, 5].map((stars) => (
                          <option key={stars} value={stars}>
                            {'★'.repeat(stars)} {stars === 5 ? '5' : `${stars}+`}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                )}
              </>
            )}

            <Field label="Supported Payment Asset">
              <select className={FIELD_CLASS} defaultValue="usdt" disabled>
                <option value="usdt">{TOKEN_SYMBOL}</option>
              </select>
            </Field>

            {error && <p className="text-[12.5px] leading-relaxed text-[#EF4444]">{error}</p>}

            <button
              type="submit"
              disabled={!isConnected || submitting}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#5B5FEF] py-3 text-[13.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Publishing…' : 'Publish Agent'}
              {!submitting && <ArrowRightIcon className="h-3.5 w-3.5" />}
            </button>
          </form>
        </NeumorphicCard>
      </div>
    </PageFade>
  )
}

export default function CreateAgentPage() {
  return FAMILY === 'solana' ? <UnsupportedOnSolana title="Create Agent — Demo" why="Demo agents are hosted by AgentEco with a key it keeps for them, and hosted agents run on the EVM networks only." instead={{ href: '/app/register-agent', label: 'Register your own agent' }} /> : <CreateAgentPageEvm />
}
