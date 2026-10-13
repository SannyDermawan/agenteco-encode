import { decodeEventLog, erc20Abi, formatEther, formatUnits, type Hex, type Log, type PublicClient } from 'viem'
import { AGENT_ECO_ABI } from '../shared/abi.generated.ts'
import { LIMITS, type TxFacts } from '../shared/capabilities/definitions.ts'
import { InvalidInputError } from './dataAnalysis.ts'

export interface TokenInfo {
  symbol: string
  decimals: number
}

type DecodedEvent = TxFacts['decodedEvents'][number]

function stringify(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return `[${value.map(stringify).join(', ')}]`
  return String(value)
}

/**
 * Decodes ERC-20 Transfer/Approval and AgentEco events from receipt logs,
 * pure, no I/O. Token amounts are shown with their symbol when `tokens` knows
 * the contract. At most LIMITS.txLogs logs are decoded; the rest are counted.
 */
export function decodeLogs(
  logs: Pick<Log, 'address' | 'data' | 'topics'>[],
  agentEcoAddress: string,
  tokens: Map<string, TokenInfo>
): { decodedEvents: DecodedEvent[]; otherLogs: number } {
  const decodedEvents: DecodedEvent[] = []
  let otherLogs = 0
  for (const log of logs.slice(0, LIMITS.txLogs)) {
    const topics = log.topics as [Hex, ...Hex[]]
    const isAgentEco = log.address.toLowerCase() === agentEcoAddress.toLowerCase()
    try {
      const decoded = decodeEventLog({ abi: isAgentEco ? AGENT_ECO_ABI : erc20Abi, data: log.data, topics, strict: true })
      const args: Record<string, string> = {}
      for (const [k, v] of Object.entries(decoded.args ?? {})) args[k] = stringify(v)
      const token = tokens.get(log.address.toLowerCase())
      if (!isAgentEco && token && ('value' in args || 'amount' in args)) {
        const raw = BigInt(args.value ?? args.amount)
        args.amount = `${formatUnits(raw, token.decimals)} ${token.symbol}`
      }
      decodedEvents.push({ contract: isAgentEco ? `AgentEco (${log.address})` : token ? `${token.symbol} (${log.address})` : log.address, event: decoded.eventName, args })
    } catch {
      otherLogs++
    }
  }
  otherLogs += Math.max(0, logs.length - LIMITS.txLogs)
  return { decodedEvents, otherLogs }
}

/**
 * Reads a transaction and its receipt from the active network's RPC and turns
 * them into plain facts. The AI only explains these; it never sees the chain.
 */
export async function buildTxFacts(publicClient: PublicClient, hash: Hex, agentEcoAddress: string): Promise<TxFacts> {
  const [tx, receipt] = await Promise.all([
    publicClient.getTransaction({ hash }).catch(() => null),
    publicClient.getTransactionReceipt({ hash }).catch(() => null),
  ])
  if (!tx || !receipt) throw new InvalidInputError(`Transaction ${hash} was not found on this network.`)

  // Symbol/decimals for every token contract that emitted a log (best effort).
  const tokens = new Map<string, TokenInfo>()
  const addresses = [...new Set(receipt.logs.slice(0, LIMITS.txLogs).map((l) => l.address.toLowerCase()))]
  await Promise.all(
    addresses
      .filter((a) => a !== agentEcoAddress.toLowerCase())
      .map(async (address) => {
        try {
          const [symbol, decimals] = await Promise.all([
            publicClient.readContract({ address: address as Hex, abi: erc20Abi, functionName: 'symbol' }),
            publicClient.readContract({ address: address as Hex, abi: erc20Abi, functionName: 'decimals' }),
          ])
          tokens.set(address, { symbol, decimals })
        } catch {
          // Not an ERC-20 (or not a standard one), events stay undecoded amounts.
        }
      })
  )

  const { decodedEvents, otherLogs } = decodeLogs(receipt.logs, agentEcoAddress, tokens)
  return {
    hash,
    from: tx.from,
    to: tx.to ?? null,
    valueNative: formatEther(tx.value),
    status: receipt.status === 'success' ? 'success' : 'reverted',
    gasUsed: receipt.gasUsed.toString(),
    blockNumber: receipt.blockNumber.toString(),
    decodedEvents,
    otherLogs,
  }
}
