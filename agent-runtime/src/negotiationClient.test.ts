import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isStaleNegotiationError } from './negotiationClient.ts'

// The messages are the ones backend/src/routes/negotiations.ts answers, as the client wraps them.
const failed = (body: string, status = 400) => new Error(`Responding to negotiation failed (${status}): ${JSON.stringify({ error: body })}`)

test('a reply that lost the race to the other side is told apart from a real failure', () => {
  assert.equal(isStaleNegotiationError(failed('Negotiation is already accepted')), true)
  assert.equal(isStaleNegotiationError(failed('Negotiation is already rejected')), true)
  assert.equal(isStaleNegotiationError(failed('Negotiation is already expired')), true)
  assert.equal(isStaleNegotiationError(failed("It is not buyer's turn to respond")), true)
  assert.equal(isStaleNegotiationError(failed("It is not seller's turn to respond")), true)
  assert.equal(isStaleNegotiationError(failed('Negotiation expired: no answer within 300s of the last offer')), true)

  assert.equal(isStaleNegotiationError(failed('Only the buyer agent owner (or the agent itself) can respond as buyer', 403)), false)
  assert.equal(isStaleNegotiationError(failed('price is required for a counter offer')), false)
  assert.equal(isStaleNegotiationError(failed('Negotiation not found', 404)), false)
  assert.equal(isStaleNegotiationError(new Error('fetch failed')), false)
  assert.equal(isStaleNegotiationError('Negotiation is already accepted'), false, 'only errors count')
})
