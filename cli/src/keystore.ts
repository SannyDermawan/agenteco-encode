import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { generateSolanaSecretKey, secretKeyFromBase58, secretKeyToBase58, solanaAddressOfSecretKey } from '../../agent-runtime/src/chain/solana.ts'
import { ensureDir, isReadableByOthers, readJson, restrictToUser } from './home.ts'

/**
 * The agent's keys. Created here from the system's secure random source, stored in the person's
 * own directory with owner-only permissions, and handed to code that signs — never printed,
 * logged or sent. Only the address ever leaves this module's callers.
 *
 * An agent has one key per chain family — an EVM key (`keys/<name>.json`) and a Solana key
 * (`keys/<name>.solana.json`) — because the two families sign with different curves. Both are
 * created by `agenteco init` for the chain it is given.
 *
 * The files are behind this interface so an OS-keychain backend can replace them (before any
 * mainnet use) without touching the commands.
 */
export type KeyFamily = 'evm' | 'solana'

interface EvmKeyFile {
  version: 1
  address: `0x${string}`
  privateKey: Hex
  createdAt: string
}

interface SolanaKeyFile {
  version: 1
  family: 'solana'
  address: string
  /** The 64-byte secret key (seed, then public key) in base58, as Solana wallets export it. */
  secretKey: string
  createdAt: string
}

export interface EvmKey {
  family: 'evm'
  address: `0x${string}`
  privateKey: Hex
  /** Every form the key's secret takes when printed by mistake — registered so output can be scrubbed. */
  secrets: string[]
}

export interface SolanaKey {
  family: 'solana'
  address: string
  privateKey: Uint8Array
  secrets: string[]
}

export type AgentKey = EvmKey | SolanaKey

const NAME = /^[A-Za-z0-9_-]{1,40}$/
const keyPath = (home: string, name: string, family: KeyFamily = 'evm') => join(home, 'keys', family === 'evm' ? `${name}.json` : `${name}.solana.json`)

export function hasKey(home: string, name = 'default', family: KeyFamily = 'evm'): boolean {
  return existsSync(keyPath(home, name, family))
}

/** Where a key lives (for messages and permission checks). */
export function keyFile(home: string, name = 'default', family: KeyFamily = 'evm'): string {
  return keyPath(home, name, family)
}

/** Creates a new key and returns its address. Refuses to overwrite an existing key. */
export function createKey(home: string, name = 'default', family: KeyFamily = 'evm'): string {
  if (!NAME.test(name)) throw new Error('A key name is letters, digits, "-" and "_" (up to 40).')
  const path = keyPath(home, name, family)
  if (existsSync(path)) throw new Error(`A ${family === 'evm' ? '' : 'Solana '}key named "${name}" already exists; it is never overwritten.`)
  ensureDir(join(home, 'keys'))
  let address: string
  let file: EvmKeyFile | SolanaKeyFile
  if (family === 'evm') {
    const privateKey = generatePrivateKey()
    address = privateKeyToAccount(privateKey).address
    file = { version: 1, address: address as `0x${string}`, privateKey, createdAt: new Date().toISOString() }
  } else {
    const secret = generateSolanaSecretKey()
    address = solanaAddressOfSecretKey(secret)
    file = { version: 1, family: 'solana', address, secretKey: secretKeyToBase58(secret), createdAt: new Date().toISOString() }
  }
  // 'wx': fails rather than replace; mode 0600 from the first byte.
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  restrictToUser(path)
  return address
}

/** The address of a stored key (safe to show). */
export function keyAddress(home: string, name = 'default', family: KeyFamily = 'evm'): string | null {
  return readJson<{ address?: string }>(keyPath(home, name, family))?.address ?? null
}

/** The key itself, for signing only. Refuses a key file other users can read. */
export function loadKey(home: string, name?: string, family?: 'evm'): EvmKey
export function loadKey(home: string, name: string, family: 'solana'): SolanaKey
export function loadKey(home: string, name?: string, family?: KeyFamily): AgentKey
export function loadKey(home: string, name = 'default', family: KeyFamily = 'evm'): AgentKey {
  const path = keyPath(home, name, family)
  const file = readJson<Partial<EvmKeyFile & SolanaKeyFile>>(path) ?? {}
  const hint = family === 'evm' ? 'Run `agenteco init` first.' : 'Run `agenteco init --chain solana-devnet` first.'
  if (family === 'evm' ? !file.privateKey : !file.secretKey) throw new Error(`No ${family === 'evm' ? '' : 'Solana '}key named "${name}" in ${home}. ${hint}`)
  if (isReadableByOthers(path)) {
    throw new Error(`${path} can be read by other users. Run \`chmod 600 ${path}\` and try again.`)
  }
  if (family === 'evm') {
    if (privateKeyToAccount(file.privateKey!).address !== file.address) throw new Error(`The key file ${path} is corrupt.`)
    // The key without its 0x prefix is as secret as the key.
    return { family, address: file.address!, privateKey: file.privateKey!, secrets: [file.privateKey!, file.privateKey!.slice(2)] }
  }
  const secret = secretKeyFromBase58(file.secretKey!)
  if (secret.length !== 64 || solanaAddressOfSecretKey(secret) !== file.address) throw new Error(`The key file ${path} is corrupt.`)
  // The base58 text, and the JSON array a Solana CLI keypair file holds, are both the secret.
  return { family, address: file.address!, privateKey: secret, secrets: [file.secretKey!, JSON.stringify([...secret]), `[${[...secret].join(', ')}]`] }
}
