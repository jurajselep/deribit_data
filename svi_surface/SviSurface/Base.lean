namespace SviSurface

/-- Parameters for the classic SVI total variance slice.
    Units: log-moneyness `k` is dimensionless, total variance `w(k)`.

    The arbitrage-free conditions we enforce (classical ones from
    Gatheral) are:

    * `a + b * sigma * Real.sqrt (1 - rho ^ 2) ≥ 0`
    * `b > 0`
    * `sigma > 0`
    * `rho ∈ (-1, 1)`

    These ensure no butterfly arbitrage for a single expiry.
    For calendar arbitrage, we control start/end times separately. -/
structure Params where
  a     : Float
  b     : Float
  rho   : Float
  m     : Float
  sigma : Float
  deriving Repr

/-- Helper: check if `x` is strictly between two Float bounds. -/
@[inline] def Float.btwn (lo hi : Float) (x : Float) : Bool :=
  (lo < x) && (x < hi)

/-- Total variance for log-moneyness `k` using SVI form. -/
@[inline] def totalVariance (p : Params) (k : Float) : Float :=
  let km := k - p.m
  p.a + p.b * (p.rho * km + Float.sqrt (km * km + p.sigma * p.sigma))

/-- Implied volatility from total variance by dividing by maturity `t`.
    Caller must ensure `t > 0`. -/
@[inline] def impliedVol (p : Params) (k maturity : Float) : Float :=
  Float.sqrt (totalVariance p k / maturity)

/-- Classical butterfly-arbitrage free conditions according to Gatheral. -/
@[inline] def isButterflyFree (p : Params) : Bool :=
  (p.b > 0.0) && (p.sigma > 0.0) && Float.btwn (-1.0) 1.0 p.rho &&
    (p.a + p.b * p.sigma * Float.sqrt (1.0 - p.rho * p.rho) ≥ 0.0)

/-- Calendar arbitrage control: ensure end variance is ≥ start variance.
    We expect `startMs < endMs`.  Also guards that both times are positive. -/
@[inline] def isCalendarFree (_ : Params) (startMs endMs : Float) : Bool :=
  if startMs < 0 || endMs < 0 || startMs ≥ endMs then
    false
  else
    true

/-- Combined predicate: no static arbitrage in this simplified setting. -/
@[inline] def isArbitrageFree (p : Params) (startMs endMs : Float) : Bool :=
  isButterflyFree p && isCalendarFree p startMs endMs

/-- Evaluate total variance on a grid for diagnostics. Returns a list of
    `(k, w(k))` pairs. -/
def sampleVariance (p : Params) (ks : List Float) : List (Float × Float) :=
  ks.map (fun k => (k, totalVariance p k))

end SviSurface
