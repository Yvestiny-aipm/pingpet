import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentEnv, AgentEventKind, AgentSource, CodexDerivedState, CodexStateMigration } from '@shared/types'
import {
  mapCodexDerivedToCandidate,
  summarizeDerivedForCandidate,
  type CodexCandidateState
} from './codexCandidate'

/**
 * Codex 双轨诊断输出（旧 Monitor 事件 + 影子 DerivedState）。
 * 只写本地 userData/diagnostics，不触发 onEvent / 桌宠 / 气泡 / 声音，不发网络。
 *
 * 方案 A：只把 source=codex 的旧事件写入 codex-legacy.jsonl。
 * Claude / Cursor / Grok 不得混入，避免被当成 Codex 样本。不改变其他 Agent 的 onEvent。
 *
 * 最小防护（不是完整日志平台）：
 * - 同步 append，失败静默，不影响 Monitor；
 * - 单条 reason 截断；
 * - 单文件软上限 8MB，超出后停写，不轮转、不删除；
 * - 进程内按 observationId 去重；重启后内存去重丢失，可能重复写同一观察；
 * - 本轮暂不轮转：这是对照诊断，不是日志平台。
 */

export const CODEX_SHADOW_DIAGNOSTIC_KIND = 'codex_shadow_diagnostic'
export const CODEX_LEGACY_DIAGNOSTIC_KIND = 'codex_legacy_diagnostic'
export const CODEX_CANDIDATE_DIAGNOSTIC_KIND = 'codex_candidate_diagnostic'
export const CODEX_ATTENTION_SOUND_DIAGNOSTIC_KIND = 'codex_attention_sound_diagnostic'

/** 单文件软上限：超过后停止追加，避免 item 事件把磁盘写满。 */
export const CODEX_DIAGNOSTIC_MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_REASON_CHARS = 200

export type DualTrackSource = 'legacy_monitor' | 'codex_shadow'
export type LegacyIgnoreReason = 'prime' | 'freshness' | 'env' | 'dedup' | 'no_working' | 'outside_tail'

export interface CodexShadowDiagnosticMeta {
  observationId?: string
  seq?: number
  fileAlias?: string
  ignoredBy?: string[]
}

export interface CodexLegacyDiagnosticDraft {
  observationId: string
  seq: number
  /** PingPet 读取和处理该事件的时间 */
  observedAt: number
  /** 旧路径事件自身时间（timestampMs）；不是 observedAt */
  eventTime: number
  source: AgentSource
  env: AgentEnv
  legacyKind: AgentEventKind
  rawPath?: string
  sessionKey: string
  dispatched: boolean
  ignoredBy: string[]
  productionVisible: boolean
}

export interface CodexShadowDiagnosticRecord {
  kind: typeof CODEX_SHADOW_DIAGNOSTIC_KIND
  userVisible: false
  track: 'codex_shadow'
  note: string
  observationId?: string
  seq?: number
  fileAlias?: string
  sessionId?: string
  /** 原始事件提供则脱敏记录；缺失为 unknown，不得猜造 */
  threadId: string
  /** 原始事件提供则脱敏记录；缺失为 unknown，不得猜造 */
  turnId: string
  lifecycle: CodexDerivedState['lifecycle']
  cause: CodexDerivedState['cause']
  process: CodexDerivedState['process']
  connection: CodexDerivedState['connection']
  item: CodexDerivedState['item']
  outputIntegrity: CodexDerivedState['outputIntegrity']
  confidence: CodexDerivedState['confidence']
  source?: CodexStateMigration['source']
  reason?: string
  /** PingPet 读取和处理该事件的时间 */
  observedAt: number
  /** 原始 Codex 事件时间；未知则为 null，不得用 observedAt 填入 */
  eventTime: number | null
  /** 检测器应用该事件的时间（PingPet）；未知则为 null */
  migrationObservedAt: number | null
  ignoredBy: string[]
  productionVisible: false
}

export interface CodexLegacyDiagnosticRecord {
  kind: typeof CODEX_LEGACY_DIAGNOSTIC_KIND
  userVisible: false
  track: 'legacy_monitor'
  note: string
  observationId: string
  seq: number
  fileAlias?: string
  /** session 级关联；旧路径没有稳定 threadId / turnId */
  sessionKey?: string
  /** 旧路径未提供；保留 unknown，不得从 sessionKey/文件名/时间戳猜造 */
  threadId: 'unknown'
  /** 旧路径未提供；保留 unknown，不得从 sessionKey/文件名/时间戳猜造 */
  turnId: 'unknown'
  /** 当前在线双轨最多 session 级对照 */
  correlationLevel: 'session'
  source: AgentSource
  env: AgentEnv
  legacyKind: AgentEventKind
  /** PingPet 读取和处理该事件的时间 */
  observedAt: number
  /** 旧路径事件自身时间；不是 observedAt */
  eventTime: number
  dispatched: boolean
  ignoredBy: string[]
  productionVisible: boolean
}

const writtenKeys = new Set<string>()

function hash8(value: string): string {
  let h = 5381
  for (let i = 0; i < value.length; i += 1) h = (h * 33) ^ value.charCodeAt(i)
  return (h >>> 0).toString(36).padStart(8, '0').slice(0, 8)
}

export function redactDiagnosticId(value: string | undefined, prefix: string): string | undefined {
  if (!value) return undefined
  return `${prefix}-${hash8(value)}`
}

function basenameSafe(rawPath?: string): string | undefined {
  if (!rawPath) return undefined
  const parts = rawPath.split(/[/\\]/)
  return parts[parts.length - 1] || undefined
}

function safeReason(reason?: string): string | undefined {
  if (!reason) return undefined
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason
}

function canAppend(filePath: string): boolean {
  try {
    return statSync(filePath).size < CODEX_DIAGNOSTIC_MAX_FILE_BYTES
  } catch {
    return true
  }
}

function appendLine(filePath: string, dedupKey: string, line: string): void {
  const key = `${filePath}\0${dedupKey}`
  if (writtenKeys.has(key)) return
  if (!canAppend(filePath)) return
  mkdirSync(dirname(filePath), { recursive: true })
  appendFileSync(filePath, `${line}\n`)
  writtenKeys.add(key)
}

export function formatCodexShadowDiagnostic(
  state: CodexDerivedState,
  migration?: CodexStateMigration,
  meta?: CodexShadowDiagnosticMeta
): CodexShadowDiagnosticRecord {
  return {
    kind: CODEX_SHADOW_DIAGNOSTIC_KIND,
    userVisible: false,
    track: 'codex_shadow',
    note: 'shadow state only; not a user-visible pet/bubble/sound event',
    observationId: meta?.observationId,
    seq: meta?.seq,
    fileAlias: meta?.fileAlias,
    sessionId: redactDiagnosticId(state.sessionId, 'sess'),
    threadId: redactDiagnosticId(state.threadId, 'th') ?? 'unknown',
    turnId: redactDiagnosticId(state.turnId, 'turn') ?? 'unknown',
    lifecycle: state.lifecycle,
    cause: state.cause,
    process: state.process,
    connection: state.connection,
    item: state.item,
    outputIntegrity: state.outputIntegrity,
    confidence: state.confidence,
    source: migration?.source,
    reason: safeReason(migration?.reason),
    observedAt: state.observedAt,
    eventTime: migration?.eventTime ?? null,
    migrationObservedAt: migration?.observedAt ?? null,
    ignoredBy: meta?.ignoredBy ?? [],
    productionVisible: false
  }
}

export type CodexCandidateObservationSource = 'exec_json' | 'session_jsonl' | 'unknown'

export interface CodexCandidateDiagnosticRecord {
  kind: typeof CODEX_CANDIDATE_DIAGNOSTIC_KIND
  userVisible: false
  track: 'codex_candidate'
  note: string
  observationId?: string
  seq?: number
  fileAlias?: string
  sessionId?: string
  threadId: string
  turnId: string
  derived: ReturnType<typeof summarizeDerivedForCandidate>
  candidate: CodexCandidateState['candidate']
  legacyEquivalent: CodexCandidateState['legacyEquivalent']
  candidatePetState: CodexCandidateState['candidatePetState']
  notificationCandidate: CodexCandidateState['notificationCandidate']
  shouldNotify: false
  requiresUserAction: boolean
  retryRecommendation: CodexCandidateState['retryRecommendation']
  reasonCodes: string[]
  confidence: CodexCandidateState['confidence']
  observedAt: number
  eventTime: number | null
  migrationObservedAt: number | null
  source?: CodexStateMigration['source']
  observationSource: CodexCandidateObservationSource
  productionVisible: false
}

function observationSourceOf(
  state: CodexDerivedState,
  migration?: CodexStateMigration
): CodexCandidateObservationSource {
  if (migration?.source === 'exec_json' || migration?.source === 'session_jsonl') return migration.source
  const ev = state.evidence[0]
  if (ev?.source === 'exec_json' || ev?.source === 'session_jsonl') return ev.source
  return 'unknown'
}

export function formatCodexCandidateDiagnostic(
  state: CodexDerivedState,
  migration?: CodexStateMigration,
  meta?: CodexShadowDiagnosticMeta
): CodexCandidateDiagnosticRecord {
  const candidate = mapCodexDerivedToCandidate(state)
  return {
    kind: CODEX_CANDIDATE_DIAGNOSTIC_KIND,
    userVisible: false,
    track: 'codex_candidate',
    note: 'candidate user-state shadow only; not a pet/bubble/sound/monitor event',
    observationId: meta?.observationId,
    seq: meta?.seq,
    fileAlias: meta?.fileAlias,
    sessionId: redactDiagnosticId(state.sessionId, 'sess'),
    threadId: redactDiagnosticId(state.threadId, 'th') ?? 'unknown',
    turnId: redactDiagnosticId(state.turnId, 'turn') ?? 'unknown',
    derived: summarizeDerivedForCandidate(state),
    candidate: candidate.candidate,
    legacyEquivalent: candidate.legacyEquivalent,
    candidatePetState: candidate.candidatePetState,
    notificationCandidate: candidate.notificationCandidate,
    shouldNotify: false,
    requiresUserAction: candidate.requiresUserAction,
    retryRecommendation: candidate.retryRecommendation,
    reasonCodes: candidate.reasonCodes,
    confidence: candidate.confidence,
    observedAt: state.observedAt,
    eventTime: migration?.eventTime ?? null,
    migrationObservedAt: migration?.observedAt ?? null,
    source: migration?.source,
    observationSource: observationSourceOf(state, migration),
    productionVisible: false
  }
}

export function formatCodexShadowDiagnosticLine(
  state: CodexDerivedState,
  migration?: CodexStateMigration,
  meta?: CodexShadowDiagnosticMeta
): string {
  return JSON.stringify(formatCodexShadowDiagnostic(state, migration, meta))
}

export function formatCodexLegacyDiagnostic(draft: CodexLegacyDiagnosticDraft): CodexLegacyDiagnosticRecord {
  const fileName = basenameSafe(draft.rawPath) ?? draft.sessionKey
  return {
    kind: CODEX_LEGACY_DIAGNOSTIC_KIND,
    userVisible: false,
    track: 'legacy_monitor',
    note: 'legacy monitor event copy; not a pet/bubble/sound trigger',
    observationId: draft.observationId,
    seq: draft.seq,
    fileAlias: redactDiagnosticId(fileName, 'file'),
    sessionKey: redactDiagnosticId(draft.sessionKey, 'sess'),
    threadId: 'unknown',
    turnId: 'unknown',
    correlationLevel: 'session',
    source: draft.source,
    env: draft.env,
    legacyKind: draft.legacyKind,
    observedAt: draft.observedAt,
    eventTime: draft.eventTime,
    dispatched: draft.dispatched,
    ignoredBy: draft.ignoredBy,
    productionVisible: draft.productionVisible
  }
}

export function codexShadowDiagnosticPath(userDataDir: string): string {
  return join(userDataDir, 'diagnostics', 'codex-shadow.jsonl')
}

export function codexLegacyDiagnosticPath(userDataDir: string): string {
  return join(userDataDir, 'diagnostics', 'codex-legacy.jsonl')
}

export function codexCandidateDiagnosticPath(userDataDir: string): string {
  return join(userDataDir, 'diagnostics', 'codex-candidate.jsonl')
}

export function codexAttentionSoundDiagnosticPath(userDataDir: string): string {
  return join(userDataDir, 'diagnostics', 'codex-attention-sound.jsonl')
}

export interface CodexAttentionSoundDiagnosticDraft {
  reason: string
  playSound: boolean
  soundType?: 'attention'
  shouldNotify: false
  candidate?: string
  fileAlias?: string
  observationId?: string
}

/** 独立 attention 音诊断。失败静默，不得回退 playDing，不得影响气泡/姿态。 */
export function appendCodexAttentionSoundDiagnostic(
  draft: CodexAttentionSoundDiagnosticDraft,
  filePath: string
): void {
  try {
    const rec = {
      kind: CODEX_ATTENTION_SOUND_DIAGNOSTIC_KIND,
      userVisible: false as const,
      track: 'codex_attention_sound',
      note: 'independent attention sound only; never playDing',
      playSound: draft.playSound,
      soundType: draft.soundType,
      shouldNotify: false as const,
      candidate: draft.candidate,
      fileAlias: draft.fileAlias,
      observationId: draft.observationId,
      reason: safeReason(draft.reason),
      productionVisible: false as const
    }
    const dedup = draft.observationId ?? `${draft.fileAlias ?? ''}:${draft.reason}:${draft.playSound}`
    appendLine(filePath, `attention-sound:${dedup}`, JSON.stringify(rec))
  } catch {
    /* 声音诊断失败不得影响气泡 / 桌宠 / playDing */
  }
}

/** 追加一条影子诊断。失败静默吞掉，不得影响 Monitor / 桌宠。 */
export function appendCodexShadowDiagnostic(
  state: CodexDerivedState,
  migration: CodexStateMigration | undefined,
  filePath: string,
  meta?: CodexShadowDiagnosticMeta
): void {
  try {
    const rec = formatCodexShadowDiagnostic(state, migration, meta)
    const dedup = rec.observationId ?? `${rec.fileAlias ?? ''}:${rec.lifecycle}:${rec.reason ?? ''}:${rec.observedAt}`
    appendLine(filePath, `shadow:${dedup}`, JSON.stringify(rec))
  } catch {
    /* 诊断失败不得影响 Monitor / 桌宠 */
  }
}

/** 追加一条候选用户状态诊断。失败静默，不得影响 detector / Monitor / 桌宠。 */
export function appendCodexCandidateDiagnostic(
  state: CodexDerivedState,
  migration: CodexStateMigration | undefined,
  filePath: string,
  meta?: CodexShadowDiagnosticMeta
): void {
  try {
    const rec = formatCodexCandidateDiagnostic(state, migration, meta)
    const dedup = rec.observationId ?? `${rec.fileAlias ?? ''}:${rec.candidate}:${rec.observedAt}`
    appendLine(filePath, `candidate:${dedup}`, JSON.stringify(rec))
  } catch {
    /* 候选诊断失败不得影响 Monitor / 桌宠 / 旧 onEvent */
  }
}

/** 追加一条旧路径诊断。失败静默，且不得进入桌宠路径。非 Codex 事件直接丢弃。 */
export function appendCodexLegacyDiagnostic(draft: CodexLegacyDiagnosticDraft, filePath: string): void {
  try {
    if (draft.source !== 'codex') return
    const rec = formatCodexLegacyDiagnostic(draft)
    appendLine(filePath, `legacy:${rec.observationId}`, JSON.stringify(rec))
  } catch {
    /* 诊断失败不得影响 Monitor / 桌宠 */
  }
}

/** 测试用：清空进程内去重。生产 Monitor 重启不调用。 */
export function resetCodexDiagnosticDedupForTests(): void {
  writtenKeys.clear()
}
