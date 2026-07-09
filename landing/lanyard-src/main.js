// 官网页脚「开源工牌」吊牌 —— 完全复刻 React Bits <Lanyard />（老师站同款）。
//  - 物理：同款 Rapier 引擎（wasm 内嵌），参数照搬原组件：gravity -40、linear/angularDamping 4、
//    三段 rope joint + 球关节挂卡、拖拽切 kinematic 松手回 dynamic、angvel.y -= quat.y*0.25 缓回正。
//    卡片是真刚体：可随意拖着翻转打圈（能看到背面项目卡），松手后重力+重阻尼自然回摆。
//  - 模型：原版 card.glb（卡体/金属夹 clip/挂扣 clamp），卡面按原版管线把正背两图合成进贴图集
//    （前=左半 UV 区，背=右半，cover 等比裁切）。
//  - 织带：原版 lanyard.png（黑底 + 图标），repeat [-4,1]。
//  - 渲染：three.js + 四条 Lightformer 灯带环境（清漆高光条纹的来源）。
// 打包：esbuild main.js --bundle --minify --format=iife
//       --loader:.jpg=dataurl --loader:.png=dataurl --loader:.glb=dataurl --outfile=../lanyard.js
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import RAPIER from '@dimforge/rapier3d-compat'
import { mountGridScan } from './gridscan.js'
import CARD_GLB from './card.glb'
import BAND_URL from './lanyard-band.png'
import FRONT_URL from './lanyard-front.jpg'
import BACK_URL from './lanyard-back.jpg'

const GITHUB_URL = 'https://github.com/Yvestiny-aipm'

// 原组件常量：卡模型 UV 集中 前面=左半 / 背面=右半
const FRONT_UV_RECT = { x: 0, y: 0, w: 0.5, h: 0.755 }
const BACK_UV_RECT = { x: 0.5, y: 0, w: 0.5, h: 0.757 }
const SEG_LEN = 1
const GRAVITY = -40
const BAND_W = 0.27
const MAX_SPEED = 50
const MIN_SPEED = 0

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = rej
    img.src = url
  })
}

// 原组件 cardMap 合成：保留 glb 原贴图集（卡边框等），把两张卡面 cover 等比裁进各自半区
function compositeAtlas(baseMap, frontImg, backImg) {
  const baseImg = baseMap.image
  const W = baseImg.width
  const H = baseImg.height
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  ctx.drawImage(baseImg, 0, 0, W, H)
  const drawFitted = (img, rect) => {
    const rx = rect.x * W, ry = rect.y * H, rw = rect.w * W, rh = rect.h * H
    const scale = Math.max(rw / img.width, rh / img.height) // cover
    const dw = img.width * scale, dh = img.height * scale
    ctx.save()
    ctx.beginPath()
    ctx.rect(rx, ry, rw, rh)
    ctx.clip()
    ctx.drawImage(img, rx + (rw - dw) / 2, ry + (rh - dh) / 2, dw, dh)
    ctx.restore()
  }
  drawFitted(frontImg, FRONT_UV_RECT)
  drawFitted(backImg, BACK_UV_RECT)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = baseMap.flipY
  tex.anisotropy = 16
  tex.needsUpdate = true
  return tex
}

class Lanyard {
  constructor(container, assets) {
    this.container = container
    this.assets = assets
    this.reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    // 相机贴近：对齐老师站比例（卡占屏高约四成、锚点在屏外上方、可见绳段短）
    this.camera = new THREE.PerspectiveCamera(20, 1, 0.1, 100)
    this.camera.position.set(0, 0, 15.5)

    // 环境光照复刻原版：4 条 Lightformer 白色灯带（卡面高光条纹的来源）
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    const envScene = new THREE.Scene()
    const strip = (intensity, pos, rot, scale) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(intensity), side: THREE.DoubleSide })
      )
      m.position.set(...pos)
      m.rotation.set(...rot)
      m.scale.set(...scale)
      envScene.add(m)
    }
    strip(2, [0, -1, 5], [0, 0, Math.PI / 3], [100, 0.1, 1])
    strip(3, [-1, -1, 1], [0, 0, Math.PI / 3], [100, 0.1, 1])
    strip(3, [1, 1, 1], [0, 0, Math.PI / 3], [100, 0.1, 1])
    strip(10, [-10, 0, 14], [0, Math.PI / 2, Math.PI / 3], [100, 10, 1])
    this.scene.environment = pmrem.fromScene(envScene, 0.75).texture
    this.scene.add(new THREE.AmbientLight(0xffffff, Math.PI))

    this.buildPhysics()
    this.buildCard()
    this.buildBand()

    this.dragging = false
    this.dragTarget = new THREE.Vector3()
    this.dragOffset = new THREE.Vector3()
    this.downAt = 0
    this.downXY = [0, 0]
    this.raycaster = new THREE.Raycaster()
    this.pointer = new THREE.Vector2()
    this.bindEvents()

    this.resize()
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)

    this.clock = new THREE.Clock()
    this.acc = 0
    this.renderer.setAnimationLoop(() => this.tick())
  }

  buildPhysics() {
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 })
    this.world.timestep = 1 / 60
    const dyn = (x, y) => {
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, 0).setLinearDamping(4).setAngularDamping(4)
      )
      this.world.createCollider(RAPIER.ColliderDesc.ball(0.1), body)
      return body
    }
    // 原版布局：fixed(0,4) + j1(0.5,4) + j2(1,4) + j3(1.5,4) + card(2,4)——绳水平摆放自然坠落入场；
    // reduced-motion 直接竖直静置
    this.bFixed = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 4, 0))
    if (this.reduce) {
      this.j1 = dyn(0, 3)
      this.j2 = dyn(0, 2)
      this.j3 = dyn(0, 1)
    } else {
      this.j1 = dyn(0.5, 4)
      this.j2 = dyn(1, 4)
      this.j3 = dyn(1.5, 4)
    }
    const cardDesc = RAPIER.RigidBodyDesc.dynamic().setLinearDamping(4).setAngularDamping(4)
    cardDesc.setTranslation(...(this.reduce ? [0, -0.5, 0] : [2, 4, 0]))
    this.bCard = this.world.createRigidBody(cardDesc)
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.8, 1.125, 0.01), this.bCard)
    const O = { x: 0, y: 0, z: 0 }
    this.world.createImpulseJoint(RAPIER.JointData.rope(SEG_LEN, O, O), this.bFixed, this.j1, true)
    this.world.createImpulseJoint(RAPIER.JointData.rope(SEG_LEN, O, O), this.j1, this.j2, true)
    this.world.createImpulseJoint(RAPIER.JointData.rope(SEG_LEN, O, O), this.j2, this.j3, true)
    // 球关节：卡在本地 (0,1.5,0) 挂到 j3 —— 原版参数
    this.world.createImpulseJoint(RAPIER.JointData.spherical(O, { x: 0, y: 1.5, z: 0 }), this.j3, this.bCard, true)
    // 织带中段平滑用（原版 j1/j2 lerped）
    this.lerp1 = new THREE.Vector3().copy(this.j1.translation())
    this.lerp2 = new THREE.Vector3().copy(this.j2.translation())
  }

  buildCard() {
    const { gltf, frontImg, backImg } = this.assets
    const nodes = {}
    const materials = {}
    gltf.scene.traverse((o) => {
      if (o.isMesh) nodes[o.name] = o
      if (o.isMesh && o.material && o.material.name) materials[o.material.name] = o.material
    })
    // 原版卡面材质：合成贴图集 + 粗糙金属底 + 清漆层
    const cardMesh = new THREE.Mesh(nodes.card.geometry, new THREE.MeshPhysicalMaterial({
      map: compositeAtlas(materials.base.map, frontImg, backImg),
      clearcoat: 1,
      clearcoatRoughness: 0.15,
      roughness: 0.9,
      metalness: 0.8
    }))
    const metalClip = materials.metal.clone()
    metalClip.roughness = 0.3
    const clipMesh = new THREE.Mesh(nodes.clip.geometry, metalClip)
    const clampMesh = new THREE.Mesh(nodes.clamp.geometry, materials.metal)
    // 原版层级：group scale=2.25 position=[0,-1.2,-0.05]
    const inner = new THREE.Group()
    inner.add(cardMesh, clipMesh, clampMesh)
    inner.scale.setScalar(2.25)
    inner.position.set(0, -1.2, -0.05)
    this.card = new THREE.Group()
    this.card.add(inner)
    this.scene.add(this.card)
    this.hitMeshes = [cardMesh, clipMesh, clampMesh]
  }

  buildBand() {
    this.bandTex = new THREE.TextureLoader().load(BAND_URL)
    this.bandTex.wrapS = this.bandTex.wrapT = THREE.RepeatWrapping
    this.bandTex.colorSpace = THREE.SRGBColorSpace
    this.bandTex.anisotropy = 8
    this.bandSamples = 32
    const n = this.bandSamples + 1
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3))
    const uv = new Float32Array(n * 2 * 2)
    for (let i = 0; i < n; i++) {
      const t = -(i / this.bandSamples) * 4 // 原版 meshline repeat [-4, 1]
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
      map: this.bandTex, side: THREE.DoubleSide, toneMapped: false, transparent: true
    }))
    this.band.frustumCulled = false
    this.scene.add(this.band)
    // 原版曲线：j3 → j2.lerped → j1.lerped → fixed
    this.curvePts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
    this.curve = new THREE.CatmullRomCurve3(this.curvePts, false, 'chordal')
  }

  bindEvents() {
    const el = this.renderer.domElement
    el.style.touchAction = 'pan-y'
    el.addEventListener('pointerdown', (e) => {
      this.setPointer(e)
      this.raycaster.setFromCamera(this.pointer, this.camera)
      if (this.raycaster.intersectObjects(this.hitMeshes, false).length === 0) return
      const world = this.pointerToWorld(e)
      const t = this.bCard.translation()
      this.dragOffset.set(world.x - t.x, world.y - t.y, 0)
      this.dragTarget.set(t.x, t.y, t.z)
      this.dragging = true
      this.bCard.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true)
      this.downAt = performance.now()
      this.downXY = [e.clientX, e.clientY]
      el.setPointerCapture(e.pointerId)
      el.style.cursor = 'grabbing'
    })
    el.addEventListener('pointermove', (e) => {
      if (this.dragging) {
        const world = this.pointerToWorld(e)
        this.dragTarget.set(world.x - this.dragOffset.x, world.y - this.dragOffset.y, 0)
        return
      }
      this.setPointer(e)
      this.raycaster.setFromCamera(this.pointer, this.camera)
      el.style.cursor = this.raycaster.intersectObjects(this.hitMeshes, false).length ? 'grab' : 'auto'
    })
    const up = (e) => {
      if (!this.dragging) return
      this.dragging = false
      this.bCard.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
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

  // 指针射线与 z=0 平面求交（吊牌活动平面）
  pointerToWorld(e) {
    this.setPointer(e)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction
    const t = -o.z / d.z
    return new THREE.Vector3().copy(d).multiplyScalar(t).add(o)
  }

  tick() {
    const dt = Math.min(this.clock.getDelta(), 1 / 30)

    // 固定步长推进 Rapier（最多补 3 步防螺旋）
    this.acc += dt
    let steps = 0
    while (this.acc >= 1 / 60 && steps < 3) {
      if (this.dragging) {
        ;[this.bCard, this.j1, this.j2, this.j3].forEach((b) => b.wakeUp())
        this.bCard.setNextKinematicTranslation({ x: this.dragTarget.x, y: this.dragTarget.y, z: 0 })
      }
      this.world.step()
      // 原版软弹簧：angvel.y -= quat.y * 0.25 —— 缓慢转回正面，但完全不阻止用户翻面
      if (!this.dragging) {
        const q = this.bCard.rotation()
        const av = this.bCard.angvel()
        this.bCard.setAngvel({ x: av.x, y: av.y - q.y * 0.25, z: av.z }, true)
      }
      this.acc -= 1 / 60
      steps++
    }
    if (steps === 3) this.acc = 0

    // 卡片网格同步刚体位姿（真 3D 旋转，翻面可见背面）
    const t = this.bCard.translation()
    const q = this.bCard.rotation()
    this.card.position.set(t.x, t.y, t.z)
    this.card.quaternion.set(q.x, q.y, q.z, q.w)

    // 织带：j1/j2 平滑插值（原版 lerped），曲线 j3 → j2 → j1 → fixed
    for (const [lerped, body] of [[this.lerp1, this.j1], [this.lerp2, this.j2]]) {
      const cur = body.translation()
      const clamped = Math.max(0.1, Math.min(1, lerped.distanceTo(cur)))
      lerped.lerp(new THREE.Vector3(cur.x, cur.y, cur.z), dt * (MIN_SPEED + clamped * (MAX_SPEED - MIN_SPEED)))
    }
    const j3t = this.j3.translation()
    const ft = this.bFixed.translation()
    this.curvePts[0].set(j3t.x, j3t.y, j3t.z)
    this.curvePts[1].copy(this.lerp2)
    this.curvePts[2].copy(this.lerp1)
    this.curvePts[3].set(ft.x, ft.y, ft.z)

    const samples = this.curve.getPoints(this.bandSamples)
    const pos = this.band.geometry.attributes.position
    const toCam = new THREE.Vector3()
    const side = new THREE.Vector3()
    const tan = new THREE.Vector3()
    for (let i = 0; i <= this.bandSamples; i++) {
      const p = samples[i]
      const pNext = samples[Math.min(i + 1, this.bandSamples)]
      const pPrev = samples[Math.max(i - 1, 0)]
      tan.subVectors(pNext, pPrev).normalize()
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
    // 背景网格扫描（独立画布，垫在吊牌下层；鼠标视差监听挂在整个舞台上）
    const grid = document.getElementById('gridScan')
    if (grid) {
      try { mountGridScan(grid, el) } catch (err) { grid.style.display = 'none' }
    }
    Promise.all([
      RAPIER.init(),
      new GLTFLoader().loadAsync(CARD_GLB),
      loadImage(FRONT_URL),
      loadImage(BACK_URL)
    ])
      .then(([, gltf, frontImg, backImg]) => new Lanyard(el, { gltf, frontImg, backImg }))
      .catch(() => { el.style.display = 'none' })
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
