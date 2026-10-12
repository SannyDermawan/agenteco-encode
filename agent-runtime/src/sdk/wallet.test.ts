import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createKeyPairSignerFromBytes, getBase58Decoder } from '@solana/kit'
import { verifyMessage } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { buildAuthHeaders } from '../authHeaders.ts'
import { PRIMARY_CHAIN_ID } from '../chain/registry.ts'
import { SOLANA_DEVNET_CHAIN_ID, parseSolanaSecretKey, solanaWalletAccount, verifySolanaSignature } from '../chain/solana.ts'
import { generateSolanaSecretKey } from '../chain/solana-keys.ts'
import { accountOf, assertKeyFits, chainFor, keyFamily, openWallet, walletAddress } from './wallet.ts'

const EVM_CHAIN = 'eip155:97'

test('a Solana key is 64 bytes, its address needs no network, and it matches the signer it makes', async () => {
  const secret = await generateSolanaSecretKey()
  assert.equal(secret.length, 64)
  const signer = await createKeyPairSignerFromBytes(secret)
  assert.equal(walletAddress(secret), signer.address)
  assert.notDeepEqual(secret, await generateSolanaSecretKey(), 'every key is new')
  assert.throws(() => walletAddress(new Uint8Array(32)), /64 bytes/)
})

test('a Solana secret key is read from a CLI keypair file or from base58, and a damaged one is refused', async () => {
  const secret = await generateSolanaSecretKey()
  assert.deepEqual(await parseSolanaSecretKey(JSON.stringify([...secret])), secret)
  assert.deepEqual(await parseSolanaSecretKey(`  ${getBase58Decoder().decode(secret)}\n`), secret)
  await assert.rejects(parseSolanaSecretKey('[1,2,3]'), /expected 64 bytes, got 3/)
  await assert.rejects(parseSolanaSecretKey('not a key'), /expected 64 bytes|Not a Solana secret key/)
  const damaged = Uint8Array.from(secret)
  damaged[40] ^= 1 // the public half no longer belongs to the seed
  await assert.rejects(parseSolanaSecretKey(JSON.stringify([...damaged])), /does not belong/)
})

test('the family of a key follows from its form, and it is only used on a chain of its own family', async () => {
  const evm = generatePrivateKey()
  const sol = await generateSolanaSecretKey()
  assert.equal(keyFamily(evm), 'evm')
  assert.equal(keyFamily(sol), 'solana')
  assert.equal(walletAddress(evm), privateKeyToAccount(evm).address)
  assert.doesNotThrow(() => assertKeyFits(evm, EVM_CHAIN))
  assert.doesNotThrow(() => assertKeyFits(sol, SOLANA_DEVNET_CHAIN_ID))
  assert.throws(() => assertKeyFits(evm, SOLANA_DEVNET_CHAIN_ID), /Solana chain, but this key is an EVM private key/)
  assert.throws(() => assertKeyFits(sol, EVM_CHAIN), /EVM chain, but this key is a Solana secret key/)
  await assert.rejects(openWallet(SOLANA_DEVNET_CHAIN_ID, evm), /EVM private key/)
  await assert.rejects(openWallet(EVM_CHAIN, sol), /Solana secret key/)
})

test('the chain an option names: the key\'s own default, any known spelling, nothing of another family', async () => {
  const evm = generatePrivateKey()
  const sol = await generateSolanaSecretKey()
  assert.equal(chainFor(evm, undefined, PRIMARY_CHAIN_ID), PRIMARY_CHAIN_ID)
  assert.equal(chainFor(sol, undefined, PRIMARY_CHAIN_ID), SOLANA_DEVNET_CHAIN_ID)
  assert.equal(chainFor(sol, 'solana-devnet', PRIMARY_CHAIN_ID), SOLANA_DEVNET_CHAIN_ID)
  assert.equal(chainFor(sol, SOLANA_DEVNET_CHAIN_ID, PRIMARY_CHAIN_ID), SOLANA_DEVNET_CHAIN_ID)
  assert.equal(chainFor(evm, 'bsc-testnet', PRIMARY_CHAIN_ID), 'eip155:97')
  assert.throws(() => chainFor(evm, 'solana-devnet', PRIMARY_CHAIN_ID), /Solana chain/)
  assert.throws(() => chainFor(sol, 'base-sepolia', PRIMARY_CHAIN_ID), /EVM chain/)
  assert.throws(() => chainFor(evm, 'no-such-chain', PRIMARY_CHAIN_ID), /Unknown chain: no-such-chain/)
  assert.throws(() => chainFor(sol, 'solana:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', PRIMARY_CHAIN_ID), /Unknown chain/)
})

test('the same request headers prove an EVM or a Solana wallet', async () => {
  // EVM: the text names the lowercase address, the signature is EIP-191 hex (unchanged).
  const evmKey = generatePrivateKey()
  const evm = await accountOf(evmKey)
  const evmHeaders = await buildAuthHeaders(evm)
  assert.equal(evmHeaders['x-owner-wallet'], evm.address)
  assert.match(evmHeaders['x-signature'], /^0x[0-9a-f]+$/)
  const evmMessage = `AgentEco:${evm.address.toLowerCase()}:${evmHeaders['x-timestamp']}`
  assert.equal(await verifyMessage({ address: evm.address as `0x${string}`, message: evmMessage, signature: evmHeaders['x-signature'] as `0x${string}` }), true)

  // Solana: the text names the address exactly, the signature is ed25519 in base58.
  const secret = await generateSolanaSecretKey()
  const account = await accountOf(secret)
  assert.equal(account.address, walletAddress(secret))
  const headers = await buildAuthHeaders(account)
  assert.equal(headers['x-owner-wallet'], account.address)
  const message = `AgentEco:${account.address}:${headers['x-timestamp']}`
  assert.equal(await verifySolanaSignature({ address: account.address, message, signature: headers['x-signature'] }), true)
  assert.equal(await verifySolanaSignature({ address: account.address, message: `${message}x`, signature: headers['x-signature'] }), false)
  assert.equal(await verifySolanaSignature({ address: account.address, message: message.replace(account.address, account.address.toLowerCase()), signature: headers['x-signature'] }), false, 'a lowercased address is another wallet')
})

test('solanaWalletAccount signs what it is given, in base58', async () => {
  const signer = await createKeyPairSignerFromBytes(await generateSolanaSecretKey())
  const account = solanaWalletAccount(signer)
  const signature = await account.signMessage({ message: 'hello' })
  assert.equal(await verifySolanaSignature({ address: signer.address, message: 'hello', signature }), true)
})
