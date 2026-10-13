'use client'
import { useState, type ReactNode } from 'react'
import { NeumorphicCard } from '../NeumorphicCard'

export const REPO_URL = 'https://github.com/SannyDermawan/agenteco-multichain'
export const SDK_DOCS_URL = `${REPO_URL}/tree/main/agent-runtime#readme`
export const PYTHON_EXAMPLE_URL = `${REPO_URL}/tree/main/buyer-agent-python`
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

// The SDK is a TypeScript package on npm, run with tsx.
export const INSTALL = `npm i @agenteco/sdk tsx`

/** Prints a new key and its address. The key goes in your .env; only the address is ever pasted here. */
export const KEYGEN = `npx tsx -e "import { generatePrivateKey, privateKeyToAccount } from '@agenteco/sdk'; const k = generatePrivateKey(); console.log('AGENT_PRIVATE_KEY=' + k); console.log('address:', privateKeyToAccount(k).address)"`

/** The same for an agent that is not written in TypeScript: any wallet generator works. */
export const KEYGEN_PYTHON = `pip install eth-account
python -c "from eth_account import Account; a = Account.create(); print('AGENT_PRIVATE_KEY=0x' + a.key.hex().removeprefix('0x')); print('address:', a.address)"`

export const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/

/** A copyable code block. */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be blocked; the code is still selectable.
    }
  }
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-[#0B0C11]">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-1.5">
        <span className="font-mono text-[11px] text-[#54565F]">{label ?? ''}</span>
        <button type="button" onClick={copy} className="rounded-md px-2 py-0.5 text-[11.5px] text-[#8B8D96] hover:text-[#F5F5F7]">
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <pre className="max-h-[460px] overflow-auto p-3.5 font-mono text-[12px] leading-relaxed text-[#C9CBD3]">{code}</pre>
    </div>
  )
}

/** A numbered step of the setup. */
export function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <NeumorphicCard className="p-6">
      <div className="flex items-center gap-3">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12.5px] font-semibold ${
            done ? 'bg-[#22A06B] text-white' : 'bg-[#5B5FEF]/15 text-[#8E91FF]'
          }`}
        >
          {done ? '✓' : n}
        </span>
        <h3 className="text-[15px] font-semibold text-[#F5F5F7]">{title}</h3>
      </div>
      <div className="mt-4 space-y-3 text-[13px] leading-relaxed text-[#A3A5AE]">{children}</div>
    </NeumorphicCard>
  )
}

export function Note({ tone = 'info', children }: { tone?: 'info' | 'warn'; children: ReactNode }) {
  return (
    <p
      className={`rounded-xl border px-3.5 py-2.5 text-[12.5px] leading-relaxed ${
        tone === 'warn' ? 'border-[#F59E0B]/30 bg-[#F59E0B]/[0.07] text-[#F5C26B]' : 'border-white/[0.06] bg-[#0B0C11]/60 text-[#8B8D96]'
      }`}
    >
      {children}
    </p>
  )
}

/** "12s ago", `now` in unix seconds (useNow), so rendering stays pure. */
export function timeAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round(now - new Date(iso).getTime() / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}
