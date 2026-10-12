import { createPrivateKey, sign } from 'node:crypto'
import type { Page } from 'playwright-core'

/** Ed25519 signing for the mock wallet, from a 64-byte Solana secret key (seed, then public key). */
function ed25519Signer(secretKey: Uint8Array) {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' })
  return (data: Uint8Array) => new Uint8Array(sign(null, Buffer.from(data), key))
}

/**
 * What the page gets: a wallet-standard wallet that registers itself like an extension would. The keys never
 * enter the page — it calls back into this process (exposed functions) to sign.
 */
const MOCK_WALLET = `(() => {
  const ADDRESS = __ADDRESS__
  const PUBLIC_KEY = new Uint8Array(__PUBLIC_KEY__)
  const b64 = (bytes) => btoa(String.fromCharCode(...bytes))
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  const listeners = new Set()
  const account = { address: ADDRESS, publicKey: PUBLIC_KEY, chains: ['solana:devnet'], features: ['solana:signMessage', 'solana:signTransaction'] }
  const wallet = {
    version: '1.0.0',
    name: 'Mock Wallet',
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PGNpcmNsZSBjeD0iOCIgY3k9IjgiIHI9IjgiIGZpbGw9IiM1QjVGRUYiLz48L3N2Zz4=',
    chains: ['solana:devnet'],
    accounts: [],
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => {
          wallet.accounts = [account]
          window.__walletLog.push('connect')
          return { accounts: wallet.accounts }
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {
          wallet.accounts = []
          window.__walletLog.push('disconnect')
        },
      },
      'standard:events': {
        version: '1.0.0',
        on: (event, listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async (...inputs) =>
          Promise.all(
            inputs.map(async (input) => {
              window.__walletLog.push('signMessage')
              return { signedMessage: input.message, signature: unb64(await window.__mockSignMessage(b64(input.message))) }
            })
          ),
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs) =>
          Promise.all(
            inputs.map(async (input) => {
              window.__walletLog.push('signTransaction')
              return { signedTransaction: unb64(await window.__mockSignTransaction(b64(input.transaction))) }
            })
          ),
      },
    },
  }
  window.__walletLog = []
  const register = (api) => api.register(wallet)
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }))
  window.addEventListener('wallet-standard:app-ready', (event) => register(event.detail))
})()`

type Kit = typeof import('../../agent-runtime/src/chain/kit.ts')

/**
 * Puts a wallet-standard wallet for `address` into every page of the context's next navigations. The secret key
 * stays in this process; the page's `window.__walletLog` lists what the wallet was asked to do.
 */
export async function installMockWallet(page: Page, wallet: { address: string; secretKey: Uint8Array; kit: Kit }): Promise<void> {
  const signWith = ed25519Signer(wallet.secretKey)
  const { getTransactionDecoder, getTransactionEncoder } = wallet.kit
  await page.exposeFunction('__mockSignMessage', (messageB64: string) => Buffer.from(signWith(Buffer.from(messageB64, 'base64'))).toString('base64'))
  await page.exposeFunction('__mockSignTransaction', (txB64: string) => {
    const tx = getTransactionDecoder().decode(Buffer.from(txB64, 'base64'))
    const signed = { ...tx, signatures: { ...tx.signatures, [wallet.address]: signWith(tx.messageBytes as unknown as Uint8Array) } }
    return Buffer.from(getTransactionEncoder().encode(signed as never)).toString('base64')
  })
  await page.addInitScript(MOCK_WALLET.replace('__ADDRESS__', JSON.stringify(wallet.address)).replace('__PUBLIC_KEY__', JSON.stringify([...wallet.secretKey.slice(32)])))
}
