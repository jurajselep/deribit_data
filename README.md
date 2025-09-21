# deribit_data

This workspace now hosts the `optstore` prototype: a Rust-based options tick store focused on fast ingest and low-latency reads.

## Quick Start

```bash
cd optstore
cargo run -- retrieve --source deribit --symbol ETH-25MAR-2025 --day 2025-03-28 --out data/cache
```

## Design Variations

- The initial prototype follows the baseline specification. No prompt inversion changes have been adopted yet; ADR-0001 records this status and will be updated as the storage format evolves.
