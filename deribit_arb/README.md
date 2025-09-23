# deribit_arb

High-frequency, fee-aware scanner and combo executor for Deribit BTC/ETH options built in Rust. The app connects to the JSON-RPC v2 API over both WebSocket and HTTP, keeps a live option chain for coin- and USDC-settled contracts, and evaluates micro-arbitrage structures sized for $5k–$20k tickets. Detected opportunities include vertical spreads, butterflies, calendars, jelly rolls, and USDC box parity, with full trading and delivery fees applied and combo discounts honoured.

> Canonical references: [Deribit API Docs](https://docs.deribit.com/), [Deribit Fee Schedule](https://support.deribit.com/kb/a47/fees.aspx), [Combo Trading overview](https://support.deribit.com/kb/a89/combination-trading.aspx).

## Prerequisites

- Rust toolchain 1.75+ (tested with stable 1.75 and nightly 1.83).
- Internet access to `www.deribit.com` or `test.deribit.com`.
- Deribit API credentials for authenticated combo preview/creation (optional for discovery/dry-run).

## Configuration

Configuration is environment-first with CLI overrides (all CLI flags have matching env vars):

| Env / Flag | Default | Description |
|------------|---------|-------------|
| `DERIBIT_ENV`, `--env` | `test` | `test` or `prod` endpoint roots |
| `API_KEY`, `API_SECRET` | _unset_ | OAuth2 credentials (required for combo preview/submit) |
| `CURRENCIES`, `--currencies` | `BTC,ETH` | Comma-separated underlyings to scan |
| `LINEARS`, `--linears` | `usdc,coin` | Settlement modes to include |
| `DRY_RUN`, `--dry-run` | `true` | Skip order submission; still previews combos |
| `MAX_TICKET_USD`, `--max-ticket` | `20000` | Max notional per opportunity |
| `MIN_EDGE_USD`, `--min-edge-usd` | `50` | Minimum net USD edge after fees |
| `MIN_EDGE_RATIO`, `--min-edge-ratio` | `2.0` | Net edge ÷ total fees lower bound |
| `HOLD_TO_EXPIRY`, `--hold-to-expiry` | `false` | Include delivery fee modelling |
| `ONLY`, `--only` | `vertical,butterfly,calendar,box,jelly` | Strategy whitelist |
| `MAX_CONCURRENT_COMBOS`, `--max-concurrent-combos` | `3` | Risk guardrail for simultaneous combos |
| `MIN_DEPTH_CONTRACTS`, `--min-depth-contracts` | `1` | Required top-of-book size per leg |

Example invocation (dry-run on testnet):

```bash
cargo run -- \
  --env test \
  --currencies BTC,ETH \
  --linears usdc,coin \
  --max-ticket 20000 \
  --min-edge-usd 75 \
  --only vertical,calendar,jelly \
  --dry-run true
```

## Runtime overview

1. **Client layer (`client/`)** – Async HTTP (Reqwest + rustls) for discovery, auth, and combo endpoints and WebSocket subscriptions via `tokio-tungstenite`. Tokens are auto-refreshed ahead of expiry.
2. **Model (`model/`)** – Strongly typed instrument, quote, combo, fee, and opportunity representations. Deribit instrument parsing follows `BTC-25DEC24-42000-C` formatting exactly.
3. **Chain (`chain/`)** – Thread-safe option chain cache (`parking_lot::RwLock`) updated by ticker/book events for near-real-time pricing.
4. **Fees (`fees/`)** – Implements Deribit’s published formulas:
   - Coin-settled options: `min(0.0003 coin, 12.5% * premium_coin) * contracts`.
   - USDC linear BTC/ETH: `min(0.0003 * index_usd, 12.5% * premium_usd) * contracts`.
   - Combo discount: cheaper side’s fees zeroed.
   - Delivery: 0.015% notional, capped at 12.5% of option value (skipped for dailies).
5. **Detectors (`detect/`)** – Vertical monotonicity, butterfly convexity, calendar roll arb, jelly rolls (put-call funding mispricing), and USDC box parity searchers working off executable quotes and fee-adjusted PnL. Slippage guard = edge ÷ total fees ≥ configured ratio.
6. **Execution (`exec/`)** – Dry-run combo planner that creates combos (`/private/create_combo`), previews fills (`/private/get_leg_prices`), and (when `--dry-run=false`) would be the place to submit IOC/FOK orders. Planner refuses sub-depth tickets.
7. **Risk (`risk/`)** – Lightweight limits for ticket size, concurrent combos, and rolling PnL EWMA kill switch hooks.
8. **Render (`render/`)** – Presents top-N opportunities using `comfy-table` and optional CSV export.

## Running a scan

1. Ensure environment variables or CLI flags are set.
2. Run `cargo run -- --env test` (keeps `dry_run=true`).
3. The scanner will:
   - Discover active option instruments for the configured currencies/kinds.
   - Pull fresh tickers/order book snapshots.
   - Evaluate detectors, compute trading + delivery fees, and apply combo discounts.
   - Print an opportunities table ranked by net USD edge.
   - Preview combo pricing via Deribit if API credentials are present.
4. When comfortable with dry-run output, set `--dry-run=false` to allow the planner to move towards execution (actual order submission is gated by additional checks in `exec/`).

## Testing

Integration-style tests live under `tests/`:

- `tests/fees.rs` – Validates fee engine (coin vs USDC, combo discount, delivery cap).
- `tests/detectors.rs` – Synthetic books for each detector class.
- `tests/planner.rs` – Ensures the planner obeys depth limits and builds leg JSON in dry-run mode.

Run the full suite with:

```bash
cargo test
```

## Extending / Next steps

- Wire real-time WebSocket streaming to continuously refresh the chain instead of snapshot polling.
- Persist per-leg depth and heartbeat stats for stale-quote snipes.
- Add CSV/Parquet exports (`--export` flag) and optional Polars integration (feature `export-polars`).
- Integrate execution kill-switch metrics with actual trade feedback once live trading is enabled.

## References

- Deribit API overview & JSON-RPC v2 methods: <https://docs.deribit.com/>
- Combination order docs & fee discounts: <https://support.deribit.com/kb/a89/combination-trading.aspx>
- Options fee and delivery schedule: <https://support.deribit.com/kb/a47/fees.aspx>
