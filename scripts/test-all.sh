#!/usr/bin/env bash
#
# Runs every locally-verifiable suite for the Syndicate backend.
# The on-chain Anchor program builds + tests in the Solana CI (needs the Solana
# platform toolchain); that job is invoked separately (see .github/workflows/ci.yml).
#
# In restricted dev environments where the working dir rejects cargo's temp-file ops,
# point the build target off-mount:  CARGO_TARGET_DIR=$HOME/syndicate-target ./scripts/test-all.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CARGO_TARGET_DIR:=target}"
export CARGO_TARGET_DIR

echo "== Rust workspace =="
echo "   (deterministic core + on-chain verify + match-engine + oracle + time-lock + settlement + e2e/parity)"
cargo test --workspace

echo
echo "== TypeScript edge/read-path services =="
echo "   (config, matchmaking, action-feed, gateway, trust-safety, settlement-chain, devnet harness)"
node_tests=()
while IFS= read -r test_file; do
  node_tests+=("$test_file")
done < <(
  find services \
    -path '*/node_modules' -prune -o \
    \( -path '*/test/*.test.ts' -o -path '*/test/*.test.mjs' \) \
    -type f -print | sort
)
if [[ ${#node_tests[@]} -eq 0 ]]; then
  echo "no TypeScript/JavaScript test files found" >&2
  exit 1
fi
node --experimental-strip-types --test "${node_tests[@]}"

echo
echo "NOTE: the on-chain program is built + tested in the Solana CI:"
echo "      (cd services/programs && anchor build && anchor test)   # reproduces golden/ vectors"
echo
echo "ALL LOCAL SUITES PASSED"
