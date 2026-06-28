# Syndicate deployment guides

Copy/paste operator runbooks. Run **in order**:

| Step | Guide | What it does |
|------|--------|--------------|
| 1 | [01_CONTRACT_DEPLOYMENT.md](./01_CONTRACT_DEPLOYMENT.md) | Build + deploy the Syndicate Anchor program on Solana (devnet / testnet / mainnet) and run `initialize_protocol` |
| 2 | [02_VPS_SETUP.md](./02_VPS_SETUP.md) | Prepare a Ubuntu VPS (Docker, firewall, deploy user) |
| 3 | [03_BACKEND_DEPLOYMENT.md](./03_BACKEND_DEPLOYMENT.md) | Clone repo, secrets, Docker Compose, migrations, health checks |
| 4 | [04_DOMAIN_AND_TLS.md](./04_DOMAIN_AND_TLS.md) | DNS, TLS (Caddy), devnet subdomains (`gateway|api|config.devnet.satoshitable.fun`) |

Supporting docs: [env.example](./env.example) · [SECRETS_AND_KEYS.md](./SECRETS_AND_KEYS.md) · [PRODUCTION_DEPLOYMENT_FRAMEWORK.md](./PRODUCTION_DEPLOYMENT_FRAMEWORK.md)

## Quick cluster cheat sheet

| Cluster | Solana RPC | Pyth stack (`PYTH_RECEIVER_STACK`) | Hermes (default) |
|---------|------------|-------------------------------------|------------------|
| **devnet** (recommended staging) | `https://api.devnet.solana.com` | `legacy` | `https://hermes.pyth.network` |
| **testnet** | `https://api.testnet.solana.com` | `legacy` | `https://hermes.pyth.network` |
| **mainnet-beta** | Your provider URL (Helius/Triton/etc.) | `upgraded` | `https://pyth.dourolabs.app/hermes` |

Canonical Pyth program ids live in `services/settlement-chain/pyth-stack.json`. Set `PYTH_RECEIVER_STACK` and optionally override individual `PYTH_*_PROGRAM_ID` vars — see [env.example](./env.example).

## Verified devnet program (team staging)

The repository declares program id **`FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS`** on devnet. Reuse it only if you have the matching upgrade authority keypair; otherwise deploy fresh (guide 01, Step 6).

## Frontend handoff

After backend deploy: give the frontend team [../frontend/INTEGRATION_GUIDE.md](../frontend/INTEGRATION_GUIDE.md), `protocol.ts`, and the IDL at `docs/frontend/idl/syndicate_program.json` (refresh with `./scripts/emit-anchor-idl.sh` on a build host).
