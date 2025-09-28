# Angular Fin Dashboard

Deribit-inspired crypto options chain rendered every animation frame with Angular 20 signals and zoneless change detection. Designed to stay smooth on slower CPUs while surfacing detailed performance telemetry.

## Performance Optimizations

- **Zoneless signal graph**: the app bootstraps with `provideZonelessChangeDetection()` so Angular runs without Zone.js. Every state holder is a signal, keeping bindings reactive without macro-task patches.
- **Deribit-style option chain**: live instrument lists come from the public Deribit API (cached client-side with a static fallback), and maturities/strikes/greeks update every frame with a synthetic BTC surface tied to the selected contract.
- **RAF-driven loop**: option generation runs inside a single `requestAnimationFrame`, keeping work aligned with the browser’s paint cycle.
- **In-place data reuse**: mutable option books stay resident in memory while writable signals and NgRx actions fan out cloned snapshots (using `equal: () => false`) to avoid garbage and still wake the view layer.
- **Frame analytics buffer**: a 180-frame ring buffer tracks min/max, p95/p99, and the latest dozen frame costs so bottlenecks are visible straight from the UI.
- **Redux signal store**: a streamlined NgRx store (`provideStore`) receives every frame snapshot without Zone.js, ready for logging/devtools while the component remains signal-fast.
- **Benchmark harness**: `npm run benchmark` executes a Node.js microbenchmark (5 000 iterations) to validate update cost against the 16.67 ms frame budget.
- **Headless-friendly testing**: Karma is wired to Puppeteer’s ChromeHeadless (with `--no-sandbox`) so unit tests run in CI or containerized environments.

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

Open the local server to watch the option chain update each frame and inspect the live performance telemetry panel.

## Further Help

Use `ng help` or visit the [Angular CLI docs](https://angular.io/cli) for additional commands and options.
