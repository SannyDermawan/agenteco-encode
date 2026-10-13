import type { CoinMarket, CryptoBriefOutput } from '../shared/capabilities/definitions.ts'
import { InvalidInputError } from './dataAnalysis.ts'

const API = 'https://api.coingecko.com/api/v3/coins/markets'
const CACHE_MS = 60_000
const cache = new Map<string, { at: number; coins: CoinMarket[] }>()

interface CoinGeckoMarket {
  id: string
  symbol: string
  name: string
  current_price: number | null
  price_change_percentage_24h_in_currency?: number | null
  price_change_percentage_7d_in_currency?: number | null
  total_volume: number | null
  market_cap: number | null
}

/** Maps CoinGecko's /coins/markets rows to our schema. Pure, tested directly. */
export function toCoinMarkets(rows: CoinGeckoMarket[]): CoinMarket[] {
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol.toUpperCase(),
    name: r.name,
    priceUsd: r.current_price ?? 0,
    change24hPct: r.price_change_percentage_24h_in_currency ?? null,
    change7dPct: r.price_change_percentage_7d_in_currency ?? null,
    volume24hUsd: r.total_volume ?? null,
    marketCapUsd: r.market_cap ?? null,
  }))
}

/**
 * Live prices, 24h/7d change, volume and market cap from CoinGecko's public
 * API (no key needed; COINGECKO_API_KEY adds a demo key for higher limits).
 * Cached 60 s per coin set. Unknown coin ids are an input error.
 */
export async function fetchCoinMarkets(coinIds: string[]): Promise<CryptoBriefOutput['data']> {
  const ids = [...new Set(coinIds.map((c) => c.trim().toLowerCase()))].sort()
  const key = ids.join(',')
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return { coins: hit.coins, fetchedAt: new Date(hit.at).toISOString(), source: 'CoinGecko' }
  }

  const url = `${API}?vs_currency=usd&ids=${encodeURIComponent(key)}&price_change_percentage=24h,7d`
  const apiKey = process.env.COINGECKO_API_KEY?.trim()
  const res = await fetch(url, { headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : {}, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`CoinGecko returned HTTP ${res.status}`)
  const coins = toCoinMarkets((await res.json()) as CoinGeckoMarket[])

  const missing = ids.filter((id) => !coins.some((c) => c.id === id))
  if (missing.length) throw new InvalidInputError(`Unknown CoinGecko coin id(s): ${missing.join(', ')}`)

  const at = Date.now()
  cache.set(key, { at, coins })
  return { coins, fetchedAt: new Date(at).toISOString(), source: 'CoinGecko' }
}
