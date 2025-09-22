import type { SnapshotListener, SurfaceSnapshot } from './types'
import { GarchModel } from './garch'

export interface RandomFeedOptions {
  cols?: number
  rows?: number
  intervalMs?: number
  jitter?: number
}

interface RandomFeedController {
  subscribe(listener: SnapshotListener): () => void
  start(): void
  stop(): void
  getSnapshot(): SurfaceSnapshot
  ready: Promise<SurfaceSnapshot>
}

const DEFAULTS = {
  cols: 96,
  rows: 64,
  intervalMs: 180,
  jitter: 0.16
} satisfies Required<RandomFeedOptions>

const MIN_MATURITY_DAYS = 7
const MAX_MATURITY_DAYS = 252 * 2 // two years
const TRADING_DAYS_PER_YEAR = 252
const MS_PER_GARCH_STEP = 900

// Tuned via scripts/calibrateGarch.js using daily SPX closes since 1990.
const SPX_GARCH_CALIBRATION = {
  alpha: 0.105,
  beta: 0.88,
  omega: 0.000001952334252257694,
  mu: 0.0003250661216017706
} as const

interface Grid {
  maturities: Float32Array
  maturityDays: Float32Array
  strikes: Float32Array
}

function buildGrid(cols: number, rows: number): Grid {
  const maturities = new Float32Array(cols)
  const maturityDays = new Float32Array(cols)
  const strikes = new Float32Array(rows)

  for (let x = 0; x < cols; x += 1) {
    const t = cols <= 1 ? 0 : x / (cols - 1)
    const bias = Math.pow(t, 1.32)
    const days = MIN_MATURITY_DAYS + bias * (MAX_MATURITY_DAYS - MIN_MATURITY_DAYS)
    maturities[x] = days / TRADING_DAYS_PER_YEAR
    maturityDays[x] = days
  }

  const minStrike = -0.55
  const maxStrike = 0.45

  for (let y = 0; y < rows; y += 1) {
    if (rows <= 1) {
      strikes[y] = 0
      continue
    }
    const t = y / (rows - 1)
    const centered = (t * 2) - 1
    const compressed = Math.tanh(centered * 1.1)
    strikes[y] = ((compressed + 1) / 2) * (maxStrike - minStrike) + minStrike
  }

  return { maturities, maturityDays, strikes }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function computeSurfacePoint(
  strike: number,
  maturityYears: number,
  tenorVol: number,
  atmVol: number,
  riskFactor: number,
  timeFactor: number
): number {
  const shortWeight = Math.exp(-maturityYears * 2.6)
  const mediumWeight = Math.exp(-maturityYears * 0.9)
  const farWeight = Math.exp(-maturityYears * 0.35)

  const skewStrength = tenorVol * (0.28 * shortWeight + 0.1 * mediumWeight) * (0.55 + 0.45 * riskFactor)
  const slope = -skewStrength * strike

  const wingMagnitude = tenorVol * (0.08 + 0.16 * shortWeight) * (0.5 + 0.5 * riskFactor)
  const wing = wingMagnitude * Math.pow(Math.abs(strike), 1.32)
  const asymmetricWing = strike < 0 ? wing : -wing * (0.38 + 0.18 * farWeight)

  const bellyDepth = tenorVol * 0.035 * mediumWeight
  const belly = -bellyDepth * Math.exp(-Math.pow(strike * 1.35, 2))

  const termBlend = (tenorVol - atmVol) * (0.45 * farWeight)

  const base = tenorVol + slope + asymmetricWing + belly + termBlend

  const seasonal = tenorVol * 0.025 * Math.sin(timeFactor * 0.7 + strike * 4.2) * shortWeight

  return clamp(base + seasonal, Math.max(0.045, tenorVol * 0.45), Math.max(0.08, tenorVol * 1.9))
}

export function createRandomDataFeed(opts: RandomFeedOptions = {}): RandomFeedController {
  const cols = opts.cols ?? DEFAULTS.cols
  const rows = opts.rows ?? DEFAULTS.rows
  const intervalMs = opts.intervalMs ?? DEFAULTS.intervalMs
  const jitter = opts.jitter ?? DEFAULTS.jitter

  const { maturities, maturityDays, strikes } = buildGrid(cols, rows)
  const vols = new Float32Array(cols * rows)
  const baselines = new Float32Array(cols * rows)
  const scratch = new Float32Array(cols * rows)

  const garch = new GarchModel({
    alpha: SPX_GARCH_CALIBRATION.alpha,
    beta: SPX_GARCH_CALIBRATION.beta,
    omega: SPX_GARCH_CALIBRATION.omega,
    mu: SPX_GARCH_CALIBRATION.mu
  })
  const longRunVol = garch.getLongRunAnnualizedVol()
  const atmVol = garch.getAnnualizedVol()
  const riskFactor = clamp(atmVol / longRunVol, 0.55, 2.4)

  for (let x = 0; x < cols; x += 1) {
    const maturityYears = maturities[x]
    const days = Math.max(1, Math.round(maturityDays[x]))
    const tenorVol = garch.forecastAnnualizedVol(days)

    for (let y = 0; y < rows; y += 1) {
      const idx = x * rows + y
      const strike = strikes[y]
      const base = computeSurfacePoint(strike, maturityYears, tenorVol, atmVol, riskFactor, 0)
      const seeded = base + (Math.random() - 0.5) * jitter * tenorVol * 0.05
      baselines[idx] = seeded
      vols[idx] = seeded
    }
  }

  let snapshot: SurfaceSnapshot = {
    cols,
    rows,
    maturities,
    strikes,
    vols,
    timestamp: performance.now()
  }

  const listeners = new Set<SnapshotListener>()
  let timer: number | null = null
  let lastTick = performance.now()
  let accumulator = 0
  let simTime = 0

  const emit = () => {
    snapshot.timestamp = performance.now()
    listeners.forEach((listener) => listener(snapshot))
  }

  const tick = () => {
    const now = performance.now()
    const deltaMs = Math.max(0, now - lastTick)
    lastTick = now
    accumulator += deltaMs
    simTime += deltaMs * 0.001

    while (accumulator >= MS_PER_GARCH_STEP) {
      garch.step()
      accumulator -= MS_PER_GARCH_STEP
    }

    const atm = garch.getAnnualizedVol()
    const longRun = garch.getLongRunAnnualizedVol()
    const factor = clamp(atm / longRun, 0.5, 2.8)
    const globalMode = Math.sin(simTime * 0.18) * 0.025 * factor

    for (let x = 0; x < cols; x += 1) {
      const maturityYears = maturities[x]
      const days = Math.max(1, Math.round(maturityDays[x]))
      const tenorVol = garch.forecastAnnualizedVol(days)

      const maturityPulse = Math.sin(simTime * 0.12 + x * 0.17) * 0.02

      for (let y = 0; y < rows; y += 1) {
        const idx = x * rows + y
        const strike = strikes[y]
        const strikePulse = Math.sin(simTime * 0.26 + y * 0.21) * 0.018

        const base = computeSurfacePoint(strike, maturityYears, tenorVol, atm, factor, simTime)
        const target = clamp(
          base * (1 + globalMode + maturityPulse) + strikePulse * tenorVol * 0.2,
          0.045,
          Math.max(0.08, tenorVol * 2.1)
        )

        baselines[idx] = target

        const shortWeight = Math.exp(-maturityYears * 2.3)
        const revert = (target - vols[idx]) * (0.22 + 0.32 * shortWeight)
        const noise = (Math.random() - 0.5) * jitter * tenorVol * (0.011 + 0.022 * factor)
        const shockChance = 0.0045 + 0.009 * (factor - 1) * (factor - 1)
        const shock = Math.random() < shockChance ? (Math.random() - 0.5) * tenorVol * 0.14 : 0

        scratch[idx] = clamp(vols[idx] + revert + noise + shock, 0.04, Math.max(0.12, tenorVol * 2.4))
      }
    }

    vols.set(scratch)
    emit()
  }

  const ready = new Promise<SurfaceSnapshot>((resolve) => {
    setTimeout(() => {
      snapshot.timestamp = performance.now()
      resolve(snapshot)
    }, 180)
  })

  return {
    subscribe(listener: SnapshotListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start() {
      if (timer !== null) return
      timer = window.setInterval(tick, intervalMs)
    },
    stop() {
      if (timer === null) return
      window.clearInterval(timer)
      timer = null
    },
    getSnapshot() {
      return snapshot
    },
    ready
  }
}
