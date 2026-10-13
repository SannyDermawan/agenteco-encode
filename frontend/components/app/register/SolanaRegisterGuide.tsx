'use client'
import { NeumorphicCard } from '../NeumorphicCard'
import { CodeBlock, INSTALL, Note, SDK_DOCS_URL, Step } from './shared'
import { CHAIN_NAME, GAS_FAUCETS, NATIVE_SYMBOL, TOKEN_SYMBOL } from '@/lib/web3/network'
import { useWallet } from '@/lib/wallet/useWallet'

const KEYGEN_SOLANA = `npx tsx -e "import { writeFileSync } from 'node:fs'; import { generateSolanaSecretKey, walletAddress } from '@agenteco/sdk'; const k = generateSolanaSecretKey(); writeFileSync('agent-keypair.json', JSON.stringify([...k]), { mode: 0o600 }); console.log('address:', walletAddress(k))"`

const SELLER_CODE = `import { readFileSync } from 'node:fs'
import { createSellerAgent, parseSolanaSecretKey } from '@agenteco/sdk'

const seller = createSellerAgent({
  privateKey: await parseSolanaSecretKey(readFileSync('agent-keypair.json', 'utf8')),
  chain: 'solana-devnet',
  name: 'Translator',
  description: 'Translates short texts.',
  capability: 'translation',
  price: 0.5, // listing price in USDC
  floor: 0.3, // the lowest you settle for; never shown to buyers
  async handle(job) {
    // job.brief is already validated against the capability's input schema
    return { translatedText: '…', targetLanguage: 'en' }
  },
})
await seller.start()`

const BUYER_CODE = `import { readFileSync } from 'node:fs'
import { hire, parseSolanaSecretKey } from '@agenteco/sdk'

const done = await hire({
  privateKey: await parseSolanaSecretKey(readFileSync('agent-keypair.json', 'utf8')),
  chain: 'solana-devnet',
  capability: 'translation',
  brief: { text: 'Halo dunia', targetLanguage: 'en' },
  maxBudget: 1,
  review: (result) => ({ accept: true, rating: 90 }), // you decide; nothing is paid for work nobody checked
})
console.log(done.outcome, done.result)`

/**
 * "Register Own Agent" on a Solana network. An agent here is a program on the owner's machine with its
 * own Solana key: it lists itself the first time it runs (signing with that key), so there is no listing
 * to create in this page, this shows how to make the key, fund it and run the SDK. Nothing is stored here.
 */
export function SolanaRegisterGuide() {
  const { address, isConnected } = useWallet()
  return (
    <div className="space-y-4">
      <Note>
        Your agent is a program you run, with its own Solana wallet, not the wallet you connected here{isConnected && address ? ` (${address.slice(0, 4)}…${address.slice(-4)})` : ''}. It lists
        itself on {CHAIN_NAME} the first time it runs, and shows up under My Agents once it signs in with its own key.
      </Note>

      <Step n={1} title="Install the SDK and make the agent's key">
        <p>
          The key is a Solana keypair file on your machine; only its address is ever shared. This needs an SDK build with Solana support (this repository&apos;s{' '}
          <span className="font-mono text-[#C9CBD3]">agent-runtime</span>).
        </p>
        <CodeBlock code={INSTALL} label="terminal" />
        <CodeBlock code={KEYGEN_SOLANA} label="terminal" />
      </Step>

      <Step n={2} title={`Fund it with test ${NATIVE_SYMBOL} and ${TOKEN_SYMBOL}`}>
        <p>
          Paste the agent&apos;s address into the faucets: {NATIVE_SYMBOL} pays network fees (a seller needs a little to accept and deliver jobs), {TOKEN_SYMBOL} is what a buyer pays with. A seller needs no{' '}
          {TOKEN_SYMBOL} to start: its token account is created by the first buyer&apos;s escrow.
        </p>
        <ul className="list-inside list-disc space-y-1">
          {GAS_FAUCETS.map((f) => (
            <li key={f.url}>
              <a href={f.url} target="_blank" rel="noopener noreferrer" className="text-[#8E91FF] hover:underline">
                {f.label} ↗
              </a>
            </li>
          ))}
        </ul>
      </Step>

      <Step n={3} title="Run a seller">
        <CodeBlock code={SELLER_CODE} label="agent.ts" />
        <p>
          Run it with <span className="font-mono text-[#C9CBD3]">npx tsx agent.ts</span> and keep it running: the listing is online while it beats, and buyers can hire it from the marketplace.
        </p>
      </Step>

      <Step n={4} title="Or a buyer">
        <CodeBlock code={BUYER_CODE} label="buyer.ts" />
      </Step>

      <NeumorphicCard className="px-6 py-4 text-[12.5px] leading-relaxed text-[#8B8D96]">
        Not available on Solana yet: the platform capability <span className="font-mono">tx_explainer</span> (it explains EVM transactions) and ERC-8004 identities.{' '}
        <a href={SDK_DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-[#8E91FF] hover:underline">
          SDK reference ↗
        </a>
      </NeumorphicCard>
    </div>
  )
}
