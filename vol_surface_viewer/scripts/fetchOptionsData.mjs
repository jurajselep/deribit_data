import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import yahooFinance from 'yahoo-finance2'

if (typeof yahooFinance.suppressNotices === 'function') {
  yahooFinance.suppressNotices(['yahooSurvey'])
}

const DEFAULT_SYMBOL = '^SPX'
const DEFAULT_EXPIRATION_LIMIT = 6
const OUTPUT_DIR = path.resolve(process.cwd(), 'data')
const PUBLIC_OUTPUT_DIR = path.resolve(process.cwd(), 'public', 'data')

async function main() {
  const symbol = process.argv[2] ?? DEFAULT_SYMBOL
  const expirationLimit = Number(process.argv[3]) || DEFAULT_EXPIRATION_LIMIT

  console.log(`Fetching option chain for ${symbol} (expirations: ${expirationLimit})...`)

  const quote = await yahooFinance.quote(symbol)

  const baseChain = await yahooFinance.options(symbol)

  if (!baseChain || !baseChain.options || baseChain.options.length === 0) {
    throw new Error(`No options data returned for ${symbol}`)
  }

  const allExpirations = baseChain.expirationDates ?? []
  if (allExpirations.length === 0) {
    throw new Error(`No expiration schedule returned for ${symbol}`)
  }

  const targetDates = allExpirations.slice(0, expirationLimit)
  const optionSets = []

  for (let i = 0; i < targetDates.length; i += 1) {
    const date = targetDates[i]
    let chain
    if (i === 0 && baseChain.options?.length) {
      chain = baseChain.options[0]
    } else {
      const next = await yahooFinance.options(symbol, { date })
      chain = next?.options?.[0]
    }
    if (!chain) continue
    optionSets.push({ expiration: date, chain })
  }

  const normalized = normalizeOptions(symbol, quote, optionSets)

  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fileName = `${symbol.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}_${timestamp}.json`
  const filePath = path.join(OUTPUT_DIR, fileName)
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2))

  fs.mkdirSync(PUBLIC_OUTPUT_DIR, { recursive: true })
  const publicPath = path.join(PUBLIC_OUTPUT_DIR, 'latest.json')
  fs.writeFileSync(publicPath, JSON.stringify(normalized, null, 2))

  console.log(
    `Saved ${normalized.records.length} option strikes across ${normalized.expirations.length} expirations -> ${filePath}`
  )
  console.log(`Updated public snapshot -> ${publicPath}`)
}

function normalizeOptions(symbol, quote, optionSets) {
  const asOf = new Date()
  const expirations = []
  const records = []

  const underlyingPrice = quote?.regularMarketPrice ?? null

  for (const { expiration: expirationTs, chain } of optionSets) {
    const expirationMs = normalizeEpoch(expirationTs)
    const expiration = expirationMs ? new Date(expirationMs).toISOString().slice(0, 10) : null
    if (expiration) {
      expirations.push(expiration)
    }

    const chains = [...(chain.calls ?? []), ...(chain.puts ?? [])]
    for (const leg of chains) {
      if (!Number.isFinite(leg.impliedVolatility) || !Number.isFinite(leg.strike)) continue

      let optionType = null
      if (typeof leg.contractSymbol === 'string') {
        const normalized = leg.contractSymbol.toUpperCase()
        const match = normalized.match(/([CP])(\d{8})$/)
        if (match) {
          optionType = match[1] === 'C' ? 'call' : 'put'
        } else if (normalized.endsWith('C')) {
          optionType = 'call'
        } else if (normalized.endsWith('P')) {
          optionType = 'put'
        }
      }

      records.push({
        symbol,
        optionType,
        contractSymbol: leg.contractSymbol ?? null,
        expiration: expiration,
        strike: leg.strike ?? null,
        lastPrice: leg.lastPrice ?? null,
        bid: leg.bid ?? null,
        ask: leg.ask ?? null,
        mid: computeMid(leg.bid, leg.ask),
        volume: leg.volume ?? null,
        openInterest: leg.openInterest ?? null,
        impliedVol: leg.impliedVolatility ?? null,
        delta: leg.delta ?? null,
        gamma: leg.gamma ?? null,
        theta: leg.theta ?? null,
        vega: leg.vega ?? null,
        rho: leg.rho ?? null
      })
    }
  }

  records.sort((a, b) => {
    if (a.expiration === b.expiration) {
      if (a.strike === b.strike) {
        return (a.optionType ?? '').localeCompare(b.optionType ?? '')
      }
      return (a.strike ?? 0) - (b.strike ?? 0)
    }
    return (a.expiration ?? '').localeCompare(b.expiration ?? '')
  })

  return {
    symbol,
    asOf: asOf.toISOString(),
    underlyingPrice,
    expirations: Array.from(new Set(expirations)).sort(),
    records
  }
}

function computeMid(bid, ask) {
  if (Number.isFinite(bid) && Number.isFinite(ask)) {
    return (bid + ask) / 2
  }
  if (Number.isFinite(bid)) return bid
  if (Number.isFinite(ask)) return ask
  return null
}

function normalizeEpoch(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getTime()
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000
  }
  return null
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
