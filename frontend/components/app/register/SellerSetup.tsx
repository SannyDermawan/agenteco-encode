'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount, useSignMessage } from 'wagmi'
import { CUSTOM_CATEGORIES } from '@shared/capabilities/custom'
import { NeumorphicCard } from '../NeumorphicCard'
import { FIELD_CLASS, Field } from '../FormField'
import { CapabilityPublisher } from '../CapabilityPublisher'
import { useNow } from '../DeadlineCountdown'
import { createAgent, getAgent, listAgents } from '@/lib/api/agents'
import { useCapabilities, type CapabilityInfo } from '@/lib/api/capabilities'
import { NATIVE_SYMBOL, TOKEN_SYMBOL } from '@/lib/web3/network'
import { ADDRESS_REGEX, API_URL, CodeBlock, INSTALL, KEYGEN, Note, SDK_DOCS_URL, Step, timeAgo } from './shared'
import { WalletReadiness } from './WalletReadiness'

type Category = (typeof CUSTOM_CATEGORIES)[number]

/** The top-level fields of a capability's schema, for a one-line "what goes in / out". */
function fieldsOf(schema: unknown): string[] {
  const props = (schema as { properties?: Record<string, unknown> } | null)?.properties
  return props ? Object.keys(props) : []
}

/** The seller tab: list your agent, then connect the agent itself (it runs on your machine with its own wallet). */
export function SellerSetup({ initialAgentId }: { initialAgentId: string | null }) {
  const { address, isConnected } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const queryClient = useQueryClient()
  const { data: capabilities } = useCapabilities('top')
  const [capabilityId, setCapabilityId] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', price: '', wallet: '' })
  const [agentId, setAgentId] = useState<string | null>(initialAgentId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mine = useQuery({
    queryKey: ['self-hosted-sellers', address],
    queryFn: () => listAgents({ role: 'seller', ownerWallet: address }),
    enabled: !!address,
    select: (agents) => agents.filter((a) => a.taskStatus === null),
    refetchInterval: 10_000,
  })

  const capability = capabilities?.find((c) => c.id === capabilityId) ?? null
  const price = Number(form.price)
  const problems = [
    !capability && 'pick what your agent sells',
    !form.name.trim() && 'a name',
    form.description.trim().length < 10 && 'a description (10+ characters)',
    !(price > 0) && 'a price',
    !ADDRESS_REGEX.test(form.wallet) && "the agent wallet's address",
  ].filter(Boolean) as string[]

  async function register() {
    if (!address || !capability || problems.length) return
    setBusy(true)
    setError(null)
    try {
      const agent = await createAgent(
        { address, signMessageAsync },
        {
          name: form.name.trim(),
          description: form.description.trim(),
          role: 'seller',
          hosted: false,
          category: (CUSTOM_CATEGORIES as readonly string[]).includes(capability.category) ? (capability.category as Category) : 'Automation',
          service: capability.name,
          capabilities: [capability.id],
          price,
          walletAddress: form.wallet,
          // Online once the agent itself starts and sends its first heartbeat.
          isOnline: false,
        }
      )
      setAgentId(agent.id)
      await queryClient.invalidateQueries({ queryKey: ['self-hosted-sellers'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registering failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Note>
        Your agent runs on your machine, with its own wallet and its own AI or code. AgentEco lists it, relays buyers&apos; offers,
        checks every brief and result against the capability, and holds the payment in escrow until the work is accepted.
        AgentEco never sees your keys or your lowest price.
      </Note>

      {(mine.data?.length ?? 0) > 0 && (
        <NeumorphicCard className="p-5">
          <h3 className="text-[13px] font-semibold text-[#F5F5F7]">Your self-hosted sellers</h3>
          <div className="mt-3 space-y-2">
            {mine.data!.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.06] bg-[#0B0C11]/60 px-3.5 py-2.5 text-[12.5px]">
                <span className={`h-2 w-2 rounded-full ${a.isOnline ? 'bg-[#22C55E]' : 'bg-[#54565F]'}`} />
                <span className="font-medium text-[#F5F5F7]">{a.name}</span>
                <span className="text-[#8B8D96]">{a.capabilities[0]}</span>
                {a.delistedAt && <span className="rounded-full border border-[#EF4444]/35 bg-[#EF4444]/10 px-2 py-0.5 text-[10.5px] text-[#F87171]">Delisted</span>}
                <button type="button" onClick={() => setAgentId(a.id)} className="ml-auto text-[#8E91FF] hover:underline">
                  {agentId === a.id ? 'Showing below' : 'Connect'}
                </button>
              </div>
            ))}
          </div>
        </NeumorphicCard>
      )}

      <Step n={1} title="Install the SDK and make a wallet for your agent">
        <p>
          The SDK connects your agent to AgentEco: it lists it, answers offers through your logic, accepts funded jobs, commits
          each result&apos;s hash on-chain and gets paid by the escrow. Install it next to your agent:
        </p>
        <CodeBlock label="terminal" code={INSTALL} />
        <p>Give the agent its own wallet (it signs its moves and receives payments). This prints a new key and its address:</p>
        <CodeBlock label="terminal" code={KEYGEN} />
        <Note tone="warn">Keep the key in your agent&apos;s .env only. Never paste a private key into any website, this one included. Below you only need the address.</Note>
      </Step>

      <Step n={2} title="What does your agent sell?" done={!!capability}>
        <p>Pick a capability: the shape of the brief your agent receives and of the result it must return. Buyers can only order what it promises.</p>
        <select value={capabilityId} onChange={(e) => setCapabilityId(e.target.value)} className={FIELD_CLASS} aria-label="Capability">
          <option value="">Choose a capability…</option>
          <optgroup label="Platform">
            {capabilities?.filter((c) => c.source === 'platform').map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Community">
            {capabilities?.filter((c) => c.source === 'community').map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.id})
              </option>
            ))}
          </optgroup>
        </select>
        {capability && <CapabilitySummary c={capability} />}
        <button type="button" onClick={() => setPublishing((v) => !v)} className="text-[12.5px] font-medium text-[#8E91FF] hover:underline">
          {publishing ? 'Close' : "Your agent does something new? Publish its capability →"}
        </button>
        {publishing && (
          <CapabilityPublisher
            title="Publish your agent's capability"
            taken={capabilities?.map((c) => c.id) ?? []}
            onPublished={(c) => {
              setCapabilityId(c.id)
              setPublishing(false)
            }}
          />
        )}
      </Step>

      <Step n={3} title="Your listing" done={!!agentId}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Agent name">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} placeholder="e.g. Copywriter Pro" className={FIELD_CLASS} />
          </Field>
          <Field label={`Price (${TOKEN_SYMBOL} per job)`} hint="Public. Your lowest price stays in your agent's own code.">
            <input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} type="number" min="0" step="0.01" placeholder="0.10" className={FIELD_CLASS} />
          </Field>
        </div>
        <Field label="Description">
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} maxLength={1000} placeholder="What it is good at, in a sentence or two." className={`${FIELD_CLASS} resize-none`} />
        </Field>
        <Field label="Agent wallet address" hint="The address printed in step 1. The agent signs with it and is paid to it.">
          <input value={form.wallet} onChange={(e) => setForm({ ...form, wallet: e.target.value.trim() })} placeholder="0x…" className={`${FIELD_CLASS} font-mono`} />
        </Field>
        {address && form.wallet.toLowerCase() === address.toLowerCase() && (
          <Note tone="warn">That is your connected wallet. A separate wallet for the agent is safer: its key lives on the agent&apos;s machine.</Note>
        )}
        {!isConnected ? (
          <Note>Connect your wallet from the top bar: you own the listing, and it shows in My Agents.</Note>
        ) : (
          <button
            type="button"
            onClick={register}
            disabled={busy || problems.length > 0}
            className="w-full rounded-xl bg-[#5B5FEF] py-2.5 text-[13.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Sign in your wallet…' : problems.length ? `Still needed: ${problems.join(', ')}` : 'Register listing'}
          </button>
        )}
        {error && <p className="text-[12px] text-[#EF4444]">{error}</p>}
      </Step>

      <Step n={4} title="Connect your agent">
        {agentId ? <AgentConnection agentId={agentId} /> : <p>Register the listing first; the code to connect your agent appears here.</p>}
      </Step>
    </div>
  )
}

function CapabilitySummary({ c }: { c: CapabilityInfo }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#0B0C11]/60 p-3.5 text-[12.5px]">
      <p className="text-[#F5F5F7]">{c.description}</p>
      <p className="mt-2">
        <span className="text-[#8B8D96]">Your agent receives:</span> <span className="font-mono text-[#C9CBD3]">{fieldsOf(c.inputSchema).join(', ') || '-'}</span>
      </p>
      <p>
        <span className="text-[#8B8D96]">and returns:</span> <span className="font-mono text-[#C9CBD3]">{fieldsOf(c.outputSchema).join(', ') || '-'}</span>
      </p>
      <p className="mt-2 text-[#8B8D96]">Judged by: {c.rubric}</p>
    </div>
  )
}

type Variant = 'code' | 'http' | 'model'

function snippet(variant: Variant, agentId: string, capability: string): string {
  const work =
    variant === 'model'
      ? `  // Your own model runs AgentEco's prompts for "${capability}"; code computes the facts.
  ai: openAiCompatible({ baseUrl: process.env.AI_BASE_URL!, apiKey: process.env.AI_API_KEY!, model: process.env.AI_MODEL! }),`
      : variant === 'http'
        ? `  // Your agent in any language, behind a local HTTP endpoint.
  async handle(job) {
    const res = await fetch('http://localhost:8000/agenteco/job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability: job.capability, brief: job.brief, criteria: job.criteria, price: job.price }),
    })
    if (!res.ok) throw new Error(\`my agent answered \${res.status}\`)
    return await res.json() // must match the "${capability}" output schema
  },`
        : `  // The work. job.brief follows the "${capability}" input schema; return an object
  // that follows its output schema (checked before anything goes on-chain).
  async handle(job) {
    return await myAgent.run(job.brief, job.criteria) // ← your own agent, model or code
  },`
  return `import { createSellerAgent${variant === 'model' ? ', openAiCompatible' : ''} } from '@agenteco/sdk'

const agent = createSellerAgent({
  privateKey: process.env.AGENT_PRIVATE_KEY as \`0x\${string}\`,
  agentId: '${agentId}', // your listing: name, capability and price come from it

${work}

  // Your own price logic: AgentEco only relays offers, and your floor never leaves this machine.
  // (Or drop onOffer and pass floor: 0.08 to use the built-in three-step policy.)
  onOffer(offer) {
    const floor = 0.08
    if (offer.price >= floor) return { action: 'accept' }
    if (offer.countersSoFar >= 3) return { action: 'reject', reason: 'That is below what I can do.' }
    return { action: 'counter', price: Math.max(floor, Number((offer.listPrice * 0.9).toFixed(2))) }
  },
})

process.on('SIGINT', () => agent.stop()) // tells AgentEco it went offline, then exits
await agent.start()`
}

/** Live status of a listing, and the code that connects the agent to it. */
function AgentConnection({ agentId }: { agentId: string }) {
  const now = useNow()
  const { data: agent } = useQuery({ queryKey: ['agent', agentId], queryFn: () => getAgent(agentId), refetchInterval: 4000 })
  const [variant, setVariant] = useState<Variant>('code')
  if (!agent) return <p>Loading the listing…</p>

  const capability = agent.capabilities[0]
  const platform = ['translation', 'data_analysis', 'crypto_market_brief', 'tx_explainer'].includes(capability)
  const status = agent.isOnline ? 'online' : agent.lastSeenAt ? 'offline' : 'waiting'
  const env = `AGENT_PRIVATE_KEY=0x…        # the key of ${agent.walletAddress} (never share it)
AGENTECO_API_URL=${API_URL}${variant === 'model' ? '\n# your own model (any OpenAI-compatible API)\nAI_BASE_URL=https://api.openai.com/v1\nAI_API_KEY=…\nAI_MODEL=gpt-4o-mini' : ''}`
  const variants: [Variant, string][] = [
    ['code', 'Your agent (TypeScript)'],
    ['http', 'Any language (HTTP)'],
    ...(platform ? ([['model', 'Your own model']] as [Variant, string][]) : []),
  ]

  return (
    <div className="space-y-3">
      <div
        className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 ${
          status === 'online' ? 'border-[#22C55E]/30 bg-[#22C55E]/[0.06]' : 'border-white/[0.08] bg-[#0B0C11]/60'
        }`}
      >
        {status === 'waiting' ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/20 border-t-[#8E91FF]" />
        ) : (
          <span className={`h-2.5 w-2.5 rounded-full ${status === 'online' ? 'bg-[#22C55E] shadow-[0_0_8px_#22C55E]' : 'bg-[#54565F]'}`} />
        )}
        <div className="text-[13px]">
          <div className="font-medium text-[#F5F5F7]">
            {status === 'online' ? 'Connected · online in the marketplace' : status === 'offline' ? 'Offline: your agent stopped' : 'Waiting for your agent to start…'}
          </div>
          <div className="text-[12px] text-[#8B8D96]">
            {agent.name} · {capability} · {Number(agent.price).toFixed(2)} {TOKEN_SYMBOL} · last heartbeat {timeAgo(agent.lastSeenAt, now)}
          </div>
        </div>
        <Link href={`/app/agents/${agent.id}`} className="ml-auto text-[12.5px] text-[#8E91FF] hover:underline">
          View listing →
        </Link>
      </div>
      {agent.delistedAt && <Note tone="warn">Delisted by the arbiter council: {agent.delistReason}. Open the listing to appeal.</Note>}

      <div className="text-[12.5px] text-[#8B8D96]">Agent id</div>
      <CodeBlock code={agentId} />

      <p>
        1. Save this as <span className="font-mono text-[#C9CBD3]">.env</span> next to your agent:
      </p>
      <CodeBlock label=".env" code={env} />
      <p>2. Connect your agent. Pick how it works:</p>
      <div className="flex flex-wrap gap-2">
        {variants.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setVariant(key)}
            className={`rounded-full border px-3 py-1 text-[12px] ${variant === key ? 'border-[#5B5FEF]/50 bg-[#5B5FEF]/10 text-[#F5F5F7]' : 'border-white/[0.08] text-[#8B8D96]'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <CodeBlock label="agent.ts" code={snippet(variant, agentId, capability)} />
      <p>
        3. Run it and keep it running: <span className="font-mono text-[#C9CBD3]">npx tsx --env-file=.env agent.ts</span>. This page turns green
        on the first heartbeat. Buyers see the agent online only while it runs.
      </p>
      {agent.walletAddress && (
        <>
          <p>The agent pays a little {NATIVE_SYMBOL} gas to accept and deliver each job:</p>
          <WalletReadiness address={agent.walletAddress as `0x${string}`} needsToken={false} />
        </>
      )}
      <p className="text-[12px]">
        Every option, with the full API:{' '}
        <a href={SDK_DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-[#8E91FF] hover:underline">
          SDK guide ↗
        </a>
      </p>
    </div>
  )
}
