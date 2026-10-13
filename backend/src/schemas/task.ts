import { z } from 'zod'
import { LIMITS } from '../../../agent-runtime/src/shared/capabilities/definitions.ts'
import { CUSTOM_CAPABILITY_ID } from '../../../agent-runtime/src/shared/capabilities/custom.ts'
import { walletSchema } from './wallet.ts'

/** The brief itself is validated against its capability's input schema in the route. */
export const createTaskSchema = z.object({
  /** A platform capability or a published community one (checked in the route). */
  capability: z.string().regex(CUSTOM_CAPABILITY_ID),
  brief: z.unknown(),
  criteria: z.string().max(LIMITS.textChars).optional(),
  price: z.union([z.string(), z.number()]),
  seller: walletSchema,
  /** Optional, the server generates a UUID when omitted. */
  nonce: z.string().uuid().optional(),
})

export const linkTaskEscrowSchema = z.object({
  escrowId: z.string().regex(/^\d+$/),
})
