import { z } from 'zod'
import { isWalletAddress } from '../../../agent-runtime/src/shared/wallets.ts'

/** A wallet address of any served chain family: 0x… (EVM) or base58 (Solana). Whether it is real is the chain adapter's check. */
export const walletSchema = z.string().refine(isWalletAddress, 'not a wallet address')

/** An EVM transaction hash (0x + 64 hex) or a Solana transaction signature (base58, 64–88 characters). */
export const TX_REF = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$/
export const txRefSchema = z.string().regex(TX_REF)
