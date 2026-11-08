// Makes a Solana key for the seller and writes it to seller-agent/.env (git-ignored). It prints ONLY the public address,
// never the secret, and refuses to overwrite a key that is already there.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateSolanaSecretKey } from '../../agent-runtime/src/sdk/index.ts'
import { secretKeyToBase58, solanaAddressOfSecretKey } from '../../agent-runtime/src/chain/solana.ts'

const envPath = fileURLToPath(new URL('../.env', import.meta.url))
const current = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
if (/^WALLET_PRIVATE_KEY=.+/m.test(current)) {
  console.log('seller-agent/.env already has a WALLET_PRIVATE_KEY. Nothing changed.')
  process.exit(0)
}

const secret = generateSolanaSecretKey()
const line = `WALLET_PRIVATE_KEY=${secretKeyToBase58(secret)}`
const defaults = [
  'AGENTECO_API_URL=https://agenteco-multichain-production.up.railway.app',
  'CHAIN=solana-devnet',
  'AGENT_ECO_PROGRAM__solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1=3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE',
  'TOKEN_MINT__solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  'POLL_INTERVAL_MS=3000',
]
const kept = current.split(/\r?\n/).filter((l) => l && !/^WALLET_PRIVATE_KEY=/.test(l))
const missing = defaults.filter((d) => !kept.some((l) => l.startsWith(d.split('=')[0]! + '=')))
writeFileSync(envPath, [...kept, ...missing, line, ''].join('\n'), { mode: 0o600 })

console.log('Seller key written to seller-agent/.env (git-ignored).')
console.log(`Seller address (public): ${solanaAddressOfSecretKey(secret)}`)
console.log('Fund it with a little devnet SOL (https://faucet.solana.com). It does not need USDC to sell.')
