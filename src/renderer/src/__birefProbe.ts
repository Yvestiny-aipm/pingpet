/** 临时 dev 探针：实测 BiRefNet_lite 在 transformers.js 里的真实调用方式和输出结构。验证后删除。 */
declare global {
  interface Window {
    __birefProbe?: (dataUrl: string) => Promise<unknown>
  }
}

window.__birefProbe = async (dataUrl: string) => {
  const log: string[] = []
  const t0 = performance.now()
  try {
    const tf = await import('@huggingface/transformers')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyTf = tf as any
    const { AutoModel, AutoProcessor, RawImage, env } = anyTf
    env.allowLocalModels = false
    env.useBrowserCache = true
    log.push('tf imported')

    const MODEL = 'onnx-community/BiRefNet_lite-ONNX'
    log.push('loading model (fp32)... 首次会下载 ~224MB')
    const model = await AutoModel.from_pretrained(MODEL, { dtype: 'fp32' })
    log.push('model loaded +' + Math.round(performance.now() - t0) + 'ms')
    const processor = await AutoProcessor.from_pretrained(MODEL)
    log.push('processor loaded +' + Math.round(performance.now() - t0) + 'ms')

    const image = await RawImage.fromURL(dataUrl)
    log.push('image ' + image.width + 'x' + image.height + ' channels=' + image.channels)

    const inputs = await processor(image)
    log.push('processor output keys=' + Object.keys(inputs).join(','))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pv = (inputs as any).pixel_values
    log.push('pixel_values dims=' + JSON.stringify(pv?.dims))

    const out = await model({ input: pv })
    log.push('model output keys=' + Object.keys(out).join(','))
    // 把每个输出的形状打出来
    for (const k of Object.keys(out)) {
      const v = out[k]
      if (Array.isArray(v)) {
        log.push(`  ${k}: Array len=${v.length}, [0].dims=${JSON.stringify(v[0]?.dims)}`)
      } else if (v?.dims) {
        log.push(`  ${k}: tensor dims=${JSON.stringify(v.dims)} type=${v.type}`)
      } else {
        log.push(`  ${k}: ${typeof v}`)
      }
    }
    log.push('TOTAL +' + Math.round(performance.now() - t0) + 'ms')
    return { ok: true, log }
  } catch (e) {
    log.push('ERROR: ' + (e instanceof Error ? e.stack || e.message : String(e)))
    return { ok: false, log }
  }
}

export {}
