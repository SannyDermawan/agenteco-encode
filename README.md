# AgentEco x402 on Solana

**Pay-per-call access to AI agents with [x402](https://www.x402.org), settled in USDC on Solana devnet.** A buyer agent asks for a result, the gateway answers HTTP 402 with the price, the buyer pays with a signed Solana transaction in the same request, the agent runs, and the payment settles only after the agent answered. Built for the **Encode Solana Hackathon 2026** (challenges: Best Use of x402 on Solana, Best Consumer App on Solana).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

- The gateway: [x402-gateway/](x402-gateway/README.md)
- What changed for this hackathon: [`pre-encode...main`](https://github.com/SannyDermawan/agenteco-encode/compare/pre-encode...main)
- Research notes on x402 for Solana: [docs/X402-NOTES.md](docs/X402-NOTES.md)
- Submission draft: [docs/ENCODE-SUBMISSION.md](docs/ENCODE-SUBMISSION.md)
- Original open source project (MIT): [SannyDermawan/agenteco-multichain](https://github.com/SannyDermawan/agenteco-multichain), described in [AGENTECO.md](AGENTECO.md)

## Why

AI agents are starting to buy work from each other and they need a way to pay that involves no accounts and no invoices. [AgentEco](AGENTECO.md) already gives agents escrow, disputes and reputation, including an Anchor escrow program on Solana devnet (`3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE`). x402 covers the other end: a small, fast, one-request payment. This project adds the x402 gateway and spends its effort where payment code usually breaks, failure handling.

## How Solana and x402 are used

- Network `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet), scheme `exact`, devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`). A price of `$0.005` becomes `5000` base units, checked by a test.
- The 402 response carries the requirements in the `PAYMENT-REQUIRED` header. The buyer sends a partially signed transfer in `PAYMENT-SIGNATURE`; the facilitator verifies it and pays the network fee; after the work it settles; the receipt returns in `PAYMENT-RESPONSE`.
- Built on the official `@x402/express`, `@x402/core`, `@x402/svm` and `@x402/fetch` packages. The public test facilitator (`https://x402.org/facilitator`) lists Solana devnet support, so no facilitator of our own is needed.

## Failure handling

| Case | Result |
|---|---|
| Invalid brief | `400`, before any payment is asked for |
| Underpaid, expired or malformed payment | `402` from verification, the agent never runs |
| The same proof reused for the same request | `200` with the stored answer, no second settlement |
| The same proof reused for a different request | `409 payment_already_used` |
| The same proof used twice at the same time | one runs, the other gets `409 payment_in_flight` |
| The agent fails after a valid payment | `502`, `charged: false`, nothing settled, the same proof can retry |
| The facilitator is slow or down | `503` with `Retry-After`, no work done |
| The work was done but settlement failed | recorded as `unsettled` in the ledger for reconciliation, the result is not handed over |
| The gateway restarts mid-job | the job is recovered as `unsettled`, not retryable |

Each row has an automated test (the gateway has 27 tests, against a fake facilitator that speaks the documented HTTP interface).

## Architecture

```
buyer agent --POST--> gateway --402 + price--> buyer signs a USDC transfer
buyer agent --POST + PAYMENT-SIGNATURE--> gateway --verify--> facilitator
                                          gateway --run--> agent --> result
                                          gateway --settle--> facilitator --> Solana devnet
buyer agent <-- result + PAYMENT-RESPONSE (settlement signature)
```

Small, fast, low-risk calls are paid directly with x402. For larger work where the buyer needs a refund path, AgentEco's escrow, dispute and arbiter on Solana are live. The size of the job picks the route: under $0.05 is paid per call, $0.05 and up goes through escrow.

- **For agents:** `GET /v1/escrow/plan?capability=<id>&budgetUsd=<n>` on the gateway answers which route to take and the steps for it. It holds no key and starts no escrow: the buyer signs its own transaction.
- **For people:** the website's **Hire an Agent** page (`/app/hire`) asks for the job and what it is worth, shows both ways to pay side by side with the chosen one lit and the reason, then either pays per call from the visitor's wallet or leads to the escrow form.

## Try it

```bash
cd x402-gateway
npm install
npm test                  # 27 tests, no network or keys
cp .env.example .env      # PAY_TO_ADDRESS is a public address that receives the payments
npm start                 # http://localhost:8402
curl localhost:8402/v1/pricing
SVM_PRIVATE_KEY=<base58 devnet key> npm run pay-demo     # a buyer agent that pays by itself
```

## What existed before and what is new

**Before (tag `pre-encode`, 150 commits since 24 Sep 2026):** AgentEco: Solidity and Anchor escrow programs, the SDK, backend, CLI, and a website that already has a Solana wallet flow and Solana read sessions. See [AGENTECO.md](AGENTECO.md) and the [project history](#project-history).

**New (commits after the tag):**

- `x402-gateway/`: the x402 gateway, its payment ledger, the agents behind the paywall, the paying buyer agent, the escrow plan endpoint, CORS for browsers, and 27 tests.
- `frontend/`: the **Hire an Agent** page (small job paid per call from the wallet, bigger job to escrow, with the reason shown), the "How a job is paid" block and honest landing text for the Solana build, and a fix for sign-in with Phantom (see below).
- `seller-agent/`: a `sentiment_score` seller for Solana devnet that shares the gateway's scorer, so one agent can be paid per call or through escrow.
- `docs/`: the research notes and the submission draft.

## Honest status

- Devnet only. No real money, no real users.
- The gateway logic is tested against a fake facilitator, and one full payment has been run on Solana devnet through the public facilitator (20 Oct 2026, `npm run pay-demo`, status 200, `success: true`): [transaction](https://explorer.solana.com/tx/3eCTKogSv6QPk1V99Mmxu6RUywc7wRns9iPKW5meMWKDvQPky1ukbGvkFMqqmKiQTgw1JEcLTSbzbdA6b3gQU3vz?cluster=devnet).
- The ledger is in memory by default; `LEDGER_FILE` keeps it across restarts.
- **A real deal with a real wallet, through the website, on Solana devnet (8 Nov 2026):** escrow #10, hired from a Phantom wallet, 0.06 USDC locked, the seller started and delivered, and the escrow settled. The seller received 0.0585 USDC and the treasury 0.0015 (2.5% fee), and the seller's reputation shows 1 job, 100% success. Transactions: [create and fund](https://explorer.solana.com/tx/3yGD6X4fM8NrMuThehiDzZ6ay4upTAga82sEXzVBLYDGmTF8MfxrtkipzJTonwQ39kr9XgiBmDVb1PWHCkvkDUZH?cluster=devnet), [start](https://explorer.solana.com/tx/4shXcsxtGtk1P62pbAGv45cTgFNm9sN6adt3sowheSMthSRT5fpuo69xMP5nJkfZSAdYMxdbv3NLYrK1g1FTzbeS?cluster=devnet), [deliver](https://explorer.solana.com/tx/57man2A3HoT1R3MM9aEvVJSR3MnzZRTMe9LFoaZqprTvqfDAyWCVnWdcD5yUuyFkZgrB8HQU1Z4eQitDh7vWFgXT?cluster=devnet), [settle](https://explorer.solana.com/tx/2RyRGBpgTd8eKoSNzB5XLh89Ku65NR1njcQ7Sm4dEDfp3Sy4y76ykKM8VFM7JFsyvocxKU3mtppr2fhVoStEKuc3?cluster=devnet). It was the first deal through the website with a real wallet extension, and it found a bug that is now fixed.
- **The sign-in bug:** the website's Solana read session existed before, but Phantom refused to show its message ("signature request cannot be shown due to invalid formatting") because the Chain ID was written as a full CAIP-2 id. Phantom accepts `devnet`. The API now reads either spelling and the website retries with the cluster name when a wallet refuses the first one, with tests for both.
- Paying per call from a browser wallet (Hire an Agent) is built, and its signing path is covered by tests with a wallet-style signer. It has not been run with a real Phantom wallet yet.
- The public gateway runs on Railway at `https://agenteco-encode-production.up.railway.app`. The version running there on 8 Nov 2026 answers `/v1/pricing`, `/health` and `402`; the plan endpoint and the CORS headers are in this repository and go live when that instance is redeployed from this commit.

## Project history

AgentEco grew in three stages across three repositories, all sharing one history that starts with the first commit on 24 Sep 2026. This repository keeps that history intact.

| Period | What happened |
|---|---|
| 24 Sep | First MVP: escrow, seller and buyer agents, a first BOT Chain deployment ([agenteco](https://github.com/SannyDermawan/agenteco), 16 commits) |
| 25 to 29 Sep | Foundry contract project, hashed task and result commitments, state-based escrow discovery, RPC failover, separate host loops for buyers, sellers and the arbiter, API hardening |
| 1 to 7 Oct | Night-market landing page, AI-required platform capabilities, faucet strip and the dispute walkthrough ([agenteco-bnb](https://github.com/SannyDermawan/agenteco-bnb), 78 commits) |
| 10 to 13 Oct | One-prompt onboarding with the staged `hire()` SDK, CLI and MCP server; the Solana program and adapter, with an end-to-end suite and a browser test on Solana; deployments with proof runs on Base, Ethereum, Arbitrum and Tempo testnets and BOT Chain ([agenteco-multichain](https://github.com/SannyDermawan/agenteco-multichain), 150 commits) |
| 17 Oct | Tag `pre-encode`: the baseline for this hackathon |
| 20 Oct onward | The work in this repository |

## License

MIT, see [LICENSE](LICENSE).
