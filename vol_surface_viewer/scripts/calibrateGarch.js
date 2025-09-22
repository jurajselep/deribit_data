import fs from 'node:fs'
import path from 'node:path'

const CSV_PATH = path.resolve(process.argv[2] ?? path.join(process.cwd(), '..', 'spx.csv'))
const REMOTE_SOURCE = 'https://stooq.pl/q/d/l/?s=^spx&i=d'

function parseCloses(csvText) {
  const rows = []
  if (!csvText) return rows
  const lines = csvText.split(/\r?\n/)
  for (const line of lines) {
    if (!line || line.startsWith('Data')) continue
    const parts = line.split(',')
    if (parts.length < 5) continue
    const date = parts[0]
    const close = Number(parts[4])
    if (!Number.isFinite(close) || close <= 0) continue
    rows.push({ date, close })
  }
  return rows
}

function toDailyReturns(rows, minDate = '1990-01-01') {
  const filtered = rows.filter((row) => row.date >= minDate)
  filtered.sort((a, b) => (a.date < b.date ? -1 : 1))
  const returns = []
  for (let i = 1; i < filtered.length; i += 1) {
    const prev = filtered[i - 1].close
    const curr = filtered[i].close
    if (prev <= 0 || curr <= 0) continue
    const logRet = Math.log(curr / prev)
    if (!Number.isFinite(logRet) || Math.abs(logRet) > 0.2) continue
    returns.push(logRet)
  }
  return returns
}

function sampleVariance(values) {
  if (values.length === 0) return 0
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  let acc = 0
  for (const v of values) {
    const d = v - mean
    acc += d * d
  }
  return acc / values.length
}

function garchLogLikelihood(returns, alpha, beta, variance0, omega) {
  const eps = 1e-12
  let variance = variance0
  let lastSq = returns[0] * returns[0]
  let logLik = 0
  for (let i = 1; i < returns.length; i += 1) {
    variance = omega + alpha * lastSq + beta * variance
    variance = Math.max(variance, eps)
    const r = returns[i]
    logLik += -0.5 * (Math.log(variance) + (r * r) / variance)
    lastSq = r * r
  }
  return logLik
}

async function main() {
  let csvText = null
  if (fs.existsSync(CSV_PATH)) {
    csvText = fs.readFileSync(CSV_PATH, 'utf8')
  } else {
    const response = await fetch(REMOTE_SOURCE)
    if (!response.ok) {
      console.error('Failed to download SPX CSV:', response.status, response.statusText)
      process.exit(1)
    }
    csvText = await response.text()
  }

  const rows = parseCloses(csvText)
  if (rows.length === 0) {
    console.error('No rows parsed from csv source')
    process.exit(1)
  }
  const returns = toDailyReturns(rows)
  if (returns.length < 1000) {
    console.error('Not enough returns to calibrate')
    process.exit(1)
  }

  const sampleVar = sampleVariance(returns)
  const meanReturn = returns.reduce((sum, v) => sum + v, 0) / returns.length
  const variance0 = sampleVar

  let best = null
  for (let alpha = 0.02; alpha <= 0.20; alpha += 0.005) {
    for (let beta = 0.70; beta <= 0.99; beta += 0.005) {
      if (alpha + beta >= 0.999) continue
      const omega = sampleVar * (1 - alpha - beta)
      if (omega <= 0) continue
      const ll = garchLogLikelihood(returns, alpha, beta, variance0, omega)
      if (!best || ll > best.logLik) {
        best = { alpha: Number(alpha.toFixed(4)), beta: Number(beta.toFixed(4)), omega, logLik: ll }
      }
    }
  }

  if (!best) {
    console.error('Calibration failed to find suitable parameters')
    process.exit(1)
  }

  const tradingDays = 252
  const longRunVariance = best.omega / (1 - (best.alpha + best.beta))
  const longRunVol = Math.sqrt(longRunVariance * tradingDays)
  const dailyVol = Math.sqrt(longRunVariance)
  const summary = {
    alpha: best.alpha,
    beta: best.beta,
    omega: best.omega,
    meanReturn,
    dailyVol,
    annualVol: longRunVol,
    logLik: best.logLik,
    sampleAnnualVol: Math.sqrt(sampleVar * tradingDays)
  }

  console.log(JSON.stringify(summary, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
