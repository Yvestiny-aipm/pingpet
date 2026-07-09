// 官网「社区形象抢先看」弧形画廊。
// 移植自 React Bits <CircularGallery />（ogl WebGL 版），去 React 化 + 三处适配：
//  1) 事件从 window 收敛到容器：拖拽/触摸/方向键/横向滚轮，纵向滚轮不劫持（页面正常滚）
//  2) 加慢速自动巡游（hover/拖拽时暂停，prefers-reduced-motion 时关闭）
//  3) 标签颜色跟随亮暗主题，主题切换时整体重建
// 打包：node_modules/.pnpm/node_modules/.bin/esbuild landing/gallery-src/main.js --bundle --minify --format=iife --outfile=landing/pet-gallery.js
import { Camera, Mesh, Plane, Program, Renderer, Texture, Transform } from 'ogl'
import ITEMS_NOBG from './items-nobg.js'

function lerp(p1, p2, t) {
  return p1 + (p2 - p1) * t
}

const LABEL_FONT = 'bold 26px -apple-system, "PingFang SC", "Hiragino Sans GB", sans-serif'

function createTextTexture(gl, text, font, color) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  context.font = font
  const metrics = context.measureText(text)
  const textWidth = Math.ceil(metrics.width)
  const textHeight = Math.ceil(parseInt(font.match(/(\d+)px/)[1], 10) * 1.2)
  canvas.width = textWidth + 20
  canvas.height = textHeight + 20
  context.font = font
  context.fillStyle = color
  context.textBaseline = 'middle'
  context.textAlign = 'center'
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.fillText(text, canvas.width / 2, canvas.height / 2)
  const texture = new Texture(gl, { generateMipmaps: false })
  texture.image = canvas
  return { texture, width: canvas.width, height: canvas.height }
}

class Title {
  constructor({ gl, plane, text, textColor, font }) {
    this.gl = gl
    this.plane = plane
    const { texture, width, height } = createTextTexture(this.gl, text, font, textColor)
    const geometry = new Plane(this.gl)
    const program = new Program(this.gl, {
      vertex: `
        attribute vec3 position;
        attribute vec2 uv;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragment: `
        precision highp float;
        uniform sampler2D tMap;
        varying vec2 vUv;
        void main() {
          vec4 color = texture2D(tMap, vUv);
          if (color.a < 0.1) discard;
          gl_FragColor = color;
        }
      `,
      uniforms: { tMap: { value: texture } },
      transparent: true
    })
    this.mesh = new Mesh(this.gl, { geometry, program })
    const aspect = width / height
    const textHeight = this.plane.scale.y * 0.14
    const textWidth = textHeight * aspect
    this.mesh.scale.set(textWidth, textHeight, 1)
    this.mesh.position.y = -this.plane.scale.y * 0.5 - textHeight * 0.5 - 0.06
    this.mesh.setParent(this.plane)
  }
}

// 透明底模式：contain-fit（完整露出宠物不裁切）+ 用贴图自身 alpha，无卡片圆角
const FRAG_NOBG = `
  precision highp float;
  uniform vec2 uImageSizes;
  uniform vec2 uPlaneSizes;
  uniform sampler2D tMap;
  varying vec2 vUv;
  void main() {
    float pr = uPlaneSizes.x / uPlaneSizes.y;
    float ir = uImageSizes.x / uImageSizes.y;
    vec2 uv = vUv;
    if (pr > ir) {
      uv.x = (vUv.x - 0.5) * (pr / ir) + 0.5;
    } else {
      uv.y = (vUv.y - 0.5) * (ir / pr) + 0.5;
    }
    float inBox = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    vec4 color = texture2D(tMap, uv);
    gl_FragColor = vec4(color.rgb, color.a * inBox);
  }
`

class Media {
  constructor({ geometry, gl, image, index, length, scene, screen, text, viewport, bend, textColor, borderRadius, font, noBg }) {
    this.extra = 0
    this.geometry = geometry
    this.gl = gl
    this.image = image
    this.index = index
    this.length = length
    this.scene = scene
    this.screen = screen
    this.text = text
    this.viewport = viewport
    this.bend = bend
    this.textColor = textColor
    this.borderRadius = borderRadius
    this.font = font
    this.noBg = noBg
    this.createShader()
    this.createMesh()
    this.createTitle()
    this.onResize()
  }
  createShader() {
    const texture = new Texture(this.gl, { generateMipmaps: true })
    this.program = new Program(this.gl, {
      depthTest: false,
      depthWrite: false,
      vertex: `
        precision highp float;
        attribute vec3 position;
        attribute vec2 uv;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        uniform float uTime;
        uniform float uSpeed;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec3 p = position;
          p.z = (sin(p.x * 4.0 + uTime) * 1.5 + cos(p.y * 2.0 + uTime) * 1.5) * (0.1 + uSpeed * 0.5);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragment: this.noBg ? FRAG_NOBG : `
        precision highp float;
        uniform vec2 uImageSizes;
        uniform vec2 uPlaneSizes;
        uniform sampler2D tMap;
        uniform float uBorderRadius;
        varying vec2 vUv;
        float roundedBoxSDF(vec2 p, vec2 b, float r) {
          vec2 d = abs(p) - b;
          return length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0) - r;
        }
        void main() {
          vec2 ratio = vec2(
            min((uPlaneSizes.x / uPlaneSizes.y) / (uImageSizes.x / uImageSizes.y), 1.0),
            min((uPlaneSizes.y / uPlaneSizes.x) / (uImageSizes.y / uImageSizes.x), 1.0)
          );
          vec2 uv = vec2(
            vUv.x * ratio.x + (1.0 - ratio.x) * 0.5,
            vUv.y * ratio.y + (1.0 - ratio.y) * 0.5
          );
          vec4 color = texture2D(tMap, uv);
          float d = roundedBoxSDF(vUv - 0.5, vec2(0.5 - uBorderRadius), uBorderRadius);
          float edgeSmooth = 0.002;
          float alpha = 1.0 - smoothstep(-edgeSmooth, edgeSmooth, d);
          gl_FragColor = vec4(color.rgb, alpha);
        }
      `,
      uniforms: {
        tMap: { value: texture },
        uPlaneSizes: { value: [0, 0] },
        uImageSizes: { value: [0, 0] },
        uSpeed: { value: 0 },
        uTime: { value: 100 * Math.random() },
        uBorderRadius: { value: this.borderRadius }
      },
      transparent: true
    })
    const img = new Image()
    img.src = this.image
    img.onload = () => {
      texture.image = img
      this.program.uniforms.uImageSizes.value = [img.naturalWidth, img.naturalHeight]
    }
  }
  createMesh() {
    this.plane = new Mesh(this.gl, { geometry: this.geometry, program: this.program })
    this.plane.setParent(this.scene)
  }
  createTitle() {
    this.title = new Title({
      gl: this.gl,
      plane: this.plane,
      text: this.text,
      textColor: this.textColor,
      font: this.font
    })
  }
  update(scroll, direction) {
    this.plane.position.x = this.x - scroll.current - this.extra
    const x = this.plane.position.x
    const H = this.viewport.width / 2
    if (this.bend === 0) {
      this.plane.position.y = 0
      this.plane.rotation.z = 0
    } else {
      const B_abs = Math.abs(this.bend)
      const R = (H * H + B_abs * B_abs) / (2 * B_abs)
      const effectiveX = Math.min(Math.abs(x), H)
      const arc = R - Math.sqrt(R * R - effectiveX * effectiveX)
      if (this.bend > 0) {
        this.plane.position.y = -arc
        this.plane.rotation.z = -Math.sign(x) * Math.asin(effectiveX / R)
      } else {
        this.plane.position.y = arc
        this.plane.rotation.z = Math.sign(x) * Math.asin(effectiveX / R)
      }
    }
    this.speed = scroll.current - scroll.last
    this.program.uniforms.uTime.value += 0.04
    this.program.uniforms.uSpeed.value = this.speed
    const planeOffset = this.plane.scale.x / 2
    const viewportOffset = this.viewport.width / 2
    this.isBefore = this.plane.position.x + planeOffset < -viewportOffset
    this.isAfter = this.plane.position.x - planeOffset > viewportOffset
    if (direction === 'right' && this.isBefore) {
      this.extra -= this.widthTotal
      this.isBefore = this.isAfter = false
    }
    if (direction === 'left' && this.isAfter) {
      this.extra += this.widthTotal
      this.isBefore = this.isAfter = false
    }
  }
  onResize({ screen, viewport } = {}) {
    if (screen) this.screen = screen
    if (viewport) this.viewport = viewport
    this.scale = this.screen.height / 1320
    this.plane.scale.y = (this.viewport.height * (900 * this.scale)) / this.screen.height
    this.plane.scale.x = (this.viewport.width * (700 * this.scale)) / this.screen.width
    this.plane.program.uniforms.uPlaneSizes.value = [this.plane.scale.x, this.plane.scale.y]
    this.padding = 1.4
    this.width = this.plane.scale.x + this.padding
    this.widthTotal = this.width * this.length
    this.x = this.width * this.index
  }
}

class App {
  constructor(container, { items, bend = 2.4, textColor = '#ffffff', borderRadius = 0.06, font = LABEL_FONT, scrollSpeed = 2, scrollEase = 0.06, autoSpeed = 0.022, noBg = false } = {}) {
    this.container = container
    this.scrollSpeed = scrollSpeed
    this.scroll = { ease: scrollEase, current: 0, target: 0, last: 0 }
    this.autoSpeed = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : autoSpeed
    this.hover = false
    this.noBg = noBg
    this.createRenderer()
    this.createCamera()
    this.createScene()
    this.onResize()
    this.createGeometry()
    this.createMedias(items, bend, textColor, borderRadius, font)
    // 从第二份拷贝的开头起步，保证首屏左右两侧都有卡（否则要等皮带转一圈左边才填满）
    const startAt = this.medias[0].width * items.length
    this.scroll.current = this.scroll.target = this.scroll.last = startAt
    this.update()
    this.addEventListeners()
  }
  createRenderer() {
    this.renderer = new Renderer({ alpha: true, antialias: true, dpr: Math.min(window.devicePixelRatio || 1, 2) })
    this.gl = this.renderer.gl
    this.gl.clearColor(0, 0, 0, 0)
    this.container.appendChild(this.gl.canvas)
  }
  createCamera() {
    this.camera = new Camera(this.gl)
    this.camera.fov = 45
    this.camera.position.z = 20
  }
  createScene() {
    this.scene = new Transform()
    // 内容在画布内整体上提（世界单位），压掉顶部空白，把富余留给下方标签
    this.scene.position.y = 1.3
  }
  createGeometry() {
    this.planeGeometry = new Plane(this.gl, { heightSegments: 50, widthSegments: 100 })
  }
  createMedias(items, bend, textColor, borderRadius, font) {
    // 首尾拼接一份实现无缝循环；24 只均不同，短时间内不会看到重复形象
    this.mediasImages = items.concat(items)
    this.medias = this.mediasImages.map((data, index) => new Media({
      geometry: this.planeGeometry,
      gl: this.gl,
      image: data.image,
      index,
      length: this.mediasImages.length,
      scene: this.scene,
      screen: this.screen,
      text: data.text,
      viewport: this.viewport,
      bend,
      textColor,
      borderRadius,
      font,
      noBg: this.noBg
    }))
  }
  onTouchDown(e) {
    this.isDown = true
    this.scroll.position = this.scroll.current
    this.start = e.touches ? e.touches[0].clientX : e.clientX
  }
  onTouchMove(e) {
    if (!this.isDown) return
    const x = e.touches ? e.touches[0].clientX : e.clientX
    const distance = (this.start - x) * (this.scrollSpeed * 0.025)
    this.scroll.target = this.scroll.position + distance
  }
  onTouchUp() {
    this.isDown = false
  }
  onWheel(e) {
    // 只接管横向滚动（触控板左右扫），纵向留给页面
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    e.preventDefault()
    this.scroll.target += (e.deltaX > 0 ? this.scrollSpeed : -this.scrollSpeed) * 0.2
  }
  onKeyDown(e) {
    if (e.key === 'ArrowRight') { e.preventDefault(); this.scroll.target += this.scrollSpeed * 2 }
    if (e.key === 'ArrowLeft') { e.preventDefault(); this.scroll.target -= this.scrollSpeed * 2 }
  }
  onResize() {
    this.screen = { width: this.container.clientWidth, height: this.container.clientHeight }
    this.renderer.setSize(this.screen.width, this.screen.height)
    this.camera.perspective({ aspect: this.screen.width / this.screen.height })
    const fov = (this.camera.fov * Math.PI) / 180
    const height = 2 * Math.tan(fov / 2) * this.camera.position.z
    const width = height * this.camera.aspect
    this.viewport = { width, height }
    if (this.medias) {
      this.medias.forEach((media) => media.onResize({ screen: this.screen, viewport: this.viewport }))
    }
  }
  update() {
    if (!this.isDown && !this.hover) this.scroll.target += this.autoSpeed
    this.scroll.current = lerp(this.scroll.current, this.scroll.target, this.scroll.ease)
    const direction = this.scroll.current > this.scroll.last ? 'right' : 'left'
    if (this.medias) this.medias.forEach((media) => media.update(this.scroll, direction))
    this.renderer.render({ scene: this.scene, camera: this.camera })
    this.scroll.last = this.scroll.current
    this.raf = window.requestAnimationFrame(this.update.bind(this))
  }
  addEventListeners() {
    const c = this.container
    this.boundOnResize = this.onResize.bind(this)
    this.boundOnWheel = this.onWheel.bind(this)
    this.boundOnTouchDown = this.onTouchDown.bind(this)
    this.boundOnTouchMove = this.onTouchMove.bind(this)
    this.boundOnTouchUp = this.onTouchUp.bind(this)
    this.boundOnKeyDown = this.onKeyDown.bind(this)
    this.boundOnEnter = () => { this.hover = true }
    this.boundOnLeave = () => { this.hover = false }
    window.addEventListener('resize', this.boundOnResize)
    c.addEventListener('wheel', this.boundOnWheel, { passive: false })
    c.addEventListener('mousedown', this.boundOnTouchDown)
    window.addEventListener('mousemove', this.boundOnTouchMove)
    window.addEventListener('mouseup', this.boundOnTouchUp)
    c.addEventListener('touchstart', this.boundOnTouchDown, { passive: true })
    c.addEventListener('touchmove', this.boundOnTouchMove, { passive: true })
    c.addEventListener('touchend', this.boundOnTouchUp)
    c.addEventListener('keydown', this.boundOnKeyDown)
    c.addEventListener('mouseenter', this.boundOnEnter)
    c.addEventListener('mouseleave', this.boundOnLeave)
  }
  destroy() {
    window.cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.boundOnResize)
    window.removeEventListener('mousemove', this.boundOnTouchMove)
    window.removeEventListener('mouseup', this.boundOnTouchUp)
    const c = this.container
    c.removeEventListener('wheel', this.boundOnWheel)
    c.removeEventListener('mousedown', this.boundOnTouchDown)
    c.removeEventListener('touchstart', this.boundOnTouchDown)
    c.removeEventListener('touchmove', this.boundOnTouchMove)
    c.removeEventListener('touchend', this.boundOnTouchUp)
    c.removeEventListener('keydown', this.boundOnKeyDown)
    c.removeEventListener('mouseenter', this.boundOnEnter)
    c.removeEventListener('mouseleave', this.boundOnLeave)
    if (this.renderer && this.renderer.gl && this.renderer.gl.canvas.parentNode) {
      this.renderer.gl.canvas.parentNode.removeChild(this.renderer.gl.canvas)
    }
  }
}

// —— 自动挂载：容器进入视口附近才初始化（省 GPU）——
// 定稿：只保留透明底模式（彩卡模式已淘汰移除），全站纯黑主题、标签固定亮色
;(function () {
  const el = document.getElementById('petOrbit')
  if (!el) return
  function boot() {
    try {
      new App(el, { items: ITEMS_NOBG, bend: 2.4, textColor: '#f5f4f2', noBg: true })
    } catch (err) {
      el.closest('.pet-orbit-wrap').style.display = 'none'
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
