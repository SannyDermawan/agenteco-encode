'use client'
import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig } from '@/lib/web3/config'
import { AppSidebar } from '@/components/app/AppSidebar'
import { AppTopbar } from '@/components/app/AppTopbar'
import { DemoModeBanner } from '@/components/app/DemoModeBanner'
import { FaucetStrip } from '@/components/app/FaucetStrip'
import { SolanaFundingStrip } from '@/components/app/SolanaFunding'
import { SessionSync } from '@/components/app/SessionGate'
import { SolanaWalletProvider } from '@/lib/solana/wallet'
import { FAMILY, SOLANA_OFFERED } from '@/lib/web3/network'

const noSubscription = () => () => {}

export default function AppLayout({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [queryClient] = useState(() => new QueryClient())
  // The app renders in the browser only: it runs on the network this browser picked
  // (lib/web3/network.ts), which a server render cannot know.
  // False on the server and while hydrating, true from the browser's next render on.
  const mounted = useSyncExternalStore(noSubscription, () => true, () => false)
  if (!mounted) return <div className="min-h-screen bg-[#08090D]" />

  const shell = (
    <>
      <SessionSync />
      <div className="min-h-screen bg-[#08090D] text-[#F5F5F7]">
        <AppSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div className="lg:pl-[248px]">
          <AppTopbar onMenuClick={() => setSidebarOpen(true)} />
          <DemoModeBanner />
          {FAMILY === 'solana' ? <SolanaFundingStrip /> : <FaucetStrip />}
          <main className="mx-auto max-w-[1400px] px-4 py-6 md:px-7 md:py-8">{children}</main>
        </div>
      </div>
    </>
  )

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{SOLANA_OFFERED ? <SolanaWalletProvider>{shell}</SolanaWalletProvider> : shell}</QueryClientProvider>
    </WagmiProvider>
  )
}
