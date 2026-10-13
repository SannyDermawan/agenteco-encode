'use client'
import { useEffect, useState } from 'react'
import { formatEther, formatUnits, parseEther, parseUnits } from 'viem'
import { useAccount, useBalance, useReadContract, useSwitchChain, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { NeumorphicCard } from './NeumorphicCard'
import { wagmiConfig } from '@/lib/web3/config'
import { appChain } from '@/lib/web3/chain'
import { MOCK_USDT_ABI, USDT_ADDRESS } from '@/lib/web3/abi'
import { useUsdtBalance, useUsdtDecimals } from '@/lib/web3/hooks'
import { explorerTxUrl } from '@/lib/web3/escrowEvents'
import { FAMILY, GAS_FAUCETS, MIN_NATIVE_BALANCE, NATIVE_SYMBOL, NO_GAS_TOKEN, TOKEN_HAS_FAUCET, TOKEN_SYMBOL } from '@/lib/web3/network'
import { SolanaFundingCard } from './SolanaFunding'

function formatCountdown(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000))
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return h ? `${h}h ${m}m` : `${m}m`
}

/** Below this much of the settlement token a wallet is shown as short of it (enough for a few jobs). */
const ENOUGH_TOKEN = 1

const LINK_CLASS =
  'rounded-lg border border-white/[0.08] bg-[#11141B] px-3 py-1.5 text-[12px] text-[#F5F5F7] transition hover:border-[#5B5FEF]/40'

/** Faucets that hand out the native gas token / the settlement token (a faucet with no tag gives both). */
const gasLinks = GAS_FAUCETS.filter((f) => (f.provides ?? 'both') !== 'token')
const tokenLinks = GAS_FAUCETS.filter((f) => (f.provides ?? 'both') !== 'gas')

function FaucetLinks({ links }: { links: typeof GAS_FAUCETS }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {links.map((f) => (
        <a key={f.url + f.label} href={f.url} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
          {f.label} ↗
        </a>
      ))}
    </div>
  )
}

/** The connected wallet's address with a copy button: every faucet asks for it. */
function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard blocked: the address is on screen to select by hand.
    }
  }
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.06] bg-[#0B0C11]/60 px-3.5 py-2.5 text-[12px]">
      <span className="text-[#8B8D96]">Your wallet:</span>
      <code className="break-all text-[#F5F5F7]">{address}</code>
      <button type="button" onClick={copy} className="rounded-md border border-white/[0.1] px-2 py-0.5 text-[11.5px] text-[#C9CBFF] transition hover:border-[#5B5FEF]/50">
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  )
}

/**
 * Test tokens for this network. On BSC Testnet: native gas from an external faucet (links) and mUSDT
 * from MockUSDT.faucet() right here, 100 per wallet every 24h. On every other EVM network the
 * settlement token is a real test token (Circle's USDC, Tempo's AlphaUSD, BOT's USDT) with no faucet
 * contract of ours, so the card says what each token is for and links the faucets that hand them out.
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

  const onCorrectChain = chainId === appChain.id
  const lowGas = !NO_GAS_TOKEN && native.data !== undefined && native.data.value < parseEther(String(MIN_NATIVE_BALANCE))
  const lowToken = token.data !== undefined && decimals !== undefined && token.data < parseUnits(String(ENOUGH_TOKEN), decimals)
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

  const balances =
    isConnected && onCorrectChain ? (
      <div className="flex gap-4 text-right text-[12px]">
        {!NO_GAS_TOKEN && (
          <div>
            <div className="font-semibold text-[#F5F5F7]">{native.data ? Number(formatEther(native.data.value)).toFixed(4) : '…'}</div>
            <div className="text-[#8B8D96]">{NATIVE_SYMBOL}</div>
          </div>
        )}
        <div>
          <div className="font-semibold text-[#F5F5F7]">
            {token.data !== undefined && decimals !== undefined ? Number(formatUnits(token.data, decimals)).toFixed(2) : '…'}
          </div>
          <div className="text-[#8B8D96]">{TOKEN_SYMBOL}</div>
        </div>
      </div>
    ) : null

  const switchButton =
    isConnected && !onCorrectChain ? (
      <button
        type="button"
        onClick={() => switchChain({ chainId: appChain.id })}
        disabled={isSwitching}
        className="mt-4 rounded-xl border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-4 py-2 text-[13px] font-medium text-[#F59E0B] transition hover:bg-[#F59E0B]/15 disabled:opacity-60"
      >
        {isSwitching ? 'Switching…' : `Switch to ${appChain.name}`}
      </button>
    ) : null

  // Every network but BSC Testnet: say what the tokens are for, and where to get them.
  if (!TOKEN_HAS_FAUCET) {
    return (
      <NeumorphicCard className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-semibold text-[#F5F5F7]">Get free test tokens on {appChain.name}</h3>
            <p className="mt-1 max-w-[560px] text-[12.5px] leading-relaxed text-[#8B8D96]">
              {reason ? `${reason} ` : ''}
              {NO_GAS_TOKEN
                ? `${appChain.name} has no gas token of its own: network fees are paid in test stablecoins. One faucet gives you ${TOKEN_SYMBOL} to pay the agents you hire, plus pathUSD for the fees. They have no value.`
                : `These are test tokens with no value. ${NATIVE_SYMBOL} pays the network fee (gas) of every transaction; ${TOKEN_SYMBOL} is what you pay an agent when you hire it, and what a hosted agent is funded with.`}
            </p>
          </div>
          {balances}
        </div>

        {isConnected && address ? <CopyAddress address={address} /> : <p className="mt-4 text-[12.5px] text-[#8B8D96]">Connect your wallet from the top bar: the faucets ask for its address.</p>}
        {switchButton}

        <div className="mt-4 space-y-3">
          {NO_GAS_TOKEN ? (
            <div className="rounded-xl border border-white/[0.06] bg-[#0B0C11]/60 p-3.5">
              <div className="text-[12.5px] font-medium text-[#F5F5F7]">
                Test stablecoins for fees and payments {onCorrectChain && isConnected && !lowToken && token.data !== undefined ? '✓' : ''}
              </div>
              <FaucetLinks links={tokenLinks} />
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-white/[0.06] bg-[#0B0C11]/60 p-3.5">
                <div className="text-[12.5px] font-medium text-[#F5F5F7]">
                  1. {NATIVE_SYMBOL} for gas {onCorrectChain && isConnected && native.data !== undefined ? (lowGas ? '(you need some first)' : '✓') : ''}
                </div>
                {lowGas && (
                  <p className="mt-1 text-[12px] text-[#F59E0B]">
                    You need {NATIVE_SYMBOL} for gas (at least {MIN_NATIVE_BALANCE}). Get it from a faucet, then come back.
                  </p>
                )}
                <FaucetLinks links={gasLinks} />
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-[#0B0C11]/60 p-3.5">
                <div className="text-[12.5px] font-medium text-[#F5F5F7]">
                  2. {TOKEN_SYMBOL} to hire agents {onCorrectChain && isConnected && token.data !== undefined ? (lowToken ? '(you need some)' : '✓') : ''}
                </div>
                <FaucetLinks links={tokenLinks} />
              </div>
            </>
          )}
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed text-[#6F7280]">
          Faucets are run by other teams: most limit how much you can take each day, and some ask you to prove you are a person. Come back here when it arrives; balances update by themselves.
        </p>
      </NeumorphicCard>
    )
  }

  return (
    <NeumorphicCard className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-[#F5F5F7]">Get test tokens</h3>
          <p className="mt-1 max-w-[520px] text-[12.5px] leading-relaxed text-[#8B8D96]">
            {reason ??
              `AgentEco on ${appChain.name} settles in ${TOKEN_SYMBOL}, a test token made by AgentEco, it has no value. You need a little ${NATIVE_SYMBOL} for gas and some ${TOKEN_SYMBOL} to hire agents.`}
          </p>
        </div>
        {balances}
      </div>

      {!isConnected ? (
        <p className="mt-4 text-[12.5px] text-[#8B8D96]">Connect your wallet from the top bar to claim test tokens.</p>
      ) : !onCorrectChain ? (
        switchButton
      ) : (
        <div className="mt-4 space-y-3">
          <div className="rounded-xl border border-white/[0.06] bg-[#0B0C11]/60 p-3.5">
            <div className="text-[12.5px] font-medium text-[#F5F5F7]">
              1. {NATIVE_SYMBOL} for gas {lowGas ? '(you need some first)' : '✓'}
            </div>
            {lowGas && (
              <p className="mt-1 text-[12px] text-[#F59E0B]">
                You need {NATIVE_SYMBOL} for gas (at least {MIN_NATIVE_BALANCE}). Claim it from a faucet, then come back.
              </p>
            )}
            <FaucetLinks links={gasLinks} />
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
              {claiming ? 'Claiming…' : cooling ? `Next claim in ${formatCountdown(nextClaimAtMs - now)}` : `Claim 100 ${TOKEN_SYMBOL}`}
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
