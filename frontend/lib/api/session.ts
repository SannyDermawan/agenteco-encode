import { getAddress } from 'viem'
import { createSiweMessage, generateSiweNonce } from 'viem/siwe'
import { READ_SESSION_HEADER, READ_SESSION_MAX_AGE_MS, READ_SESSION_STATEMENT, createSolanaSessionMessage } from '@shared/session'
import { normalizeWallet, walletFamily } from '@shared/wallets'
import { appChain } from '../web3/chain'
import { CHAIN_KEY } from '../web3/network'
import type { WalletSigner } from './authHeaders'

/**
 * Read session for the connected wallet: one free Sign-In with Ethereum
 * signature (for a Solana wallet, the same session as CAIP-122 text signed with ed25519), kept for up to 24 h, sent with every request for the wallet's
 * own data (see backend/src/session.ts). Kept per address in localStorage so
 * a reload or a new tab doesn't ask again.
 */

interface StoredSession {
  header: string
  expiresAt: number
}

// Ask again a little before expiry rather than fail mid-page.
const RENEW_MARGIN_MS = 5 * 60 * 1000
// Stored per wallet in its stored form: EVM lowercase, Solana exactly as given (base58 is case-sensitive).
const storageKey = (address: string) => `agenteco.readSession.${normalizeWallet(address)}`

let activeAddress: string | null = null
const listeners = new Set<() => void>()
let version = 0

function notify() {
  version++
  for (const listener of listeners) listener()
}

// Also kept in memory, for browsers that block localStorage (private mode).
const memory = new Map<string, StoredSession>()

function load(address: string): StoredSession | null {
  let stored = memory.get(normalizeWallet(address)) ?? null
  if (!stored) {
    try {
      const raw = window.localStorage.getItem(storageKey(address))
      if (raw) stored = JSON.parse(raw) as StoredSession
    } catch {
      stored = null
    }
  }
  if (!stored || typeof stored.header !== 'string' || typeof stored.expiresAt !== 'number') return null
  return stored.expiresAt - RENEW_MARGIN_MS > Date.now() ? stored : null
}

function save(address: string, session: StoredSession) {
  memory.set(normalizeWallet(address), session)
  try {
    window.localStorage.setItem(storageKey(address), JSON.stringify(session))
  } catch {
    // Private mode: the in-memory copy lasts for this tab.
  }
}

/** Called by SessionSync whenever the connected wallet changes. */
export function setActiveAddress(address: string | null) {
  const next = address ? normalizeWallet(address) : null
  if (next === activeAddress) return
  activeAddress = next
  lastError = null // a rejection by the previous wallet says nothing about this one
  notify()
}

export function hasReadSession(address: string | null | undefined): boolean {
  if (!address || typeof window === 'undefined') return false
  return load(address) !== null
}

/** Headers for a read of the connected wallet's own data — empty when not signed in (or on the server). */
export function readHeaders(): Record<string, string> {
  if (!activeAddress || typeof window === 'undefined') return {}
  const stored = load(activeAddress)
  return stored ? { [READ_SESSION_HEADER]: stored.header } : {}
}

/** The API refused the session (expired, or signed for something else): forget it so the sign-in prompt returns. */
export function dropReadSession() {
  if (!activeAddress) return
  memory.delete(activeAddress)
  try {
    window.localStorage.removeItem(storageKey(activeAddress))
  } catch {
    // Storage unavailable — nothing was kept anyway.
  }
  notify()
}

let pending: Promise<void> | null = null
let lastError: string | null = null

/** A sign-in prompt is open in the wallet right now. */
export function isSigningIn(): boolean {
  return pending !== null
}

/** Why the last sign-in didn't complete (rejected, closed…), or null. */
export function lastSignInError(): string | null {
  return lastError
}

/**
 * Asks the wallet for the sign-in signature (free, no transaction). One
 * prompt at a time: a second call while one is open waits for the same one.
 */
export function signInForReads(signer: WalletSigner): Promise<void> {
  pending ??= (async () => {
    lastError = null
    notify()
    try {
      await requestSignature(signer)
    } catch (error) {
      lastError = error instanceof Error ? error.message.split('\n')[0] : 'Signature was not completed.'
      throw error
    } finally {
      pending = null
      notify()
    }
  })()
  return pending
}

/** 16 random letters and digits (the nonce of a Solana session message). */
function solanaNonce(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => alphabet[b % alphabet.length]).join('')
}

async function requestSignature(signer: WalletSigner): Promise<void> {
  const issuedAt = new Date()
  const expirationTime = new Date(issuedAt.getTime() + READ_SESSION_MAX_AGE_MS)
  if (walletFamily(signer.address) === 'solana') {
    const message = createSolanaSessionMessage({
      domain: window.location.host,
      address: signer.address,
      statement: READ_SESSION_STATEMENT,
      uri: window.location.origin,
      chainId: CHAIN_KEY,
      nonce: solanaNonce(),
      issuedAt,
      expirationTime,
    })
    const signature = await signer.signMessageAsync({ message })
    save(signer.address, { header: btoa(JSON.stringify({ family: 'solana', message, signature })), expiresAt: expirationTime.getTime() })
    return
  }
  const message = createSiweMessage({
    domain: window.location.host,
    address: getAddress(signer.address),
    statement: READ_SESSION_STATEMENT,
    uri: window.location.origin,
    version: '1',
    chainId: appChain.id,
    nonce: generateSiweNonce(),
    issuedAt,
    expirationTime,
  })
  const signature = await signer.signMessageAsync({ message })
  const header = btoa(JSON.stringify({ message, signature }))
  save(signer.address, { header, expiresAt: expirationTime.getTime() })
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Changes whenever the session or the active wallet does (for useSyncExternalStore). */
export function sessionVersion(): number {
  return version
}

/** Thrown by reads the API refused because the viewer is not a party to the order. */
export class PrivateOrderError extends Error {
  constructor(message = 'This order is private — only its buyer, seller and the arbiter can see it.') {
    super(message)
    this.name = 'PrivateOrderError'
  }
}

/**
 * Shared handling for private reads: 401 drops a stale session (the gate asks
 * to sign in again), 403 becomes a PrivateOrderError.
 */
export async function checkReadAccess(res: Response): Promise<void> {
  if (res.status === 401) {
    dropReadSession()
    throw new Error('Sign in again to view this.')
  }
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new PrivateOrderError(body?.error)
  }
}
