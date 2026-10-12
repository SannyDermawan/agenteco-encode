'use client'
import { useState } from 'react'
import { BrandLogo } from '@/components/BrandLogo'
import { UnavailableModal } from './UnavailableModal'

// A link with no href isn't live yet — clicking it opens the "coming soon" modal.
type ResourceLink = { label: string; href?: string }

const COLUMNS: { heading: string; links: ResourceLink[] }[] = [
  {
    heading: 'RESOURCES',
    links: [{ label: 'Docs' }],
  },
  {
    heading: 'CONTRACTS',
    // The deployed AgentEco escrow on each network's explorer (docs/MULTICHAIN.md and docs/SOLANA.md list them).
    links: [
      { label: 'BNB Smart Chain', href: 'https://testnet.bscscan.com/address/0xdC08Dd97e959Ab6ED2AB76702F25757Fe1fF46BE' },
      { label: 'Base Sepolia', href: 'https://base-sepolia.blockscout.com/address/0xF8448762AeCE0039f1072Da74477fbFAD629fDB8?tab=contract' },
      { label: 'Ethereum Sepolia', href: 'https://eth-sepolia.blockscout.com/address/0x3048b1a3CeeE4f1AF09485e49f059d094EF6f865?tab=contract' },
      { label: 'Arbitrum Sepolia', href: 'https://sepolia.arbiscan.io/address/0xaf77570B25D2EAD24a53Eead61deEB0bc21a83ea#code' },
      { label: 'Tempo Moderato', href: 'https://explore.testnet.tempo.xyz/address/0x2620424C73A39624bDcd3fa43aABF425d6Da997e' },
      { label: 'BOT Chain Testnet', href: 'https://scan.bohr.life/address/0xaf77570B25D2EAD24a53Eead61deEB0bc21a83ea?tab=contract' },
      { label: 'Solana devnet', href: 'https://explorer.solana.com/address/3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE?cluster=devnet' },
    ],
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
    <footer className="relative bg-[#0A0B1E]/80 px-5 backdrop-blur-xl text-[#F5F5F7]">
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

        {/* md:pr-16 keeps the networks line clear of the floating GitHub button in the corner. */}
        <div className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-8 md:mt-16 md:flex-row md:items-center md:justify-between md:pr-16">
          <p className="text-[11px] text-[#8B8D96]">&copy; 2026 AgentEco. All rights reserved.</p>
          <p className="text-[11px] text-[#8B8D96]">
            Deployed on test networks: <span className="font-semibold text-[#F5F5F7]">BNB Smart Chain, Base, Ethereum, Arbitrum, Tempo, BOT Chain and Solana</span>
          </p>
        </div>
      </div>

      <UnavailableModal open={activeLink !== null} onClose={() => setActiveLink(null)} context={activeLink ?? undefined} />
    </footer>
  )
}
