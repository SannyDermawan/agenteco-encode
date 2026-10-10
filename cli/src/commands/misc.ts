import { parseArgs } from 'node:util'
import { formatEther, formatUnits } from 'viem'
import { MOCK_USDT_ABI } from '../../../agent-runtime/src/shared/abi.generated.ts'
import { chainConfig, signerClients } from '../../../agent-runtime/src/chain/registry.ts'
import { CliError, type Ctx } from '../ctx.ts'
import { DEFAULT_CAPS, capsFor, isTestnet, saveConfig, type Caps } from '../config.ts'
import { faucetGuide } from '../faucets.ts'
import { keyAddress } from '../keystore.ts'
import { spentToday } from '../spend.ts'

/** `agenteco faucet`: claims AgentEco's own test token (MockUSDT, BSC Testnet) for the agent wallet. Needs a little gas first. */
export async function faucet(ctx: Ctx, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { chain: { type: 'string' } } })
  const chainId = ctx.chain(values.chain)
  const { io } = ctx
  if (chainId !== 'eip155:97') {
    const guide = faucetGuide(chainId)
    io.out(`${chainId} has no AgentEco token faucet. ${guide.token}`)
    return 1
  }
  const config = chainConfig(chainId)
  const { account, publicClient, walletClient } = signerClients(chainId, ctx.key().privateKey)
  const native = await publicClient.getBalance({ address: account.address })
  if (native === BigInt(0)) {
    io.out(`The agent wallet ${account.address} has no ${config.nativeSymbol} for gas yet. A person gets some from a faucet first:`)
    for (const g of faucetGuide(chainId).gas) io.out(`  ${g.label} — ${g.url}`)
    return 1
  }
  const next = await publicClient.readContract({ address: config.usdt, abi: MOCK_USDT_ABI, functionName: 'nextClaimAt', args: [account.address] })
  if (next > BigInt(Math.floor(Date.now() / 1000))) {
    io.out(`The faucet allows one claim a day per wallet; the next one is at ${new Date(Number(next) * 1000).toISOString()}.`)
    return 1
  }
  const hash = await walletClient.writeContract({ address: config.usdt, abi: MOCK_USDT_ABI, functionName: 'faucet', chain: walletClient.chain, account })
  await publicClient.waitForTransactionReceipt({ hash })
  const [balance, decimals] = await Promise.all([
    publicClient.readContract({ address: config.usdt, abi: MOCK_USDT_ABI, functionName: 'balanceOf', args: [account.address] }),
    publicClient.readContract({ address: config.usdt, abi: MOCK_USDT_ABI, functionName: 'decimals' }),
  ])
  io.out(`Claimed. ${config.explorerUrl}/tx/${hash}`)
  io.out(`balance: ${formatEther(native)} ${config.nativeSymbol} (before), ${formatUnits(balance, decimals)} ${config.tokenSymbol}`)
  return 0
}

/** `agenteco key address` (safe) and `agenteco key export` (a person at a terminal, typed confirmation). */
export async function keyCommand(ctx: Ctx, args: string[]): Promise<number> {
  const [sub] = args
  const { io } = ctx
  if (sub === 'address' || sub === undefined) {
    const address = keyAddress(io.home, ctx.keyName)
    if (!address) throw new CliError('No agent key yet. Run `agenteco init`.')
    io.out(address)
    return 0
  }
  if (sub === 'export') {
    // For the person only: refuses unless both ends are a terminal, so an agent's pipe never gets it.
    if (!io.interactive || !io.ask) throw new CliError('`key export` only runs in a terminal, for a person. An agent cannot use it.', 77)
    const answer = await io.ask('This prints the private key. Anyone who sees it controls the wallet. Type "export my key" to continue: ')
    if (answer.trim() !== 'export my key') {
      io.out('Cancelled.')
      return 1
    }
    const { privateKey } = ctx.key()
    // Written straight to the terminal, bypassing the scrubbing that protects every other output.
    process.stdout.write(`${privateKey}\n`)
    return 0
  }
  throw new CliError('Usage: agenteco key address | export', 64)
}

/** `agenteco caps` shows the spend caps; `agenteco caps set <testnet|mainnet> <maxPerJob> <maxPerDay>` changes them (a person's decision). */
export async function caps(ctx: Ctx, args: string[]): Promise<number> {
  const { io } = ctx
  const [sub, kind, perJob, perDay] = args
  if (sub === 'set') {
    if ((kind !== 'testnet' && kind !== 'mainnet') || perJob === undefined || perDay === undefined || !(Number(perJob) >= 0) || !(Number(perDay) >= 0)) {
      throw new CliError('Usage: agenteco caps set <testnet|mainnet> <maxPerJob> <maxPerDay>', 64)
    }
    const next: Partial<Caps> = { maxPerJob: Number(perJob), maxPerDay: Number(perDay) }
    // Raising a cap is a person's decision: it needs a terminal and a typed confirmation, so an agent's
    // shell pipe cannot do it. Lowering is always fine. (Editing config.json by hand is the person's too.)
    const current = capsFor(ctx.config, kind === 'testnet' ? 'eip155:97' : 'eip155:677')
    if (next.maxPerJob! > current.maxPerJob || next.maxPerDay! > current.maxPerDay) {
      if (!io.interactive || !io.ask) throw new CliError('Raising a spend cap needs a person at a terminal (or editing config.json by hand). Lowering a cap works anywhere.', 77)
      const answer = await io.ask(`Raise the ${kind} caps to ${next.maxPerJob}/job and ${next.maxPerDay}/day? Type "raise my caps" to confirm: `)
      if (answer.trim() !== 'raise my caps') {
        io.out('Cancelled.')
        return 1
      }
    }
    saveConfig(io.home, { ...ctx.config, caps: { ...ctx.config.caps, [kind]: next } })
    io.out(`Set the ${kind} caps to ${next.maxPerJob} per job and ${next.maxPerDay} per day.`)
    return 0
  }
  io.out('Spend caps (a hire reserves its budget when it starts):')
  io.out(`  defaults: testnet ${DEFAULT_CAPS.testnet.maxPerJob}/job ${DEFAULT_CAPS.testnet.maxPerDay}/day; mainnet ${DEFAULT_CAPS.mainnet.maxPerJob}/job ${DEFAULT_CAPS.mainnet.maxPerDay}/day (off until a person turns it on)`)
  for (const chainId of ['eip155:97', 'eip155:84532', 'eip155:968', 'eip155:677']) {
    const c = capsFor(ctx.config, chainId)
    io.out(`  ${chainId} (${isTestnet(chainId) ? 'testnet' : 'mainnet'}): ${c.maxPerJob}/job, ${c.maxPerDay}/day, ${spentToday(io.home, chainId)} reserved or spent today`)
  }
  io.out(`Change them with \`agenteco caps set testnet 2 10\`, or edit ${io.home}/config.json.`)
  return 0
}
