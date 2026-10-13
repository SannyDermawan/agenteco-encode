'use client'
import { useState } from 'react'
import Link from 'next/link'
import { parseEther, parseUnits } from 'viem'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { useAccount, useSendTransaction, useSignMessage, useWriteContract } from 'wagmi'
import { NeumorphicCard } from './NeumorphicCard'
import { CheckIcon, WalletIcon } from './icons'
import { wagmiConfig } from '@/lib/web3/config'
import { appChain } from '@/lib/web3/chain'
import { ERC20_ABI, USDT_ADDRESS } from '@/lib/web3/abi'
import { useUsdtDecimals } from '@/lib/web3/hooks'
import { AGENT_GAS_TOPUP, NATIVE_SYMBOL, TOKEN_SYMBOL } from '@/lib/web3/network'
import { InsufficientTokenError, assertUsdtBalance } from '@/lib/web3/usdtBalance'
import { GetTestTokensCard } from './GetTestTokensCard'
import { activateAgent, type ApiAgent } from '@/lib/api/agents'

// Gas for the agent's own transactions, buyer: createEscrow + approve +
// fundEscrow + accept/dispute + rating + refund; seller: several startExecution
// + markDelivered + dispute-response + payout rounds. Per network, see
// AGENT_GAS_TOPUP; the host checks a matching minimum (backend/src/hostedDeposit.ts).

type Step = 'idle' | 'sending-usdt' | 'sending-bot' | 'activating' | 'done'

const STEP_LABEL: Record<Exclude<Step, 'idle' | 'done'>, string> = {
  'sending-usdt': 'Sending USDT…',
  'sending-bot': `Sending ${NATIVE_SYMBOL} for gas…`,
  activating: 'Activating agent…',
}

function Spinner() {
  return <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white" />
}

/** Deposit + activate screen for any agent AgentEco hosts, a buyer task or a seller. */
export function ActivateAgentCard({ agent }: { agent: ApiAgent }) {
  const { address, isConnected, chainId } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const { writeContractAsync } = useWriteContract()
  const { sendTransactionAsync } = useSendTransaction()
  const { data: decimals } = useUsdtDecimals()

  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)
  // Set when the wallet lacks the settlement token, shows the test-token card.
  const [needsTokens, setNeedsTokens] = useState(false)
  const [activated, setActivated] = useState(agent.taskStatus === 'active')
  const [copied, setCopied] = useState(false)

  // A hosted seller only needs gas, it earns USDT, it doesn't spend any.
  const isSeller = agent.role === 'seller'
  const wallet = agent.walletAddress as `0x${string}` | null
  const onCorrectChain = chainId === appChain.id
  const busy = step !== 'idle' && step !== 'done'
  const isDepositor = !!address && !!agent.depositorWallet && address.toLowerCase() === agent.depositorWallet.toLowerCase()

  async function handleCopy() {
    if (!wallet) return
    try {
      await navigator.clipboard.writeText(wallet)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can fail silently (permissions), non-critical, address is shown either way.
    }
  }

  async function handleDepositAndActivate() {
    if (!wallet || !address || decimals === undefined) return
    setError(null)
    setNeedsTokens(false)

    try {
      if (!isSeller) {
        const usdtAmount = parseUnits(agent.maxBudget ?? '0', decimals)
        await assertUsdtBalance(address, usdtAmount, decimals)

        setStep('sending-usdt')
        const usdtHash = await writeContractAsync({
          address: USDT_ADDRESS,
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [wallet, usdtAmount],
        })
        await waitForTransactionReceipt(wagmiConfig, { hash: usdtHash })
      }

      setStep('sending-bot')
      const botHash = await sendTransactionAsync({ to: wallet, value: parseEther(AGENT_GAS_TOPUP) })
      await waitForTransactionReceipt(wagmiConfig, { hash: botHash })

      setStep('activating')
      await activateAgent(agent.id, { address, signMessageAsync })

      setStep('done')
      setActivated(true)
    } catch (err) {
      setStep('idle')
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setNeedsTokens(err instanceof InsufficientTokenError)
    }
  }

  if (activated) {
    return (
      <NeumorphicCard className="mx-auto max-w-[480px] p-8 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#22A06B]/15 text-[#22A06B]">
          <CheckIcon className="h-6 w-6" />
        </span>
        <h2 className="mt-4 text-[18px] font-semibold text-[#F5F5F7]">Agent activated</h2>
        <p className="mt-2 text-[13.5px] text-[#8B8D96]">
          {isSeller
            ? `${agent.name} is now live in the marketplace, it negotiates, executes, and delivers jobs on its own, and pays settled earnings out to your wallet.`
            : `${agent.name} is now live, it will discover a seller, negotiate, fund escrow, and settle on its own.`}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link
            href="/app/agents"
            className="rounded-xl border border-white/[0.08] bg-[#0D0F14] px-4 py-2.5 text-[13px] font-medium text-[#F5F5F7] transition hover:border-white/20"
          >
            View My Agents
          </Link>
        </div>
      </NeumorphicCard>
    )
  }

  return (
    <div className="mx-auto max-w-[560px] space-y-6">
      <div>
        <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[#F5F5F7]">Activate {agent.name}</h2>
        <p className="mt-1 text-[13.5px] text-[#8B8D96]">
          {isSeller
            ? "Top up this agent's own wallet with gas, then activate it. It answers negotiations and executes jobs on its own from here, no further approvals needed."
            : "Fund this agent's own wallet, then activate it. It negotiates, escrows, and settles a purchase on its own from here, no further approvals needed."}
        </p>
      </div>

      <NeumorphicCard className="p-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#151820] text-[#5B5FEF]">
            <WalletIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="text-[12.5px] font-medium text-[#8B8D96]">Agent Wallet Address</div>
            <div className="truncate font-mono text-[13px] text-[#F5F5F7]" title={wallet ?? undefined}>
              {wallet ?? '-'}
            </div>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="ml-auto shrink-0 rounded-lg border border-white/[0.08] bg-[#0B0C11] px-2.5 py-1.5 text-[11.5px] font-medium text-[#8B8D96] transition hover:border-white/20 hover:text-[#F5F5F7]"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <div className="mt-5 space-y-3 text-[13px]">
          {!isSeller && (
            <div className="flex items-center justify-between">
              <span className="text-[#8B8D96]">Required {TOKEN_SYMBOL} (Max Budget)</span>
              <span className="text-[#F5F5F7]">{Number(agent.maxBudget ?? 0).toFixed(2)} {TOKEN_SYMBOL}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-[#8B8D96]">Required {NATIVE_SYMBOL} (gas)</span>
            <span className="text-[#F5F5F7]">~{AGENT_GAS_TOPUP} {NATIVE_SYMBOL}</span>
          </div>
        </div>

        <p className="mt-4 rounded-xl border border-white/[0.06] bg-[#0B0C11]/60 px-3.5 py-2.5 text-[12px] leading-relaxed text-[#8B8D96]">
          {isSeller
            ? `Clicking below prompts one transaction from your wallet: the ${NATIVE_SYMBOL} gas top-up. Once it confirms, the network verifies it on-chain and the agent goes live. Every settled payment is forwarded from the agent wallet to you automatically.`
            : `Clicking below prompts two transactions from your wallet: the ${TOKEN_SYMBOL} deposit, then the ${NATIVE_SYMBOL} gas top-up. Once both confirm, the agent is activated and the network verifies the deposit on-chain before it starts working. Any leftover ${TOKEN_SYMBOL} after negotiation is refunded back to you automatically.`}
        </p>

        {!isConnected ? (
          <p className="mt-5 rounded-xl border border-white/[0.06] bg-[#0D0F14] px-3 py-2.5 text-[12.5px] text-[#8B8D96]">
            Connect your wallet from the top bar to fund and activate this agent.
          </p>
        ) : !onCorrectChain ? (
          <p className="mt-5 rounded-xl border border-[#F59E0B]/30 bg-[#F59E0B]/10 px-3 py-2.5 text-[12.5px] text-[#F59E0B]">
            Switch to {appChain.name} from the top bar to continue.
          </p>
        ) : !isDepositor ? (
          <p className="mt-5 rounded-xl border border-[#F59E0B]/30 bg-[#F59E0B]/10 px-3 py-2.5 text-[12.5px] text-[#F59E0B]">
            Connect the wallet that created this agent to fund and activate it.
          </p>
        ) : (
          <button
            type="button"
            onClick={handleDepositAndActivate}
            disabled={busy || !wallet || decimals === undefined}
            className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#5B5FEF] py-3 text-[13.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? (
              <>
                <Spinner />
                {STEP_LABEL[step as Exclude<Step, 'idle' | 'done'>]}
              </>
            ) : (
              isSeller ? 'Top Up Gas & Activate Agent' : 'Deposit & Activate Agent'
            )}
          </button>
        )}

        {error && <p className="mt-3 text-[12px] leading-relaxed text-[#EF4444]">{error}</p>}
          {needsTokens && (
            <div className="mt-4">
              <GetTestTokensCard reason="Your wallet does not hold enough test tokens for this. Claim some, then try again." />
            </div>
          )}
      </NeumorphicCard>

      <div className="text-center">
        <Link href="/app/agents" className="text-[12.5px] text-[#8B8D96] underline-offset-2 hover:text-[#F5F5F7] hover:underline">
          I&apos;ll fund this later, take me to My Agents
        </Link>
      </div>
    </div>
  )
}
