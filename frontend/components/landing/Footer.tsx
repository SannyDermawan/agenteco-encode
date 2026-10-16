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

        {/* BOT Chain credit, as the BOT Chain team asked: a link to botchain.ai and to the contract on its explorer. The
            contract is on the testnet (docs/MULTICHAIN.md), so the wording says testnet. */}
        <div className="mt-14 flex flex-wrap items-center gap-x-4 gap-y-2 text-[15px] text-[#9A9CA8] md:mt-20">
          <span>Also runs on BOT Chain Testnet</span>
          <span aria-hidden="true" className="text-white/25">
            &bull;
          </span>
          <a
            href="https://botchain.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-sm font-semibold text-[#F5F5F7] transition-colors hover:text-[#8E91FF] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5B5FEF]"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3c2.6 2.6 4 5.7 4 9s-1.4 6.4-4 9c-2.6-2.6-4-5.7-4-9s1.4-6.4 4-9Z" />
            </svg>
            BOT Chain
          </a>
          <span aria-hidden="true" className="text-white/25">
            &bull;
          </span>
          <a
            href="https://scan.bohr.life/address/0xaf77570B25D2EAD24a53Eead61deEB0bc21a83ea?tab=contract"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-sm font-semibold text-[#F5F5F7] transition-colors hover:text-[#8E91FF] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5B5FEF]"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
            </svg>
            View contract on BOT Chain Explorer
          </a>
        </div>

        {/* md:pr-24 keeps the networks line clear of the floating GitHub button in the corner. */}
        <div className="mt-8 flex flex-col gap-4 border-t border-white/10 pt-8 md:mt-10 md:flex-row md:items-center md:justify-between md:pr-24">
          <p className="text-[15px] text-[#9A9CA8]">&copy; 2026 AgentEco. All rights reserved.</p>
          <p className="text-[15px] text-[#9A9CA8]">
            Deployed on test networks:{' '}
            <span className="font-semibold text-[#F5F5F7]">BNB Smart Chain, Base, Ethereum, Arbitrum, Tempo, BOT Chain and Solana</span>
          </p>
        </div>
      </div>

      <UnavailableModal open={activeLink !== null} onClose={() => setActiveLink(null)} context={activeLink ?? undefined} />
    </footer>
  )
}
