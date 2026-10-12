import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createPrivateKey, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { localValidatorUnavailable, startLocalValidatorChain, type ValidatorChain } from '../../agent-runtime/test-support/validator.ts'
import { startTestDb, type TestDb } from '../test-support/db.ts'

/**
 * The website on Solana, in a real browser: Chromium drives the built frontend (next start) against a real
 * solana-test-validator running the escrow program, this API with an in-memory Postgres, and an SDK seller.
 * The browser has a mock wallet-standard wallet (the same interface Phantom, Solflare and Backpack expose)
 * whose signatures come from a test key held here — so what runs in the page is the production code path:
 * wallet discovery, connect, the 24 h read session, the SolanaAdapter in the bundle, a wallet-signed
 * create-and-fund transaction, settling, rating and disputing.
 *
 * Opt-in (about 4 minutes): SOLANA_BROWSER_E2E=1, with solana-test-validator, the built program
 * (solana/target/deploy), a Chromium (CHROMIUM_PATH, else Playwright's), and `npm ci` done in ../frontend.
 * E2E_SCREENSHOTS=<dir> keeps a screenshot of each step.
 */
const enabled = process.env.SOLANA_BROWSER_E2E === '1'
if (enabled) process.env.SOLANA_LOCAL_VALIDATOR = '1'

const FRONTEND = join(import.meta.dirname, '..', '..', 'frontend')
const CHROMIUM = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium', process.env.PLAYWRIGHT_BROWSERS_PATH ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium') : ''].find((p) => p && existsSync(p))
const skip = !enabled ? 'opt-in: set SOLANA_BROWSER_E2E=1' : (localValidatorUnavailable() ?? (CHROMIUM ? (existsSync(join(FRONTEND, 'node_modules', 'next')) ? false : 'run `npm ci` in frontend/ first') : 'no Chromium found (set CHROMIUM_PATH)'))

const SOL = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const SUFFIX = SOL.replace(/[^A-Za-z0-9]/g, '_')
const RESULT = { translatedText: 'Hello world', targetLanguage: 'en' }
const SETTLED = 5
const DISPUTED = 4
const REFUNDED = 6

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

/** Runs a command to its end; resolves with its output, rejects with it when it fails. */
function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} ${args.join(' ')} exited ${code}:\n${out.slice(-3000)}`))))
  })
}

async function waitForHttp(url: string, ms = 60_000): Promise<void> {
  const until = Date.now() + ms
  for (;;) {
    try {
      if ((await fetch(url)).status < 500) return
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`${url} did not come up`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** Ed25519 signing for the mock wallet, from a 64-byte Solana secret key (seed, then public key). */
function ed25519Signer(secretKey: Uint8Array) {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' })
  return (data: Uint8Array) => new Uint8Array(sign(null, Buffer.from(data), key))
}

/**
 * What the page gets: a wallet-standard wallet that registers itself like an extension would. The keys never
 * enter the page — it calls back into this process (exposed functions) to sign.
 */
const MOCK_WALLET = `(() => {
  const ADDRESS = __ADDRESS__
  const PUBLIC_KEY = new Uint8Array(__PUBLIC_KEY__)
  const b64 = (bytes) => btoa(String.fromCharCode(...bytes))
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  const listeners = new Set()
  const account = { address: ADDRESS, publicKey: PUBLIC_KEY, chains: ['solana:devnet'], features: ['solana:signMessage', 'solana:signTransaction'] }
  const wallet = {
    version: '1.0.0',
    name: 'Mock Wallet',
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PGNpcmNsZSBjeD0iOCIgY3k9IjgiIHI9IjgiIGZpbGw9IiM1QjVGRUYiLz48L3N2Zz4=',
    chains: ['solana:devnet'],
    accounts: [],
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => {
          wallet.accounts = [account]
          window.__walletLog.push('connect')
          return { accounts: wallet.accounts }
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {
          wallet.accounts = []
          window.__walletLog.push('disconnect')
        },
      },
      'standard:events': {
        version: '1.0.0',
        on: (event, listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async (...inputs) =>
          Promise.all(
            inputs.map(async (input) => {
              window.__walletLog.push('signMessage')
              return { signedMessage: input.message, signature: unb64(await window.__mockSignMessage(b64(input.message))) }
            })
          ),
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs) =>
          Promise.all(
            inputs.map(async (input) => {
              window.__walletLog.push('signTransaction')
              return { signedTransaction: unb64(await window.__mockSignTransaction(b64(input.transaction))) }
            })
          ),
      },
    },
  }
  window.__walletLog = []
  const register = (api) => api.register(wallet)
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }))
  window.addEventListener('wallet-standard:app-ready', (event) => register(event.detail))
})()`

describe('the website on Solana, in a real browser', { skip, timeout: 900_000 }, () => {
  let chain: ValidatorChain
  let db: TestDb
  let apiServer: Server
  let api: string
  let site: string
  let nextProcess: ChildProcess | undefined
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let prisma: typeof import('./db.ts').prisma
  let sdk: typeof import('../../agent-runtime/src/sdk/index.ts')
  let kit: typeof import('../../agent-runtime/src/chain/kit.ts')
  let seller: { stop(): void } | undefined
  let listingId = ''
  let tsconfigBefore = ''
  const problems: string[] = []
  let shots = 0

  const buyerAddress = () => chain.signers.buyer.address
  /** What the mock wallet was asked to do since this page loaded. */
  const walletLog = () => page.evaluate('window.__walletLog') as Promise<string[]>
  const adapter = (role: keyof ValidatorChain['signers']) => chain.adapterFor(role)
  const shot = async (name: string) => {
    const dir = process.env.E2E_SCREENSHOTS
    if (!dir) return
    mkdirSync(dir, { recursive: true })
    await page.screenshot({ path: join(dir, `${String(++shots).padStart(2, '0')}-${name}.png`), fullPage: true })
  }
  /** Waits (polling the chain, not the page) for an escrow to reach a status. */
  async function waitForStatus(escrowId: bigint, status: number, ms = 60_000) {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if ((await adapter('buyer').getEscrowStatus(escrowId)) === status) return
      await new Promise((r) => setTimeout(r, 300))
    }
    assert.fail(`escrow #${escrowId} never reached status ${status} (is ${await adapter('buyer').getEscrowStatus(escrowId)})`)
  }
  const escrowIdOf = (url: string) => BigInt(/\/orders\/onchain\/(\d+)/.exec(url)?.[1] ?? assert.fail(`not an order page: ${url}`))

  before(async () => {
    const sitePort = await freePort()
    site = `http://127.0.0.1:${sitePort}`
    ;[chain, db] = await Promise.all([startLocalValidatorChain(250), startTestDb()])
    Object.assign(process.env, {
      DATABASE_URL: db.url,
      CHAINS: 'solana-devnet',
      PUBLIC_API_URL: 'https://api.test',
      FRONTEND_ORIGIN: site,
      [`RPC_URL__${SUFFIX}`]: chain.rpcUrl,
      [`AGENT_ECO_PROGRAM__${SUFFIX}`]: chain.programId,
      [`TOKEN_MINT__${SUFFIX}`]: chain.mint,
    })
    const [{ app }, dbMod, sdkMod, kitMod] = await Promise.all([
      import('./app.ts'),
      import('./db.ts'),
      import('../../agent-runtime/src/sdk/index.ts'),
      import('../../agent-runtime/src/chain/kit.ts'),
    ])
    prisma = dbMod.prisma
    sdk = sdkMod
    kit = kitMod
    await new Promise<void>((resolve) => {
      apiServer = app.listen(0, '127.0.0.1', () => resolve())
    })
    api = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`

    // The website, built for this chain (NEXT_PUBLIC_* are inlined at build time) into its own directory.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NEXT_DIST_DIR: '.next-e2e',
      NEXT_PUBLIC_API_URL: api,
      NEXT_PUBLIC_CHAINS: 'solana-devnet',
      [`NEXT_PUBLIC_AGENT_ECO_PROGRAM__${SUFFIX}`]: chain.programId,
      [`NEXT_PUBLIC_TOKEN_MINT__${SUFFIX}`]: chain.mint,
      [`NEXT_PUBLIC_RPC_URL__${SUFFIX}`]: chain.rpcUrl,
      [`NEXT_PUBLIC_RPC_FALLBACK_URLS__${SUFFIX}`]: 'none',
      NEXT_TELEMETRY_DISABLED: '1',
    }
    // `next build` adds its output directory to tsconfig.json; put the file back afterwards.
    tsconfigBefore = readFileSync(join(FRONTEND, 'tsconfig.json'), 'utf8')
    try {
      await run('npx', ['next', 'build'], { cwd: FRONTEND, env })
    } finally {
      writeFileSync(join(FRONTEND, 'tsconfig.json'), tsconfigBefore)
    }
    nextProcess = spawn('npx', ['next', 'start', '-p', String(sitePort), '-H', '127.0.0.1'], { cwd: FRONTEND, env, stdio: 'ignore' })
    await waitForHttp(`${site}/`)

    // A seller on this chain: the SDK agent a person would run with `agenteco sell`.
    const agent = sdk.createSellerAgent({
      privateKey: chain.secretKeys.seller,
      apiUrl: api,
      chain: 'solana-devnet',
      name: 'Browser test seller',
      description: 'Translates text for the browser test.',
      capability: 'translation',
      price: 1,
      floor: 1,
      handle: async () => RESULT,
      pollMs: 200,
      log: () => {},
      respondToDispute: async () => 'The translation follows the brief exactly.',
    })
    seller = agent
    void agent.start()
    for (let i = 0; i < 300 && !listingId; i++) {
      listingId = (await prisma.agent.findFirst({ where: { walletAddress: chain.signers.seller.address, isOnline: true, deletedAt: null } }))?.id ?? ''
      if (!listingId) await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(listingId, 'the seller never came online')
    await chain.mintTo(chain.signers.buyer.address, 50_000_000n) // 50 USDC

    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox'] })
    context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await context.newPage()
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`)
    })

    // The mock wallet holds the buyer's key out here; the page only asks it to sign.
    const signWith = ed25519Signer(chain.secretKeys.buyer)
    const { getTransactionDecoder, getTransactionEncoder } = kit
    await page.exposeFunction('__mockSignMessage', (messageB64: string) => Buffer.from(signWith(Buffer.from(messageB64, 'base64'))).toString('base64'))
    await page.exposeFunction('__mockSignTransaction', (txB64: string) => {
      const tx = getTransactionDecoder().decode(Buffer.from(txB64, 'base64'))
      const signed = { ...tx, signatures: { ...tx.signatures, [buyerAddress()]: signWith(tx.messageBytes as unknown as Uint8Array) } }
      return Buffer.from(getTransactionEncoder().encode(signed as never)).toString('base64')
    })
    await page.addInitScript(MOCK_WALLET.replace('__ADDRESS__', JSON.stringify(buyerAddress())).replace('__PUBLIC_KEY__', JSON.stringify([...chain.secretKeys.buyer.slice(32)])))
  })

  after(async () => {
    await browser?.close()
    nextProcess?.kill()
    seller?.stop()
    await new Promise((resolve) => apiServer?.close(resolve))
    await prisma?.$disconnect()
    await db?.stop()
    chain?.stop()
  })

  test('the wallet is found, connects, and signs in once: the top bar shows its address and USDC', async () => {
    await page.goto(`${site}/app/marketplace`)
    await page.getByRole('button', { name: 'Connect Wallet' }).click()
    const short = `${buyerAddress().slice(0, 4)}…${buyerAddress().slice(-4)}`
    await page.getByRole('button', { name: short }).waitFor()
    await page.getByText('50.00 USDC').waitFor()
    await shot('connected')
    const log = await walletLog()
    assert.ok(log.includes('connect'))
    // The 24 h session needs one signature; a reload reuses it (and the remembered wallet reconnects by itself).
    await page.waitForFunction("Object.keys(localStorage).some((k) => k.startsWith('agenteco.readSession.'))")
    const before = (await walletLog()).filter((e) => e === 'signMessage').length
    assert.equal(before, 1, 'one sign-in prompt')
    await page.reload()
    await page.getByRole('button', { name: short }).waitFor()
  })

  test('hire the seller from its page: one wallet-signed transaction creates and funds the escrow', async () => {
    await page.goto(`${site}/app/agents/${listingId}`)
    await page.getByText('Request Service').waitFor()
    await page.getByLabel('Text to translate').fill('Halo dunia')
    await shot('brief')
    const buyerBefore = await adapter('buyer').tokenBalance(buyerAddress())
    await page.getByRole('button', { name: /Create & Fund Escrow/ }).click()
    await page.waitForURL(/\/app\/orders\/onchain\/\d+/, { timeout: 60_000 })
    const escrowId = escrowIdOf(page.url())
    const basic = await adapter('buyer').getEscrowBasic(escrowId)
    assert.equal(basic.buyer, buyerAddress())
    assert.equal(basic.seller, chain.signers.seller.address)
    assert.equal(basic.amount, 1_000_000n)
    assert.equal(buyerBefore - (await adapter('buyer').tokenBalance(buyerAddress())), 1_000_000n)
    // The API stored the brief and verified it against the escrow on the program.
    const task = await prisma.task.findUnique({ where: { chainId_escrowId: { chainId: SOL, escrowId: escrowId.toString() } } })
    assert.equal(task?.verified, true)
    assert.equal(task?.buyer, buyerAddress())
    const log = await walletLog()
    assert.equal(log.filter((e) => e === 'signTransaction').length, 1, 'one transaction prompt for create-and-fund')
  })

  test('the seller delivers; the order page shows it, the buyer accepts, and the seller is paid minus the fee', async () => {
    const escrowId = escrowIdOf(page.url())
    await waitForStatus(escrowId, 3)
    await page.getByRole('button', { name: 'Accept & Settle' }).waitFor({ timeout: 30_000 })
    await page.getByText('Hello world').first().waitFor() // the result, hash-checked against the program
    await shot('delivered')
    const sellerBefore = await adapter('seller').tokenBalance(chain.signers.seller.address)
    await page.getByRole('button', { name: 'Accept & Settle' }).click()
    await waitForStatus(escrowId, SETTLED)
    assert.equal((await adapter('seller').tokenBalance(chain.signers.seller.address)) - sellerBefore, 975_000n, '1 USDC minus 2.5%')
    await page.getByText('SETTLED').first().waitFor({ timeout: 30_000 })
    await shot('settled')
  })

  test('the buyer rates the seller from the page', async () => {
    const escrowId = escrowIdOf(page.url())
    await page.getByRole('button', { name: '4 stars' }).click()
    await page.getByRole('button', { name: 'Rate 4 stars' }).click()
    await page.getByText('80/100').waitFor({ timeout: 30_000 })
    assert.deepEqual(await adapter('buyer').reputationCounters(chain.signers.seller.address), [1n, 0n, 1_000_000n, 80n, 1n])
    assert.equal((await adapter('buyer').getEscrowDisputeInfo(escrowId)).rated, true)
    await shot('rated')
  })

  test('a dispute: the reason is hashed on the program and saved to the API; the seller answers; the arbiter rules and the order refunds', async () => {
    await page.goto(`${site}/app/agents/${listingId}`)
    await page.getByLabel('Text to translate').fill('Selamat pagi')
    await page.getByRole('button', { name: /Create & Fund Escrow/ }).click()
    await page.waitForURL(/\/app\/orders\/onchain\/\d+/, { timeout: 60_000 })
    const escrowId = escrowIdOf(page.url())
    await waitForStatus(escrowId, 3)
    await page.getByRole('button', { name: 'Raise Dispute' }).click()
    const reason = 'The register is wrong: the brief asked for formal Indonesian.'
    await page.getByLabel(/What's wrong with the delivered result/).fill(reason)
    await shot('dispute-form')
    const buyerBefore = await adapter('buyer').tokenBalance(buyerAddress())
    await page.getByRole('button', { name: 'Submit Dispute' }).click()
    await waitForStatus(escrowId, DISPUTED)
    // Two prompts: the transaction, then a free signature that saves the reason.
    for (let i = 0; i < 100; i++) {
      const row = await prisma.dispute.findUnique({ where: { chainId_escrowId: { chainId: SOL, escrowId: escrowId.toString() } } })
      if (row?.reason === reason && row.sellerResponse) break
      assert.ok(i < 99, 'the reason and the seller\'s answer never reached the API')
      await new Promise((r) => setTimeout(r, 200))
    }
    const hashes = await adapter('buyer').getEscrowHashes(escrowId)
    assert.notEqual(hashes.disputeReasonHash, `0x${'0'.repeat(64)}`)
    await page.getByText(reason).first().waitFor({ timeout: 30_000 })
    await shot('disputed')

    const ruling = await adapter('arbiter').ruleDispute(escrowId, false, `0x${'ab'.repeat(32)}`)
    assert.equal(ruling.kind, 'executed')
    await waitForStatus(escrowId, REFUNDED)
    assert.equal(await adapter('buyer').tokenBalance(buyerAddress()), buyerBefore + 1_000_000n, 'the buyer is whole again')
    await page.getByText('REFUNDED').first().waitFor({ timeout: 30_000 })
    await shot('refunded')
  })

  test('nothing in the page threw or logged an error', () => {
    // Failed requests to a missing favicon etc. are not the app's; everything else is.
    const real = problems.filter((p) => !/favicon|Failed to load resource: the server responded with a status of 404/.test(p))
    assert.deepEqual(real, [])
  })
})
