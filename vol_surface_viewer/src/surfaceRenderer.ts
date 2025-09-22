import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { SurfaceSnapshot } from './types'

export interface SurfaceRendererOptions {
  canvas: HTMLCanvasElement
  zScale?: number
  pixelRatio?: number
}

export interface SurfaceFrameStats {
  fps: number
  frameTime: number
}

type FrameListener = (stats: SurfaceFrameStats) => void

type AxisKey = 'x' | 'y' | 'z'

interface AxisElements {
  key: AxisKey
  group: Group
  line: Line
  label: Sprite
  tickGroup: Group
  start: Vector3
  end: Vector3
  component: 0 | 1 | 2
  color: number
  tickNormal: Vector3
  tickLength: number
  tickLabelOffset: Vector3
  tickLines: Line[]
  tickLineMaterials: LineBasicMaterial[]
  tickLineGeometries: BufferGeometry[]
  tickSprites: Sprite[]
  tickSpriteMaterials: SpriteMaterial[]
  tickSpriteTextures: CanvasTexture[]
}

interface AxisScaleState {
  niceMin: number
  niceMax: number
  ticks: number[]
  axisStart: Vector3
  axisEnd: Vector3
  axisVector: Vector3
  component: 0 | 1 | 2
  rangeMin: number
  rangeMax: number
  span: number
  dataMin: number
  dataMax: number
}

interface AxisDefinition {
  key: AxisKey
  start: Vector3
  end: Vector3
  color: number
  label: string
  labelOffset: Vector3
  component: 0 | 1 | 2
  tickNormal: Vector3
  tickLength: number
  tickLabelOffset: Vector3
}

export class SurfaceRenderer {
  private readonly canvas: HTMLCanvasElement
  private readonly renderer: WebGLRenderer
  private readonly scene: Scene
  private readonly camera: PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly zScale: number
  private axesGroup: Group | null = null
  private axes: Record<AxisKey, AxisElements> | null = null
  private axisScales: Partial<Record<AxisKey, AxisScaleState>> = {}
  private axisMaterials: LineBasicMaterial[] = []
  private axisGeometries: BufferGeometry[] = []
  private labelMaterials: SpriteMaterial[] = []
  private labelTextures: CanvasTexture[] = []
  private geometry: BufferGeometry | null = null
  private mesh: Mesh | null = null
  private frameListeners = new Set<FrameListener>()
  private animationHandle = 0
  private lastFrameTime = performance.now()
  private fpsAccumulator = 0
  private fpsCounter = 0
  private lastVolRange: { min: number; max: number } | null = null

  constructor({ canvas, zScale = 18, pixelRatio }: SurfaceRendererOptions) {
    this.canvas = canvas
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.setPixelRatio(pixelRatio ?? Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight, false)

    this.scene = new Scene()
    this.scene.background = new Color(0x05070c)

    this.camera = new PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 240)
    this.camera.position.set(-18, 13, 24)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 8
    this.controls.maxDistance = 60
    this.controls.maxPolarAngle = Math.PI * 0.495
    this.controls.target.set(0, 0, 5)
    this.controls.update()

    this.zScale = zScale

    const ambient = new AmbientLight(0xffffff, 0.55)
    const directional = new DirectionalLight(0x84c6ff, 1.25)
    directional.position.set(8, 14, 10)
    directional.castShadow = false

    this.scene.add(ambient)
    this.scene.add(directional)

    this.axesGroup = this.buildAxes()
    this.scene.add(this.axesGroup)

    window.addEventListener('resize', this.handleResize)
  }

  dispose() {
    window.removeEventListener('resize', this.handleResize)
    this.stop()
    if (this.axesGroup) {
      this.scene.remove(this.axesGroup)
      this.axesGroup = null
    }
    if (this.axes) {
      Object.values(this.axes).forEach((axis) => this.clearAxisTicks(axis))
      this.axes = null
    }
    this.axisGeometries.forEach((geometry) => geometry.dispose())
    this.axisGeometries = []
    this.axisMaterials.forEach((material) => material.dispose())
    this.axisMaterials = []
    this.labelMaterials.forEach((material) => material.dispose())
    this.labelMaterials = []
    this.labelTextures.forEach((texture) => texture.dispose())
    this.labelTextures = []
    if (this.geometry) {
      this.geometry.dispose()
      this.geometry = null
    }
    if (this.mesh) {
      this.scene.remove(this.mesh)
      this.mesh.material.dispose()
      this.mesh = null
    }
    this.renderer.dispose()
  }

  onFrame(listener: FrameListener) {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  syncSnapshot(snapshot: SurfaceSnapshot) {
    if (!this.geometry) {
      this.bootstrapGeometry(snapshot)
    }

    const geometry = this.geometry!
    const positions = geometry.getAttribute('position') as BufferAttribute
    const colors = geometry.getAttribute('color') as BufferAttribute

    const { vols } = snapshot

    let min = Infinity
    let max = -Infinity
    const total = vols.length

    for (let i = 0; i < total; i += 1) {
      const v = vols[i]
      if (v < min) min = v
      if (v > max) max = v
    }

    const range = max - min || 1

    let zScale = this.axisScales.z
    const axes = this.axes

    const threshold = Math.max(0.004, range * 0.12)
    const lastRange = this.lastVolRange
    const needsRescale =
      !zScale ||
      !lastRange ||
      Math.abs(min - lastRange.min) > threshold ||
      Math.abs(max - lastRange.max) > threshold

    if (needsRescale && axes) {
      zScale = createAxisScaleState(axes.z, min, max, 6, {
        clampMin: 0,
        padding: 0.12
      })
      this.axisScales.z = zScale
      this.updateAxisTicks('z', zScale, formatVolTick)
    }

    if (zScale) {
      this.lastVolRange = { min, max }
    }

    for (let idx = 0; idx < total; idx += 1) {
      const zValue = zScale ? coordinateFor(zScale, vols[idx]) : ((vols[idx] - min) / range) * this.zScale
      positions.setZ(idx, zValue)

      const offset = idx * 3
      const normalized = (vols[idx] - min) / range
      encodeColor(normalized, colors.array as Float32Array, offset)
    }

    positions.needsUpdate = true
    colors.needsUpdate = true
    geometry.computeVertexNormals()
    const normals = geometry.getAttribute('normal')
    if (normals) {
      normals.needsUpdate = true
    }
  }

  start() {
    if (this.animationHandle) return
    const loop = (time: number) => {
      this.animationHandle = this.renderer.setAnimationLoop(loop)
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
      this.reportFrame(time)
    }
    this.animationHandle = this.renderer.setAnimationLoop(loop)
  }

  stop() {
    if (!this.animationHandle) return
    this.renderer.setAnimationLoop(null)
    this.animationHandle = 0
  }

  private reportFrame(time: number) {
    const delta = time - this.lastFrameTime
    this.lastFrameTime = time
    this.fpsAccumulator += delta
    this.fpsCounter += 1

    if (this.fpsAccumulator >= 500) {
      const fps = (this.fpsCounter / this.fpsAccumulator) * 1000
      const frameTime = this.fpsAccumulator / this.fpsCounter
      this.frameListeners.forEach((listener) => listener({ fps, frameTime }))
      this.fpsAccumulator = 0
      this.fpsCounter = 0
    }
  }

  private bootstrapGeometry(snapshot: SurfaceSnapshot) {
    const axes = this.axes
    if (!axes) {
      throw new Error('Axes must be initialised before geometry bootstrap')
    }

    const { cols, rows, maturities, strikes, vols } = snapshot
    const vertices = cols * rows
    const geometry = new BufferGeometry()

    const maturityStats = computeArrayStats(maturities)
    const strikeStats = computeArrayStats(strikes)
    const volStats = computeArrayStats(vols)

    const xScale = createAxisScaleState(axes.x, maturityStats.min, maturityStats.max, 6, {
      clampMin: 0,
      padding: 0.02
    })
    const yScale = createAxisScaleState(axes.y, strikeStats.min, strikeStats.max, 7, {
      padding: 0.05
    })
    const zScale = createAxisScaleState(axes.z, volStats.min, volStats.max, 6, {
      clampMin: 0,
      padding: 0.12
    })

    this.axisScales.x = xScale
    this.axisScales.y = yScale
    this.axisScales.z = zScale
    this.lastVolRange = { min: volStats.min, max: volStats.max }

    this.updateAxisTicks('x', xScale, formatMaturityTick)
    this.updateAxisTicks('y', yScale, formatStrikeTick)
    this.updateAxisTicks('z', zScale, formatVolTick)

    const positions = new Float32Array(vertices * 3)
    const colors = new Float32Array(vertices * 3)

    const xCoordinates = new Float32Array(cols)
    for (let x = 0; x < cols; x += 1) {
      xCoordinates[x] = coordinateFor(xScale, maturities[x])
    }

    const yCoordinates = new Float32Array(rows)
    for (let y = 0; y < rows; y += 1) {
      yCoordinates[y] = coordinateFor(yScale, strikes[y])
    }

    for (let x = 0; x < cols; x += 1) {
      for (let y = 0; y < rows; y += 1) {
        const idx = x * rows + y
        positions[idx * 3 + 0] = xCoordinates[x]
        positions[idx * 3 + 1] = yCoordinates[y]
        positions[idx * 3 + 2] = coordinateFor(zScale, vols[idx])
        colors[idx * 3 + 0] = 0.1
        colors[idx * 3 + 1] = 0.3
        colors[idx * 3 + 2] = 0.9
      }
    }

    const indices = new Uint32Array((cols - 1) * (rows - 1) * 6)
    let offset = 0
    for (let x = 0; x < cols - 1; x += 1) {
      for (let y = 0; y < rows - 1; y += 1) {
        const a = x * rows + y
        const b = (x + 1) * rows + y
        const c = (x + 1) * rows + (y + 1)
        const d = x * rows + (y + 1)

        indices[offset + 0] = a
        indices[offset + 1] = b
        indices[offset + 2] = d
        indices[offset + 3] = b
        indices[offset + 4] = c
        indices[offset + 5] = d
        offset += 6
      }
    }

    geometry.setIndex(new BufferAttribute(indices, 1))
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    geometry.setAttribute('color', new BufferAttribute(colors, 3))

    const material = new MeshStandardMaterial({
      metalness: 0.0,
      roughness: 0.42,
      vertexColors: true,
      flatShading: true,
      transparent: true,
      opacity: 0.95
    })

    const mesh = new Mesh(geometry, material)
    mesh.castShadow = false
    mesh.receiveShadow = true

    this.scene.add(mesh)
    this.geometry = geometry
    this.mesh = mesh
  }

  private buildAxes() {
    const axesGroup = new Group()
    axesGroup.renderOrder = -1

    const origin = new Vector3(-10, -8, 0)
    const axisDefinitions: AxisDefinition[] = [
      {
        key: 'x',
        start: origin.clone(),
        end: new Vector3(10, -8, 0),
        color: 0x59b2ff,
        label: 'Maturity',
        labelOffset: new Vector3(1.8, 0.6, 0.4),
        component: 0,
        tickNormal: new Vector3(0, 1, 0),
        tickLength: 0.68,
        tickLabelOffset: new Vector3(0, 1.18, 0)
      },
      {
        key: 'y',
        start: origin.clone(),
        end: new Vector3(-10, 8, 0),
        color: 0x5cf0b5,
        label: 'Strike moneyness',
        labelOffset: new Vector3(0.6, 1.8, 0.4),
        component: 1,
        tickNormal: new Vector3(1, 0, 0),
        tickLength: 0.68,
        tickLabelOffset: new Vector3(1.1, 0, 0)
      },
      {
        key: 'z',
        start: origin.clone(),
        end: new Vector3(-10, -8, this.zScale),
        color: 0xffa629,
        label: 'Implied vol',
        labelOffset: new Vector3(0.8, 0.6, 1.6),
        component: 2,
        tickNormal: new Vector3(1, 0, 0),
        tickLength: 0.68,
        tickLabelOffset: new Vector3(1.15, 0, 0)
      }
    ]

    const axes: Partial<Record<AxisKey, AxisElements>> = {}

    axisDefinitions.forEach((definition) => {
      const axis = this.createAxis(definition)
      axes[definition.key] = axis
      axesGroup.add(axis.group)
    })

    this.axes = axes as Record<AxisKey, AxisElements>
    return axesGroup
  }

  private createAxis(definition: AxisDefinition): AxisElements {
    const geometry = new BufferGeometry().setFromPoints([definition.start.clone(), definition.end.clone()])
    const material = new LineBasicMaterial({ color: definition.color, linewidth: 1.5 })
    const line = new Line(geometry, material)
    line.frustumCulled = false

    this.axisGeometries.push(geometry)
    this.axisMaterials.push(material)

    const { sprite, material: spriteMaterial, texture } = createLabelSprite(definition.label, definition.color)
    sprite.position.copy(definition.end).add(definition.labelOffset)

    this.labelMaterials.push(spriteMaterial)
    this.labelTextures.push(texture)

    const tickGroup = new Group()
    const group = new Group()
    group.add(line)
    group.add(sprite)
    group.add(tickGroup)

    return {
      key: definition.key,
      group,
      line,
      label: sprite,
      tickGroup,
      start: definition.start.clone(),
      end: definition.end.clone(),
      component: definition.component,
      color: definition.color,
      tickNormal: definition.tickNormal.clone().normalize(),
      tickLength: definition.tickLength,
      tickLabelOffset: definition.tickLabelOffset.clone(),
      tickLines: [],
      tickLineMaterials: [],
      tickLineGeometries: [],
      tickSprites: [],
      tickSpriteMaterials: [],
      tickSpriteTextures: []
    }
  }

  private clearAxisTicks(axis: AxisElements) {
    axis.tickLines.forEach((tickLine) => {
      axis.tickGroup.remove(tickLine)
    })
    axis.tickLineGeometries.forEach((geometry) => geometry.dispose())
    axis.tickLineMaterials.forEach((material) => material.dispose())
    axis.tickSprites.forEach((sprite) => {
      axis.tickGroup.remove(sprite)
    })
    axis.tickSpriteMaterials.forEach((material) => material.dispose())
    axis.tickSpriteTextures.forEach((texture) => texture.dispose())

    axis.tickLines = []
    axis.tickLineGeometries = []
    axis.tickLineMaterials = []
    axis.tickSprites = []
    axis.tickSpriteMaterials = []
    axis.tickSpriteTextures = []
  }

  private updateAxisTicks(axisKey: AxisKey, scale: AxisScaleState | undefined, formatter: (value: number) => string) {
    if (!scale) return
    const axis = this.axes?.[axisKey]
    if (!axis) return

    this.clearAxisTicks(axis)

    if (!Number.isFinite(scale.span) || scale.span <= 0 || scale.ticks.length === 0) {
      return
    }

    const maxTicks = Math.min(scale.ticks.length, 12)

    for (let i = 0; i < maxTicks; i += 1) {
      const value = scale.ticks[i]
      if (i > 0 && Math.abs(value - scale.ticks[i - 1]) < 1e-6) continue
      const label = formatter(value)
      if (!label) continue

      const basePosition = positionFor(scale, value)
      const tickEnd = basePosition.clone().addScaledVector(axis.tickNormal, axis.tickLength)

      const tickGeometry = new BufferGeometry().setFromPoints([basePosition.clone(), tickEnd])
      const tickMaterial = new LineBasicMaterial({ color: axis.color, linewidth: 1 })
      const tickLine = new Line(tickGeometry, tickMaterial)
      tickLine.frustumCulled = false

      axis.tickGroup.add(tickLine)
      axis.tickLines.push(tickLine)
      axis.tickLineGeometries.push(tickGeometry)
      axis.tickLineMaterials.push(tickMaterial)

      const tickLabel = createTickLabelSprite(label, axis.color)
      tickLabel.sprite.position.copy(basePosition).add(axis.tickLabelOffset)
      axis.tickGroup.add(tickLabel.sprite)
      axis.tickSprites.push(tickLabel.sprite)
      axis.tickSpriteMaterials.push(tickLabel.material)
      axis.tickSpriteTextures.push(tickLabel.texture)
    }
  }

  private handleResize = () => {
    const width = window.innerWidth
    const height = window.innerHeight
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }
}

const COLD = new Color('#1a75ff')
const MID = new Color('#8ef5ff')
const HOT = new Color('#ff9f1c')
const EXTREME = new Color('#ef476f')

const cold = COLD.toArray()
const mid = MID.toArray()
const hot = HOT.toArray()
const extreme = EXTREME.toArray()

function encodeColor(value: number, target: Float32Array, offset: number) {
  if (value < 0.33) {
    const t = value / 0.33
    target[offset + 0] = cold[0] + (mid[0] - cold[0]) * t
    target[offset + 1] = cold[1] + (mid[1] - cold[1]) * t
    target[offset + 2] = cold[2] + (mid[2] - cold[2]) * t
    return
  }

  if (value < 0.66) {
    const t = (value - 0.33) / 0.33
    target[offset + 0] = mid[0] + (hot[0] - mid[0]) * t
    target[offset + 1] = mid[1] + (hot[1] - mid[1]) * t
    target[offset + 2] = mid[2] + (hot[2] - mid[2]) * t
    return
  }

  const t = (value - 0.66) / 0.34
  target[offset + 0] = hot[0] + (extreme[0] - hot[0]) * t
  target[offset + 1] = hot[1] + (extreme[1] - hot[1]) * t
  target[offset + 2] = hot[2] + (extreme[2] - hot[2]) * t
}

function coordinateFor(scale: AxisScaleState, value: number): number {
  if (!Number.isFinite(value)) return scale.rangeMin
  const span = scale.span || 1
  let t = (value - scale.niceMin) / span
  t = clamp01(t)
  return scale.rangeMin + (scale.rangeMax - scale.rangeMin) * t
}

function positionFor(scale: AxisScaleState, value: number, target = new Vector3()): Vector3 {
  const span = scale.span || 1
  let t = (value - scale.niceMin) / span
  t = clamp01(t)
  return target.copy(scale.axisStart).addScaledVector(scale.axisVector, t)
}

function clamp01(value: number): number {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function computeArrayStats(values: ArrayLike<number>): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  const length = values.length
  for (let i = 0; i < length; i += 1) {
    const v = values[i]
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 }
  }
  if (min === max) {
    const pad = Math.abs(min) > 1e-6 ? Math.abs(min) * 0.1 : 0.1
    return { min: min - pad, max: max + pad }
  }
  return { min, max }
}

function createAxisScaleState(
  axis: AxisElements,
  dataMin: number,
  dataMax: number,
  tickCount: number,
  options: { clampMin?: number; clampMax?: number; padding?: number } = {}
): AxisScaleState {
  const padding = options.padding ?? 0
  const { niceMin, niceMax, step } = computeNiceRange(dataMin, dataMax, tickCount, padding)

  let minValue = niceMin
  let maxValue = niceMax

  if (options.clampMin !== undefined) {
    minValue = Math.max(minValue, options.clampMin)
  }
  if (options.clampMax !== undefined) {
    maxValue = Math.min(maxValue, options.clampMax)
  }

  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    minValue = 0
    maxValue = 1
  }

  if (maxValue <= minValue) {
    const delta = Math.abs(maxValue) > 1e-6 ? Math.abs(maxValue) * 0.2 : 0.2
    minValue -= delta
    maxValue += delta
  }

  const ticks = generateTicks(minValue, maxValue, step, tickCount)
  const axisVector = new Vector3().subVectors(axis.end, axis.start)

  return {
    niceMin: minValue,
    niceMax: maxValue,
    ticks,
    axisStart: axis.start.clone(),
    axisEnd: axis.end.clone(),
    axisVector,
    component: axis.component,
    rangeMin: axis.start.getComponent(axis.component),
    rangeMax: axis.end.getComponent(axis.component),
    span: maxValue - minValue || 1,
    dataMin,
    dataMax
  }
}

function computeNiceRange(min: number, max: number, tickCount: number, paddingRatio: number): {
  niceMin: number
  niceMax: number
  step: number
} {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { niceMin: 0, niceMax: 1, step: 0.25 }
  }

  if (min === max) {
    const pad = Math.abs(min) > 1e-6 ? Math.abs(min) * 0.2 : 0.2
    min -= pad
    max += pad
  }

  if (paddingRatio > 0) {
    const span = max - min
    const pad = span * paddingRatio
    min -= pad
    max += pad
  }

  const span = max - min
  const niceSpan = niceNum(span, false)
  const step = niceNum(niceSpan / Math.max(1, tickCount - 1), true)
  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  return { niceMin, niceMax, step }
}

function niceNum(range: number, round: boolean): number {
  if (!Number.isFinite(range) || range <= 0) {
    return 0
  }
  const exponent = Math.floor(Math.log10(range))
  const fraction = range / Math.pow(10, exponent)
  let niceFraction
  if (round) {
    if (fraction < 1.5) niceFraction = 1
    else if (fraction < 3) niceFraction = 2
    else if (fraction < 7) niceFraction = 5
    else niceFraction = 10
  } else {
    if (fraction <= 1) niceFraction = 1
    else if (fraction <= 2) niceFraction = 2
    else if (fraction <= 5) niceFraction = 5
    else niceFraction = 10
  }
  return niceFraction * Math.pow(10, exponent)
}

function generateTicks(start: number, end: number, step: number, desiredCount: number): number[] {
  if (!Number.isFinite(step) || step <= 0) {
    return [Number(start.toFixed(4)), Number(end.toFixed(4))]
  }
  const ticks: number[] = []
  const epsilon = step * 1e-6
  const maxIterations = Math.max(desiredCount * 2, 12)
  let value = start
  let iterations = 0
  while (value <= end + epsilon && iterations < maxIterations) {
    ticks.push(Number(value.toFixed(6)))
    value += step
    iterations += 1
  }
  if (ticks.length === 0) {
    ticks.push(Number(start.toFixed(6)))
    ticks.push(Number(end.toFixed(6)))
  }
  const last = ticks[ticks.length - 1]
  if (Math.abs(last - end) > epsilon) {
    ticks.push(Number(end.toFixed(6)))
  }
  return ticks
}

function formatMaturityTick(value: number): string {
  if (!Number.isFinite(value)) return ''
  if (value <= 0) return '0d'
  if (value >= 1) {
    const decimals = value >= 3 ? 0 : 1
    return `${value.toFixed(decimals)}y`
  }
  const months = value * 12
  if (months >= 2) {
    return `${Math.round(months)}m`
  }
  const days = Math.max(1, Math.round(value * 252))
  return `${days}d`
}

function formatStrikeTick(value: number): string {
  if (!Number.isFinite(value)) return ''
  const pct = value * 100
  const decimals = Math.abs(pct) < 15 ? 1 : 0
  return `${pct.toFixed(decimals)}%`
}

function formatVolTick(value: number): string {
  if (!Number.isFinite(value)) return ''
  const pct = value * 100
  const decimals = Math.abs(pct) >= 45 ? 0 : 1
  return `${pct.toFixed(decimals)}%`
}

function createLabelSprite(text: string, color: number) {
  const canvas = document.createElement('canvas')
  const ratio = window.devicePixelRatio || 1
  const width = 256 * ratio
  const height = 128 * ratio
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('2D canvas is not supported in this environment')
  }

  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.scale(ratio, ratio)
  context.fillStyle = 'rgba(6, 9, 16, 0.76)'
  context.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  context.lineWidth = 2
  drawRoundedRect(context, 6, 6, 244, 88, 22)
  context.fill()
  context.stroke()

  context.font = '600 24px "Inter", "Segoe UI", sans-serif'
  context.fillStyle = `#${color.toString(16).padStart(6, '0')}`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(text, 128, 50)

  const texture = new CanvasTexture(canvas)
  texture.needsUpdate = true
  texture.anisotropy = 4

  const material = new SpriteMaterial({
    map: texture,
    depthWrite: false,
    depthTest: false,
    transparent: true
  })

  const sprite = new Sprite(material)
  sprite.scale.set(6, 2.4, 1)

  return { sprite, material, texture }
}

function createTickLabelSprite(text: string, color: number) {
  const canvas = document.createElement('canvas')
  const ratio = window.devicePixelRatio || 1
  const width = 192 * ratio
  const height = 96 * ratio
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('2D canvas is not supported in this environment')
  }

  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.scale(ratio, ratio)
  context.fillStyle = 'rgba(7, 11, 18, 0.82)'
  context.strokeStyle = 'rgba(255, 255, 255, 0.06)'
  context.lineWidth = 1.6
  drawRoundedRect(context, 8, 10, 168, 60, 16)
  context.fill()
  context.stroke()

  context.font = '500 20px "Inter", "Segoe UI", sans-serif'
  context.fillStyle = `#${color.toString(16).padStart(6, '0')}`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(text, 92, 40)

  const texture = new CanvasTexture(canvas)
  texture.needsUpdate = true
  texture.anisotropy = 2

  const material = new SpriteMaterial({
    map: texture,
    depthWrite: false,
    depthTest: false,
    transparent: true
  })

  const sprite = new Sprite(material)
  sprite.scale.set(2.6, 0.9, 1)

  return { sprite, material, texture }
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + r)
  ctx.lineTo(x + width, y + height - r)
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  ctx.lineTo(x + r, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}
