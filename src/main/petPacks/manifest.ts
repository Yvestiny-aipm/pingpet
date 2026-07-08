import { statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PetState } from '@shared/types'

/**
 * 皮肤包 manifest 读取与校验（v0.3）。
 *
 * 安全第一：所有校验在“导入前”做，任何一条不过就拒绝整个包，绝不半导入。
 * 关键防御：manifest 里的素材路径必须是相对路径、且 resolve 后仍落在包目录内（防 ../ 穿越）。
 */

/** 皮肤包支持的状态（对齐我们的 PetState，注意本项目没有独立的 done） */
export const PACK_STATES: PetState[] = ['idle', 'happy', 'sleepy', 'attention', 'thinking', 'failed']

/** 允许的素材扩展名（不做 gif/视频/lottie/远程 URL） */
const ALLOWED_EXT = ['.png', '.webp', '.svg']

/** 单素材大小上限 5MB，整包大小上限 30MB */
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_PACK_BYTES = 30 * 1024 * 1024

const DEFAULT_ACCENT = '#7AA7FF'

/** 校验通过后的规范化 manifest（路径都是相对包目录的相对路径） */
export interface ValidatedManifest {
  id: string
  name: string
  version: string
  author: string
  description: string
  accentColor: string
  /** 相对包目录的缩略图路径，可能为空 */
  thumbnail?: string
  /** 状态 → 相对包目录的素材路径。至少含 idle */
  states: Partial<Record<PetState, string>>
}

export type ManifestResult =
  | { ok: true; manifest: ValidatedManifest }
  | { ok: false; error: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 素材相对路径安全性：必须相对、扩展名允许、resolve 后仍在包目录内、文件存在且不超限 */
function checkAssetPath(
  packDir: string,
  rel: unknown,
  label: string
): { ok: true; rel: string; bytes: number } | { ok: false; error: string } {
  if (typeof rel !== 'string' || !rel.trim()) {
    return { ok: false, error: `${label} 路径必须是非空字符串` }
  }
  const r = rel.trim()
  if (isAbsolute(r)) return { ok: false, error: `${label} 不允许绝对路径：${r}` }
  const ext = r.slice(r.lastIndexOf('.')).toLowerCase()
  if (!ALLOWED_EXT.includes(ext)) {
    return { ok: false, error: `${label} 扩展名不被允许（只允许 png/webp/svg）：${r}` }
  }
  // 关键：resolve 后必须仍在 packDir 内（防 ../ 穿越、软链跳出）
  const abs = resolve(packDir, r)
  const relBack = relative(packDir, abs)
  if (relBack.startsWith('..') || isAbsolute(relBack) || relBack.split(sep).includes('..')) {
    return { ok: false, error: `${label} 路径跳出了皮肤包目录（疑似 ../ 穿越）：${r}` }
  }
  let bytes = 0
  try {
    const st = statSync(abs)
    if (!st.isFile()) return { ok: false, error: `${label} 不是文件：${r}` }
    bytes = st.size
  } catch {
    return { ok: false, error: `${label} 文件不存在：${r}` }
  }
  if (bytes > MAX_FILE_BYTES) {
    return { ok: false, error: `${label} 文件超过 5MB 上限：${r}` }
  }
  return { ok: true, rel: r, bytes }
}

/**
 * 校验一个原始 manifest 对象（已 JSON.parse）。packDir 用于路径穿越/存在性/大小校验。
 */
export function validateManifest(raw: unknown, packDir: string): ManifestResult {
  if (!isPlainObject(raw)) return { ok: false, error: 'manifest.json 不是合法的 JSON 对象' }

  // id：小写字母/数字/短横线/下划线，长度 2-40
  const id = raw.id
  if (typeof id !== 'string' || !/^[a-z0-9_-]{2,40}$/.test(id)) {
    return { ok: false, error: 'manifest.id 非法（只允许小写字母/数字/-/_，长度 2-40）' }
  }
  // name：非空，长度 1-30
  const name = raw.name
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 30) {
    return { ok: false, error: 'manifest.name 非法（非空，长度 1-30）' }
  }
  // description：可选，最长 80
  let description = ''
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string' || raw.description.length > 80) {
      return { ok: false, error: 'manifest.description 非法（可选，最长 80）' }
    }
    description = raw.description
  }
  // accentColor：#RRGGBB，非法则用默认色（不报错）
  let accentColor = DEFAULT_ACCENT
  if (typeof raw.accentColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.accentColor)) {
    accentColor = raw.accentColor
  }
  // version / author：可选字符串
  const version = typeof raw.version === 'string' ? raw.version : '1.0.0'
  const author = typeof raw.author === 'string' ? raw.author : ''

  // states：必须是对象，且必须含 idle
  if (!isPlainObject(raw.states)) {
    return { ok: false, error: 'manifest.states 缺失或不是对象' }
  }
  const rawStates = raw.states
  if (rawStates.idle === undefined) {
    return { ok: false, error: '皮肤包必须包含 idle 状态' }
  }

  const states: Partial<Record<PetState, string>> = {}
  let totalBytes = 0
  for (const state of PACK_STATES) {
    const v = rawStates[state]
    if (v === undefined) continue // 缺失的状态允许，渲染时 fallback
    const res = checkAssetPath(packDir, v, `states.${state}`)
    if (!res.ok) return { ok: false, error: res.error }
    states[state] = res.rel
    totalBytes += res.bytes
  }

  // thumbnail：可选
  let thumbnail: string | undefined
  if (raw.thumbnail !== undefined) {
    const res = checkAssetPath(packDir, raw.thumbnail, 'thumbnail')
    if (!res.ok) return { ok: false, error: res.error }
    thumbnail = res.rel
    totalBytes += res.bytes
  }

  if (totalBytes > MAX_PACK_BYTES) {
    return { ok: false, error: '皮肤包总大小超过 30MB 上限' }
  }

  return {
    ok: true,
    manifest: { id, name: name.trim(), version, author, description, accentColor, thumbnail, states }
  }
}

/** 读并校验 packDir/manifest.json */
export function readAndValidateManifest(packDir: string): ManifestResult {
  const manifestPath = join(packDir, 'manifest.json')
  let raw: unknown
  try {
    // 延迟到这里 require fs 的 readFileSync，避免顶部循环依赖顾虑
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    return {
      ok: false,
      error: `读取 manifest.json 失败：${err instanceof Error ? err.message : String(err)}`
    }
  }
  return validateManifest(raw, packDir)
}
