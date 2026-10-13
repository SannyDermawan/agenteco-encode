import { LIMITS, type DataStats } from '../shared/capabilities/definitions.ts'

/** A brief that breaks a capability's input limits, the seller must not start the job. */
export class InvalidInputError extends Error {}

/**
 * Minimal RFC 4180 CSV parser: comma-separated, double-quoted fields may
 * contain commas, newlines and "" escapes. Enough for pasted spreadsheets.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') {
        quoted = false
      } else {
        field += c
      }
    } else if (c === '"') {
      quoted = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      if (row.some((f) => f.trim() !== '')) rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }
  row.push(field)
  if (row.some((f) => f.trim() !== '')) rows.push(row)
  return rows
}

function toNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(/[$,%\s]/g, '')
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function toDate(raw: string): number | null {
  const v = raw.trim()
  // Plain numbers are values, not dates.
  if (v === '' || /^-?\d+(\.\d+)?$/.test(v)) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits

/**
 * Per numeric column: count, mean, median, min, max, stddev (population).
 * If a column holds dates, adds the first→last change of each numeric
 * column over time. Pure, the AI only interprets these numbers.
 */
export function computeStats(csv: string): DataStats {
  const table = parseCsv(csv)
  if (table.length < 2) throw new InvalidInputError('The CSV needs a header row and at least one data row.')
  const [header, ...body] = table
  if (header.length > LIMITS.csvColumns) {
    throw new InvalidInputError(`The CSV has ${header.length} columns; the limit is ${LIMITS.csvColumns}.`)
  }
  if (body.length > LIMITS.csvRows) {
    throw new InvalidInputError(`The CSV has ${body.length} data rows; the limit is ${LIMITS.csvRows}.`)
  }
  const columns = header.map((h, i) => h.trim() || `column_${i + 1}`)

  const numeric: DataStats['numeric'] = []
  const numericValues = new Map<number, (number | null)[]>()
  let dateCol: number | null = null

  columns.forEach((name, c) => {
    const cells = body.map((r) => r[c] ?? '')
    const nums = cells.map(toNumber)
    const present = nums.filter((n): n is number => n !== null)
    // Numeric when at least 80% of non-empty cells parse as numbers.
    const nonEmpty = cells.filter((v) => v.trim() !== '').length
    if (present.length > 0 && present.length >= 0.8 * nonEmpty) {
      const sorted = [...present].sort((a, b) => a - b)
      const mean = present.reduce((s, n) => s + n, 0) / present.length
      const mid = Math.floor(sorted.length / 2)
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
      const variance = present.reduce((s, n) => s + (n - mean) ** 2, 0) / present.length
      numeric.push({
        column: name,
        count: present.length,
        mean: round(mean),
        median: round(median),
        min: sorted[0],
        max: sorted[sorted.length - 1],
        stddev: round(Math.sqrt(variance)),
      })
      numericValues.set(c, nums)
    } else if (dateCol === null && nonEmpty > 0 && cells.filter((v) => toDate(v) !== null).length >= 0.8 * nonEmpty) {
      dateCol = c
    }
  })

  const trends: DataStats['trends'] = []
  if (dateCol !== null) {
    const dc = dateCol
    for (const [c, nums] of numericValues) {
      const points = body
        .map((r, i) => ({ t: toDate(r[dc] ?? ''), label: (r[dc] ?? '').trim(), v: nums[i] }))
        .filter((p): p is { t: number; label: string; v: number } => p.t !== null && p.v !== null)
        .sort((a, b) => a.t - b.t)
      if (points.length < 2) continue
      const first = points[0]
      const last = points[points.length - 1]
      const changePct = first.v === 0 ? null : round(((last.v - first.v) / Math.abs(first.v)) * 100, 2)
      trends.push({
        dateColumn: columns[dc],
        valueColumn: columns[c],
        firstDate: first.label,
        lastDate: last.label,
        firstValue: first.v,
        lastValue: last.v,
        changePct,
        direction: last.v > first.v ? 'up' : last.v < first.v ? 'down' : 'flat',
      })
    }
  }

  if (numeric.length === 0) throw new InvalidInputError('The CSV has no numeric column to analyse.')
  return { rows: body.length, columns, numeric, trends }
}
