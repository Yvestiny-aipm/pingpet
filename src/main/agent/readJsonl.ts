import { closeSync, openSync, readSync, statSync } from 'node:fs'

/**
 * 容错地读取一个 JSONL 文件的 tail。
 *
 * 设计原则（全部本地、绝不抛给上层导致崩溃）：
 * - 文件不存在 / stat 失败：返回空数组。
 * - 文件很大：只读末尾 maxBytes，不整文件读取。
 * - tail 从半行开始：丢弃第一段（很可能是被截断的半行）。
 * - 某行 JSON.parse 失败（坏行 / 正在写入的行）：忽略该行，不影响其它行。
 *
 * 返回的每个元素是一个已解析的 JSON 对象（非对象的行被跳过）。
 */
/**
 * 只读一个 JSONL 文件的头部若干字节，解析出前几行。
 * 用于读会话元信息（如 codex 的 session_meta 在文件第一行，含 source/originator）。
 * 同样全本地、绝不抛错：读不到就返回空数组。
 *
 * ⚠️ v0.3.3 修：Codex **客户端** 会把一大堆 MCP 工具定义塞进 session_meta 首行，
 * 实测单行可达 40KB+。默认上限过小时连第一行都读不完 → split 后只剩半行 → 被
 * pop 丢掉 → 读到 0 行 → originator 丢失 → 环境误判成 terminal（客户端不提醒的真凶）。
 * 因此：① 默认上限提到 128KB；② 只有确实读到 2 行以上时才 pop 尾部半行，
 * 单行超长但已完整（读到了文件末尾）时不 pop，保证首行 session_meta 能被解析。
 */
export function readJsonlHead(filePath: string, maxBytes = 131_072): Record<string, unknown>[] {
  let fd: number | null = null
  try {
    const stat = statSync(filePath)
    if (!stat.isFile() || stat.size === 0) return []
    const length = Math.min(stat.size, maxBytes)
    const buffer = Buffer.allocUnsafe(length)
    fd = openSync(filePath, 'r')
    let read = 0
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, read)
      if (n <= 0) break
      read += n
    }
    const text = buffer.toString('utf8', 0, read)
    const lines = text.split('\n')
    // 尾部那行可能是被截断的半行：仅当没读到文件末尾、且行数≥2 时才丢弃它。
    // （行数<2 说明第一行本身就超长还没读完，此时若强行 pop 会丢掉唯一的 session_meta。）
    if (length < stat.size && lines.length >= 2) lines.pop()
    const out: Record<string, unknown>[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          out.push(parsed as Record<string, unknown>)
        }
      } catch {
        /* 坏行 / 半截行：跳过 */
      }
    }
    return out
  } catch {
    return []
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

export function readJsonlTail(filePath: string, maxBytes = 96_000): Record<string, unknown>[] {
  let fd: number | null = null
  try {
    const stat = statSync(filePath)
    if (!stat.isFile() || stat.size === 0) return []

    const size = stat.size
    const start = size > maxBytes ? size - maxBytes : 0
    const length = size - start
    const buffer = Buffer.allocUnsafe(length)

    fd = openSync(filePath, 'r')
    let read = 0
    // 循环读满，防止单次 readSync 少读
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read)
      if (n <= 0) break
      read += n
    }

    const text = buffer.toString('utf8', 0, read)
    const lines = text.split('\n')
    // 如果不是从文件开头读的，第一行可能是被 tail 截断的半行，丢弃
    if (start > 0 && lines.length > 0) lines.shift()

    const out: Record<string, unknown>[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          out.push(parsed as Record<string, unknown>)
        }
      } catch {
        // 坏行 / 半截行 / 正在写入的行：静默跳过
      }
    }
    return out
  } catch {
    // 文件不存在、权限不足、正被写入等：安静返回空
    return []
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}
