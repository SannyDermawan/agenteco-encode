import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto'

/**
 * Making a Solana key needs Node's crypto, so it lives apart from ./solana.ts, which the browser
 * bundle imports (the website's Solana pages run the SolanaAdapter there).
 */

// The fixed front of an ed25519 private key in PKCS#8 DER; the 32-byte seed follows.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** A new random Solana secret key (64 bytes: seed, then public key), from the system's secure random source. */
export function generateSolanaSecretKey(): Uint8Array {
  const seed = randomBytes(32)
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  return new Uint8Array(Buffer.concat([seed, spki.subarray(spki.length - 32)]))
}
