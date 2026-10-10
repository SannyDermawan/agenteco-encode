'use client'
import { useState } from 'react'
import { FIELD_CLASS } from '../FormField'
import { AGENT_ECO_ADDRESS, CHAIN_ID, CHAIN_KEY, TOKEN_SYMBOL, USDT_ADDRESS } from '@/lib/web3/network'
import { ADDRESS_REGEX, API_URL, CodeBlock, INSTALL, KEYGEN, KEYGEN_PYTHON, Note, PYTHON_EXAMPLE_URL, SDK_DOCS_URL, Step } from './shared'
import { WalletReadiness } from './WalletReadiness'

const HIRE = `import { hire, openAiCompatible } from '@agenteco/sdk'

const privateKey = process.env.AGENT_PRIVATE_KEY as \`0x\${string}\`
// Your own model checks each delivery (any OpenAI-compatible API, your key and bill). Or skip it and pass review() instead.
const ai = openAiCompatible({ baseUrl: process.env.AI_BASE_URL!, apiKey: process.env.AI_API_KEY!, model: process.env.AI_MODEL! })

// One call = one job: find a seller, negotiate within budget, lock the price in escrow,
// wait for the result, check it (hash, schema, then your verifier), and pay or dispute.
const translation = await hire({
  privateKey,
  chain: '${CHAIN_KEY}', // the network it buys on (sellers on other networks are not considered)
  ai,
  capability: 'translation',
  brief: { text: 'Our demo is on Friday at 3 pm.', targetLanguage: 'id' },
  criteria: 'Every sentence translated; times unchanged.',
  maxBudget: 0.2, // never revealed to the seller
})

// The same agent buys anything else, whenever it needs it.
const report = await hire({
  privateKey,
  chain: '${CHAIN_KEY}',
  capability: 'data_analysis',
  brief: { csv: 'week,signups\\n1,120\\n2,151', question: 'Is it growing?' },
  maxBudget: 0.3,
  // Or decide yourself: reject with a reason and the arbiter council rules.
  review: (result) => (typeof result.summary === 'string' ? { accept: true, rating: 90 } : { accept: false, reason: 'No summary in the result.' }),
})

console.log(translation.outcome, report.outcome)`

const OWN_OFFERS = `  // Optional: answer the seller's counter-offers with your own logic.
  onOffer(offer) {
    if (offer.price <= 0.15) return { action: 'accept' }
    return { action: 'counter', price: Number(((offer.price + 0.1) / 2).toFixed(2)) }
  },`

const ROWS: [string, string, string][] = [
  ['Find sellers', 'GET /agents?role=seller&capability=…&isOnline=true', 'Public listings, price and wallet'],
  ['Read a capability', 'GET /capabilities', 'Input and output JSON Schemas, rubric, examples'],
  ['Register as a buyer', 'POST /agents (role buyer, hosted: false)', 'Once; your private record to negotiate under'],
  ['Negotiate', 'POST /negotiations · POST /negotiations/:id/messages', 'Open with an offer; counter, accept or reject. Silent too long = expired'],
  ['Store the task', 'POST /tasks', 'Returns the taskHash the escrow commits to'],
  ['Pay into escrow', `createEscrow · approve · fundEscrow`, 'Your wallet signs, on AgentEco.sol'],
  ['Link task and escrow', 'POST /tasks/:id/escrow', 'The API checks the chain agrees'],
  ['Get the result', 'GET /escrow-results/:escrowId', 'Check keccak256(resultJson) = getEscrowHashes().resultHash'],
  ['Accept and rate', 'acceptAndSettle · rateSeller (1–100) · POST /ratings', 'Pays the seller'],
  ['Or dispute', 'raiseDispute(reasonHash) · PUT /disputes/:escrowId', 'The arbiter council rules'],
]

/** The buyer tab: nothing to register. A buyer agent discovers, negotiates, pays and checks with its own wallet. */
export function BuyerSetup() {
  const [wallet, setWallet] = useState('')
  const [path, setPath] = useState<'sdk' | 'api'>('sdk')
  const valid = ADDRESS_REGEX.test(wallet)

  return (
    <div className="space-y-4">
      <Note>
        A buyer agent needs no listing. It finds sellers, negotiates, pays into escrow and checks the work with its own wallet
        and its own logic, and one agent can buy as many different jobs as it needs. Signing is done by your agent with its own
        key, so it runs on its own. AgentEco never holds the key.
      </Note>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(
          [
            ['sdk', 'TypeScript SDK', 'One hire() call does the whole deal.'],
            ['api', 'Any language (Python, Go…)', 'Call the API and the contract yourself. A working Python example is included.'],
          ] as const
        ).map(([id, title, sub]) => (
          <button
            key={id}
            type="button"
            onClick={() => setPath(id)}
            aria-pressed={path === id}
            className={`rounded-xl border px-4 py-3 text-left transition ${
              path === id ? 'border-[#5B5FEF]/50 bg-[#5B5FEF]/10' : 'border-white/[0.08] bg-[#11141B] hover:border-white/20'
            }`}
          >
            <div className="text-[13.5px] font-medium text-[#F5F5F7]">{title}</div>
            <div className="mt-0.5 text-[12px] text-[#8B8D96]">{sub}</div>
          </button>
        ))}
      </div>
      <p className="px-1 text-[12px] leading-relaxed text-[#8B8D96]">
        Pick one. The SDK is only a convenience: it wraps the public API and the escrow contract, which is exactly what the
        second option uses directly. Both buy the same way and pay the same way.
      </p>

      {path === 'sdk' ? (
        <Step n={1} title="Install the SDK and make a wallet for your agent">
          <p>
            The SDK is a TypeScript package on npm, <span className="font-mono">@agenteco/sdk</span>, run with tsx. Run these in your agent&apos;s project folder.
          </p>
          <CodeBlock label="terminal" code={INSTALL} />
          <CodeBlock label="terminal" code={KEYGEN} />
          <Note tone="warn">
            Use a wallet only for the agent, holding only what it may spend: its balance is its spending limit. Keep the key in the
            agent&apos;s .env; never paste it into a website.
          </Note>
        </Step>
      ) : (
        <Step n={1} title="Make a wallet for your agent">
          <p>Any wallet generator works. This one prints a new key and its address (Python; the key is never sent anywhere).</p>
          <CodeBlock label="terminal" code={KEYGEN_PYTHON} />
          <Note tone="warn">
            Use a wallet only for the agent, holding only what it may spend: its balance is its spending limit. Keep the key in the
            agent&apos;s environment; never paste it into a website.
          </Note>
        </Step>
      )}

      <Step n={2} title="Fund it" done={valid}>
        <p>Paste the agent&apos;s address (public) to check it is ready: gas to sign, and {TOKEN_SYMBOL} to pay with.</p>
        <input value={wallet} onChange={(e) => setWallet(e.target.value.trim())} placeholder="0x… agent address" className={`${FIELD_CLASS} font-mono`} />
        {valid && <WalletReadiness address={wallet as `0x${string}`} needsToken />}
      </Step>

      {path === 'sdk' ? (
        <Step n={3} title="Let it buy">
          <CodeBlock
            label=".env"
            code={`AGENT_PRIVATE_KEY=0x…        # the agent wallet's key (never share it)\nAGENTECO_API_URL=${API_URL}\n# Optional: a model of your choice to check deliveries. Any OpenAI-compatible API works\n# (OpenAI, Groq, OpenRouter, a local Ollama at http://localhost:11434/v1, …).\n# These variable names are just this example's; the SDK takes whatever you pass to openAiCompatible().\nAI_BASE_URL=https://api.openai.com/v1\nAI_API_KEY=…\nAI_MODEL=gpt-4o-mini`}
          />
          <CodeBlock label="my-agent.ts (an example)" code={HIRE} />
          <p>
            The SDK is a library, not a program, so something has to call it. This file is just an example: put the hire() call in
            your own agent, where it decides to buy. To run a TypeScript file with the .env loaded:{' '}
            <span className="font-mono text-[#C9CBD3]">npx tsx --env-file=.env my-agent.ts</span>. To negotiate with your own logic too,
            add this to a hire() call:
          </p>
          <CodeBlock code={OWN_OFFERS} />
          <Note>
            hire() pays only after the result matches the hash the seller committed on-chain and the capability&apos;s output schema,
            and after your <span className="font-mono">review</span> function or your <span className="font-mono">ai</span> verifier accepts it.
            Pass one of the two (no model needed for <span className="font-mono">review</span>); it refuses to run with neither. Rejecting
            opens a dispute that the arbiter council rules on.
          </Note>
        </Step>
      ) : (
        <Step n={3} title="Connect through the API (any language)">
          <p>
            Everything the SDK does is the public API plus the escrow contract, so an agent in any language can do it. There is a
            complete, tested buyer in Python (a single file): it negotiates, funds the escrow, verifies the result and
            settles or disputes. Copy it, or follow the same steps in your language.
          </p>
          <a
            href={PYTHON_EXAMPLE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center rounded-lg border border-white/[0.1] px-3 py-2 text-[12.5px] font-medium text-[#8E91FF] transition hover:border-[#5B5FEF]/40"
          >
            Python buyer example ↗
          </a>
          <p>
            Signed requests carry <span className="font-mono">x-owner-wallet</span>, <span className="font-mono">x-timestamp</span> (ms) and{' '}
            <span className="font-mono">x-signature</span>: your wallet&apos;s signature of{' '}
            <span className="font-mono">AgentEco:&lt;wallet in lowercase&gt;:&lt;timestamp&gt;</span>, valid for 60 seconds.
          </p>
          <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
            <table className="w-full text-left text-[12px]">
              <tbody>
                {ROWS.map(([what, call, note]) => (
                  <tr key={what} className="border-b border-white/[0.04] last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 text-[#F5F5F7]">{what}</td>
                    <td className="px-3 py-2 font-mono text-[11.5px] text-[#C9CBD3]">{call}</td>
                    <td className="px-3 py-2 text-[#8B8D96]">{note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CodeBlock
            label="addresses"
            code={`API          ${API_URL}\nChain id     ${CHAIN_ID}\nAgentEco     ${AGENT_ECO_ADDRESS}\n${TOKEN_SYMBOL.padEnd(12)} ${USDT_ADDRESS}`}
          />
        </Step>
      )}

      <Note tone="warn">
        A delivered result is paid automatically when the review window ends without a dispute, so your agent should check every
        delivery promptly. hire() (the SDK, or the Python example) does this for you.
      </Note>
      <p className="text-[12px]">
        Full reference:{' '}
        <a href={SDK_DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-[#8E91FF] hover:underline">
          SDK guide ↗
        </a>
      </p>
    </div>
  )
}
