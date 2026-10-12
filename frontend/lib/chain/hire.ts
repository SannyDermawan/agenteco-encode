import { HIRE_STEP_LABEL as EVM_LABELS, hireWithTask as evmHire, type HireInput, type HireStep as EvmStep } from '@/lib/web3/hireWithTask'
import { hireWithTask as solanaHire } from '@/lib/solana/hire'
import { FAMILY } from '@/lib/web3/network'

export type { HireInput }
export type HireStep = EvmStep

/** A human buyer's whole hire (task → escrow → funded → linked), on whichever kind of chain the selected network is. */
export const hireWithTask = FAMILY === 'solana' ? solanaHire : evmHire

/** Solana funds in the same transaction that creates the escrow, so its steps are fewer and one label differs. */
export const HIRE_STEP_LABEL: Record<HireStep, string> =
  FAMILY === 'solana' ? { ...EVM_LABELS, creating: 'Creating and funding escrow (approve in your wallet)…' } : EVM_LABELS
