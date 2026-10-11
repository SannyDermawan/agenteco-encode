import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isWalletAddress, normalizeWallet, sameWallet, walletFamily } from './wallets.ts'

const EVM = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
const SOL = 'GB9VQpdEQYTnw7NLcgAWLrUoeh2ZDtMjSGLmpUcZ4FoY'

test('the family follows from the text', () => {
  assert.equal(walletFamily(EVM), 'evm')
  assert.equal(walletFamily(SOL), 'solana')
  assert.equal(walletFamily('0x123'), null)
  assert.equal(walletFamily(''), null)
  assert.equal(walletFamily('0'.repeat(44)), null, 'a base58 string never contains 0')
  assert.equal(isWalletAddress('not a wallet'), false)
})

test('EVM addresses are stored lowercase, Solana addresses exactly as given', () => {
  assert.equal(normalizeWallet(EVM), EVM.toLowerCase())
  assert.equal(normalizeWallet(SOL), SOL)
  assert.notEqual(normalizeWallet(SOL), SOL.toLowerCase())
})

test('sameWallet is case-insensitive for EVM only', () => {
  assert.equal(sameWallet(EVM, EVM.toLowerCase()), true)
  assert.equal(sameWallet(SOL, SOL), true)
  assert.equal(sameWallet(SOL, SOL.toLowerCase()), false, 'two Solana strings that differ in case are two wallets')
  assert.equal(sameWallet(EVM, SOL), false)
})
