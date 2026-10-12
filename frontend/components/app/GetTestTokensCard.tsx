'use client'
import { useEffect, useState } from 'react'
import { formatEther, formatUnits, parseEther } from 'viem'
import { useAccount, useBalance, useReadContract, useSwitchChain, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { NeumorphicCard } from './NeumorphicCard'
import { wagmiConfig } from '@/lib/web3/config'
import { appChain } from '@/lib/web3/chain'
import { MOCK_USDT_ABI, USDT_ADDRESS } from '@/lib/web3/abi'
import { useUsdtBalance, useUsdtDecimals } from '@/lib/web3/hooks'
import { explorerTxUrl } from '@/lib/web3/escrowEvents'
import { FAMILY, GAS_FAUCETS, MIN_NATIVE_BALANCE, NATIVE_SYMBOL, TOKEN_HAS_FAUCET, TOKEN_SYMBOL } from '@/lib/web3/network'
import { SolanaFundingCard } from './SolanaFunding'

function formatCountdown(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000))
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return h ? `${h}h ${m}m` : `${m}m`
}

/**
 * Test tokens for this network: native gas from an external faucet (links),
 * and mUSDT from MockUSDT.faucet() right here — 100 per wallet every 24h.
 * Renders nothing on networks whose token has no faucet (BOT Chain).
 */
function EvmGetTestTokensCard({ reason }: { reason?: string }) {
  const { address, isConnected, chainId } = useAccount()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const { data: decimals } = useUsdtDecimals()

  const native = useBalance({ address, chainId: appChain.id, query: { enabled: !!address } })
  const token = useUsdtBalance(address)
  const nextClaim = useReadContract({
    address: USDT_ADDRESS,
    abi: MOCK_USDT_ABI,
    functionName: 'nextClaimAt',
    args: address ? [address] : undefined,
    query: { enabled: !!address && TOKEN_HAS_FAUCET },
  })

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const [claiming, setClaiming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [claimTx, setClaimTx] = useState<string | null>(null)

  if (!TOKEN_HAS_FAUCET) return null

  const onCorrectChain = chainId === appChain.id
  const lowGas = native.data !== undefined && native.data.value < parseEther(String(MIN_NATIVE_BALANCE))
  const nextClaimAtMs = nextClaim.data ? Number(nextClaim.data) * 1000 : 0
  const cooling = nextClaimAtMs > now

  async function handleClaim() {
    setError(null)
    setClaimTx(null)
    setClaiming(true)
    try {
      const hash = await writeContractAsync({ address: USDT_ADDRESS, abi: MOCK_USDT_ABI, functionName: 'faucet' })
      await waitForTransactionReceipt(wagmiConfig, { hash })
      setClaimTx(hash)
      await Promise.all([token.refetch(), native.refetch(), nextClaim.refetch()])
    } catch (err) {
      setError(err instanceof Error ? err.message.split('\n')[0] : 'Claim failed. Please try again.')
    } finally {
      setClaiming(false)
    }
  }

  return (
    <NeumorphicCard className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-[#F5F5F7]">Get test tokens</h3>
          <p className="mt-1 max-w-[520px] text-[12.5px] leading-relaxed text-[#8B8D96]">
            {reason ??
              `AgentEco on ${appChain.name} settles in ${TOKEN_SYMBOL}, a test token made by AgentEco — it has no value. You need a little ${NATIVE_SYMBOL} for gas and some ${TOKEN_SYMBOL} to hire agents.`}
          </p>
        </div>
        {isConnected && onCorrectChain && (
          <div className="flex gap-4 text-right text-[12px]">
            <div>
              <div className="font-semibold text-[#F5F5F7]">
                {native.data ? Number(formatEther(native.data.value)).toFixed(4) : '…'}
              </div>
              <div className="text-[#8B8D96]">{NATIVE_SYMBOL}</div>
            </div>
            <div>
              <div className="font-semibold text-[#F5F5F7]">
                {token.data !== undefined && decimals !== undefined ? Number(formatUnits(token.data, decimals)).toFixed(2) : '…'}
              </div>
              <div className="text-[#8B8D96]">{TOKEN_SYMBOL}</div>
            </div>
          </div>
        )}
      </div>

      {!isConnected ? (
        <p className="mt-4 text-[12.5px] text-[#8B8D96]">Connect your wallet from the top bar to claim test tokens.</p>
      ) : !onCorrectChain ? (
        <button
          type="button"
          onClick={() => switchChain({ chainId: appChain.id })}
          disabled={isSwitching}
          className="mt-4 rounded-xl border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-4 py-2 text-[13px] font-medium text-[#F59E0B] transition hover:bg-[#F59E0B]/15 disabled:opacity-60"
        >
          {isSwitching ? 'Switching…' : `Switch to ${appChain.name}`}
        </button>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="rounded-xl border border-white/[0.06] bg-[#0B0C11]/60 p-3.5">
            <div className="text-[12.5px] font-medium text-[#F5F5F7]">
              1. {NATIVE_SYMBOL} for gas {lowGas ? '— you need some first' : '✓'}
            </div>
            {lowGas && (
              <p className="mt-1 text-[12px] text-[#F59E0B]">
                You need {NATIVE_SYMBOL} for gas (at least {MIN_NATIVE_BALANCE}). Claim it from a faucet, then come back.
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {GAS_FAUCETS.map((f) => (
                <a
                  key={f.url}
                  href={f.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg border border-white/[0.08] bg-[#11141B] px-3 py-1.5 text-[12px] text-[#F5F5F7] transition hover:border-[#5B5FEF]/40"
                >
                  {f.label} ↗
                </a>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-[#0B0C11]/60 p-3.5">
            <div className="text-[12.5px] font-medium text-[#F5F5F7]">2. Claim 100 {TOKEN_SYMBOL}</div>
            <p className="mt-1 text-[12px] text-[#8B8D96]">Once per wallet every 24 hours, straight from the token contract.</p>
            <button
              type="button"
              onClick={handleClaim}
              disabled={claiming || lowGas || cooling || native.data === undefined}
              className="mt-2.5 rounded-xl bg-[#5B5FEF] px-4 py-2 text-[13px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {claiming
                ? 'Claiming…'
                : cooling
                  ? `Next claim in ${formatCountdown(nextClaimAtMs - now)}`
                  : `Claim 100 ${TOKEN_SYMBOL}`}
            </button>
            {claimTx && (
              <p className="mt-2 text-[12px] text-[#22A06B]">
                Claimed.{' '}
                <a href={explorerTxUrl(claimTx)} target="_blank" rel="noopener noreferrer" className="underline">
                  View transaction ↗
                </a>
              </p>
            )}
            {error && <p className="mt-2 text-[12px] text-[#EF4444]">{error}</p>}
          </div>
        </div>
      )}
    </NeumorphicCard>
  )
}

/** Test tokens for the selected network, of either family. */
export const GetTestTokensCard = FAMILY === 'solana' ? SolanaFundingCard : EvmGetTestTokensCard
