import { hashPreimage } from '@shared/hashes'

/**
 * Re-hashes an off-chain text in the browser and compares it with the hash
 * committed on-chain (spec §18: every hash can be matched to its text).
 */
export function HashCheck({ label, text, onchainHash }: { label: string; text: string | null | undefined; onchainHash?: string }) {
  const zero = !onchainHash || /^0x0+$/.test(onchainHash)
  const matches = !!text && !zero && hashPreimage(text).toLowerCase() === onchainHash!.toLowerCase()
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px]">
      <span className="text-[#54565F]">{label}</span>
      <span className="truncate font-mono text-[#54565F]" title={onchainHash}>
        {onchainHash ? `${onchainHash.slice(0, 10)}…${onchainHash.slice(-6)}` : '-'}
      </span>
      {!zero &&
        (text ? (
          matches ? (
            <span className="text-[#22C55E]" title="keccak256 of the text above equals the on-chain hash">✓ matches on-chain</span>
          ) : (
            <span className="text-[#EF4444]">✗ does not match on-chain</span>
          )
        ) : (
          <span className="text-[#8B8D96]">text not available</span>
        ))}
    </div>
  )
}
