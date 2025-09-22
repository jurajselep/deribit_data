import { Hud } from './hud'
import { createRandomDataFeed } from './randomDataFeed'
import { SurfaceRenderer } from './surfaceRenderer'

async function bootstrap() {
  const canvas = document.getElementById('surface-canvas') as HTMLCanvasElement | null
  const hudEl = document.getElementById('hud') as HTMLDivElement | null

  if (!canvas || !hudEl) {
    throw new Error('Missing required DOM nodes')
  }

  const renderer = new SurfaceRenderer({ canvas })
  const hud = new Hud(hudEl)
  const feed = createRandomDataFeed({ intervalMs: 180 })

  renderer.onFrame((stats) => hud.setFrame(stats))

  const snapshot = await feed.ready
  renderer.syncSnapshot(snapshot)
  hud.setSnapshot(snapshot)
  renderer.start()
  feed.start()

  feed.subscribe((next) => {
    renderer.syncSnapshot(next)
    hud.setSnapshot(next)
  })
}

bootstrap().catch((err) => {
  console.error(err)
})
