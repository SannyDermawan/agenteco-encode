import type { Request, Response } from 'express'
import { signerChain, signerClients, chainConfig } from '../../agent-runtime/src/chain/registry.ts'
import {
  UnknownChainError,
  UnsupportedOnChainError,
  chainFamily,
  defaultChainId,
  readAdapter,
  readEvm,
  readSolanaAdapter,
  resolveServedChainId,
  servedChainIds,
  servedChainIdsOf,
} from '../../agent-runtime/src/chain/multi.ts'
import { solanaEntry } from '../../agent-runtime/src/chain/solana-registry.ts'
import { SolanaRpcBackend } from '../../agent-runtime/src/chain/solana-rpc.ts'
import type { ChainId } from '../../agent-runtime/src/chain/types.ts'
import { log } from './log.ts'

// The chains this backend serves (CHAINS, default: NETWORK alone), of either family — see
// agent-runtime/src/chain/multi.ts. `readAdapter` works on any of them; `readChain` is the EVM-only
// adapter (hosted agents, ERC-8004, viem clients) and refuses a Solana chain.
export {
  UnknownChainError,
  UnsupportedOnChainError,
  chainConfig,
  chainFamily,
  defaultChainId,
  readAdapter,
  readSolanaAdapter,
  resolveServedChainId,
  servedChainIds,
  servedChainIdsOf,
  signerChain,
  signerClients,
}
export const readChain = readEvm
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

/** EVM chain ids of every served EVM chain — what a website sign-in may be signed for. */
export function servedEvmChainIds(): number[] {
  return servedChainIdsOf('evm').map((id) => chainConfig(id).chain.id)
}

/** The served chains as the API describes them (GET /chains). `family` tells which kind of chain an entry is. */
export function chainSummaries() {
  return servedChainIds().map((id) => {
    if (chainFamily(id) === 'solana') {
      const e = solanaEntry(id)
      return {
        chainId: id,
        family: 'solana' as const,
        evmChainId: null,
        name: e.name,
        default: id === defaultChainId(),
        // The escrow program, under the name the EVM entries give their contract.
        agentEco: e.config.programId,
        token: { address: e.config.mint, symbol: e.config.tokenSymbol },
        nativeSymbol: e.config.nativeSymbol,
        explorerUrl: e.config.explorerUrl,
        testnet: e.testnet,
        erc8004: null,
      }
    }
    const c = chainConfig(id)
    return {
      chainId: id,
      family: 'evm' as const,
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
/**
 * Throws when a served chain's RPC answers for another chain (a misconfiguration). An RPC that cannot be
 * reached at all is only logged: a public node being down for a minute must not keep the whole backend, and
 * every other chain it serves, from starting.
 */
export async function assertServedChainsMatchRpc(): Promise<void> {
  for (const id of servedChainIds()) {
    if (chainFamily(id) === 'solana') {
      const backend = solanaEntry(id).backend
      // Only an RPC backend can be asked; an in-process one has no genesis to mismatch.
      if (backend instanceof SolanaRpcBackend) {
        let genesis: string
        try {
          genesis = await backend.getGenesisHash()
        } catch (error) {
          log(`RPC check skipped for ${id}: the node did not answer (${error instanceof Error ? error.message : String(error)})`, 'CHAINS')
          continue
        }
        if (!genesis.startsWith(id.slice('solana:'.length))) {
          throw new Error(`The RPC for ${id} reports genesis ${genesis}, which is another cluster.`)
        }
      }
      continue
    }
    const chain = readEvm(id)
    let actual: number
    try {
      actual = await chain.rpcChainId()
    } catch (error) {
      log(`RPC check skipped for ${id}: the node did not answer (${error instanceof Error ? error.message : String(error)})`, 'CHAINS')
      continue
    }
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
