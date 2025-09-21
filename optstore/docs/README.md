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
cargo run -- retrieve --source deribit --symbol ETH-21MAR25-4100-C --day 2025-03-21 --out raw_cache/
cargo run -- retrieve --source deribit --symbol BTC-28MAR25-60000-C --day 2025-03-28 --out raw_cache/
```

> Note: Deribit expects a fully qualified option instrument (expiry/strike/CP). A bare symbol such as `ETH-25MAR-2025` will be rejected with a 400 error.
