import { parseArgs } from 'node:util'
import { formatEther, formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { registerOrSyncSelf } from '../../../agent-runtime/src/index.ts'
import { CliError, type Ctx } from '../ctx.ts'
import { assertChainAllowed } from '../config.ts'
import { faucetGuide } from '../faucets.ts'
import { createKey, hasKey, keyAddress } from '../keystore.ts'
import { loadState, pollDeviceLink, saveState, startDeviceLink, type LinkRecord } from '../link.ts'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/**
 * `agenteco init`: everything an agent needs to start, resumable at every step.
 *   1. a key, made here and never shown      2. the account link, approved by the person in a browser
 *   3. (seller, with --capability and --price) the listing      4. what to fund, and where
 * Exit code 2 means "waiting for the person to approve the link — run it again".
 */
export async function init(ctx: Ctx, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      role: { type: 'string', default: 'buyer' },
      chain: { type: 'string' },
      name: { type: 'string' },
      wait: { type: 'string', default: '120' },
      'skip-link': { type: 'boolean', default: false },
      capability: { type: 'string' },
      price: { type: 'string' },
      description: { type: 'string' },
      key: { type: 'string' },
    },
    allowPositionals: false,
  })
  const role = values.role
  if (role !== 'buyer' && role !== 'seller') throw new CliError('--role must be "buyer" or "seller".', 64)
  const { io } = ctx
  const chainId = ctx.chain(values.chain)
  assertChainAllowed(ctx.config, chainId)
  const label = values.name ?? (role === 'seller' ? 'AgentEco seller' : 'AgentEco buyer')
  const waitMs = Math.max(0, Number(values.wait) || 0) * 1000

  io.out(`AgentEco setup — ${chainId}, API ${ctx.api}`)

  // 1. The key.
  if (hasKey(io.home, ctx.keyName)) {
    io.out(`[1/4] key: using the existing agent wallet ${keyAddress(io.home, ctx.keyName)}`)
  } else {
    const address = createKey(io.home, ctx.keyName)
    io.out(`[1/4] key: created the agent wallet ${address}`)
    io.out(`      It is stored in ${io.home}/keys with owner-only permissions. It is never printed or sent anywhere.`)
  }
  const { privateKey, address } = ctx.key()

  // 2. The account link.
  if (values['skip-link']) {
    io.out('[2/4] account link: skipped (--skip-link). The agent will be listed under its own key only.')
  } else {
    const state = loadState(io.home)
    let link: LinkRecord | undefined = state.link
    const reusable = link && link.chainId === chainId && link.role === role && (link.status === 'approved' || (link.status === 'pending' && new Date(link.expiresAt) > io.now()))
    if (!reusable) {
      link = await startDeviceLink({ apiUrl: ctx.api, privateKey, chainId, role, label })
      saveState(io.home, { ...state, link })
    }
    if (!link) throw new CliError('No link state.')
    if (link.status === 'approved') {
      io.out(`[2/4] account link: already linked to ${link.ownerWallet ?? 'your account'}`)
    } else {
      // A code the server has expired (or lost) is replaced once, in the same run.
      let renewed = false
      for (;;) {
        io.out(`[2/4] account link: ask the person to open ${link.verifyUrl} in a browser, connect their wallet and enter this code:`)
        io.out('')
        io.out(`      ${link.userCode}`)
        io.out('')
        io.out(`      (valid until ${link.expiresAt}; the page shows the agent wallet ${short(address)} — it must match). Waiting up to ${Math.round(waitMs / 1000)} s…`)
        const until = io.now().getTime() + waitMs
        let status: LinkRecord['status'] = link.status
        let owner: string | undefined
        for (;;) {
          const polled = await pollDeviceLink(ctx.api, link)
          status = polled.status
          owner = polled.ownerWallet
          if (status !== 'pending' || io.now().getTime() >= until) break
          await io.sleep(2000)
        }
        if (status === 'approved') {
          link = { ...link, status: 'approved', ownerWallet: owner }
          saveState(io.home, { ...loadState(io.home), link })
          io.out(`      approved by ${owner ?? 'the person'}.`)
          break
        }
        if (status === 'pending') {
          io.out('      Not approved yet. Run `agenteco init` again (same options) to keep waiting; nothing is lost.')
          return 2
        }
        if (status === 'expired' && !renewed) {
          renewed = true
          io.out('      That code expired. Asking for a new one…')
          link = await startDeviceLink({ apiUrl: ctx.api, privateKey, chainId, role, label })
          saveState(io.home, { ...loadState(io.home), link })
          continue
        }
        saveState(io.home, { ...loadState(io.home), link: { ...link, status } })
        io.out(`      The link ${status === 'denied' ? 'was locked after too many wrong tries' : 'expired'}. Run \`agenteco init\` again for a new code.`)
        return 2
      }
    }
  }

  // 3. The listing (sellers), when it is fully described.
  if (role === 'seller' && values.capability && values.price) {
    const price = Number(values.price)
    if (!(price > 0)) throw new CliError('--price must be above zero.', 64)
    const listing = await registerOrSyncSelf(
      {
        name: label,
        role: 'seller',
        capabilities: [values.capability],
        description: values.description ?? `${values.capability} seller (AgentEco CLI)`,
        category: 'Automation',
        service: label,
        basePrice: price,
      },
      { apiUrl: ctx.api, account: privateKeyToAccount(privateKey), walletAddress: address, hosted: false, chainId }
    )
    io.out(`[3/4] listing: "${label}" is registered as a seller of ${values.capability} at ${price} (agent ${listing.id}). It goes online when \`agenteco sell\` runs.`)
  } else if (role === 'seller') {
    io.out('[3/4] listing: not created yet. `agenteco sell --capability <id> --price <n> --handler <file>` creates it and starts serving.')
  } else {
    io.out('[3/4] listing: a buyer needs none; `agenteco hire` registers it on first use.')
  }

  // 4. Funding.
  io.out('[4/4] funding:')
  io.out(`      agent wallet: ${address}`)
  try {
    const chain = ctx.adapter(chainId)
    const [native, token] = await Promise.all([chain.nativeBalance(address), chain.token().then(async (t) => ({ ...t, balance: await chain.tokenBalance(address) }))])
    io.out(`      balance: ${formatEther(native)} ${chain.nativeSymbol}, ${formatUnits(token.balance, token.decimals)} ${token.symbol}`)
  } catch (error) {
    io.out(`      (could not read balances: ${(error as Error).message.split('\n')[0]})`)
  }
  const guide = faucetGuide(chainId)
  for (const g of guide.gas) io.out(`      gas: ${g.label} — ${g.url}`)
  io.out(`      token: ${guide.token}`)
  io.out('Next: fund the wallet (a person does this), then `agenteco status`. Spending stays capped — see `agenteco caps`.')
  return 0
}
