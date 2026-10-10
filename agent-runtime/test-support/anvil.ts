// Test harness: a throwaway local EVM chain (anvil) with the real contracts deployed from
// Foundry's build output (out/). Used by the on-chain regression tests; they skip when
// anvil or the build output is missing. Not part of the published package (outside src/).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const artifactPath = (name: string) => join(ROOT, 'out', `${name}.sol`, `${name}.json`)

/** Why on-chain tests cannot run here, or null when they can. */
export function anvilUnavailable(): string | null {
  if (spawnSync('anvil', ['--version']).error) return 'anvil is not installed'
  for (const n of ['AgentEco', 'MockUSDT', 'ArbiterCouncil', 'TestToken']) {
    if (!existsSync(artifactPath(n))) return `missing out/${n}.sol — run \`forge build\``
  }
  if (!existsSync(join(ROOT, 'out', 'ERC8004Registries.sol', 'MockIdentityRegistry.json'))) return 'missing out/ERC8004Registries.sol — run `forge build`'
  return null
}

/** viem ships Multicall3's runtime bytecode but does not export it; read it from its source file. */
function multicall3Bytecode(): Hex {
  const viemDir = dirname(createRequire(import.meta.url).resolve('viem/package.json'))
  const source = readFileSync(join(viemDir, '_esm', 'constants', 'contracts.js'), 'utf8')
  const match = /multicall3Bytecode = '(0x[0-9a-fA-F]+)'/.exec(source)
  if (!match) throw new Error('Multicall3 bytecode not found in viem')
  return match[1] as Hex
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

export interface TestChain {
  rpcUrl: string
  chainId: number
  /** Fresh funded accounts, by role. */
  keys: Record<'deployer' | 'arbiter' | 'buyer' | 'seller' | 'keeper' | 'other', Hex>
  addresses: Record<'deployer' | 'arbiter' | 'buyer' | 'seller' | 'keeper' | 'other', Address>
  usdt: Address
  agentEco: Address
  /** Test ERC-8004 registries, when started with `erc8004: true`. */
  erc8004: { identity: Address; reputation: Address } | null
  /** Move the chain's clock forward and mine a block. */
  advance(seconds: number): Promise<void>
  /** Deploy another AgentEco on the same token and arbiter, numbering its escrows from `firstEscrowId`. */
  deployAgentEco(firstEscrowId: number): Promise<Address>
  /** Deploy an ArbiterCouncil bound to the deployed AgentEco. */
  deployCouncil(members: Address[], rulingThreshold: number, adminThreshold: number): Promise<Address>
  /** Mint settlement tokens (base units) to an address. */
  mint(to: Address, amount: bigint): Promise<void>
  stop(): void
}

export interface StartOptions {
  chainId?: number
  firstEscrowId?: number
  feeBps?: number
  /** Settle in a plain ERC-20 with these decimals (e.g. 6, like USDC) instead of MockUSDT (18). */
  tokenDecimals?: number
  /** Also deploy test ERC-8004 Identity and Reputation registries (test/mocks/ERC8004Registries.sol). */
  erc8004?: boolean
}

export async function startTestChain(opts: StartOptions = {}): Promise<TestChain> {
  const chainId = opts.chainId ?? 97
  const port = await freePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  const proc: ChildProcess = spawn('anvil', ['--port', String(port), '--chain-id', String(chainId), '--silent'], { stdio: 'ignore' })
  const stop = () => {
    if (!proc.killed) proc.kill()
  }
  try {
    const chain = defineChain({ id: chainId, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } })
    const pub = createPublicClient({ chain, transport: http(rpcUrl) })
    for (let i = 0; ; i++) {
      try {
        await pub.getChainId()
        break
      } catch {
        if (i > 100) throw new Error('anvil did not start')
        await new Promise((r) => setTimeout(r, 100))
      }
    }

    const roles = ['deployer', 'arbiter', 'buyer', 'seller', 'keeper', 'other'] as const
    const keys = Object.fromEntries(roles.map((r) => [r, generatePrivateKey()])) as TestChain['keys']
    const addresses = Object.fromEntries(roles.map((r) => [r, privateKeyToAccount(keys[r]).address])) as TestChain['addresses']
    const tester = createTestClient({ chain, mode: 'anvil', transport: http(rpcUrl) })
    for (const r of roles) await tester.setBalance({ address: addresses[r], value: BigInt(100) * BigInt(10) ** BigInt(18) })

    const deployer = createWalletClient({ account: privateKeyToAccount(keys.deployer), chain, transport: http(rpcUrl) })
    const load = (name: string, file = name) => {
      const a = JSON.parse(readFileSync(join(ROOT, 'out', `${file}.sol`, `${name}.json`), 'utf8'))
      return { abi: a.abi, bytecode: a.bytecode.object as Hex }
    }
    const deploy = async (name: string, args: unknown[], file = name): Promise<Address> => {
      const hash = await deployer.deployContract({ ...load(name, file), args } as never)
      const receipt = await pub.waitForTransactionReceipt({ hash })
      if (!receipt.contractAddress) throw new Error(`${name} deployment failed`)
      return receipt.contractAddress
    }

    // Multicall3: viem ships its creation code; deploy it, then put its runtime code at the canonical address.
    // (BSC Testnet's preset batches reads through it.)
    const mcHash = await deployer.sendTransaction({ data: multicall3Bytecode(), to: null } as never)
    const mcAddress = (await pub.waitForTransactionReceipt({ hash: mcHash })).contractAddress
    if (!mcAddress) throw new Error('Multicall3 deployment failed')
    await tester.setCode({ address: '0xcA11bde05977b3631167028862bE2a173976CA11', bytecode: (await pub.getCode({ address: mcAddress })) as Hex })

    const tokenArtifact = opts.tokenDecimals === undefined ? 'MockUSDT' : 'TestToken'
    const usdt = await deploy(tokenArtifact, opts.tokenDecimals === undefined ? [] : [opts.tokenDecimals])
    // minWindow 120 s, accept timeout 120 s, dispute timeout 900 s (the demo defaults of script/Deploy.s.sol).
    const deployAgentEco = (firstEscrowId: number) =>
      deploy('AgentEco', [usdt, addresses.arbiter, BigInt(120), BigInt(120), BigInt(900), BigInt(firstEscrowId), BigInt(opts.feeBps ?? 250), addresses.deployer])
    const agentEco = await deployAgentEco(opts.firstEscrowId ?? 1)
    let erc8004: TestChain['erc8004'] = null
    if (opts.erc8004) {
      const identity = await deploy('MockIdentityRegistry', [], 'ERC8004Registries')
      erc8004 = { identity, reputation: await deploy('MockReputationRegistry', [identity], 'ERC8004Registries') }
    }

    return {
      rpcUrl,
      chainId,
      keys,
      addresses,
      usdt,
      agentEco,
      erc8004,
      async advance(seconds) {
        await tester.increaseTime({ seconds })
        await tester.mine({ blocks: 1 })
      },
      deployAgentEco,
      deployCouncil: (members, rulingThreshold, adminThreshold) =>
        deploy('ArbiterCouncil', [agentEco, members, BigInt(rulingThreshold), BigInt(adminThreshold)]),
      async mint(to, amount) {
        // MockUSDT's owner (the deployer) or TestToken's open mint.
        const hash = await deployer.writeContract({ address: usdt, abi: load(tokenArtifact).abi, functionName: 'mint', args: [to, amount] } as never)
        await pub.waitForTransactionReceipt({ hash })
      },
      stop,
    }
  } catch (error) {
    stop()
    throw error
  }
}
