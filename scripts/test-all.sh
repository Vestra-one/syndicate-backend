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
echo "   (config, matchmaking, action-feed, gateway, trust-safety)"
node --experimental-strip-types --test $(find services -name '*.test.ts' | sort)

echo
echo "NOTE: the on-chain program is built + tested in the Solana CI:"
echo "      (cd services/programs && anchor build && anchor test)   # reproduces golden/ vectors"
echo
echo "ALL LOCAL SUITES PASSED"
