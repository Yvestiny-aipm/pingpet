/**
 * 纯色背景抠图（v0.3.1，纯前端 Canvas，零依赖、不联网）。
 *
 * 思路（只处理「纯色背景」这一常见场景，不碰复杂照片背景）：
 *   1. 采样图片四个角的颜色，判断背景是否为纯色（四角颜色互相接近才算）。
 *   2. 从四条边缘做漫水填充（flood fill / BFS），把「连通到边缘 且 颜色接近背景色」的像素设为透明。
 *      —— 只抠连通到边缘的背景，主体内部的同色区域不会被误伤。
 *   3. 对刚好在阈值边界的像素做一点半透明羽化，减少生硬黑边/锯齿。
 *
 * 判定为「非纯色背景」时返回 null，调用方应回退用原图（不硬抠、不搞坏图）。
 */

/** 两个 RGB 的欧氏距离平方（省一次开方） */
function colorDist2(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = r1 - r2
  const dg = g1 - g2
  const db = b1 - b2
  return dr * dr + dg * dg + db * db
}

/** 四角是否为纯色背景：四角两两颜色距离都小才算（阈值宽松些，容忍 jpg 噪点） */
function detectSolidCorner(
  data: Uint8ClampedArray,
  w: number,
  h: number
): { r: number; g: number; b: number } | null {
  const corners = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1]
  ]
  const cols = corners.map(([x, y]) => {
    const i = (y * w + x) * 4
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] }
  })
  // 有任一角本来就透明 → 视作已是透明图，不需要抠
  if (cols.some((c) => c.a < 250)) return null
  // 四角互相距离都要小（<~32 的色差²≈1024）才认定纯色背景
  const CORNER_TOL2 = 32 * 32
  for (let i = 1; i < cols.length; i++) {
    if (colorDist2(cols[0].r, cols[0].g, cols[0].b, cols[i].r, cols[i].g, cols[i].b) > CORNER_TOL2) {
      return null
    }
  }
  // 用四角平均色当背景色
  const r = Math.round(cols.reduce((s, c) => s + c.r, 0) / 4)
  const g = Math.round(cols.reduce((s, c) => s + c.g, 0) / 4)
  const b = Math.round(cols.reduce((s, c) => s + c.b, 0) / 4)
  return { r, g, b }
}

/**
 * 抠掉纯色背景。
 * @param source 已加载完成的图片元素或位图
 * @returns 抠好背景的透明 PNG dataUrl；若判定非纯色背景则返回 null
 */
export function removeSolidBackground(source: HTMLImageElement | ImageBitmap): string | null {
  const w = 'naturalWidth' in source ? source.naturalWidth || source.width : source.width
  const h = 'naturalHeight' in source ? source.naturalHeight || source.height : source.height
  if (!w || !h) return null

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(source as CanvasImageSource, 0, 0, w, h)

  let img: ImageData
  try {
    img = ctx.getImageData(0, 0, w, h)
  } catch {
    // 跨源污染等导致读不了像素 → 放弃抠图
    return null
  }
  const data = img.data

  const bg = detectSolidCorner(data, w, h)
  if (!bg) return null // 非纯色背景，交回原图

  // 阈值：核心透明阈（距离² < HARD 直接透明）、羽化上界（HARD~SOFT 之间按比例半透明）
  const HARD2 = 44 * 44
  const SOFT2 = 88 * 88

  // 从四条边所有像素入队做 BFS，只抹「连通到边缘」的背景
  const total = w * h
  const visited = new Uint8Array(total)
  const queue = new Int32Array(total)
  let qHead = 0
  let qTail = 0

  const enqueueIfBg = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const p = y * w + x
    if (visited[p]) return
    const i = p * 4
    const d2 = colorDist2(data[i], data[i + 1], data[i + 2], bg.r, bg.g, bg.b)
    if (d2 > SOFT2) return // 明显是主体，边界到此为止
    visited[p] = 1
    queue[qTail++] = p
  }

  for (let x = 0; x < w; x++) {
    enqueueIfBg(x, 0)
    enqueueIfBg(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    enqueueIfBg(0, y)
    enqueueIfBg(w - 1, y)
  }

  while (qHead < qTail) {
    const p = queue[qHead++]
    const x = p % w
    const y = (p - x) / w
    const i = p * 4
    const d2 = colorDist2(data[i], data[i + 1], data[i + 2], bg.r, bg.g, bg.b)
    if (d2 <= HARD2) {
      data[i + 3] = 0 // 纯背景 → 全透明
    } else {
      // 羽化带：距离越接近 SOFT 越不透明
      const t = (d2 - HARD2) / (SOFT2 - HARD2) // 0..1
      data[i + 3] = Math.round(data[i + 3] * t)
    }
    enqueueIfBg(x + 1, y)
    enqueueIfBg(x - 1, y)
    enqueueIfBg(x, y + 1)
    enqueueIfBg(x, y - 1)
  }

  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

/**
 * 从一个图片 dataUrl 抠掉纯色背景，返回透明 PNG 的 dataUrl。
 * 非纯色背景 / 加载失败时返回 null（调用方回退原图）。
 */
export function removeBackgroundFromDataUrl(dataUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const im = new Image()
    im.onload = () => {
      try {
        resolve(removeSolidBackground(im))
      } catch {
        resolve(null)
      }
    }
    im.onerror = () => resolve(null)
    im.src = dataUrl
  })
}
