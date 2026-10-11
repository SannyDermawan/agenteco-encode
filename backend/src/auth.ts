import type { Request } from 'express'
import { recoverMessageAddress } from 'viem'
import { verifySolanaSignature } from '../../agent-runtime/src/chain/solana.ts'
import { normalizeWallet, sameWallet, walletFamily } from '../../agent-runtime/src/shared/wallets.ts'

// A signature is only valid for this long after its timestamp — bounds how
// long a captured header set could be replayed.
const MAX_AGE_MS = 60_000

/** `wallet` is the address as the caller sent it: 0x… (EVM) or base58 (Solana). */
export type AuthResult = { ok: true; wallet: string } | { ok: false; error: string }

/**
 * Cryptographic proof of wallet ownership — replaces trusting a plain
 * x-owner-wallet header. The caller signs `AgentEco:<wallet>:<timestamp>`
 * with their private key (see agent-runtime/src/authHeaders.ts and
 * frontend/lib/api/authHeaders.ts) and sends the signature + timestamp
 * alongside the claimed wallet — an EIP-191 signature for an EVM wallet, an ed25519 signature
 * (base58) for a Solana wallet. This only proves *who is calling* —
 * whether that wallet is allowed to touch a given resource is still a
 * separate, per-route check against that resource's stored ownerWallet.
 */
export async function verifyOwnerAuth(req: Request): Promise<AuthResult> {
  const wallet = req.header('x-owner-wallet')
  const signature = req.header('x-signature')
  const timestampRaw = req.header('x-timestamp')

  const family = wallet ? walletFamily(wallet) : null
  if (!wallet || !family) return { ok: false, error: 'Missing or invalid x-owner-wallet header' }
  if (!signature) return { ok: false, error: 'Missing x-signature header' }
  if (!timestampRaw) return { ok: false, error: 'Missing x-timestamp header' }

  const timestamp = Number(timestampRaw)
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > MAX_AGE_MS) {
    return { ok: false, error: 'x-timestamp is missing, invalid, or expired (must be within 60s of the server clock)' }
  }

  // EVM addresses are case-insensitive and signed lowercase; a Solana address is signed exactly as it is.
  const message = `AgentEco:${normalizeWallet(wallet)}:${timestamp}`
  if (family === 'solana') {
    if (!(await verifySolanaSignature({ address: wallet, message, signature }))) {
      return { ok: false, error: 'Signature does not match x-owner-wallet' }
    }
  } else {
    try {
      const recovered = await recoverMessageAddress({ message, signature: signature as `0x${string}` })
      if (!sameWallet(recovered, wallet)) {
        return { ok: false, error: 'Signature does not match x-owner-wallet' }
      }
    } catch {
      return { ok: false, error: 'Malformed signature' }
    }
  }

  return { ok: true, wallet }
}

/**
 * Is `wallet` the agent's owner: the wallet it was registered under, or the person it is linked
 * to (an approved device link — Agent.accountWallet)? The checks that guard what a person may do
 * to an agent from the website (edit, pause, delete, appeal) use this.
 */
export function isAgentOwnerWallet(wallet: string, agent: { ownerWallet: string; accountWallet?: string | null }): boolean {
  return sameWallet(wallet, agent.ownerWallet) || (!!agent.accountWallet && sameWallet(wallet, agent.accountWallet))
}

/**
 * Is `wallet` allowed to act as this agent? True for the human owner
 * (administrative actions from the website — toggling online/offline,
 * editing) OR the agent's own operating wallet (a hosted buyer task's host
 * runtime, signing with the key it holds for exactly this agent). A
 * self-custodied agent like buyer-agent/seller-agent has these be the same
 * address anyway, so this is a strict superset of the old check.
 */
export function isAuthorizedForAgent(wallet: string, agent: { ownerWallet: string; walletAddress: string | null; accountWallet?: string | null }): boolean {
  if (isAgentOwnerWallet(wallet, agent)) return true
  if (agent.walletAddress && sameWallet(wallet, agent.walletAddress)) return true
  return false
}
