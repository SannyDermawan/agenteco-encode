# Encode Solana Hackathon: submission draft

Challenges: Best Use of x402 on Solana, and Best Consumer App on Solana. Repository: https://github.com/SannyDermawan/agenteco-encode. Live demo: https://agenteco.my.id (the website) and https://agenteco-encode-production.up.railway.app (the x402 gateway). The Encode form itself is filled in by the author; this file is the text and the facts behind it.

**Project:** AgentEco, with an x402 gateway for pay-per-call agents on Solana and a website that picks the way to pay by the size of the job

## Description

AI agents are starting to buy work from each other, and they need a way to pay that does not involve accounts or invoices. AgentEco gives agents escrow, disputes and reputation on Solana devnet. During the hackathon we added an x402 gateway and a website that brings the two together: a small job is paid per call with x402, a bigger one is locked in escrow until the buyer accepts.

**x402 gateway.** An agent calls an HTTP endpoint, gets a 402 with the price in devnet USDC, pays with a signed Solana transaction in the same request, and receives the result. The payment settles only after the agent has answered, so a failed job costs nothing. We spent the time on the part that usually breaks: failure handling. A payment proof pays for exactly one job (a replay returns the stored answer, a different request is refused, two at once cannot both run), an agent failure after a valid payment is not charged, a slow or down facilitator gives a clear 503 and no work is done, and a settlement that fails after the work is recorded for reconciliation. The gateway has 27 automated tests.

**The route by the size of the job.** `GET /v1/escrow/plan?capability=<id>&budgetUsd=<n>` tells an agent which way to pay (under $0.05 per call, $0.05 and up through escrow) and the steps for it. It holds no key and starts no escrow: the buyer signs its own transaction. The website's **Hire an Agent** page applies the same rule for people and shows both ways to pay side by side, with the chosen one lit and the reason for it.

**For people.** A person with a Phantom wallet hires an agent on the website, the price is locked in the escrow program, the seller delivers, and the person accepts or disputes. A real deal went through this on Solana devnet on 8 Nov 2026 (escrow #10, 0.06 USDC, the seller received 0.0585 and the treasury 0.0015). It was the first deal through the website with a real wallet extension, and it found a sign-in bug with Phantom that is now fixed.

## What existed before and what is new

Before (tag `pre-encode`): AgentEco: escrow and dispute programs on Solana and EVM, the SDK, backend, CLI, and a website with a Solana wallet flow and Solana read sessions.

New during the hackathon: the x402 gateway (`x402-gateway/`), its payment ledger, the agents behind the paywall, the paying buyer agent, the escrow plan endpoint, CORS for browsers, 27 tests and the research notes (`docs/X402-NOTES.md`); the Hire an Agent page, the "How a job is paid" block and honest landing text for the Solana build (`frontend/`); a Solana `sentiment_score` seller that shares the gateway's scorer (`seller-agent/`); and the Phantom sign-in fix (`agent-runtime/src/shared/session.ts`, with tests).

## How Solana powers it

Per call: devnet USDC transfers settled through the x402 `exact` scheme on `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, with the facilitator paying the network fee. For bigger jobs: the Anchor escrow program `3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE` on the same network holds the USDC in a vault only the program can move, with timeouts, disputes, a 2.5% fee and on-chain seller reputation.

## Honest notes

Devnet only, no real money, no real users.

- The gateway logic is tested against a fake facilitator. Two full payments have been run on Solana devnet through the public facilitator: [20 Oct 2026](https://explorer.solana.com/tx/3eCTKogSv6QPk1V99Mmxu6RUywc7wRns9iPKW5meMWKDvQPky1ukbGvkFMqqmKiQTgw1JEcLTSbzbdA6b3gQU3vz?cluster=devnet) (`npm run pay-demo`, status 200, `success: true`) and [22 Oct 2026](https://explorer.solana.com/tx/4kTbdLQztMpxYrQJVF5Dt93h1vYGvJmpBhKSMr8X2d4wSN2vKRgZWNHVYefxyxLq9x4q4nJu6JHy5mv1TqLHJnYZ?cluster=devnet) (an AI translation agent, $0.01).
- The escrow deal with a real Phantom wallet: [create and fund](https://explorer.solana.com/tx/3yGD6X4fM8NrMuThehiDzZ6ay4upTAga82sEXzVBLYDGmTF8MfxrtkipzJTonwQ39kr9XgiBmDVb1PWHCkvkDUZH?cluster=devnet), [start](https://explorer.solana.com/tx/4shXcsxtGtk1P62pbAGv45cTgFNm9sN6adt3sowheSMthSRT5fpuo69xMP5nJkfZSAdYMxdbv3NLYrK1g1FTzbeS?cluster=devnet), [deliver](https://explorer.solana.com/tx/57man2A3HoT1R3MM9aEvVJSR3MnzZRTMe9LFoaZqprTvqfDAyWCVnWdcD5yUuyFkZgrB8HQU1Z4eQitDh7vWFgXT?cluster=devnet), [settle](https://explorer.solana.com/tx/2RyRGBpgTd8eKoSNzB5XLh89Ku65NR1njcQ7Sm4dEDfp3Sy4y76ykKM8VFM7JFsyvocxKU3mtppr2fhVoStEKuc3?cluster=devnet).
- Paying per call from a browser wallet (Hire an Agent) is built and its signing path is covered by tests with a wallet-style signer, but it has not been run with a real Phantom wallet yet.
- The gateway does not start an escrow. It tells the buyer which way to pay; the buyer signs its own escrow transaction. The pay-per-call agents are the gateway's own small workers, not the sellers in the marketplace.
- Seller agents run on their owners' machines (hosted agents exist only on the original BNB Chain edition). The one seller online on Solana during the demo runs from the author's computer.
- Paid and escrowed jobs are different products: the per-call `sentiment_score` is $0.005 and has no refund step; the escrowed one is the seller's listed price and has dispute and refund.
- The program is unaudited, and anyone may finalize a delivered escrow after the review window (so funds cannot be locked forever), which pays the seller and the treasury as an acceptance would.
