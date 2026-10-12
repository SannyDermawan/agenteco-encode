/**
 * Byte helpers on plain Uint8Array. The Solana adapter runs in Node and in a browser bundle; Node's Buffer is a
 * different thing in each (a bundler's polyfill lacks methods and is strict about argument types), so none of it
 * uses Buffer.
 */

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function base64ToBytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)

function inRange(n: bigint, min: bigint, max: bigint, what: string): bigint {
  if (n < min || n > max) throw new RangeError(`${n} does not fit in ${what}`)
  return n
}

export const readU8 = (b: Uint8Array, offset: number): number => view(b).getUint8(offset)
export const readU16 = (b: Uint8Array, offset: number): number => view(b).getUint16(offset, true)
export const readU64 = (b: Uint8Array, offset: number): bigint => view(b).getBigUint64(offset, true)
export const readI64 = (b: Uint8Array, offset: number): bigint => view(b).getBigInt64(offset, true)

/** Little-endian encodings; a value that does not fit throws instead of wrapping. */
export function u16le(n: number): Uint8Array {
  const out = new Uint8Array(2)
  view(out).setUint16(0, Number(inRange(BigInt(n), 0n, 0xffffn, 'u16')), true)
  return out
}

export function u64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8)
  view(out).setBigUint64(0, inRange(n, 0n, 0xffff_ffff_ffff_ffffn, 'u64'), true)
  return out
}

export function i64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8)
  view(out).setBigInt64(0, inRange(n, -(2n ** 63n), 2n ** 63n - 1n, 'i64'), true)
  return out
}
