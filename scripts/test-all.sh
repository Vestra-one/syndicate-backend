#!/usr/bin/env bash
# Run every test suite: host workspace, contract (litesvm), and lint gates.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== workspace tests =="
cargo test --workspace

echo "== clippy (v2 crates) =="
cargo clippy -p syndicate-chain -p syndicate-chain-worker -p syndicate-game-server

echo "== contract check =="
(cd services/programs && cargo check -p syndicate-program)

echo "== litesvm suite (requires cargo build-sbf first) =="
if [ -f services/programs/target/deploy/syndicate_program.so ]; then
  (cd services/programs/litesvm-tests && cargo test)
else
  echo "skipped: services/programs/target/deploy/syndicate_program.so not built"
  echo "         run: cd services/programs && cargo build-sbf --tools-version v1.53 -- -p syndicate-program"
fi

echo "all green"
