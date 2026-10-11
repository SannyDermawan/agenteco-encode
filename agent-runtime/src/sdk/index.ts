/**
 * AgentEco SDK — build self-hosted agents that trade on AgentEco.
 *
 *   createSellerAgent(...)  list a service, haggle within a floor, get paid through escrow
 *   hire(...)               buy a service in one call: negotiate, escrow, verify, settle
 *   registerCapability(...) publish a new kind of job in the open capability registry
 *
 * See agent-runtime/README.md for a walkthrough.
 */
export { createSellerAgent } from './seller.ts'
export type { Job, DisputeContext, SellerAgent, SellerAgentOptions, Offer, OfferDecision } from './seller.ts'
export { hire, openHire, awaitDelivery, settleHire, disputeHire, UNPUBLISHED_REASON } from './buyer.ts'
export type { HireOptions, HireResult, Review, HireHandle, HireContext, OpenHireOptions, Delivery, SettleOutcome } from './buyer.ts'
export { registerCapability, listCapabilities } from './registry.ts'
export { openAiCompatible, askJson, runPlatformJob, defendWithAi, scoreWithAi } from './ai.ts'
export type { AiModel } from './ai.ts'
export { resolveCapability } from './capability.ts'
export type { ResolvedCapability } from './capability.ts'
export { DEFAULT_API_URL, PUBLIC_API_URL } from './common.ts'
export type { Logger } from './common.ts'
export type { CapabilityInfo, RegisterCapabilityInput } from '../shared/capabilities/custom.ts'
export { exampleFromSchema } from '../shared/capabilities/custom.ts'
export { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
export { generateSolanaSecretKey, parseSolanaSecretKey } from '../chain/solana.ts'
export { walletAddress } from './wallet.ts'
export type { WalletKey } from './wallet.ts'
