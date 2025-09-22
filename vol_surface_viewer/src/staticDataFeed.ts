import type { SnapshotListener, SurfaceSnapshot } from './types'

export interface StaticFeedOptions {
  dataUrl?: string
  minMoneyness?: number
  maxMoneyness?: number
  rows?: number
}

interface StaticFeedController {
  subscribe(listener: SnapshotListener): () => void
  start(): void
  stop(): void
  getSnapshot(): SurfaceSnapshot
  ready: Promise<SurfaceSnapshot>
}

interface RawOptionRecord {
  expiration: string | null
  strike: number | null
  impliedVol: number | null
  optionType: 'call' | 'put' | null
}

interface RawOptionChain {
  symbol: string
  asOf: string
  underlyingPrice: number | null
  expirations: string[]
  records: Array<
    RawOptionRecord & {
      contractSymbol: string | null
      lastPrice: number | null
      bid: number | null
      ask: number | null
      mid: number | null
      volume: number | null
      openInterest: number | null
      delta: number | null
      gamma: number | null
      theta: number | null
      vega: number | null
      rho: number | null
    }
  >
}

interface ProcessedExpiration {
  maturityYears: number
  expirationDate: string
  points: Array<{ moneyness: number; vol: number }>
}

export function createStaticDataFeed(opts: StaticFeedOptions = {}): StaticFeedController {
  const dataUrl = opts.dataUrl ?? '/data/latest.json'
  const minM = opts.minMoneyness ?? -0.6
  const maxM = opts.maxMoneyness ?? 0.6
  const rows = Math.max(8, Math.floor(opts.rows ?? 61))

  const listeners = new Set<SnapshotListener>()
  let snapshot: SurfaceSnapshot | null = null

  const ready = (async () => {
    const response = await fetch(dataUrl, { cache: 'no-cache' })
    if (!response.ok) {
      throw new Error(`Failed to load option surface data: ${response.status} ${response.statusText}`)
    }
    const payload = (await response.json()) as RawOptionChain
    snapshot = buildSnapshot(payload, { minM, maxM, rows })
    notify()
    return snapshot
  })()

  function notify() {
    if (!snapshot) return
    listeners.forEach((listener) => listener(snapshot!))
  }

  return {
    subscribe(listener: SnapshotListener) {
      listeners.add(listener)
      if (snapshot) {
        listener(snapshot)
      }
      return () => listeners.delete(listener)
    },
    start() {
      // no-op for static feed
    },
    stop() {
      // no-op for static feed
    },
    getSnapshot() {
      if (!snapshot) {
        throw new Error('Static surface data not ready yet')
      }
      return snapshot
    },
    ready
  }
}

function buildSnapshot(chain: RawOptionChain, config: { minM: number; maxM: number; rows: number }): SurfaceSnapshot {
  if (!chain) {
    throw new Error('Empty option surface payload')
  }

  const underlying = typeof chain.underlyingPrice === 'number' && chain.underlyingPrice > 0 ? chain.underlyingPrice : null
  if (!underlying) {
    throw new Error('Missing underlying price in option dataset')
  }

  const asOf = chain.asOf ? new Date(chain.asOf) : new Date()
  if (Number.isNaN(asOf.getTime())) {
    throw new Error('Invalid asOf timestamp in option dataset')
  }

  const expirations = aggregateExpirations(chain.records ?? [], underlying)
    .map((exp) => enrichExpiration(exp, asOf))
    .filter((exp): exp is ProcessedExpiration => exp !== null && exp.points.length >= 2)
    .sort((a, b) => a.maturityYears - b.maturityYears)

  if (expirations.length === 0) {
    throw new Error('No usable expirations in option dataset')
  }

  const cols = expirations.length
  const rows = config.rows
  const minM = config.minM
  const maxM = config.maxM
  const strikes = new Float32Array(rows)
  const maturities = new Float32Array(cols)
  const vols = new Float32Array(cols * rows)

  const step = (maxM - minM) / (rows - 1)
  for (let y = 0; y < rows; y += 1) {
    strikes[y] = minM + step * y
  }

  for (let x = 0; x < cols; x += 1) {
    const exp = expirations[x]
    maturities[x] = exp.maturityYears
    for (let y = 0; y < rows; y += 1) {
      const m = strikes[y]
      const vol = interpolateVol(exp.points, m)
      const idx = x * rows + y
      vols[idx] = Math.max(0.01, Math.min(vol, 5))
    }
  }

  return {
    cols,
    rows,
    maturities,
    strikes,
    vols,
    timestamp: Date.now()
  }
}

function aggregateExpirations(records: RawOptionChain['records'], underlying: number) {
  const map = new Map<
    string,
    Map<
      number,
      {
        callVols: number[]
        putVols: number[]
      }
    >
  >()

  for (const record of records) {
    if (!record || typeof record.expiration !== 'string') continue
    if (!Number.isFinite(record.strike) || !Number.isFinite(record.impliedVol)) continue
    if (!record.optionType) continue

    const exp = record.expiration
    let strikes = map.get(exp)
    if (!strikes) {
      strikes = new Map()
      map.set(exp, strikes)
    }

    const strike = record.strike ?? 0
    let bucket = strikes.get(strike)
    if (!bucket) {
      bucket = { callVols: [], putVols: [] }
      strikes.set(strike, bucket)
    }

    if (record.optionType === 'call') {
      bucket.callVols.push(record.impliedVol!)
    } else if (record.optionType === 'put') {
      bucket.putVols.push(record.impliedVol!)
    }
  }

  const results: Array<{ expiration: string; strikes: Array<{ moneyness: number; vol: number }> }> = []

  for (const [expiration, strikeMap] of map.entries()) {
    const points: Array<{ moneyness: number; vol: number }> = []
    for (const [strike, vols] of strikeMap.entries()) {
      const moneyness = strike / underlying - 1
      const callVol = average(vols.callVols)
      const putVol = average(vols.putVols)

      let vol: number | null = null
      if (Number.isFinite(callVol) && Number.isFinite(putVol)) {
        vol = (callVol! + putVol!) / 2
      } else if (Number.isFinite(callVol)) {
        vol = callVol!
      } else if (Number.isFinite(putVol)) {
        vol = putVol!
      }

      if (vol !== null && Number.isFinite(vol) && vol > 0) {
        points.push({ moneyness, vol })
      }
    }

    points.sort((a, b) => a.moneyness - b.moneyness)
    results.push({ expiration, strikes: points })
  }

  return results
}

function enrichExpiration(entry: { expiration: string; strikes: Array<{ moneyness: number; vol: number }> }, asOf: Date): ProcessedExpiration | null {
  const expiryDate = new Date(entry.expiration)
  if (Number.isNaN(expiryDate.getTime())) {
    return null
  }

  const diffMs = expiryDate.getTime() - asOf.getTime()
  if (diffMs <= 0) {
    return null
  }
  const maturityYears = diffMs / (365.25 * 24 * 60 * 60 * 1000)

  const filtered = entry.strikes.filter((point) => Number.isFinite(point.moneyness) && Number.isFinite(point.vol))
  if (filtered.length < 2) {
    return null
  }

  return {
    maturityYears,
    expirationDate: entry.expiration,
    points: filtered
  }
}

function interpolateVol(points: Array<{ moneyness: number; vol: number }>, target: number): number {
  if (points.length === 0) return 0.2
  if (points.length === 1) return points[0].vol

  let left = points[0]
  if (target <= left.moneyness) {
    return left.vol
  }

  let right = points[points.length - 1]
  if (target >= right.moneyness) {
    return right.vol
  }

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]
    const b = points[i + 1]
    if (target >= a.moneyness && target <= b.moneyness) {
      if (b.moneyness === a.moneyness) {
        return (a.vol + b.vol) * 0.5
      }
      const t = (target - a.moneyness) / (b.moneyness - a.moneyness)
      return a.vol + (b.vol - a.vol) * t
    }
  }

  return right.vol
}

function average(values: number[]): number | null {
  if (!values || values.length === 0) return null
  let sum = 0
  let count = 0
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    sum += value
    count += 1
  }
  if (count === 0) return null
  return sum / count
}
