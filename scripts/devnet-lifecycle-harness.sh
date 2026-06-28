#!/usr/bin/env bash
#
# Runs the Solana Devnet custody lifecycle harness.
# Required: services/devnet-harness dependencies installed with `npm install`.
# Optional: set PYTH_API_KEY to execute the Hermes -> Pyth Receiver ->
# submit_settlement -> claim path in addition to the default void/refund lifecycle.
set -euo pipefail
cd "$(dirname "$0")/.."

node services/devnet-harness/src/lifecycle.mjs
