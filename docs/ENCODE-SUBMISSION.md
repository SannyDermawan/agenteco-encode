# Encode Solana Hackathon: submission draft

Challenge: Best Use of x402 on Solana (the only track on the Encode dashboard; Best Consumer App was removed on 21 Oct 2026 because the gateway is developer infrastructure). Repository: https://github.com/SannyDermawan/agenteco-encode. Fill the live demo and video links. The real devnet settlement receipt exists (see the honest notes below and x402-gateway/README.md). Checkpoint 2 is due 2 Nov 2026 18:59 WIB (only Submission Details is required), final 8 Nov 2026 23:59 UTC-12.

**Project:** AgentEco, with a new x402 gateway for pay-per-call agents on Solana

## Description

AI agents are starting to buy work from each other, and they need a way to pay that does not involve accounts or invoices. AgentEco already gives agents escrow, disputes and reputation on Solana devnet. During the hackathon we added an x402 gateway: an agent calls an HTTP endpoint, gets a 402 with the price in devnet USDC, pays with a signed Solana transaction in the same request, and receives the result. The payment settles only after the agent has answered, so a failed job costs nothing.

We spent the time on the part that usually breaks: failure handling. A payment proof pays for exactly one job (a replay returns the stored answer, a different request is refused, two at once cannot both run), an agent failure after a valid payment is not charged, a slow or down facilitator gives a clear 503 and no work is done, and a settlement that fails after the work is recorded for reconciliation. Twelve automated tests cover each case.

## What existed before and what is new

Before (tag `pre-encode`): AgentEco: escrow and dispute programs on Solana and EVM, the SDK, backend, CLI, and a website with a Solana wallet flow and Solana read sessions.
New during the hackathon: the x402 gateway (`x402-gateway/`), its payment ledger, the paying buyer agent, the tests and the research notes (`docs/X402-NOTES.md`).

## How Solana powers it

Devnet USDC transfers settled through the x402 `exact` scheme on `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`; the escrow program for larger jobs is already deployed on the same network.

## Honest notes

Devnet only, no real money, no real users. The gateway logic is tested against a fake facilitator, and one full payment has been run on Solana devnet through the public facilitator (20 Oct 2026, `npm run pay-demo`, status 200, `success: true`): [transaction](https://explorer.solana.com/tx/3eCTKogSv6QPk1V99Mmxu6RUywc7wRns9iPKW5meMWKDvQPky1ukbGvkFMqqmKiQTgw1JEcLTSbzbdA6b3gQU3vz?cluster=devnet). Escalating a gateway call to an AgentEco escrow job is designed, not built.
