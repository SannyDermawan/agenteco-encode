import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentView, isAgentOwner, isPartyOf, visibleAgentsFilter } from './access.ts'

const OWNER = '0x1111111111111111111111111111111111111111'
const AGENT_WALLET = '0x2222222222222222222222222222222222222222'
const STRANGER = '0x3333333333333333333333333333333333333333'

const seller = {
  id: 's1',
  name: 'Translator Pro',
  role: 'seller',
  price: '0.30',
  ownerWallet: OWNER.toUpperCase().replace('0X', '0x'),
  walletAddress: AGENT_WALLET,
  taskStatus: 'active',
  minimumPrice: '0.24',
  maxBudget: null,
  customInstructions: 'Formal register.',
  taskBrief: null,
  acceptanceCriteria: null,
  depositorWallet: OWNER,
  minSuccessRate: null,
  minCompletedJobs: null,
  minReputation: null,
}

test('a stranger sees the public profile only, never the negotiation floor or instructions', () => {
  const view = agentView(seller, STRANGER)
  assert.equal(view.price, '0.30')
  assert.equal(view.walletAddress, AGENT_WALLET)
  for (const field of ['minimumPrice', 'maxBudget', 'customInstructions', 'taskBrief', 'acceptanceCriteria', 'depositorWallet']) {
    assert.equal(field in view, false, `${field} leaked`)
  }
})

test('an anonymous viewer gets the public profile too', () => {
  assert.equal('minimumPrice' in agentView(seller, null), false)
})

test('the owner (any address casing) and the hosted agent itself see everything', () => {
  assert.equal(agentView(seller, OWNER).minimumPrice, '0.24')
  assert.equal(agentView(seller, AGENT_WALLET).minimumPrice, '0.24')
})

test("a self-custody agent's claimed wallet does not make that wallet an owner", () => {
  const selfCustody = { ...seller, taskStatus: null, walletAddress: STRANGER }
  assert.equal(isAgentOwner(STRANGER, selfCustody), false)
  assert.equal('minimumPrice' in agentView(selfCustody, STRANGER), false)
})

test('isPartyOf: the owner or the agent wallet, nobody else', () => {
  assert.equal(isPartyOf(OWNER, seller), true)
  assert.equal(isPartyOf(AGENT_WALLET, seller), true)
  assert.equal(isPartyOf(STRANGER, seller), false)
})

test('buyer agents are listed only to their owner', () => {
  assert.deepEqual(visibleAgentsFilter(null), { role: 'seller' })
  // Its owner: the wallet it was registered under, and the person it is linked to (device link).
  assert.deepEqual(visibleAgentsFilter(OWNER), {
    OR: [
      { role: 'seller' },
      { ownerWallet: { equals: OWNER, mode: 'insensitive' } },
      { accountWallet: { equals: OWNER, mode: 'insensitive' } },
    ],
  })
})

test('a person linked to an agent is its owner too, and the link itself stays private', () => {
  const linked = { ...seller, taskStatus: null, walletAddress: STRANGER, ownerWallet: STRANGER, accountWallet: OWNER }
  assert.equal(isAgentOwner(OWNER, linked), true)
  assert.equal(isPartyOf(OWNER, linked), true)
  assert.equal(isAgentOwner(AGENT_WALLET, linked), false)
  assert.equal('accountWallet' in agentView(linked, AGENT_WALLET), false)
  assert.equal(agentView(linked, OWNER).accountWallet, OWNER)
})
