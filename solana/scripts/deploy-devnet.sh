#!/usr/bin/env bash
# Build, test and deploy the agenteco_escrow program to Solana devnet (docs/SOLANA.md §9).
# It only ever talks to devnet (or a local validator, for rehearsals): any other cluster is refused.
#
#   KEYPAIR=~/.config/solana/devnet-deployer.json solana/scripts/deploy-devnet.sh
#
# Environment:
#   KEYPAIR          the fee payer / upgrade authority (default ~/.config/solana/id.json); read by the Solana CLI only
#   RPC_URL          default https://api.devnet.solana.com
#   PROGRAM_KEYPAIR  the program's own keypair (default solana/target/deploy/agenteco_escrow-keypair.json);
#                    its address must equal declare_id! in lib.rs, see `anchor keys sync`
#   SKIP_TESTS=1     do not run the litesvm tests first
#   DRY_RUN=1        run every check, print the deploy command, do not send it
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYPAIR="${KEYPAIR:-$HOME/.config/solana/id.json}"
RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
PROGRAM_KEYPAIR="${PROGRAM_KEYPAIR:-$ROOT/target/deploy/agenteco_escrow-keypair.json}"
SO="$ROOT/target/deploy/agenteco_escrow.so"
DEVNET_GENESIS_PREFIX="EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
TESTNET_GENESIS="4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"

die() { echo "error: $*" >&2; exit 1; }
command -v solana >/dev/null || die "the Solana CLI is not installed (see docs/SOLANA.md §1)"
command -v cargo >/dev/null || die "cargo is not installed"
[ -f "$KEYPAIR" ] || die "no keypair at $KEYPAIR (solana-keygen new -o ... for a devnet-only key)"

genesis="$(solana genesis-hash --url "$RPC_URL")" || die "cannot reach $RPC_URL"
host="${RPC_URL#*://}"; host="${host%%[:/]*}"
case "$genesis" in
  "$DEVNET_GENESIS_PREFIX"*|"$TESTNET_GENESIS") ;;
  *) case "$host" in 127.0.0.1|localhost) ;; *) die "$RPC_URL is not Solana devnet, testnet or a local validator (genesis $genesis): refusing" ;; esac ;;
esac

declared="$(sed -n 's/.*declare_id!("\([1-9A-HJ-NP-Za-km-z]*\)").*/\1/p' "$ROOT/programs/agenteco_escrow/src/lib.rs" | head -n1)"
[ -f "$PROGRAM_KEYPAIR" ] || die "no program keypair at $PROGRAM_KEYPAIR (solana-keygen new -o it, then \`anchor keys sync\` in solana/)"
actual="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
[ "$declared" = "$actual" ] || die "declare_id! is $declared but the program keypair is $actual: run \`anchor keys sync\` in solana/"

echo "building (SBPF v0, the same bytecode the tests run)"
(cd "$ROOT/programs/agenteco_escrow" && cargo build-sbf --arch v0)
if [ -z "${SKIP_TESTS:-}" ]; then
  echo "testing"
  (cd "$ROOT/programs/agenteco_escrow" && cargo test)
fi

payer="$(solana-keygen pubkey "$KEYPAIR")"
balance="$(solana balance "$payer" --url "$RPC_URL" --lamports | awk '{print $1}')"
echo "deployer $payer holds $balance lamports on $RPC_URL; program $declared"

cmd=(solana program deploy "$SO" --program-id "$PROGRAM_KEYPAIR" --keypair "$KEYPAIR" --url "$RPC_URL")
if [ -n "${DRY_RUN:-}" ]; then
  echo "dry run, would run: ${cmd[*]}"
  exit 0
fi
"${cmd[@]}"
echo "deployed. Next, once: cd agent-runtime && npx tsx scripts/solana-initialize.ts --keypair $KEYPAIR --mint <token> --arbiter <address> --treasury <address>"
