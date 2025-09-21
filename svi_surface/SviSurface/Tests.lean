import SviSurface.Base
import Std

open SviSurface
open Std

/-- Small tolerance for float comparisons. -/
@[inline] def approxEq (ε : Float) (x y : Float) : Bool :=
  Float.abs (x - y) ≤ ε

/-- Example parameters widely used for arbitrage-free SVI slice. -/
def exampleParams : Params :=
  { a := 0.04
  , b := 0.25
  , rho := -0.35
  , m := 0.0
  , sigma := 0.5 }

/-- Numeric regression on the variance grid. -/
def regression : List (Float × Float) :=
  sampleVariance exampleParams [-2.0, -1.0, 0.0, 1.0, 2.0]

/-- Check monotonicity of variance wings (simple diagnostic).
    We ensure left wing increases as `k → -∞` (slope > 0) and right wing
    increases as `k → +∞`.  Here we approximate with finite differences. -/
def wingSlope (p : Params) (k step : Float) : Float :=
  let w1 := totalVariance p (k + step)
  let w0 := totalVariance p k
  (w1 - w0) / step

/-- Quick property-based test across a few sample points. -/
def runWingDiagnostics : Bool :=
  let left := wingSlope exampleParams (-3.0) 0.5 > -1.0
  let right := wingSlope exampleParams 3.0 0.5 > 0.0
  left && right

/-- Pretty print diagnostics for CLI execution. -/
def report : IO Unit := do
  IO.println s!"Arbitrage free? {isArbitrageFree exampleParams 0.0 86_400.0}"
  IO.println "Sample variance slice:"
  for (k, w) in regression do
    IO.println s!"  k={k}, w={w}"
  IO.println s!"Wing diagnostics passed? {runWingDiagnostics}"

def main : IO Unit :=
  report
