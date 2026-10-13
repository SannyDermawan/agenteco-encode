/**
 * ERC-8004 ("Trustless Agents", https://eips.ethereum.org/EIPS/eip-8004, status Draft):
 * the parts AgentEco uses, the Identity Registry (an agent is an ERC-721 whose URI points at
 * its registration file) and the Reputation Registry (giveFeedback). The registries are
 * singletons per chain; their addresses are not in the EIP, so each chain configures them
 * (ERC8004_IDENTITY_REGISTRY / ERC8004_REPUTATION_REGISTRY, suffixed per chain like every
 * other chain setting). A chain without them simply has no ERC-8004 features.
 */

export const IDENTITY_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'setAgentURI',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newURI', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
] as const

export const REPUTATION_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'giveFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' },
      { name: 'feedbackHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getLastIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'readFeedback',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'isRevoked', type: 'bool' },
    ],
  },
  {
    type: 'event',
    name: 'NewFeedback',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'clientAddress', type: 'address', indexed: true },
      { name: 'feedbackIndex', type: 'uint64', indexed: false },
      { name: 'value', type: 'int128', indexed: false },
      { name: 'valueDecimals', type: 'uint8', indexed: false },
      { name: 'indexedTag1', type: 'string', indexed: true },
      { name: 'tag1', type: 'string', indexed: false },
      { name: 'tag2', type: 'string', indexed: false },
      { name: 'endpoint', type: 'string', indexed: false },
      { name: 'feedbackURI', type: 'string', indexed: false },
      { name: 'feedbackHash', type: 'bytes32', indexed: false },
    ],
  },
] as const

/** Where a chain's ERC-8004 registries are. */
export interface Erc8004Registries {
  identity: `0x${string}`
  reputation: `0x${string}`
}

export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1'

/** The registration file an agent's URI points at (EIP-8004 "Agent registration file"). */
export interface RegistrationFile {
  type: typeof REGISTRATION_TYPE
  name: string
  description: string
  image: string
  services: { name: string; endpoint: string; version?: string }[]
  x402Support: boolean
  active: boolean
  registrations: { agentId: number; agentRegistry: string }[]
  supportedTrust: string[]
}

/**
 * The registration file of an AgentEco listing. `agentUrl` is the listing on the AgentEco API
 * (how other agents hire it); `endpoint` is the agent's own endpoint, when it has one.
 */
export function buildRegistrationFile(agent: {
  name: string
  description: string
  capabilities: string[]
  agentUrl: string
  endpoint?: string | null
  active: boolean
  image?: string
  registration?: { agentId: string; evmChainId: number; identityRegistry: string } | null
}): RegistrationFile {
  return {
    type: REGISTRATION_TYPE,
    name: agent.name,
    description: agent.description,
    image: agent.image ?? '',
    services: [
      { name: 'AgentEco', endpoint: agent.agentUrl, version: '1' },
      ...(agent.endpoint ? [{ name: 'web', endpoint: agent.endpoint }] : []),
    ],
    x402Support: false,
    active: agent.active,
    registrations: agent.registration
      ? [{ agentId: Number(agent.registration.agentId), agentRegistry: `eip155:${agent.registration.evmChainId}:${agent.registration.identityRegistry}` }]
      : [],
    // Buyers' ratings after escrowed deals, published as feedback.
    supportedTrust: ['reputation'],
  }
}

/**
 * The feedback a buyer gives after an AgentEco deal: the rating on the 1–100 scale (stars × 20,
 * the number rateSeller stores), no decimals; tag1 = the capability; tag2 ties it to the escrow.
 */
export function dealFeedback(params: { score: number; capability: string; chainId: string; escrowId: bigint | string }) {
  const value = Math.round(params.score)
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error(`Feedback score must be 1–100, got ${params.score}`)
  return {
    value: BigInt(value),
    valueDecimals: 0,
    tag1: params.capability,
    tag2: `agenteco:${params.chainId}:${params.escrowId}`,
  }
}

/**
 * A chain's registries from its settings: both addresses, or neither (no ERC-8004 there).
 * `get` reads one setting (env, suffixed per chain); `label` names the suffix in errors.
 */
export function erc8004FromSettings(get: (name: string) => string | undefined, label = ''): Erc8004Registries | null {
  const identity = get('ERC8004_IDENTITY_REGISTRY')
  const reputation = get('ERC8004_REPUTATION_REGISTRY')
  if (!identity && !reputation) return null
  const valid = (v: string | undefined) => !!v && /^0x[0-9a-fA-F]{40}$/.test(v)
  if (!valid(identity) || !valid(reputation)) {
    throw new Error(`ERC8004_IDENTITY_REGISTRY${label} and ERC8004_REPUTATION_REGISTRY${label} must both be set to contract addresses, or both left empty.`)
  }
  return { identity: identity as `0x${string}`, reputation: reputation as `0x${string}` }
}
