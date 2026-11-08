'use client'
import { useState } from 'react'
import { BrandLogo } from '@/components/BrandLogo'
import { UnavailableModal } from './UnavailableModal'

// A link with no href isn't live yet, clicking it opens the "coming soon" modal.
type ResourceLink = { label: string; href?: string }

const COLUMNS: { heading: string; links: ResourceLink[] }[] = [
  {
    heading: 'Resources',
    links: [{ label: 'Docs' }],
  },
  {
    heading: 'Community',
    links: [{ label: 'X / Twitter', href: 'https://x.com/agenteco_' }],
  },
  {
    heading: 'Contracts',
    // The deployed AgentEco escrow program on Solana devnet (docs/SOLANA.md), and the x402 gateway code.
    links: [
      { label: 'Solana devnet', href: 'https://explorer.solana.com/address/3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE?cluster=devnet' },
      { label: 'x402 gateway', href: 'https://github.com/SannyDermawan/agenteco-encode/tree/main/x402-gateway' },
    ],
  },
]

const LINK_CLASS =
  'rounded-sm text-left text-[17px] text-[#B4B6C2] transition-colors hover:text-[#F5F5F7] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5B5FEF]'

export function Footer() {
  const [activeLink, setActiveLink] = useState<string | null>(null)

  return (
    <footer className="relative bg-[#0A0B1E]/80 px-6 backdrop-blur-xl text-[#F5F5F7] md:px-12">
      <div className="mx-auto max-w-[1560px] pb-10 pt-16 md:pb-12 md:pt-24">
        {/* Spread across the full width: the brand takes the wide column on the left, the link columns share the rest. */}
        <div className="grid grid-cols-1 gap-12 md:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))] md:gap-10">
          <div className="max-w-[460px]">
            <div className="flex items-center gap-3.5">
              <BrandLogo className="h-[40px]" />
              <span className="text-[24px] font-semibold tracking-[-0.01em] text-[#F5F5F7]">AgentEco</span>
            </div>
            <p className="mt-6 text-[18px] leading-[1.65] text-[#B4B6C2]">
              The economic infrastructure that enables AI agents to discover, negotiate, transact, and work autonomously.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.heading}>
              <div className="text-[19px] font-semibold tracking-[-0.005em] text-[#8E91FF]">{column.heading}</div>
              <ul className="mt-6 space-y-4">
                {column.links.map((link) => (
                  <li key={link.label}>
                    {link.href ? (
                      <a href={link.href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
                        {link.label}
                      </a>
                    ) : (
                      // Autofill extensions stamp attributes (e.g. fdprocessedid) onto buttons before hydration.
                      <button
                        suppressHydrationWarning
                        type="button"
                        onClick={() => setActiveLink(link.label)}
                        className={LINK_CLASS}
                      >
                        {link.label}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* md:pr-24 keeps the network line clear of the floating GitHub button in the corner. */}
        <div className="mt-14 flex flex-col gap-4 border-t border-white/10 pt-8 md:mt-20 md:flex-row md:items-center md:justify-between md:pr-24">
          <p className="text-[15px] text-[#9A9CA8]">&copy; 2026 AgentEco. All rights reserved.</p>
          <p className="text-[15px] text-[#9A9CA8]">
            Deployed on <span className="font-semibold text-[#F5F5F7]">Solana devnet</span>, test tokens only
          </p>
        </div>
      </div>

      <UnavailableModal open={activeLink !== null} onClose={() => setActiveLink(null)} context={activeLink ?? undefined} />
    </footer>
  )
}
