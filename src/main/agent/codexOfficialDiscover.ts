import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  type Dirent
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 只读检查本机是否已有可安全读取的 `codex exec --json` 官方点号事件流。
 * 不执行 Codex、不发起网络请求、不消耗额度、不把真实日志复制进仓库。
 *
 * 发现方式：对可疑文件按行读取少量样本，解析 JSON 对象，检查顶层 `type`。
 * 命中只表示「疑似官方 JSONL」，不得写成协议已验证。
 */

export const OFFICIAL_EXEC_EVENT_NAMES = [
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'item.started',
  'item.completed',
  'item.failed',
  'error',
  'rate limit / quota',
  'authentication / permission',
  'approval / input waiting',
  'stream disconnect / timeout / retry'
] as const

/** 发现器识别的官方顶层 type。只出现 error / turn.failed / turn.cancelled 也算候选。 */
export const OFFICIAL_JSONL_TYPE_CANDIDATES = [
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'item.started',
  'item.completed',
  'item.failed',
  'error'
] as const

export type OfficialJsonlTypeCandidate = (typeof OFFICIAL_JSONL_TYPE_CANDIDATES)[number]

const OFFICIAL_JSONL_TYPE_SET = new Set<string>(OFFICIAL_JSONL_TYPE_CANDIDATES)

/** 每个目录最多 peek 多少个可疑文件。超过则停止检查并记入扫描边界。 */
export const OFFICIAL_DISCOVER_MAX_FILES_PER_DIR = 40
/** 每个文件最多从头部读取多少字节。大文件不得整文件载入。 */
export const OFFICIAL_DISCOVER_MAX_PEEK_BYTES = 16_384
/** 每个文件最多解析多少行 / 个 JSON 对象。 */
export const OFFICIAL_DISCOVER_MAX_PEEK_LINES = 32

export const OFFICIAL_CANDIDATE_DISCLAIMER = '疑似官方 JSONL，仍需人工或真实回放确认'

export type OfficialExecVerdict = 'PASS' | 'PARTIAL' | 'BLOCKED'

export interface OfficialExecLocation {
  label: string
  exists: boolean
  note: string
}

export interface OfficialExecDirScan {
  label: string
  exists: boolean
  maxFiles: number
  maxBytesPerFile: number
  maxLinesPerFile: number
  filesSeen: number
  filesPeeked: number
  hitFileCap: boolean
  hitByteCap: boolean
}

export interface OfficialExecScanBounds {
  maxFilesPerDir: number
  maxBytesPerFile: number
  maxLinesPerFile: number
  dirs: OfficialExecDirScan[]
  anyHitFileCap: boolean
  anyHitByteCap: boolean
}

export interface OfficialJsonlSamplePeek {
  text: string
  bytesRead: number
  linesUsed: number
  fileSize: number
  truncatedByBytes: boolean
  truncatedByLines: boolean
}

export interface OfficialJsonlClassification {
  officialTypes: OfficialJsonlTypeCandidate[]
  isCandidate: boolean
}

export interface OfficialExecAvailability {
  verdict: OfficialExecVerdict
  cliAvailable: boolean
  checkedLocations: OfficialExecLocation[]
  scanBounds: OfficialExecScanBounds
  realOfficialFileCount: number
  fixtureFileCount: number
  cannotObtainBecause: string[]
  unverifiedOfficialEvents: string[]
  candidateNote: string
  summary: string
}

function homeLabel(abs: string): string {
  const home = homedir()
  if (abs.startsWith(home)) return `$HOME${abs.slice(home.length)}`
  return abs.replace(/\/Users\/[^/]+/g, '$HOME')
}

function pathHasCodexCli(): boolean {
  const extras = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(homedir(), '.local/bin/codex'),
    '/Applications/Codex.app/Contents/MacOS/codex'
  ]
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  const candidates = [...extras, ...dirs.map((dir) => join(dir, 'codex'))]
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      /* keep looking */
    }
  }
  return false
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    /* 半行或非对象，跳过 */
  }
  return null
}

/**
 * 从有界样本中抽出 JSON 对象。允许空格、字段顺序和换行格式变化。
 * 不依赖 `"type":"…" ` 字符串拼接。
 */
export function extractJsonObjectsFromSample(
  text: string,
  maxObjects = OFFICIAL_DISCOVER_MAX_PEEK_LINES
): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = []
  const seen = new Set<string>()
  const add = (obj: Record<string, unknown> | null) => {
    if (!obj || objects.length >= maxObjects) return
    const key = JSON.stringify(obj)
    if (seen.has(key)) return
    seen.add(key)
    objects.push(obj)
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    add(tryParseObject(trimmed))
    if (objects.length >= maxObjects) return objects
  }

  let i = 0
  while (i < text.length && objects.length < maxObjects) {
    const start = text.indexOf('{', i)
    if (start < 0) break
    const end = findMatchingBrace(text, start)
    if (end < 0) break
    add(tryParseObject(text.slice(start, end + 1)))
    i = end + 1
  }
  return objects
}

export function classifyOfficialJsonlSample(text: string): OfficialJsonlClassification {
  const officialTypes: OfficialJsonlTypeCandidate[] = []
  const seen = new Set<string>()
  for (const obj of extractJsonObjectsFromSample(text)) {
    const type = typeof obj.type === 'string' ? obj.type : undefined
    if (!type || !OFFICIAL_JSONL_TYPE_SET.has(type) || seen.has(type)) continue
    seen.add(type)
    officialTypes.push(type as OfficialJsonlTypeCandidate)
  }
  return { officialTypes, isCandidate: officialTypes.length > 0 }
}

export function peekOfficialJsonlHead(filePath: string): OfficialJsonlSamplePeek {
  try {
    const fileSize = statSync(filePath).size
    if (fileSize <= 0) {
      return {
        text: '',
        bytesRead: 0,
        linesUsed: 0,
        fileSize,
        truncatedByBytes: false,
        truncatedByLines: false
      }
    }
    const toRead = Math.min(OFFICIAL_DISCOVER_MAX_PEEK_BYTES, fileSize)
    const fd = openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(toRead)
      const n = readSync(fd, buf, 0, buf.length, 0)
      const raw = buf.subarray(0, n).toString('utf8')
      const allLines = raw.split(/\r?\n/)
      const usedLines = allLines.slice(0, OFFICIAL_DISCOVER_MAX_PEEK_LINES)
      return {
        text: usedLines.join('\n'),
        bytesRead: n,
        linesUsed: usedLines.filter((line) => line.trim()).length,
        fileSize,
        truncatedByBytes: fileSize > n,
        truncatedByLines: allLines.length > OFFICIAL_DISCOVER_MAX_PEEK_LINES
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    return {
      text: '',
      bytesRead: 0,
      linesUsed: 0,
      fileSize: 0,
      truncatedByBytes: false,
      truncatedByLines: false
    }
  }
}

function listDirNote(abs: string, missingNote: string): OfficialExecLocation {
  const label = homeLabel(abs)
  if (!existsSync(abs)) {
    return { label, exists: false, note: missingNote }
  }
  try {
    const st = statSync(abs)
    return {
      label,
      exists: true,
      note: st.isDirectory()
        ? `目录存在；每目录最多 ${OFFICIAL_DISCOVER_MAX_FILES_PER_DIR} 个文件，每文件最多 ${OFFICIAL_DISCOVER_MAX_PEEK_BYTES} 字节 / ${OFFICIAL_DISCOVER_MAX_PEEK_LINES} 行`
        : '路径存在但不是目录'
    }
  } catch {
    return { label, exists: true, note: '存在但无法 stat' }
  }
}

function walkSuspiciousFiles(
  root: string,
  maxDepth: number,
  maxFiles: number,
  visit: (filePath: string) => void
): { filesSeen: number; filesVisited: number; hitFileCap: boolean } {
  const skip = new Set(['node_modules', '.git', 'out', 'dist', 'attachments', 'shell_snapshots'])
  let filesSeen = 0
  let filesVisited = 0
  let hitFileCap = false
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return
    let entries: Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue
        walk(full, depth + 1)
      } else if (entry.isFile() && /\.(jsonl|json|log)$/.test(entry.name)) {
        filesSeen += 1
        if (filesVisited >= maxFiles) {
          hitFileCap = true
          continue
        }
        filesVisited += 1
        visit(full)
      }
    }
  }
  walk(root, 0)
  return { filesSeen, filesVisited, hitFileCap }
}

/**
 * 只读发现：不执行 Codex。仓库 fixture 不计为真实官方 JSONL。
 */
export function discoverOfficialExecJsonl(options?: {
  projectRoot?: string
  extraRoots?: Array<{ abs: string; label: string; fixture?: boolean }>
}): OfficialExecAvailability {
  const home = homedir()
  const projectRoot = options?.projectRoot
  const cliAvailable = pathHasCodexCli()
  const checkedLocations: OfficialExecLocation[] = [
    {
      label: 'PATH / 常见安装位置的 `codex` 可执行文件',
      exists: cliAvailable,
      note: cliAvailable
        ? '发现可执行文件，但本轮禁止自动调用真实 Codex'
        : '未发现可执行 Codex CLI，不能据此判断协议缺事件'
    },
    listDirNote(join(home, '.codex/sessions'), '本地 session 目录不存在'),
    listDirNote(join(home, '.codex/archived_sessions'), '归档目录不存在'),
    listDirNote(join(home, '.codex/tmp'), '临时目录不存在'),
    listDirNote(join(home, '.codex/cache'), '缓存目录不存在'),
    listDirNote(join(home, '.codex/logs'), '日志目录不存在'),
    listDirNote(join(home, 'Library/Application Support/desktop-pet-mvp'), '应用 userData 不存在'),
    listDirNote(join(home, 'Library/Application Support/PingPet'), 'PingPet userData 不存在')
  ]

  if (projectRoot) {
    checkedLocations.push({
      label: 'repo:src/main/agent/fixtures/codex',
      exists: existsSync(join(projectRoot, 'src/main/agent/fixtures/codex')),
      note: '仓库手写 fixture，不得当作真实 exec --json'
    })
  }

  let realOfficialFileCount = 0
  let fixtureFileCount = 0
  const dirScans: OfficialExecDirScan[] = []

  const peekRoots: Array<{ abs: string; label: string; fixture: boolean; maxDepth: number }> = [
    { abs: join(home, '.codex/sessions'), label: '$HOME/.codex/sessions', fixture: false, maxDepth: 8 },
    {
      abs: join(home, '.codex/archived_sessions'),
      label: '$HOME/.codex/archived_sessions',
      fixture: false,
      maxDepth: 6
    },
    { abs: join(home, '.codex/tmp'), label: '$HOME/.codex/tmp', fixture: false, maxDepth: 4 },
    { abs: join(home, '.codex/cache'), label: '$HOME/.codex/cache', fixture: false, maxDepth: 4 },
    { abs: join(home, '.codex/logs'), label: '$HOME/.codex/logs', fixture: false, maxDepth: 3 },
    {
      abs: join(home, 'Library/Application Support/desktop-pet-mvp/diagnostics'),
      label: '$HOME/Library/Application Support/desktop-pet-mvp/diagnostics',
      fixture: false,
      maxDepth: 2
    }
  ]
  if (projectRoot) {
    peekRoots.push({
      abs: join(projectRoot, 'src/main/agent/fixtures/codex'),
      label: 'repo:src/main/agent/fixtures/codex',
      fixture: true,
      maxDepth: 2
    })
  }
  for (const extra of options?.extraRoots ?? []) {
    peekRoots.push({ abs: extra.abs, label: extra.label, fixture: Boolean(extra.fixture), maxDepth: 3 })
    checkedLocations.push({
      label: extra.label,
      exists: existsSync(extra.abs),
      note: extra.fixture ? '测试夹具' : '额外只读位置'
    })
  }

  for (const root of peekRoots) {
    const exists = existsSync(root.abs)
    const scan: OfficialExecDirScan = {
      label: root.label,
      exists,
      maxFiles: OFFICIAL_DISCOVER_MAX_FILES_PER_DIR,
      maxBytesPerFile: OFFICIAL_DISCOVER_MAX_PEEK_BYTES,
      maxLinesPerFile: OFFICIAL_DISCOVER_MAX_PEEK_LINES,
      filesSeen: 0,
      filesPeeked: 0,
      hitFileCap: false,
      hitByteCap: false
    }
    if (exists) {
      const walked = walkSuspiciousFiles(
        root.abs,
        root.maxDepth,
        OFFICIAL_DISCOVER_MAX_FILES_PER_DIR,
        (filePath) => {
          try {
            const peek = peekOfficialJsonlHead(filePath)
            scan.filesPeeked += 1
            if (peek.truncatedByBytes || peek.truncatedByLines) scan.hitByteCap = true
            if (!classifyOfficialJsonlSample(peek.text).isCandidate) return
            if (root.fixture) fixtureFileCount += 1
            else realOfficialFileCount += 1
          } catch {
            /* 单个文件失败不影响结论 */
          }
        }
      )
      scan.filesSeen = walked.filesSeen
      scan.hitFileCap = walked.hitFileCap
    }
    dirScans.push(scan)
  }

  const scanBounds: OfficialExecScanBounds = {
    maxFilesPerDir: OFFICIAL_DISCOVER_MAX_FILES_PER_DIR,
    maxBytesPerFile: OFFICIAL_DISCOVER_MAX_PEEK_BYTES,
    maxLinesPerFile: OFFICIAL_DISCOVER_MAX_PEEK_LINES,
    dirs: dirScans,
    anyHitFileCap: dirScans.some((d) => d.hitFileCap),
    anyHitByteCap: dirScans.some((d) => d.hitByteCap)
  }

  const cannotObtainBecause: string[] = []
  if (!cliAvailable) {
    cannotObtainBecause.push('本机 PATH/常见位置没有可执行 Codex CLI，且禁止为取样自动安装或调用。')
  } else {
    cannotObtainBecause.push('即使有 CLI，本轮也禁止自动运行会消耗额度、改文件或走网络的 `codex exec`。')
  }
  if (realOfficialFileCount === 0) {
    cannotObtainBecause.push(
      '当前扫描未找到疑似真实 `codex exec --json` 点号事件流。当前扫描未找到 ≠ Codex 不支持这些事件。'
    )
  } else {
    cannotObtainBecause.push(
      `找到 ${realOfficialFileCount} 个${OFFICIAL_CANDIDATE_DISCLAIMER}；不能写成协议已验证。`
    )
  }
  if (fixtureFileCount > 0) {
    cannotObtainBecause.push(
      `仓库内有 ${fixtureFileCount} 个手写 fixture 含点号 type，只能测解析器，不能证明真实协议。`
    )
  }
  if (scanBounds.anyHitFileCap) {
    cannotObtainBecause.push('至少一个目录因文件数量上限未检查全部文件；未检查 ≠ 不存在官方 JSONL。')
  }
  cannotObtainBecause.push('真实日志只允许本地读取，禁止上传或复制进仓库。')

  const unverifiedOfficialEvents = [...OFFICIAL_EXEC_EVENT_NAMES]
  const candidateNote =
    realOfficialFileCount > 0
      ? OFFICIAL_CANDIDATE_DISCLAIMER
      : '当前扫描未找到疑似官方 JSONL；不能据此判断协议是否支持'
  const verdict: OfficialExecVerdict = realOfficialFileCount > 0 ? 'PARTIAL' : 'BLOCKED'
  const summary =
    verdict === 'BLOCKED'
      ? '官方 exec JSONL 尚未验证，因此不能进入 Monitor 行为替换阶段。'
      : `${OFFICIAL_CANDIDATE_DISCLAIMER}。协议尚未验证，因此不能进入 Monitor 行为替换阶段。`

  return {
    verdict,
    cliAvailable,
    checkedLocations,
    scanBounds,
    realOfficialFileCount,
    fixtureFileCount,
    cannotObtainBecause,
    unverifiedOfficialEvents,
    candidateNote,
    summary
  }
}

export function officialExecMarkdown(info: OfficialExecAvailability): string[] {
  const lines: string[] = []
  lines.push(`- 结论： **${info.verdict}**`)
  lines.push(`- Codex CLI 可执行：${info.cliAvailable ? '是（未调用）' : '否'}`)
  lines.push(
    `- 疑似官方 JSONL 文件：${info.realOfficialFileCount}（${info.candidateNote}；发现候选 ≠ 协议已验证）`
  )
  lines.push(`- 仓库 fixture（不计为真实）：${info.fixtureFileCount}`)
  lines.push('- 扫描边界：')
  lines.push(`  - 检查目录：${info.scanBounds.dirs.map((d) => `\`${d.label}\``).join('、')}`)
  lines.push(`  - 每个目录最多检查 ${info.scanBounds.maxFilesPerDir} 个 \`.jsonl/.json/.log\` 文件`)
  lines.push(
    `  - 每个文件最多读取 ${info.scanBounds.maxBytesPerFile} 字节或 ${info.scanBounds.maxLinesPerFile} 行`
  )
  lines.push(
    `  - 因文件数量上限未检查全部：${info.scanBounds.anyHitFileCap ? '是' : '否'}；因大小/行数上限只读头部：${info.scanBounds.anyHitByteCap ? '是' : '否'}`
  )
  for (const dir of info.scanBounds.dirs) {
    if (!dir.exists) continue
    lines.push(
      `  - \`${dir.label}\`：见到 ${dir.filesSeen} 个可疑文件，peek ${dir.filesPeeked} 个；文件上限截断=${dir.hitFileCap}；只读头部=${dir.hitByteCap}`
    )
  }
  lines.push('- 已检查位置：')
  for (const loc of info.checkedLocations) {
    lines.push(`  - \`${loc.label}\`：${loc.exists ? '存在' : '不存在'} — ${loc.note}`)
  }
  lines.push('- 不能安全取得真实官方流的原因：')
  for (const reason of info.cannotObtainBecause) lines.push(`  - ${reason}`)
  lines.push('- 仍未用真实官方流验证的事件（本批样本未出现或仅发现候选，不能据此判断协议是否支持）：')
  for (const name of info.unverifiedOfficialEvents) lines.push(`  - \`${name}\``)
  lines.push(`- ${info.summary}`)
  return lines
}
