'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { JSX } from 'react'
import { useWallet } from '@/lib/wallet/useWallet'
import { useIsArbiter } from '@/lib/chain/hooks'
import { useDisputes } from '@/lib/web3/escrowEvents'
import { BrandLogo } from '@/components/BrandLogo'
import {
  DashboardIcon,
  MarketplaceIcon,
  CapabilityIcon,
  AgentsIcon,
  CreateAgentIcon,
  PlugIcon,
  OrdersIcon,
  ActivityIcon,
  CloseIcon,
  ScaleIcon,
  type IconProps,
} from './icons'

type NavItem = { label: string; href: string; icon: (props: IconProps) => JSX.Element; badge?: number }

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'MARKETPLACE',
    items: [
      { label: 'Marketplace', href: '/app/marketplace', icon: MarketplaceIcon },
      { label: 'Capabilities', href: '/app/capabilities', icon: CapabilityIcon },
    ],
  },
  { group: 'OVERVIEW', items: [{ label: 'Dashboard', href: '/app/dashboard', icon: DashboardIcon }] },
  {
    group: 'MY AGENTS',
    items: [
      { label: 'My Agents', href: '/app/agents', icon: AgentsIcon },
      // Hosted by AgentEco: try the whole flow (real escrow, AI and ratings) without building an agent.
      { label: 'Create Agent - Demo', href: '/app/create-agent', icon: CreateAgentIcon },
      // Bring an agent you built: it runs on your machine, with its own wallet and AI.
      { label: 'Register Own Agent', href: '/app/register-agent', icon: PlugIcon },
    ],
  },
  {
    group: 'TRANSACTIONS',
    items: [
      { label: 'Orders', href: '/app/orders', icon: OrdersIcon },
      { label: 'Activity', href: '/app/activity', icon: ActivityIcon },
    ],
  },
]

// AgentEco.sol OrderStatus.DISPUTED
const DISPUTED = 4

export function AppSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname()

  // The arbiter's inbox — only shown to the wallet the contract names as arbiter.
  const { address } = useWallet()
  const isArbiter = useIsArbiter(address)
  const { data: disputes } = useDisputes(isArbiter)
  const openDisputes = disputes?.filter((d) => d.status === DISPUTED).length ?? 0
  const groups = isArbiter
    ? [...NAV, { group: 'ARBITER', items: [{ label: 'Disputes', href: '/app/disputes', icon: ScaleIcon, badge: openDisputes }] }]
    : NAV

  return (
    <>
      {open && (
        <div aria-hidden onClick={onClose} className="fixed inset-0 z-40 bg-black/60 lg:hidden" />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[248px] flex-col border-r border-white/[0.06] bg-[#0B0C11] transition-transform duration-200 lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-[64px] shrink-0 items-center justify-between px-5">
          <Link href="/app/marketplace" className="flex items-center gap-2.5">
            <BrandLogo className="h-6" />
            <span className="text-[15px] font-semibold tracking-[-0.01em] text-[#F5F5F7]">AgentEco</span>
          </Link>
          <button onClick={onClose} className="rounded-md p-1 text-[#8B8D96] lg:hidden" aria-label="Close menu">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-6 pt-2">
          {groups.map((group) => (
            <div key={group.group}>
              <div className="px-2.5 text-[10.5px] font-medium tracking-[0.12em] text-[#54565F]">{group.group}</div>
              <div className="mt-2 space-y-0.5">
                {group.items.map((item) => {
                  const active = pathname === item.href || pathname?.startsWith(item.href + '/')
                  const Icon = item.icon
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onClose}
                      className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13.5px] transition ${
                        active
                          ? 'bg-[#5B5FEF]/[0.12] text-[#F5F5F7] shadow-[inset_0_0_0_1px_rgba(91,95,239,.35)]'
                          : 'text-[#8B8D96] hover:bg-white/[0.03] hover:text-[#F5F5F7]'
                      }`}
                    >
                      <Icon className="h-[18px] w-[18px]" />
                      {item.label}
                      {!!item.badge && (
                        <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-[#EF4444] px-1.5 text-[11px] font-semibold text-white">
                          {item.badge}
                        </span>
                      )}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>
    </>
  )
}
