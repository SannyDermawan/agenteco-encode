'use client'
import './polyfills'
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { getWallets } from '@wallet-standard/app'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import { StandardConnect, StandardDisconnect, StandardEvents } from '@wallet-standard/features'
import { SolanaSignMessage, SolanaSignTransaction } from '@solana/wallet-standard-features'
import { getBase58Decoder, getTransactionDecoder, getTransactionEncoder, type Address, type TransactionModifyingSigner } from '@runtime/chain/kit.ts'
import { SOLANA } from '@/lib/web3/network'
import type { WalletChoice, WalletSigner } from '@/lib/wallet/types'

/**
 * The visitor's Solana wallet, through wallet-standard: any wallet that registers itself with the page
 * (Phantom, Solflare, Backpack, …) is found, with no per-wallet adapter. It signs text for the API
 * (`signMessage`, ed25519 → base58) and transactions for the escrow program (`txSigner`, a kit
 * TransactionModifyingSigner the SolanaAdapter uses as it would a keypair).
 */

const STORAGE_KEY = 'agenteco.solanaWallet'

interface Found {
  wallet: Wallet
  choice: WalletChoice
}

interface SolanaWalletContextValue {
  choices: WalletChoice[]
  walletName: string | null
  address: string | null
  isConnecting: boolean
  error: string | null
  connect: (walletName?: string) => Promise<void>
  disconnect: () => Promise<void>
  /** Signs text for the API: `signMessageAsync` returns the signature in base58. */
  signer: WalletSigner | null
  /** Signs the escrow program's transactions. */
  txSigner: TransactionModifyingSigner | null
}

const SolanaWalletContext = createContext<SolanaWalletContextValue | null>(null)

const supports = (wallet: Wallet) =>
  StandardConnect in wallet.features && SolanaSignMessage in wallet.features && SolanaSignTransaction in wallet.features

// The wallets registered with this page, as an external store: wallets announce themselves before or
// after the page loads, and the list changes as extensions load or are removed.
const EMPTY: readonly Found[] = []
let walletList: readonly Found[] = EMPTY
const walletListeners = new Set<() => void>()
let watching = false

function readFound(): readonly Found[] {
  return getWallets()
    .get()
    .filter(supports)
    .map((wallet) => ({ wallet, choice: { name: wallet.name, icon: wallet.icon } }))
}

function watchWallets() {
  if (watching) return
  watching = true
  walletList = readFound()
  const refresh = () => {
    walletList = readFound()
    walletListeners.forEach((listener) => listener())
  }
  getWallets().on('register', refresh)
  getWallets().on('unregister', refresh)
}

function subscribeWallets(listener: () => void): () => void {
  watchWallets()
  walletListeners.add(listener)
  return () => walletListeners.delete(listener)
}

const walletsSnapshot = (): readonly Found[] => {
  watchWallets()
  return walletList
}

function rememberedWallet(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function remember(name: string | null) {
  try {
    if (name) window.localStorage.setItem(STORAGE_KEY, name)
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage blocked: the visitor picks the wallet again next time.
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : 'The wallet did not complete the request.'
}

/** A kit signer over a wallet-standard account: the wallet signs, and may adjust, each transaction. */
function transactionSigner(wallet: Wallet, account: WalletAccount, chain: string): TransactionModifyingSigner {
  const feature = wallet.features[SolanaSignTransaction] as {
    signTransaction(...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: `${string}:${string}` }[]): Promise<readonly { signedTransaction: Uint8Array }[]>
  }
  const encoder = getTransactionEncoder()
  const decoder = getTransactionDecoder()
  return {
    address: account.address as Address,
    async modifyAndSignTransactions(transactions) {
      const signed = []
      // One at a time: each is the wallet's own prompt, and a later one may depend on an earlier.
      for (const tx of transactions) {
        const [{ signedTransaction }] = await feature.signTransaction({ account, transaction: new Uint8Array(encoder.encode(tx)), chain: chain as `${string}:${string}` })
        const decoded = decoder.decode(signedTransaction)
        // kit wants the lifetime back on what the signer returns; the wire format does not carry it.
        signed.push(Object.freeze({ ...decoded, ...('lifetimeConstraint' in tx ? { lifetimeConstraint: tx.lifetimeConstraint } : {}) }))
      }
      return signed as never
    },
  }
}

const accountOf = (accounts: readonly WalletAccount[]) => accounts.find((a) => a.chains.some((c) => c.startsWith('solana:'))) ?? accounts[0]

export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const found = useSyncExternalStore(subscribeWallets, walletsSnapshot, () => EMPTY)
  const [active, setActive] = useState<{ wallet: Wallet; account: WalletAccount } | null>(null)
  const [isConnecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const triedRemembered = useRef(false)

  async function connectTo(wallet: Wallet, silent: boolean) {
    setConnecting(true)
    setError(null)
    try {
      const { accounts } = await (wallet.features[StandardConnect] as { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> }).connect({ silent })
      const account = accountOf(accounts)
      if (!account) throw new Error(`${wallet.name} did not share an account.`)
      setActive({ wallet, account })
      remember(wallet.name)
    } catch (e) {
      // A silent reconnect that the wallet declines is not an error to show.
      if (!silent) setError(message(e))
    } finally {
      setConnecting(false)
    }
  }

  async function connect(walletName?: string) {
    const target = walletName ? found.find((f) => f.choice.name === walletName) : found.length === 1 ? found[0] : undefined
    if (!target) {
      setError(found.length === 0 ? 'No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then reload.' : 'Pick a wallet.')
      return
    }
    await connectTo(target.wallet, false)
  }

  async function disconnect() {
    const current = active
    setActive(null)
    remember(null)
    try {
      await (current?.wallet.features[StandardDisconnect] as { disconnect(): Promise<void> } | undefined)?.disconnect()
    } catch {
      // The wallet was already gone: nothing left to disconnect.
    }
  }

  // Reconnect the wallet used last time, without a prompt, as soon as it has registered.
  useEffect(() => {
    if (triedRemembered.current || active || found.length === 0) return
    const name = rememberedWallet()
    const target = name ? found.find((f) => f.choice.name === name) : undefined
    if (!target) return
    triedRemembered.current = true
    // Not in the effect's own turn: connecting sets state, which is for callbacks, not effect bodies.
    queueMicrotask(() => {
      void connectTo(target.wallet, true)
    })
  }, [found, active])

  // The wallet can switch account or disconnect from its own UI.
  useEffect(() => {
    if (!active) return
    const events = active.wallet.features[StandardEvents] as { on(event: 'change', listener: (p: { accounts?: readonly WalletAccount[] }) => void): () => void } | undefined
    if (!events) return
    return events.on('change', ({ accounts }) => {
      if (!accounts) return
      const next = accountOf(accounts)
      setActive(next ? { wallet: active.wallet, account: next } : null)
    })
  }, [active])

  let signer: WalletSigner | null = null
  let txSigner: TransactionModifyingSigner | null = null
  if (active) {
    const feature = active.wallet.features[SolanaSignMessage] as {
      signMessage(...inputs: { account: WalletAccount; message: Uint8Array }[]): Promise<readonly { signature: Uint8Array }[]>
    }
    signer = {
      address: active.account.address,
      signMessageAsync: async ({ message: text }) => {
        const [{ signature }] = await feature.signMessage({ account: active.account, message: new TextEncoder().encode(text) })
        return getBase58Decoder().decode(signature)
      },
    }
    if (SOLANA) txSigner = transactionSigner(active.wallet, active.account, SOLANA.walletChain)
  }

  const value: SolanaWalletContextValue = {
    choices: found.map((f) => f.choice),
    walletName: active?.wallet.name ?? null,
    address: active?.account.address ?? null,
    isConnecting,
    error,
    connect,
    disconnect,
    signer,
    txSigner,
  }
  return <SolanaWalletContext.Provider value={value}>{children}</SolanaWalletContext.Provider>
}

export function useSolanaWalletContext(): SolanaWalletContextValue {
  const value = useContext(SolanaWalletContext)
  if (!value) throw new Error('useSolanaWalletContext needs the SolanaWalletProvider (app/app/layout.tsx).')
  return value
}
