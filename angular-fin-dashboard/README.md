# Angular Fin Dashboard

Synthetic market dashboard pushing frame-by-frame updates with Angular 20 signals and zoneless change detection. Designed to stay smooth on slower CPUs while surfacing detailed performance telemetry.

## Performance Optimizations

- **Zoneless signal graph**: the app bootstraps with `provideZonelessChangeDetection()` so Angular runs without Zone.js. Every state holder is a `signal`, which keeps template bindings reactive without relying on macro-task patches.
- **RAF-driven stream loop**: ticker generation runs inside a single `requestAnimationFrame` callback, guaranteeing work is batch-aligned with the browser render pipeline.
- **In-place data reuse**: `nextTickerSlice` mutates a stable pool of `TickerRow` objects, and the writable signals re-emit the same references each tick (using `equal: () => false`). That keeps garbage creation near-zero and still wakes the view layer.
- **Preformatted payloads**: price/percentage/volume strings are computed alongside the numeric values, removing the need for expensive pipes during change detection.
- **Frame analytics buffer**: a 180-frame ring buffer tracks min/max, p95/p99, and the latest dozen frame times so bottlenecks are visible straight from the UI.
- **Headless-friendly testing**: Karma is wired to Puppeteer’s `ChromeHeadless` launcher (with `--no-sandbox` flags) so tests run in CI or containerized environments.
- **Benchmark harness**: `npm run benchmark` executes a Node.js microbenchmark (5 000 iterations) to validate update cost against the 16.67 ms frame budget.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Serve the app at http://localhost:4200/ with live reload. |
| `npm run build` | Produce a production build in `dist/angular-fin-dashboard`. |
| `npm test` | Run the Karma/Jasmine unit suite in ChromeHeadless. |
| `npm run benchmark` | Execute the ticker-generation benchmark via ts-node. |

> **Node requirement:** Angular 20 requires Node.js 20.18+ (or 22.12+). Use a compatible runtime when running the scripts above.

## Getting Started

```bash
npm install
npm start
```

Open the local server to watch the feed update every frame and inspect the live frame diagnostics panel.

## Further Help

Use `ng help` or visit the [Angular CLI docs](https://angular.io/cli) for additional commands and options.
