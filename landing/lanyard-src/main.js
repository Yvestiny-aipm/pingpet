// 官网页脚「开源工牌」吊牌。
// 参考 React Bits <Lanyard />（R3F + Rapier 物理），此处为零依赖运行时移植：
//  - three.js 渲染（RoomEnvironment 反射 + 物理材质 clearcoat），esbuild 打成经典脚本
//  - Rapier 刚体绳 → 自写 Verlet 粒子绳（5 点 4 段 + 距离约束），观感一致、免 1.6MB wasm
//  - 卡面贴图：正=作者 GitHub 名片 / 背=PingPet 项目卡（构建时 dataurl 内嵌）
//  - 交互：拖拽甩卡（指针捕获）、快速点击跳 GitHub 主页、hover 抓手光标
// 打包：esbuild main.js --bundle --minify --format=iife --loader:.jpg=dataurl --outfile=../lanyard.js
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import FRONT_URL from './lanyard-front.jpg'
import BACK_URL from './lanyard-back.jpg'

const GITHUB_URL = 'https://github.com/Yvestiny-aipm'

const CARD_W = 1.9
const CARD_H = 2.6
const CARD_R = 0.14
const CLIP_GAP = 0.16
const ROPE_SEGS = 4          // 5 个粒子 4 段，对齐原版 fixed+j1+j2+j3+card
const SEG_LEN = 0.52
const GRAVITY = -22
const BAND_W = 0.30

function roundedRectShape(w, h, r) {
  const s = new THREE.Shape()
  const x = -w / 2, y = -h / 2
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.quadraticCurveTo(x + w, y, x + w, y + r)
  s.lineTo(x + w, y + h - r)
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  s.lineTo(x + r, y + h)
  s.quadraticCurveTo(x, y + h, x, y + h - r)
  s.lineTo(x, y + r)
  s.quadraticCurveTo(x, y, x + r, y)
  return s
}

// ShapeGeometry 的 uv 是形状坐标系，重映射到 0..1 才能贴整张卡面
function remapUVs(geo) {
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  const size = new THREE.Vector3().subVectors(bb.max, bb.min)
  const pos = geo.attributes.position
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - bb.min.x) / size.x
    uv[i * 2 + 1] = (pos.getY(i) - bb.min.y) / size.y
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
}

// 织带贴图：品牌紫底 + 重复 PINGPET 字样（运行时 canvas 生成，免外部素材）
function makeBandTexture() {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 128
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#6b46d6'
  ctx.fillRect(0, 0, 512, 128)
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = 'bold 58px ui-monospace, Menlo, monospace'
  ctx.textBaseline = 'middle'
  ctx.fillText('PINGPET ✦', 24, 68)
  ctx.fillText('PINGPET ✦', 24 + 512, 68)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

class Lanyard {
  constructor(container) {
    this.container = container
    this.reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(22, 1, 0.1, 100)
    this.camera.position.set(0, 0, 15.5)

    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.06).texture
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(2, 4, 6)
    this.scene.add(key)

    // —— Verlet 绳（P0 固定锚点 → P4 卡片挂点）——
    this.anchor = new THREE.Vector3(0, 3.55, 0)
    this.pts = []
    this.prev = []
    for (let i = 0; i <= ROPE_SEGS; i++) {
      // 原版初始把绳摆开让它自然坠落甩起来（45° 比水平收敛更利落）；reduced-motion 直接竖直静置
      const k = SEG_LEN * 0.707
      const p = this.reduce
        ? new THREE.Vector3(this.anchor.x, this.anchor.y - SEG_LEN * i, 0)
        : new THREE.Vector3(this.anchor.x + k * i, this.anchor.y - k * i, 0)
      this.pts.push(p)
      this.prev.push(p.clone())
    }

    this.buildCard()
    this.buildBand()

    this.dragging = false
    this.dragOffset = new THREE.Vector3()
    this.downAt = 0
    this.downXY = [0, 0]
    this.yRot = 0
    this.yVel = 0
    this.raycaster = new THREE.Raycaster()
    this.pointer = new THREE.Vector2()
    this.bindEvents()

    this.resize()
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)

    this.clock = new THREE.Clock()
    this.renderer.setAnimationLoop(() => this.tick())
  }

  buildCard() {
    this.card = new THREE.Group()
    const core = new THREE.Mesh(
      new RoundedBoxGeometry(CARD_W, CARD_H, 0.06, 4, CARD_R),
      new THREE.MeshPhysicalMaterial({ color: 0x16151b, metalness: 0.6, roughness: 0.5, clearcoat: 1, clearcoatRoughness: 0.2 })
    )
    const faceGeo = new THREE.ShapeGeometry(roundedRectShape(CARD_W - 0.04, CARD_H - 0.04, CARD_R), 12)
    remapUVs(faceGeo)
    const loader = new THREE.TextureLoader()
    const mkFace = (url) => {
      const map = loader.load(url)
      map.colorSpace = THREE.SRGBColorSpace
      map.anisotropy = 16
      return new THREE.Mesh(faceGeo, new THREE.MeshPhysicalMaterial({
        map, metalness: 0.35, roughness: 0.55, clearcoat: 1, clearcoatRoughness: 0.15
      }))
    }
    const front = mkFace(FRONT_URL)
    front.position.z = 0.035
    const back = mkFace(BACK_URL)
    back.rotation.y = Math.PI
    back.position.z = -0.035
    // 金属卡扣（对齐原版 clip/clamp 的观感）
    const metal = new THREE.MeshPhysicalMaterial({ color: 0xd8d8de, metalness: 1, roughness: 0.28 })
    const clamp = new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.2, 0.09, 3, 0.045), metal)
    clamp.position.y = CARD_H / 2 + 0.06
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.035, 10, 24), metal)
    ring.position.y = CARD_H / 2 + 0.2
    this.card.add(core, front, back, clamp, ring)
    this.scene.add(this.card)
    this.hitMeshes = [core, front, back]
  }

  buildBand() {
    this.bandTex = makeBandTexture()
    this.bandSamples = 40
    const n = this.bandSamples + 1
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3))
    const uv = new Float32Array(n * 2 * 2)
    for (let i = 0; i < n; i++) {
      const t = (i / this.bandSamples) * 3 // 沿带重复 3 次
      uv[(i * 2) * 2] = t
      uv[(i * 2) * 2 + 1] = 0
      uv[(i * 2 + 1) * 2] = t
      uv[(i * 2 + 1) * 2 + 1] = 1
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    const idx = []
    for (let i = 0; i < this.bandSamples; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3
      idx.push(a, b, c, b, d, c)
    }
    geo.setIndex(idx)
    this.band = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: this.bandTex, side: THREE.DoubleSide, toneMapped: false
    }))
    this.band.frustumCulled = false
    this.scene.add(this.band)
    this.curve = new THREE.CatmullRomCurve3(this.pts, false, 'chordal')
  }

  bindEvents() {
    const el = this.renderer.domElement
    el.style.touchAction = 'pan-y'
    el.addEventListener('pointerdown', (e) => {
      this.setPointer(e)
      this.raycaster.setFromCamera(this.pointer, this.camera)
      if (this.raycaster.intersectObjects(this.hitMeshes, false).length === 0) return
      const world = this.pointerToWorld(e)
      this.dragging = true
      this.dragOffset.subVectors(this.pts[ROPE_SEGS], world)
      this.downAt = performance.now()
      this.downXY = [e.clientX, e.clientY]
      el.setPointerCapture(e.pointerId)
      el.style.cursor = 'grabbing'
    })
    el.addEventListener('pointermove', (e) => {
      if (this.dragging) {
        const world = this.pointerToWorld(e)
        const target = world.add(this.dragOffset)
        this.yVel += (target.x - this.pts[ROPE_SEGS].x) * 0.9 // 拖动带一点扭转的活气
        this.pts[ROPE_SEGS].copy(target)
        return
      }
      this.setPointer(e)
      this.raycaster.setFromCamera(this.pointer, this.camera)
      el.style.cursor = this.raycaster.intersectObjects(this.hitMeshes, false).length ? 'grab' : 'auto'
    })
    const up = (e) => {
      if (!this.dragging) return
      this.dragging = false
      el.style.cursor = 'grab'
      const quick = performance.now() - this.downAt < 250 &&
        Math.hypot(e.clientX - this.downXY[0], e.clientY - this.downXY[1]) < 6
      if (quick) window.open(GITHUB_URL, '_blank', 'noreferrer')
    }
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  setPointer(e) {
    const r = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  }

  // 指针射线与 z=0 平面求交（卡片活动平面）
  pointerToWorld(e) {
    this.setPointer(e)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction
    const t = -o.z / d.z
    return new THREE.Vector3().copy(d).multiplyScalar(t).add(o)
  }

  step(dt) {
    const g = GRAVITY * dt * dt
    for (let i = 1; i <= ROPE_SEGS; i++) {
      if (this.dragging && i === ROPE_SEGS) continue // 拖拽时挂点由指针钉住
      const p = this.pts[i], pr = this.prev[i]
      const vx = (p.x - pr.x) * 0.985
      const vy = (p.y - pr.y) * 0.985
      pr.copy(p)
      p.x += vx
      p.y += vy + g
    }
    // 距离约束：P0 钉在锚点，逐段收敛
    for (let k = 0; k < 6; k++) {
      this.pts[0].copy(this.anchor)
      for (let i = 0; i < ROPE_SEGS; i++) {
        const a = this.pts[i], b = this.pts[i + 1]
        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.hypot(dx, dy) || 1e-6
        const diff = (dist - SEG_LEN) / dist
        const lockA = i === 0
        const lockB = this.dragging && i + 1 === ROPE_SEGS
        const wA = lockA ? 0 : lockB ? 1 : 0.5
        const wB = lockB ? 0 : lockA ? 1 : 0.5
        a.x += dx * diff * wA
        a.y += dy * diff * wA
        b.x -= dx * diff * wB
        b.y -= dy * diff * wB
      }
    }
  }

  tick() {
    const dt = Math.min(this.clock.getDelta(), 1 / 30)
    this.step(dt)

    // 卡片跟随挂点：位置 + 沿末段方向下垂 + 扭转回弹（对齐原版 angvel.y 阻尼）
    const tip = this.pts[ROPE_SEGS]
    const dir = new THREE.Vector3().subVectors(tip, this.pts[ROPE_SEGS - 1]).normalize()
    if (dir.lengthSq() < 0.5) dir.set(0, -1, 0)
    const zRot = Math.atan2(dir.x, -dir.y)
    this.yVel += (-this.yRot * 3 - this.yVel * 1.6) * dt * 4
    this.yRot = THREE.MathUtils.clamp(this.yRot + this.yVel * dt, -0.7, 0.7)
    this.card.position.set(
      tip.x + dir.x * (CLIP_GAP + CARD_H / 2),
      tip.y + dir.y * (CLIP_GAP + CARD_H / 2),
      0
    )
    this.card.rotation.set(0, this.yRot, zRot)

    // 织带条带：曲线取样，屏幕朝向展宽
    const samples = this.curve.getPoints(this.bandSamples)
    const pos = this.band.geometry.attributes.position
    const toCam = new THREE.Vector3()
    const side = new THREE.Vector3()
    const tan = new THREE.Vector3()
    for (let i = 0; i <= this.bandSamples; i++) {
      const p = samples[i]
      const pNext = samples[Math.min(i + 1, this.bandSamples)]
      const pPrev2 = samples[Math.max(i - 1, 0)]
      tan.subVectors(pNext, pPrev2).normalize()
      toCam.subVectors(this.camera.position, p).normalize()
      side.crossVectors(tan, toCam).normalize().multiplyScalar(BAND_W / 2)
      pos.setXYZ(i * 2, p.x - side.x, p.y - side.y, p.z - side.z)
      pos.setXYZ(i * 2 + 1, p.x + side.x, p.y + side.y, p.z + side.z)
    }
    pos.needsUpdate = true

    this.renderer.render(this.scene, this.camera)
  }

  resize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }
}

;(function () {
  const el = document.getElementById('lanyardStage')
  if (!el) return
  function boot() {
    try {
      new Lanyard(el)
    } catch (err) {
      el.closest('#opensource') && (el.style.display = 'none')
    }
  }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect()
        boot()
      }
    }, { rootMargin: '300px' })
    io.observe(el)
  } else {
    boot()
  }
})()
