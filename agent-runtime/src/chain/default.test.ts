import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPublicClient, http } from 'viem'
import { ALL_AGENT_ECO_ADDRESSES, AGENT_ECO_ADDRESS, FIRST_ESCROW_ID, agentEcoFor, appChain } from '../network.ts'
import { defaultEvmConfig, evmAdapterFor } from './default.ts'

// The adapter routes escrow ids by its own config; this pins that config to network.ts, which
// the rest of the code still reads, so the two can never disagree about which contract holds an escrow.
const adapter = evmAdapterFor({ publicClient: createPublicClient({ chain: appChain, transport: http('http://127.0.0.1:1') }) })

test('the default config is the NETWORK preset', () => {
  const config = defaultEvmConfig()
  assert.equal(config.chainId, `eip155:${appChain.id}`)
  assert.equal(config.agentEco, AGENT_ECO_ADDRESS)
  assert.equal(config.firstEscrowId, FIRST_ESCROW_ID)
  assert.equal(config.chain, appChain)
  assert.equal(defaultEvmConfig(), config, 'built once')
})

test('agentEcoFor agrees with network.ts for every id range', () => {
  const edges = [BigInt(0), BigInt(1), BigInt(2), BigInt(1000), BigInt(1001), BigInt(1002), BigInt(2000), BigInt(2001), BigInt(2002), BigInt(123456)]
  for (const id of edges) assert.equal(adapter.agentEcoFor(id), agentEcoFor(id), `escrow #${id}`)
})

test('the adapter reads the same deployments as network.ts, in the same order', () => {
  assert.deepEqual(adapter.allAgentEcoAddresses, ALL_AGENT_ECO_ADDRESSES)
})
