import { z } from 'zod'

export const listOrdersQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  ownerWallet: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  status: z.enum(['agreed', 'funded']).optional(),
  // One chain's orders only (CAIP-2 id, network name or EVM chain id).
  chain: z.string().min(1).optional(),
})

export const fundOrderSchema = z.object({
  escrowId: z.string().regex(/^\d{1,30}$/, 'escrowId must be a number'),
})
