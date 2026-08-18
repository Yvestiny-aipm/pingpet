import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

interface FoundFile {
  path: string
  mtimeMs: number
}

/** 可选的扫描约束 */
export interface FindOptions {
  /**
   * 只要 mtime 不早于此刻的文件（毫秒时间戳）。
   * 用来把长期没动过的历史会话挡在门外——它们不可能产出新鲜事件，读了也是白读。
   */
  minMtimeMs?: number
}

/**
 * 递归找出某个根目录下最近修改的 .jsonl / .json 文件。
 * 全部本地、防御式：任何目录读不了都静默跳过，绝不抛错。
 *
 * @param root      根目录（如 ~/.codex/sessions）
 * @param exts      要匹配的后缀（含点，如 ['.jsonl']）
 * @param maxFiles  最多返回几个（按 mtime 倒序取最近的）
 * @param maxDepth  递归深度上限
 * @param options   可选约束（如 minMtimeMs 只要够新的文件）
 */
export function findRecentFiles(
  root: string,
  exts: string[],
  maxFiles: number,
  maxDepth: number,
  options?: FindOptions
): string[] {
  return findRecentFilesAcross([root], exts, maxFiles, maxDepth, options)
}

/**
 * 同 findRecentFiles，但接受多个根目录，跨所有根统一按 mtime 取最近的 maxFiles 个。
 *
 * 用于 Cursor：会话散在 ~/.cursor/projects/<每个工作区>/agent-transcripts 下，而同级还有
 * terminals / agent-tools / canvases 等大量无关文件。直接从 projects 整棵树走会白扫一大片，
 * 这里只把各工作区的 agent-transcripts 子树喂进来。
 */
export function findRecentFilesAcross(
  roots: string[],
  exts: string[],
  maxFiles: number,
  maxDepth: number,
  options?: FindOptions
): string[] {
  const found: FoundFile[] = []
  const minMtimeMs = options?.minMtimeMs

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return // 目录不存在 / 无权限：安静跳过
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue // 跳过隐藏文件/目录
      const full = join(dir, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1)
      } else if (stat.isFile() && exts.some((e) => name.endsWith(e))) {
        // 目录 mtime 不随文件内容改变，只能逐文件筛；但省下的是后续的读盘 + 逐行解析
        if (minMtimeMs !== undefined && stat.mtimeMs < minMtimeMs) continue
        found.push({ path: full, mtimeMs: stat.mtimeMs })
      }
    }
  }

  for (const root of roots) walk(root, 0)
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found.slice(0, maxFiles).map((f) => f.path)
}
