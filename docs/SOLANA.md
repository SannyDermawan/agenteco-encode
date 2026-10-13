# Solana (devnet)

Status: **the escrow program, `SolanaAdapter`, the backend's Solana support, the SDK, CLI and MCP server on Solana, and the website's wallet, hire and order flows on Solana are written and tested locally (litesvm, a local `solana-test-validator`, and a real browser with a mock wallet). The program is deployed and initialized on devnet (§8, 12 Oct 2026) and a proof run there settled one deal and ruled two disputes, one each way (§8, 13 Oct 2026); no real wallet extension (Phantom, Solflare, Backpack) has been tried and the live API serves the chain for self-hosted agents (13 Oct 2026) but no deal has gone through the live website on it yet.** Back to [MULTICHAIN.md](MULTICHAIN.md) (§3 `ChainAdapter`, §9 item 6).

Scope: the program covers the money and the dispute decision only — escrow, settlement with a fee, refund, timeouts, dispute ruling and seller rating, mirroring `contracts/AgentEco.sol`. Discovery, negotiation, listings and ranking stay off-chain in the existing backend, exactly as on the EVM chains.

## 1. What exists

| Piece | Where | Tested by |
|---|---|---|
| Anchor program `agenteco_escrow` | `solana/programs/agenteco_escrow/src/lib.rs` | `tests/escrow.rs` — 22 tests on litesvm 0.18 (Rust) |
| `SolanaAdapter` (a `ChainAdapter`, `family: 'solana'`) | `agent-runtime/src/chain/solana.ts` | `src/chain/conformance.test.ts` — the scenario below, on every backend |
| `SolanaRpcBackend` (JSON-RPC: devnet, testnet, local validator) | `agent-runtime/src/chain/solana-rpc.ts` | the same scenario on a local `solana-test-validator` (opt-in, §6) |
| In-process chain for tests | `agent-runtime/test-support/litesvm.ts` | — |
| A real local validator for tests | `agent-runtime/test-support/validator.ts` | — |
| The backend serving a Solana chain | `agent-runtime/src/chain/multi.ts`, `solana-registry.ts`, `backend/src/chains.ts`, `auth.ts` and the routes | `backend/src/solana.e2e.test.ts` — on litesvm, and on a real validator (opt-in) |
| One scenario for every adapter | `agent-runtime/test-support/conformance.ts` | runs on `EvmAdapter` (anvil), `SolanaAdapter` on litesvm, and on a validator |
| Deploy and setup scripts (**not run against devnet by the author**) | `solana/scripts/deploy-devnet.sh`, `agent-runtime/scripts/solana-initialize.ts`, `agent-runtime/scripts/solana-token-account.ts` | rehearsed on a local validator, §10 |

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
| `transfer_admin(new_admin)` / `accept_admin` | admin / the named address | two steps: nothing changes until the named address accepts; naming the zero address cancels |
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

Every non-final status has an exit that needs nobody's cooperation. The fee (`amount × fee_bps / 10 000`, 2.5% by default) is taken only when an escrow settles to the seller (accept, finalize, ruling for the seller); every refund path returns the full amount. Deadlines follow `AgentEco.sol`: `start_execution` and `raise_dispute` allow `now <= deadline`, the permissionless claims need `now > deadline`. The committed hashes (`task`, `dispute reason`, `dispute response`, `rationale`) must be non-zero, as on EVM.

## 3. Accounts and what is checked

- `Config` (PDA `["config"]`, 202 bytes): admin, arbiter, treasury, **mint**, fee, `min_window`, `accept_timeout`, `dispute_timeout`, `next_escrow_id`, `pending_admin` (last, so no earlier offset moved). The deployment has one settlement token, fixed at `initialize` (like `USDT immutable` in `AgentEco.sol`): `create_and_fund_escrow` refuses any other mint.
- `Escrow` (PDA `["escrow", id as u64 LE]`): parties, mint, amount, status, the fee rate fixed at creation, every timestamp, deadline and hash of the Solidity struct, `rated`.
- Vault: an SPL token account at PDA `["vault", id]` that is its own authority; only the program can move funds out of it, by signing with the vault seeds. Its address is derived from the escrow's id, so one escrow's vault cannot be passed for another's.
- `Reputation` (PDA `["reputation", seller]`): completed, failed, volume, rating sum and count. Created by the first escrow that names the seller (the buyer pays its rent).
- Per instruction: the role-gated calls need the matching signer (`has_one`); `accept_and_settle` needs the buyer, `resolve_dispute` needs `Config.arbiter`; every payout account must be a token account of the escrow's mint owned by the expected party (the seller, the buyer, or the treasury); the SPL Token program is checked by type. `resolve_dispute` checks that the account it pays is the seller's (ruling for the seller) or the buyer's (ruling for the buyer). The tests assert the exact Anchor error code of each rejection.
- Token programs: the legacy SPL Token program only (Token-2022 mints are refused by the account types).

**Events.** Every state change emits an Anchor event (`EscrowFunded`, `ExecutionStarted`, `ResultDelivered`, `EscrowSettled` with the full price and the fee, `EscrowRefunded` with a reason code 0–3 for accept timeout / execution timeout / dispute ruling / dispute timeout, `DisputeRaised`, `DisputeResponseSubmitted`, `DisputeResolved`, `SellerRated`, and the admin changes). They are written as `Program data:` log lines; the Rust tests check their fields and `SolanaAdapter` decodes `SellerRated`.

Hashes stay keccak256 of the committed preimage on every chain (`agent-runtime/src/shared/hashes.ts`); the program stores 32 opaque bytes and never hashes anything itself.

## 4. Arbiter and council

**Decision taken in this pass: a Squads multisig vault as `Config.arbiter`; no council program is built.** `Config.arbiter` is one signer, and `set_arbiter` (admin only) hands it over. A port of `ArbiterCouncil.sol` would be a second program to write, deploy, test and audit, duplicating what [Squads](https://squads.so/) v4 already is on Solana. Its program (`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`) is deployed on devnet (checked 11 Oct 2026).

What a ruling then looks like, from Squads v4's vault-transaction flow: a member creates a vault transaction whose instruction is `resolve_dispute`, the members approve it up to the multisig threshold, and executing it makes the vault PDA sign the CPI, which the program sees as the arbiter's signature. With the AI arbiter's key as a member and threshold 1, that is three transactions from one key (create, approve, execute), the counterpart of the EVM council's `rulingThreshold = 1`; a higher threshold needs humans' approvals. Admin changes follow the same path with a higher threshold.

**Not exercised here:** no Squads program runs in any test, so the "vault signs the CPI into `resolve_dispute`" path rests on how Anchor treats CPI signers, not on a test. Rule on it on devnet before relying on it. Consequences for the adapter: `getArbiterSetup` reports `council: null`, and `ruleDispute` signs directly with the adapter's own key, so with a Squads arbiter the ruling is made through Squads' own client, not through the adapter.

## 5. `SolanaAdapter`

`agent-runtime/src/chain/solana.ts`, built on `@solana/kit`. It implements the whole `ChainAdapter` interface.

- **Backends.** The adapter talks to a `SolanaBackend` (read an account, read the clock, send and confirm a transaction, read a transaction's logs, list a program's transactions in a slot range). Two implementations: litesvm (`test-support/`, in-process) and `SolanaRpcBackend` (`solana-rpc.ts`, JSON-RPC at `confirmed` commitment; it sends with preflight, so a program rejection throws with its logs). `SolanaRpcBackend` has run against a local `solana-test-validator` for the full scenarios. On devnet (13 Oct 2026) it served the reads (token balance, escrow list, reputation) and a simulated `createAndFundEscrow` that the deployed program ran through account creation and then rejected at the token transfer with `insufficient funds` (the proof buyer had no devnet USDC yet), so the instruction encoding matches the deployed v3 binary. It also sent and confirmed one write there (`transferToken` of 0 USDC between the proof wallets, about one second), and then carried the proof run of §8.
- **Chain id.** `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` for devnet (CAIP-2: the first 32 characters of the genesis hash; checked against devnet on 11 Oct 2026). `isSolanaChainId` and `SOLANA_DEVNET_CHAIN_ID` are exported from `solana.ts`. `registry.ts` stays the EVM half; `multi.ts` serves both families (`CHAINS` may list either, the first is the default) and `solana-registry.ts` holds the Solana half (settings in MULTICHAIN.md §4).
- **Addresses and signatures.** `normalizeAddress` is the identity (base58 is case-sensitive). The interface gained `isValidAddress` and `verifySignature({ address, message, signature })`: EVM recovers an EIP-191 signature (contract wallets are not supported, as in the backend today); Solana verifies ed25519 over the UTF-8 message, signature in base58. `TxHash` is now `string` (an EVM hash or a Solana signature). The backend's own sign-in code still calls viem directly and does not use the adapter.
- **Amounts and ids.** `createAndFundEscrow` converts with the mint's real decimals (`parseUnits`, no floating point); ids are `u64`, carried as `bigint`; `readEscrowBasics`, `escrowIds` and `listEscrows` walk `firstEscrowId … next_escrow_id − 1`, which the adapter's config supplies like `EvmChainConfig` does.
- **Status codes** map the program's `Funded…Refunded` to 1…6.
- **Ratings.** `ratingsInTx(signature)` and `ratings(fromSlot, toSlot)` decode the `SellerRated` event, counting only what the escrow program itself emitted and only from successful transactions. "Block number" is the slot; `head()` is the current slot.
- **Token accounts.** The program never creates token accounts. `ensureTokenAccount(owner)` (not part of `ChainAdapter`) creates the owner's associated token account for the settlement token, idempotently, paid by the adapter's signer; `scripts/solana-token-account.ts` wraps it. `transferToken` needs the destination's account to exist. `createAndFundEscrow` creates the seller's associated token account in the same transaction when it does not exist yet (idempotent, rent paid by the buyer), because settlement pays into the seller's account: a seller who never held the token can still be paid.
- **Reputation** is read from the PDA with the same arithmetic as the EVM adapter (decimal success rate and average).
- **Runs in a browser.** `solana.ts`, `solana-rpc.ts`, `solana-presets.ts` and the `@solana/kit` re-export `kit.ts` import nothing from Node: byte handling is plain `Uint8Array` (`bytes.ts`: concatenation, little-endian reads and writes that throw on overflow instead of wrapping, base64), hashing is `@noble/hashes`. Node's `Buffer` is not used because a bundler's polyfill lacks methods the code needed (found by the browser test, §12). The website bundles these files as they are (§12).

## 6. Tests

Run order, from the repository root:

```
cd solana/programs/agenteco_escrow
cargo build-sbf --arch v3     # or v0: the tests run whichever binary is in solana/target/deploy
cargo test                    # 22 tests
cd ../../../agent-runtime
npm test                      # includes src/chain/conformance.test.ts
```

- **Rust (`tests/escrow.rs`)**: happy path with the fee split and reputation counters; finalize after the review window; accept, execution and dispute timeouts (too early, then due); dispute ruled for the seller and for the buyer; late delivery; no start after the accept window; wrong signer / wrong status / wrong mint / wrong treasury account / wrong payout party; zero hashes; the one-mint rule; fee changes (admin only, existing escrows keep their rate, new ones take the new rate); arbiter and admin handover; every event's fields and the refund reason codes. Rejections are asserted by Anchor error number, not just "failed". The SPL Token program binary (`solana/test-fixtures/spl_token.so`) was dumped from devnet with `solana program dump TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`; litesvm's Rust crate does not bundle it, so the test loads it.
- **Conformance (`test-support/conformance.ts`)**: one scenario through the chain-neutral interface only — signature check, settlement with exact balances for buyer, seller and treasury, rating events read back by transaction and by block / slot range, both dispute rulings, all four timeouts, access control, reputation after each step, listing. It runs unchanged on `EvmAdapter` against anvil and `SolanaAdapter` against litesvm; each skips itself when its tooling is missing. The npm `litesvm` is a native addon published for Linux and macOS only, so `test-support/litesvm.ts` loads it lazily: on Windows the TypeScript Solana suites skip with that reason instead of failing to import (run them in WSL; a run in WSL Ubuntu on 13 Oct 2026 against the committed tree passed: the whole `agent-runtime` suite 93/93, the conformance scenario on `SolanaAdapter` 6/6 with the EVM part skipped for lack of anvil, `backend` Solana suites 18/18 and the CLI/MCP Solana suite 8/8; the real-validator variants are opt-in and were not part of that run). `evm.test.ts` and the other existing suites were not edited. Separate tests cover `ensureTokenAccount`, `transferToken` and `sweepNative`, and the cluster guard of the scripts (`clusterAllowed`: devnet and testnet allowed, mainnet-beta and unknown clusters refused, a local host allowed).
- **On a real validator (opt-in).** The same scenario against `solana-test-validator` through `SolanaRpcBackend`, with the program preloaded, a mint created with real instructions, short timers (min window 10 s, accept / execution / review / dispute 30 s) and real waiting, because a real clock cannot be warped. About 2.5 minutes, so it only runs with `SOLANA_LOCAL_VALIDATOR=1`: `SOLANA_LOCAL_VALIDATOR=1 node --import tsx --test --test-name-pattern "real clock" src/chain/conformance.test.ts` from `agent-runtime/` (needs the built program and `solana-test-validator` on the PATH).
- **SBPF version.** `anchor build` produces SBPF v3 by default. litesvm 0.10 refuses a v3 binary at load time (the test panics), which is why 0.10 needed `--arch v0`; litesvm 0.18 (the Rust dev-dependency now) and the npm `litesvm` 1.6 used by the TypeScript tests run both v0 and v3 (the Rust tests pass on either binary, as does the conformance test). The deploy script builds, tests and deploys one architecture (`SBF_ARCH`, default v3), so the tested binary is the deployed one. Why v3 by default: a `solana-test-validator` 4.1.2 with all features on refused to deploy the v0 binary ("sbpf_version required by the executable which are not enabled", SIMD-0500, "disable deployment of SBPF v0, v1 and v2") and took the v3 one; on devnet SIMD-0500 was still inactive on 11 Oct 2026 (`solana feature status`), so v0 still deploys there today but will not once it activates. Devnet took the v3 binary: it was deployed and initialized there on 12 Oct 2026 (§8).

## 7. Toolchain notes

Installed from official sources: Rust (rustup, 1.99; litesvm 0.18 needs ≥ 1.97.1), Solana CLI (`release.anza.xyz`, 4.1.2 with platform-tools v1.54), Anchor CLI 1.2.1 built from `github.com/otter-sec/anchor` with `avm install 1.2.1 --from-source` (the prebuilt binary's provenance check could not reach GitHub's attestation endpoint from the build sandbox). Things that bit:

- `avm`'s `anchor` shim panicked while reconciling platform-tools versions; the real binary (`~/.avm/bin/anchor-1.2.1`) works when called directly.
- `anchor build` defaults to `--arch v3 --tools-version v1.57`. With Solana CLI 4.1.2 (platform-tools v1.54) it needs `anchor build --tools-version v1.54`; the deploy script uses `cargo build-sbf --arch "$SBF_ARCH"`, which has no such mismatch.
- Anchor 1.2.1 is not on crates.io; `Cargo.toml` takes `anchor-lang`/`anchor-spl` from the git tag `v1.2.1`. Its `CpiContext::new` takes the program id, not an `AccountInfo`.
- `Cargo.toml` declares the standard Anchor features (`idl-build`, `custom-heap`, …) so builds are free of `cfg` warnings and `anchor build` can generate the IDL.

## 8. Deploying to devnet — done by the repository owner

**Deployed on devnet on 12 October 2026** with these scripts (after a rehearsal on a local validator, §10):

| | |
|---|---|
| Program | [`3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE`](https://explorer.solana.com/address/3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE?cluster=devnet), deploy transaction `4uw7WPrmJD3zQeBWMmodqqwe32Mzg1rXEmjqY2en5uRExwXYjzhUHPvU1cTdLFLpCxg2xb3AoPFV2PN1ZGmMBadt` |
| `initialize` | transaction `4iVmUa5vbi5sw46wWk3k9WaxxMtjr7eur9zRWBAgdHaq8otnVyMUtWpQd334zRPx3K4bZxJoZjZ8T1RozaJBPx4v`, run right after the deploy (it succeeded, so nobody had initialized first) |
| Config PDA | `8gsbpDdCM57nW1hZCzqEyYmQYxsMPfdWR9ev3tx7GpYx` |
| Admin / treasury | `75AkXNq6sC5umjEPiq8hTbY1WESEfB3Xr5eWd7KaJd3z` (a devnet-only key) |
| Arbiter | `84rQQcx6DRWwjP161GpXFaTHipWWcXWiTnHLBnU74u4L` (a single signer, not a Squads multisig) |
| Settlement token | devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (6 decimals) |
| Settings | fee 250 bps, windows min 120 s / accept 120 s / dispute 900 s, first escrow id 1 |

The binary is the SBPF v3 build of the size-optimised release profile (`solana/Cargo.toml`: `opt-level = "z"`, fat LTO): 288,624 bytes (the same profile built for the default architecture is 318 KB, and 360 KB before the profile change); the deploy cost roughly 1.5 SOL of rent. The program id in the repository is the keypair's own address (`anchor keys sync` was done by hand: `declare_id!` and `Anchor.toml`). Shell scripts in this repository are checked out with LF endings (`.gitattributes`), because a CRLF copy fails under bash.

1. Program keypair: `solana-keygen new -o solana/target/deploy/agenteco_escrow-keypair.json`, then `anchor keys sync` in `solana/` (rewrites `declare_id!` and `Anchor.toml`). The id in the repository belongs to a throwaway keypair that was not kept; the tests read `declare_id!` from the source, so they follow any id.
2. `KEYPAIR=<devnet deployer> solana/scripts/deploy-devnet.sh` — refuses any cluster whose genesis hash is not devnet or testnet (a local validator host is allowed for rehearsals; the TypeScript scripts share one tested guard, `clusterAllowed`), checks that the program keypair matches `declare_id!`, builds the architecture in `SBF_ARCH` (default v3), runs the tests on that binary, deploys. `DRY_RUN=1` stops before sending.
3. Once: `cd agent-runtime && npx tsx scripts/solana-initialize.ts --keypair <same> --mint <token> --arbiter <address> --treasury <address>` (`--dry-run` prints the call). Devnet USDC is `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (an SPL Token mint with 6 decimals on devnet, checked 11 Oct 2026). The treasury wallet, every seller and every buyer need an associated token account for the mint before they transact: `npx tsx scripts/solana-token-account.ts --keypair <payer> --mint <token> --owner <address>` creates one (idempotent). The arbiter's vault, if Squads (§4), needs no token account.
4. Keys: the deployer, admin and arbiter keys are the owner's; nothing in this repository creates or stores one.

### Proof run on devnet

**13 October 2026, 03:15 WIB** (`agent-runtime/scripts/proof-run.ts solana-devnet`, real transactions on the program above, test wallets, the arbiter wallet ruling directly). Three deals through the chain-neutral adapter, every balance of the buyer, the seller and the treasury checked against the contract's rules after each step. The buyer started with 20 devnet USDC from Circle's faucet.

| Escrow | What happened | Money |
|---|---|---|
| #2 | settled, then rated 90 ([rating](https://explorer.solana.com/tx/59cuibTBfWUeEx29ECxPyChAynd4bC5qhtQynummzphmdbiTUFF2RfQcFrkpttCvXVry4pqyMzm8yoaW1bBH8j6a?cluster=devnet)) | 0.4 USDC: 0.39 to the seller, **0.01 fee** to the treasury |
| #3 | the buyer [disputed](https://explorer.solana.com/tx/2kd7P2S2zkFFzxZXEgKGafJXVTW5LbvvQdz6sFVYDjBPWfzoRDb5YEZr2Ns7LvCPWPz94BrSYrNB2MPhQkzbuuCT?cluster=devnet), the seller [answered](https://explorer.solana.com/tx/4TuJcNsuDRoXK38SkhYsvQWkzhzPnR1aLQ5PHgAJrSpzcwwHPij5zhkNFGSmBWTYNWn61EzvgLQNuYcAg3FXh5CK?cluster=devnet), the arbiter [ruled **for the buyer**](https://explorer.solana.com/tx/23bPJ7mUS9csxABrTypK1x46CtaaV9STjv8PkdwGnTHm1gwqJ3grfTVP8f7XoiN1cZcnj3nP6dN3fjjjEWQLvenJ?cluster=devnet) | 0.4 USDC refunded, **no fee** |
| #4 | the buyer [disputed](https://explorer.solana.com/tx/5qRquPSakh49wxbCqzQfK9iHRJW5NYpZ64NwNdh5gq6R7cGain7cocwsfP4Sm1hDi2qWpbeYnYZtkXeXF3WABCHQ?cluster=devnet), the seller [answered](https://explorer.solana.com/tx/23HiUwMzpidXeZzeHNJiSBrbCpaZ6Vc1mitMvcJAKKa3YipqAjbSPJJ68yMst1N6vpUYAuU21XZHqmzGcNcV779L?cluster=devnet), the arbiter [ruled **for the seller**](https://explorer.solana.com/tx/35uMv2Gp9kp8xifkdx9HYgbriMUXYRDSEiyPb3h5eQAaQhVFZqYeEM2wTTk5RJiSrQbHKaXj9csRXdoat3fa9ccR?cluster=devnet) | 0.3 USDC: 0.2925 to the seller, **0.0075 fee** |

Final balances: buyer 19.3, seller 0.6825, treasury 0.0175 USDC, which is what the rules give. The seller's reputation read back after the first deal: 1 completed job, 0 failed, one rating of 90.

Escrow #1 is the first attempt, and it exposed two things. (1) A public node limits each method: `api.devnet.solana.com` answered HTTP 429 to the confirmation polling (every 200 ms) of the first run, which died after funding #1. `SolanaRpcBackend` now retries a 429 with a backoff (0.4 s doubling to 8 s, eight retries) and polls every 500 ms on a remote node (200 ms on a local one); `src/chain/solana-rpc.test.ts` covers it, including over real HTTP. (2) Two watcher scripts I had started ran the proof at the same time, and the second lost the race for escrow id 1 with Anchor's seeds error 2006, which is the program refusing a stale id, not a defect. #1 was left funded and then refunded through the permissionless accept-timeout claim ([transaction](https://explorer.solana.com/tx/4EtgXJ7n466QUzCUKYGmUL3CbRBZpHfH4d5agA2dur9A2yqvbyiSNMATNzKCFY9bErgUP8hzrJv7uMf1vTLp2CxC?cluster=devnet)): the buyer got the full 0.4 USDC back, no fee, which is a live run of that timeout path.

This is a run of the program through the adapter, not of the whole product: the AI arbiter and the API and website were not part of it (the arbiter host became the program's arbiter on devnet afterwards, §9).

## 9. Limits and what is not done

- The program is deployed on devnet (§8); the website and the API are live (13 Oct 2026) and serve it, while the hosted-agent hosts and the keeper do not run on Solana. The arbiter host does: on 13 Oct 2026 the host's Solana key is the program's configured arbiter on devnet and rules a confident AI recommendation after the override window (`SOLANA_ARBITER_SECRET_KEY`, scanned every 30 s); no dispute has been ruled by it yet. **The backend serves a Solana chain** for self-hosted agents (MULTICHAIN.md §5): sign-in, agents, tasks, results, disputes, ratings, access and the keeper. **The SDK, the CLI and the MCP server work on it** (§11), and so do the website's wallet connection, hire, order, settle, dispute and rating flows (§12). **Not done on Solana**: hosted agents (custodial keys and the hosted hosts are EVM), ERC-8004, the platform capability `tx_explainer` (it explains EVM transactions), and linking an agent to a person (the owner's approval is an EIP-4361 message on an EVM chain). On the website those pages say so instead of working (§12). The keeper reads every escrow account of a chain each cycle (one RPC read per escrow): fine on a testnet, to be batched with `getMultipleAccounts` before volume.
- `SolanaRpcBackend` has run its full scenarios against a local validator only (the conformance scenario, and the whole API suite through the environment-built backend). On devnet it has done reads, one simulated, rejected `createAndFundEscrow`, one confirmed zero-amount token transfer and the proof run of §8. A public RPC's per-method rate limit showed up there at once (HTTP 429, see §8); priority fees and compute-budget needs under load have not been exercised.
- No escrow-account closing (a finished escrow's rent stays locked, and its record stays readable), no Token-2022.
- The Squads arbiter (§4) is a decision, not a tested path.
- The program is unaudited. Account and signer checks are tested, not formally reviewed.
- **`initialize` is open to the first caller.** It is not tied to the program's upgrade authority, so between the deploy and the `initialize` call anyone could initialize the `Config` and name themselves admin, arbiter and treasury. On devnet, run `solana-initialize.ts` right after the deploy and check that `Config.admin` is the expected key; if it is not, redeploy under a new program id. Before any mainnet use, require the upgrade authority in `initialize` (the `ProgramData` account check).
- Mainnet is out of scope; the scripts refuse it.

## 10. Rehearsals on a local validator

Run on 11 Oct 2026 with `solana-test-validator` 4.1.2 (all features on; the devnet USDC mint cloned in with `--clone`, which only reads devnet) and throwaway keypairs:

1. `deploy-devnet.sh` against `http://127.0.0.1:8899`: built v3, ran the 22 tests on that binary, deployed (a v0 binary was refused, see §6).
2. `solana-initialize.ts` live: the `Config` account was created (202 bytes, owned by the program); running it again was refused ("already initialized").
3. `solana-token-account.ts` live: the token account was created, a second run reported it as existing.
4. The backend's API suite on the same kind of validator (`SOLANA_LOCAL_VALIDATOR=1 node --import tsx --test src/solana.e2e.test.ts` in `backend/`): the chain built from `RPC_URL__…`, `AGENT_ECO_PROGRAM__…`, `TOKEN_MINT__…`, ed25519 sign-in, tasks, results, disputes, the rating scan through `getSignaturesForAddress`, the keeper.
5. The conformance scenario through `SolanaAdapter` + `SolanaRpcBackend` on a fresh validator (program preloaded, own mint): settle, both rulings, every timeout, ratings, access control, exact balances, with the real clock.
6. A mainnet RPC was refused by the deploy script (a read-only `genesis-hash` call), and the TypeScript guard is covered by a unit test of `clusterAllowed`.

This covers the scripts, the binary's deployability, the instruction encoding and the adapter on a real validator runtime. It does **not** cover devnet, a long-lived cluster, or Squads.

## 11. SDK, CLI and MCP on Solana

What a buyer or seller does is the same on both families; only the key and the signing differ.

- **Keys.** An EVM key is `0x` hex; a Solana key is the 64-byte secret key of a Solana CLI keypair file (`Uint8Array`; `parseSolanaSecretKey` reads the file's JSON array or a base58 string, `generateSolanaSecretKey` makes one). `hire`, `openHire`, `awaitDelivery`, `settleHire`, `disputeHire`, `createSellerAgent` and `registerCapability` take either, and refuse a key on a chain of the other family before anything happens. With no `chain`, an EVM key trades on `NETWORK` (as before) and a Solana key on Solana devnet.
- **API requests.** The six API clients take a `WalletAccount` (`address` and `signMessage`) instead of viem's `LocalAccount`; viem accounts still fit unchanged. A Solana wallet signs the same `AgentEco:<wallet>:<timestamp>` text with ed25519 and sends it in base58 (`solanaWalletAccount`).
- **Seller.** `createSellerAgent` stays synchronous (its `address` is derived from the key without network access); the Solana signer is built on the first `start()` / `runOnce()`. Selling `tx_explainer` on Solana is refused when the agent is created. ERC-8004 registration and feedback are skipped (the API reports no registries on Solana).
- **CLI.** One key per chain family: `keys/default.json` (EVM) and `keys/default.solana.json` (base58 secret key, mode 0600). `init --chain solana-devnet` creates the Solana key and skips the account link; `hire`, `sell`, `status`, `key address|export --chain …`, `doctor` and the MCP tools work with `solana-devnet`. SOL is shown with 9 decimals (`ChainAdapter.nativeDecimals`). `bootstrap.ts` sets `AGENT_ECO_PROGRAM__…` and `TOKEN_MINT__…` from the API's `GET /chains`; the RPC is the preset's public one unless `RPC_URL__solana_<genesis prefix>` is set. The CLI bundle keeps `@solana/kit` external (a dependency of the package, about 80 ms at start-up).
- **Tests.** `backend/src/sdk.solana.e2e.test.ts` (8 tests: a deal settled with a rating, a dispute the seller answers and the arbiter rules, the staged calls with a handle saved and resumed, a refund when the seller never delivers, a community capability published by one Solana wallet, sold by a second and hired by a third, family mismatches, `tx_explainer`) and `cli/test/solana.e2e.test.ts` (`init`, `status`, `hire` → `job settle|dispute`, `--auto-accept`, the caps, a job resumed after a restart, the MCP tools, `sell`), plus unit tests of the key and account helpers (`agent-runtime/src/sdk/wallet.test.ts`). They run on litesvm, and on a real validator with `SOLANA_LOCAL_VALIDATOR=1`. The in-process chain starts at the wall clock (as anvil does): the SDK seller and the keeper compare chain deadlines with `Date.now()`.

## 12. The website on Solana

`frontend/` offers Solana as a network of its own. Everything the visitor does on it is the code that runs everywhere else: the same `SolanaAdapter` (bundled from `agent-runtime/src`, one copy of `@solana/kit`) reads the program through a JSON-RPC endpoint and the visitor's wallet signs what it builds.

- **Choosing it.** `NEXT_PUBLIC_CHAINS=solana-devnet,…` lists the offered networks (the first is the default); the picker in the top bar remembers the choice and reloads the app. The program id has no default: `NEXT_PUBLIC_AGENT_ECO_PROGRAM__solana_EtWTRABZaYq6iMfeYKouRu166VU2xqa1` is required at build time, the mint (default devnet USDC), `NEXT_PUBLIC_RPC_URL__…`, `NEXT_PUBLIC_RPC_FALLBACK_URLS__…` and `NEXT_PUBLIC_FIRST_ESCROW_ID__…` are optional (`frontend/.env.example`, MULTICHAIN.md §4). The public devnet RPC is rate limited; a production site needs its own endpoint.
- **Wallet.** Through the wallet-standard (`@wallet-standard/app`): Phantom, Solflare and Backpack register themselves with the page. One wallet connects at once, several are offered as a short list, none points to where to get one. The page asks the wallet for `solana:signTransaction` and `solana:signMessage`. The wallet is remembered and reconnects by itself on the next visit.
- **Sign-in.** The first connection asks for one free signature over a CAIP-122-style message (domain, chain, a statement, issued-at and expiry). It becomes a 24 h read session sent as `x-agenteco-session` (`backend/src/session.ts`, `verifySolanaSession`); requests that change something still carry the per-request signed header, as on EVM.
- **Hire.** The agent page's form builds the brief, hashes it, and sends **one** transaction for the wallet to sign: it creates the seller's token account if needed, and creates and funds the escrow. The page then stores the brief with the API, which verifies it against the escrow on the program, and opens the order page.
- **Order page** (`/app/orders/onchain/<id>`): the escrow read together (status, timers on the chain's own clock, fee, hashes), the task and the result checked against the hashes on the program, accept and settle, raise a dispute (a transaction with the reason's hash, then a free signature that saves the reason with the API), the seller's response, the ruling, and the rating (one transaction; the API learns it from the transaction). Balances in the top bar poll every 10 s; a strip points to the faucets while the wallet has no SOL or too little USDC.
- **Register Own Agent** shows how to make a key and run the SDK on Solana (an agent here is a program with its own key, §11); nothing is stored on the page.
- **Not on Solana, and said so on the page**: Create Agent (demo; hosted agents hold their key with AgentEco and run on EVM), activating a hosted agent, linking an agent to an account, the negotiated-order page, and the disputes console (the arbiter is the program's arbiter signer, a wallet or a multisig vault; the AI arbiter and the council console exist for EVM only, so a Solana dispute is raised, answered and shown on its order page and ruled with that signer, outside the website). The order timeline shows no per-stage transaction links on Solana.
- **Test.** `backend/src/frontend.solana.e2e.test.ts`, opt-in with `SOLANA_BROWSER_E2E=1` (about a minute): it builds the site, starts a local `solana-test-validator` with the program, this API on an in-memory Postgres and an SDK seller, and drives headless Chromium (Playwright's `playwright-core`; `CHROMIUM_PATH` if the default is not installed) through connect and sign-in (one prompt, reused after a reload), hire (one transaction prompt, the API's record verified), delivery, accept and settle (1 USDC pays the seller 0.975 after the 2.5 % fee), rating (reputation counters on the program), and a dispute with the seller's answer and the arbiter's refund, then fails on any page error, console error or unexpected failed request. The wallet is a **mock wallet-standard wallet** (`backend/test-support/mockWallet.ts`) that implements the same interface the extensions do and signs with a test key held outside the page. It proves the site's code path, not any extension's own UI. `backend/test-support/solanaBrowserStack.ts` starts the same stack in `next dev` mode for working on the pages. `E2E_SCREENSHOTS=<dir>` keeps a screenshot per step.
- **What this has not shown.** A real wallet extension, a public RPC (rate limits, blockhash expiry under load, priority fees), a mobile browser, or devnet at all.
