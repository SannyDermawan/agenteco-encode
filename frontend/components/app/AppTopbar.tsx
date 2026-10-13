'use client'
import { usePathname } from 'next/navigation'
import { formatUnits } from 'viem'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { appChain } from '@/lib/web3/chain'
import { AVAILABLE_NETWORKS, FAMILY, NETWORK, NETWORK_LABEL, TOKEN_SYMBOL, selectNetwork, type NetworkName } from '@/lib/web3/network'
import { useUsdtBalance, useUsdtDecimals } from '@/lib/web3/hooks'
import { MenuIcon, WalletIcon } from './icons'
import { SolanaWalletControl } from './SolanaWalletControl'

const TITLES: Record<string, string> = {
  '/app/dashboard': 'Dashboard',
  '/app/marketplace': 'Marketplace',
  '/app/capabilities': 'Capabilities',
  '/app/agents': 'My Agents',
  '/app/create-agent': 'Create Agent - Demo',
  '/app/register-agent': 'Register Own Agent',
  '/app/link': 'Link an Agent',
  '/app/disputes': 'Disputes',
  '/app/orders': 'Orders',
  '/app/activity': 'Agent Activity',
}

function titleFor(pathname: string | null) {
  if (!pathname) return 'Dashboard'
  if (TITLES[pathname]) return TITLES[pathname]
  if (pathname.startsWith('/app/agents/')) return 'Agent Profile'
  if (pathname.startsWith('/app/orders/')) return 'Order'
  return 'Dashboard'
}

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function EvmWalletControl() {
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending: isConnecting } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain, isPending: isSwitching } = useSwitchChain()

  const { data: balance } = useUsdtBalance(address)
  const { data: decimals } = useUsdtDecimals()

  if (!isConnected) {
    return (
      <button
        type="button"
        onClick={() => connect({ connector: connectors[0] })}
        disabled={isConnecting}
        className="flex items-center gap-2 rounded-full bg-gradient-to-r from-[#6D71F7] via-[#5B5FEF] to-[#4347C9] px-4 py-2 text-[13px] font-medium text-white shadow-[0_1px_0_rgba(255,255,255,.16)_inset] transition hover:-translate-y-px hover:brightness-110 hover:shadow-[0_0_22px_rgba(91,95,239,.45)] disabled:opacity-60"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- local PNG icon, no optimization needed */}
        <img src="/logo-wallet.png" alt="" className="h-4 w-4" />
        {isConnecting ? 'Connecting…' : 'Connect Wallet'}
      </button>
    )
  }

  if (chainId !== appChain.id) {
    return (
      <button
        type="button"
        onClick={() => switchChain({ chainId: appChain.id })}
        disabled={isSwitching}
        className="flex items-center gap-2 rounded-full border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-4 py-2 text-[13px] font-medium text-[#F59E0B] transition hover:bg-[#F59E0B]/15 disabled:opacity-60"
      >
        {isSwitching ? 'Switching…' : 'Wrong network: switch'}
      </button>
    )
  }

  const formattedBalance =
    balance !== undefined && decimals !== undefined ? Number(formatUnits(balance, decimals)).toFixed(2) : '…'

  return (
    <>
      <span className="hidden items-center gap-1.5 rounded-full border border-white/[0.06] bg-[#0D0F14] px-3 py-1.5 text-[11.5px] font-medium text-[#F5F5F7] sm:inline-flex">
        <WalletIcon className="h-3.5 w-3.5 text-[#8B8D96]" />
        {formattedBalance} {TOKEN_SYMBOL}
      </span>
      <button
        type="button"
        onClick={() => disconnect()}
        title="Disconnect wallet"
        className="flex items-center gap-2 rounded-full bg-gradient-to-r from-[#6D71F7] via-[#5B5FEF] to-[#4347C9] px-4 py-2 text-[13px] font-medium text-white shadow-[0_1px_0_rgba(255,255,255,.16)_inset] transition hover:-translate-y-px hover:brightness-110 hover:shadow-[0_0_22px_rgba(91,95,239,.45)]"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- local PNG icon, no optimization needed */}
        <img src="/logo-wallet.png" alt="" className="h-4 w-4" />
        {address && truncateAddress(address)}
      </button>
    </>
  )
}

/** The wallet control of the selected network's family (fixed for a page load). */
const WalletControl = FAMILY === 'solana' ? SolanaWalletControl : EvmWalletControl

/**
 * The network badge, a picker when the app offers several networks. Picking one reloads
 * the app on it (listings, orders, escrows and balances are all per network).
 */
function NetworkPicker() {
  const dot = <i className="h-1.5 w-1.5 rounded-full bg-[#22A06B] shadow-[0_0_6px_#22A06B]" />
  if (AVAILABLE_NETWORKS.length <= 1) {
    return (
      <span className="hidden items-center gap-1.5 rounded-full border border-white/[0.06] bg-[#0D0F14] px-3 py-1.5 text-[11.5px] font-medium text-[#8B8D96] sm:inline-flex">
        {dot}
        {NETWORK_LABEL}
      </span>
    )
  }
  return (
    <label className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-[#0D0F14] py-1.5 pl-3 pr-2 text-[11.5px] font-medium text-[#8B8D96]">
      {dot}
      <span className="sr-only">Network</span>
      <select
        value={NETWORK}
        onChange={(e) => selectNetwork(e.target.value as NetworkName)}
        className="cursor-pointer bg-transparent text-[#F5F5F7] outline-none"
      >
        {AVAILABLE_NETWORKS.map((n) => (
          <option key={n.name} value={n.name} className="bg-[#0D0F14]">
            {n.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function AppTopbar({ onMenuClick }: { onMenuClick: () => void }) {
  const pathname = usePathname()

  return (
    <header className="sticky top-0 z-30 flex h-[64px] items-center gap-4 border-b border-white/[0.06] bg-[#08090D]/85 px-4 backdrop-blur-md md:px-7">
      <button
        onClick={onMenuClick}
        className="rounded-md p-1.5 text-[#8B8D96] hover:text-[#F5F5F7] lg:hidden"
        aria-label="Open menu"
      >
        <MenuIcon className="h-5 w-5" />
      </button>

      <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-[#F5F5F7]">{titleFor(pathname)}</h1>

      <div className="ml-auto flex items-center gap-3">
        <NetworkPicker />
        <WalletControl />
      </div>
    </header>
  )
}
