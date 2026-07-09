// 吊牌背景：GridScan 网格扫描（React Bits 移植，去 React/face-api/陀螺仪）。
// 按用户要求定制：
//  1) 配色品牌紫（线=浅紫、扫描光=亮紫），匹配全站黑色主题
//  2) 扫描光只保留「由近到远」单方向（scanDirection=forward），每 3 秒发射一趟
//  3) 背景完全静止：无鼠标视差、无线条抖动、无噪点闪烁——唯一会动的只有扫描光
// 着色器原样照搬；bloom/色散用 postprocessing（和原组件一致）。
import * as THREE from 'three'
import { BloomEffect, ChromaticAberrationEffect, EffectComposer, EffectPass, RenderPass } from 'postprocessing'

const vert = `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const frag = `
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform vec2 uSkew;
uniform float uTilt;
uniform float uYaw;
uniform float uLineThickness;
uniform vec3 uLinesColor;
uniform vec3 uScanColor;
uniform float uGridScale;
uniform float uLineStyle;
uniform float uLineJitter;
uniform float uScanOpacity;
uniform float uScanDirection;
uniform float uNoise;
uniform float uBloomOpacity;
uniform float uScanGlow;
uniform float uScanSoftness;
uniform float uPhaseTaper;
uniform float uScanDuration;
uniform float uScanDelay;
varying vec2 vUv;

float smoother01(float a, float b, float x){
  float t = clamp((x - a) / max(1e-5, (b - a)), 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 p = (2.0 * fragCoord - iResolution.xy) / iResolution.y;

    vec3 ro = vec3(0.0);
    vec3 rd = normalize(vec3(p, 2.0));

    float cR = cos(uTilt), sR = sin(uTilt);
    rd.xy = mat2(cR, -sR, sR, cR) * rd.xy;

    float cY = cos(uYaw), sY = sin(uYaw);
    rd.xz = mat2(cY, -sY, sY, cY) * rd.xz;

    vec2 skew = clamp(uSkew, vec2(-0.7), vec2(0.7));
    rd.xy += skew * rd.z;

    vec3 color = vec3(0.0);
  float minT = 1e20;
  float gridScale = max(1e-5, uGridScale);
    float fadeStrength = 2.0;
    vec2 gridUV = vec2(0.0);

  float hitIsY = 1.0;
    for (int i = 0; i < 4; i++)
    {
        float isY = float(i < 2);
        float pos = mix(-0.2, 0.2, float(i)) * isY + mix(-0.5, 0.5, float(i - 2)) * (1.0 - isY);
        float num = pos - (isY * ro.y + (1.0 - isY) * ro.x);
        float den = isY * rd.y + (1.0 - isY) * rd.x;
        float t = num / den;
        vec3 h = ro + rd * t;

        float depthBoost = smoothstep(0.0, 3.0, h.z);
        h.xy += skew * 0.15 * depthBoost;

    bool use = t > 0.0 && t < minT;
    gridUV = use ? mix(h.zy, h.xz, isY) / gridScale : gridUV;
    minT = use ? t : minT;
    hitIsY = use ? isY : hitIsY;
    }

    vec3 hit = ro + rd * minT;
    float dist = length(hit - ro);

  float jitterAmt = clamp(uLineJitter, 0.0, 1.0);
  if (jitterAmt > 0.0) {
    vec2 j = vec2(
      sin(gridUV.y * 2.7 + iTime * 1.8),
      cos(gridUV.x * 2.3 - iTime * 1.6)
    ) * (0.15 * jitterAmt);
    gridUV += j;
  }
  float fx = fract(gridUV.x);
  float fy = fract(gridUV.y);
  float ax = min(fx, 1.0 - fx);
  float ay = min(fy, 1.0 - fy);
  float wx = fwidth(gridUV.x);
  float wy = fwidth(gridUV.y);
  float halfPx = max(0.0, uLineThickness) * 0.5;

  float tx = halfPx * wx;
  float ty = halfPx * wy;

  float aax = wx;
  float aay = wy;

  float lineX = 1.0 - smoothstep(tx, tx + aax, ax);
  float lineY = 1.0 - smoothstep(ty, ty + aay, ay);
  float primaryMask = max(lineX, lineY);

  vec2 gridUV2 = (hitIsY > 0.5 ? hit.xz : hit.zy) / gridScale;
  if (jitterAmt > 0.0) {
    vec2 j2 = vec2(
      cos(gridUV2.y * 2.1 - iTime * 1.4),
      sin(gridUV2.x * 2.5 + iTime * 1.7)
    ) * (0.15 * jitterAmt);
    gridUV2 += j2;
  }
  float fx2 = fract(gridUV2.x);
  float fy2 = fract(gridUV2.y);
  float ax2 = min(fx2, 1.0 - fx2);
  float ay2 = min(fy2, 1.0 - fy2);
  float wx2 = fwidth(gridUV2.x);
  float wy2 = fwidth(gridUV2.y);
  float tx2 = halfPx * wx2;
  float ty2 = halfPx * wy2;
  float aax2 = wx2;
  float aay2 = wy2;
  float lineX2 = 1.0 - smoothstep(tx2, tx2 + aax2, ax2);
  float lineY2 = 1.0 - smoothstep(ty2, ty2 + aay2, ay2);
    float altMask = max(lineX2, lineY2);

    float edgeDistX = min(abs(hit.x - (-0.5)), abs(hit.x - 0.5));
    float edgeDistY = min(abs(hit.y - (-0.2)), abs(hit.y - 0.2));
    float edgeDist = mix(edgeDistY, edgeDistX, hitIsY);
    float edgeGate = 1.0 - smoothstep(gridScale * 0.5, gridScale * 2.0, edgeDist);
    altMask *= edgeGate;

  float lineMask = max(primaryMask, altMask);

    float fade = exp(-dist * fadeStrength);

    float dur = max(0.05, uScanDuration);
    float del = max(0.0, uScanDelay);
    float scanZMax = 2.0;
    float widthScale = max(0.1, uScanGlow);
    float sigma = max(0.001, 0.18 * widthScale * uScanSoftness);
    float sigmaA = sigma * 2.0;

    float combinedPulse = 0.0;
    float combinedAura = 0.0;

    float cycle = dur + del;
    float tCycle = mod(iTime, cycle);
    float scanPhase = clamp((tCycle - del) / dur, 0.0, 1.0);
    float phase = scanPhase;
    if (uScanDirection > 0.5 && uScanDirection < 1.5) {
      phase = 1.0 - phase;
    } else if (uScanDirection > 1.5) {
      float t2 = mod(max(0.0, iTime - del), 2.0 * dur);
      phase = (t2 < dur) ? (t2 / dur) : (1.0 - (t2 - dur) / dur);
    }
    float scanZ = phase * scanZMax;
    float dz = abs(hit.z - scanZ);
    float lineBand = exp(-0.5 * (dz * dz) / (sigma * sigma));
    float taper = clamp(uPhaseTaper, 0.0, 0.49);
    float headW = taper;
    float tailW = taper;
    float headFade = smoother01(0.0, headW, phase);
    float tailFade = 1.0 - smoother01(1.0 - tailW, 1.0, phase);
    float phaseWindow = headFade * tailFade;
    float pulseBase = lineBand * phaseWindow;
    combinedPulse += pulseBase * clamp(uScanOpacity, 0.0, 1.0);
    float auraBand = exp(-0.5 * (dz * dz) / (sigmaA * sigmaA));
    combinedAura += (auraBand * 0.25) * phaseWindow * clamp(uScanOpacity, 0.0, 1.0);

  float lineVis = lineMask;
  // 定制：线条只在扫描光经过时显现——黑色细线在紫光里以剪影浮现；静息时画布几乎全透明
  vec3 gridCol = uLinesColor * lineVis * fade;
  vec3 scanCol = uScanColor * combinedPulse;
  vec3 scanAura = uScanColor * combinedAura;
  float carve = 1.0 - lineVis * 0.85; // 光带经过处，线条位置挖暗
  color = gridCol + (scanCol + scanAura) * carve;

  color = clamp(color, 0.0, 1.0);
  // alpha 只由扫描光决定 + 一丝极淡的常驻线（几乎与背景融为一体）
  float alpha = clamp(max(combinedPulse, combinedAura), 0.0, 1.0);
  alpha = max(alpha, lineVis * fade * 0.12);
  fragColor = vec4(color, alpha);
}

void main(){
  vec4 c;
  mainImage(c, vUv * iResolution.xy);
  gl_FragColor = c;
}
`

function srgbColor(hex) {
  return new THREE.Color(hex).convertSRGBToLinear()
}

// 用法：mountGridScan(挂载容器)。配色/参数按官网品牌定制，其余对齐原组件 usage 示例。
export function mountGridScan(container) {
  const OPTS = {
    lineThickness: 0.6,      // 细线（用户要求比 1 更细）
    linesColor: '#000000',   // 黑色线条：静息隐形，扫描光里以剪影显现
    scanColor: '#c9a2ff',    // 品牌紫（亮）——扫描光
    scanOpacity: 0.4,
    gridScale: 0.1,
    lineJitter: 0,           // 背景静止：线条不抖
    bloomIntensity: 0.6,
    chromaticAberration: 0.002,
    noiseIntensity: 0,       // 背景静止：无噪点闪烁
    scanGlow: 0.5,
    scanSoftness: 2,
    scanPhaseTaper: 0.9,
    scanDuration: 2.0,
    scanDelay: 4.0,          // 2s 扫描 + 4s 间歇 = 每 6 秒发射一趟
    scanDirection: 0 // forward：只保留「由近到远」，按需求砍掉回程
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(container.clientWidth, container.clientHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NoToneMapping
  renderer.autoClear = false
  renderer.setClearColor(0x000000, 0)
  container.appendChild(renderer.domElement)

  const uniforms = {
    iResolution: { value: new THREE.Vector3(container.clientWidth, container.clientHeight, renderer.getPixelRatio()) },
    iTime: { value: 0 },
    uSkew: { value: new THREE.Vector2(0, 0) },
    uTilt: { value: 0 },
    uYaw: { value: 0 },
    uLineThickness: { value: OPTS.lineThickness },
    uLinesColor: { value: srgbColor(OPTS.linesColor) },
    uScanColor: { value: srgbColor(OPTS.scanColor) },
    uGridScale: { value: OPTS.gridScale },
    uLineStyle: { value: 0 },
    uLineJitter: { value: OPTS.lineJitter },
    uScanOpacity: { value: OPTS.scanOpacity },
    uNoise: { value: OPTS.noiseIntensity },
    uBloomOpacity: { value: OPTS.bloomIntensity },
    uScanGlow: { value: OPTS.scanGlow },
    uScanSoftness: { value: OPTS.scanSoftness },
    uPhaseTaper: { value: OPTS.scanPhaseTaper },
    uScanDuration: { value: OPTS.scanDuration },
    uScanDelay: { value: OPTS.scanDelay },
    uScanDirection: { value: OPTS.scanDirection }
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    depthTest: false
  })
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material))

  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new BloomEffect({ intensity: 1.0, luminanceThreshold: 0, luminanceSmoothing: 0 })
  bloom.blendMode.opacity.value = OPTS.bloomIntensity
  const chroma = new ChromaticAberrationEffect({
    offset: new THREE.Vector2(OPTS.chromaticAberration, OPTS.chromaticAberration),
    radialModulation: true,
    modulationOffset: 0.0
  })
  const effectPass = new EffectPass(camera, bloom, chroma)
  effectPass.renderToScreen = true
  composer.addPass(effectPass)

  // 背景完全静止：不接鼠标视差，uSkew/uTilt/uYaw 恒为 0

  const onResize = () => {
    renderer.setSize(container.clientWidth, container.clientHeight)
    uniforms.iResolution.value.set(container.clientWidth, container.clientHeight, renderer.getPixelRatio())
    composer.setSize(container.clientWidth, container.clientHeight)
  }
  new ResizeObserver(onResize).observe(container)

  let last = performance.now()
  function tick() {
    const now = performance.now()
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000))
    last = now
    uniforms.iTime.value = now / 1000
    renderer.clear(true, true, true)
    composer.render(dt)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
