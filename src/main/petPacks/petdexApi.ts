import { net } from 'electron'
import { importPetdexFromZipBuffer } from './importPetdexPack'
import type { PetdexListItem, PetdexInstallResult } from '@shared/types'

/**
 * v0.4：在线库——从 PetDex 公开 API 拉宠物列表、按需下载安装。
 *
 * 隐私边界（重要）：这是**唯一**会联网的功能，且完全由用户主动触发（打开形象库 tab / 点安装）。
 * 桌宠的核心功能（监控 Codex/Claude Code）始终纯本地、从不联网。
 *
 * 用 Electron 的 net 模块（走系统代理、比 node https 稳）。全防御式，网络失败返回错误不崩。
 */

const MANIFEST_URL = 'https://petdex.dev/api/manifest'

/** 用 electron net 发一个 GET，返回 Buffer（含重定向跟随）。超时/失败抛错。 */
function fetchBuffer(url: string, timeoutMs = 20000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url, redirect: 'follow' })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      try {
        request.abort()
      } catch {
        /* ignore */
      }
      reject(new Error('请求超时'))
    }, timeoutMs)

    request.on('response', (response) => {
      const status = response.statusCode
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        clearTimeout(timer)
        if (status >= 200 && status < 300) resolve(Buffer.concat(chunks))
        else reject(new Error(`HTTP ${status}`))
      })
      response.on('error', (err: Error) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    request.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    request.end()
  })
}

/**
 * 拉取 PetDex 全量宠物列表。返回精简后的列表项（供渲染层展示 + 一键装）。
 * 失败返回 { ok:false }，UI 显示"暂时连不上形象库"。
 */
export async function fetchPetdexList(): Promise<
  { ok: true; total: number; pets: PetdexListItem[] } | { ok: false; error: string }
> {
  try {
    const buf = await fetchBuffer(MANIFEST_URL)
    const data = JSON.parse(buf.toString('utf8')) as {
      total?: number
      pets?: Array<Record<string, unknown>>
    }
    const rawPets = Array.isArray(data.pets) ? data.pets : []
    const pets: PetdexListItem[] = []
    for (const p of rawPets) {
      const slug = typeof p.slug === 'string' ? p.slug : ''
      const spritesheetUrl = typeof p.spritesheetUrl === 'string' ? p.spritesheetUrl : ''
      const zipUrl = typeof p.zipUrl === 'string' ? p.zipUrl : ''
      if (!slug || !spritesheetUrl || !zipUrl) continue
      pets.push({
        slug,
        displayName: typeof p.displayName === 'string' ? p.displayName : slug,
        kind: typeof p.kind === 'string' ? p.kind : '',
        author: typeof p.submittedBy === 'string' ? p.submittedBy : '',
        spritesheetUrl,
        zipUrl
      })
    }
    return { ok: true, total: typeof data.total === 'number' ? data.total : pets.length, pets }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 下载并安装某一只 PetDex 宠物（从它的 zipUrl）。装到我们的 petdex 目录。
 */
export async function installPetdexPet(
  zipUrl: string,
  displayName: string
): Promise<PetdexInstallResult> {
  try {
    const buf = await fetchBuffer(zipUrl, 40000)
    const res = importPetdexFromZipBuffer(buf, displayName)
    if (res.ok) return { ok: true, slug: res.slug, name: res.name }
    return { ok: false, error: res.error }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
