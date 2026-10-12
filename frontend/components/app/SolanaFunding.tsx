'use client'
import { useState } from 'react'
import { formatUnits } from 'viem'
import { NeumorphicCard } from './NeumorphicCard'
import { useSolanaBalances, useSolanaToken } from '@/lib/solana/hooks'
import { CHAIN_NAME, GAS_FAUCETS, NATIVE_SYMBOL, TOKEN_SYMBOL } from '@/lib/web3/network'
import { useWallet } from '@/lib/wallet/useWallet'

/** Below this much of the settlement token the strip offers the faucet. */
const LOW_TOKEN_BALANCE = 1
const DISMISS_KEY = 'agenteco:solana-funding-dismissed'

/** Devnet SOL (fees) and USDC come from external faucets that need a person: this shows where, and the wallet's balances. */
function useFunding() {
  const { address, isConnected } = useWallet()
  const { data: balances } = useSolanaBalances(address)
  const { data: token } = useSolanaToken()
  const sol = balances?.sol
  const usdc = balances && token ? balances.token : undefined
  const decimals = token?.decimals
  const needsSol = isConnected && sol !== undefined && sol === BigInt(0)
  const needsToken = isConnected && usdc !== undefined && decimals !== undefined && usdc < BigInt(LOW_TOKEN_BALANCE) * BigInt(10) ** BigInt(decimals)
  return { isConnected, sol, usdc, decimals, needsSol, needsToken }
}

function FaucetLinks({ className }: { className: string }) {
  return (
    <>
      {GAS_FAUCETS.map((f) => (
        <a key={f.url} href={f.url} target="_blank" rel="noopener noreferrer" className={className}>
          {f.label} ↗
        </a>
      ))}
    </>
  )
}

/**
 * App-wide strip on a Solana network: this is a devnet, so a wallet needs a little SOL for fees and
 * some USDC before it can hire anyone. Shows only while the wallet is short of either, and goes away
 * by itself once the balances are enough, or when dismissed for the session.
 */
export function SolanaFundingStrip() {
  const f = useFunding()
  // The app renders in the browser only (app/app/layout.tsx), so storage can be read at once.
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })
  if (dismissed || !f.isConnected || (!f.needsSol && !f.needsToken)) return null

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-b border-[#5B5FEF]/20 bg-[#5B5FEF]/[0.07] px-4 py-2 text-[12.5px] text-[#B9BBFF] md:px-7">
      <span>
        <span className="font-medium text-[#C9CBFF]">{f.needsSol ? `You need ${NATIVE_SYMBOL} for fees` : `Get free test ${TOKEN_SYMBOL}`}</span> on {CHAIN_NAME} before you can hire anyone.
      </span>
      <span className="flex flex-wrap gap-x-3">
        <FaucetLinks className="text-[#8FA9FF] hover:underline" />
      </span>
      <button
        type="button"
        onClick={() => {
          setDismissed(true)
          try {
            sessionStorage.setItem(DISMISS_KEY, '1')
          } catch {}
        }}
        className="text-[#8B8D96] hover:text-[#F5F5F7]"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  )
}

/** The same guidance as a card, where a flow stopped for a short wallet. */
export function SolanaFundingCard({ reason }: { reason?: string }) {
  const f = useFunding()
  return (
    <NeumorphicCard className="p-5">
      <h3 className="text-[14px] font-semibold text-[#F5F5F7]">Get test funds on {CHAIN_NAME}</h3>
      {reason && <p className="mt-2 text-[12.5px] leading-relaxed text-[#8B8D96]">{reason}</p>}
      <p className="mt-2 text-[12.5px] leading-relaxed text-[#8B8D96]">
        Devnet faucets need a person (a captcha or a social check), so they open in their own page. Paste your wallet address there:
        {NATIVE_SYMBOL} pays network fees, {TOKEN_SYMBOL} pays for the work.
      </p>
      {f.isConnected && f.sol !== undefined && f.decimals !== undefined && (
        <p className="mt-3 text-[12.5px] text-[#F5F5F7]">
          Your wallet holds {formatUnits(f.sol, 9)} {NATIVE_SYMBOL} and {f.usdc !== undefined ? formatUnits(f.usdc, f.decimals) : '…'} {TOKEN_SYMBOL}.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <FaucetLinks className="rounded-lg bg-[#5B5FEF] px-3 py-1.5 text-[12px] font-medium text-white transition hover:brightness-110" />
      </div>
    </NeumorphicCard>
  )
}
