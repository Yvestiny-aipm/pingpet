/**
 * AI 抠图（v0.3.1，本地 WASM 推理，纯前端）。
 *
 * 用 transformers.js（onnxruntime-web / WASM）在渲染进程本地跑 BiRefNet_lite 语义分割，
 * 抠掉「复杂/模糊/渐变背景 + 主体背景颜色接近」这类纯色算法搞不定的图。
 *
 * - 模型 MIT 许可可商用；首次使用时从 HuggingFace 下载（约 100+MB），之后缓存本地离线用。
 * - 只在「纯色抠图搞不定」时才调用；输出带 alpha matte 的透明 PNG（边缘自然）。
 * - 全程本地：图片不出机器，只有首次下模型联网。
 */

const MODEL_ID = 'onnx-community/BiRefNet_lite-ONNX'
// fp16 体积小但部分 WASM 后端支持不稳；先用 q8/默认，效果不足再调。
const MODEL_DTYPE = 'fp32'

export interface AiCutoutProgress {
  /** 'download' 下载模型中 | 'run' 推理中 */
  phase: 'download' | 'run'
  /** 0-100，download 阶段有意义 */
  progress?: number
  /** 正在下载的文件名 */
  file?: string
}

type ProgressCb = (p: AiCutoutProgress) => void

// 模型单例：首次加载后缓存在内存，避免重复初始化
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let modelPromise: Promise<{ model: any; processor: any; RawImage: any }> | null = null

async function loadModel(onProgress?: ProgressCb): Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processor: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RawImage: any
}> {
  if (modelPromise) return modelPromise
  modelPromise = (async () => {
    const tf = await import('@huggingface/transformers')
    const { AutoModel, AutoProcessor, RawImage, env } = tf as unknown as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      AutoModel: any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      AutoProcessor: any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      RawImage: any
      env: { allowLocalModels: boolean; useBrowserCache: boolean }
    }
    // 只从远端 hub 拉（首次），之后走浏览器缓存
    env.allowLocalModels = false
    env.useBrowserCache = true

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const progressCb = (data: any): void => {
      if (!onProgress) return
      if (data?.status === 'progress' && typeof data.progress === 'number') {
        onProgress({ phase: 'download', progress: Math.round(data.progress), file: data.file })
      }
    }

    const model = await AutoModel.from_pretrained(MODEL_ID, {
      dtype: MODEL_DTYPE,
      progress_callback: progressCb
    })
    const processor = await AutoProcessor.from_pretrained(MODEL_ID, {
      progress_callback: progressCb
    })
    return { model, processor, RawImage }
  })()
  return modelPromise
}

/**
 * 用 AI 抠掉图片背景，返回透明 PNG dataUrl。
 * 失败（下载失败/推理异常）时返回 null，调用方回退（用原图或纯色抠图结果）。
 */
export async function aiRemoveBackground(
  dataUrl: string,
  onProgress?: ProgressCb
): Promise<string | null> {
  try {
    const { model, processor, RawImage } = await loadModel(onProgress)

    onProgress?.({ phase: 'run' })
    // 从 dataUrl 读成 RawImage
    const image = await RawImage.fromURL(dataUrl)
    const { pixel_values } = await processor(image)

    // 推理：BiRefNet 输出单通道 mask（sigmoid 后 0..1）
    const { output } = await model({ input: pixel_values })

    // output 是 [1,1,H,W] 的 tensor；取出并 resize 回原图尺寸当 alpha
    const maskTensor = output[0]
    const mask = await RawImage.fromTensor(
      maskTensor.mul(255).to('uint8')
    ).resize(image.width, image.height)

    // 把 mask 当 alpha 通道，合成透明 PNG
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    // 先画原图
    const srcImg = new Image()
    await new Promise<void>((res, rej) => {
      srcImg.onload = () => res()
      srcImg.onerror = () => rej(new Error('src load fail'))
      srcImg.src = dataUrl
    })
    ctx.drawImage(srcImg, 0, 0, image.width, image.height)

    const imgData = ctx.getImageData(0, 0, image.width, image.height)
    const maskData = mask.data // 单通道，长度 = w*h
    for (let i = 0; i < maskData.length; i++) {
      imgData.data[i * 4 + 3] = maskData[i] // alpha = mask 值
    }
    ctx.putImageData(imgData, 0, 0)
    return canvas.toDataURL('image/png')
  } catch (e) {
    console.error('[aiCutout] 失败:', e)
    return null
  }
}
