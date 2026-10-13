import type { ReactNode } from 'react'
import {
  LANGUAGES,
  isCapabilityId,
  parseResult,
  type CryptoBriefOutput,
  type DataAnalysisOutput,
  type TranslationOutput,
  type TxExplainerOutput,
} from '@shared/capabilities/definitions'
import { explorerAddressUrl } from '@/lib/web3/network'
import { explorerTxUrl } from '@/lib/web3/escrowEvents'

const AI_UNAVAILABLE = 'AI unavailable'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium tracking-[0.08em] text-[#8B8D96]">{title}</div>
      {children}
    </div>
  )
}

function Prose({ text }: { text: string }) {
  return (
    <div className="space-y-2">
      {text.includes(AI_UNAVAILABLE) && (
        <span className="inline-block rounded-full border border-[#F59E0B]/35 bg-[#F59E0B]/10 px-2 py-0.5 text-[10.5px] font-medium text-[#F59E0B]">
          AI unavailable, data only
        </span>
      )}
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[#F5F5F7]">{text}</p>
    </div>
  )
}

const num = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? '-' : n.toLocaleString('en-US', { maximumFractionDigits: digits })
const pct = (n: number | null) => (n === null ? '-' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`)
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
      <table className="w-full text-left text-[12px]">
        <thead className="bg-[#0B0C11] text-[#8B8D96]">
          <tr>
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-[#F5F5F7]">
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-white/[0.04]">
              {r.map((c, j) => (
                <td key={j} className="whitespace-nowrap px-3 py-2">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Translation({ r }: { r: TranslationOutput }) {
  const language = LANGUAGES.find((l) => l.code === r.targetLanguage)?.name ?? r.targetLanguage
  return (
    <div className="space-y-4">
      <Section title={`TRANSLATION · ${language.toUpperCase()}`}>
        <div className="rounded-xl border border-white/[0.06] bg-[#0B0C11] p-3.5">
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[#F5F5F7]">{r.translatedText}</p>
        </div>
      </Section>
      {r.notes && (
        <Section title="TRANSLATOR NOTES">
          <p className="text-[12.5px] text-[#8B8D96]">{r.notes}</p>
        </Section>
      )}
    </div>
  )
}

function DataAnalysis({ r }: { r: DataAnalysisOutput }) {
  return (
    <div className="space-y-4">
      <Section title="SUMMARY">
        <Prose text={r.summary} />
      </Section>
      {r.insights.length > 0 && (
        <Section title="INSIGHTS">
          <ul className="list-disc space-y-1 pl-5 text-[13px] text-[#F5F5F7]">
            {r.insights.map((insight, i) => (
              <li key={i}>{insight}</li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={`STATISTICS · ${r.stats.rows} ROWS (COMPUTED BY CODE)`}>
        <Table
          head={['Column', 'Mean', 'Median', 'Min', 'Max', 'Std dev']}
          rows={r.stats.numeric.map((c) => [c.column, num(c.mean), num(c.median), num(c.min), num(c.max), num(c.stddev)])}
        />
      </Section>
      {r.stats.trends.length > 0 && (
        <Section title="TRENDS">
          <ul className="space-y-1 text-[12.5px] text-[#F5F5F7]">
            {r.stats.trends.map((t) => (
              <li key={`${t.dateColumn}-${t.valueColumn}`}>
                <span className="text-[#8B8D96]">{t.valueColumn}:</span> {num(t.firstValue)} ({t.firstDate}) → {num(t.lastValue)} ({t.lastDate}){' '}
                <span className={t.direction === 'up' ? 'text-[#22C55E]' : t.direction === 'down' ? 'text-[#EF4444]' : 'text-[#8B8D96]'}>
                  {t.changePct === null ? t.direction : pct(t.changePct)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

function CryptoBrief({ r }: { r: CryptoBriefOutput }) {
  return (
    <div className="space-y-4">
      <Section title="BRIEF">
        <Prose text={r.brief} />
      </Section>
      <Section title="MARKET DATA (USD)">
        <Table
          head={['Coin', 'Price', '24h', '7d', 'Volume 24h', 'Market cap']}
          rows={r.data.coins.map((c) => [
            `${c.name} (${c.symbol})`,
            `$${num(c.priceUsd, c.priceUsd < 1 ? 6 : 2)}`,
            pct(c.change24hPct),
            pct(c.change7dPct),
            `$${num(c.volume24hUsd, 0)}`,
            `$${num(c.marketCapUsd, 0)}`,
          ])}
        />
        {/* The CoinGecko Demo API requires attribution. */}
        <p className="mt-1.5 text-[11px] text-[#54565F]">
          Fetched {new Date(r.data.fetchedAt).toLocaleString()} · Data by{' '}
          <a href="https://www.coingecko.com/" target="_blank" rel="noreferrer" className="text-[#8FA9FF] hover:underline">
            CoinGecko
          </a>
        </p>
      </Section>
      <p className="rounded-xl border border-white/[0.06] bg-[#0B0C11] px-3 py-2 text-[11.5px] text-[#8B8D96]">{r.disclaimer}</p>
    </div>
  )
}

function TxExplainer({ r }: { r: TxExplainerOutput }) {
  const f = r.facts
  return (
    <div className="space-y-4">
      <Section title="EXPLANATION">
        <Prose text={r.explanation} />
      </Section>
      <Section title="FACTS (READ FROM THE CHAIN BY CODE)">
        <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-2">
          <div>
            <span className="text-[#8B8D96]">Tx </span>
            <a href={explorerTxUrl(f.hash)} target="_blank" rel="noreferrer" className="font-mono text-[#8FA9FF] hover:underline">
              {short(f.hash)} ↗
            </a>
          </div>
          <div>
            <span className="text-[#8B8D96]">Status </span>
            <span className={f.status === 'success' ? 'text-[#22C55E]' : 'text-[#EF4444]'}>{f.status}</span>
          </div>
          <div>
            <span className="text-[#8B8D96]">From </span>
            <a href={explorerAddressUrl(f.from)} target="_blank" rel="noreferrer" className="font-mono text-[#F5F5F7] hover:underline">
              {short(f.from)}
            </a>
          </div>
          <div>
            <span className="text-[#8B8D96]">To </span>
            {f.to ? (
              <a href={explorerAddressUrl(f.to)} target="_blank" rel="noreferrer" className="font-mono text-[#F5F5F7] hover:underline">
                {short(f.to)}
              </a>
            ) : (
              <span className="text-[#F5F5F7]">contract creation</span>
            )}
          </div>
          <div>
            <span className="text-[#8B8D96]">Value </span>
            <span className="text-[#F5F5F7]">{f.valueNative}</span>
          </div>
          <div>
            <span className="text-[#8B8D96]">Gas used </span>
            <span className="text-[#F5F5F7]">{f.gasUsed}</span> <span className="text-[#54565F]">· block {f.blockNumber}</span>
          </div>
        </div>
      </Section>
      {f.decodedEvents.length > 0 && (
        <Section title={`DECODED EVENTS${f.otherLogs ? ` · ${f.otherLogs} OTHER LOG(S)` : ''}`}>
          <ul className="space-y-1.5 text-[12px]">
            {f.decodedEvents.map((e, i) => (
              <li key={i} className="rounded-lg border border-white/[0.06] bg-[#0B0C11] px-3 py-2">
                <span className="font-medium text-[#F5F5F7]">{e.event}</span> <span className="font-mono text-[#54565F]">{short(e.contract)}</span>
                <div className="mt-0.5 break-all font-mono text-[11px] text-[#8B8D96]">
                  {Object.entries(e.args)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('  ')}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

/**
 * A delivered result shown the way its capability reads (spec §10.2), not as
 * raw JSON. A result that doesn't match its capability's schema falls back to
 * the raw JSON so nothing is ever hidden.
 */
export function CapabilityResultView({ capability, result }: { capability: string; result: unknown }) {
  if (isCapabilityId(capability)) {
    const parsed = parseResult(capability, result)
    if (parsed.success) {
      switch (capability) {
        case 'translation':
          return <Translation r={parsed.data as TranslationOutput} />
        case 'data_analysis':
          return <DataAnalysis r={parsed.data as DataAnalysisOutput} />
        case 'crypto_market_brief':
          return <CryptoBrief r={parsed.data as CryptoBriefOutput} />
        case 'tx_explainer':
          return <TxExplainer r={parsed.data as TxExplainerOutput} />
      }
    }
  }
  return (
    <pre className="overflow-x-auto rounded-xl border border-white/[0.06] bg-[#0B0C11] p-3.5 text-[12px] leading-relaxed text-[#F5F5F7]">
      {JSON.stringify(result, null, 2)}
    </pre>
  )
}
