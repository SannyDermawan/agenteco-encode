'use client'
import { useState } from 'react'
import { formatUnits } from 'viem'
import { useSolanaBalances, useSolanaToken } from '@/lib/solana/hooks'
import { TOKEN_SYMBOL } from '@/lib/web3/network'
import { useWallet } from '@/lib/wallet/useWallet'
import { WalletIcon } from './icons'

const BUTTON =
  'flex items-center gap-2 rounded-full bg-gradient-to-r from-[#6D71F7] via-[#5B5FEF] to-[#4347C9] px-4 py-2 text-[13px] font-medium text-white shadow-[0_1px_0_rgba(255,255,255,.16)_inset] transition hover:-translate-y-px hover:brightness-110 hover:shadow-[0_0_22px_rgba(91,95,239,.45)] disabled:opacity-60'

const WALLET_LINKS = [
  { name: 'Phantom', url: 'https://phantom.com/download' },
  { name: 'Solflare', url: 'https://solflare.com/download' },
  { name: 'Backpack', url: 'https://backpack.app/download' },
]

function truncateAddress(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

/**
 * The top bar's wallet control on a Solana network. Wallets register themselves with the page, so the
 * list is whatever this browser has: one wallet connects at once, several are offered as a short list,
 * none points to where to get one.
 */
export function SolanaWalletControl() {
  const { address, isConnected, isConnecting, choices, error, connect, disconnect } = useWallet()
  const { data: balances } = useSolanaBalances(address)
  const { data: token } = useSolanaToken()
  const [open, setOpen] = useState(false)

  if (!isConnected || !address) {
    return (
      <div className="relative">
        <button
          type="button"
          disabled={isConnecting}
          onClick={() => (choices.length === 1 ? connect(choices[0].name) : setOpen((o) => !o))}
          className={BUTTON}
        >
          <WalletIcon className="h-4 w-4" />
          {isConnecting ? 'Connecting…' : 'Connect Wallet'}
        </button>
        {open && choices.length !== 1 && (
          <div role="menu" className="absolute right-0 top-[calc(100%+8px)] z-40 w-[260px] rounded-2xl border border-white/[0.08] bg-[#0D0F14] p-2 shadow-xl">
            {choices.length > 0 ? (
              choices.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false)
                    connect(c.name)
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-[#F5F5F7] hover:bg-white/[0.05]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- icon is a data: URL supplied by the wallet */}
                  <img src={c.icon} alt="" className="h-5 w-5 rounded" />
                  {c.name}
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-[12.5px] leading-relaxed text-[#8B8D96]">
                <p>No Solana wallet found in this browser. Install one, then reload:</p>
                <ul className="mt-2 space-y-1">
                  {WALLET_LINKS.map((w) => (
                    <li key={w.name}>
                      <a href={w.url} target="_blank" rel="noreferrer" className="text-[#5B5FEF] hover:underline">
                        {w.name} ↗
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {error && !open && <p className="absolute right-0 top-[calc(100%+6px)] w-[260px] text-right text-[11.5px] text-[#EF4444]">{error}</p>}
      </div>
    )
  }

  const formatted = balances && token ? Number(formatUnits(balances.token, token.decimals)).toFixed(2) : '…'
  return (
    <>
      <span className="hidden items-center gap-1.5 rounded-full border border-white/[0.06] bg-[#0D0F14] px-3 py-1.5 text-[11.5px] font-medium text-[#F5F5F7] sm:inline-flex">
        <WalletIcon className="h-3.5 w-3.5 text-[#8B8D96]" />
        {formatted} {TOKEN_SYMBOL}
      </span>
      <button type="button" onClick={() => disconnect()} title="Disconnect wallet" className={BUTTON}>
        {truncateAddress(address)}
      </button>
    </>
  )
}
