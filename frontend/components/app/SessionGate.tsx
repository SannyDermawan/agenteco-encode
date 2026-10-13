'use client'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { normalizeWallet } from '@shared/wallets'
import { useWallet } from '@/lib/wallet/useWallet'
import { NeumorphicCard } from '@/components/app/NeumorphicCard'
import {
  hasReadSession,
  isSigningIn,
  lastSignInError,
  sessionVersion,
  setActiveAddress,
  signInForReads,
  subscribeSession,
} from '@/lib/api/session'

// Automatic prompts per wallet per page load, a session the API keeps
// refusing must not turn into an endless stream of wallet popups.
const MAX_AUTO_PROMPTS = 2

/**
 * Keeps the session store pointed at the connected wallet, and asks for the
 * sign-in signature right after a wallet connects (or its session runs out),
 * so connecting and signing in feel like one step. After a rejection it waits
 * for the gate's "Try again". Mounted once in the app layout.
 */
export function SessionSync() {
  const { address, isConnected, signer } = useWallet()
  const prompts = useRef(new Map<string, number>())
  const version = useSyncExternalStore(subscribeSession, sessionVersion, () => 0)

  useEffect(() => {
    setActiveAddress(address ?? null)
  }, [address])

  useEffect(() => {
    if (!isConnected || !address || !signer) return
    if (hasReadSession(address) || isSigningIn() || lastSignInError()) return
    const key = normalizeWallet(address)
    const count = prompts.current.get(key) ?? 0
    if (count >= MAX_AUTO_PROMPTS) return
    prompts.current.set(key, count + 1)
    signInForReads(signer).catch(() => {
      // Rejected or closed: the gate shows why and offers to try again.
    })
  }, [address, isConnected, signer, version])

  return null
}

/** Re-renders when the session, a sign-in prompt or the connected wallet changes. */
export function useReadSession() {
  const { address, isConnected } = useWallet()
  useSyncExternalStore(subscribeSession, sessionVersion, () => 0)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  // localStorage only exists in the browser: render as signed-out until mounted.
  return {
    address,
    isConnected,
    signedIn: mounted && hasReadSession(address),
    signing: mounted && isSigningIn(),
    error: mounted ? lastSignInError() : null,
  }
}

function GateCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <NeumorphicCard className="mx-auto max-w-[560px] p-7 text-center">
      <h2 className="text-[17px] font-semibold text-[#F5F5F7]">{title}</h2>
      <div className="mt-2 text-[13.5px] leading-relaxed text-[#8B8D96]">{children}</div>
    </NeumorphicCard>
  )
}

/**
 * Orders, results and disputes are private to their parties, so pages that
 * show them need to know who is looking. Connecting a wallet asks for the
 * sign-in signature automatically (SessionSync); this shows what's happening
 * meanwhile, and a retry if it was rejected. Children remount per wallet.
 */
export function SessionGate({ children, what = 'your orders' }: { children: ReactNode; what?: string }) {
  const { address, isConnected, signedIn, signing, error } = useReadSession()
  const { signer } = useWallet()

  if (!isConnected || !address) {
    return <GateCard title="Connect your wallet">Connect a wallet to see {what}. Orders are private to their buyer and seller.</GateCard>
  }

  if (signedIn) return <div key={normalizeWallet(address)}>{children}</div>

  if (signing || !error) {
    return (
      <GateCard title="Confirm sign-in in your wallet">
        Sign the message in your wallet to prove it&apos;s you. It&apos;s free, sends no transaction, and lasts 24 hours.
        {!signing && (
          <button
            type="button"
            onClick={() => signer && signInForReads(signer).catch(() => {})}
            className="mt-4 block w-full text-[12.5px] text-[#5B5FEF] hover:underline"
          >
            No prompt? Open it again
          </button>
        )}
      </GateCard>
    )
  }

  return (
    <GateCard title="Sign in to view">
      <p>
        The sign-in wasn&apos;t completed ({error}). Only you and the other side of each deal can see {what}, so we need one free
        signature from your wallet. It sends no transaction and lasts 24 hours.
      </p>
      <button
        type="button"
        onClick={() => signer && signInForReads(signer).catch(() => {})}
        className="mt-5 rounded-xl bg-[#5B5FEF] px-5 py-2.5 text-[13.5px] font-medium text-white transition hover:bg-[#4B4FDF]"
      >
        Try again
      </button>
    </GateCard>
  )
}

/** Shown instead of an order the viewer is not a party to. */
export function PrivateOrderNotice({ message }: { message?: string }) {
  return (
    <GateCard title="This order is private">
      {message ?? 'Only its buyer, seller and the arbiter can see it.'} Connect the wallet that took part in this deal to open it.
    </GateCard>
  )
}
