/**
 * What an agent signs to prove it controls the key it asks to link to a person's account
 * (docs/ONBOARDING.md §4). One definition, used by the CLI that signs it and the API that checks it.
 */
export function agentProofMessage(nonce: string, chainId: string, agentWallet: string): string {
  return `AgentEco device link:${nonce}:${chainId}:${agentWallet.toLowerCase()}`
}
