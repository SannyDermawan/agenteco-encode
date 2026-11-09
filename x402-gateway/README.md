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
- `src/escrow.ts` and `GET /v1/escrow/plan`: tells a buyer which way to pay for a job of a given size (x402 or AgentEco escrow) and the steps for it. It holds no key and starts no escrow
- CORS and proxy handling, so a browser can pay per call from the visitor's wallet (the website's Hire an Agent page does)
- `scripts/pay-demo.ts`: a buyer agent that pays automatically
- 28 tests against a fake facilitator

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

Direct x402 payment suits small, fast, low-risk calls (a sentiment score for half a cent). For work worth more, where the buyer needs a refund path if the result is bad, AgentEco's escrow, dispute and arbiter are live on Solana devnet.

`GET /v1/escrow/plan?capability=<id>&budgetUsd=<dollars>` is the bridge. It is free, needs no key and runs no paid agent:

- A job worth **less than the threshold** (`ESCROW_THRESHOLD_USD`, default `0.15`) that the gateway sells, and at least the per-call price, gets `recommendedMode: "x402"` with the endpoint and the price.
- Anything else gets `recommendedMode: "escrow"`, with the escrow program and token, the online Solana sellers of that capability (read from the AgentEco API, online first), and the `agenteco hire ...` command and the `hire({ ... })` call for it.
- If the AgentEco API does not answer, the plan is still `200`, with no sellers and a note. A missing or invalid budget or capability is `400`.

The gateway does **not** start an escrow, fund one or hold a key. The buyer signs its own escrow transaction (through the SDK, the CLI, or the website). `GET /v1/pricing` also says where the escrow path is. Eleven tests cover the plan and the CORS headers.

The website's Hire an Agent page (`/app/hire`) applies this rule for people: a small job is paid per call from the visitor's wallet, a bigger one leads to the escrow form. Two more tests pay through the official x402 client with a wallet-style signer (the kind of signer a browser wallet is), so the signing path the website uses is covered.

## Setup

```bash
cd x402-gateway
npm install
cp .env.example .env     # PAY_TO_ADDRESS is a public address that receives the payments
npm test                 # 28 tests, no network, no keys
npm start                # http://localhost:8402
curl localhost:8402/v1/pricing
# a buyer agent, with a devnet wallet that holds devnet USDC:
SVM_PRIVATE_KEY=<base58 secret key> npm run pay-demo
```

Environment (names only): `PORT`, `PAY_TO_ADDRESS`, `X402_NETWORK`, `X402_FACILITATOR_URL`, `X402_FACILITATOR_TIMEOUT_MS`, `LEDGER_FILE`, `AGENTECO_API_URL`, `ESCROW_THRESHOLD_USD`, `CORS_ORIGIN`, and for the demo `SVM_PRIVATE_KEY`, `GATEWAY_URL`, `CAPABILITY`; and, for the model-backed agent, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`.

## Honest status

- Everything here is devnet. No real money, no real users.
- The gateway logic is tested against a fake facilitator that speaks the documented HTTP interface, and one full payment has been run on Solana devnet through the public facilitator (20 Oct 2026, `npm run pay-demo`, status 200, `success: true`): [transaction](https://explorer.solana.com/tx/3eCTKogSv6QPk1V99Mmxu6RUywc7wRns9iPKW5meMWKDvQPky1ukbGvkFMqqmKiQTgw1JEcLTSbzbdA6b3gQU3vz?cluster=devnet).
- The model-backed agent was run for real on 22 Oct 2026: `CAPABILITY=translate npm run pay-demo` paid $0.01 from one devnet wallet to the merchant wallet through the public facilitator (status 200, `success: true`) and returned a Nebius translation; the receipt transaction is `4kTbdLQztMpxYrQJVF5Dt93h1vYGvJmpBhKSMr8X2d4wSN2vKRgZWNHVYefxyxLq9x4q4nJu6JHy5mv1TqLHJnYZ` on devnet.
- A public instance runs at `https://agenteco-encode-production.up.railway.app` (Railway). On 8 Nov 2026 its `/v1/pricing` and `/health` answered and an unpaid call got `402`; a payment through that public URL has not been run yet. The `/v1/escrow/plan` endpoint and the CORS headers are in this repository and covered by tests; they are live once that instance is redeployed from this commit.
- Paying per call from a browser wallet (the website's Hire an Agent page) is built and its signing path is covered by tests with a wallet-style signer. It has not been run with a real Phantom wallet yet.
- The escrow itself has run end to end with a real Phantom wallet on Solana devnet (see the repository README): the plan endpoint only points a buyer to it.
- The ledger is in memory by default (`LEDGER_FILE` keeps it between restarts).

License: MIT.
