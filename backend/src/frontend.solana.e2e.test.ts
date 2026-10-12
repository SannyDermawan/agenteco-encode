import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { localValidatorUnavailable, type ValidatorChain } from '../../agent-runtime/test-support/validator.ts'
import { installMockWallet } from '../test-support/mockWallet.ts'
import { FRONTEND, SOL, startSolanaBrowserStack, type SolanaBrowserStack } from '../test-support/solanaBrowserStack.ts'

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
 * E2E_SCREENSHOTS=<dir> keeps a screenshot of each step; E2E_DIAGNOSTICS=<file> keeps what the page logged.
 */
const enabled = process.env.SOLANA_BROWSER_E2E === '1'
if (enabled) process.env.SOLANA_LOCAL_VALIDATOR = '1'

const CHROMIUM = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium', process.env.PLAYWRIGHT_BROWSERS_PATH ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium') : ''].find((p) => p && existsSync(p))
const skip = !enabled ? 'opt-in: set SOLANA_BROWSER_E2E=1' : (localValidatorUnavailable() ?? (CHROMIUM ? (existsSync(join(FRONTEND, 'node_modules', 'next')) ? false : 'run `npm ci` in frontend/ first') : 'no Chromium found (set CHROMIUM_PATH)'))

const SETTLED = 5
const DISPUTED = 4
const REFUNDED = 6

describe('the website on Solana, in a real browser', { skip, timeout: 900_000 }, () => {
  let stack: SolanaBrowserStack
  let chain: ValidatorChain
  let site: string
  let listingId = ''
  let browser: Browser
  let context: BrowserContext
  let page: Page
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
  /** Waits for the order page's status badge itself (a text search would also match the timeline's step names). */
  const waitForBadge = (label: string) => page.locator('h2:has-text("On-Chain Order") + *', { hasText: new RegExp(`^\\s*${label}\\s*$`) }).waitFor({ timeout: 30_000 })
  const escrowIdOf = (url: string) => BigInt(/\/orders\/onchain\/(\d+)/.exec(url)?.[1] ?? assert.fail(`not an order page: ${url}`))

  before(async () => {
    stack = await startSolanaBrowserStack({ mode: 'start' })
    ;({ chain, site, listingId } = stack)

    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox'] })
    context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await context.newPage()
    const note = (line: string) => process.env.E2E_DIAGNOSTICS && appendFileSync(process.env.E2E_DIAGNOSTICS, `${line}\n`)
    page.on('pageerror', (e) => {
      problems.push(`pageerror: ${e.message}`)
      note(`pageerror: ${e.stack ?? e.message}`)
    })
    page.on('console', (m) => {
      // A failed request is reported once, with its URL, by the response listener below.
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push(`console: ${m.text()}`)
      note(`console.${m.type()}: ${m.text()}`)
    })
    page.on('requestfailed', (r) => note(`requestfailed: ${r.method()} ${r.url()} ${r.failure()?.errorText}`))
    page.on('response', (r) => {
      if (r.status() < 400) return
      const line = `${r.status()} ${r.request().method()} ${r.url()}`
      note(`response: ${line}`)
      // The site's lookups of things an order may not have yet (a dispute, a verdict, a rating) answer 404 for "none".
      const none = r.status() === 404 && r.request().method() === 'GET' && /\/(disputes|verifications|ratings\/escrow)\/\d+\?/.test(r.url())
      if (!none && !/favicon/.test(r.url())) problems.push(`http: ${line}`)
    })
    // The mock wallet holds the buyer's key out here; the page only asks it to sign.
    await installMockWallet(page, { address: buyerAddress(), secretKey: chain.secretKeys.buyer, kit: stack.kit })
  })

  after(async () => {
    await browser?.close()
    await stack?.stop()
  })

  test('the wallet is found, connects, and signs in once: the top bar shows its address and USDC', async () => {
    await page.goto(`${site}/app/marketplace`)
    await page.getByRole('button', { name: 'Connect Wallet' }).click()
    const short = `${buyerAddress().slice(0, 4)}…${buyerAddress().slice(-4)}`
    await page.getByRole('button', { name: short }).waitFor()
    await page.getByText('50.00 USDC').waitFor().catch(async (error) => {
      await shot('no-balance')
      throw error
    })
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
    const task = await stack.prisma.task.findUnique({ where: { chainId_escrowId: { chainId: SOL, escrowId: escrowId.toString() } } })
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
    await waitForBadge('SETTLED')
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
      const row = await stack.prisma.dispute.findUnique({ where: { chainId_escrowId: { chainId: SOL, escrowId: escrowId.toString() } } })
      if (row?.reason === reason && row.sellerResponse) break
      assert.ok(i < 99, "the reason and the seller's answer never reached the API")
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
    await waitForBadge('REFUNDED')
    await shot('refunded')
  })

  test('nothing in the page threw, logged an error or got a failed request', () => {
    assert.deepEqual(problems, [])
  })
})
