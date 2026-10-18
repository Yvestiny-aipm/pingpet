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

/**
 * JSONL 增量游标。给 Codex 观察层用，不改上面 Head/Tail 的静默丢行行为。
 *
 * leftover：上一块末尾的半行（还没有 '\n'）。
 * lineCount：已经交付的完整行数（含坏行），用作稳定行号。
 * charOffset：已经交付文本的字符偏移（UTF-16 code unit，只用于同行去重，不是文件字节）。
 */
export interface JsonlFeedState {
  leftover: string
  lineCount: number
  charOffset: number
}

export function emptyJsonlFeedState(): JsonlFeedState {
  return { leftover: '', lineCount: 0, charOffset: 0 }
}

export type JsonlFeedLineKind = 'object' | 'malformed' | 'non_object'

export interface JsonlFeedLine {
  kind: JsonlFeedLineKind
  raw: string
  value?: unknown
  lineIndex: number
  charOffset: number
}

function classifyParsedLine(raw: string, lineIndex: number, charOffset: number): JsonlFeedLine {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { kind: 'object', raw, value: parsed, lineIndex, charOffset }
    }
    return { kind: 'non_object', raw, value: parsed, lineIndex, charOffset }
  } catch {
    return { kind: 'malformed', raw, lineIndex, charOffset }
  }
}

/**
 * 把一块新文本喂进增量解析器。
 * - 末尾半行留在 leftover，不丢、也不当成完整事件；
 * - 已以换行结束、但 JSON 坏掉的行会以 malformed 交出来，供观察层记账。
 */
export function feedJsonlText(
  chunk: string,
  state: JsonlFeedState
): { lines: JsonlFeedLine[]; state: JsonlFeedState } {
  const combined = `${state.leftover}${chunk}`
  const parts = combined.split('\n')
  const leftover = parts.pop() ?? ''
  const lines: JsonlFeedLine[] = []
  let charOffset = state.charOffset
  let lineCount = state.lineCount

  for (const part of parts) {
    const raw = part.trim()
    if (raw) {
      lines.push(classifyParsedLine(raw, lineCount, charOffset))
      lineCount += 1
    }
    charOffset += part.length + 1
  }

  return {
    lines,
    state: { leftover, lineCount, charOffset }
  }
}

/** 把残留半行交出来：能 parse 就当完整行，否则 kind=malformed（由调用方再标成 partial_line）。 */
export function flushJsonlFeed(state: JsonlFeedState): {
  line: JsonlFeedLine | null
  state: JsonlFeedState
} {
  const raw = state.leftover.trim()
  if (!raw) {
    return { line: null, state: { leftover: '', lineCount: state.lineCount, charOffset: state.charOffset } }
  }
  const line = classifyParsedLine(raw, state.lineCount, state.charOffset)
  return {
    line,
    state: {
      leftover: '',
      lineCount: state.lineCount + 1,
      charOffset: state.charOffset + state.leftover.length
    }
  }
}

/**
 * 从文件某个字节偏移读一段文本。失败返回空串 + 原偏移，不抛给上层。
 * 注意：按字节切开可能落在 UTF-8 字符中间，半字符由 feed 的 leftover 机制消化。
 */
export function readFileTextFromOffset(
  filePath: string,
  byteOffset: number,
  maxBytes = 256_000
): { text: string; nextOffset: number; eof: boolean; size: number } {
  let fd: number | null = null
  try {
    const stat = statSync(filePath)
    if (!stat.isFile() || stat.size === 0 || byteOffset >= stat.size) {
      return { text: '', nextOffset: Math.max(0, byteOffset), eof: true, size: stat.size }
    }
    const start = Math.max(0, byteOffset)
    const length = Math.min(maxBytes, stat.size - start)
    const buffer = Buffer.allocUnsafe(length)
    fd = openSync(filePath, 'r')
    let read = 0
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read)
      if (n <= 0) break
      read += n
    }
    const nextOffset = start + read
    return {
      text: buffer.toString('utf8', 0, read),
      nextOffset,
      eof: nextOffset >= stat.size,
      size: stat.size
    }
  } catch {
    return { text: '', nextOffset: byteOffset, eof: true, size: 0 }
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
