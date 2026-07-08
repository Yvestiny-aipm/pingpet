import { inflateRawSync } from 'node:zlib'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { petdexImportedDir, petdexImportedRoot } from './paths'

/**
 * v0.4：导入 PetDex / Codex 格式宠物（pet.json + spritesheet.webp/png），
 * 支持「文件夹」或「zip 包」两种来源。装到我们自己的 userData/pet-packs/petdex/<slug>。
 *
 * zip 解压是自己手写的（读中央目录 + node:zlib inflateRaw），不引第三方依赖，
 * 参考 PawPause / crafter-station 的公开实现。全防御式，失败返回错误不崩。
 */

export type PetdexImportResult =
  | { ok: true; slug: string; name: string }
  | { ok: false; error: string }

/** 只允许安全的 slug 字符 */
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

function tryReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** slug 去重：已存在就加 -2 -3… */
function uniqueSlug(base: string): string {
  const safe = slugify(base) || 'pet'
  mkdirSync(petdexImportedRoot(), { recursive: true })
  const existing = new Set(tryReaddir(petdexImportedRoot()))
  if (!existing.has(safe)) return safe
  for (let i = 2; i < 1000; i++) {
    const c = `${safe}-${i}`
    if (!existing.has(c)) return c
  }
  return `${safe}-x`
}

/** 在一个目录里找到 pet.json 和 spritesheet；返回它们所在的目录（处理 zip 单层根目录） */
function locatePackRoot(dir: string): string | null {
  // 当前目录就有 pet.json 或 spritesheet
  const hasHere =
    existsSync(join(dir, 'pet.json')) ||
    existsSync(join(dir, 'spritesheet.webp')) ||
    existsSync(join(dir, 'spritesheet.png')) ||
    existsSync(join(dir, 'sprite.webp'))
  if (hasHere) return dir
  // 单层子目录里有
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  const dirs = entries.filter((e) => {
    try {
      return statSync(join(dir, e)).isDirectory() && !e.startsWith('.') && e !== '__MACOSX'
    } catch {
      return false
    }
  })
  if (dirs.length === 1) return locatePackRoot(join(dir, dirs[0]))
  return null
}

/** 找精灵图文件名（兼容 spritesheet.webp/png 与 PetDex 的 sprite.webp） */
function findSpriteName(root: string): string | null {
  for (const n of ['spritesheet.webp', 'spritesheet.png', 'sprite.webp', 'sprite.png']) {
    if (existsSync(join(root, n))) return n
  }
  return null
}

/** 从一个「已经是宠物包根目录」的地方，装到 petdex 目录 */
function installFromRoot(root: string): PetdexImportResult {
  const spriteName = findSpriteName(root)
  if (!spriteName) return { ok: false, error: '没找到 spritesheet（需要 .webp 或 .png 精灵图）' }

  // 读 pet.json（可选，缺了用目录名兜底）
  let manifest: Record<string, unknown> = {}
  const petJson = join(root, 'pet.json')
  if (existsSync(petJson)) {
    try {
      const p = JSON.parse(readFileSync(petJson, 'utf8'))
      if (p && typeof p === 'object' && !Array.isArray(p)) manifest = p as Record<string, unknown>
    } catch {
      /* 坏 json 忽略，用兜底 */
    }
  }

  const rawId =
    (typeof manifest.id === 'string' && manifest.id) ||
    (typeof manifest.slug === 'string' && manifest.slug) ||
    (typeof manifest.displayName === 'string' && manifest.displayName) ||
    basename(root)
  const slug = uniqueSlug(String(rawId))
  const name =
    (typeof manifest.displayName === 'string' && manifest.displayName.trim()) ||
    (typeof manifest.name === 'string' && manifest.name.trim()) ||
    slug

  const target = petdexImportedDir(slug)
  try {
    mkdirSync(target, { recursive: true })
    // 统一精灵图文件名为 spritesheet.<ext>，并写规范化 pet.json
    const ext = extname(spriteName).toLowerCase() === '.png' ? '.png' : '.webp'
    const targetSprite = `spritesheet${ext}`
    cpSync(join(root, spriteName), join(target, targetSprite))
    writeFileSync(
      join(target, 'pet.json'),
      JSON.stringify(
        {
          id: slug,
          displayName: name,
          description: typeof manifest.description === 'string' ? manifest.description : '',
          spritesheetPath: targetSprite,
          source: 'imported'
        },
        null,
        2
      ),
      'utf8'
    )
    return { ok: true, slug, name }
  } catch (err) {
    try {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    return { ok: false, error: `导入失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 从文件夹导入 PetDex 宠物 */
export function importPetdexFromDir(srcDir: string): PetdexImportResult {
  const root = locatePackRoot(srcDir)
  if (!root) return { ok: false, error: '这个文件夹里没有 spritesheet 精灵图，不是 PetDex 宠物包' }
  return installFromRoot(root)
}

/** 从 zip 导入 PetDex 宠物 */
export function importPetdexFromZip(zipPath: string): PetdexImportResult {
  let files: Array<{ name: string; data: Buffer }>
  try {
    files = unzip(readFileSync(zipPath))
  } catch (err) {
    return { ok: false, error: `zip 解压失败：${err instanceof Error ? err.message : String(err)}` }
  }
  // 解压到临时目录
  const workspace = join(petdexImportedRoot(), `.stage-${Date.now().toString(36)}`)
  try {
    mkdirSync(workspace, { recursive: true })
    for (const f of files) {
      if (f.name.endsWith('/') || f.name.includes('__MACOSX/')) continue
      const target = resolve(workspace, f.name)
      if (!target.startsWith(resolve(workspace))) continue // 防 zip 穿越
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, f.data)
    }
    const root = locatePackRoot(workspace)
    if (!root) return { ok: false, error: 'zip 里没有 spritesheet 精灵图，不是 PetDex 宠物包' }
    return installFromRoot(root)
  } catch (err) {
    return { ok: false, error: `导入失败：${err instanceof Error ? err.message : String(err)}` }
  } finally {
    try {
      if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

/**
 * 从已下载的 buffer（在线库一键安装用）导入。
 * 自动判断是 zip 还是裸 spritesheet：这里只处理 zip；裸图由调用方另处理。
 */
export function importPetdexFromZipBuffer(
  data: Buffer,
  fallbackName: string
): PetdexImportResult {
  let files: Array<{ name: string; data: Buffer }>
  try {
    files = unzip(data)
  } catch (err) {
    return { ok: false, error: `zip 解压失败：${err instanceof Error ? err.message : String(err)}` }
  }
  const workspace = join(petdexImportedRoot(), `.stage-${Date.now().toString(36)}`)
  try {
    mkdirSync(workspace, { recursive: true })
    for (const f of files) {
      if (f.name.endsWith('/') || f.name.includes('__MACOSX/')) continue
      const target = resolve(workspace, f.name)
      if (!target.startsWith(resolve(workspace))) continue
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, f.data)
    }
    const root = locatePackRoot(workspace)
    if (!root) return { ok: false, error: `${fallbackName} 的包里没有精灵图` }
    return installFromRoot(root)
  } catch (err) {
    return { ok: false, error: `导入失败：${err instanceof Error ? err.message : String(err)}` }
  } finally {
    try {
      if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

// ---------- 自己手写的 zip 解压（读中央目录 + inflateRaw），不引第三方 ----------

function findEndOfCentralDirectory(data: Buffer): number {
  // EOCD 签名 0x06054b50，从尾部往前找
  for (let i = data.length - 22; i >= 0; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

function unzip(data: Buffer): Array<{ name: string; data: Buffer }> {
  const eocd = findEndOfCentralDirectory(data)
  if (eocd < 0) throw new Error('不是有效的 zip')
  const entryCount = data.readUInt16LE(eocd + 10)
  let cursor = data.readUInt32LE(eocd + 16)
  const out: Array<{ name: string; data: Buffer }> = []
  for (let i = 0; i < entryCount; i++) {
    if (data.readUInt32LE(cursor) !== 0x02014b50) break // 中央目录头签名
    const method = data.readUInt16LE(cursor + 10)
    const compressedSize = data.readUInt32LE(cursor + 20)
    const nameLength = data.readUInt16LE(cursor + 28)
    const extraLength = data.readUInt16LE(cursor + 30)
    const commentLength = data.readUInt16LE(cursor + 32)
    const localOffset = data.readUInt32LE(cursor + 42)
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    if (!name.includes('__MACOSX/')) {
      const localNameLength = data.readUInt16LE(localOffset + 26)
      const localExtraLength = data.readUInt16LE(localOffset + 28)
      const fileStart = localOffset + 30 + localNameLength + localExtraLength
      const compressed = data.subarray(fileStart, fileStart + compressedSize)
      if (method !== 0 && method !== 8) throw new Error(`不支持的压缩方式 ${method}`)
      out.push({ name, data: method === 0 ? compressed : inflateRawSync(compressed) })
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return out
}
