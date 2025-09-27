# Angular Fin Dashboard

Real-time synthetic market dashboard updated every animation frame. The project was scaffolded with Angular CLI 16.2.0 and tuned for high-frequency UI updates on slower CPUs.

## Performance Optimizations

- **Zone-bypassed render loop**: the ticker stream runs inside `requestAnimationFrame` outside Angular's zone, then performs a targeted `detectChanges` call. This keeps change detection work minimal and avoids the cost of timer-driven change cycles.
- **In-place data reuse**: each frame mutates preallocated `TickerRow` objects and reuses the same array reference. Angular only re-renders what changed, eliminating churn from re-creating arrays or pipes every tick.
- **Preformatted values**: price, change, percentage, and volume strings are precomputed in the data layer, so the template binds to plain strings with no formatting pipes per frame.
- **Frame diagnostics cache**: performance stats are stored in mutable structs and a ring buffer (180-frame history) to avoid allocations, while exposing average, min/max, p95/p99, and recent frame timings directly in the UI.
- **Headless-friendly testing**: Karma is configured to launch Puppeteer’s ChromeHeadless with `--no-sandbox`, ensuring unit tests run in CI or minimal environments without installing Chrome.
- **Benchmark harness**: a Node.js benchmark (`npm run benchmark`) exercises the ticker generator for 5 000 iterations and reports mean/percentile costs versus the 16.67 ms frame budget.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Run the dev server at http://localhost:4200/. |
| `npm run build` | Create an optimized production build in `dist/angular-fin-dashboard`. |
| `npm test` | Execute Karma unit tests in ChromeHeadless. |
| `npm run benchmark` | Run the ticker-generation micro-benchmark with ts-node. |

## Getting Started

```bash
npm install
npm start
```

Open the served page to see the live feed and expanded performance telemetry (frame history, percentiles, and FPS readiness) update in real time.

## Further Help

Use `ng help` or consult the [Angular CLI docs](https://angular.io/cli) for additional commands.
