# Syndicate Secrets And Key Management

**Status:** Phase 8 launch runbook.

This runbook applies to bare-metal/VPS deployment on Netcup or Hetzner.

## Rules

- Never commit `.env`, keypairs, API keys, RPC credentials, multisig recovery material, or operator SSH private keys.
- Store host environment files under `/etc/syndicate/` with owner `root:syndicate` and mode `0640`.
- Store deployment secrets encrypted at rest using `sops`, `age`, or Ansible Vault.
- Use separate keys for localnet, devnet, and mainnet. A localnet/devnet key must never become a mainnet authority.
- No single personal wallet should control a mainnet authority role.
- Mainnet upgrade, pause, fee, settlement-admin, emergency-void, config, and treasury authorities must be multisig-controlled.

## Secret Classes

| Secret | Environment | Storage | Rotation |
|---|---|---|---|
| Signed-price-server signing key (`ECDSA_PRIVATE_KEY`) | devnet/mainnet | signed-price-server host secrets only; address must equal on-chain `price_signer` | on suspected exposure or signer rotation (then `set_price_signer`) |
| Pyth API key (`PYTH_API_KEY`) | devnet/mainnet | `/etc/syndicate/settlement-worker.env` | vestigial boot requirement only — not used for v1 settlement; any non-empty value |
| Solana RPC credentials | devnet/mainnet | `/etc/syndicate/settlement-worker.env` | 90 days or provider incident |
| Settlement-chain internal auth token | devnet/mainnet | `/etc/syndicate/settlement-chain.token`, mode `0640` | before mainnet and on host change |
| Hot settlement/void signer keypair | devnet/mainnet | `/etc/syndicate/settlement-admin-keypair.json`, mode `0640`, root/syndicate only | on operator change or suspected exposure |
| Program authority keys | devnet/mainnet | multisig custody, never service host plaintext | signer rotation ceremony |
| Postgres password | all | `/etc/syndicate/postgres.env` | before public launch and on staff change |
| Redis/NATS credentials | devnet/mainnet | `/etc/syndicate/*.env` | before public launch and on staff change |
| MinIO/object-store credentials | all | `/etc/syndicate/object-store.env` | before public launch and on staff change |

## Host Setup

```bash
sudo groupadd --system syndicate || true
sudo install -d -o root -g syndicate -m 0750 /etc/syndicate
sudo install -d -o syndicate -g syndicate -m 0750 /var/lib/syndicate
sudo install -d -o syndicate -g syndicate -m 0750 /var/log/syndicate
```

Create one env file per service, for example:

```bash
sudo install -o root -g syndicate -m 0640 /dev/null /etc/syndicate/action-feed.env
```

Use `docs/deployment/env.example` as a schema only. Replace every `REPLACE_WITH_*` value before devnet or mainnet.

Settlement automation no longer uses a prepared transaction JSON bundle. The Rust worker talks to the localhost-only `settlement-chain` adapter with `SETTLEMENT_CHAIN_AUTH_TOKEN_FILE`; the adapter reads the scoped hot settlement/void signer from `SETTLEMENT_SIGNER_KEYPAIR_PATH`, fetches the **company-signed price** from `services/signed-price-server` (secp256k1 / EIP-191) via `SIGNED_PRICE_SERVER_URL`, builds transactions at runtime, simulates, submits, confirms, and returns receipts for persistence.

The decisive oracle secret is the signed-price-server's `ECDSA_PRIVATE_KEY`: its Ethereum address must equal the on-chain `ProtocolState.price_signer` (set at `initialize_protocol`, rotatable with `set_price_signer`). `PYTH_API_KEY` is **not** part of the v1 settlement path — it remains only because the worker still reads it at boot; set any non-empty value and do not treat it as oracle-critical.

## Mainnet Authority Ceremony

1. Freeze the release tag and record the commit hash.
2. Build program artifacts from a clean checkout.
3. Record the program binary hash.
4. Confirm multisig membership for each role.
5. Confirm the timelock delay and emergency action process.
6. Execute deployment or upgrade from multisig.
7. Publish program id, config hash, feed ids, and audit links.
8. Revoke any bootstrap authority that is not needed post-launch.

## Incident Rotation

Rotate immediately when:

- A laptop or host containing secrets is lost.
- A provider dashboard account is compromised.
- A relayer signs an unexpected transaction.
- A mainnet multisig signer leaves the trusted operator set.
- A secret is printed into logs or copied into a ticket/chat.
- A third-party API key is pasted into chat or any non-secret collaboration channel.

After rotation, run the localnet/devnet smoke path before resuming mainnet traffic.
