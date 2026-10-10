import { formatEther, formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { buildAuthHeaders } from '../../../agent-runtime/src/authHeaders.ts'
import { servedChainIds } from '../../../agent-runtime/src/chain/registry.ts'
import type { Ctx } from '../ctx.ts'
import { capsFor } from '../config.ts'
import { hasKey } from '../keystore.ts'
import { loadState } from '../link.ts'
import { spentToday } from '../spend.ts'

interface Listing {
  id: string
  name: string
  role: string
  chainId?: string
  isOnline: boolean
  price: string
  capabilities: string[]
  erc8004AgentId?: string | null
}

/** `agenteco status`: who the agent is, whether it is linked, what it lists, what it holds, what it may spend. */
export async function status(ctx: Ctx): Promise<number> {
  const { io } = ctx
  if (!hasKey(io.home, ctx.keyName)) {
    io.out('No agent key yet. Run `agenteco init`.')
    return 1
  }
  const { address, privateKey } = ctx.key()
  io.out(`agent wallet: ${address}`)
  io.out(`home: ${io.home}`)
  io.out(`API: ${ctx.api}`)

  const link = loadState(io.home).link
  io.out(`account link: ${link?.status === 'approved' ? `linked to ${link.ownerWallet}` : link?.status === 'pending' ? `waiting for approval of code ${link.userCode}` : 'not linked'}`)

  try {
    const res = await fetch(`${ctx.api}/agents?ownerWallet=${address}`, { headers: await buildAuthHeaders(privateKeyToAccount(privateKey)) })
    if (res.ok) {
      const listings = (await res.json()) as Listing[]
      if (!listings.length) io.out('listings: none')
      for (const l of listings) {
        io.out(`listing: "${l.name}" (${l.role}, ${l.chainId ?? 'default chain'}) ${l.isOnline ? 'online' : 'offline'}, ${l.price}, ${l.capabilities.join(',')}${l.erc8004AgentId ? `, ERC-8004 #${l.erc8004AgentId}` : ''}`)
      }
    } else {
      io.out(`listings: could not read (${res.status})`)
    }
  } catch (error) {
    io.out(`listings: could not read (${(error as Error).message.split('\n')[0]})`)
  }

  for (const chainId of servedChainIds()) {
    try {
      const chain = ctx.adapter(chainId)
      const token = await chain.token()
      const [native, balance] = await Promise.all([chain.nativeBalance(address), chain.tokenBalance(address)])
      const caps = capsFor(ctx.config, chainId)
      io.out(
        `${chainId}: ${formatEther(native)} ${chain.nativeSymbol}, ${formatUnits(balance, token.decimals)} ${token.symbol}; ` +
          `caps ${caps.maxPerJob}/job, ${caps.maxPerDay}/day (${spentToday(io.home, chainId)} reserved or spent today)`
      )
    } catch (error) {
      io.out(`${chainId}: unreachable (${(error as Error).message.split('\n')[0]})`)
    }
  }

  const jobs = ctx.jobs().list()
  const open = jobs.filter((j) => !['settled', 'disputed', 'refunded', 'failed'].includes(j.stage))
  io.out(`jobs: ${jobs.length} total, ${open.length} open${open.length ? ` (${open.map((j) => `${j.id} ${j.stage}`).join(', ')})` : ''}`)
  return 0
}
