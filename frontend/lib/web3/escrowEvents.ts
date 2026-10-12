'use client'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { decodeEventLog, toHex, type Address, type Hash, type Hex } from 'viem'
import { AGENT_ECO_ABI, AGENT_ECO_ADDRESS, FIRST_ESCROW_ID, LEGACY_DEPLOYMENTS, agentEcoFor } from './abi'
import { appChain } from './chain'
import { DEPLOY_BLOCK, LOG_HISTORY_BLOCKS, LOG_RANGE } from './network'

// Block AgentEco.sol was deployed at — no escrow event can predate it, so
// every log scan starts here instead of at genesis. Per network, see ./network.ts.
export const AGENT_ECO_DEPLOY_BLOCK = DEPLOY_BLOCK
// eth_getLogs span per call — each RPC caps it (PublicNode on BSC Testnet:
// 50,000 blocks), so every scan walks the chain in chunks. See ./network.ts.
const LOG_CHUNK = LOG_RANGE

export { explorerTxUrl } from './network'

type PublicClient = NonNullable<ReturnType<typeof usePublicClient>>

/**
 * Walks the chain in LOG_CHUNK steps — but never further back than the RPC
 * still serves logs (PublicNode on BSC Testnet prunes after ~80,000 blocks).
 * Only explorer links rely on logs; escrow discovery reads contract state.
 */
async function forEachRecentChunk(client: PublicClient, fn: (fromBlock: bigint, toBlock: bigint) => Promise<void>) {
  const head = await client.getBlockNumber()
  const oldestServed = LOG_HISTORY_BLOCKS === null ? BigInt(0) : head - LOG_HISTORY_BLOCKS
  const start = AGENT_ECO_DEPLOY_BLOCK > oldestServed ? AGENT_ECO_DEPLOY_BLOCK : oldestServed
  for (let from = start; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - BigInt(1) < head ? from + LOG_CHUNK - BigInt(1) : head
    await fn(from, to)
  }
}

export interface EscrowBasic {
  escrowId: bigint
  buyer: Address
  seller: Address
  amount: bigint
  status: number
}

const MULTICALL_BATCH = 200

async function idsOn(client: PublicClient, address: Address, first: bigint, cap?: bigint): Promise<bigint[]> {
  const next = await client.readContract({ address, abi: AGENT_ECO_ABI, functionName: 'nextEscrowId' })
  const end = cap !== undefined && cap < next ? cap : next
  const ids: bigint[] = []
  for (let id = first; id < end; id++) ids.push(id)
  return ids
}

/**
 * Every escrow, from contract state: each legacy deployment's id range (v1
 * 1..1000, v2 1001..2000, still read there), then the current one's from
 * FIRST_ESCROW_ID; each is read through getEscrowBasic (batched with
 * Multicall3). No event logs, so it keeps working after the RPC prunes history.
 */
async function readAllEscrows(client: PublicClient): Promise<EscrowBasic[]> {
  const lists = await Promise.all([
    ...LEGACY_DEPLOYMENTS.map((d) => idsOn(client, d.address, d.firstEscrowId, d.endEscrowId)),
    idsOn(client, AGENT_ECO_ADDRESS, FIRST_ESCROW_ID),
  ])
  const ids = lists.flat()

  const out: EscrowBasic[] = []
  for (let i = 0; i < ids.length; i += MULTICALL_BATCH) {
    const chunk = ids.slice(i, i + MULTICALL_BATCH)
    const calls = chunk.map((id) => ({
      address: agentEcoFor(id),
      abi: AGENT_ECO_ABI,
      functionName: 'getEscrowBasic' as const,
      args: [id] as const,
    }))
    const results = appChain.contracts?.multicall3
      ? await client.multicall({ contracts: calls, allowFailure: false })
      : await Promise.all(calls.map((c) => client.readContract(c)))
    results.forEach(([buyer, seller, amount, status], j) => {
      out.push({ escrowId: chunk[j], buyer, seller, amount, status: Number(status) })
    })
  }
  return out
}

/**
 * Every escrow where any of `addresses` is the buyer or the seller — read from
 * contract state, so it includes direct "Request Service" hires that never get
 * an Order row in the database.
 */
export function useEscrowsInvolving(addresses: string[]) {
  const client = usePublicClient({ chainId: appChain.id })
  const normalized = [...new Set(addresses.map((a) => a.toLowerCase()))].sort()

  return useQuery({
    queryKey: ['escrowsInvolving', normalized],
    enabled: !!client && normalized.length > 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const mine = new Set(normalized)
      return (await readAllEscrows(client!)).filter(
        (e) => mine.has(e.buyer.toLowerCase()) || mine.has(e.seller.toLowerCase())
      )
    },
  })
}

export interface DisputeSummary {
  escrowId: bigint
  buyer: Address
  seller: Address
  amount: bigint
  /** Live AgentEco.sol status — 4 DISPUTED while open, 5/6 once resolved. */
  status: number
  raisedAt: number // unix ms
  /** On-chain dispute deadline (unix ms); after it anyone can refund the buyer. */
  deadline: number
  /** Only while the RPC still serves that block's logs. */
  raisedTx?: Hash
  resolution?: {
    releasedToSeller: boolean
    /** Refunded by claimDisputeTimeout rather than an arbiter ruling. */
    byTimeout: boolean
    tx?: Hash
  }
}

// AgentEco.sol OrderStatus
const DISPUTED = 4
const SETTLED = 5
const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'

/**
 * Every dispute ever raised — the arbiter's inbox. Found from contract state
 * (disputedAt != 0), with transaction links added from logs where the RPC
 * still has them. `enabled` lets non-arbiters skip the reads entirely.
 */
export function useDisputes(enabled: boolean) {
  const client = usePublicClient({ chainId: appChain.id })

  return useQuery({
    queryKey: ['disputes'],
    enabled: enabled && !!client,
    refetchInterval: 15_000,
    queryFn: async (): Promise<DisputeSummary[]> => {
      const escrows = (await readAllEscrows(client!)).filter((e) => e.status >= DISPUTED)
      const details = await Promise.all(
        escrows.map(async (e) => {
          const [info, hashes] = await Promise.all([
            client!.readContract({ address: agentEcoFor(e.escrowId), abi: AGENT_ECO_ABI, functionName: 'getEscrowDisputeInfo', args: [e.escrowId] }),
            client!.readContract({ address: agentEcoFor(e.escrowId), abi: AGENT_ECO_ABI, functionName: 'getEscrowHashes', args: [e.escrowId] }),
          ])
          return { e, disputedAt: info[0], disputeDeadline: info[1], resolutionHash: hashes[4] }
        })
      )
      const disputed = details.filter((d) => d.disputedAt > BigInt(0))

      const raisedTx = new Map<string, Hash>()
      const resolvedTx = new Map<string, Hash>()
      if (disputed.length) {
        await forEachRecentChunk(client!, async (fromBlock, toBlock) => {
          const [r, s] = await Promise.all([
            client!.getContractEvents({ address: AGENT_ECO_ADDRESS, abi: AGENT_ECO_ABI, eventName: 'DisputeRaised', fromBlock, toBlock }),
            client!.getContractEvents({ address: AGENT_ECO_ADDRESS, abi: AGENT_ECO_ABI, eventName: 'DisputeResolved', fromBlock, toBlock }),
          ])
          for (const log of r) if (log.args.escrowId !== undefined) raisedTx.set(log.args.escrowId.toString(), log.transactionHash)
          for (const log of s) if (log.args.escrowId !== undefined) resolvedTx.set(log.args.escrowId.toString(), log.transactionHash)
        }).catch(() => {
          // Links are a nice-to-have; the inbox itself comes from contract state.
        })
      }

      const summaries = disputed.map(({ e, disputedAt, disputeDeadline, resolutionHash }): DisputeSummary => {
        const key = e.escrowId.toString()
        const open = e.status === DISPUTED
        return {
          escrowId: e.escrowId,
          buyer: e.buyer,
          seller: e.seller,
          amount: e.amount,
          status: e.status,
          raisedAt: Number(disputedAt) * 1000,
          deadline: Number(disputeDeadline) * 1000,
          raisedTx: raisedTx.get(key),
          resolution: open
            ? undefined
            : { releasedToSeller: e.status === SETTLED, byTimeout: resolutionHash === ZERO_HASH, tx: resolvedTx.get(key) },
        }
      })
      // Open disputes oldest-first (longest waiting on top); resolved ones newest-first.
      const openOnes = summaries.filter((d) => d.status === DISPUTED).sort((a, b) => a.raisedAt - b.raisedAt)
      const closed = summaries.filter((d) => d.status !== DISPUTED).sort((a, b) => b.raisedAt - a.raisedAt)
      return [...openOnes, ...closed]
    },
  })
}

export interface EscrowTxHashes {
  /** Aligned with OnChainTimeline's steps: CREATED, FUNDED, EXECUTING, DELIVERED, SETTLED. */
  steps: (Hash | undefined)[]
  refund?: Hash
}

// Which lifecycle event marks each timeline step. SETTLED can be reached by
// the buyer accepting, the review window expiring, or an arbiter ruling.
const STEP_EVENTS: string[][] = [
  ['EscrowCreated'],
  ['EscrowFunded'],
  ['ExecutionStarted'],
  ['ResultDelivered'],
  ['EscrowSettled', 'ReviewFinalized', 'DisputeResolvedForSeller'],
]
const REFUND_EVENTS = ['EscrowRefunded', 'AcceptTimedOut', 'ExecutionTimedOut', 'DisputeTimedOut', 'DisputeResolvedForBuyer']

/**
 * The transaction behind each lifecycle step of one escrow, for explorer links.
 * Steps older than the RPC's log history simply have no link.
 */
export function useEscrowTxHashes(escrowId?: bigint) {
  const client = usePublicClient({ chainId: appChain.id })

  return useQuery({
    queryKey: ['escrowTxHashes', escrowId?.toString()],
    enabled: !!client && escrowId !== undefined,
    // Hosted agents advance escrows on their own, so keep picking up new steps.
    refetchInterval: 10_000,
    queryFn: async (): Promise<EscrowTxHashes> => {
      const firstHashByEvent = new Map<string, Hash>()
      await forEachRecentChunk(client!, async (fromBlock, toBlock) => {
        // Every AgentEco event indexes escrowId as its first topic — one
        // unfiltered-by-event query catches the escrow's whole lifecycle.
        const logs = await client!.request({
          method: 'eth_getLogs',
          params: [
            {
              address: agentEcoFor(escrowId!),
              fromBlock: toHex(fromBlock),
              toBlock: toHex(toBlock),
              topics: [null, toHex(escrowId!, { size: 32 })],
            },
          ],
        })
        for (const log of logs) {
          try {
            const decoded = decodeEventLog({ abi: AGENT_ECO_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
            // A ruling settles or refunds depending on who it released to.
            const eventName =
              decoded.eventName === 'DisputeResolved'
                ? (decoded.args as { releasedToSeller: boolean }).releasedToSeller
                  ? 'DisputeResolvedForSeller'
                  : 'DisputeResolvedForBuyer'
                : decoded.eventName
            if (!firstHashByEvent.has(eventName) && log.transactionHash) firstHashByEvent.set(eventName, log.transactionHash)
          } catch {
            // Not an AgentEco event we know about — nothing to link.
          }
        }
      })

      const pick = (names: string[]) => names.map((n) => firstHashByEvent.get(n)).find(Boolean)
      return { steps: STEP_EVENTS.map(pick), refund: pick(REFUND_EVENTS) }
    },
  })
}
