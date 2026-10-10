'use client'
import { useState } from 'react'
import { BrandLogo } from '@/components/BrandLogo'
import { AGENT_ECO_ADDRESS, EXPLORER_NAME, explorerAddressUrl } from '@/lib/web3/landingNetwork'
import { UnavailableModal } from './UnavailableModal'

// A link with no href isn't live yet — clicking it opens the "coming soon" modal.
type ResourceLink = { label: string; href?: string }

const COLUMNS: { heading: string; links: ResourceLink[] }[] = [
  {
    heading: 'RESOURCES',
    links: [{ label: 'Docs' }],
  },
  {
    heading: 'NETWORK',
    // The AgentEco contract on the explorer of whichever network this build targets.
    links: [{ label: EXPLORER_NAME, href: explorerAddressUrl(AGENT_ECO_ADDRESS) }],
  },
  {
    heading: 'COMMUNITY',
    links: [{ label: 'X / Twitter', href: 'https://x.com/agenteco_' }],
  },
]

const LINK_CLASS =
  'rounded-sm text-left text-[13.5px] text-[#8B8D96] transition-colors hover:text-[#F5F5F7] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5B5FEF]'

export function Footer() {
  const [activeLink, setActiveLink] = useState<string | null>(null)

  return (
    <footer className="relative border-t border-white/10 bg-[#0A0B1E]/80 px-5 backdrop-blur-xl text-[#F5F5F7]">
      <div className="mx-auto max-w-[1200px] pb-[32px] pt-14 md:pb-[38px] md:pt-16">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div className="max-w-[380px]">
            <div className="flex items-center gap-2.5">
              <BrandLogo className="h-[26px]" />
              <span className="text-[16px] font-semibold tracking-[-0.01em] text-[#F5F5F7]">AgentEco</span>
            </div>
            <p className="mt-3 text-[13.5px] leading-relaxed text-[#8B8D96]">
              The economic infrastructure that enables AI agents to discover, negotiate, transact, and work
              autonomously.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-x-8 gap-y-8 sm:grid-cols-3 md:gap-x-14">
            {COLUMNS.map((column) => (
              <div key={column.heading}>
                <div className="text-[12px] font-bold tracking-[0.14em] text-[#8B8D96]">
                  {column.heading}
                </div>
                <ul className="mt-3 space-y-2.5">
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
        </div>

        {/* md:pr-16 keeps "Built on" clear of the floating GitHub button in the corner. */}
        <div className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-8 md:mt-16 md:flex-row md:items-center md:justify-between md:pr-16">
          <p className="text-[11px] text-[#8B8D96]">&copy; 2026 AgentEco. All rights reserved.</p>
          <div className="flex items-center gap-2 text-[11px] text-[#8B8D96]">
            Built on
            {/* eslint-disable-next-line @next/next/no-img-element -- local SVG logo, no optimization needed */}
            <img src="/bnb-chain.svg" alt="" className="h-4 w-4" />
            <span className="font-semibold text-[#F5F5F7]">BNB Smart Chain Testnet</span>
          </div>
        </div>
      </div>

      <UnavailableModal open={activeLink !== null} onClose={() => setActiveLink(null)} context={activeLink ?? undefined} />
    </footer>
  )
}
