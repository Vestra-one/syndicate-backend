# deploy/secrets — provisioning

Everything in this directory except `README.md` and `*.example` is **gitignored**. Each
secret is a single file, mounted read-only into its container (`*_FILE` convention),
`chmod 600`.

| File | Used by | How to generate |
|---|---|---|
| `postgres-password` | postgres, db-migrate, game-server, chain-worker | `openssl rand -hex 24 > postgres-password` |
| `operator-keypair.json` | chain-worker | `solana-keygen new --no-bip39-passphrase -o operator-keypair.json` — fund with SOL; grant it the settlement/config/emergency-void/treasury roles at `initialize_protocol` |
| `price-signer.key` | signed-price-server | 32-byte secp256k1 secret, hex: `openssl rand -hex 32 > price-signer.key`. Register its Ethereum address on-chain via `set_price_signer` |
| `session-signing-key` | game-server | `openssl rand -hex 32 > session-signing-key` |

## Rotation

- **Price key**: generate a new key → `cargo run -p syndicate-chain --features rpc --bin init-protocol -- set-price-signer <new-eth-address>` (config_admin) → swap the file → restart `signed-price-server`.
- **Operator keypair**: fund the new key → rotate the on-chain roles (protocol_admin) → swap the file → restart `chain-worker`. Never delete the old key until in-flight matches settle.
- **Postgres password**: `ALTER USER syndicate PASSWORD ...` → update file → restart dependents.
- **Session key**: swap the file → restart `game-server` (players re-authenticate; on-chain funds unaffected).
