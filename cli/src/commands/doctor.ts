import { accessSync, constants, existsSync } from 'node:fs'
import { join } from 'node:path'
import { chainFamily, readEvm, servedChainIds } from '../../../agent-runtime/src/chain/multi.ts'
import { solanaEntry } from '../../../agent-runtime/src/chain/solana-registry.ts'
import { SolanaRpcBackend } from '../../../agent-runtime/src/chain/solana-rpc.ts'
import type { Ctx } from '../ctx.ts'
import { ensureDir, isReadableByOthers } from '../home.ts'
import { hasKey, keyFile } from '../keystore.ts'

/** `agenteco doctor`: read-only checks of the machine and the network. Exit 1 when something it needs is broken. */
export async function doctor(ctx: Ctx): Promise<number> {
  const { io } = ctx
  let failed = false
  const line = (state: 'ok' | 'warn' | 'FAIL', text: string) => {
    if (state === 'FAIL') failed = true
    io.out(`${state === 'ok' ? '  ok  ' : state === 'warn' ? ' warn ' : ' FAIL '} ${text}`)
  }

  const major = Number(process.versions.node.split('.')[0])
  line(major >= 22 ? 'ok' : 'FAIL', `Node ${process.versions.node} (22 or newer is needed)`)

  try {
    ensureDir(io.home)
    accessSync(io.home, constants.W_OK)
    line('ok', `data directory ${io.home} is writable`)
  } catch {
    line('FAIL', `cannot write to ${io.home}`)
  }

  const families = (['evm', 'solana'] as const).filter((family) => hasKey(io.home, ctx.keyName, family))
  for (const family of families) {
    const path = keyFile(io.home, ctx.keyName, family)
    const label = families.length > 1 ? `the ${family} key file` : 'the key file'
    line(isReadableByOthers(path) ? 'FAIL' : 'ok', isReadableByOthers(path) ? `${path} can be read by other users (chmod 600)` : `${label} is private to this user`)
  }
  if (!families.length) line('warn', 'no agent key yet (`agenteco init` creates one)')
  line(existsSync(join(io.home, 'config.json')) ? 'ok' : 'warn', existsSync(join(io.home, 'config.json')) ? 'config.json found' : 'no config.json: default spend caps apply (testnet 1/job and 5/day, mainnet 0)')

  io.out(`API ${ctx.api}`)
  try {
    const health = await fetch(`${ctx.api}/health`, { signal: AbortSignal.timeout(10_000) })
    line(health.ok ? 'ok' : 'FAIL', `/health answers ${health.status}`)
  } catch (error) {
    line('FAIL', `the API is not reachable (${(error as Error).message.split('\n')[0]})`)
  }
  try {
    const chains = await fetch(`${ctx.api}/chains`, { signal: AbortSignal.timeout(10_000) })
    line(chains.ok ? 'ok' : 'warn', chains.ok ? '/chains answers: a multi-chain API' : `/chains answers ${chains.status}: this API predates multi-chain (BSC Testnet only, no account links)`)
    const links = await fetch(`${ctx.api}/device-links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) })
    line(links.status === 400 ? 'ok' : 'warn', links.status === 400 ? 'account links are supported' : `account links are not available here (/device-links answers ${links.status})`)
  } catch {
    // already reported above
  }

  for (const chainId of new Set([...servedChainIds(), ...ctx.knownChains()])) {
    try {
      if (chainFamily(chainId) === 'solana') {
        const backend = solanaEntry(chainId).backend
        if (!(backend instanceof SolanaRpcBackend)) continue
        const genesis = await backend.getGenesisHash()
        line(genesis.startsWith(chainId.slice('solana:'.length)) ? 'ok' : 'FAIL', `${chainId}: RPC answers with genesis ${genesis.slice(0, 8)}…`)
        continue
      }
      const chain = readEvm(chainId)
      const actual = await chain.rpcChainId()
      line(actual === chain.config.chain.id ? 'ok' : 'FAIL', `${chainId}: RPC answers with chain id ${actual}`)
    } catch (error) {
      line('FAIL', `${chainId}: ${(error as Error).message.split('\n')[0]}`)
    }
  }
  io.out(failed ? 'Something above needs fixing.' : 'Everything it needs is in place.')
  return failed ? 1 : 0
}
