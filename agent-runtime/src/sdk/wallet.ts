import { createKeyPairSignerFromBytes } from '@solana/kit'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { WalletAccount } from '../authHeaders.ts'
import { chainFamily, normalizeAnyChainId, type ChainFamily } from '../chain/multi.ts'
import { UnknownChainError, signerChain } from '../chain/registry.ts'
import { SOLANA_DEVNET_CHAIN_ID, solanaAddressOfSecretKey, solanaWalletAccount } from '../chain/solana.ts'
import { signerSolana } from '../chain/solana-registry.ts'
import type { ChainAdapter, ChainId } from '../chain/types.ts'

/**
 * An agent's key, on either chain family: an EVM private key (`0x…` hex) or a Solana secret key
 * (the 64 bytes of a Solana CLI keypair file: seed, then public key). Which family a key belongs to
 * follows from its form, and a key is only ever used on a chain of its own family.
 */
export type WalletKey = Hex | Uint8Array

export const keyFamily = (key: WalletKey): ChainFamily => (typeof key === 'string' ? 'evm' : 'solana')

/** The wallet address of a key, without any network or async work. */
export function walletAddress(key: WalletKey): string {
  return typeof key === 'string' ? privateKeyToAccount(key).address : solanaAddressOfSecretKey(key)
}

/**
 * The CAIP-2 id an option names, for a key of the given family. Unset: the primary EVM chain for an
 * EVM key, Solana devnet for a Solana key. Throws for an unknown chain or one of the other family.
 */
export function chainFor(key: WalletKey, input: string | number | undefined, fallbackEvm: ChainId): ChainId {
  if (input === undefined) return keyFamily(key) === 'solana' ? SOLANA_DEVNET_CHAIN_ID : fallbackEvm
  const id = normalizeAnyChainId(input)
  if (!id) throw new UnknownChainError(`Unknown chain: ${input}`)
  assertKeyFits(key, id)
  return id
}

/** Throws unless `key` belongs to the family of `chainId` (an EVM key cannot sign on Solana, nor the other way round). */
export function assertKeyFits(key: WalletKey, chainId: ChainId): void {
  const chain = chainFamily(chainId)
  if (keyFamily(key) !== chain) {
    throw new Error(
      chain === 'solana'
        ? `${chainId} is a Solana chain, but this key is an EVM private key. Pass a Solana secret key (64 bytes) for it.`
        : `${chainId} is an EVM chain, but this key is a Solana secret key. Pass an EVM private key (0x…) for it.`
    )
  }
}

/** A key opened for one chain: the account that signs API requests and the adapter that signs transactions. */
export interface Wallet {
  chainId: ChainId
  family: ChainFamily
  address: string
  account: WalletAccount
  adapter: ChainAdapter
}

/** An EVM key opened on an EVM chain, synchronous, so a chain nobody configured fails where the caller starts, not later. */
export function openEvmWallet(chainId: ChainId, key: Hex): Wallet {
  assertKeyFits(key, chainId)
  const account = privateKeyToAccount(key)
  return { chainId, family: 'evm', address: account.address, account, adapter: signerChain(chainId, key) }
}

/** The account that signs API requests for `key`, it needs no chain, so it can exist before one is chosen. */
export async function accountOf(key: WalletKey): Promise<WalletAccount> {
  return typeof key === 'string' ? privateKeyToAccount(key) : solanaWalletAccount(await createKeyPairSignerFromBytes(key))
}

/**
 * Opens `key` on a chain. EVM needs no network; Solana derives its signer first (async), and needs the
 * chain configured (see chain/solana-registry.ts), a program address has no default deployment.
 */
export async function openWallet(chainId: ChainId, key: WalletKey): Promise<Wallet> {
  assertKeyFits(key, chainId)
  if (typeof key === 'string') return openEvmWallet(chainId, key)
  const signer = await createKeyPairSignerFromBytes(key)
  return { chainId, family: 'solana', address: signer.address, account: solanaWalletAccount(signer), adapter: signerSolana(chainId, signer) }
}
