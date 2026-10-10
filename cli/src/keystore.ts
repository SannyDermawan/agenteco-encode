import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ensureDir, isReadableByOthers, readJson, restrictToUser } from './home.ts'

/**
 * The agent's key. Created here from the system's secure random source, stored in the person's
 * own directory with owner-only permissions, and handed to code that signs — never printed,
 * logged or sent. Only the address ever leaves this module's callers.
 *
 * The file is behind this interface so an OS-keychain backend can replace it (before any
 * mainnet use) without touching the commands.
 */
interface KeyFile {
  version: 1
  address: `0x${string}`
  privateKey: Hex
  createdAt: string
}

const keyPath = (home: string, name: string) => join(home, 'keys', `${name}.json`)

export function hasKey(home: string, name = 'default'): boolean {
  return existsSync(keyPath(home, name))
}

/** Creates a new key and returns its address. Refuses to overwrite an existing key. */
export function createKey(home: string, name = 'default'): `0x${string}` {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error('A key name is letters, digits, "-" and "_" (up to 40).')
  const path = keyPath(home, name)
  if (existsSync(path)) throw new Error(`A key named "${name}" already exists; it is never overwritten.`)
  ensureDir(join(home, 'keys'))
  const privateKey = generatePrivateKey()
  const address = privateKeyToAccount(privateKey).address
  const file: KeyFile = { version: 1, address, privateKey, createdAt: new Date().toISOString() }
  // 'wx': fails rather than replace; mode 0600 from the first byte.
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  restrictToUser(path)
  return address
}

/** The address of a stored key (safe to show). */
export function keyAddress(home: string, name = 'default'): `0x${string}` | null {
  return readJson<KeyFile>(keyPath(home, name))?.address ?? null
}

/** The key itself, for signing only. Refuses a key file other users can read. */
export function loadKey(home: string, name = 'default'): { address: `0x${string}`; privateKey: Hex } {
  const path = keyPath(home, name)
  const file = readJson<KeyFile>(path)
  if (!file?.privateKey) throw new Error(`No key named "${name}" in ${home}. Run \`agenteco init\` first.`)
  if (isReadableByOthers(path)) {
    throw new Error(`${path} can be read by other users. Run \`chmod 600 ${path}\` and try again.`)
  }
  if (privateKeyToAccount(file.privateKey).address !== file.address) throw new Error(`The key file ${path} is corrupt.`)
  return { address: file.address, privateKey: file.privateKey }
}
