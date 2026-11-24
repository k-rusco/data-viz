import * as THREE from "three"
import type { Dataset, ViewState } from "./types"
import { fromWorld, toWorld, worldHeight } from "./geo"
import { annual, lastYear, lengthKm, mass, passes, type Ice } from "./model"

const ICE = new THREE.Color("#f4f7f8")
const LOSS = new THREE.Color("#7b0000")
const GAIN = new THREE.Color("#6d838c")
const STILL = new THREE.Color("#d5d0c8")
const MIN_PHI = 0.06
const MAX_PHI = 1.32

export type SceneHooks = {
  onZoom: (zoom: number) => void
  onFocus: (id: string | null) => void
  onHover: (id: string | null) => void
  onMassif: (id: string | null) => void
  onEnter: () => void
}

type Overlay = { labels: HTMLDivElement; compass: HTMLDivElement }

type Body = {
  ice: Ice
  group: THREE.Group
  tongue: THREE.Mesh
  ghost: THREE.Mesh
  scar: THREE.Mesh
  pick: THREE.Mesh
  shown: number
}

type RiverView = {
  basin: string
  name: string
  mid: THREE.Vector3
  curve: THREE.CatmullRomCurve3
  tube: THREE.Mesh
  points: THREE.Points
  phases: Float32Array
}

function damp(current: number, target: number, lambda: number, dt: number) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt))
}

function dampAngle(current: number, target: number, lambda: number, dt: number) {
  let delta = target - current
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return current + delta * (1 - Math.exp(-lambda * dt))
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function tongueGeometry(seed: number) {
  const along = 26
  const across = 9
  const rand = mulberry(seed)
  const bow = Array.from({ length: along + 1 }, () => (rand() - 0.5) * 0.035)
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i <= along; i++) {
    const t = i / along
    const half = 0.5 * Math.pow(1 - t, 0.62)
    const crest = Math.pow(1 - t, 0.75)
    for (let j = 0; j <= across; j++) {
      const u = j / across
      const side = (u - 0.5) * 2
      const x = side * half + bow[i] * Math.sin(Math.PI * t)
      const arch = 1 - side * side
      const groove = Math.exp(-Math.pow(side * 2.4, 2)) * 0.18
      const y = Math.max(0, crest * arch * 0.14 * (1 - groove * 0.35))
      positions.push(x, y, -t)
    }
  }
  const row = across + 1
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < across; j++) {
      const a = i * row + j
      indices.push(a, a + 1, a + row, a + 1, a + row + 1, a + row)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

function mulberry(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashId(id: string) {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function levelOf(zoom: number) {
  if (zoom < 0.28) return 0
  if (zoom < 0.52) return 1
  if (zoom < 0.78) return 2
  return 3
}

export class GlacierView {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private clock = new THREE.Clock()
  private bodies: Body[]
  private byId = new Map<string, Body>()
  private rivers: RiverView[] = []
  private riverRoot = new THREE.Group()
  private reliefMat: THREE.ShaderMaterial
  private core: THREE.InstancedMesh
  private coreGroup = new THREE.Group()
  private ring: THREE.Mesh
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private ndc = new THREE.Vector2()
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private hit = new THREE.Vector3()
  private grab = new THREE.Vector3()
  private target = new THREE.Vector3()
  private offset = new THREE.Vector3()
  private lockId: string | null = null
  private bounds = { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity }
  private shownTarget = new THREE.Vector3()
  private look = new THREE.Vector3()
  private dummy = new THREE.Object3D()
  private proj = new THREE.Vector3()
  private color = new THREE.Color()
  private labelPool: HTMLDivElement[] = []
  private decadeMarks: { year: number; y: number }[] = []
  private coreAnchor = new THREE.Vector3()
  private hooks: SceneHooks = {
    onZoom: () => {},
    onFocus: () => {},
    onHover: () => {},
    onMassif: () => {},
    onEnter: () => {},
  }
  private state: ViewState
  private query = ""
  private shownZoom: number
  private zoomTarget = 0.04
  private reportedZoom = 0.04
  private shownYear: number
  private shownRelief = 0
  private userAz = 0
  private userTilt = 0
  private az = 0
  private phi = 0.04
  private dist = 48
  private dragging = false
  private mode: "orbit" | "pan" = "orbit"
  private armed = false
  private moved = false
  private downX = 0
  private downY = 0
  private lastX = 0
  private lastY = 0
  private azVel = 0
  private phiVel = 0
  private hoverId: string | null = null
  private lastMassif: string | null = null
  private focusGuard = false
  private clearGuard = false
  private builtYear = -1
  private builtId: string | null = null
  private riverYear = -1
  private overlay: Overlay | null = null
  private compassRotor: HTMLDivElement | null = null
  private compassLetter: HTMLSpanElement | null = null
  private compassRead: HTMLParagraphElement | null = null
  private frame = 0
  private disposed = false
  private width = 1
  private height = 1

  constructor(
    private canvas: HTMLCanvasElement,
    private data: Dataset,
    private glaciers: Ice[],
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    this.renderer.setClearColor(0xffffff, 1)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 220)
    this.state = {
      screen: "landing",
      projection: "2d",
      rivers: false,
      year: data.yearMax,
      zoom: 0.04,
      glacierId: null,
      basin: "all",
      massOnly: false,
      query: "",
    }
    this.shownZoom = 0.04
    this.shownYear = data.yearMax
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xe7e2dc, 0.92))
    const sun = new THREE.DirectionalLight(0xffffff, 1.45)
    sun.position.set(-14, 22, 10)
    this.scene.add(sun)
    const fill = new THREE.DirectionalLight(0xf7f5f2, 0.38)
    fill.position.set(12, 8, -10)
    this.scene.add(fill)

    const { plinth, reliefMat } = this.buildLand()
    this.reliefMat = reliefMat
    this.scene.add(plinth)

    this.bodies = this.glaciers.map((ice) => this.buildBody(ice))
    for (const body of this.bodies) this.byId.set(body.ice.id, body)

    this.core = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0 }),
      180,
    )
    this.core.count = 0
    this.coreGroup.add(this.core)
    this.scene.add(this.coreGroup)

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 0.8, 64),
      new THREE.MeshBasicMaterial({ color: 0x7b0000, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
    )
    this.ring.rotation.x = -Math.PI / 2
    this.ring.visible = false
    this.scene.add(this.ring)

    this.buildRivers()
    this.scene.add(this.riverRoot)

    this.resize()
    window.addEventListener("resize", this.resize)
    this.canvas.addEventListener("pointerdown", this.onPointerDown)
    this.canvas.addEventListener("contextmenu", this.onContextMenu)
    window.addEventListener("pointermove", this.onPointerMove)
    window.addEventListener("pointerup", this.onPointerUp)
    window.addEventListener("wheel", this.onWheel, { passive: false })
    this.frame = requestAnimationFrame(this.animate)
  }

  setHooks(hooks: SceneHooks) {
    this.hooks = hooks
  }

  attach(overlay: Overlay) {
    this.overlay = overlay
    overlay.compass.replaceChildren()
    const rotor = document.createElement("div")
    rotor.className = "compass-rotor"
    const letter = document.createElement("span")
    letter.className = "compass-n"
    letter.textContent = "N"
    rotor.appendChild(letter)
    const read = document.createElement("p")
    read.className = "compass-read"
    const hint = document.createElement("p")
    hint.className = "compass-hint"
    hint.textContent = "Drag to orbit · Right-drag to pan"
    overlay.compass.append(rotor, read, hint)
    this.compassRotor = rotor
    this.compassLetter = letter
    this.compassRead = read
  }

  apply(state: ViewState) {
    const entered = this.state.screen === "landing" && state.screen === "explore"
    this.state = state
    this.query = state.query.trim().toLowerCase()
    if (Math.abs(state.zoom - this.reportedZoom) > 0.0008) {
      this.zoomTarget = state.zoom
      this.reportedZoom = state.zoom
      if (state.zoom < 0.12) this.recenter()
    }
    if (entered) this.userTilt = 0
    if (state.screen === "landing") {
      this.userAz = 0
      this.userTilt = 0
      this.zoomTarget = 0.04
      this.recenter()
    }
  }

  private recenter() {
    this.target.set(0, this.target.y, 0.15)
    this.offset.set(0, 0, 0)
  }

  private moveTarget(dx: number, dz: number) {
    const { minX, maxX, minZ, maxZ } = this.bounds
    const x = Math.min(maxX, Math.max(minX, this.target.x + dx))
    const z = Math.min(maxZ, Math.max(minZ, this.target.z + dz))
    if (this.lockId) {
      this.offset.x += x - this.target.x
      this.offset.z += z - this.target.z
    }
    this.target.x = x
    this.target.z = z
  }

  private groundAt(clientX: number, clientY: number, out: THREE.Vector3) {
    const rect = this.canvas.getBoundingClientRect()
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.camera)
    this.plane.constant = -this.look.y
    return this.raycaster.ray.intersectPlane(this.plane, out)
  }

  private baseTilt(zoom: number) {
    return lerp(0.68, 1.02, smoothstep(0.58, 0.86, zoom))
  }

  private clampTilt() {
    const base = this.baseTilt(this.shownZoom)
    this.userTilt = Math.min(MAX_PHI - base, Math.max(MIN_PHI - base, this.userTilt))
  }

  private setZoom(zoom: number) {
    this.zoomTarget = Math.min(1, Math.max(0, zoom))
    this.reportedZoom = this.zoomTarget
    this.hooks.onZoom(this.zoomTarget)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    window.removeEventListener("resize", this.resize)
    this.canvas.removeEventListener("pointerdown", this.onPointerDown)
    this.canvas.removeEventListener("contextmenu", this.onContextMenu)
    window.removeEventListener("pointermove", this.onPointerMove)
    window.removeEventListener("pointerup", this.onPointerUp)
    window.removeEventListener("wheel", this.onWheel)
    this.renderer.dispose()
  }

  private resize = () => {
    const rect = this.canvas.getBoundingClientRect()
    this.width = Math.max(1, rect.width)
    this.height = Math.max(1, rect.height)
    this.camera.aspect = this.width / this.height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(this.width, this.height, false)
  }

  private buildLand() {
    const outer = this.data.outline.map(([lon, lat]) => {
      const [x, z] = toWorld(lon, lat)
      return new THREE.Vector2(x, -z)
    })
    const shape = new THREE.Shape(outer)
    for (const hole of this.data.holes) {
      const path = new THREE.Path(
        hole.map(([lon, lat]) => {
          const [x, z] = toWorld(lon, lat)
          return new THREE.Vector2(x, -z)
        }),
      )
      shape.holes.push(path)
    }
    const plinthGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.045, bevelEnabled: false })
    plinthGeo.rotateX(-Math.PI / 2)
    plinthGeo.translate(0, -0.045, 0)
    const plinth = new THREE.Mesh(
      plinthGeo,
      new THREE.MeshBasicMaterial({ color: 0xc9c7c3 }),
    )

    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const [lon, lat] of this.data.outline) {
      const [x, z] = toWorld(lon, lat)
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
    }
    this.bounds = { minX, maxX, minZ, maxZ }
    const pad = 0.4
    minX -= pad
    maxX += pad
    minZ -= pad
    maxZ += pad
    const cols = 180
    const rows = 120
    const relief = new THREE.PlaneGeometry(maxX - minX, maxZ - minZ, cols, rows)
    relief.rotateX(-Math.PI / 2)
    const pos = relief.attributes.position
    const elev = new Float32Array(pos.count)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + (minX + maxX) / 2
      const z = pos.getZ(i) + (minZ + maxZ) / 2
      pos.setX(i, x)
      pos.setZ(i, z)
      const [lon, lat] = fromWorld(x, z)
      elev[i] = worldHeight(lat, lon)
      pos.setY(i, elev[i])
    }
    relief.computeVertexNormals()
    for (let i = 0; i < pos.count; i++) pos.setY(i, 0)
    pos.needsUpdate = true
    relief.setAttribute("elev", new THREE.BufferAttribute(elev, 1))
    const uv = relief.attributes.uv
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, (pos.getX(i) - minX) / (maxX - minX), (pos.getZ(i) - minZ) / (maxZ - minZ))
    }
    uv.needsUpdate = true
    relief.computeBoundingSphere()

    const mask = document.createElement("canvas")
    mask.width = 1024
    mask.height = 1024
    const ctx = mask.getContext("2d")
    if (!ctx) throw new Error("Could not draw the country mask")
    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, mask.width, mask.height)
    ctx.fillStyle = "#fff"
    const paint = (ring: [number, number][]) => {
      ring.forEach(([lon, lat], index) => {
        const [x, z] = toWorld(lon, lat)
        const u = (x - minX) / (maxX - minX)
        const v = (z - minZ) / (maxZ - minZ)
        const px = u * mask.width
        const py = (1 - v) * mask.height
        if (index === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.closePath()
    }
    ctx.beginPath()
    paint(this.data.outline)
    for (const hole of this.data.holes) paint(hole)
    ctx.fill("evenodd")
    const maskTex = new THREE.CanvasTexture(mask)
    maskTex.colorSpace = THREE.NoColorSpace
    maskTex.flipY = true

    const reliefMat = new THREE.ShaderMaterial({
      uniforms: { uRelief: { value: 0 }, uMask: { value: maskTex } },
      vertexShader: `
        attribute float elev;
        uniform float uRelief;
        varying vec3 vNormal;
        varying float vElev;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec3 p = position;
          p.y += elev * uRelief + 0.025;
          vNormal = normalize(mat3(modelMatrix) * normal);
          vElev = elev;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        varying float vElev;
        varying vec2 vUv;
        uniform float uRelief;
        uniform sampler2D uMask;
        void main() {
          if (texture2D(uMask, vUv).r < 0.45) discard;
          vec3 n = normalize(mix(vec3(0.0, 1.0, 0.0), normalize(vNormal), clamp(uRelief, 0.0, 1.0)));
          vec3 light = normalize(vec3(-0.45, 0.82, 0.32));
          float shade = clamp(dot(n, light), 0.0, 1.0);
          float fill = clamp(dot(n, normalize(vec3(0.4, 0.35, -0.5))), 0.0, 1.0);
          vec3 base = vec3(0.775, 0.768, 0.745);
          vec3 col = base * (0.58 + shade * 0.55 + fill * 0.08);
          col *= mix(0.93, 1.0, clamp(vElev * 0.9, 0.0, 1.0));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
    this.scene.add(new THREE.Mesh(relief, reliefMat))
    return { plinth, reliefMat }
  }

  private buildBody(ice: Ice): Body {
    const geo = tongueGeometry(hashId(ice.id))
    const tongue = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: ICE.clone(),
        roughness: 0.46,
        metalness: 0.04,
        side: THREE.DoubleSide,
      }),
    )
    const ghost = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0xf7f7f5, transparent: true, opacity: 0.28, depthWrite: false }),
    )
    const scar = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.018, 1),
      new THREE.MeshBasicMaterial({ color: LOSS.clone(), transparent: true, opacity: 0.82 }),
    )
    const pick = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 10, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
    )
    const group = new THREE.Group()
    group.position.set(ice.x, 0.04, ice.z)
    group.rotation.order = "YXZ"
    group.rotation.y = ice.yaw
    group.add(tongue, ghost, scar, pick)
    tongue.userData.pick = ice.id
    pick.userData.pick = ice.id
    this.scene.add(group)
    return { ice, group, tongue, ghost, scar, pick, shown: lengthKm(ice, this.data.yearMax) / 10 }
  }

  private buildRivers() {
    const mat = new THREE.MeshBasicMaterial({ color: 0x242424, transparent: true, opacity: 0.55 })
    const pointMat = new THREE.PointsMaterial({
      color: 0x7b0000,
      size: 0.07,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    })
    for (const river of this.data.rivers) {
      const pts = river.path.map(([lon, lat]) => {
        const [x, z] = toWorld(lon, lat)
        return new THREE.Vector3(x, worldHeight(lat, lon) * 0.92 + 0.08, z)
      })
      const curve = new THREE.CatmullRomCurve3(pts)
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.02, 5, false), mat.clone())
      const count = 28
      const phases = new Float32Array(count)
      for (let i = 0; i < count; i++) phases[i] = i / count
      const points = new THREE.Points(new THREE.BufferGeometry(), pointMat.clone())
      points.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3))
      const mid = curve.getPoint(0.45)
      this.riverRoot.add(tube, points)
      this.rivers.push({ basin: river.basin, name: river.name, mid, curve, tube, points, phases })
    }
  }

  private visible(ice: Ice) {
    return passes(ice, this.state.basin, this.state.massOnly, this.query)
  }

  private nearest(point: THREE.Vector3, radius: number) {
    let best: Body | null = null
    let bestD = radius * radius
    for (const body of this.bodies) {
      if (!this.visible(body.ice)) continue
      const dx = body.ice.x - point.x
      const dz = body.ice.z - point.z
      const d = dx * dx + dz * dz
      if (d < bestD) {
        bestD = d
        best = body
      }
    }
    return best
  }

  private onContextMenu = (event: MouseEvent) => {
    event.preventDefault()
  }

  private onPointerDown = (event: PointerEvent) => {
    if (this.dragging) return
    if (event.button === 1) event.preventDefault()
    const wantsPan = event.button === 1 || event.button === 2 || event.shiftKey || event.ctrlKey || event.metaKey
    this.mode = wantsPan || this.state.projection === "2d" ? "pan" : "orbit"
    this.armed = event.button === 0 && !wantsPan
    this.dragging = true
    this.moved = false
    this.downX = this.lastX = event.clientX
    this.downY = this.lastY = event.clientY
    this.azVel = 0
    this.phiVel = 0
  }

  private onPointerMove = (event: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect()
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    if (!this.dragging) return
    const fromX = this.lastX
    const fromY = this.lastY
    const dx = event.clientX - fromX
    const dy = event.clientY - fromY
    this.lastX = event.clientX
    this.lastY = event.clientY
    const sx = event.clientX - this.downX
    const sy = event.clientY - this.downY
    if (sx * sx + sy * sy > 9) this.moved = true
    if (!this.moved || this.state.screen === "landing") return
    if (this.mode === "orbit") {
      this.userAz -= dx * 0.0055
      this.userTilt += dy * 0.0035
      this.clampTilt()
      this.azVel = -dx * 0.0004
      this.phiVel = dy * 0.00025
      return
    }
    if (!this.groundAt(fromX, fromY, this.grab) || !this.groundAt(event.clientX, event.clientY, this.hit)) return
    this.grab.sub(this.hit)
    const limit = this.dist * 0.25
    if (this.grab.lengthSq() > limit * limit) this.grab.setLength(limit)
    this.moveTarget(this.grab.x, this.grab.z)
  }

  private onPointerUp = () => {
    if (!this.dragging) return
    const wasDrag = this.moved
    const armed = this.armed
    this.dragging = false
    this.armed = false
    if (!armed || wasDrag || this.state.screen === "landing") return
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects(
      this.bodies.filter((body) => body.group.visible).map((body) => body.pick),
      false,
    )
    const id = hits[0]?.object.userData.pick as string | undefined
    if (id) {
      this.hooks.onFocus(id)
      if (this.zoomTarget < 0.68) this.setZoom(0.68)
      return
    }
    if (this.zoomTarget > 0.5) {
      this.setZoom(0.38)
      this.hooks.onFocus(null)
    } else if (this.zoomTarget > 0.26) {
      this.setZoom(0.06)
    }
  }

  private onWheel = (event: WheelEvent) => {
    const target = event.target as HTMLElement | null
    if (target?.closest(".panel, .notes, .filter-pop, .time, .mapcard")) return
    event.preventDefault()
    if (this.state.screen === "landing") {
      this.hooks.onEnter()
      return
    }
    const mode = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1
    const step = Math.min(0.055, Math.max(-0.055, event.deltaY * mode * 0.00048))
    const next = Math.min(1, Math.max(0, this.zoomTarget + step))
    if (next !== this.zoomTarget && this.groundAt(event.clientX, event.clientY, this.hit)) {
      const pull = 1 - Math.pow(6 / 54, next - this.zoomTarget)
      this.moveTarget((this.hit.x - this.target.x) * pull, (this.hit.z - this.target.z) * pull)
    }
    this.setZoom(next)
  }

  private animate = () => {
    if (this.disposed) return
    this.frame = requestAnimationFrame(this.animate)
    const dt = Math.min(0.18, this.clock.getDelta())
    this.step(dt)
    this.renderer.render(this.scene, this.camera)
  }

  private step(dt: number) {
    const state = this.state
    const landing = state.screen === "landing"
    this.shownZoom = damp(this.shownZoom, landing ? 0.04 : this.zoomTarget, 4.2, dt)
    this.shownYear = damp(this.shownYear, state.year, 8, dt)
    const reliefGoal = !landing && state.projection === "3d" ? 1 : 0.02
    this.shownRelief = damp(this.shownRelief, reliefGoal, 2.4, dt)
    this.reliefMat.uniforms.uRelief.value = this.shownRelief

    if (!(this.dragging && this.mode === "orbit")) {
      this.userAz += this.azVel
      this.userTilt += this.phiVel
      this.azVel *= Math.exp(-3.4 * dt)
      this.phiVel *= Math.exp(-3.4 * dt)
    }
    this.clampTilt()

    const focus = state.glacierId ? this.byId.get(state.glacierId) : undefined
    const zoom = this.shownZoom
    const lockId = focus && this.zoomTarget > 0.48 ? focus.ice.id : null
    if (lockId !== this.lockId) {
      this.lockId = lockId
      this.offset.set(0, 0, 0)
    }
    if (focus && lockId) {
      const reach = lengthKm(focus.ice, this.shownYear) / 10
      this.target.set(
        focus.ice.x + focus.ice.dx * reach * 0.42 + this.offset.x,
        focus.ice.y * this.shownRelief,
        focus.ice.z + focus.ice.dz * reach * 0.42 + this.offset.z,
      )
    } else {
      this.target.y = damp(this.target.y, 0, 2.4, dt)
    }
    this.shownTarget.lerp(this.target, 1 - Math.exp(-3.1 * dt))

    const flat = state.projection === "2d" || landing
    this.az = dampAngle(this.az, flat ? 0 : this.userAz, 5, dt)
    const phi3d = Math.min(MAX_PHI, Math.max(MIN_PHI, this.baseTilt(zoom) + this.userTilt))
    const phiGoal = flat ? 0.035 : phi3d
    this.phi = damp(this.phi, phiGoal, 3.6, dt)
    const distGoal = 54 * Math.pow(6 / 54, zoom)
    this.dist = damp(this.dist, distGoal, 3.4, dt)

    const sinPhi = Math.sin(this.phi)
    this.camera.position.set(
      this.shownTarget.x + this.dist * sinPhi * Math.sin(this.az),
      this.dist * Math.cos(this.phi) + this.shownTarget.y,
      this.shownTarget.z + this.dist * sinPhi * Math.cos(this.az),
    )
    this.look.copy(this.shownTarget)
    if (!(focus && this.zoomTarget > 0.48)) this.look.y *= 0.2
    this.camera.lookAt(this.look)

    this.updateBodies(dt)
    this.updateCore()
    this.updateRivers()
    this.updatePicking()
    this.updateLabels()
    this.updateCompass()
    this.syncLevel()
  }

  private updateBodies(dt: number) {
    const zoom = this.shownZoom
    const year = this.shownYear
    const near = smoothstep(0.2, 0.6, zoom)
    const exploring = this.state.screen === "explore"
    for (const body of this.bodies) {
      const show = exploring && this.visible(body.ice)
      body.group.visible = show
      if (!show) continue
      const known = year + 0.15 >= body.ice.y0
      const worldLen = lengthKm(body.ice, year) / 10
      const retreated = Math.max(0, body.ice.estStartKm - lengthKm(body.ice, year))
      const pin = known ? 0.16 + Math.min(0.85, retreated / 4.2) : 0.07
      const lay = smoothstep(0.18, 0.36, zoom)
      const goal = lerp(pin, worldLen, lay)
      body.shown = damp(body.shown, goal, known ? 7 : 4, dt)
      const draw = Math.max(0.05, body.shown)
      const width = lerp(0.16, (body.ice.widthKm / 10) * 2.1, lay)
      const thick = lerp(1.6, 1.15, lay)
      body.tongue.scale.set(Math.max(0.06, width), thick, draw)
      body.pick.scale.setScalar(lerp(1.8, 0.85, lay))
      body.group.position.y = 0.05 + body.ice.y * this.shownRelief
      const drop = worldHeight(body.ice.lat - body.ice.dz * 0.05, body.ice.lon + body.ice.dx * 0.05)
      const slope = Math.atan2((body.ice.y - drop) * this.shownRelief, Math.max(0.2, body.ice.estStartKm / 10))
      const pitch = Math.max(-0.28, Math.min(0.05, -slope * 0.28))
      body.group.rotation.x = lerp(Math.PI / 2, pitch, lay)

      const loss = Math.min(1, Math.max(0, retreated / Math.max(0.4, body.ice.estStartKm)))
      const tint = lerp(loss * 0.92, loss * (1 - smoothstep(0.45, 0.72, zoom)), lay)
      const focused = body.ice.id === this.state.glacierId
      const isolate = smoothstep(0.5, 0.7, zoom)
      const mat = body.tongue.material as THREE.MeshStandardMaterial
      mat.color.copy(ICE).lerp(LOSS, known ? tint : 0)
      mat.opacity = (known ? 1 : 0.28) * (focused ? 1 : lerp(1, 0.16, isolate))
      mat.transparent = mat.opacity < 0.98

      const ghostLen = (body.ice.estStartKm / 10) * lerp(0.32, 1, near)
      body.ghost.visible = focused && known && lay > 0.7 && ghostLen > draw + 0.04
      body.ghost.scale.set(width * 1.02, thick * 0.35, ghostLen)
      ;(body.ghost.material as THREE.MeshBasicMaterial).opacity = 0.22 * smoothstep(0.4, 0.62, zoom)

      const scarLen = ghostLen - draw
      const advanced = lengthKm(body.ice, year) > body.ice.estStartKm + 0.05
      body.scar.visible = focused && known && lay > 0.7 && Math.abs(scarLen) > 0.03
      if (body.scar.visible) {
        const start = advanced ? ghostLen : draw
        const size = Math.max(0.02, Math.abs(scarLen))
        body.scar.scale.set(Math.max(0.05, width * 0.78), 1, size)
        body.scar.position.set(0, 0.012, -(start + size / 2))
        ;(body.scar.material as THREE.MeshBasicMaterial).color.copy(advanced ? GAIN : LOSS)
        ;(body.scar.material as THREE.MeshBasicMaterial).opacity = 0.78 * smoothstep(0.38, 0.58, zoom)
      }
    }
  }

  private updateCore() {
    const zoom = this.shownZoom
    const id = this.state.glacierId
    const body = id ? this.byId.get(id) : undefined
    const rise = smoothstep(0.82, 0.94, zoom)
    this.coreGroup.visible = Boolean(body) && rise > 0.02 && this.state.screen === "explore"
    if (!body || !this.coreGroup.visible) {
      this.ring.visible = false
      return
    }
    const year = Math.round(this.shownYear)
    if (this.builtId !== id || this.builtYear !== year) {
      this.builtId = id
      this.builtYear = year
      this.writeCore(body, year)
    }
    const side = Math.max(0.42, body.ice.widthKm / 10)
    this.coreAnchor.set(body.ice.x, body.group.position.y, body.ice.z)
    this.coreGroup.position.copy(this.coreAnchor)
    this.coreGroup.position.x += Math.cos(body.ice.yaw) * side * 2.6
    this.coreGroup.position.z -= Math.sin(body.ice.yaw) * side * 2.6
    this.coreGroup.scale.set(lerp(0.7, 1, rise), rise, lerp(0.7, 1, rise))
    const material = this.core.material as THREE.MeshStandardMaterial
    material.opacity = rise
    material.transparent = rise < 0.98

    this.ring.visible = zoom > 0.48 && zoom < 0.9
    this.ring.position.set(body.ice.x, body.group.position.y + 0.03, body.ice.z)
    const ringScale = Math.max(0.55, body.ice.widthKm / 6)
    this.ring.scale.setScalar(ringScale)
  }

  private writeCore(body: Body, year: number) {
    const ice = body.ice
    const end = Math.min(year, lastYear(ice))
    const rows: { year: number; value: number; useMass: boolean }[] = []
    for (let y = ice.y0; y <= end; y++) {
      const balance = mass(ice, y)
      const delta = annual(ice, y)
      const value = balance != null ? balance : delta
      if (value == null) continue
      rows.push({ year: y, value, useMass: balance != null })
      if (rows.length >= 180) break
    }
    const gap = 0.007
    const raw = rows.map((row) => {
      const magnitude = row.useMass ? Math.min(1, Math.abs(row.value) / 2200) : Math.min(1, Math.abs(row.value) / 35)
      return 0.01 + magnitude * 0.018
    })
    const sum = raw.reduce((total, height) => total + height, 0) + Math.max(0, raw.length - 1) * gap
    const fit = sum > 0 ? Math.min(1, 1.45 / sum) : 1
    let cursor = 0
    this.decadeMarks = []
    rows.forEach((row, index) => {
      const height = raw[index] * fit
      this.dummy.position.set(0, cursor + height / 2, 0)
      this.dummy.scale.set(0.14, height, 0.05)
      this.dummy.rotation.set(0, 0, 0)
      this.dummy.updateMatrix()
      this.core.setMatrixAt(index, this.dummy.matrix)
      if (row.useMass ? row.value < -80 : row.value < -1) this.color.copy(LOSS)
      else if (row.useMass ? row.value > 80 : row.value > 1) this.color.copy(GAIN)
      else this.color.copy(STILL)
      this.core.setColorAt(index, this.color)
      if (row.year % 20 === 0) this.decadeMarks.push({ year: row.year, y: cursor + height })
      cursor += height + gap * fit
    })
    this.core.count = rows.length
    this.core.instanceMatrix.needsUpdate = true
    if (this.core.instanceColor) this.core.instanceColor.needsUpdate = true
  }

  private updateRivers() {
    const on = this.state.rivers && this.state.screen === "explore"
    this.riverRoot.visible = on
    if (!on) return
    const year = Math.round(this.shownYear)
    if (year !== this.riverYear) {
      this.riverYear = year
      for (const river of this.rivers) {
        let retreat = 0
        let observed = 0
        for (const body of this.bodies) {
          if (body.ice.basin !== river.basin || !this.visible(body.ice)) continue
          const delta = annual(body.ice, year)
          if (delta == null) continue
          observed += 1
          if (delta < -1) retreat += 1
        }
        const share = observed ? retreat / observed : 0
        const radius = 0.012 + share * 0.034
        river.tube.geometry.dispose()
        river.tube.geometry = new THREE.TubeGeometry(river.curve, 40, radius, 5, false)
        const material = river.tube.material as THREE.MeshBasicMaterial
        material.opacity = 0.28 + share * 0.45
      }
    }
    const clock = performance.now() * 0.00008
    for (const river of this.rivers) {
      const attr = river.points.geometry.attributes.position as THREE.BufferAttribute
      for (let i = 0; i < river.phases.length; i++) {
        const t = (river.phases[i] + clock) % 1
        river.curve.getPoint(t, this.hit)
        attr.setXYZ(i, this.hit.x, this.hit.y + 0.03, this.hit.z)
      }
      attr.needsUpdate = true
    }
  }

  private updatePicking() {
    if (this.dragging || this.state.screen !== "explore") {
      if (this.hoverId) {
        this.hoverId = null
        this.hooks.onHover(null)
      }
      this.canvas.style.cursor = !this.dragging || !this.moved ? "default" : this.mode === "pan" ? "move" : "grabbing"
      return
    }
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects(
      this.bodies.filter((body) => body.group.visible).map((body) => body.pick),
      false,
    )
    const id = (hits[0]?.object.userData.pick as string | undefined) ?? null
    this.canvas.style.cursor = id ? "pointer" : "grab"
    if (id !== this.hoverId) {
      this.hoverId = id
      this.hooks.onHover(id)
    }
  }

  private updateLabels() {
    const root = this.overlay?.labels
    if (!root) return
    if (this.state.screen !== "explore") {
      this.syncLabels([])
      return
    }
    const zoom = this.shownZoom
    const items: { text: string; x: number; y: number; kind: string }[] = []
    const push = (text: string, point: THREE.Vector3, kind: string, yLift = 0) => {
      point.y += yLift
      const p = this.project(point)
      if (!p) return
      const underCard = p.x < 400 && p.y > this.height - 360
      const underBar = p.y > this.height - 78 && p.x > this.width * 0.28 && p.x < this.width * 0.72
      const underChrome = p.x > this.width - 150
      if (underCard || underBar || underChrome) return
      items.push({ text, x: p.x, y: p.y, kind })
    }

    if (zoom < 0.46) {
      for (const basin of this.data.basins) {
        let sx = 0
        let sz = 0
        let n = 0
        for (const body of this.bodies) {
          if (body.ice.basin !== basin.id || !this.visible(body.ice)) continue
          sx += body.ice.x
          sz += body.ice.z
          n += 1
        }
        if (!n) continue
        push(basin.name, new THREE.Vector3(sx / n, 0.2, sz / n), "basin", 0.4)
      }
    }

    if (zoom > 0.24) {
      const ranked = this.bodies
        .filter((body) => this.visible(body.ice) && this.shownYear >= body.ice.y0)
        .slice()
        .sort((a, b) => (b.ice.area ?? 0) - (a.ice.area ?? 0))
      const limit = zoom < 0.4 ? 4 : zoom < 0.58 ? 8 : 12
      let used = 0
      for (const body of ranked) {
        if (used >= limit) break
        const dx = body.ice.x - this.shownTarget.x
        const dz = body.ice.z - this.shownTarget.z
        if (zoom > 0.84 && body.ice.id !== this.state.glacierId) continue
        if (zoom > 0.45 && dx * dx + dz * dz > 42) continue
        const kind = body.ice.id === this.state.glacierId ? "focus" : "glacier"
        push(body.ice.short, new THREE.Vector3(body.ice.x, body.group.position.y, body.ice.z), kind, 0.25)
        used += 1
      }
    }

    if (this.state.rivers && zoom < 0.62) {
      for (const river of this.rivers) {
        push(river.name, river.mid.clone(), "river", 0.15)
      }
    }

    if (zoom > 0.74 && this.coreGroup.visible) {
      for (const mark of this.decadeMarks) {
        const point = new THREE.Vector3(0.38, mark.y * this.coreGroup.scale.y, 0)
        point.applyMatrix4(this.coreGroup.matrixWorld)
        const p = this.project(point)
        if (p) items.push({ text: String(mark.year), x: p.x, y: p.y, kind: "decade" })
      }
    }

    this.syncLabels(this.separate(items))
  }

  private separate(items: { text: string; x: number; y: number; kind: string }[]) {
    const kept: typeof items = []
    for (const item of items) {
      if (item.kind === "focus" || item.kind === "decade") {
        kept.push(item)
        continue
      }
      const crowded = kept.some((other) => {
        const dx = other.x - item.x
        const dy = other.y - item.y
        return dx * dx + dy * dy < 52 * 52
      })
      if (!crowded) kept.push(item)
    }
    return kept
  }

  private syncLabels(items: { text: string; x: number; y: number; kind: string }[]) {
    const root = this.overlay?.labels
    if (!root) return
    while (this.labelPool.length < items.length) {
      const el = document.createElement("div")
      root.appendChild(el)
      this.labelPool.push(el)
    }
    for (let i = 0; i < this.labelPool.length; i++) {
      const el = this.labelPool[i]
      const item = items[i]
      if (!item) {
        el.style.display = "none"
        continue
      }
      el.style.display = "block"
      el.className = `tag ${item.kind}`
      el.textContent = item.text
      el.style.transform = `translate(${item.x}px, ${item.y}px) translate(-50%, -50%)`
    }
  }

  private project(point: THREE.Vector3) {
    this.proj.copy(point).project(this.camera)
    if (this.proj.z > 1) return null
    const x = (this.proj.x * 0.5 + 0.5) * this.width
    const y = (-this.proj.y * 0.5 + 0.5) * this.height
    if (x < -40 || y < -40 || x > this.width + 40 || y > this.height + 40) return null
    return { x, y }
  }

  private updateCompass() {
    const compass = this.overlay?.compass
    if (!compass || !this.compassRotor || !this.compassLetter || !this.compassRead) return
    const show = this.state.screen === "explore" && this.state.projection === "3d"
    compass.classList.toggle("show", show)
    compass.classList.toggle("hot", show && this.shownZoom > 0.5)
    const deg = THREE.MathUtils.radToDeg(this.az)
    this.compassRotor.style.transform = `rotate(${deg}deg)`
    this.compassLetter.style.transform = `rotate(${-deg}deg)`
    const bearing = ((Math.round(-deg) % 360) + 360) % 360
    const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    const name = names[Math.round(bearing / 45) % 8]
    this.compassRead.textContent = `${name}  ${bearing}°`
  }

  private syncLevel() {
    const level = levelOf(this.zoomTarget)
    if (this.zoomTarget > 0.56 && !this.state.glacierId && !this.focusGuard) {
      const nearest = this.nearest(this.shownTarget, this.zoomTarget > 0.75 ? 7 : 3.2)
      if (nearest) {
        this.focusGuard = true
        this.hooks.onFocus(nearest.ice.id)
      }
    }
    if (this.zoomTarget < 0.5) this.focusGuard = false
    if (this.zoomTarget < 0.42 && this.state.glacierId && !this.clearGuard) {
      this.clearGuard = true
      this.hooks.onFocus(null)
    }
    if (!this.state.glacierId) this.clearGuard = false

    let massif: string | null = null
    if (this.state.glacierId) massif = this.byId.get(this.state.glacierId)?.ice.massif ?? null
    else if (level === 1) massif = this.nearest(this.shownTarget, 40)?.ice.massif ?? null
    if (massif !== this.lastMassif) {
      this.lastMassif = massif
      this.hooks.onMassif(massif)
    }
  }
}
