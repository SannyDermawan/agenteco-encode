# Solana (devnet)

Status: **the escrow program and `SolanaAdapter` are written and tested locally (litesvm). Nothing is deployed, and nothing in the backend, API, SDK, CLI or frontend uses Solana yet.** Back to [MULTICHAIN.md](MULTICHAIN.md) (§3 `ChainAdapter`, §9 item 6).

Scope: the program covers the money and the dispute decision only — escrow, settlement with a fee, refund, timeouts, dispute ruling and seller rating, mirroring `contracts/AgentEco.sol`. Discovery, negotiation, listings and ranking stay off-chain in the existing backend, exactly as on the EVM chains.

## 1. What exists

| Piece | Where | Tested by |
|---|---|---|
| Anchor program `agenteco_escrow` | `solana/programs/agenteco_escrow/src/lib.rs` | `tests/escrow.rs` — 18 litesvm tests (Rust) |
| `SolanaAdapter` (a `ChainAdapter`, `family: 'solana'`) | `agent-runtime/src/chain/solana.ts` | `src/chain/conformance.test.ts` — the scenario below, on both adapters |
| In-process chain for tests | `agent-runtime/test-support/litesvm.ts` | — |
| One scenario for every adapter | `agent-runtime/test-support/conformance.ts` | runs on `EvmAdapter` (anvil) and `SolanaAdapter` (litesvm) |
| Deploy and setup scripts (**not run against a cluster by the author**) | `solana/scripts/deploy-devnet.sh`, `agent-runtime/scripts/solana-initialize.ts` | see §8 |

## 2. State machine

The same order as the EVM contract, so `EscrowStatusCode` means the same on every chain: `CREATED 0, FUNDED 1, EXECUTING 2, DELIVERED 3, DISPUTED 4, SETTLED 5, REFUNDED 6`.

```
FUNDED → EXECUTING → DELIVERED → SETTLED | REFUNDED
                         ↓
                      DISPUTED → SETTLED | REFUNDED
```

One difference: `createEscrow` and `fundEscrow` are a single instruction, `create_and_fund_escrow` (`ChainAdapter.createAndFundEscrow` is already one call, and an SPL transfer needs the buyer's signature in the same transaction anyway). An escrow therefore starts in FUNDED; `CREATED` never occurs on Solana.

| Instruction | Signer | Effect |
|---|---|---|
| `initialize` | admin | once: writes `Config` (arbiter, treasury, the settlement mint, fee, windows, first escrow id) |
| `set_fee(fee_bps, treasury)` | admin | new escrows take the new rate (≤ 10%); existing escrows keep theirs |
| `set_arbiter(arbiter)` | admin | one step, no pending/accept handover (unlike `transferArbiter`/`acceptArbiter` on EVM) |
| `create_and_fund_escrow(amount, execution_window, review_window, task_hash)` | buyer | creates the escrow and its vault, moves `amount` in; FUNDED; `accept_deadline = now + accept_timeout` |
| `start_execution` | seller | FUNDED → EXECUTING, no later than `accept_deadline` |
| `claim_accept_timeout` | anyone | FUNDED past `accept_deadline` → REFUNDED, vault → buyer; no mark against the seller |
| `mark_delivered(result_hash)` | seller | EXECUTING → DELIVERED; a late delivery is accepted until someone claims the timeout |
| `claim_execution_timeout` | anyone | EXECUTING past `execution_deadline` → REFUNDED; `failed_jobs += 1` |
| `accept_and_settle` | buyer | DELIVERED → SETTLED, pays fee + seller |
| `finalize_after_review_window` | anyone | DELIVERED past `review_deadline` → SETTLED, same payout |
| `raise_dispute(reason_hash)` | buyer | DELIVERED, no later than `review_deadline` → DISPUTED; `dispute_deadline = now + dispute_timeout` |
| `submit_dispute_response(response_hash)` | seller | once, before `dispute_deadline` |
| `resolve_dispute(to_seller, rationale_hash)` | arbiter | before `dispute_deadline`: SETTLED (paid like a settlement) or REFUNDED (`failed_jobs += 1`) |
| `claim_dispute_timeout` | anyone | DISPUTED past `dispute_deadline` → REFUNDED; no reputation change |
| `rate_seller(score)` | buyer | once per escrow, 1–100, after SETTLED/REFUNDED, only if a result was delivered |

Every non-final status has an exit that needs nobody's cooperation. The fee (`amount × fee_bps / 10 000`, 2.5% by default) is taken only when an escrow settles to the seller (accept, finalize, ruling for the seller); every refund path returns the full amount. Deadlines follow `AgentEco.sol`: `start_execution` and `raise_dispute` allow `now <= deadline`, the permissionless claims need `now > deadline`. The four hashes the preimage rules produce (`task`, `result`, `dispute reason`, `dispute response`, `rationale`) must be non-zero, as on EVM.

## 3. Accounts and what is checked

- `Config` (PDA `["config"]`): admin, arbiter, treasury, **mint**, fee, `min_window`, `accept_timeout`, `dispute_timeout`, `next_escrow_id`. The deployment has one settlement token, fixed at `initialize` (like `USDT immutable` in `AgentEco.sol`): `create_and_fund_escrow` refuses any other mint.
- `Escrow` (PDA `["escrow", id as u64 LE]`): parties, mint, amount, status, the fee rate fixed at creation, every timestamp, deadline and hash of the Solidity struct, `rated`.
- Vault: an SPL token account at PDA `["vault", id]` that is its own authority; only the program can move funds out of it, by signing with the vault seeds. Its address is derived from the escrow's id, so one escrow's vault cannot be passed for another's.
- `Reputation` (PDA `["reputation", seller]`): completed, failed, volume, rating sum and count. Created by the first escrow that names the seller (the buyer pays its rent).
- Per instruction: the role-gated calls need the matching signer (`has_one`); `accept_and_settle` needs the buyer, `resolve_dispute` needs `Config.arbiter`; every payout account must be a token account of the escrow's mint owned by the expected party (the seller, the buyer, or the treasury); the SPL Token program is checked by type. `resolve_dispute` checks that the account it pays is the seller's (ruling for the seller) or the buyer's (ruling for the buyer). The tests assert the exact Anchor error code of each rejection.
- Token programs: the legacy SPL Token program only (Token-2022 mints are refused by the account types).

Hashes stay keccak256 of the committed preimage on every chain (`agent-runtime/src/shared/hashes.ts`); the program stores 32 opaque bytes and never hashes anything itself.

## 4. Arbiter and council — a decision for the owner

`Config.arbiter` is one signer. It can be a plain wallet or the vault of a multisig such as [Squads](https://squads.so/), which signs `resolve_dispute` like any wallet; `set_arbiter` hands the role over. The adapter therefore reports `council: null`, and `ruleDispute` always executes directly. A Solana port of `ArbiterCouncil.sol` (votes per `(escrow, ruling, rationale)`, ruling and admin thresholds, CPI into `resolve_dispute`) is **not built**: it is a second program to write, deploy and test. Open: Squads (no new code, but then rulings are multisig proposals, not the keeper's one-call vote) versus a purpose-built council program.

## 5. `SolanaAdapter`

`agent-runtime/src/chain/solana.ts`, built on `@solana/kit`. It implements the whole `ChainAdapter` interface except `ratingsInTx` and `ratings`, which throw: the program emits no events yet, and Solana has no block-range log query to fall back on.

- **Backend.** The adapter talks to a `SolanaBackend` (read an account, read the clock, send instructions). The only implementation is the litesvm one in `test-support/`; **there is no devnet RPC backend yet.**
- **Chain id.** `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` for devnet (CAIP-2: the first 32 characters of the genesis hash; checked against devnet on 11 Oct 2026). `isSolanaChainId` and `SOLANA_DEVNET_CHAIN_ID` are exported from `solana.ts`. **The chain registry (`registry.ts`, `normalizeChainId`, `CHAINS`) was not extended**: it is built around `EvmChainConfig`. Until it is, the backend cannot serve a Solana chain.
- **Addresses and signatures.** `normalizeAddress` is the identity (base58 is case-sensitive). The interface gained `isValidAddress` and `verifySignature({ address, message, signature })`: EVM recovers an EIP-191 signature (contract wallets are not supported, as in the backend today); Solana verifies ed25519 over the UTF-8 message, signature in base58. `TxHash` is now `string` (an EVM hash or a Solana signature). The backend's own sign-in code still calls viem directly and does not use the adapter.
- **Amounts and ids.** `createAndFundEscrow` converts with the mint's real decimals (`parseUnits`, no floating point); ids are `u64`, carried as `bigint`; `readEscrowBasics`, `escrowIds` and `listEscrows` walk `firstEscrowId … next_escrow_id − 1`, which the adapter's config supplies like `EvmChainConfig` does.
- **Status codes** map the program's `Funded…Refunded` to 1…6.
- **Token accounts.** The adapter uses associated token accounts (buyer, seller, treasury) and **does not create them**: they must exist. Creating the seller's and treasury's accounts is a setup step that is not built (the test chain pre-creates them). `transferToken` also needs the destination's account to exist.
- **Reputation** is read from the PDA with the same arithmetic as the EVM adapter (decimal success rate and average).

## 6. Tests

Run order, from the repository root:

```
cd solana/programs/agenteco_escrow
cargo build-sbf --arch v0     # litesvm 0.10 refuses the SBPF v3 that Anchor 1.2.1 builds by default
cargo test                    # 18 tests
cd ../../../agent-runtime
npm test                      # includes src/chain/conformance.test.ts
```

- **Rust (`tests/escrow.rs`)**: happy path with the fee split and reputation counters; finalize after the review window; accept, execution and dispute timeouts (too early, then due); dispute ruled for the seller and for the buyer; late delivery; no start after the accept window; wrong signer / wrong status / wrong mint / wrong treasury account / wrong payout party; zero hashes; the one-mint rule; fee changes (admin only, existing escrows keep their rate, new ones take the new rate); arbiter handover. Rejections are asserted by Anchor error number, not just "failed". The SPL Token program binary (`solana/test-fixtures/spl_token.so`) was dumped from devnet with `solana program dump TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`; litesvm 0.10 does not bundle it.
- **Conformance (`test-support/conformance.ts`)**: one scenario through the chain-neutral interface only — signature check, settlement with exact balances for buyer, seller and treasury, both dispute rulings, all four timeouts, access control, reputation after each step, listing. It runs unchanged on `EvmAdapter` against anvil and `SolanaAdapter` against litesvm; each skips itself when its tooling is missing. `evm.test.ts` and the other existing suites were not edited.
- The litesvm used by the TypeScript tests (npm `litesvm` 1.6) runs both SBPF v0 and v3; the Rust crate's litesvm (0.10) only v0, which is why the program is built with `--arch v0` everywhere, and the tested binary is the deployed one.

## 7. Toolchain notes

Installed from official sources: Rust (rustup, 1.99), Solana CLI (`release.anza.xyz`, 4.1.2 with platform-tools v1.54), Anchor CLI 1.2.1 built from `github.com/otter-sec/anchor` with `avm install 1.2.1 --from-source` (the prebuilt binary's provenance check could not reach GitHub's attestation endpoint from the build sandbox). Things that bit:

- `avm`'s `anchor` shim panicked while reconciling platform-tools versions; the real binary (`~/.avm/bin/anchor-1.2.1`) works when called directly.
- `anchor build` defaults to `--arch v3 --tools-version v1.57`. With Solana CLI 4.1.2 (platform-tools v1.54) use `anchor build --arch v0 --tools-version v1.54`; with a CLI that ships v1.57, `anchor build --arch v0`.
- Anchor 1.2.1 is not on crates.io; `Cargo.toml` takes `anchor-lang`/`anchor-spl` from the git tag `v1.2.1`. Its `CpiContext::new` takes the program id, not an `AccountInfo`.
- `Cargo.toml` declares the standard Anchor features (`idl-build`, `custom-heap`, …) so builds are free of `cfg` warnings and `anchor build` can generate the IDL.

## 8. Deploying to devnet — done by the repository owner

The scripts check but have not been run against devnet by their author. A rehearsal against a local `solana-test-validator` is described in §10.

1. Program keypair: `solana-keygen new -o solana/target/deploy/agenteco_escrow-keypair.json`, then `anchor keys sync` in `solana/` (rewrites `declare_id!` and `Anchor.toml`). The id in the repository belongs to a throwaway keypair that was not kept; the tests read `declare_id!` from the source, so they follow any id.
2. `KEYPAIR=<devnet deployer> solana/scripts/deploy-devnet.sh` — refuses any cluster whose genesis hash is not devnet or testnet (a local validator host is allowed for rehearsals), checks that the program keypair matches `declare_id!`, builds with `--arch v0`, runs the tests, deploys. `DRY_RUN=1` stops before sending.
3. Once: `cd agent-runtime && npx tsx scripts/solana-initialize.ts --keypair <same> --mint <token> --arbiter <address> --treasury <address>` (`--dry-run` prints the call). Devnet USDC is `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (an SPL Token mint with 6 decimals on devnet, checked 11 Oct 2026). The treasury wallet, every seller and every buyer need an associated token account for the mint before they transact.
4. Keys: the deployer, admin and arbiter keys are the owner's; nothing in this repository creates or stores one.

## 9. Limits and what is not done

- Nothing is deployed; the backend, API, SDK, CLI and frontend do not know the chain. Wiring needs: a Solana entry type in the chain registry and `CHAINS`, a devnet RPC `SolanaBackend`, `chainId` handling beyond EVM in the API and database, and an ed25519 path in the sign-in code.
- No events, so no `ratings()`/`ratingsInTx()` and no log-based escrow index; the adapter lists escrows by counting up to `next_escrow_id`.
- No council program (§4). `set_arbiter` is a single-step handover by the admin.
- No creation of token accounts, no escrow account closing (rent stays locked), no Token-2022.
- The program is unaudited. Account and signer checks are tested, not formally reviewed.
- Mainnet is out of scope; the scripts refuse it.

## 10. Rehearsal against a local validator

See the end-to-end check recorded with the work: deploy with the script, initialize with the setup script (devnet USDC cloned into the validator), and read the `Config` back. It exercises the scripts, the program binary and the instruction encoding on a real validator runtime, not the adapter's full flow.
