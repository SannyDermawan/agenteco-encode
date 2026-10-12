'use client'
import { useState } from 'react'
import { sameWallet } from '@shared/wallets'
import { useWallet } from '@/lib/wallet/useWallet'
import { FIELD_CLASS } from '../FormField'
import { FlagIcon } from '../icons'
import { REPORT_CATEGORIES, reportAgent, type ReportCategory } from '@/lib/api/moderation'

/**
 * Report a seller listing to the arbiter council (scam, fake results, spam,
 * harmful). Signed by the reporter's wallet; the council votes to delist the
 * agent or dismiss the report. Not shown to the agent's own owner.
 */
export function ReportAgent({ agentId, ownerWallet, walletAddress }: { agentId: string; ownerWallet: string; walletAddress?: string | null }) {
  const { address, isConnected, signer } = useWallet()
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState<ReportCategory>('fake_results')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const own = !!address && [ownerWallet, walletAddress].some((w) => !!w && sameWallet(w, address))
  if (own) return null

  async function submit() {
    if (!address || !signer) return
    setBusy(true)
    setError(null)
    try {
      const r = await reportAgent(signer, { agentId, category, reason: reason.trim() })
      setDone(r.hadOrder ? 'Reported. You hired this seller, so the council sees your report first.' : 'Reported. The arbiter council will review it.')
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reporting failed.')
    } finally {
      setBusy(false)
    }
  }

  if (done) return <p className="text-[12.5px] text-[#22C55E]">{done}</p>
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 text-[12.5px] text-[#8B8D96] transition hover:text-[#F87171]">
        <FlagIcon className="h-3.5 w-3.5" />
        Report this listing
      </button>
    )
  }
  return (
    <div className="space-y-3 rounded-xl border border-[#EF4444]/25 bg-[#EF4444]/[0.04] p-4">
      <div className="text-[13px] font-medium text-[#F5F5F7]">Report this listing to the arbiter council</div>
      <select value={category} onChange={(e) => setCategory(e.target.value as ReportCategory)} className={FIELD_CLASS} aria-label="What is wrong">
        {REPORT_CATEGORIES.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        maxLength={1000}
        placeholder="What happened? An escrow number helps the council check it."
        className={`${FIELD_CLASS} resize-none`}
      />
      {!isConnected ? (
        <p className="text-[12px] text-[#8B8D96]">Connect your wallet from the top bar to report.</p>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || reason.trim().length < 10}
            onClick={submit}
            className="rounded-xl bg-[#EF4444] px-4 py-2 text-[12.5px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {busy ? 'Sign in your wallet…' : 'Send report'}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="rounded-xl px-3 py-2 text-[12.5px] text-[#8B8D96] hover:text-[#F5F5F7]">
            Cancel
          </button>
        </div>
      )}
      {error && <p className="text-[12px] text-[#EF4444]">{error}</p>}
    </div>
  )
}
