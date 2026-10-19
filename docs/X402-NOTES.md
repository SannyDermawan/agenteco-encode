# x402 on Solana: research notes

Read on 20 Oct 2026 from docs.x402.org, the x402 repository's exact SVM scheme specification, and the installed `@x402/*` 2.28.0 packages. Nothing below is guessed; the open questions are at the end.

## Flow

1. The client requests the resource. The server answers 402 with a base64 JSON `PAYMENT-REQUIRED` header (accepted schemes, price, network, destination).
2. The client prepares a payment payload and retries with a base64 JSON `PAYMENT-SIGNATURE` header.
3. The server verifies and settles, itself or through a facilitator's `/verify` and `/settle`.
4. If valid, the server returns the resource and a `PAYMENT-RESPONSE` header with the settlement result (`success`, `transaction`, `network`, `payer`).

## Exact scheme on Solana

- Network ids are CAIP-2: mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, devnet `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`.
- Requirements: `scheme: exact`, `amount` (base units, string), `asset` (token mint), `payTo` (merchant; funds go to its associated token account), `maxTimeoutSeconds`, `extra.feePayer` (the sponsor that pays the network fee).
- The payload is a base64, partially signed, versioned transaction: a compute budget pair, one `TransferChecked` to the merchant's token account, an optional memo. The sponsor adds its signature at settlement and must not appear in any instruction's accounts.
- Verification (per the spec): at least `amount` of `asset` reaches `payTo`'s token account, exactly one matching transfer, only the client and sponsor are required signers, only compute-budget and memo extras (plus wallet-program allowlist). Settlement submits the fully signed transaction.
- The spec recommends keeping a short-lived cache of settling payloads to reject duplicates. The gateway's ledger does this per payment proof, permanently.

## Packages used (2.28.0)

`@x402/express` (`paymentMiddleware`, `x402ResourceServer`), `@x402/core` (`HTTPFacilitatorClient`, the client), `@x402/svm` (`ExactSvmScheme` for server and client, `toClientSvmSigner`), `@x402/fetch` (`wrapFetchWithPayment`). The README of `@x402/svm` mentions a `createSvmClient` builder at `@x402/svm/client`, but 2.28.0 does not export it; use `x402Client().register('solana:*', new ExactSvmScheme(signer))` as `scripts/pay-demo.ts` does.

## Facilitator

`https://x402.org/facilitator` is the public development and test facilitator. Its `/supported` answer (checked 20 Oct 2026) lists the `exact` scheme for `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` with a fee payer address, so devnet works without running a facilitator of our own. The default price conversion for `$0.005` on devnet gives amount `5000` of mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (also AgentEco's devnet test token).

## Behaviour of the express middleware that mattered

- Settlement happens after the handler responds; a response with status 400 or above is not settled. The gateway relies on this: a failed agent costs the buyer nothing.
- A facilitator timeout is answered by the middleware as a bare 502 with an `error` text; the gateway maps it to 503 with `Retry-After`. A facilitator that answers 500 is treated as a failed verification (402).
- Hooks (`onVerifyFailure`, `onAfterSettle`, `onSettleFailure`) take a single context argument.

## Open questions

- A real devnet payment has not been run (needs a funded wallet): confirm the settlement receipt format end to end with `npm run pay-demo`.
- Whether the public facilitator rate-limits Solana devnet settlements.
- Escalation to AgentEco escrow from the gateway is designed in the README but not built.
