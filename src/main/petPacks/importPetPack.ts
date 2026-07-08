import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { dialog, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { readAndValidateManifest } from './manifest'
import { importPetdexFromDir, importPetdexFromZip } from './importPetdexPack'
import {
  codexPetsRoot,
  importedPackDir,
  importedPacksRoot,
  petdexImportedDir
} from './paths'

/**
 * 皮肤包导入 / 删除 / 打开目录（v0.3）。
 *
 * 导入流程（手册要求，防半导入）：
 *   选目录 → 读并校验源目录 manifest → 复制到临时目录 → 成功后原子替换正式目录。
 * 任何一步失败都回滚，绝不留下半个包。
 */

export type ImportResult =
  | { ok: true; petId: string }
  | { ok: false; error: string; canceled?: boolean }

/** 弹目录选择框，让用户选一个皮肤包文件夹并导入 */
export function importPetPackFromDialog(parent?: BrowserWindow): ImportResult {
  const picked = dialog.showOpenDialogSync(parent as BrowserWindow, {
    title: '选择皮肤包文件夹',
    properties: ['openDirectory'],
    message: '选择一个包含 manifest.json 的皮肤包文件夹'
  })
  if (!picked || picked.length === 0) {
    return { ok: false, error: '', canceled: true }
  }
  return importPetPackFromDir(picked[0])
}

/**
 * v0.3.3 统一「导入皮肤」入口的结果。
 *  - kind:'image'：用户选了一张图 → 返回 dataUrl 交渲染进程（可选抠背景）再 savePetImage
 *  - kind:'pack' ：用户选了我们的 manifest 皮肤包文件夹 → 已在 main 侧导入完成
 *  - kind:'petdex'：v0.4 用户选了 PetDex 格式（zip 或含 spritesheet 的文件夹）→ 已导入完成
 *  - kind:'canceled' / kind:'error'
 */
export type PickSkinResult =
  | { kind: 'image'; dataUrl: string; ext: string; name: string }
  | { kind: 'pack'; petId: string }
  | { kind: 'petdex'; slug: string; name: string }
  | { kind: 'canceled' }
  | { kind: 'error'; error: string }

/**
 * v0.3.3：合并后的「导入皮肤」——一个对话框同时允许选图片或选皮肤包文件夹，
 * 选完后按类型自动分流（用户不用自己判断选图还是选文件夹）。
 */
export function pickSkinFromDialog(parent?: BrowserWindow): PickSkinResult {
  const picked = dialog.showOpenDialogSync(parent as BrowserWindow, {
    title: '导入皮肤',
    // macOS 下同时允许选文件和文件夹；不加 filters（filters 只对文件生效，会让文件夹变灰）
    properties: ['openFile', 'openDirectory'],
    buttonLabel: '导入',
    message:
      '选一张 PNG / WebP / SVG 图片，或一个皮肤包 / PetDex 宠物（文件夹或 .zip 都行）\n（选文件夹时单击选中它、再点“导入”，不要双击进入）'
  })
  if (!picked || picked.length === 0) return { kind: 'canceled' }
  const p = picked[0]

  let isDir = false
  try {
    isDir = statSync(p).isDirectory()
  } catch {
    return { kind: 'error', error: '选中的路径无法读取' }
  }

  if (isDir) {
    // 文件夹：先看是不是 PetDex 格式（有 spritesheet），是就走 PetDex；否则走我们的 manifest 皮肤包
    if (looksLikePetdexDir(p)) {
      const res = importPetdexFromDir(p)
      if (res.ok) return { kind: 'petdex', slug: res.slug, name: res.name }
      return { kind: 'error', error: res.error }
    }
    const res = importPetPackFromDir(p)
    if (res.ok) return { kind: 'pack', petId: res.petId }
    return { kind: 'error', error: res.error }
  }

  // 文件：zip → PetDex 包；图片 → 单图抠图流程
  const ext = extname(p).toLowerCase()
  if (ext === '.zip') {
    const res = importPetdexFromZip(p)
    if (res.ok) return { kind: 'petdex', slug: res.slug, name: res.name }
    return { kind: 'error', error: res.error }
  }
  const img = readImageFileAsDataUrl(p)
  if (!img.ok) return { kind: 'error', error: img.error }
  return { kind: 'image', dataUrl: img.dataUrl, ext: img.ext, name: img.name }
}

/** 一个文件夹是不是 PetDex 格式（含 spritesheet 精灵图，或单层子目录里有） */
function looksLikePetdexDir(dir: string): boolean {
  const names = ['spritesheet.webp', 'spritesheet.png', 'sprite.webp', 'sprite.png']
  if (names.some((n) => existsSync(join(dir, n)))) return true
  // 单层子目录兜底（zip 解出来常带一层根目录）
  try {
    const subs = require('node:fs')
      .readdirSync(dir)
      .filter((e: string) => {
        try {
          return statSync(join(dir, e)).isDirectory() && !e.startsWith('.') && e !== '__MACOSX'
        } catch {
          return false
        }
      })
    if (subs.length === 1) {
      return names.some((n) => existsSync(join(dir, subs[0], n)))
    }
  } catch {
    /* ignore */
  }
  return false
}

/** 单图导入允许的图片扩展名（与 manifest 的 ALLOWED_EXT 对齐） */
const IMAGE_EXTS = ['.png', '.webp', '.svg']
/** 单张素材大小上限，和 manifest 的 MAX_FILE_BYTES 一致（5MB） */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024

/**
 * 从一个图片文件名派生一个合法的皮肤包 id（^[a-z0-9_-]{2,40}$）。
 * 中文/空格/特殊字符会被清掉，清空后用 'pet' 兜底；再拼时间戳后缀防同名冲突。
 */
function deriveImageId(fileName: string): string {
  const base = basename(fileName, extname(fileName))
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-') // 非法字符（含中文）→ 短横线
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
  const stem = slug.length >= 2 ? slug : 'pet'
  // 时间戳后缀（36 进制，短）保证唯一；总长控制在 40 内
  return `${stem}-${Date.now().toString(36)}`.slice(0, 40)
}

/** 选图结果（第一步）：把用户选的图读成 dataUrl 交回渲染进程抠图，不落盘 */
export type PickImageResult =
  | { ok: true; dataUrl: string; ext: string; name: string }
  | { ok: false; error: string; canceled?: boolean }

/** 图片扩展名 → dataUrl 的 MIME */
function extToMime(ext: string): string {
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.svg') return 'image/svg+xml'
  return 'application/octet-stream'
}

/**
 * 把一个图片文件读成 dataUrl（含扩展名/大小校验），不落盘。
 * 抽出来供「单图导入」和「合并后的导入皮肤」两个入口共用。
 */
function readImageFileAsDataUrl(imgPath: string): PickImageResult {
  const ext = extname(imgPath).toLowerCase()
  if (!IMAGE_EXTS.includes(ext)) {
    return { ok: false, error: `不支持的图片格式（只允许 PNG / WebP / SVG）：${basename(imgPath)}` }
  }
  let bytes = 0
  try {
    const st = statSync(imgPath)
    if (!st.isFile()) return { ok: false, error: '选中的不是一个文件' }
    bytes = st.size
  } catch {
    return { ok: false, error: '图片文件不存在或无法读取' }
  }
  if (bytes > IMAGE_MAX_BYTES) {
    return { ok: false, error: `图片超过 5MB 上限：${basename(imgPath)}` }
  }
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const b64 = readFileSync(imgPath).toString('base64')
  const rawName = basename(imgPath, ext).trim().slice(0, 30)
  const name = rawName.length >= 1 ? rawName : '我的桌宠'
  return { ok: true, dataUrl: `data:${extToMime(ext)};base64,${b64}`, ext, name }
}

/**
 * v0.3.1 单图导入第一步：弹框选图，读成 dataUrl 返回（供渲染进程抠背景）。
 * 只做扩展名/大小校验，不落盘。（v0.3.3 起主入口是 pickSkinFromDialog，此函数保留兼容。）
 */
export function pickPetImageFromDialog(parent?: BrowserWindow): PickImageResult {
  const picked = dialog.showOpenDialogSync(parent as BrowserWindow, {
    title: '选择一张图片当桌宠',
    properties: ['openFile'],
    message: '选一张 PNG / WebP / SVG 图片，直接变成你的桌宠',
    filters: [{ name: '图片', extensions: ['png', 'webp', 'svg'] }]
  })
  if (!picked || picked.length === 0) {
    return { ok: false, error: '', canceled: true }
  }
  return readImageFileAsDataUrl(picked[0])
}

/**
 * v0.3.1 单图导入第二步：把（可能已抠好背景的）图 dataUrl 存成皮肤包。
 * dataUrl 里的 MIME 决定素材扩展名；抠过背景的一律是 png。
 */
export function savePetImageFromDataUrl(dataUrl: string, rawName: string): ImportResult {
  // 1. 解析 dataUrl
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl)
  if (!m) return { ok: false, error: '图片数据格式不正确' }
  const mime = m[1].toLowerCase()
  const isB64 = !!m[2]
  const mimeToExt: Record<string, string> = {
    'image/png': '.png',
    'image/webp': '.webp',
    'image/svg+xml': '.svg'
  }
  const ext = mimeToExt[mime]
  if (!ext) return { ok: false, error: `不支持的图片类型：${mime}` }

  let buf: Buffer
  try {
    buf = isB64 ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8')
  } catch {
    return { ok: false, error: '图片数据解码失败' }
  }
  if (buf.byteLength > IMAGE_MAX_BYTES) {
    return { ok: false, error: '图片超过 5MB 上限' }
  }

  const name = (rawName || '').trim().slice(0, 30) || '我的桌宠'
  const id = deriveImageId(name)
  const assetName = `idle${ext}`

  // 2. 套壳：临时目录写 idle.<ext> + manifest，再交标准导入（校验 + 原子替换）
  const stageDir = join(importedPacksRoot(), `.stage-${id}`)
  try {
    mkdirSync(stageDir, { recursive: true })
    writeFileSync(join(stageDir, assetName), buf)
    const manifest = {
      id,
      name,
      version: '1.0.0',
      description: '从一张图片生成的桌宠',
      states: { idle: assetName }
    }
    writeFileSync(join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    return importPetPackFromDir(stageDir)
  } catch (err) {
    return { ok: false, error: `导入失败：${err instanceof Error ? err.message : String(err)}` }
  } finally {
    try {
      if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

/** 从指定源目录导入（校验 → 复制到临时 → 原子替换）。抽出来便于测试。 */
export function importPetPackFromDir(srcDir: string): ImportResult {
  // 1. 校验源目录
  const res = readAndValidateManifest(srcDir)
  if (!res.ok) return { ok: false, error: res.error }
  const { id } = res.manifest

  const finalDir = importedPackDir(id)
  const tmpDir = join(importedPacksRoot(), `.tmp-${id}`)

  try {
    mkdirSync(importedPacksRoot(), { recursive: true })
    // 2. 清理可能残留的临时目录
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    // 3. 复制到临时目录
    cpSync(srcDir, tmpDir, { recursive: true })
    // 4. 复制完再校验一次临时目录（确保复制没损坏、路径仍安全）
    const recheck = readAndValidateManifest(tmpDir)
    if (!recheck.ok) {
      rmSync(tmpDir, { recursive: true, force: true })
      return { ok: false, error: `复制后校验失败：${recheck.error}` }
    }
    // 5. 原子替换正式目录：先删旧、再把临时改名过去
    if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true })
    // rename 同盘原子；跨情况用复制兜底
    const { renameSync } = require('node:fs') as typeof import('node:fs')
    try {
      renameSync(tmpDir, finalDir)
    } catch {
      cpSync(tmpDir, finalDir, { recursive: true })
      rmSync(tmpDir, { recursive: true, force: true })
    }
    return { ok: true, petId: id }
  } catch (err) {
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    return { ok: false, error: `导入失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 删除一个已导入皮肤包（只按 id 删 imported 目录下的） */
export function deleteImportedPack(petId: string): { ok: true } | { ok: false; error: string } {
  // id 安全性：只允许字母/数字/-/_（不含 . / \ 等），防路径穿越删到别处。
  // 放宽长度到 80、允许大写——PetDex 的 slug 可能较长或含大写。
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(petId)) {
    return { ok: false, error: '非法的皮肤包 id' }
  }
  // v0.4：宠物可能落在三处目录之一——我们的图片导入包、PetDex 导入包、PetDex CLI 目录。
  // 逐个删（哪个存在删哪个），确保 spritesheet 宠物也能删掉。
  const dirs = [importedPackDir(petId), petdexImportedDir(petId), join(codexPetsRoot(), petId)]
  let removedAny = false
  try {
    for (const dir of dirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true })
        removedAny = true
      }
    }
    // 三处都没有 = 本来就不在了，也视为成功（幂等）
    void removedAny
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `删除失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * 重命名一个已导入皮肤包的显示名（v0.3.3）。
 * 只改 manifest.json 的 name 字段，不动 id / 目录 / 素材。原子写回，避免写坏 manifest。
 * name 校验规则与导入时一致：trim 后 1-30 字符。
 */
export function renameImportedPack(
  petId: string,
  rawName: string
): { ok: true } | { ok: false; error: string } {
  // id 安全性：只允许合法 id 字符集，防写到别处
  if (!/^[a-z0-9_-]{2,40}$/.test(petId)) {
    return { ok: false, error: '非法的皮肤包 id' }
  }
  const name = (rawName || '').trim()
  if (name.length < 1 || name.length > 30) {
    return { ok: false, error: '名字要 1-30 个字' }
  }
  const dir = importedPackDir(petId)
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    return { ok: false, error: '这个皮肤包不存在或不可改名' }
  }
  try {
    const { readFileSync, renameSync } = require('node:fs') as typeof import('node:fs')
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    raw.name = name
    // 原子写：先写临时文件，再 rename 覆盖，避免写一半损坏 manifest
    const tmp = join(dir, `.manifest-${Date.now().toString(36)}.tmp`)
    writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8')
    renameSync(tmp, manifestPath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `改名失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 在 Finder 里打开用户导入皮肤包目录（不存在则先建） */
export function revealImportedPacksFolder(): void {
  const root = importedPacksRoot()
  try {
    mkdirSync(root, { recursive: true })
  } catch {
    /* ignore */
  }
  void shell.openPath(root)
}
