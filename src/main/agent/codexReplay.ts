import { statSync } from 'node:fs'
import {
  AGENT_EVENT_FRESH_MS,
  AGENT_FILE_FRESH_MS,
  AGENT_MAX_FILES_PER_SOURCE,
  AGENT_TAIL_BYTES
} from '@shared/defaults'
import type {
  AgentEventKind,
  CodexDerivedState,
  CodexLifecycleState,
  CodexNormalizedEventType,
  CodexObservationEvent,
  CodexObservationSource
} from '@shared/types'
import {
  classifyCodexLegacyLine,
  codexSessionsRoot,
  type CodexLegacySignalVia
} from './codex'
import {
  CodexObservationJournal,
  emptyCodexJsonlFileCursor,
  observeCodexJsonlFile
} from './codexObserve'
import { CodexStateDetector, isCodexLifecycleTerminal } from './codexState'
import { findRecentFiles } from './findFiles'

/**
 * 只读 Codex session 回放与新旧路径对照。
 * 不驱动桌宠，不写真实日志进仓库，不把 DerivedState 映射成 working/done。
 */

const SENSITIVE_KEY =
  /prompt|content|command|text|token|secret|password|authorization|api[_-]?key|input|output|message|instruction/i

export interface CodexSessionFileInfo {
  alias: string
  size: number
  mtimeMs: number
  readable: boolean
}

export interface CodexReplayDiscoverResult {
  root: string
  rootExists: boolean
  files: CodexSessionFileInfo[]
}

export type OldPathIgnoreReason = 'freshness' | 'outside_tail' | 'file_not_in_recent_scan'

export interface OldPathReplayEvent {
  seq: number
  byteOffset: number
  timestampMs: number
  kind: AgentEventKind
  via: CodexLegacySignalVia
  ignoredByProduction: OldPathIgnoreReason[]
}

export interface NewPathReplayRow {
  seq: number
  eventType: CodexNormalizedEventType
  recognition: string
  lifecycle: CodexLifecycleState
  cause: CodexDerivedState['cause']
  process: CodexDerivedState['process']
  connection: CodexDerivedState['connection']
  session: CodexDerivedState['session']
  item: CodexDerivedState['item']
  outputIntegrity: CodexDerivedState['outputIntegrity']
  taskSemantics: CodexDerivedState['taskSemantics']
  confidence: CodexDerivedState['confidence']
  reason: string
  isTerminal: boolean
  sessionId?: string
  threadId?: string
  turnId?: string
}

export type ReplayVerdict =
  | '一致'
  | '新检测器更精确'
  | '新检测器信息不足'
  | '旧路径误判候选'
  | '新检测器误判候选'
  | '无法确认'
  | '样本未覆盖'

export interface ReplayComparisonRow {
  phase: string
  oldResult: string
  newResult: string
  verdict: ReplayVerdict
  difference: string
  evidence: string
  /** 本轮对照是否改变用户可见行为。诊断/回放一律否。 */
  userImpact: string
}

export interface SessionReplayResult {
  alias: string
  size: number
  mtimeMs: number
  replayedBytes: number
  truncated: boolean
  hasSessionId: boolean
  hasThreadId: boolean
  hasTurnId: boolean
  eventTypeCounts: Record<string, number>
  unknownCount: number
  malformedCount: number
  unsupportedCount: number
  itemFailedCount: number
  turnStartedCount: number
  turnCompletedCount: number
  turnFailedCount: number
  abortCount: number
  officialStructuredCount: number
  oldEvents: OldPathReplayEvent[]
  newFinal: CodexDerivedState
  newRows: NewPathReplayRow[]
  comparisons: ReplayComparisonRow[]
  selectionReasons?: SamplePickReason[]
}

export type SamplePickReason =
  | 'completed_session'
  | 'item_or_tool_failure'
  | 'multi_turn'
  | 'recently_active'
  | 'older_history'
  | 'unknown_or_malformed'
  | 'incomplete_last_line'
  | 'large_incremental'

export interface SessionCoverageProbe {
  alias: string
  size: number
  mtimeMs: number
  readable: boolean
  hasComplete: boolean
  hasItemFailed: boolean
  hasMultiTurn: boolean
  hasUnknownOrMalformed: boolean
  hasLeftover: boolean
  turnStarts: number
  officialCount: number
  probedBytes: number
}

export interface CoverageSamplePick {
  filePath: string
  alias: string
  reasons: SamplePickReason[]
  maxBytes: number
  size: number
  mtimeMs: number
}

export interface CoverageSampleSelection {
  directoryFileCount: number
  probedCount: number
  skippedProbeCount: number
  picks: CoverageSamplePick[]
  notReplayedCount: number
  note: string
}

export interface CodexReplayOptions {
  nowMs?: number
  maxBytes?: number
  maxSlicesPerFile?: number
  maxBytesPerSlice?: number
  recentScanPaths?: string[]
  selectionReasons?: SamplePickReason[]
  /**
   * JSONL 来源。默认 session_jsonl，保持本地 session / 生产影子回放不变。
   * 官方 exec --json 必须显式传 exec_json，否则点号事件不会走官方 interpret。
   */
  source?: CodexObservationSource
}

function hash8(value: string): string {
  let h = 5381
  for (let i = 0; i < value.length; i += 1) h = (h * 33) ^ value.charCodeAt(i)
  return (h >>> 0).toString(36).padStart(8, '0').slice(0, 8)
}

export function redactId(value: string | undefined, prefix: string): string | undefined {
  if (!value) return undefined
  return `${prefix}-${hash8(value)}`
}

export function sessionAlias(index: number): string {
  return `session-${String(index + 1).padStart(3, '0')}`
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key)
}

/** 只保留字段存在性和非敏感枚举，去掉正文/命令/路径/token。 */
export function redactForReplay(value: unknown, key = ''): unknown {
  if (value == null) return value
  if (typeof value === 'string') {
    if (isSensitiveKey(key)) return `[redacted:${value.length}ch]`
    if (value.length > 48) return `[redacted:${value.length}ch]`
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return { kind: 'array', length: value.length }
  if (typeof value === 'object') {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = v == null ? 'null' : Array.isArray(v) ? `array:${v.length}` : typeof v
    }
    return out
  }
  return typeof value
}

export function discoverCodexSessionFiles(
  root = codexSessionsRoot(),
  maxDepth = 8
): CodexReplayDiscoverResult {
  let rootExists = true
  try {
    const st = statSync(root)
    rootExists = st.isDirectory()
  } catch {
    rootExists = false
  }
  if (!rootExists) return { root, rootExists: false, files: [] }

  const paths = listCodexSessionPaths(root, maxDepth)
  const files: CodexSessionFileInfo[] = paths.map((filePath, index) => {
    try {
      const st = statSync(filePath)
      return {
        alias: sessionAlias(index),
        size: st.size,
        mtimeMs: st.mtimeMs,
        readable: st.isFile() && st.size >= 0
      }
    } catch {
      return { alias: sessionAlias(index), size: 0, mtimeMs: 0, readable: false }
    }
  })
  return { root, rootExists: true, files }
}

export function explainOldPathOfflineLimits(): string[] {
  return [
    `production scanCodex only opens the ${AGENT_MAX_FILES_PER_SOURCE} newest files`,
    `production skips files with mtime older than ${AGENT_FILE_FRESH_MS}ms`,
    `production only reads the last ${AGENT_TAIL_BYTES} bytes of each file`,
    `production drops events older than ${AGENT_EVENT_FRESH_MS}ms relative to now`,
    'offline replay therefore uses a read-only adapter and records these ignore reasons instead of faking the clock'
  ]
}

function classifyOldPathObservation(
  event: CodexObservationEvent,
  nowMs: number
): { kind: AgentEventKind; via: CodexLegacySignalVia; timestampMs: number } | null {
  const timestampMs = event.eventTime ?? nowMs
  if (event.eventType === 'event_msg.task_started') {
    return { kind: 'working', via: 'event_msg.task_started', timestampMs }
  }
  if (event.eventType === 'event_msg.task_complete') {
    return { kind: 'done', via: 'event_msg.task_complete', timestampMs }
  }
  if (event.eventType === 'event_msg.turn_aborted') {
    return { kind: 'failed', via: 'event_msg.turn_aborted', timestampMs }
  }
  if (event.eventType === 'response_item' && event.payload && typeof event.payload === 'object') {
    // 回放要复现修复前的旧路径（含 assistant 正文判 done），否则对照报告会失真。
    // 生产扫描不传这个选项，正文不再产出终态。
    const classified = classifyCodexLegacyLine(event.payload as Record<string, unknown>, {
      allowAssistantTextTerminal: true
    })
    if (classified) {
      return { kind: classified.kind, via: classified.via, timestampMs: classified.timestampMs || timestampMs }
    }
  }
  return null
}

function productionIgnoreReasons(
  timestampMs: number,
  byteOffset: number,
  fileSize: number,
  filePath: string,
  nowMs: number,
  recentScanPaths: string[] | undefined
): OldPathIgnoreReason[] {
  const ignored: OldPathIgnoreReason[] = []
  if (nowMs - timestampMs > AGENT_EVENT_FRESH_MS) ignored.push('freshness')
  if (fileSize > AGENT_TAIL_BYTES && byteOffset < fileSize - AGENT_TAIL_BYTES) ignored.push('outside_tail')
  if (recentScanPaths && !recentScanPaths.includes(filePath)) ignored.push('file_not_in_recent_scan')
  return ignored
}

export function replayOldPathFile(
  filePath: string,
  options: CodexReplayOptions = {}
): OldPathReplayEvent[] {
  const nowMs = options.nowMs ?? Date.now()
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
  const slice = options.maxBytesPerSlice ?? 256_000
  const journal = new CodexObservationJournal()
  let cursor = emptyCodexJsonlFileCursor()
  let size = 0
  try {
    size = statSync(filePath).size
  } catch {
    return []
  }
  const out: OldPathReplayEvent[] = []
  let seq = 0
  let eof = false
  let rounds = 0
  const maxRounds = options.maxSlicesPerFile ?? 512
  while (!eof && rounds < maxRounds && cursor.byteOffset < maxBytes) {
    rounds += 1
    const prev = cursor.byteOffset
    const result = observeCodexJsonlFile(filePath, journal, cursor, nowMs, slice)
    cursor = result.cursor
    eof = result.eof
    for (const item of result.results) {
      const classified = classifyOldPathObservation(item.event, nowMs)
      if (!classified) continue
      seq += 1
      out.push({
        seq,
        byteOffset: prev,
        timestampMs: classified.timestampMs,
        kind: classified.kind,
        via: classified.via,
        ignoredByProduction: productionIgnoreReasons(
          classified.timestampMs,
          prev,
          size,
          filePath,
          nowMs,
          options.recentScanPaths
        )
      })
    }
    if (cursor.byteOffset === prev) break
  }
  return out
}

export function replayNewPathFile(
  filePath: string,
  options: CodexReplayOptions = {}
): { state: CodexDerivedState; rows: NewPathReplayRow[]; replayedBytes: number; truncated: boolean } {
  const nowMs = options.nowMs ?? Date.now()
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
  const slice = options.maxBytesPerSlice ?? 256_000
  const journal = new CodexObservationJournal()
  const detector = new CodexStateDetector(nowMs)
  let cursor = emptyCodexJsonlFileCursor()
  const rows: NewPathReplayRow[] = []
  let eof = false
  let rounds = 0
  const maxRounds = options.maxSlicesPerFile ?? 512
  let size = 0
  try {
    size = statSync(filePath).size
  } catch {
    return { state: detector.getState(), rows, replayedBytes: 0, truncated: false }
  }

  while (!eof && rounds < maxRounds && cursor.byteOffset < maxBytes) {
    rounds += 1
    const previous = cursor.byteOffset
    const result = observeCodexJsonlFile(
      filePath,
      journal,
      cursor,
      nowMs,
      slice,
      options.source ?? 'session_jsonl'
    )
    cursor = result.cursor
    eof = result.eof
    for (const item of result.results) {
      if (!item.accepted) continue
      const applied = detector.apply(item.event)
      const state = applied.state
      rows.push({
        seq: rows.length + 1,
        eventType: item.event.eventType,
        recognition: item.event.recognition,
        lifecycle: state.lifecycle,
        cause: state.cause,
        process: state.process,
        connection: state.connection,
        session: state.session,
        item: state.item,
        outputIntegrity: state.outputIntegrity,
        taskSemantics: state.taskSemantics,
        confidence: state.confidence,
        reason: applied.migration?.reason ?? applied.reason,
        isTerminal: isCodexLifecycleTerminal(state.lifecycle),
        sessionId: redactId(state.sessionId, 'sess'),
        threadId: redactId(state.threadId, 'th'),
        turnId: redactId(state.turnId, 'turn')
      })
    }
    if (cursor.byteOffset === previous) break
  }
  return {
    state: detector.getState(),
    rows,
    replayedBytes: Math.min(cursor.byteOffset, size),
    truncated: !eof || cursor.byteOffset < size || Boolean(journal.leftover)
  }
}

function countBy(rows: NewPathReplayRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) {
    out[row.eventType] = (out[row.eventType] ?? 0) + 1
  }
  return out
}

const OFFICIAL_PROBE_TYPES = new Set<string>([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'item.started',
  'item.updated',
  'item.completed',
  'error'
])

export function probeSessionCoverage(
  filePath: string,
  alias: string,
  options: { nowMs?: number; probeBytes?: number; maxBytesPerSlice?: number } = {}
): SessionCoverageProbe {
  const nowMs = options.nowMs ?? Date.now()
  const probeBytes = options.probeBytes ?? 256_000
  const slice = options.maxBytesPerSlice ?? 256_000
  let size = 0
  let mtimeMs = 0
  try {
    const st = statSync(filePath)
    size = st.size
    mtimeMs = st.mtimeMs
  } catch {
    return {
      alias,
      size: 0,
      mtimeMs: 0,
      readable: false,
      hasComplete: false,
      hasItemFailed: false,
      hasMultiTurn: false,
      hasUnknownOrMalformed: false,
      hasLeftover: false,
      turnStarts: 0,
      officialCount: 0,
      probedBytes: 0
    }
  }

  const journal = new CodexObservationJournal()
  let cursor = emptyCodexJsonlFileCursor()
  let eof = false
  let turnStarts = 0
  let hasComplete = false
  let hasItemFailed = false
  let hasUnknownOrMalformed = false
  let officialCount = 0
  let rounds = 0
  while (!eof && rounds < 8 && cursor.byteOffset < probeBytes) {
    rounds += 1
    const prev = cursor.byteOffset
    const result = observeCodexJsonlFile(filePath, journal, cursor, nowMs, slice)
    cursor = result.cursor
    eof = result.eof
    for (const item of result.results) {
      const type = item.event.eventType
      if (type === 'event_msg.task_started' || type === 'turn.started') turnStarts += 1
      if (type === 'event_msg.task_complete' || type === 'turn.completed') hasComplete = true
      if (
        type === 'unknown' ||
        type === 'malformed' ||
        type === 'unsupported' ||
        type === 'partial_line'
      ) {
        hasUnknownOrMalformed = true
      }
      if (OFFICIAL_PROBE_TYPES.has(type)) officialCount += 1
      const status = item.event.itemStatus?.toLowerCase()
      if (
        (type === 'event_msg.item_completed' || type === 'item.completed') &&
        (status === 'failed' || status === 'error' || status === 'declined')
      ) {
        hasItemFailed = true
      }
    }
    if (cursor.byteOffset === prev) break
  }

  return {
    alias,
    size,
    mtimeMs,
    readable: true,
    hasComplete,
    hasItemFailed,
    hasMultiTurn: turnStarts >= 2,
    hasUnknownOrMalformed,
    hasLeftover: eof && Boolean(journal.leftover.trim()),
    turnStarts,
    officialCount,
    probedBytes: Math.min(cursor.byteOffset, size)
  }
}

export function selectCoverageSamples(args: {
  paths: string[]
  aliases: string[]
  nowMs: number
  maxDetail?: number
  probeBytes?: number
  skipProbeAboveBytes?: number
  largeIncrementalBytes?: number
}): CoverageSampleSelection {
  const maxDetail = args.maxDetail ?? 8
  const probeBytes = args.probeBytes ?? 256_000
  const skipAbove = args.skipProbeAboveBytes ?? 40_000_000
  const largeBytes = args.largeIncrementalBytes ?? 512_000
  const probes: Array<SessionCoverageProbe & { index: number; filePath: string }> = []
  let skippedProbeCount = 0

  for (let i = 0; i < args.paths.length; i += 1) {
    const filePath = args.paths[i]
    const alias = args.aliases[i] ?? sessionAlias(i)
    let size = 0
    let mtimeMs = 0
    try {
      const st = statSync(filePath)
      size = st.size
      mtimeMs = st.mtimeMs
    } catch {
      skippedProbeCount += 1
      continue
    }
    if (size > skipAbove) {
      skippedProbeCount += 1
      probes.push({
        index: i,
        filePath,
        alias,
        size,
        mtimeMs,
        readable: true,
        hasComplete: false,
        hasItemFailed: false,
        hasMultiTurn: false,
        hasUnknownOrMalformed: false,
        hasLeftover: false,
        turnStarts: 0,
        officialCount: 0,
        probedBytes: 0
      })
      continue
    }
    probes.push({
      ...probeSessionCoverage(filePath, alias, { nowMs: args.nowMs, probeBytes }),
      index: i,
      filePath
    })
  }

  const picked = new Map<number, SamplePickReason[]>()
  const add = (index: number, reason: SamplePickReason) => {
    const cur = picked.get(index) ?? []
    if (!cur.includes(reason)) cur.push(reason)
    picked.set(index, cur)
  }
  const unused = (pred: (p: (typeof probes)[number]) => boolean) =>
    probes.find((p) => pred(p) && !picked.has(p.index))
  const any = (pred: (p: (typeof probes)[number]) => boolean) => probes.find((p) => pred(p))

  const complete = unused((p) => p.hasComplete) ?? any((p) => p.hasComplete)
  if (complete) add(complete.index, 'completed_session')
  const failed = unused((p) => p.hasItemFailed) ?? any((p) => p.hasItemFailed)
  if (failed) add(failed.index, 'item_or_tool_failure')
  const multi = unused((p) => p.hasMultiTurn) ?? any((p) => p.hasMultiTurn)
  if (multi) add(multi.index, 'multi_turn')

  const byMtimeDesc = [...probes].sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (byMtimeDesc[0]) add(byMtimeDesc[0].index, 'recently_active')
  const older = [...probes]
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .find((p) => p.index !== byMtimeDesc[0]?.index)
  if (older) add(older.index, 'older_history')

  const unknown = unused((p) => p.hasUnknownOrMalformed) ?? any((p) => p.hasUnknownOrMalformed)
  if (unknown) add(unknown.index, 'unknown_or_malformed')
  const leftover = unused((p) => p.hasLeftover) ?? any((p) => p.hasLeftover)
  if (leftover) add(leftover.index, 'incomplete_last_line')
  const large = unused((p) => p.size > 1_500_000) ?? any((p) => p.size > 1_500_000)
  if (large) add(large.index, 'large_incremental')

  const picks: CoverageSamplePick[] = []
  for (const [index, reasons] of picked) {
    if (picks.length >= maxDetail) break
    const probe = probes.find((p) => p.index === index)
    if (!probe) continue
    const incremental = reasons.includes('large_incremental') && probe.size > 1_500_000
    picks.push({
      filePath: probe.filePath,
      alias: probe.alias,
      reasons,
      maxBytes: incremental ? largeBytes : Math.min(probe.size, 2_000_000),
      size: probe.size,
      mtimeMs: probe.mtimeMs
    })
  }

  return {
    directoryFileCount: args.paths.length,
    probedCount: probes.filter((p) => p.probedBytes > 0 || p.size <= skipAbove).length,
    skippedProbeCount,
    picks,
    notReplayedCount: Math.max(0, args.paths.length - picks.length),
    note: `按事件覆盖挑选 ${picks.length} 个详细样本，不是按「前 N 个小文件」。目录共 ${args.paths.length} 个文件，未回放 ${Math.max(0, args.paths.length - picks.length)} 个。`
  }
}

function lastMatching(rows: NewPathReplayRow[], pred: (row: NewPathReplayRow) => boolean): NewPathReplayRow | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (pred(rows[i])) return rows[i]
  }
  return undefined
}

function productionHiddenLabel(events: OldPathReplayEvent[]): string {
  const reasons = [...new Set(events.flatMap((e) => e.ignoredByProduction))]
  return reasons.length ? `生产不可见（${reasons.join('/')}）` : '生产不可见'
}

function userImpact(oldVisibleCount: number): string {
  return oldVisibleCount === 0
    ? '否（生产不可见）'
    : '否（对照/诊断不驱动桌宠；旧 onEvent 未改）'
}

function buildComparisons(oldEvents: OldPathReplayEvent[], neu: NewPathReplayRow[], final: CodexDerivedState): ReplayComparisonRow[] {
  const rows: ReplayComparisonRow[] = []
  const oldVisible = oldEvents.filter((e) => e.ignoredByProduction.length === 0)
  const oldKinds = oldEvents.map((e) => e.kind)
  const oldDone = oldEvents.some((e) => e.kind === 'done')
  const oldFailed = oldEvents.some((e) => e.kind === 'failed')
  const oldTextDone = oldEvents.some((e) => e.via === 'response_item.assistant_text' && e.kind === 'done')
  const itemFailed = neu.some((r) => r.cause === 'tool_failed' && r.lifecycle === 'running')
  const completed = neu.some((r) => r.lifecycle === 'completed_signal')
  const cancelled = neu.some((r) => r.lifecycle === 'cancelled')
  const turnFailed = neu.some((r) => r.lifecycle === 'failed' && r.cause === 'turn_failed')
  const turnStarts = neu.filter((r) => r.eventType === 'event_msg.task_started' || r.eventType === 'turn.started').length
  const laterTurnClean = (() => {
    const starts = neu
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.eventType === 'event_msg.task_started' || r.eventType === 'turn.started')
    if (starts.length < 2) return undefined
    const second = starts[1].i
    const after = neu.slice(second, second + 4)
    return after.some((r) => r.item === 'partial_failure') ? 'polluted' : 'isolated'
  })()
  const impact = userImpact(oldVisible.length)
  const workingHidden =
    oldKinds.includes('working') && !oldVisible.some((e) => e.kind === 'working')
      ? productionHiddenLabel(oldEvents.filter((e) => e.kind === 'working'))
      : null

  rows.push({
    phase: 'task_started → running',
    oldResult: oldKinds.includes('working')
      ? workingHidden
        ? `working（${workingHidden}）`
        : 'working（生产可见）'
      : oldEvents.length
        ? '无 working'
        : '旧路径无事件',
    newResult: neu.some((r) => r.lifecycle === 'running') ? 'running' : final.lifecycle,
    verdict: oldKinds.includes('working') && neu.some((r) => r.lifecycle === 'running') ? '一致' : oldEvents.length === 0 ? '无法确认' : '新检测器更精确',
    difference: oldVisible.length === 0 && oldEvents.length > 0 ? '历史事件被 freshness/tail 丢弃；不能当成无事件' : '',
    evidence: `old working=${oldKinds.filter((k) => k === 'working').length}; new running rows=${neu.filter((r) => r.lifecycle === 'running').length}`,
    userImpact: impact
  })

  rows.push({
    phase: '单个 item/tool 失败且 turn 继续',
    oldResult: itemFailed ? (oldFailed && !oldDone ? '可能升格为 failed' : '通常不单独成事件') : '本文件未见 item failed',
    newResult: itemFailed ? 'running + tool_failed' : '本文件未见',
    verdict: itemFailed ? '新检测器更精确' : '样本未覆盖',
    difference: itemFailed ? '旧路径没有 item 维度，不会保持 running+tool_failed' : '',
    evidence: `itemFailedRows=${neu.filter((r) => r.item === 'failed').length}`,
    userImpact: impact
  })

  rows.push({
    phase: 'item 失败后 turn 完成 / task_complete → completed_signal',
    oldResult: oldDone
      ? oldVisible.some((e) => e.kind === 'done')
        ? 'done（生产可见）'
        : `done（${productionHiddenLabel(oldEvents.filter((e) => e.kind === 'done'))}）`
      : '未见 done',
    newResult: itemFailed && completed ? 'completed_signal（不升格 failed）' : completed ? 'completed_signal' : final.lifecycle,
    verdict: itemFailed && completed ? '新检测器更精确' : completed && oldDone ? '一致' : completed || oldDone ? '无法确认' : '样本未覆盖',
    difference: oldDone && completed ? '旧路径 done ≠ 任务语义成功；新路径 completed_signal 同样不声称 succeeded' : '',
    evidence: `oldDone=${oldDone}; newCompleted=${completed}; newSucceeded=${final.lifecycle === 'succeeded'}`,
    userImpact: impact
  })

  rows.push({
    phase: 'turn 明确失败',
    oldResult: oldFailed ? 'failed' : '未见 failed',
    newResult: turnFailed ? 'failed + turn_failed' : '未见 turn.failed',
    verdict: turnFailed ? (oldFailed ? '一致' : '新检测器更精确') : '样本未覆盖',
    difference: '',
    evidence: `turnFailed=${turnFailed}`,
    userImpact: impact
  })

  rows.push({
    phase: '用户取消或中断',
    oldResult: oldEvents.some((e) => e.via === 'event_msg.turn_aborted') ? 'failed/interrupted' : '未见 turn_aborted',
    newResult: cancelled ? 'cancelled' : neu.some((r) => r.eventType === 'event_msg.turn_aborted') ? lastMatching(neu, (r) => r.eventType === 'event_msg.turn_aborted')?.lifecycle ?? 'unknown' : '未见',
    verdict: oldEvents.some((e) => e.via === 'event_msg.turn_aborted')
      ? cancelled
        ? '新检测器更精确'
        : '一致'
      : '样本未覆盖',
    difference: oldEvents.some((e) => e.via === 'event_msg.turn_aborted') && !cancelled ? '旧路径一律 failed；新路径无明确用户取消词则 unknown' : '',
    evidence: `abortRows=${neu.filter((r) => r.eventType === 'event_msg.turn_aborted').length}`,
    userImpact: impact
  })

  rows.push({
    phase: '只有 error、没有 turn 终态',
    oldResult: '旧路径不识别官方 error 事件',
    newResult: neu.some((r) => r.eventType === 'error') ? (completed || turnFailed ? '随后有终态' : 'unknown，不升格 failed') : '未见官方 error',
    verdict: neu.some((r) => r.eventType === 'error') ? '新检测器更精确' : '样本未覆盖',
    difference: '',
    evidence: `errorRows=${neu.filter((r) => r.eventType === 'error').length}`,
    userImpact: impact
  })

  rows.push({
    phase: '跨 turn item 失败隔离',
    oldResult: turnStarts >= 2 ? '无 item 状态，无法表达污染' : '少于两个 turn 开始',
    newResult: laterTurnClean === 'isolated' ? '后一轮未继承 partial_failure' : laterTurnClean === 'polluted' ? '后一轮仍是 partial_failure' : '不足两个 turn',
    verdict: laterTurnClean === 'isolated' ? '一致' : laterTurnClean === 'polluted' ? '新检测器误判候选' : '样本未覆盖',
    difference: '',
    evidence: `task/turn starts=${turnStarts}`,
    userImpact: impact
  })

  rows.push({
    phase: '旧路径文本完成 vs 新路径信号',
    oldResult: oldTextDone ? 'assistant 文本被判 done' : '未见文本 done',
    newResult: final.taskSemantics,
    verdict: oldTextDone ? '旧路径误判候选' : '样本未覆盖',
    difference: oldTextDone ? '不得把最终回答正文当成任务成功；新路径 taskSemantics=not_verified' : '',
    evidence: `assistantTextDone=${oldTextDone}; taskSemantics=${final.taskSemantics}`,
    userImpact: impact
  })

  rows.push({
    phase: '生产 Monitor 能否看到本文件',
    oldResult: oldVisible.length
      ? `生产可见 ${oldVisible.length} 条`
      : oldEvents.length
        ? `识别 ${oldEvents.length} 条，全部为${productionHiddenLabel(oldEvents)}，不能当成无事件`
        : '旧路径无识别事件',
    newResult: '从文件头完整（或截断上限内）回放，仍能看到历史事件',
    verdict: oldVisible.length === 0 && oldEvents.length > 0 ? '新检测器更精确' : oldVisible.length > 0 ? '一致' : '无法确认',
    difference: explainOldPathOfflineLimits().join('; '),
    evidence: `oldVisible=${oldVisible.length}/${oldEvents.length}`,
    userImpact: impact
  })

  rows.push({
    phase: '冲突时是否强行成功/失败',
    oldResult: '旧路径只有单一 kind',
    newResult: final.conflicts.length
      ? `保留 ${final.conflicts.length} 条 conflict/evidence，lifecycle=${final.lifecycle}`
      : `无 conflict；lifecycle=${final.lifecycle}（不是 succeeded）`,
    verdict: final.lifecycle === 'succeeded' ? '新检测器误判候选' : '一致',
    difference: final.conflicts.length ? '冲突保留证据，不映射 working/done/failed' : '',
    evidence: `conflicts=${final.conflicts.length}; lifecycle=${final.lifecycle}`,
    userImpact: '否（影子不进桌宠）'
  })

  return rows
}

export function replayCodexSessionFile(
  filePath: string,
  alias: string,
  options: CodexReplayOptions = {}
): SessionReplayResult {
  let size = 0
  let mtimeMs = 0
  try {
    const st = statSync(filePath)
    size = st.size
    mtimeMs = st.mtimeMs
  } catch {
    /* keep zeros */
  }
  const oldEvents = replayOldPathFile(filePath, options)
  const neu = replayNewPathFile(filePath, options)
  const counts = countBy(neu.rows)
  const redactedFinal = {
    ...neu.state,
    sessionId: redactId(neu.state.sessionId, 'sess'),
    threadId: redactId(neu.state.threadId, 'th'),
    turnId: redactId(neu.state.turnId, 'turn'),
    evidence: [],
    conflicts: neu.state.conflicts.map((c) => ({ ...c, reason: c.reason.slice(0, 80) }))
  }
  return {
    alias,
    size,
    mtimeMs,
    replayedBytes: neu.replayedBytes,
    truncated: neu.truncated,
    hasSessionId: Boolean(neu.state.sessionId),
    hasThreadId: Boolean(neu.state.threadId),
    hasTurnId: Boolean(neu.state.turnId),
    eventTypeCounts: counts,
    unknownCount: counts.unknown ?? 0,
    malformedCount: counts.malformed ?? 0,
    unsupportedCount: counts.unsupported ?? 0,
    itemFailedCount: neu.rows.filter((r) => r.item === 'failed').length,
    turnStartedCount: (counts['event_msg.task_started'] ?? 0) + (counts['turn.started'] ?? 0),
    turnCompletedCount: (counts['event_msg.task_complete'] ?? 0) + (counts['turn.completed'] ?? 0),
    turnFailedCount: counts['turn.failed'] ?? 0,
    abortCount: counts['event_msg.turn_aborted'] ?? 0,
    officialStructuredCount:
      (counts['thread.started'] ?? 0) +
      (counts['turn.started'] ?? 0) +
      (counts['turn.completed'] ?? 0) +
      (counts['turn.failed'] ?? 0) +
      (counts['turn.cancelled'] ?? 0) +
      (counts['item.started'] ?? 0) +
      (counts['item.updated'] ?? 0) +
      (counts['item.completed'] ?? 0) +
      (counts['error'] ?? 0),
    oldEvents,
    newFinal: redactedFinal,
    newRows: neu.rows,
    comparisons: buildComparisons(oldEvents, neu.rows, neu.state),
    selectionReasons: options.selectionReasons
  }
}

export function aggregateEventTypes(results: SessionReplayResult[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const result of results) {
    for (const [type, n] of Object.entries(result.eventTypeCounts)) {
      out[type] = (out[type] ?? 0) + n
    }
  }
  return out
}

/** 把 alias 映射回真实路径。仅在本机回放时使用，报告里不得打印返回值。 */
export function listCodexSessionPaths(root = codexSessionsRoot(), maxDepth = 8): string[] {
  return findRecentFiles(root, ['.jsonl'], 100_000, maxDepth)
}

export const CODEX_REPLAY_OFFICIAL_TYPES = [
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'item.started',
  'item.updated',
  'item.completed',
  'error'
] as const
