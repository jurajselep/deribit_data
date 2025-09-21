# deribit_data

This workspace now hosts the `optstore` prototype: a Rust-based options tick store focused on fast ingest and low-latency reads.

## Quick Start

```bash
cd optstore

# Discover available instruments (optional helper)
curl 'https://www.deribit.com/api/v2/public/get_instruments?currency=ETH&kind=option&expired=true' \
  | jq '.result[].instrument_name' | head

# Retrieve ETH option data (replace symbol/day with one returned above)
cargo run -- retrieve \
  --source deribit \
  --symbol ETH-21SEP25-4200-C \
  --day 2025-03-21 \
  --out raw_cache/ \
  --rate 6

# Retrieve BTC option data
cargo run -- retrieve \
  --source deribit \
  --symbol BTC-28MAR25-60000-C \
  --day 2025-03-28 \
  --out raw_cache/ \
  --rate 6

# Re-run with --resume to continue filling the same partition
cargo run -- retrieve \
  --source deribit \
  --symbol ETH-21MAR25-4100-C \
  --day 2025-03-21 \
  --out raw_cache/ \
  --resume
```

## Design Variations

- Retrieval now persists a manifest per (symbol, day) partition, including resume tokens and per-part statistics, but the on-disk block layout still mirrors the baseline specification; ADR-0001 remains unchanged until we adopt a substantive storage variation.
- ⚠️ Deribit requires using the full option instrument name (including expiry, strike, and call/put suffix). If you receive `Deribit rejected instrument...` ensure you pass values like `ETH-21MAR25-4100-C` or `BTC-28MAR25-60000-C`.
