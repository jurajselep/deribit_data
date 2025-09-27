import { performance } from 'node:perf_hooks';
import { generateTickers, type TickerRow } from '../src/app/data/generate-tickers';

const ROW_COUNT = 20;
const WARM_UP_ITERATIONS = 500;
const BENCH_ITERATIONS = 5_000;
const FRAME_TARGET_MS = 1000 / 60;

type SampleResult = {
  iterations: number;
  averageMs: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  updatesPerSecond: number;
};

function percentile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.ceil(percentile * sorted.length) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

function summarise(samples: number[]): SampleResult {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const average = total / sorted.length;
  return {
    iterations: sorted.length,
    averageMs: average,
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    updatesPerSecond: average === 0 ? Infinity : 1000 / average
  };
}

function verifyRowInvariants(rows: TickerRow[]): void {
  for (const row of rows) {
    if (!Number.isFinite(row.price) || row.price <= 0) {
      throw new Error(`Invalid price generated for ${row.symbol}`);
    }
    if (!Number.isFinite(row.volume) || row.volume < 0) {
      throw new Error(`Invalid volume generated for ${row.symbol}`);
    }
  }
}

function runBenchmark(): SampleResult {
  let snapshot = generateTickers(ROW_COUNT);
  verifyRowInvariants(snapshot);

  for (let i = 0; i < WARM_UP_ITERATIONS; i += 1) {
    snapshot = generateTickers(ROW_COUNT, snapshot);
  }

  const samples: number[] = [];

  for (let i = 0; i < BENCH_ITERATIONS; i += 1) {
    const start = performance.now();
    snapshot = generateTickers(ROW_COUNT, snapshot);
    const end = performance.now();
    verifyRowInvariants(snapshot);
    samples.push(end - start);
  }

  return summarise(samples);
}

const results = runBenchmark();
const meetsFrameBudget = results.averageMs <= FRAME_TARGET_MS;

console.log('Synthetic ticker stream benchmark (Node.js)');
console.table({
  metrics: {
    iterations: results.iterations,
    averageMs: Number(results.averageMs.toFixed(6)),
    p95Ms: Number(results.p95Ms.toFixed(6)),
    p99Ms: Number(results.p99Ms.toFixed(6)),
    minMs: Number(results.minMs.toFixed(6)),
    maxMs: Number(results.maxMs.toFixed(6)),
    updatesPerSecond: Number(results.updatesPerSecond.toFixed(2)),
    meets60FpsBudget: meetsFrameBudget
  }
});

if (meetsFrameBudget) {
  console.log(`✓ Average update cost fits inside the 16.67 ms frame budget.`);
} else {
  console.log(`✗ Average update cost exceeds the 16.67 ms frame budget.`);
}
