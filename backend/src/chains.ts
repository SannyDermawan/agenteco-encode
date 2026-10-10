import type { Request, Response } from 'express'
import {
  UnknownChainError,
  chainConfig,
  defaultChainId,
  readChain,
  resolveServedChainId,
  servedChainIds,
} from '../../agent-runtime/src/chain/registry.ts'
import type { ChainId } from '../../agent-runtime/src/chain/types.ts'

// The chains this backend serves (CHAINS, default: NETWORK alone) — see agent-runtime/src/chain/registry.ts.
export {
  UnknownChainError,
  chainConfig,
  defaultChainId,
  readChain,
  resolveServedChainId,
  servedChainIds,
  signerChain,
  signerClients,
} from '../../agent-runtime/src/chain/registry.ts'
export type { ChainId } from '../../agent-runtime/src/chain/types.ts'

/**
 * The chain a request is about: a `chainId` in the JSON body, else a `?chain=` query
 * parameter (CAIP-2 id, network name or EVM chain id), else the default chain — so a
 * client that never names a chain keeps working against the primary one. An unknown or
 * unserved chain is answered with 400 and undefined is returned.
 */
export function requestChain(req: Request, res: Response): ChainId | undefined {
  const raw: unknown = (req.body && typeof req.body === 'object' ? (req.body as { chainId?: unknown }).chainId : undefined) ?? req.query.chain
  if (raw !== undefined && typeof raw !== 'string' && typeof raw !== 'number') {
    res.status(400).json({ error: 'chain must be a chain id such as eip155:97' })
    return undefined
  }
  try {
    return resolveServedChainId(raw)
  } catch (error) {
    if (!(error instanceof UnknownChainError)) throw error
    res.status(400).json({ error: error.message })
    return undefined
  }
}

/** EVM chain ids of every served chain — what a website sign-in may be signed for. */
export function servedEvmChainIds(): number[] {
  return servedChainIds().map((id) => chainConfig(id).chain.id)
}

/** The served chains as the API describes them (GET /chains). */
export function chainSummaries() {
  return servedChainIds().map((id) => {
    const c = chainConfig(id)
    return {
      chainId: id,
      evmChainId: c.chain.id,
      name: c.chain.name,
      default: id === defaultChainId(),
      agentEco: c.agentEco,
      token: { address: c.usdt, symbol: c.tokenSymbol },
      nativeSymbol: c.nativeSymbol,
      explorerUrl: c.explorerUrl,
      testnet: c.chain.testnet ?? false,
      // ERC-8004 registries on this chain (null = none configured).
      erc8004: c.erc8004,
    }
  })
}

/**
 * Refuses to run against an RPC that reports another chain than the one it is configured
 * for — e.g. a mainnet process accidentally given a testnet RPC. Checks every served chain.
 */
export async function assertServedChainsMatchRpc(): Promise<void> {
  for (const id of servedChainIds()) {
    const chain = readChain(id)
    const actual = await chain.rpcChainId()
    if (actual !== chain.config.chain.id) {
      throw new Error(`The RPC for ${id} reports chain id ${actual}, but ${chain.config.chain.name} is ${chain.config.chain.id}.`)
    }
  }
}

/** An optional `?chain=` list filter: undefined when absent, the CAIP-2 id when served; 400 (and null) otherwise. */
export function optionalChainFilter(raw: string | undefined, res: Response): ChainId | undefined | null {
  if (!raw) return undefined
  try {
    return resolveServedChainId(raw)
  } catch (error) {
    if (!(error instanceof UnknownChainError)) throw error
    res.status(400).json({ error: error.message })
    return null
  }
}
