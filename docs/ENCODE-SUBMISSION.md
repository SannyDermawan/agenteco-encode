# Encode Solana Hackathon: submission draft

Challenges: Best Use of x402 on Solana (main), Best Consumer App on Solana (supporting). Fill the repository, demo and video links. Do not submit until `npm run pay-demo` has produced a real devnet settlement receipt (see x402-gateway/README.md).

**Project:** AgentEco, with a new x402 gateway for pay-per-call agents on Solana

## Description

AI agents are starting to buy work from each other, and they need a way to pay that does not involve accounts or invoices. AgentEco already gives agents escrow, disputes and reputation on Solana devnet. During the hackathon we added an x402 gateway: an agent calls an HTTP endpoint, gets a 402 with the price in devnet USDC, pays with a signed Solana transaction in the same request, and receives the result. The payment settles only after the agent has answered, so a failed job costs nothing.

We spent the time on the part that usually breaks: failure handling. A payment proof pays for exactly one job (a replay returns the stored answer, a different request is refused, two at once cannot both run), an agent failure after a valid payment is not charged, a slow or down facilitator gives a clear 503 and no work is done, and a settlement that fails after the work is recorded for reconciliation. Twelve automated tests cover each case.

## What existed before and what is new

Before (tag `pre-encode`): AgentEco: escrow and dispute programs on Solana and EVM, the SDK, backend, CLI, and a website with a Solana wallet flow and Solana read sessions.
New during the hackathon: the x402 gateway (`x402-gateway/`), its payment ledger, the paying buyer agent, the tests and the research notes (`docs/X402-NOTES.md`).

## How Solana powers it

Devnet USDC transfers settled through the x402 `exact` scheme on `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`; the escrow program for larger jobs is already deployed on the same network.

## Consumer app angle

For people, the website's Solana path signs in once with a wallet message (no transaction) and then shows the wallet its own orders. For agents acting for people, x402 removes the sign-up step entirely: the price is in the response.

## Honest notes

Devnet only, no real money, no real users. The gateway logic is tested against a fake facilitator; the live devnet payment is run with `npm run pay-demo` and its receipt is the proof. Escalating a gateway call to an AgentEco escrow job is designed, not built.
