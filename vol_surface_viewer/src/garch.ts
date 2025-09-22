const DEFAULT_TRADING_DAYS = 252

export interface GarchParams {
  alpha?: number
  beta?: number
  omega?: number
  mu?: number
  tradingDaysPerYear?: number
  longRunVol?: number
  initialVariance?: number
}

export interface GarchStepResult {
  variance: number
  annualizedVol: number
  return: number
}

export class GarchModel {
  private readonly alpha: number
  private readonly beta: number
  private readonly omega: number
  private readonly mu: number
  private readonly tradingDaysPerYear: number
  private readonly longRunVariance: number
  private variance: number
  private lastReturn = 0

  constructor(opts: GarchParams = {}) {
    const alpha = opts.alpha ?? 0.075
    const beta = opts.beta ?? 0.92
    const mu = opts.mu ?? 0
    const tradingDaysPerYear = opts.tradingDaysPerYear ?? DEFAULT_TRADING_DAYS

    if (alpha < 0 || beta < 0) {
      throw new Error('GARCH parameters alpha and beta must be non-negative')
    }
    if (alpha + beta >= 1) {
      throw new Error('The sum alpha + beta must be < 1 for a stationary GARCH(1,1) process')
    }

    const longRunDailyVariance = (() => {
      if (opts.omega !== undefined) {
        return opts.omega / (1 - (alpha + beta))
      }
      const longRunVol = opts.longRunVol ?? 0.19
      const annualVariance = longRunVol * longRunVol
      return annualVariance / tradingDaysPerYear
    })()

    const omega = opts.omega ?? longRunDailyVariance * (1 - (alpha + beta))
    const initialVariance = opts.initialVariance ?? longRunDailyVariance

    this.alpha = alpha
    this.beta = beta
    this.omega = omega
    this.mu = mu
    this.tradingDaysPerYear = tradingDaysPerYear
    this.longRunVariance = longRunDailyVariance
    this.variance = Math.max(initialVariance, 1e-10)
  }

  step(shock = normal()): GarchStepResult {
    const sigma = Math.sqrt(this.variance)
    const ret = this.mu + sigma * shock
    const nextVariance = this.omega + this.alpha * Math.pow(ret - this.mu, 2) + this.beta * this.variance
    this.variance = Math.max(nextVariance, 1e-10)
    this.lastReturn = ret
    return {
      variance: this.variance,
      annualizedVol: Math.sqrt(this.variance * this.tradingDaysPerYear),
      return: ret
    }
  }

  getVariance(): number {
    return this.variance
  }

  getAnnualizedVol(): number {
    return Math.sqrt(this.variance * this.tradingDaysPerYear)
  }

  getLongRunAnnualizedVol(): number {
    return Math.sqrt(this.longRunVariance * this.tradingDaysPerYear)
  }

  getLastReturn(): number {
    return this.lastReturn
  }

  forecastAverageVariance(days: number): number {
    if (days <= 1) {
      return this.variance
    }

    const meanReversion = this.alpha + this.beta
    let expectedVariance = this.variance
    let sum = 0

    for (let i = 0; i < days; i += 1) {
      sum += expectedVariance
      expectedVariance = this.omega + meanReversion * expectedVariance
    }

    return sum / days
  }

  forecastAnnualizedVol(days: number): number {
    const avgDailyVariance = this.forecastAverageVariance(days)
    return Math.sqrt(avgDailyVariance * this.tradingDaysPerYear)
  }
}

function normal(): number {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
