'use client'
import './polyfills'
import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { SolanaAdapter } from '@runtime/chain/solana.ts'
import { useSolanaWalletContext } from './wallet'
import { solanaWriter } from './chain'

/**
 * Writes to the escrow program, signed by the visitor's wallet. The shape mirrors wagmi's write hooks
 * (`isPending`, `isSuccess`, `error`, `hash`) so the order page reads the same on either family.
 * Every successful write refreshes the polled escrow reads.
 */
export interface SolanaAction<Args extends unknown[]> {
  run: (...args: Args) => Promise<unknown>
  isPending: boolean
  /** A wallet signs and the cluster confirms in one call here; kept so callers need not special-case. */
  isConfirming: false
  isSuccess: boolean
  error: Error | null
  /** The signature of the transaction, when the write made one. */
  hash: string | undefined
  reset: () => void
}

function describe(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  // The wallet's own refusal, in words a person reads.
  if (/reject|denied|declin|cancel/i.test(raw) && !/transaction (rejected|failed)/i.test(raw)) return new Error('The wallet request was cancelled.')
  return new Error(raw.split('\n')[0])
}

export function useSolanaAction<Args extends unknown[]>(write: (adapter: SolanaAdapter, ...args: Args) => Promise<unknown>): SolanaAction<Args> {
  const { txSigner } = useSolanaWalletContext()
  const queryClient = useQueryClient()
  const [state, setState] = useState<{ isPending: boolean; isSuccess: boolean; error: Error | null; hash: string | undefined }>({
    isPending: false,
    isSuccess: false,
    error: null,
    hash: undefined,
  })

  const run = useCallback(
    async (...args: Args) => {
      if (!txSigner) {
        const error = new Error('Connect a Solana wallet first.')
        setState({ isPending: false, isSuccess: false, error, hash: undefined })
        return undefined
      }
      setState({ isPending: true, isSuccess: false, error: null, hash: undefined })
      try {
        const result = await write(solanaWriter(txSigner), ...args)
        setState({ isPending: false, isSuccess: true, error: null, hash: typeof result === 'string' ? result : undefined })
        void queryClient.invalidateQueries()
        return result
      } catch (e) {
        setState({ isPending: false, isSuccess: false, error: describe(e), hash: undefined })
        return undefined
      }
    },
    // `write` is a module-level function at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [txSigner, queryClient]
  )

  const reset = useCallback(() => setState({ isPending: false, isSuccess: false, error: null, hash: undefined }), [])
  return { run, isConfirming: false, reset, ...state }
}
