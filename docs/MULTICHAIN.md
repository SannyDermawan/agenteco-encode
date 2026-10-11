# Multi-chain

Status: **implemented for EVM chains** (BSC Testnet, BOT Chain, Base Sepolia presets). Solana: the escrow program and `SolanaAdapter` are built and tested locally ([SOLANA.md](SOLANA.md)); not deployed, not wired into the backend, API, SDK or frontend. Back to the [README](../README.md).

One backend, one database and one SDK run the same escrow, dispute and reputation flow on several chains at once. With no new settings, everything behaves exactly as the single-chain BNB version did.

## 1. What was single-chain, and what replaced it

| Before | Now |
|---|---|
| `network.ts` exported the contract, token, RPC and explorer of one `NETWORK` as module constants | `ChainRegistry` (`agent-runtime/src/chain/registry.ts`): any number of chains, each an `EvmChainConfig`; `NETWORK` stays the primary chain |
| Escrow logic called viem directly in ~20 files | `ChainAdapter` interface, `EvmAdapter` implementation; business logic calls the adapter |
| `escrowId` unique on its own | unique per `(chainId, escrowId)` |
| 18 decimals assumed | the token's own `decimals()` (tested with a 6-decimal token) |
| one keeper / host loop | one loop per served chain; a failing chain does not stop the others |

## 2. Chain identity

Every chain is a [CAIP-2](https://chainagnostic.org/CAIPs/caip-2) id. Network names, aliases and bare EVM chain ids are accepted wherever a chain is named.

| Chain | `chainId` | names |
|---|---|---|
| BSC Testnet | `eip155:97` | `bsc-testnet`, `97` |
| BOT Chain Testnet / Mainnet | `eip155:968` / `eip155:677` | `bot-testnet` (`testnet`) / `bot-mainnet` (`mainnet`) |
| Base Sepolia | `eip155:84532` | `base-sepolia`, `84532` |
| Solana devnet (adapter only, not served) | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (genesis-hash prefix) | — (the registry does not know it yet) |

## 3. `ChainAdapter`

The chain-neutral surface, in `agent-runtime/src/chain/types.ts`:

```ts
type ChainId = string // CAIP-2
type EscrowId = bigint // a uint256 on EVM chains, a u64 on Solana: both fit

interface ChainAdapter {
  readonly chainId: ChainId
  readonly family: 'evm' | 'solana'
  readonly signer: string | null // the wallet that signs writes; null = read-only adapter
  readonly nativeSymbol: string
  readonly explorer: { name: string; txUrl(hash: string): string; addressUrl(address: string): string }

  normalizeAddress(address: string): string // EVM: lowercase hex; Solana: base58 as is
  isValidAddress(address: string): boolean
  verifySignature(p: { address: string; message: string; signature: string }): Promise<boolean> // EVM: EIP-191; Solana: ed25519, base58
  token(): Promise<{ address: string; symbol: string; decimals: number }>
  head(): Promise<bigint>
  nativeBalance(address: string): Promise<bigint>
  tokenBalance(address: string): Promise<bigint>

  // writes (need a signer)
  createAndFundEscrow(p: { seller: string; amount: number | string; taskHash: Hash32 }): Promise<EscrowId>
  startExecution(id: EscrowId): Promise<void>
  markDelivered(id: EscrowId, resultHash: Hash32): Promise<void>
  acceptAndSettle(id: EscrowId): Promise<void>
  raiseDispute(id: EscrowId, reasonHash: Hash32): Promise<TxHash>
  submitDisputeResponse(id: EscrowId, responseHash: Hash32): Promise<TxHash>
  rateSeller(id: EscrowId, score: number): Promise<TxHash>
  resolveDispute(id: EscrowId, toSeller: boolean, rationaleHash: Hash32): Promise<TxHash> // arbiter wallet
  ruleDispute(id: EscrowId, toSeller: boolean, rationaleHash: Hash32): Promise<RulingOutcome> // wallet or council vote
  claimTimeout(id: EscrowId, action: TimeoutAction, hooks?: TimeoutClaimHooks): Promise<TimeoutClaim> // permissionless, simulated first
  transferToken(to: string, amount: bigint): Promise<TxHash>
  sweepNative(to: string): Promise<TxHash | null>

  // reads
  getEscrowBasic(id: EscrowId): Promise<EscrowBasic>
  getEscrowStatus(id: EscrowId): Promise<number>
  getResultHash(id: EscrowId): Promise<Hash32>
  getEscrowHashes(id: EscrowId): Promise<EscrowHashes>
  getEscrowTimestamps(id: EscrowId): Promise<EscrowTimestamps>
  getEscrowWindows(id: EscrowId): Promise<EscrowWindows>
  getEscrowDisputeInfo(id: EscrowId): Promise<EscrowDisputeInfo>
  readTimeoutFlag(id: EscrowId, flag: TimeoutFlag): Promise<boolean>
  getArbiterSetup(id?: EscrowId): Promise<ArbiterSetup>
  escrowIds(opts?: { currentOnly?: boolean }): Promise<EscrowId[]>
  readEscrowBasics(ids: EscrowId[]): Promise<EscrowBasic[]>
  listEscrows(opts?: { currentOnly?: boolean }): Promise<EscrowBasic[]>
  getReputation(seller: string): Promise<OnchainReputation>
  timerLimits(): Promise<TimerLimits>
  ratingsInTx(txHash: string): Promise<RatingEvent[]>
  ratings(fromBlock: bigint, toBlock: bigint): Promise<RatingEvent[]>
}
```

`TxHash` is a `string`: an EVM transaction hash or a Solana signature. Status codes are the contract's state machine, in order: `CREATED, FUNDED, EXECUTING, DELIVERED, DISPUTED, SETTLED, REFUNDED`. Amounts are base units; `createAndFundEscrow` takes a decimal amount and converts it with the token's real decimals. Hashes stay keccak256 of the committed preimage (`agent-runtime/src/shared/hashes.ts`) on every chain.

Rules: no chain-specific branching outside adapters; signing keys are handed to an adapter, never read from `process.env` inside it.

**`EvmAdapter`** (`chain/evm.ts`, viem) holds all escrow, arbiter-council, escrow-index, keeper, reputation, token and rating-event logic, plus ERC-8004 (section 6). It has no module state: the deployment comes in as an `EvmChainConfig`, the wallet as `EvmClients`. The older helpers (`onchain/escrow.ts`, `arbiter.ts`, `escrowIndex.ts`, `host/reputation.ts`) remain as thin wrappers over the primary chain, with unchanged signatures.

**`SolanaAdapter`** (`chain/solana.ts`, `@solana/kit` over the Anchor program in `solana/`): implements the whole interface with the same state machine, `u64` ids, SPL token accounts, ed25519 `verifySignature`, base58 addresses and rating events. It runs behind a `SolanaBackend`: litesvm in tests, `SolanaRpcBackend` (`chain/solana-rpc.ts`) for a cluster. One conformance scenario runs on `EvmAdapter` and on `SolanaAdapter` (litesvm, and a local validator). Not done: registry and backend wiring, any run on devnet, a council program (a Squads vault is the decided arbiter). Details and limits in [SOLANA.md](SOLANA.md).

## 4. Configuration

### Backend and runtime

```
NETWORK=bsc-testnet                      # the primary chain; unsuffixed settings are its, as before
CHAINS=bsc-testnet,base-sepolia          # served chains, the default first; empty = NETWORK alone
AGENT_ECO_ADDRESS__eip155_84532=0x…      # every other chain: same setting names + CAIP-2 suffix
DEPLOYMENT_BLOCK__eip155_84532=…
# optional per chain: RPC_URL__…, RPC_FALLBACK_URLS__…, USDT_ADDRESS__…, LOG_RANGE_BLOCKS__…,
# HOSTED_MIN_GAS__…, LOW_GAS_WARN__…, ERC8004_IDENTITY_REGISTRY__…, ERC8004_REPUTATION_REGISTRY__…
```

The suffix is the CAIP-2 id with the colon as an underscore. A served chain without a deployment address, or an RPC that reports another chain id, stops the process at startup. Escrow timers (`EXECUTION_WINDOW_SECONDS`, …) are shared and checked against every chain's contract.

### Frontend

```
NEXT_PUBLIC_NETWORK=bsc-testnet                          # primary; unsuffixed NEXT_PUBLIC_* are its
NEXT_PUBLIC_CHAINS=bsc-testnet,base-sepolia              # offered networks, the default first
NEXT_PUBLIC_AGENT_ECO_ADDRESS__eip155_84532=0x…
NEXT_PUBLIC_DEPLOY_BLOCK__eip155_84532=…
```

Read at build time; the build fails if an offered network lacks its deployment. With more than one network, the top bar shows a picker: the choice is remembered in the browser and the app reloads on it. Every API call names the selected chain (`lib/api/base.ts`). The `/app` pages render in the browser only, so they never disagree with a server render; the landing page always describes the default network (`lib/web3/landingNetwork.ts`).

### Base Sepolia

Preset values were checked against the public RPC: chain id 84532, Circle's test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals), Multicall3 present. PublicNode is the primary RPC because `sepolia.base.org` limits `eth_getLogs` to 200 blocks; it stays as the fallback. Deploy with the existing script:

```
USDT_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e FIRST_ESCROW_ID=1 \
forge script script/DeployV3.s.sol --rpc-url base_sepolia --broadcast
```

then set `AGENT_ECO_ADDRESS__eip155_84532` / `DEPLOYMENT_BLOCK__eip155_84532` (and the `NEXT_PUBLIC_…` pair).

## 5. Database and API

New database, created with a plain `prisma db push` (no data is carried over from BNB).

| Model | Change |
|---|---|
| `Agent` | `chainId`, `groupId?`, `erc8004AgentId?`; one row per agent **per chain** |
| `Negotiation`, `Order` | `chainId` (order unique per `(chainId, escrowId)`) |
| `Task`, `EscrowResult`, `Verification`, `Rating`, `Dispute` | `chainId`; unique per `(chainId, escrowId)` |
| `Rating` | `erc8004FeedbackTx?` |
| `Capability`, `Report`, `Appeal`, `ModerationVote`, `AiCall` | unchanged |

`groupId` links one owner's listings of the same agent across chains (any UUID the owner sets); there is deliberately no `agent_chains` table yet. For a database that ever imports BSC Testnet data, the backfill value is `eip155:97`.

**API.** Every escrow-keyed route names its chain with `?chain=` (or `chainId` in a JSON body); without one it means the default chain, so older clients keep working. An unknown or unserved chain is a 400, never a silent fallback. Listings (`GET /agents`), orders, negotiations and the arbiter's dispute list accept `?chain=` as a filter. `GET /chains` lists the served chains with contract, token, explorer and ERC-8004 registries. A buyer and a seller on different chains cannot open a negotiation. Website sign-ins may be signed on any served chain. Listing moderation is one council for all chains: the default chain's.

**SDK.** `hire({ chain })` buys only from sellers on that chain; `createSellerAgent({ chain })` trades on it (an attached listing brings its own chain). Omitted: an attached listing's chain, else `NETWORK`.

**Local database.** `npm run db:local` (backend) runs an embedded Postgres (PGlite) on port 54330 with its data in `backend/.pglite` (gitignored); with `DATABASE_URL`/`DIRECT_URL` at `postgresql://postgres:postgres@127.0.0.1:54330/postgres?sslmode=disable` (the generated `backend/.env` has them), `npm run db:local:init` creates the schema. Prisma's own `db push` cannot talk to PGlite, so the script applies the SQL `prisma migrate diff` generates for the same schema; for the online database (Supabase) a plain `npx prisma db push` stays the way. PGlite serves one connection at a time: the tests set `DB_POOL_MAX=1`, which `src/db.ts` honours.

## 6. Identity and reputation: ERC-8004

[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) (status: Draft) defines per-chain Identity, Reputation and Validation registries. Their addresses are not in the EIP, so each chain has them configured: the presets carry the official ones for BSC Testnet and Base Sepolia, and `ERC8004_IDENTITY_REGISTRY` / `ERC8004_REPUTATION_REGISTRY` (both or neither, suffixed per chain) override them. A chain with none known has no ERC-8004 features.

| Chain | Identity Registry | Reputation Registry |
|---|---|---|
| BSC Testnet, Base Sepolia | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

Checked on both chains on 10 Oct 2026: both contracts exist (proxies), the Reputation Registry's `getIdentityRegistry()` returns the Identity address, and the Identity Registry answers `name()` = `AgentIdentity`, `symbol()` = `AGENT`.

**Identity.**
- Every seller listing has a registration file at `GET /agents/:id/registration.json` (type `…#registration-v1`, services, `active`, `registrations`, `supportedTrust: ["reputation"]`). It needs `PUBLIC_API_URL` to be stable.
- A hosted seller's host registers it once (`register(agentURI)`) from the agent's own wallet, which then owns the identity.
- A self-hosted seller registers with `createSellerAgent({ erc8004: true })`, then reports the transaction to `POST /agents/:id/erc8004`. The API trusts nothing but the hash: the `Registered` event must come from that chain's Identity Registry, be owned by the agent's wallet (or its owner), and point at this listing's registration file.
- `setAgentWallet` (EIP-712) is not used: the agent wallet is the identity's owner.

**Reputation.** After a deal is settled and rated, the **buyer's wallet** calls `giveFeedback`:

| Field | Value |
|---|---|
| `value`, `valueDecimals` | the rating, 1–100 (stars × 20, the number `rateSeller` stores), decimals `0` |
| `tag1` | the capability id |
| `tag2` | `agenteco:<chainId>:<escrowId>` |
| `endpoint`, `feedbackURI`, `feedbackHash` | empty |

Hosted buyers do it automatically; `hire()` does it unless `erc8004Feedback: false`. Ratings between two agents of one owner are never published (and the registry refuses the agent's own owner anyway). Each deal is published once; the transaction is kept on the rating.

**Possible later:** the AgentEco contract publishing feedback itself (only paid escrows could then produce it — needs a contract change); the Validation Registry for AI verification scores and council rulings (0–100).

AgentEco's own on-chain reputation stays the ranking source inside AgentEco; ERC-8004 is the portable, public copy.

## 7. Testing

All on-chain suites run on throwaway local chains (anvil) with the real contracts from `out/` (`forge build`) and skip themselves when anvil or the build output is missing. Database suites run on an in-memory Postgres (PGlite) with the Prisma schema.

- **Regression:** `agent-runtime/src/onchain/escrow.chain.test.ts` and `backend/src/keeper/escrowKeeper.chain.test.ts` were written against the single-chain code before any refactor and pass unchanged: the whole escrow lifecycle, wallet-arbiter and council rulings, the escrow index, every keeper timeout, on-chain reputation. The original suites (forge 97, backend 76, agent-runtime 53) are unchanged.
- **Adapter and registry:** `chain/evm.test.ts` (explicit config, two deployments on one chain), `chain/default.test.ts` (the primary chain matches `network.ts`), `chain/registry.test.ts` (`CHAINS`, suffixes, aliases, fail-fast), `chain/erc8004.test.ts` (registration, feedback, owner refused).
- **Schema:** `backend/src/db.schema.test.ts` — the same escrow id on two chains, every escrow-keyed table unique per `(chain_id, escrow_id)`.
- **End to end:** `backend/src/multichain.e2e.test.ts` — the API serving two local chains (chain id 97 with an 18-decimal token, 84532 with a 6-decimal token): escrow #1 on both without mixing, access per chain, disputes per chain arbiter, ratings read from the right chain, cross-chain negotiation refused, ERC-8004 registration checks and deal feedback.
- Test-only ERC-8004 registries: `test/mocks/ERC8004Registries.sol` (implements just what AgentEco calls; not the reference implementation).

## 8. Local setup pitfall: `npm ci` in `frontend/`

`frontend/package.json` has a `postinstall` that runs `npm install --prefix ../agent-runtime --omit=dev` (the app imports the SDK's sources). That **removes agent-runtime's devDependencies** (`tsx`, `typescript`), so afterwards `npm test` in `agent-runtime` fails with `Cannot find package 'tsx'` for every test file. The same happens when the packages are installed in parallel and the frontend finishes last. After installing the frontend, run `npm ci` in `agent-runtime` again (and, if `agent-runtime/package-lock.json` shows a four-line metadata change from npm 11, `git checkout` it). The backend and the standalone agents are not affected.

## 9. Work order

1. `ChainAdapter` and `EvmAdapter` with no behaviour change. **Done.**
2. `chainId` in the schema, every query scoped by it, `groupId`. **Done.**
3. Chain registry in backend, runtime and frontend; chain picker; `chain` in the SDK. **Done.**
4. ERC-8004 identity and feedback on EVM chains. **Done** (registries per chain by configuration).
5. Base Sepolia: preset, 6-decimal handling, deploy command. **Done in code**; the contract is not deployed yet.
6. `SolanaAdapter` and the Anchor program. **Built and tested locally** (litesvm and a local validator); **not deployed and not wired** ([SOLANA.md](SOLANA.md) §9).

## 10. Open questions

- The council on Solana is a Squads multisig vault as the program's one arbiter signer; the vault-signed ruling is not tested ([SOLANA.md](SOLANA.md) §4).
