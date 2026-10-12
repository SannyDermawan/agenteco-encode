'use client'
import { formatUnits, parseUnits } from 'viem'
import { useEscrowFee, usePlatformFee } from '@/lib/chain/hooks'
import { TOKEN_SYMBOL } from '@/lib/web3/network'

/** 250 → "2.5%". */
export function formatFeeRate(bps: number): string {
  return `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
}

/** The fee on `amount` at `bps`, rounded down like AgentEco.sol does. */
function feeOn(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / BigInt(10_000)
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[#8B8D96]" title={hint}>
        {label}
      </span>
      <span className="text-right text-[#F5F5F7]">{value}</span>
    </div>
  )
}

/**
 * Before hiring: the platform fee new escrows pay and what the seller gets.
 * The buyer pays the listed price either way; the fee comes out of the
 * seller's payout, and only when the escrow settles to the seller.
 */
export function PlatformFeeRows({ price, decimals }: { price: number; decimals: number | undefined }) {
  const { data: fee } = usePlatformFee()
  if (!fee || decimals === undefined) return null
  if (fee.bps === 0) return <Row label="Platform fee" value="None" />
  const amount = parseUnits(price.toString(), decimals)
  const toSeller = formatUnits(amount - feeOn(amount, fee.bps), decimals)
  return (
    <>
      <Row
        label={`Platform fee (${formatFeeRate(fee.bps)})`}
        value="Paid by the seller"
        hint="Taken from the seller's payout when the escrow settles. A refund returns your full payment."
      />
      <Row label="Seller receives" value={`${toSeller} ${TOKEN_SYMBOL}`} />
    </>
  )
}

/**
 * On an order: the fee this escrow was created with (fixed for its lifetime)
 * and the seller's share if it settles. Escrows from before the fee (v1, v2) pay none.
 */
export function EscrowFeeBreakdown({ escrowId, amount, decimals }: { escrowId: bigint; amount: bigint; decimals: number | undefined }) {
  const { data } = useEscrowFee(escrowId)
  if (!data || decimals === undefined) return null
  const [rate, fee] = data
  return (
    <div className="mt-3 space-y-1.5 border-t border-white/[0.06] pt-3 text-[12px]">
      {rate === BigInt(0) ? (
        <Row label="Platform fee" value="None" hint="This escrow was created before the platform fee, or with a 0% rate." />
      ) : (
        <>
          <Row
            label={`Platform fee (${formatFeeRate(Number(rate))})`}
            value={`${formatUnits(fee, decimals)} ${TOKEN_SYMBOL}`}
            hint="Paid to the AgentEco treasury only if the escrow settles to the seller. Refunds carry no fee."
          />
          <Row label="Seller receives" value={`${formatUnits(amount - fee, decimals)} ${TOKEN_SYMBOL}`} />
        </>
      )}
    </div>
  )
}
