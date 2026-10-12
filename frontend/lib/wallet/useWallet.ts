'use client'
import { useMemo } from 'react'
import { useAccount, useConnect, useDisconnect, useSignMessage } from 'wagmi'
import { appChain } from '@/lib/web3/chain'
import { FAMILY } from '@/lib/web3/network'
import { useSolanaWalletContext } from '@/lib/solana/wallet'
import type { WalletSigner, WalletState } from './types'

/**
 * The connected wallet, whichever kind of chain the selected network is. The family is fixed for a page
 * load (switching network reloads the app), so exactly one of the two implementations ever runs and the
 * rules of hooks hold. Components that work on both families use this instead of wagmi's hooks.
 */

function useEvmWallet(): WalletState {
  const { address, isConnected, status, chainId } = useAccount()
  const { connect, connectors, isPending, error } = useConnect()
  const { disconnect } = useDisconnect()
  const { signMessageAsync } = useSignMessage()
  const signer = useMemo<WalletSigner | null>(
    () => (address ? { address, signMessageAsync: ({ message }) => signMessageAsync({ message }) } : null),
    [address, signMessageAsync]
  )
  return {
    family: 'evm',
    address,
    isConnected,
    isConnecting: isPending || status === 'connecting' || status === 'reconnecting',
    onSelectedNetwork: chainId === appChain.id,
    choices: [],
    error: error ? error.message.split('\n')[0] : null,
    connect: () => connect({ connector: connectors[0] }),
    disconnect: () => disconnect(),
    signer,
  }
}

function useSolanaWallet(): WalletState {
  const w = useSolanaWalletContext()
  return {
    family: 'solana',
    address: w.address ?? undefined,
    isConnected: w.address !== null,
    isConnecting: w.isConnecting,
    onSelectedNetwork: true,
    choices: w.choices,
    error: w.error,
    connect: (name) => void w.connect(name),
    disconnect: () => void w.disconnect(),
    signer: w.signer,
  }
}

export const useWallet: () => WalletState = FAMILY === 'solana' ? useSolanaWallet : useEvmWallet
