# x402 gateway for AgentEco agents (Solana)

Pay-per-call access to AI agents with [x402](https://www.x402.org), settled in USDC on **Solana devnet**. A buyer agent asks for a result, the gateway answers HTTP 402 with the price, the buyer pays with a signed Solana transaction in the same request, the agent runs, and the payment settles only after the agent answered. For small jobs this is one HTTP round trip; for large jobs AgentEco's existing escrow program on Solana (`3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE`) is the safer path (see "Small jobs and big jobs").

Built for the Encode Solana Hackathon (challenges: Best Use of x402 on Solana, Best Consumer App on Solana).

## What existed before the hackathon and what is new

Existed (tag `pre-encode`, 150 commits since 24 Sep 2026): AgentEco, an escrow, dispute and reputation layer for AI agent work: Solidity and Anchor escrow programs (the Solana program is deployed on devnet), the SDK, backend, CLI, and the website with a Solana wallet flow and Solana read sessions.

New in `x402-gateway/` (commits after the tag):
- `src/gateway.ts`: the paid HTTP gateway on the official `@x402/express`, `@x402/core` and `@x402/svm` packages
- `src/ledger.ts`: a payment ledger that makes one payment proof pay for one job
- `src/agents.ts`: the agents behind the paywall (two small deterministic workers, plus a model-backed `translate` agent when `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` are set; an AgentEco seller plugs in here)
- `src/llm.ts`: a small client for any OpenAI-compatible endpoint (Nebius in the demo)
- `scripts/pay-demo.ts`: a buyer agent that pays automatically
- 14 tests against a fake facilitator

## How Solana and x402 are used

- Network `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet), scheme `exact`, asset devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), prices in dollars converted to base units (6 decimals).
- The 402 response carries the payment requirements in the `PAYMENT-REQUIRED` header. The buyer builds a partially signed transfer, sends it in `PAYMENT-SIGNATURE`, the facilitator verifies it and pays the network fee, and after the work the facilitator settles it. The receipt comes back in `PAYMENT-RESPONSE` with the transaction signature.
- The facilitator is configurable. The default is the public test facilitator, which lists Solana devnet `exact` support.

## Failure handling

Each case has a clear status and a test:

| Case | Result |
|---|---|
| Invalid brief | `400`, before any payment is asked for |
| Underpaid, expired or malformed payment | `402` from verification, the agent never runs |
| The same proof used again for the same request | `200` with the stored answer, header `x-payment-replay: true`, no second settlement |
| The same proof used for a different request | `409 payment_already_used` |
| The same proof used twice at the same time | one runs, the other gets `409 payment_in_flight` |
| The agent fails after a valid payment | `502 agent_failed`, `charged: false`, nothing is settled, the same proof can retry |
| The agent answers with the wrong shape (a field missing, empty or of the wrong type) | `502 invalid_result`, `charged: false`, nothing is settled, the same proof can retry. This checks the shape only, not whether the answer is good |
| The facilitator is slow or down | `503 facilitator_unavailable` with `Retry-After`, no work done |
| The work was done but settlement failed | recorded as `unsettled` in the ledger for the merchant to reconcile, the result is not handed over, reuse of the proof is `409 payment_unsettled` |
| The gateway restarts mid-job | the job is recovered as `unsettled`, not retryable |

## Small jobs and big jobs

Direct x402 payment suits small, fast, low-risk calls (a sentiment score for half a cent). For work worth more, where the buyer needs a refund path if the result is bad, AgentEco's escrow, dispute and arbiter are already live on Solana devnet; `GET /v1/pricing` is where a buyer agent learns the per-call prices, and a seller that wants escrow for a bigger job uses `@agenteco/sdk` (`createSellerAgent` and `hire` on `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`). Wiring one gateway endpoint to start an escrow job is not built yet.

## Setup

```bash
cd x402-gateway
npm install
cp .env.example .env     # PAY_TO_ADDRESS is a public address that receives the payments
npm test                 # 14 tests, no network, no keys
npm start                # http://localhost:8402
curl localhost:8402/v1/pricing
# a buyer agent, with a devnet wallet that holds devnet USDC:
SVM_PRIVATE_KEY=<base58 secret key> npm run pay-demo
```

Environment (names only): `PORT`, `PAY_TO_ADDRESS`, `X402_NETWORK`, `X402_FACILITATOR_URL`, `X402_FACILITATOR_TIMEOUT_MS`, `LEDGER_FILE`, and for the demo `SVM_PRIVATE_KEY`, `GATEWAY_URL`, `CAPABILITY`; and, for the model-backed agent, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`.

## Honest status

- Everything here is devnet. No real money, no real users.
- The gateway logic is tested against a fake facilitator that speaks the documented HTTP interface, and one full payment has been run on Solana devnet through the public facilitator (20 Oct 2026, `npm run pay-demo`, status 200, `success: true`): [transaction](https://explorer.solana.com/tx/3eCTKogSv6QPk1V99Mmxu6RUywc7wRns9iPKW5meMWKDvQPky1ukbGvkFMqqmKiQTgw1JEcLTSbzbdA6b3gQU3vz?cluster=devnet).
- The model-backed agent was run for real on 22 Oct 2026: `CAPABILITY=translate npm run pay-demo` paid $0.01 from one devnet wallet to the merchant wallet through the public facilitator (status 200, `success: true`) and returned a Nebius translation; the receipt transaction is `4kTbdLQztMpxYrQJVF5Dt93h1vYGvJmpBhKSMr8X2d4wSN2vKRgZWNHVYefxyxLq9x4q4nJu6JHy5mv1TqLHJnYZ` on devnet.
- The ledger is in memory by default (`LEDGER_FILE` keeps it between restarts).

License: MIT.
