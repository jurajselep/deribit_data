export interface SurfaceSnapshot {
  cols: number
  rows: number
  maturities: Float32Array
  strikes: Float32Array
  vols: Float32Array
  timestamp: number
}

export type SnapshotListener = (snapshot: SurfaceSnapshot) => void
