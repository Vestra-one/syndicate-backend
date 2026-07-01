# Syndicate deployment guides

Copy/paste operator runbooks. Run **in order**:

| Step | Guide | What it does |
|------|--------|--------------|
| 1 | [01_CONTRACT_DEPLOYMENT.md](./01_CONTRACT_DEPLOYMENT.md) | Build + deploy the Syndicate Anchor program on Solana (devnet / testnet / mainnet) and run `initialize_protocol` |
| 2 | [02_VPS_SETUP.md](./02_VPS_SETUP.md) | Prepare a Ubuntu VPS (Docker, firewall, deploy user) |
| 3 | [03_BACKEND_DEPLOYMENT.md](./03_BACKEND_DEPLOYMENT.md) | Clone repo, secrets, Docker Compose, migrations (0001–0007), health checks — start with **First-time run (checklist)** in that guide |
| 4 | [04_DOMAIN_AND_TLS.md](./04_DOMAIN_AND_TLS.md) | DNS, TLS (Caddy), devnet subdomains (`gateway|api|config.devnet.satoshitable.fun`) |

Supporting docs: [env.example](./env.example) · [SECRETS_AND_KEYS.md](./SECRETS_AND_KEYS.md) · [PRODUCTION_DEPLOYMENT_FRAMEWORK.md](./PRODUCTION_DEPLOYMENT_FRAMEWORK.md)

## v1 oracle: signed-price-server (NOT Pyth)

v1 settlement does **not** use Pyth. The contract verifies a **company-signed price**
(secp256k1 / EIP-191) against `ProtocolState.price_signer` — a 20-byte Ethereum address set at
`initialize_protocol`. The price comes from the Go **`services/signed-price-server`**, reached by
`settlement-chain` via `SIGNED_PRICE_SERVER_URL`. There is no on-chain Pyth receiver
(`pyth_receiver.rs` was removed in Task 6). Any `PYTH_*` env vars that remain are legacy scaffolding
the Node/Rust services still parse at boot but no longer drive settlement — see
[env.example](./env.example) and `docs/V1_COMPLETION_CHECKLIST.md`.

## Quick cluster cheat sheet

| Cluster | Solana RPC | Signed-price feed (devnet default) |
|---------|------------|-------------------------------------|
| **devnet** (recommended staging) | `https://api.devnet.solana.com` | Coinbase `book_mid` for `SOLUSD`/`BTCUSD`/`ETHUSD` (`services/signed-price-server/config/devnet.toml`) |
| **testnet** | `https://api.testnet.solana.com` | same |
| **mainnet-beta** | Your provider URL (Helius/Triton/etc.) | production signed-price-server + production signer key |

## Verified devnet program (team staging)

The repository declares program id **`8D2Wt3pLyoS8wLaTb3mcnC5WVja6xYMoumNqG2yZs1qX`** on all
clusters (`services/programs/Anchor.toml`, `declare_id!` in `lib.rs`). The live devnet protocol
state PDA is **`EDwcfo4UjFp3kEwz9CqEAv2iojKinzaAmPLNLeZiAkXS`**. Reuse the program only if you hold
the matching upgrade authority keypair; otherwise deploy fresh (guide 01).

## Frontend handoff

After backend deploy: give the frontend team [../frontend/INTEGRATION_GUIDE.md](../frontend/INTEGRATION_GUIDE.md), `protocol.ts`, and the IDL at `docs/frontend/idl/syndicate_program.json` (refresh with `./scripts/emit-anchor-idl.sh` on a build host).
