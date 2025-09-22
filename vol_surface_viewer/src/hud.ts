import type { SurfaceFrameStats } from './surfaceRenderer'
import type { SurfaceSnapshot } from './types'

export class Hud {
  private readonly el: HTMLElement
  private frame: SurfaceFrameStats | null = null
  private snapshot: SurfaceSnapshot | null = null
  private lastRender = 0

  constructor(el: HTMLElement) {
    this.el = el
  }

  setFrame(stats: SurfaceFrameStats) {
    this.frame = stats
    this.scheduleRender()
  }

  setSnapshot(snapshot: SurfaceSnapshot) {
    this.snapshot = snapshot
    this.scheduleRender()
  }

  private scheduleRender() {
    const now = performance.now()
    if (now - this.lastRender < 120) return
    this.lastRender = now
    this.render()
  }

  private render() {
    if (!this.frame || !this.snapshot) return

    const { fps, frameTime } = this.frame
    const sinceUpdate = Math.max(0, performance.now() - this.snapshot.timestamp)

    const lastVol = this.snapshot.vols[this.snapshot.vols.length - 1]

    this.el.innerHTML = `
      <div><strong>FPS</strong> ${fps.toFixed(1)}</div>
      <div><strong>Frame</strong> ${frameTime.toFixed(2)} ms</div>
      <div><strong>Feed Δ</strong> ${sinceUpdate.toFixed(0)} ms</div>
      <div><strong>Last vol</strong> ${(lastVol * 100).toFixed(2)}%</div>
    `
  }
}
