# deploy/secrets — provisioning

Everything in this directory except `README.md` and `*.example` is **gitignored**. Each
secret is a single file, mounted read-only into its container (`*_FILE` convention).

> **Permissions — must be `chmod 644`, not 600.** The Rust images run as the unprivileged
> in-image user `syndicate`, whose UID does **not** match the host file owner. A bind-mounted
> `600` file (owner-only) is therefore unreadable inside the container: chain-worker fails with
> `Permission denied (os error 13)`, and game-server fails more obscurely with
> `db connect: ... invalid configuration` (it swallows the read error, then tries to connect
> with no password). Set all four files world-readable:
> ```bash
> chmod 644 deploy/secrets/{postgres-password,operator-keypair.json,price-signer.key,session-signing-key}
> ```
> These files are gitignored and the VPS is single-tenant behind the cloud firewall, so 644 is
> acceptable. If your host is multi-tenant, instead `sudo chown 999:999 deploy/secrets/*`
> (or whatever UID `id syndicate` reports *inside* the container) and keep `640`.

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
