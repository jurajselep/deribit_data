# optstore

This repository hosts an experimental options tick storage engine. The current implementation focuses on a minimal vertical slice:

- Retrieve Deribit public trade data for a symbol/day into a compressed raw cache with manifests that track per-page resume tokens.
- Surface progress and JSON events throughout the retrieve/ingest flow.
- Provide a placeholder ingest path that writes binary tick stubs while reporting throughput.

Further work will extend the format, block codecs, query engine, and WAL mechanics.

## Example Commands

```bash
# Discover instruments
curl 'https://www.deribit.com/api/v2/public/get_instruments?currency=ETH&kind=option&expired=true' \
  | jq '.result[].instrument_name' | head

# Retrieve sample ETH/BTC options
cargo run -- retrieve --source deribit --symbol ETH-21SEP25-4200-C --day 2025-09-21 --out raw_cache/
cargo run -- retrieve --source deribit --symbol BTC-28MAR25-60000-C --day 2025-03-28 --out raw_cache/
```


During retrieval the CLI reports percentage complete and ETA based on the day window (start/end timestamps).

> Note: Deribit expects a fully qualified option instrument (expiry/strike/CP). A bare symbol such as `ETH-25MAR-2025` will be rejected with a 400 error.

## Roadmap

- Implement columnar block writer/reader with compression, anchors, CRC/xxhash, and Bloom filters.
- Add ingestion pipeline for cached raw data (normalize, dedup, append-only storage).
- Extend progress reporting (ingest/compress/write/verify, json events) and query planning (`--explain`).
- Broaden retrieval to support quotes/both feeds, resume manifests, dedup spill to disk, and configurable rate/backoff.
- Add comprehensive tests (retrieve roundtrip, dedup, corruption) and end-to-end benchmarks.
- Document prompt inversion decisions in ADR-0001 when format changes are introduced.


### Lean 4 SVI Helper

The repository also includes `../svi_surface/`, a Lean 4 project that
implements an arbitrage-free SVI slice.

```bash
cd ../svi_surface
lake build
lake exe svi-surface-test
```

The executable prints whether the example parameters satisfy the classic
Gatheral no-arbitrage constraints and dumps variance samples across a few
log-moneyness points.
