# Syndicate Signed Price Server

High-performance cryptocurrency price signing and streaming service copied into the Syndicate monorepo. This copy is the only version used by Syndicate backend and contract integration work; do not edit the original Ryze repository for Syndicate changes.

## Features

- **Real-time Exchange Data**: Syndicate devnet uses Coinbase `book_mid` for `SOLUSD`, `BTCUSD`, and `ETHUSD`, signing mid-price on a short heartbeat while the book is fresh (see `[book_mid]` in `config/devnet.toml`).
- **Exact-second archive**: Every signed price is persisted into SQLite by `(symbol, timestamp_sec)`. If multiple signed prices land in the same second, the row keeps the latest payload timestamp, then latest `signed_at` as tie-breaker.
- **Book staleness gate**: If no BBO WebSocket update arrives within `max_book_age_ms` (default 10s), signing pauses for that symbol until the feed recovers (auto-resume). Status is exposed on `/health` (`book_mid`, `book_mid_ok`; top-level `ok` is false when book_mid is unhealthy) and Prometheus — not on the price WebSocket stream.
- **Exchange WS metrics**: Prometheus `provider_ws_connected` and `provider_ws_last_message_seconds` per provider for feed debugging.
- **Client stream stability**: Large per-client send buffers with coalesce-to-latest on backpressure (connections are not dropped for slow consumers).
- **ECDSA Signing**: Signs every price update using secp256k1 curve (ethereum compatible)
- **High Performance**: Worker pool architecture with concurrent signing
- **Symbol Filtering**: Clients can subscribe to specific trading pairs
- **Metrics**: Prometheus metrics for monitoring latency and throughput

## Architecture

```
Coinbase WebSocket -> Book Mid Emitter -> Worker Pool -> Signed Prices -> WebSocket Hub -> Clients
                                                          |
                                                          v
                                             Store (Latest Cache + SQLite Seconds)
```

### Components

1. **Provider**: Connects to Binance WebSocket and receives trade events
2. **Signing**: Worker pool that signs trades using ECDSA private key
3. **Store**: Ring buffer for history + sync.Map for latest prices
4. **Stream**: WebSocket hub with pub/sub pattern for client connections
5. **API**: HTTP server with WebSocket upgrade and REST endpoints

## Quick Start

### Prerequisites

- Go 1.24+
- ECDSA private key (secp256k1)

### Installation

```bash
# Install dependencies
make install
```

### Generate Private Key

```bash
# Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Or use an existing Ethereum wallet private key (without 0x prefix)
```

### Run

```bash
# Set private key environment variable
export ECDSA_PRIVATE_KEY=0xfb145a6fda5b798284b6edcfc3e2a6eff86f19fcc306e6edc2345ea1772b50c2

# Run the Syndicate devnet config
CONFIG_PATH=config/devnet.toml make run

# Or build and run binary
make build
CONFIG_PATH=config/devnet.toml ./bin/price-bot
```

## API Endpoints

### WebSocket Streaming

```bash
# Connect to WebSocket (all symbols)
ws://localhost:8080/ws

# Connect with symbol filter
ws://localhost:8080/ws?symbols=BTCUSD,ETHUSD
```

**Dynamic Subscription:**
```json
// Subscribe to symbols
{"action": "subscribe", "symbols": ["BTCUSD", "ETHUSD"]}

// Unsubscribe from symbols
{"action": "unsubscribe", "symbols": ["BTCUSD"]}
```

### REST API

**Get Latest Prices (all symbols):**
```bash
curl http://localhost:8080/prices
```

**Get Latest Prices (specific symbols):**
```bash
curl http://localhost:8080/prices?symbols=BTCUSD,ETHUSD
```

**Get Exact Signed Price For Settlement:**
```bash
curl 'http://localhost:8080/prices/at?symbol=BTCUSD&timestamp=1715000000'
```

**Health Check:**
```bash
curl http://localhost:8080/health
```

## Configuration

Configuration is loaded from `CONFIG_PATH` or `config/config.toml`. For Syndicate devnet:

```bash
export ECDSA_PRIVATE_KEY=<secp256k1-private-key>
export CONFIG_PATH=config/devnet.toml
go run ./cmd/bot
```

The devnet config keeps only `SOLUSD`, `BTCUSD`, and `ETHUSD`, disables failover by default, and writes durable exact-second prices to `data/signed-prices-devnet.sqlite`.

## Docker

```bash
# Build Docker image
make docker-build

# Run in Docker
ECDSA_PRIVATE_KEY=your_key make docker-run
```

## Signature Verification

### Solidity Smart Contract Verification

The bot signs prices using EIP-191 format, compatible with Solidity's `ecrecover`:

```solidity
struct CexPrice {
    address token;
    uint256 priceInWad;
    uint256 timestamp;
    uint8 v;
    bytes32 r;
    bytes32 s;
}

function verifyCexPrice(
    CexPrice calldata cexData,
    address trustedSigner
) internal view returns (bool) {
    // Create message hash: keccak256(token, priceInWad, timestamp)
    bytes32 messageHash = keccak256(
        abi.encodePacked(cexData.token, cexData.priceInWad, cexData.timestamp)
    );

    // EIP-191 signed message standard
    bytes32 ethSignedMessageHash = keccak256(
        abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
    );

    // Recover signer from signature
    address recoveredSigner = ecrecover(
        ethSignedMessageHash,
        cexData.v,
        cexData.r,
        cexData.s
    );

    // Verify signer is trusted
    return recoveredSigner == trustedSigner && recoveredSigner != address(0);
}
```

### Message Format

The signed message contains:
- `token` (address): Token contract address (20 bytes)
- `priceInWad` (uint256): Price in WAD format (18 decimals, 32 bytes)
- `timestamp` (uint256): Unix timestamp in **milliseconds** (32 bytes). Consumers must use ms; do not compare directly against `block.timestamp` (seconds) without scaling.

Total message size: 84 bytes (20 + 32 + 32)
