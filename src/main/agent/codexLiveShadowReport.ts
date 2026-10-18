import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 只读读取真实 PingPet 诊断 JSONL，生成旧路径 / 新检测器 / 候选状态对照报告。
 * 不复制日志进仓库，不发网络，不改 Monitor / 桌宠。
 * 没有真实运行数据时输出 BLOCKED_NO_LIVE_DATA，不得用 fixture 冒充。
 */

export const LIVE_REPORT_BLOCKED = 'BLOCKED_NO_LIVE_DATA'
export const UNMATCHED_CORRELATION = 'UNMATCHED_CORRELATION'

export type LiveReportConclusion = 'PASS' | 'PARTIAL' | typeof LIVE_REPORT_BLOCKED

export type LiveDiffVerdict =
  | '一致'
  | '新检测器信息更丰富'
  | '候选状态更谨慎'
  | '旧路径可能过早结束'
  | '旧路径可能丢失事件'
  | '新路径信息不足'
  | '关联失败'
  | '样本未覆盖'
  | '无法确认'

export interface CodexLiveShadowReportOptions {
  diagnosticsDir: string
  diagnosticsLabel?: string
  sinceMs?: number
  untilMs?: number
  sessionId?: string
  maxBytesPerFile?: number
  byteOffset?: number
  nowMs?: number
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const SENSITIVE =
  /prompt|assistant|command|token|secret|password|authorization|api[_-]?key|\/Users\/|\/home\/|\\\\Users\\\\/i

interface FileReadResult {
  name: string
  exists: boolean
  fileBytes: number
  readBytes: number
  truncated: boolean
  parsed: number
  uniqueIds: number
  duplicateIds: number
  malformed: number
  records: Record<string, unknown>[]
}

export interface LiveTrackStats {
  file: FileReadResult
}

function iso(ms: number | null | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : 'n/a'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function bump(map: Record<string, number>, key: string | undefined): void {
  const k = key && key.trim() ? key : '(missing)'
  map[k] = (map[k] ?? 0) + 1
}

function countMap(records: Record<string, unknown>[], field: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const rec of records) bump(out, asString(rec[field]) ?? String(rec[field] ?? ''))
  return out
}

function derivedField(rec: Record<string, unknown>, field: string): string | undefined {
  const derived = asRecord(rec.derived)
  return asString(derived?.[field]) ?? asString(rec[field])
}

export function defaultDiagnosticsCandidates(): Array<{ label: string; abs: string; exists: boolean }> {
  const home = homedir()
  return [
    {
      label: '$HOME/Library/Application Support/desktop-pet-mvp/diagnostics',
      abs: join(home, 'Library/Application Support/desktop-pet-mvp/diagnostics'),
      exists: existsSync(join(home, 'Library/Application Support/desktop-pet-mvp/diagnostics'))
    },
    {
      label: '$HOME/Library/Application Support/PingPet/diagnostics',
      abs: join(home, 'Library/Application Support/PingPet/diagnostics'),
      exists: existsSync(join(home, 'Library/Application Support/PingPet/diagnostics'))
    }
  ]
}

function readBoundedJsonl(
  filePath: string,
  maxBytes: number,
  byteOffset: number
): { text: string; fileBytes: number; readBytes: number; truncated: boolean; exists: boolean } {
  if (!existsSync(filePath)) {
    return { text: '', fileBytes: 0, readBytes: 0, truncated: false, exists: false }
  }
  let fd: number | null = null
  try {
    const size = statSync(filePath).size
    const start = Math.max(0, byteOffset, size > maxBytes ? size - maxBytes : 0)
    const length = Math.min(maxBytes, Math.max(0, size - start))
    if (length <= 0) {
      return { text: '', fileBytes: size, readBytes: 0, truncated: size > 0, exists: true }
    }
    const buf = Buffer.allocUnsafe(length)
    fd = openSync(filePath, 'r')
    let read = 0
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read)
      if (n <= 0) break
      read += n
    }
    let text = buf.toString('utf8', 0, read)
    if (start > 0) {
      const nl = text.indexOf('\n')
      if (nl >= 0) text = text.slice(nl + 1)
    }
    return {
      text,
      fileBytes: size,
      readBytes: read,
      truncated: start > 0 || start + read < size,
      exists: true
    }
  } catch {
    return { text: '', fileBytes: 0, readBytes: 0, truncated: false, exists: false }
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

function inTimeWindow(rec: Record<string, unknown>, sinceMs?: number, untilMs?: number): boolean {
  const t = asNumber(rec.observedAt) ?? asNumber(rec.eventTime) ?? asNumber(rec.migrationObservedAt)
  if (t == null) return true
  if (sinceMs != null && t < sinceMs) return false
  if (untilMs != null && t > untilMs) return false
  return true
}

function parseFile(
  filePath: string,
  name: string,
  opts: { maxBytes: number; byteOffset: number; sinceMs?: number; untilMs?: number; sessionId?: string }
): FileReadResult {
  const raw = readBoundedJsonl(filePath, opts.maxBytes, opts.byteOffset)
  if (!raw.exists) {
    return {
      name,
      exists: false,
      fileBytes: 0,
      readBytes: 0,
      truncated: false,
      parsed: 0,
      uniqueIds: 0,
      duplicateIds: 0,
      malformed: 0,
      records: []
    }
  }
  let malformed = 0
  const parsed: Record<string, unknown>[] = []
  const seen = new Map<string, number>()
  for (const line of raw.text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: unknown
    try {
      obj = JSON.parse(trimmed)
    } catch {
      malformed += 1
      continue
    }
    const rec = asRecord(obj)
    if (!rec) {
      malformed += 1
      continue
    }
    if (!inTimeWindow(rec, opts.sinceMs, opts.untilMs)) continue
    if (opts.sessionId) {
      const sid = asString(rec.sessionId) ?? asString(rec.sessionKey)
      if (sid !== opts.sessionId) continue
    }
    parsed.push(rec)
    const id = asString(rec.observationId)
    if (id) seen.set(id, (seen.get(id) ?? 0) + 1)
  }
  let duplicateIds = 0
  for (const n of seen.values()) if (n > 1) duplicateIds += n - 1
  const unique = parsed.filter((rec, idx, arr) => {
    const id = asString(rec.observationId)
    if (!id) return true
    return arr.findIndex((other) => asString(other.observationId) === id) === idx
  })
  return {
    name,
    exists: true,
    fileBytes: raw.fileBytes,
    readBytes: raw.readBytes,
    truncated: raw.truncated,
    parsed: parsed.length,
    uniqueIds: unique.length,
    duplicateIds,
    malformed,
    records: unique
  }
}

function sessionOf(rec: Record<string, unknown>): string | undefined {
  return asString(rec.sessionId) ?? asString(rec.sessionKey)
}

function fileAliasOf(rec: Record<string, unknown>): string | undefined {
  return asString(rec.fileAlias)
}

function uniquePicked(
  recs: Record<string, unknown>[],
  pick: (rec: Record<string, unknown>) => string | undefined
): string[] {
  const seen = new Set<string>()
  for (const rec of recs) {
    const value = pick(rec)
    if (value) seen.add(value)
  }
  return [...seen].sort()
}

function turnOf(rec: Record<string, unknown>): string | undefined {
  const turn = asString(rec.turnId)
  return turn && turn !== 'unknown' ? turn : undefined
}

function correlate(
  legacy: Record<string, unknown>[],
  shadow: Record<string, unknown>[],
  candidate: Record<string, unknown>[]
): Array<{
  key: string
  via: 'sessionId' | 'fileAlias' | typeof UNMATCHED_CORRELATION
  fileAlias?: string
  sessions: string[]
  turns: string[]
  legacy: Record<string, unknown>[]
  shadow: Record<string, unknown>[]
  candidate: Record<string, unknown>[]
}> {
  const groups = new Map<
    string,
    {
      via: 'sessionId' | 'fileAlias' | typeof UNMATCHED_CORRELATION
      legacy: Record<string, unknown>[]
      shadow: Record<string, unknown>[]
      candidate: Record<string, unknown>[]
    }
  >()
  const unmatched: Record<string, unknown>[][] = [[], [], []]

  const put = (rec: Record<string, unknown>, bucket: 0 | 1 | 2) => {
    const session = sessionOf(rec)
    const alias = fileAliasOf(rec)
    // 先按 fileAlias 归组，避免旧路径 sessionKey 与影子 sessionId 哈希不同就被拆开。
    // 不按时间或顺序猜。无 fileAlias 时才退回 session。
    const key = alias ? `file:${alias}` : session ? `session:${session}` : ''
    if (!key) {
      unmatched[bucket].push(rec)
      return
    }
    const via = alias ? 'fileAlias' : 'sessionId'
    const cur = groups.get(key) ?? { via, legacy: [], shadow: [], candidate: [] }
    if (bucket === 0) cur.legacy.push(rec)
    if (bucket === 1) cur.shadow.push(rec)
    if (bucket === 2) cur.candidate.push(rec)
    groups.set(key, cur)
  }

  for (const rec of legacy) put(rec, 0)
  for (const rec of shadow) put(rec, 1)
  for (const rec of candidate) put(rec, 2)

  const rows = [...groups.entries()].map(([key, g]) => {
    const all = [...g.legacy, ...g.shadow, ...g.candidate]
    const sessions = uniquePicked(all, sessionOf)
    const turns = uniquePicked(all, turnOf)
    const alias = key.startsWith('file:') ? key.slice('file:'.length) : fileAliasOf(all[0] ?? {})
    if (sessions.length === 1) {
      return {
        ...g,
        key: `session:${sessions[0]}`,
        via: 'sessionId' as const,
        fileAlias: alias,
        sessions,
        turns
      }
    }
    return { ...g, key, via: g.via, fileAlias: alias, sessions, turns }
  })
  if (unmatched[0].length || unmatched[1].length || unmatched[2].length) {
    rows.push({
      key: UNMATCHED_CORRELATION,
      via: UNMATCHED_CORRELATION,
      fileAlias: undefined,
      sessions: [],
      turns: [],
      legacy: unmatched[0],
      shadow: unmatched[1],
      candidate: unmatched[2]
    })
  }
  return rows
}

function lastOf<T>(rows: T[]): T | undefined {
  return rows.length ? rows[rows.length - 1] : undefined
}

function classifyPair(
  legacyKind: string | undefined,
  lifecycle: string | undefined,
  item: string | undefined,
  cause: string | undefined,
  candidate: string | undefined,
  hasLegacy: boolean,
  hasShadow: boolean,
  unmatched: boolean
): { verdict: LiveDiffVerdict; note: string } {
  if (unmatched) return { verdict: '关联失败', note: '缺少 sessionId/fileAlias，不能按时间或顺序猜 turn' }
  if (!hasLegacy && !hasShadow) return { verdict: '无法确认', note: '该组没有可对照记录' }
  if (!hasLegacy && hasShadow) {
    return { verdict: '无法确认', note: '旧路径无事件，新路径有影子状态；不能据此判断旧路径漏判' }
  }
  if (hasLegacy && !hasShadow) {
    return { verdict: '无法确认', note: '新路径无影子记录；不能据此判断新检测器误判' }
  }
  if (lifecycle === 'unknown' && hasLegacy) {
    return { verdict: '新路径信息不足', note: '旧路径有事件，新路径 lifecycle=unknown' }
  }
  if (legacyKind === 'working' && lifecycle === 'running') {
    return { verdict: '一致', note: '旧 working 对应新 running' }
  }
  if (legacyKind === 'done' && candidate === 'completed_with_partial_failure') {
    return {
      verdict: '候选状态更谨慎',
      note: '旧路径 done，候选 completed_with_partial_failure；协议结束但有工具失败'
    }
  }
  if (legacyKind === 'done' && (item === 'partial_failure' || cause === 'tool_failed')) {
    return { verdict: '旧路径可能过早结束', note: '旧路径 done，新路径仍保留 item/tool 失败' }
  }
  if (legacyKind === 'done' && lifecycle === 'completed_signal') {
    return { verdict: '一致', note: '旧 done 对应 completed_signal；不等于任务成功' }
  }
  if (legacyKind === 'failed' && lifecycle === 'incomplete') {
    return { verdict: '候选状态更谨慎', note: '旧路径 failed，新路径 incomplete，不能确认 Agent 失败' }
  }
  if (legacyKind === 'failed' && lifecycle === 'failed') {
    return { verdict: '一致', note: '双方均为失败态；仍只是候选，未接入用户通知' }
  }
  if (legacyKind === 'needs_attention' && (candidate === 'cancelled' || candidate === 'incomplete' || candidate === 'waiting')) {
    return { verdict: '新检测器信息更丰富', note: '旧路径 needs_attention，新路径区分了取消/不完整/等待' }
  }
  return { verdict: '无法确认', note: 'session 级可见对应，但不足以做 turn 级判定' }
}

function checklist(shadow: Record<string, unknown>[], candidate: Record<string, unknown>[]): string[] {
  const lines: string[] = []
  const candPartial = candidate.filter((r) => asString(r.candidate) === 'completed_with_partial_failure')
  const shadowPartial = shadow.filter((r) => asString(r.item) === 'partial_failure')
  const toolFailed = shadow.filter((r) => asString(r.cause) === 'tool_failed')
  const integrity = shadow.filter((r) => asString(r.outputIntegrity) === 'partial')
  const retryUnknown = candidate.filter((r) => derivedField(r, 'retryability') === 'unknown')
  const incomplete = [...shadow, ...candidate].filter(
    (r) => asString(r.lifecycle) === 'incomplete' || asString(r.candidate) === 'incomplete'
  )
  const cancelledFromIncomplete = candidate.filter(
    (r) => asString(r.candidate) === 'cancelled' && derivedField(r, 'cause') === 'process_exit'
  )
  const unknownGuess = candidate.filter(
    (r) => asString(r.candidate) === 'unknown' && (asString(r.legacyEquivalent) === 'failed' || asString(r.legacyEquivalent) === 'done')
  )
  const notifyTrue = candidate.filter((r) => r.shouldNotify === true)
  lines.push(
    `- completed_signal 区分：普通 ${candidate.filter((r) => asString(r.candidate) === 'completed_signal').length}，partial_failure ${candPartial.length}`
  )
  lines.push(`- item=partial_failure 保留：${shadowPartial.length} 条影子记录`)
  lines.push(`- cause=tool_failed 保留：${toolFailed.length} 条`)
  lines.push(`- outputIntegrity=partial 保留：${integrity.length} 条`)
  lines.push(`- retryability=unknown 保留：${retryUnknown.length} 条候选记录`)
  lines.push(
    `- incomplete/process_exit 未变成 cancelled：${cancelledFromIncomplete.length === 0 ? '是' : '否（见计数 ' + cancelledFromIncomplete.length + '）'}`
  )
  lines.push(`- unknown 未被猜成 failed/succeeded：${unknownGuess.length === 0 ? '是' : '否'}`)
  lines.push(`- shouldNotify 始终 false：${notifyTrue.length === 0 ? '是' : '否'}`)
  lines.push(`- incomplete 记录数：${incomplete.length}`)
  return lines
}

function renderCounts(title: string, map: Record<string, number>): string[] {
  const keys = Object.keys(map).sort()
  if (!keys.length) return [`- ${title}：无`]
  return [`- ${title}：${keys.map((k) => ` \`${k}\`=${map[k]}`).join('；')}`]
}

export function buildCodexLiveShadowReport(options: CodexLiveShadowReportOptions): {
  conclusion: LiveReportConclusion
  markdown: string
  missing: string[]
  present: string[]
} {
  const nowMs = options.nowMs ?? Date.now()
  const sinceMs = options.sinceMs ?? nowMs - DEFAULT_WINDOW_MS
  const untilMs = options.untilMs
  const maxBytes = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES
  const byteOffset = options.byteOffset ?? 0
  const dir = options.diagnosticsDir
  const label = options.diagnosticsLabel ?? 'userData/diagnostics'
  const files = {
    legacy: join(dir, 'codex-legacy.jsonl'),
    shadow: join(dir, 'codex-shadow.jsonl'),
    candidate: join(dir, 'codex-candidate.jsonl')
  }
  const readOpts = { maxBytes, byteOffset, sinceMs, untilMs, sessionId: options.sessionId }
  const legacy = parseFile(files.legacy, 'codex-legacy.jsonl', readOpts)
  const shadow = parseFile(files.shadow, 'codex-shadow.jsonl', readOpts)
  const candidate = parseFile(files.candidate, 'codex-candidate.jsonl', readOpts)
  const present = [legacy, shadow, candidate].filter((f) => f.exists).map((f) => f.name)
  const missing = [legacy, shadow, candidate].filter((f) => !f.exists).map((f) => f.name)
  const dirExists = existsSync(dir)

  let conclusion: LiveReportConclusion = 'PARTIAL'
  if (!dirExists || present.length === 0) conclusion = LIVE_REPORT_BLOCKED
  else if (present.length < 3) conclusion = 'PARTIAL'
  else conclusion = 'PARTIAL'

  const groups = correlate(legacy.records, shadow.records, candidate.records)
  const diffs = groups.map((g) => {
    const L = lastOf(g.legacy)
    const S = lastOf(g.shadow)
    const C = lastOf(g.candidate)
    const classified = classifyPair(
      asString(L?.legacyKind),
      asString(S?.lifecycle) ?? derivedField(C ?? {}, 'lifecycle'),
      asString(S?.item) ?? derivedField(C ?? {}, 'item'),
      asString(S?.cause) ?? derivedField(C ?? {}, 'cause'),
      asString(C?.candidate),
      g.legacy.length > 0,
      g.shadow.length > 0 || g.candidate.length > 0,
      g.via === UNMATCHED_CORRELATION
    )
    const legacyKinds = uniquePicked(g.legacy, (r) => asString(r.legacyKind))
    const lifecycles = uniquePicked(g.shadow, (r) => asString(r.lifecycle))
    const candidates = uniquePicked(g.candidate, (r) => asString(r.candidate))
    return {
      key: g.key,
      via: g.via,
      fileAlias: g.fileAlias,
      sessions: g.sessions,
      turns: g.turns,
      legacyKind: asString(L?.legacyKind) ?? (g.legacy.length ? '(present)' : '无事件'),
      legacyKinds: legacyKinds.join(',') || (g.legacy.length ? '(present)' : '无事件'),
      lifecycle: asString(S?.lifecycle) ?? derivedField(C ?? {}, 'lifecycle') ?? (g.shadow.length ? '(present)' : '无事件'),
      lifecycles: lifecycles.join(',') || (g.shadow.length ? '(present)' : '无事件'),
      item: asString(S?.item) ?? derivedField(C ?? {}, 'item') ?? 'n/a',
      cause: asString(S?.cause) ?? derivedField(C ?? {}, 'cause') ?? 'n/a',
      candidate: asString(C?.candidate) ?? (g.candidate.length ? '(present)' : '无事件'),
      candidates: candidates.join(',') || (g.candidate.length ? '(present)' : '无事件'),
      notify: C ? String(C.shouldNotify ?? false) : 'n/a',
      ...classified
    }
  })

  const verdictCounts: Record<string, number> = {}
  for (const row of diffs) bump(verdictCounts, row.verdict)

  const ignored: Record<string, number> = {}
  let dispatched = 0
  for (const rec of legacy.records) {
    if (rec.dispatched === true) dispatched += 1
    const arr = rec.ignoredBy
    if (Array.isArray(arr)) for (const reason of arr) bump(ignored, String(reason))
  }

  const candidateCounts = countMap(candidate.records, 'candidate')
  const shouldNotifyTrue = candidate.records.filter((r) => r.shouldNotify === true).length
  const petCounts = countMap(candidate.records, 'candidatePetState')

  const lines: string[] = []
  const push = (s = '') => lines.push(s)
  push('# Codex 真实运行影子对照（阶段 6）')
  push()
  push('## 1. 执行结论')
  push()
  push(`**${conclusion}**`)
  push()
  if (conclusion === LIVE_REPORT_BLOCKED) {
    push('未找到真实运行期间产生的诊断文件，因此不能声称对照已完成。')
    push()
    push('缺失：')
    for (const name of missing) push(`- \`${name}\``)
    push()
    push('- 尚未产生真实运行数据。')
    push('- 不能用单元测试或 fixture 冒充真实运行。')
    push('- 不能据此替换正式 Monitor。')
  } else if (missing.length) {
    push(`诊断目录有部分文件。缺失：${missing.map((n) => `\`${n}\``).join('、') || '无'}。`)
    push('缺失路径不计入状态不一致。')
  } else {
    push('三个诊断文件均存在。当前最多做 session 级对照，可辅以 fileAlias；不能做完整 turn 级一一对应。')
  }
  push()
  push('本报告只读取真实 userData 诊断 JSONL。')
  push('- 真实运行数据：下面列出的 `codex-*.jsonl`。')
  push('- fixture / 单元测试数据：未计入本报告。')
  push('- 不能用单元测试结果冒充真实运行。')
  push()
  push('候选状态不是正式用户状态。`shouldNotify` 必须为 false。本报告不改变桌宠、气泡、声音或 Monitor。')
  push()
  push('## 2. 数据范围')
  push()
  push(`- 诊断目录：\`${label}\`${dirExists ? '（存在）' : '（不存在）'}`)
  push(`- 时间窗口：${iso(sinceMs)} → ${iso(untilMs ?? nowMs)}`)
  if (options.sessionId) push(`- 仅统计脱敏 session：\`${options.sessionId}\``)
  push(`- 每文件最大读取 ${maxBytes} 字节；byteOffset=${byteOffset}`)
  for (const f of [legacy, shadow, candidate]) {
    push(
      `- \`${f.name}\`：${f.exists ? '存在' : '不存在'}；文件 ${f.fileBytes} 字节；读入 ${f.readBytes} 字节；解析 ${f.parsed}；去重后 ${f.uniqueIds}；重复 observationId ${f.duplicateIds}；malformed ${f.malformed}${f.truncated ? '；因字节上限截断' : ''}`
    )
  }
  push()
  push('## 2.1 关联结果')
  push()
  push('关联优先级：脱敏 sessionId/sessionKey → fileAlias。不按时间或顺序猜 turnId，不猜造真实 sessionId。')
  if (!groups.length) {
    push('- 无分组。')
  } else {
    for (const g of groups.slice(0, 40)) {
      if (g.key === UNMATCHED_CORRELATION) {
        push(`- \`${UNMATCHED_CORRELATION}\`：缺少 sessionId/fileAlias，不能按时间合并。`)
        continue
      }
      const sessionNote =
        g.sessions.length === 0
          ? '无 session 哈希'
          : g.sessions.length === 1
            ? `session 哈希一致 \`${g.sessions[0]}\``
            : `session 哈希不一致（${g.sessions.map((s) => `\`${s}\``).join('、')}）；fileAlias 仍可对齐`
      const turnNote = g.turns.length ? `有脱敏 turnId ${g.turns.length} 个` : 'turnId 均为 unknown 或缺失'
      push(
        `- \`${g.key}\`${g.fileAlias ? ` / fileAlias=\`${g.fileAlias}\`` : ''}：legacy ${g.legacy.length} / shadow ${g.shadow.length} / candidate ${g.candidate.length}；via=${g.via}；${sessionNote}；${turnNote}`
      )
    }
  }
  push()
  push('## 3. 旧路径统计')
  push()
  if (!legacy.exists) {
    push('- 文件不存在。不能把缺失当成旧路径无事件或新检测器误判。')
  } else {
    push(...renderCounts('legacyKind', countMap(legacy.records, 'legacyKind')))
    push(`- dispatched=true：${dispatched}`)
    push(...renderCounts('ignoredBy', ignored))
  }
  push()
  push('## 4. 新检测器统计')
  push()
  if (!shadow.exists) {
    push('- 文件不存在。不能把缺失当成状态不一致。')
  } else {
    push(...renderCounts('lifecycle', countMap(shadow.records, 'lifecycle')))
    push(...renderCounts('cause', countMap(shadow.records, 'cause')))
    push(...renderCounts('process', countMap(shadow.records, 'process')))
    push(...renderCounts('connection', countMap(shadow.records, 'connection')))
    push(...renderCounts('item', countMap(shadow.records, 'item')))
    push(...renderCounts('outputIntegrity', countMap(shadow.records, 'outputIntegrity')))
    push(...renderCounts('confidence', countMap(shadow.records, 'confidence')))
    push(`- unknown lifecycle：${shadow.records.filter((r) => r.lifecycle === 'unknown').length}`)
    push(`- incomplete lifecycle：${shadow.records.filter((r) => r.lifecycle === 'incomplete').length}`)
    push(`- completed_signal：${shadow.records.filter((r) => r.lifecycle === 'completed_signal').length}`)
    push(`- item=partial_failure：${shadow.records.filter((r) => r.item === 'partial_failure').length}`)
    push('- 影子记录本身不一定带 turn / taskSemantics / retryability；这些字段以候选诊断 derived 为准。')
  }
  if (candidate.exists) {
    const turns: Record<string, number> = {}
    const semantics: Record<string, number> = {}
    const retries: Record<string, number> = {}
    for (const rec of candidate.records) {
      bump(turns, derivedField(rec, 'turn'))
      bump(semantics, derivedField(rec, 'taskSemantics'))
      bump(retries, derivedField(rec, 'retryability'))
    }
    push(...renderCounts('candidate.derived.turn', turns))
    push(...renderCounts('candidate.derived.taskSemantics', semantics))
    push(...renderCounts('candidate.derived.retryability', retries))
  }
  push()
  push('## 5. 候选状态统计')
  push()
  if (!candidate.exists) {
    push('- 文件不存在。不能把缺失当成候选状态不一致。')
  } else {
    push(...renderCounts('candidate', candidateCounts))
    push(...renderCounts('candidatePetState（仅影子统计）', petCounts))
    push(`- shouldNotify=true：${shouldNotifyTrue}（必须为 0）`)
    push(`- shouldNotify 始终 false：${shouldNotifyTrue === 0 ? '是' : '否'}`)
  }
  push()
  push('## 6. 新旧对照')
  push()
  push('当前最多 session 级对照，不是完整 turn 级对照。')
  push('缺少对应记录 ≠ 误判。无法可靠关联标记为 `UNMATCHED_CORRELATION`。')
  push()
  push('| 关联 | 旧事件 | 新 DerivedState | CandidateState | 是否允许用户通知 | 当前结论 |')
  push('|---|---|---|---|---|---|')
  if (!diffs.length) {
    push('| 无 | 无 | 无 | 无 | 否 | 无法确认 |')
  } else {
    for (const row of diffs.slice(0, 40)) {
      const keyLabel = row.key === UNMATCHED_CORRELATION ? UNMATCHED_CORRELATION : row.key
      push(
        `| ${keyLabel} | ${row.legacyKinds} | ${row.lifecycles} / item=${row.item} / cause=${row.cause} | ${row.candidates} | 否 | ${row.verdict}：${row.note} |`
      )
    }
    if (diffs.length > 40) push(`| … | … | … | 否 | 其余 ${diffs.length - 40} 组已计入统计，未展开 |`)
  }
  push()
  push(...renderCounts('对照分类', verdictCounts))
  push()
  push('## 7. 专项检查')
  push()
  if (shadow.exists || candidate.exists) {
    for (const line of checklist(shadow.records, candidate.records)) push(line)
  } else {
    push('- 无影子/候选数据，专项检查样本未覆盖。')
  }
  push('- 多个 turn 状态污染：本报告不做 turn 级一一对应，标记为无法确认。')
  push(
    `- 多个 session 串线：fileAlias 组 ${groups.filter((g) => g.key !== UNMATCHED_CORRELATION).length} 个；只按已有脱敏 sessionId / fileAlias 分组，不按时间猜。同一 fileAlias 上旧 sessionKey 与影子 sessionId 哈希不同 ≠ 串线。`
  )
  push(`- 重复 observationId：legacy ${legacy.duplicateIds}，shadow ${shadow.duplicateIds}，candidate ${candidate.duplicateIds}`)
  push(
    `- prime 重放：legacy ignoredBy 含 prime ${Object.entries(ignored).filter(([k]) => k === 'prime').reduce((n, [, v]) => n + v, 0)} 条。诊断回调在 prime 时不发射；仅凭落盘记录不能反证未落盘的 prime 行为。`
  )
  push('- candidatePetState 未进入用户行为：本报告为只读统计，未改桌宠/气泡/声音。')
  push()
  push('## 7.1 保持 unknown 的字段')
  push()
  push('- `completed_signal` 只表示协议发出结束信号，不等于任务成功；candidate 不得映射为 succeeded。')
  if (shadow.exists) {
    const itemUnknown = shadow.records.filter((r) => asString(r.item) === 'unknown').length
    const causeUnknown = shadow.records.filter((r) => asString(r.cause) === 'unknown').length
    const oiUnknown = shadow.records.filter((r) => asString(r.outputIntegrity) === 'unknown').length
    const sources = uniquePicked(shadow.records, (r) => asString(r.source))
    push(`- shadow item=unknown：${itemUnknown}/${shadow.records.length}。source=${sources.join(',') || 'n/a'}。本地 session JSONL 不一定带官方 item status，不能写成协议不支持。`)
    push(`- shadow cause=unknown：${causeUnknown}/${shadow.records.length}。本窗口无 tool_failed / turn_failed 结构化证据。`)
    push(`- shadow outputIntegrity=unknown：${oiUnknown}/${shadow.records.length}。无 complete/partial 的结构化证据。`)
  }
  if (legacy.exists) {
    const legacyTurnUnknown = legacy.records.filter((r) => !turnOf(r)).length
    push(`- 旧路径 turnId/threadId：${legacyTurnUnknown}/${legacy.records.length} 条为 unknown 或缺失。旧 Monitor 未提供则不得猜造。`)
  }
  push()
  push('## 8. 尚未完成项')
  push()
  push('以下官方事件若本窗口未出现，只能写样本未覆盖，不能写不支持：')
  push()
  push('- `turn.failed`')
  push('- `turn.cancelled`')
  push('- 顶层 `error`')
  push('- 限流 / 鉴权 / 审批 / 断流 / 超时')
  push()
  push('## 9. 下一步')
  push()
  push('仍不能替换正式 Monitor。候选状态与 `shouldNotify=false` 必须保持影子诊断。')
  push()

  const markdown = lines.join('\n')
  if (SENSITIVE.test(markdown)) {
    return {
      conclusion,
      markdown: markdown.replace(SENSITIVE, '[redacted]'),
      missing,
      present
    }
  }
  return { conclusion, markdown, missing, present }
}

export function writeCodexLiveShadowDocs(
  docsDir: string,
  report: ReturnType<typeof buildCodexLiveShadowReport>
): string {
  mkdirSync(docsDir, { recursive: true })
  const name =
    report.conclusion === LIVE_REPORT_BLOCKED
      ? 'codex-live-shadow-comparison-blocked.md'
      : 'codex-live-shadow-comparison.md'
  const out = resolve(docsDir, name)
  writeFileSync(out, report.markdown)
  return out
}

export function runCodexLiveShadowReportFromDefaultDirs(nowMs = Date.now()): {
  report: ReturnType<typeof buildCodexLiveShadowReport>
  label: string
} {
  const found = defaultDiagnosticsCandidates().find((c) => c.exists)
  if (!found) {
    return {
      label: 'userData/diagnostics',
      report: buildCodexLiveShadowReport({
        diagnosticsDir: join(homedir(), 'Library/Application Support/desktop-pet-mvp/diagnostics'),
        diagnosticsLabel: '$HOME/Library/Application Support/desktop-pet-mvp/diagnostics',
        nowMs,
        sinceMs: nowMs - DEFAULT_WINDOW_MS
      })
    }
  }
  return {
    label: found.label,
    report: buildCodexLiveShadowReport({
      diagnosticsDir: found.abs,
      diagnosticsLabel: found.label,
      nowMs,
      sinceMs: nowMs - DEFAULT_WINDOW_MS
    })
  }
}
