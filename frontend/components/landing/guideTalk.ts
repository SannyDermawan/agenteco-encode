import { listCapabilities } from '@/lib/api/capabilities'
import { TOKEN_SYMBOL } from '@/lib/web3/landingNetwork'

/**
 * What Eco, the landing page's guide, says outside its per-section lines: the opening greeting, the
 * guided tour, and its reactions to things happening on the page.
 */

const pickOne = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)]

const VISIT_KEY = 'agenteco-guide-visited'

// Decided once per page load: effects can run more than once (React's dev double-run, the guide being
// hidden and shown again), and only the first look at storage tells a new visitor from a returning one.
let returningVisitor: boolean | undefined

/** Whether this browser had been here before this page load (and remembers this visit for next time). */
export function markVisit(): boolean {
  if (returningVisitor !== undefined) return returningVisitor
  try {
    returningVisitor = localStorage.getItem(VISIT_KEY) !== null
    localStorage.setItem(VISIT_KEY, String(Date.now()))
  } catch {
    returningVisitor = false
  }
  return returningVisitor
}

/** The opening line, by the visitor's local time and whether they have been here before. */
export function greeting(returning: boolean, hour = new Date().getHours()): string {
  if (hour >= 22 || hour < 4) {
    return returning ? 'Up late? Me too! Welcome back — double-click me for a quick tour.' : "Up late? Me too! I'm Eco — scroll down and I'll show you around."
  }
  const time = hour < 11 ? 'Good morning!' : hour < 17 ? 'Good afternoon!' : 'Good evening!'
  return returning ? `${time} Welcome back! Double-click me any time for a quick tour.` : `${time} I'm Eco — I'll show you around. Scroll down, I'll tag along!`
}

/** The guided tour: one stop per section, in page order. */
// `focus` is what to bring into view instead of the top of the section (a [data-guide-focus] marker), and
// `block` where on screen to put it: the product's pinned steps start at the top (so step 1 is fully on screen,
// not half hidden under the heading), the call-to-action card sits in the middle of the screen.
// `step` (product only): press that tab of the pinned steps, so the page slides on to step 2, 3 and 4.
/**
 * The tour: about a minute in total. Each stop has its own time on screen (`ms`), sized to its line, so a
 * short stop (a pinned product step, the FAQ) does not hold as long as a section that needs explaining.
 */
export const TOUR: { key: string; line: string; ms: number; focus?: string; block?: 'start' | 'center'; step?: number }[] = [
  { key: 'product', focus: '[data-guide-focus="steps"]', block: 'start', ms: 3500, line: 'A marketplace where AI agents hire AI agents. Step 1: find a seller and haggle.' },
  { key: 'product', step: 1, ms: 2200, line: 'Step 2: the money locks in escrow.' },
  { key: 'product', step: 2, ms: 2700, line: "Step 3: the seller's AI works, the buyer's AI checks." },
  { key: 'product', step: 3, ms: 2200, line: 'Step 4: a bad result opens a dispute.' },
  { key: 'capabilities', ms: 3200, line: 'These sellers are online now, each with a price and a secret floor.' },
  { key: 'roles', ms: 2900, line: 'Buyer, seller, or both. We can even run your agent.' },
  { key: 'how-it-works', ms: 3300, line: "They haggle, lock money in escrow, and the buyer's AI checks the work." },
  { key: 'proof', ms: 2900, line: 'Every deal is a real transaction on a public testnet.' },
  { key: 'developers', ms: 2700, line: 'Prefer code to a prompt? The SDK, CLI and MCP server are open.' },
  { key: 'faq', ms: 2100, line: 'Still curious? Quick answers live here.' },
  { key: 'cta', focus: '[data-guide-focus="cta"]', block: 'center', ms: 2800, line: "That's the tour! Launch App and try a deal." },
]

/** How long a line stays up: enough time to read it. */
export const readMs = (text: string) => Math.round(2600 + text.length * 32)

export const ESCROW_LINE =
  "Escrow is a locked box on the blockchain. The buyer's money waits inside while the work is done, and the seller is paid only when the work checks out."

export const PET_LINES = ['Hehe… that’s nice.', 'Aww, more please!', 'Okay, now I’m blushing.', 'Best. Pat. Ever.']
export const FAQ_LINES = ['Good question!', 'Ooh, I wondered that too.', 'Smart thing to ask!', 'Good one — read on!']
export const BACK_LINES = ['You’re back! I missed you.', 'There you are! I kept your spot warm.', 'Oh hi! Welcome back.']

/** Hovering a button that leads into the app. */
export function hoverLine(href: string): string {
  if (href === '/app/marketplace') return pickOne(['Yes! The marketplace is full of agents.', 'Go on — the agents are waiting!'])
  if (href === '/app/create-agent') return 'Make your own agent? I’ll cheer you on!'
  return 'That one takes you into the app!'
}

/** The negotiation simulator just finished a run. `byUser`: the visitor moved a slider or pressed Replay. */
export function simLine(kind: 'deal' | 'no-deal', price: number | undefined, byUser: boolean): string | null {
  if (kind === 'deal') return byUser ? `Nice haggling — deal at ${price?.toFixed(2)} ${TOKEN_SYMBOL}!` : 'Look, they made a deal!'
  return byUser ? 'No deal — their prices never met. Try a bigger budget?' : null
}

/** A line with the marketplace's live numbers from the API, or null if it can't be reached. */
export async function liveLine(): Promise<string | null> {
  try {
    const caps = await listCapabilities()
    const online = caps.reduce((n, c) => n + (c.stats?.onlineSellers ?? 0), 0)
    const deals = caps.reduce((n, c) => n + (c.stats?.hires ?? 0), 0)
    if (!online && !deals) return null
    const sellers = `${online} seller${online === 1 ? ' is' : 's are'} online`
    if (!deals) return `Live right now: ${sellers} — be the first to hire one!`
    return `Live right now: ${sellers}, and ${deals} deal${deals === 1 ? ' has' : 's have'} been made on-chain so far!`
  } catch {
    return null
  }
}
