import { createHash } from 'node:crypto'
import { acceptIdentityRef } from '@shared/agentObservation'
import type {
  AgentCause,
  AgentConfidence,
  AgentConnection,
  AgentDerivedState,
  AgentLifecycle,
  AgentObservation,
  AgentProcess,
  AgentRecognition,
  GenericAgentId,
  IdentityRefSource
} from '@shared/agentObservation'
import type { AgentEventKind, AgentStopReason } from '@shared/types'

/**
 * 新旧路径只读对照（阶段 4）。
 *
 * 只比较已经产生的旧 Monitor 记录和已经产生的通用投影。
 * 不读用户目录、不派发事件、不写诊断、不触发 Monitor / 桌宠 / 气泡 / 声音、不改状态。
 */

export const UNMATCHED_CORRELATION = 'UNMATCHED_CORRELATION' as const

export type ShadowEvidenceGrade =
  | 'REAL_CODEX'
  | 'REAL_CURSOR'
  | 'FIXTURE_ONLY'
  | 'CODE_INFERENCE'
  | 'SAMPLE_NOT_COVERED'
  | typeof UNMATCHED_CORRELATION

export type ShadowDiffClass =
  | 'CONSISTENT'
  | 'GENERIC_MORE_CONSERVATIVE'
  | 'LEGACY_COMPATIBILITY'
  | 'GENERIC_MORE_INFORMATIVE'
  | 'POTENTIAL_BUG'
  | 'SAMPLE_NOT_COVERED'
  | typeof UNMATCHED_CORRELATION

export type ShadowCorrelationLevel = 'file' | 'session' | 'thread' | 'turn' | 'item' | 'dedup' | 'unmatched'

export interface ShadowIdentityFields {
  agentId: GenericAgentId
  fileIdentity?: string
  sessionRef?: string
  sessionRefSource?: IdentityRefSource
  threadRef?: string
  threadRefSource?: IdentityRefSource
  turnRef?: string
  turnRefSource?: IdentityRefSource
  itemRef?: string
  itemRefSource?: IdentityRefSource
  dedupKey?: string
}

export interface LegacyShadowRecord extends ShadowIdentityFields {
  source: string
  kind: AgentEventKind
  reason?: AgentStopReason
  observationId?: string
  observedAt: number
  eventTime?: number
  primed?: boolean
  userVisible?: boolean
}

export interface GenericShadowRecord extends ShadowIdentityFields {
  source: string
  adapterId?: string
  observation?: Pick<
    AgentObservation,
    'eventName' | 'confidence' | 'recognition' | 'evidenceOrigin' | 'observedAt' | 'eventTime'
  >
  derived?: Pick<
    AgentDerivedState,
    | 'lifecycle'
    | 'cause'
    | 'connection'
    | 'process'
    | 'session'
    | 'turn'
    | 'item'
    | 'outputIntegrity'
    | 'taskSemantics'
    | 'retryability'
    | 'conflicts'
    | 'observedAt'
    | 'extension'
  >
  candidate?: string
  observationId?: string
  observedAt: number
  eventTime?: number
  primed?: boolean
  userCancelled?: boolean
  textHint?: string
}

export interface ShadowPairInput {
  legacy: LegacyShadowRecord
  generic: GenericShadowRecord
  evidenceGrade: ShadowEvidenceGrade
  compareAt?: ShadowCorrelationLevel
}

export interface ShadowComparisonRow {
  agentId: GenericAgentId
  source: string
  fileAlias?: string
  correlationKey: string
  sessionCorrelationLevel: ShadowCorrelationLevel
  turnCorrelationLevel: ShadowCorrelationLevel
  itemCorrelationLevel: ShadowCorrelationLevel
  maxCorrelationLevel: ShadowCorrelationLevel
  legacyKind: AgentEventKind
  legacyReason?: AgentStopReason
  observationEventName?: string
  observationConfidence?: AgentConfidence
  observationRecognition?: AgentRecognition
  derivedLifecycle?: AgentLifecycle | 'unknown' | 'unsupported'
  derivedCause?: AgentCause | 'unknown' | 'unsupported'
  derivedConnection?: AgentConnection | 'unknown' | 'unsupported'
  derivedProcess?: AgentProcess | 'unknown' | 'unsupported'
  derivedTurn?: string
  derivedItem?: string
  derivedOutputIntegrity?: string
  derivedTaskSemantics?: string
  candidate?: string
  evidenceGrade: ShadowEvidenceGrade
  diffClass: ShadowDiffClass
  userVisible: boolean
  duplicateObservationId: boolean
  primeReplay: boolean
  hasConflicts: boolean
  reason: string
  observedAt: number
  eventTime?: number
  canConcludeTaskSemantics: false
}

export interface ShadowComparisonBatch {
  rows: ShadowComparisonRow[]
  unmatched: Array<{ side: 'legacy' | 'generic'; agentId: GenericAgentId; source: string }>
  duplicateObservationIds: string[]
  counts: Record<ShadowDiffClass, number>
  evidenceCounts: Record<string, number>
  correlationCapability: {
    file: boolean
    session: boolean
    turn: boolean
    item: boolean
  }
}

const SENSITIVE =
  /prompt|assistant text|command|token|secret|password|authorization|api[_-]?key|\/Users\/|\/home\/|\\\\Users\\\\/i

function payloadRef(raw: string | undefined, source: IdentityRefSource | undefined): string | undefined {
  return acceptIdentityRef(raw, source ?? 'filename')
}

function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || value.includes('Users') || value.includes('home')
}

export function redactIdentity(raw: string | undefined, prefix: string): string | undefined {
  if (!raw || !raw.trim()) return undefined
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 10)
  return `${prefix}-${digest}`
}

export function safeFileAlias(raw: string | undefined): string | undefined {
  if (!raw || !raw.trim()) return undefined
  if (looksLikePath(raw)) return redactIdentity(raw, 'file')
  return raw
}

export function reportContainsSensitiveText(text: string): boolean {
  return SENSITIVE.test(text)
}

function dimLabel<T extends string>(dimension: { presence: string; value?: T } | undefined): T | 'unknown' | 'unsupported' | undefined {
  if (!dimension) return undefined
  if (dimension.presence === 'unsupported') return 'unsupported'
  if (dimension.presence === 'unknown') return 'unknown'
  return dimension.value
}

export function correlationOf(
  left: ShadowIdentityFields,
  right: ShadowIdentityFields
): { level: ShadowCorrelationLevel; key: string } {
  if (left.agentId !== right.agentId) {
    return { level: 'unmatched', key: UNMATCHED_CORRELATION }
  }

  const leftFile = safeFileAlias(left.fileIdentity)
  const rightFile = safeFileAlias(right.fileIdentity)
  if (leftFile && rightFile && leftFile === rightFile) {
    return { level: 'file', key: `file:${leftFile}` }
  }

  const leftSession = payloadRef(left.sessionRef, left.sessionRefSource)
  const rightSession = payloadRef(right.sessionRef, right.sessionRefSource)
  if (leftSession && rightSession && leftSession === rightSession) {
    return { level: 'session', key: `session:${leftSession}` }
  }

  const leftThread = payloadRef(left.threadRef, left.threadRefSource)
  const rightThread = payloadRef(right.threadRef, right.threadRefSource)
  if (leftThread && rightThread && leftThread === rightThread) {
    return { level: 'thread', key: `thread:${leftThread}` }
  }

  const leftTurn = payloadRef(left.turnRef, left.turnRefSource)
  const rightTurn = payloadRef(right.turnRef, right.turnRefSource)
  if (leftTurn && rightTurn && leftTurn === rightTurn) {
    return { level: 'turn', key: `turn:${leftTurn}` }
  }

  const leftItem = payloadRef(left.itemRef, left.itemRefSource)
  const rightItem = payloadRef(right.itemRef, right.itemRefSource)
  if (leftItem && rightItem && leftItem === rightItem) {
    return { level: 'item', key: `item:${leftItem}` }
  }

  if (left.dedupKey && right.dedupKey && left.dedupKey === right.dedupKey) {
    return { level: 'dedup', key: `dedup:${left.dedupKey}` }
  }

  return { level: 'unmatched', key: UNMATCHED_CORRELATION }
}

function levelOf(
  left: ShadowIdentityFields,
  right: ShadowIdentityFields,
  kind: 'session' | 'turn' | 'item'
): ShadowCorrelationLevel {
  const leftRef =
    kind === 'session'
      ? payloadRef(left.sessionRef, left.sessionRefSource)
      : kind === 'turn'
        ? payloadRef(left.turnRef, left.turnRefSource)
        : payloadRef(left.itemRef, left.itemRefSource)
  const rightRef =
    kind === 'session'
      ? payloadRef(right.sessionRef, right.sessionRefSource)
      : kind === 'turn'
        ? payloadRef(right.turnRef, right.turnRefSource)
        : payloadRef(right.itemRef, right.itemRefSource)
  if (!leftRef || !rightRef) return 'unmatched'
  return leftRef === rightRef ? kind : 'unmatched'
}

export function classifyShadowDiff(input: {
  agentId: GenericAgentId
  legacyKind: AgentEventKind
  legacyReason?: AgentStopReason
  lifecycle?: AgentLifecycle | 'unknown' | 'unsupported'
  cause?: AgentCause | 'unknown' | 'unsupported'
  connection?: AgentConnection | 'unknown' | 'unsupported'
  process?: AgentProcess | 'unknown' | 'unsupported'
  item?: string
  outputIntegrity?: string
  taskSemantics?: string
  candidate?: string
  userCancelled?: boolean
  confidence?: AgentConfidence
  evidenceGrade: ShadowEvidenceGrade
  correlationLevel: ShadowCorrelationLevel
  compareAt?: ShadowCorrelationLevel
}): { diffClass: ShadowDiffClass; reason: string } {
  if (input.evidenceGrade === 'SAMPLE_NOT_COVERED') {
    return { diffClass: 'SAMPLE_NOT_COVERED', reason: '样本未覆盖，不能判断' }
  }
  if (input.correlationLevel === 'unmatched') {
    return { diffClass: UNMATCHED_CORRELATION, reason: '没有稳定关联键，不能比较' }
  }
  if (input.compareAt === 'turn' && input.correlationLevel !== 'turn' && input.correlationLevel !== 'item') {
    return { diffClass: UNMATCHED_CORRELATION, reason: '缺少稳定 turnRef，不能做 turn 级比较' }
  }

  const lifecycle = input.lifecycle
  const cause = input.cause
  const staleOnly = input.connection === 'stale'

  if (lifecycle === 'cancelled' && input.userCancelled !== true && input.legacyReason !== undefined) {
    return { diffClass: 'POTENTIAL_BUG', reason: '普通中断被写成 user cancellation' }
  }
  if (cause === 'process_exit' && (input.process === 'unsupported' || input.process === 'not_observed' || !input.process)) {
    return { diffClass: 'POTENTIAL_BUG', reason: 'process 未观察却写成 process_exit' }
  }
  if (staleOnly && lifecycle === 'failed' && cause !== 'turn_failed') {
    return { diffClass: 'POTENTIAL_BUG', reason: 'stale 被写成 Agent failed' }
  }
  if (lifecycle === ('succeeded' as AgentLifecycle)) {
    return { diffClass: 'POTENTIAL_BUG', reason: '通用层出现禁止的 succeeded' }
  }

  if (input.legacyKind === 'working' && lifecycle === 'running') {
    if (staleOnly) {
      return { diffClass: 'CONSISTENT', reason: '旧 working 对应 running；stale 只影响 connection' }
    }
    return { diffClass: 'CONSISTENT', reason: '旧 working 对应通用 running' }
  }

  if (input.legacyKind === 'done' && lifecycle === 'completed_signal') {
    const partial =
      input.candidate === 'completed_with_partial_failure' ||
      cause === 'tool_failed' ||
      input.item === 'partial_failure' ||
      input.item === 'failed' ||
      input.outputIntegrity === 'partial'
    if (partial) {
      return {
        diffClass: 'GENERIC_MORE_INFORMATIVE',
        reason: '旧路径 done，通用层 completed_signal 并保留 tool/item 失败；done/completed_signal 不等于任务成功'
      }
    }
    if (input.agentId === 'cursor' && input.confidence === 'low') {
      return {
        diffClass: 'GENERIC_MORE_CONSERVATIVE',
        reason: '旧路径 done，文本 success 只映射 completed_signal 且 confidence=low；不等于任务成功'
      }
    }
    if (input.agentId === 'cursor') {
      return {
        diffClass: 'LEGACY_COMPATIBILITY',
        reason: '旧 Cursor done 仍会完成展示；通用层 completed_signal 未验证任务成功'
      }
    }
    return {
      diffClass: 'CONSISTENT',
      reason: '旧 done 对应 completed_signal；不等于任务成功'
    }
  }

  if (input.legacyKind === 'failed' && (lifecycle === 'unknown' || lifecycle === 'running')) {
    if (cause === 'user_cancelled') {
      return { diffClass: 'POTENTIAL_BUG', reason: '普通 abort 被写成 user_cancelled' }
    }
    return {
      diffClass: 'GENERIC_MORE_CONSERVATIVE',
      reason: '旧路径 failed，通用层保持 unknown/running；这不是已确认的用户取消'
    }
  }

  if (input.legacyKind === 'failed' && lifecycle === 'cancelled' && input.userCancelled === true) {
    return {
      diffClass: 'GENERIC_MORE_INFORMATIVE',
      reason: '旧路径 failed，通用层单独标出 user_cancelled'
    }
  }

  if (input.legacyKind === 'failed' && lifecycle === 'failed' && cause === 'turn_failed') {
    if (input.evidenceGrade === 'FIXTURE_ONLY') {
      return { diffClass: 'CONSISTENT', reason: 'fixture 中 turn-level failed 双方一致；不得写成真实协议结论' }
    }
    return { diffClass: 'CONSISTENT', reason: '双方均为 turn-level failed' }
  }

  if (input.legacyKind === 'needs_attention' && lifecycle === 'completed_signal') {
    return {
      diffClass: 'LEGACY_COMPATIBILITY',
      reason: '旧路径用文本改判 needs_attention；通用层仍是 completed_signal'
    }
  }

  if (cause && cause !== 'unknown' && cause !== 'unsupported') {
    return {
      diffClass: 'GENERIC_MORE_INFORMATIVE',
      reason: '通用层保留了旧路径没有的 cause/item 等维度'
    }
  }

  return { diffClass: 'SAMPLE_NOT_COVERED', reason: '已关联，但当前形状不足以判断' }
}

export function compareShadowPair(input: ShadowPairInput, extras?: { duplicateObservationId?: boolean }): ShadowComparisonRow {
  const { legacy, generic, evidenceGrade, compareAt } = input
  const correlation = correlationOf(legacy, generic)
  const sessionLevel = levelOf(legacy, generic, 'session')
  const turnLevel = levelOf(legacy, generic, 'turn')
  const itemLevel = levelOf(legacy, generic, 'item')
  const derived = generic.derived
  const lifecycle = dimLabel(derived?.lifecycle)
  const cause = dimLabel(derived?.cause)
  const classified = classifyShadowDiff({
    agentId: legacy.agentId,
    legacyKind: legacy.kind,
    legacyReason: legacy.reason,
    lifecycle,
    cause,
    connection: dimLabel(derived?.connection),
    process: dimLabel(derived?.process),
    item: dimLabel(derived?.item),
    outputIntegrity: dimLabel(derived?.outputIntegrity),
    taskSemantics: dimLabel(derived?.taskSemantics),
    candidate: generic.candidate,
    userCancelled: generic.userCancelled,
    confidence: generic.observation?.confidence,
    evidenceGrade,
    correlationLevel: correlation.level,
    compareAt
  })

  const primed = Boolean(legacy.primed || generic.primed)

  return {
    agentId: legacy.agentId,
    source: legacy.source,
    fileAlias: safeFileAlias(legacy.fileIdentity) ?? safeFileAlias(generic.fileIdentity),
    correlationKey: correlation.key,
    sessionCorrelationLevel: sessionLevel,
    turnCorrelationLevel: turnLevel,
    itemCorrelationLevel: itemLevel,
    maxCorrelationLevel: correlation.level,
    legacyKind: legacy.kind,
    legacyReason: legacy.reason,
    observationEventName: generic.observation?.eventName,
    observationConfidence: generic.observation?.confidence,
    observationRecognition: generic.observation?.recognition,
    derivedLifecycle: lifecycle,
    derivedCause: cause,
    derivedConnection: dimLabel(derived?.connection),
    derivedProcess: dimLabel(derived?.process),
    derivedTurn: dimLabel(derived?.turn),
    derivedItem: dimLabel(derived?.item),
    derivedOutputIntegrity: dimLabel(derived?.outputIntegrity),
    derivedTaskSemantics: dimLabel(derived?.taskSemantics),
    candidate: generic.candidate,
    evidenceGrade,
    diffClass: classified.diffClass,
    userVisible: primed ? false : Boolean(legacy.userVisible),
    duplicateObservationId: Boolean(extras?.duplicateObservationId),
    primeReplay: primed,
    hasConflicts: Boolean(derived?.conflicts?.length),
    reason: classified.reason,
    observedAt: generic.observedAt || legacy.observedAt,
    eventTime: generic.eventTime ?? generic.observation?.eventTime ?? legacy.eventTime,
    canConcludeTaskSemantics: false
  }
}

function identityKey(record: ShadowIdentityFields, side: 'legacy' | 'generic', index: number): string {
  const file = safeFileAlias(record.fileIdentity)
  if (file) return `file:${record.agentId}:${file}`
  const session = payloadRef(record.sessionRef, record.sessionRefSource)
  if (session) return `session:${record.agentId}:${session}`
  const thread = payloadRef(record.threadRef, record.threadRefSource)
  if (thread) return `thread:${record.agentId}:${thread}`
  const turn = payloadRef(record.turnRef, record.turnRefSource)
  if (turn) return `turn:${record.agentId}:${turn}`
  if (record.dedupKey) return `dedup:${record.agentId}:${record.dedupKey}`
  return `unmatched:${side}:${record.agentId}:${index}`
}

function emptyCounts(): Record<ShadowDiffClass, number> {
  return {
    CONSISTENT: 0,
    GENERIC_MORE_CONSERVATIVE: 0,
    LEGACY_COMPATIBILITY: 0,
    GENERIC_MORE_INFORMATIVE: 0,
    POTENTIAL_BUG: 0,
    SAMPLE_NOT_COVERED: 0,
    UNMATCHED_CORRELATION: 0
  }
}

export function compareShadowBatch(input: {
  legacy: LegacyShadowRecord[]
  generic: GenericShadowRecord[]
  evidenceGrade: ShadowEvidenceGrade
}): ShadowComparisonBatch {
  const observationIds = new Map<string, number>()
  const bumpId = (id: string | undefined) => {
    if (!id) return
    observationIds.set(id, (observationIds.get(id) ?? 0) + 1)
  }
  for (const rec of input.legacy) bumpId(rec.observationId)
  for (const rec of input.generic) bumpId(rec.observationId)
  const duplicateObservationIds = [...observationIds.entries()].filter(([, n]) => n > 1).map(([id]) => id)

  const genericByKey = new Map<string, GenericShadowRecord[]>()
  const unmatchedGeneric: GenericShadowRecord[] = []
  input.generic.forEach((rec, index) => {
    const key = identityKey(rec, 'generic', index)
    if (key.startsWith('unmatched:')) {
      unmatchedGeneric.push(rec)
      return
    }
    const list = genericByKey.get(key) ?? []
    list.push(rec)
    genericByKey.set(key, list)
  })

  const rows: ShadowComparisonRow[] = []
  const unmatched: ShadowComparisonBatch['unmatched'] = []
  const usedGeneric = new Set<GenericShadowRecord>()

  input.legacy.forEach((legacy, index) => {
    const key = identityKey(legacy, 'legacy', index)
    if (key.startsWith('unmatched:')) {
      unmatched.push({ side: 'legacy', agentId: legacy.agentId, source: legacy.source })
      return
    }
    const candidates = genericByKey.get(key) ?? []
    const generic = candidates.find((item) => !usedGeneric.has(item) && correlationOf(legacy, item).level !== 'unmatched')
    if (!generic) {
      unmatched.push({ side: 'legacy', agentId: legacy.agentId, source: legacy.source })
      return
    }
    usedGeneric.add(generic)
    const duplicate =
      Boolean(legacy.observationId && duplicateObservationIds.includes(legacy.observationId)) ||
      Boolean(generic.observationId && duplicateObservationIds.includes(generic.observationId))
    rows.push(
      compareShadowPair({ legacy, generic, evidenceGrade: input.evidenceGrade }, { duplicateObservationId: duplicate })
    )
  })

  for (const rec of input.generic) {
    if (!usedGeneric.has(rec) && !unmatchedGeneric.includes(rec)) {
      unmatchedGeneric.push(rec)
    }
  }
  for (const rec of unmatchedGeneric) {
    unmatched.push({ side: 'generic', agentId: rec.agentId, source: rec.source })
  }

  const counts = emptyCounts()
  for (const row of rows) counts[row.diffClass] += 1
  if (unmatched.length) counts.UNMATCHED_CORRELATION += unmatched.length

  const evidenceCounts: Record<string, number> = {}
  for (const row of rows) {
    evidenceCounts[row.evidenceGrade] = (evidenceCounts[row.evidenceGrade] ?? 0) + 1
  }

  return {
    rows,
    unmatched,
    duplicateObservationIds,
    counts,
    evidenceCounts,
    correlationCapability: {
      file: rows.some((row) => row.maxCorrelationLevel === 'file'),
      session: rows.some((row) => row.sessionCorrelationLevel === 'session' || row.maxCorrelationLevel === 'session'),
      turn: rows.some((row) => row.turnCorrelationLevel === 'turn'),
      item: rows.some((row) => row.itemCorrelationLevel === 'item')
    }
  }
}

export function renderShadowComparisonMarkdown(batch: ShadowComparisonBatch, title: string): string {
  const lines = [
    `# ${title}`,
    '',
    '本对照只读，不接入 Monitor，不改变用户可见行为。',
    '',
    `差异分类：CONSISTENT=${batch.counts.CONSISTENT} GENERIC_MORE_CONSERVATIVE=${batch.counts.GENERIC_MORE_CONSERVATIVE} LEGACY_COMPATIBILITY=${batch.counts.LEGACY_COMPATIBILITY} GENERIC_MORE_INFORMATIVE=${batch.counts.GENERIC_MORE_INFORMATIVE} POTENTIAL_BUG=${batch.counts.POTENTIAL_BUG} SAMPLE_NOT_COVERED=${batch.counts.SAMPLE_NOT_COVERED} UNMATCHED_CORRELATION=${batch.counts.UNMATCHED_CORRELATION}`,
    '',
    `关联能力：file=${batch.correlationCapability.file} session=${batch.correlationCapability.session} turn=${batch.correlationCapability.turn} item=${batch.correlationCapability.item}`,
    ''
  ]
  for (const row of batch.rows) {
    lines.push(
      `- ${row.agentId} ${row.fileAlias ?? row.correlationKey}: legacy=${row.legacyKind} lifecycle=${row.derivedLifecycle ?? 'n/a'} class=${row.diffClass} evidence=${row.evidenceGrade} visible=${row.userVisible} prime=${row.primeReplay} taskSemantics=${row.canConcludeTaskSemantics}`
    )
    lines.push(`  reason: ${row.reason}`)
  }
  const text = lines.join('\n')
  if (reportContainsSensitiveText(text)) {
    throw new Error('shadow comparison markdown contained sensitive text')
  }
  return text
}
