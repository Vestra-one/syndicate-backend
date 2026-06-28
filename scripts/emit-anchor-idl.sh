#!/usr/bin/env bash
# Emit Anchor IDL on the deploy host (requires Solana + Anchor toolchain).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/services/programs"
anchor build
mkdir -p "$ROOT/docs/frontend/idl"
cp target/idl/syndicate_program.json "$ROOT/docs/frontend/idl/syndicate_program.json"
echo "IDL written to docs/frontend/idl/syndicate_program.json"
