'use client'
import { useState } from 'react'
import { useAccount, useConnect, useSignMessage } from 'wagmi'
import { FIELD_CLASS } from '@/components/app/FormField'
import { NeumorphicCard } from '@/components/app/NeumorphicCard'
import { PageFade } from '@/components/app/PageFade'
import { approveDeviceLink, lookupDeviceLink, type DeviceLinkInfo } from '@/lib/api/deviceLinks'

const BUTTON =
  'rounded-lg bg-[#5B5FEF] px-4 py-2 text-[13px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60'

/** "k7qp m2xd" → "K7QP-M2XD", while typing. */
function formatCode(raw: string): string {
  const chars = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return chars.length > 4 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars
}

/**
 * Approve an agent's key as yours. The code comes from the terminal where `agenteco init`
 * is running; the page shows what the code stands for, and your wallet signs one free
 * message (no transaction). The link lists the agent under your account; it cannot spend
 * your funds, and you can unlink it any time.
 */
export default function LinkPage() {
  const { address, isConnected } = useAccount()
  const { connect, connectors, isPending: isConnecting } = useConnect()
  const { signMessageAsync } = useSignMessage()
  const [code, setCode] = useState('')
  const [info, setInfo] = useState<DeviceLinkInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function find() {
    setBusy(true)
    setError(null)
    try {
      setInfo(await lookupDeviceLink(code))
    } catch (e) {
      setInfo(null)
      setError(e instanceof Error ? e.message : 'Lookup failed')
    } finally {
      setBusy(false)
    }
  }

  async function approve() {
    if (!info || !address) return
    setBusy(true)
    setError(null)
    try {
      // The message is built by the server for this wallet, this code, this agent and this network.
      const withMessage = await lookupDeviceLink(info.userCode, address)
      if (!withMessage.message) throw new Error('The server returned no message to sign')
      const signature = await signMessageAsync({ message: withMessage.message })
      const result = await approveDeviceLink(info.userCode, address, withMessage.message, signature)
      setDone(result.agentWallet)
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0] : 'The approval failed')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <PageFade>
        <NeumorphicCard className="mx-auto max-w-[560px] p-6">
          <h2 className="text-[16px] font-semibold text-[#F5F5F7]">Linked</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[#B4B6BE]">
            The agent <span className="break-all font-mono text-[#F5F5F7]">{done}</span> is now listed under your account. Go back to your terminal: it
            continues by itself. You can unlink it any time from <span className="text-[#F5F5F7]">My Agents</span>.
          </p>
        </NeumorphicCard>
      </PageFade>
    )
  }

  return (
    <PageFade>
      <div className="mx-auto max-w-[560px] space-y-4">
        <NeumorphicCard className="p-6">
          <h2 className="text-[16px] font-semibold text-[#F5F5F7]">Link an agent to your account</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[#B4B6BE]">
            Enter the code your terminal printed. Linking lists the agent under your wallet so you can see and manage it here. It gives the agent no
            access to your funds, and it gives you none over its key.
          </p>
          <div className="mt-4 flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(formatCode(e.target.value))}
              onKeyDown={(e) => e.key === 'Enter' && code.length === 9 && !busy && find()}
              placeholder="K7QP-M2XD"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              aria-label="Link code"
              className={`${FIELD_CLASS} font-mono tracking-[0.18em]`}
            />
            <button type="button" onClick={find} disabled={busy || code.length !== 9} className={BUTTON}>
              Look up
            </button>
          </div>
        </NeumorphicCard>

        {info && (
          <NeumorphicCard className="p-6">
            <h3 className="text-[14px] font-semibold text-[#F5F5F7]">Approve this agent?</h3>
            <dl className="mt-3 space-y-2 text-[13px]">
              <div>
                <dt className="text-[#8B8D96]">Agent wallet</dt>
                <dd className="break-all font-mono text-[#F5F5F7]">{info.agentWallet}</dd>
              </div>
              <div className="flex gap-6">
                <div>
                  <dt className="text-[#8B8D96]">Name</dt>
                  <dd className="text-[#F5F5F7]">{info.label}</dd>
                </div>
                <div>
                  <dt className="text-[#8B8D96]">Role</dt>
                  <dd className="text-[#F5F5F7]">{info.role}</dd>
                </div>
                <div>
                  <dt className="text-[#8B8D96]">Network</dt>
                  <dd className="text-[#F5F5F7]">{info.chainId}</dd>
                </div>
              </div>
            </dl>
            <p className="mt-4 rounded-lg border border-[#F59E0B]/30 bg-[#F59E0B]/10 px-3 py-2 text-[12.5px] leading-relaxed text-[#F5C26B]">
              Approve only if this exact address and code appeared in a terminal <em>you</em> started. If someone sent you this code, do not approve it.
            </p>
            <div className="mt-4">
              {isConnected ? (
                <button type="button" onClick={approve} disabled={busy} className={BUTTON}>
                  {busy ? 'Waiting for your wallet…' : 'Approve with my wallet'}
                </button>
              ) : (
                <button type="button" onClick={() => connect({ connector: connectors[0] })} disabled={isConnecting} className={BUTTON}>
                  {isConnecting ? 'Connecting…' : 'Connect wallet to approve'}
                </button>
              )}
            </div>
          </NeumorphicCard>
        )}

        {error && (
          <p role="alert" className="rounded-lg border border-[#EF4444]/30 bg-[#EF4444]/10 px-3 py-2 text-[12.5px] text-[#F28B8B]">
            {error}
          </p>
        )}
      </div>
    </PageFade>
  )
}
