import { acceptIdentityRef, digestAllowedFields } from '@shared/agentObservation'
import type {
  AgentAdapterCapability,
  AgentAdapterIdentity,
  AgentCause,
  AgentConfidence,
  AgentConnection,
  AgentDerivedState,
  AgentEvidenceKind,
  AgentLifecycle,
  AgentObservation,
  AgentRecognition,
  AgentStateConflict,
  AgentStateEvidence,
  Dimension,
  IdentityRefSource
} from '@shared/agentObservation'
import { observed, unknownDimension, unsupportedDimension } from './presence'
import { UNREGISTERED_CURSOR_TRANSCRIPT_CAPABILITY, UNREGISTERED_CURSOR_TRANSCRIPT_IDENTITY } from './placeholders'
import type { AgentAdapterBoundary, AgentAdapterOutput } from './types'

/**
 * Cursor 只读投影 Adapter（阶段 3）。
 *
 * 只转换调用方已经解析好的 Cursor 末行结果。
 * 不读用户 Cursor 目录、不扫描文件、不调用文本分类、不改旧扫描器、不接入 Monitor、不自动注册。
 */

export const CURSOR_TRANSCRIPT_IDENTITY: AgentAdapterIdentity = {
  ...UNREGISTERED_CURSOR_TRANSCRIPT_IDENTITY,
  adapterVersion: 'phase-3-projection'
}

export const CURSOR_TRANSCRIPT_CAPABILITY: AgentAdapterCapability = {
  ...UNREGISTERED_CURSOR_TRANSCRIPT_CAPABILITY
}

export const CURSOR_TRANSCRIPT_ADAPTER: AgentAdapterBoundary = {
  identity: CURSOR_TRANSCRIPT_IDENTITY,
  capability: CURSOR_TRANSCRIPT_CAPABILITY
}

export const CURSOR_TRANSCRIPT_CHANNEL = 'transcript_file' as const
export const CURSOR_EVIDENCE_ORIGIN = 'cursor_transcript' as const

const STRUCTURAL_PAYLOAD_KEYS = [
  'type',
  'role',
  'status',
  'session_id',
  'sessionId',
  'turn_id',
  'turnId',
  'item_id',
  'itemId'
] as const

export type CursorLastLineKind = 'turn_ended' | 'assistant_text' | 'assistant_tool_use' | 'user' | 'other'

export type CursorTurnEndedStatus = 'success' | 'aborted' | 'error'

/** 调用方已经算好的脱敏文本分类，Adapter 不再跑关键词。 */
export type CursorTextHintKind = 'done' | 'success' | 'needs_attention' | 'failed'

export type CursorSampleKind = 'live' | 'FIXTURE_ONLY'

export type CursorEventTimeSource = 'payload' | 'mtime' | 'observedAt'

/**
 * 已有 Cursor 解析结果的最小封装。
 * 不要为了喂这个类型去改旧扫描器；也不得把文件名 / mtime 当成 turnRef。
 */
export interface CursorAdapterInput {
  observedAt: number
  /** 仅当原始输入真有事件时间。mtime / observedAt 不得填入。 */
  eventTime?: number
  eventTimeSource?: CursorEventTimeSource
  sessionRef?: string
  sessionRefSource?: IdentityRefSource
  turnRef?: string
  turnRefSource?: IdentityRefSource
  itemRef?: string
  itemRefSource?: IdentityRefSource
  lastLineKind: CursorLastLineKind
  turnEndedStatus?: CursorTurnEndedStatus
  /**
   * 只有调用方已经明确「用户主动取消」时才能为 true。
   * Adapter 不会从 error 文案「用户取消」自行推断。
   */
  userCancelled?: boolean
  textHint?: CursorTextHintKind
  /** 单条 item/tool 失败。不得单独把 lifecycle 升成 turn failed。 */
  itemOrToolFailed?: boolean
  connection?: AgentConnection
  /** 必须是 Cursor 现有稳定标识，不得用 mtime 拼造。 */
  dedupKey: string
  fieldNames?: readonly string[]
  rawType?: string
  payload?: Readonly<Record<string, unknown>>
  /** 仓库没有真实协议样本时必须标 FIXTURE_ONLY。 */
  sampleKind?: CursorSampleKind
}

export interface CursorProjectionExtension {
  agent: 'cursor'
  process: 'not_observed'
  lastLineKind: CursorLastLineKind
  turnEndedStatus?: CursorTurnEndedStatus
  textHint?: CursorTextHintKind
  sampleKind?: CursorSampleKind
}

export function createCursorTranscriptBoundary(): AgentAdapterBoundary {
  return { identity: CURSOR_TRANSCRIPT_IDENTITY, capability: CURSOR_TRANSCRIPT_CAPABILITY }
}

function acceptedRef(raw: string | undefined, source: IdentityRefSource | undefined): string | undefined {
  return acceptIdentityRef(raw, source ?? 'filename')
}

function finiteEventTime(input: CursorAdapterInput): number | undefined {
  if (input.eventTimeSource === 'mtime' || input.eventTimeSource === 'observedAt') return undefined
  return typeof input.eventTime === 'number' && Number.isFinite(input.eventTime) ? input.eventTime : undefined
}

function recognitionOf(input: CursorAdapterInput): AgentRecognition {
  if (input.lastLineKind === 'turn_ended') return 'recognized'
  if (input.lastLineKind === 'assistant_tool_use' || input.lastLineKind === 'user') return 'recognized'
  if (input.lastLineKind === 'assistant_text') return 'partial'
  return 'unknown'
}

function evidenceKindOf(input: CursorAdapterInput): AgentEvidenceKind {
  if (input.lastLineKind === 'turn_ended') return 'structured'
  if (input.lastLineKind === 'assistant_tool_use' || input.lastLineKind === 'user') return 'structured'
  return 'text_keyword'
}

function observationConfidenceOf(input: CursorAdapterInput): AgentConfidence {
  if (input.lastLineKind === 'assistant_text') return 'low'
  if (input.lastLineKind === 'other') return 'low'
  if (input.lastLineKind === 'turn_ended') return 'medium'
  if (input.lastLineKind === 'assistant_tool_use' || input.lastLineKind === 'user') return 'medium'
  return 'low'
}

function payloadDigestOf(input: CursorAdapterInput) {
  const digest = digestAllowedFields(input.payload, STRUCTURAL_PAYLOAD_KEYS)
  const fieldNames = input.fieldNames
    ? STRUCTURAL_PAYLOAD_KEYS.filter((key) => input.fieldNames?.includes(key))
    : digest.fieldNames
  return {
    fieldNames,
    rawType: input.rawType,
    redacted: true as const
  }
}

function projectConnection(value: AgentConnection | undefined): Dimension<AgentConnection> {
  if (!value || value === 'unknown') return unknownDimension()
  return observed(value)
}

function isStructuredTurnEnd(input: CursorAdapterInput): boolean {
  return input.lastLineKind === 'turn_ended'
}

function isRunningLastLine(input: CursorAdapterInput): boolean {
  return (
    input.lastLineKind === 'assistant_tool_use' ||
    input.lastLineKind === 'user' ||
    input.lastLineKind === 'other'
  )
}

function isTextCompletion(input: CursorAdapterInput): boolean {
  if (input.lastLineKind === 'assistant_text') return true
  return input.textHint === 'done' || input.textHint === 'success'
}

function textHintConflictsWith(kept: AgentLifecycle, input: CursorAdapterInput): AgentStateConflict | undefined {
  if (!input.textHint) return undefined
  const textLooksTerminal = input.textHint === 'done' || input.textHint === 'success'
  const textLooksFailed = input.textHint === 'failed' || input.textHint === 'needs_attention'
  const structuredSuccess = isStructuredTurnEnd(input) && input.turnEndedStatus === 'success'
  const structuredFailed = isStructuredTurnEnd(input) && input.turnEndedStatus === 'error'
  const structuredRunning = isRunningLastLine(input)
  const shouldRecord =
    (structuredSuccess && textLooksFailed) ||
    (structuredFailed && textLooksTerminal) ||
    (structuredRunning && (textLooksTerminal || textLooksFailed))
  if (!shouldRecord) return undefined
  return {
    observedAt: input.observedAt,
    keptLifecycle: kept,
    ignoredEventName: `text_hint.${input.textHint}`,
    ignoredChannel: CURSOR_TRANSCRIPT_CHANNEL,
    reason: 'structured Cursor last-line signal kept over low-confidence text hint'
  }
}

function evidenceOf(input: CursorAdapterInput, observation: AgentObservation): AgentStateEvidence {
  const noteParts = ['cursor last-line projection']
  if (input.sampleKind === 'FIXTURE_ONLY') noteParts.push('FIXTURE_ONLY')
  return {
    id: observation.dedupKey,
    eventDedupKey: observation.dedupKey,
    agentId: 'cursor',
    adapterId: CURSOR_TRANSCRIPT_IDENTITY.adapterId,
    channel: CURSOR_TRANSCRIPT_CHANNEL,
    evidenceOrigin: CURSOR_EVIDENCE_ORIGIN,
    eventName: observation.eventName,
    observedAt: input.observedAt,
    evidenceKind: evidenceKindOf(input),
    note: noteParts.join('; ')
  }
}

export function projectCursorObservation(input: CursorAdapterInput): AgentObservation {
  const observation: AgentObservation = {
    agentId: 'cursor',
    adapterId: CURSOR_TRANSCRIPT_IDENTITY.adapterId,
    channel: CURSOR_TRANSCRIPT_CHANNEL,
    eventName: input.lastLineKind,
    recognition: recognitionOf(input),
    payloadDigest: payloadDigestOf(input),
    observedAt: input.observedAt,
    evidenceOrigin: CURSOR_EVIDENCE_ORIGIN,
    confidence: observationConfidenceOf(input),
    dedupKey: input.dedupKey,
    evidenceKind: evidenceKindOf(input)
  }
  const sessionRef = acceptedRef(input.sessionRef, input.sessionRefSource)
  const turnRef = acceptedRef(input.turnRef, input.turnRefSource)
  const itemRef = acceptedRef(input.itemRef, input.itemRefSource)
  const eventTime = finiteEventTime(input)
  if (sessionRef) observation.sessionRef = sessionRef
  if (turnRef) observation.turnRef = turnRef
  if (itemRef) observation.itemRef = itemRef
  if (eventTime !== undefined) observation.eventTime = eventTime
  return observation
}

export function projectCursorDerivedState(input: CursorAdapterInput): AgentDerivedState {
  const sessionRef = acceptedRef(input.sessionRef, input.sessionRefSource)
  const turnRef = acceptedRef(input.turnRef, input.turnRefSource)
  const itemRef = acceptedRef(input.itemRef, input.itemRefSource)
  const observation = projectCursorObservation(input)

  let lifecycle: Dimension<AgentLifecycle> = unknownDimension()
  let cause: Dimension<AgentCause> = unknownDimension()
  let session = sessionRef ? observed('active' as const) : unknownDimension<'active'>()
  let turn = unknownDimension<'in_progress' | 'completed' | 'interrupted' | 'failed'>()
  let item = unknownDimension<'failed'>()
  let outputIntegrity = unknownDimension<'partial'>()
  let retryability = unknownDimension<'user_action'>()
  let confidence: AgentConfidence = observation.confidence

  if (isStructuredTurnEnd(input) && input.turnEndedStatus === 'success') {
    lifecycle = observed('completed_signal')
    turn = observed('completed')
    retryability = unknownDimension()
    confidence = 'medium'
    if (input.itemOrToolFailed) {
      cause = observed('tool_failed')
      item = observed('failed')
      outputIntegrity = observed('partial')
    }
  } else if (isStructuredTurnEnd(input) && input.turnEndedStatus === 'aborted') {
    turn = observed('interrupted')
    if (input.userCancelled === true) {
      lifecycle = observed('cancelled')
      cause = observed('user_cancelled')
      retryability = observed('user_action')
      confidence = 'medium'
    } else {
      lifecycle = unknownDimension()
      cause = unknownDimension()
      confidence = 'medium'
    }
  } else if (isStructuredTurnEnd(input) && input.turnEndedStatus === 'error') {
    // FIXTURE_ONLY：仓库尚无真实 Cursor turn-level error 协议样本。
    lifecycle = observed('failed')
    cause = observed('turn_failed')
    turn = observed('failed')
    confidence = 'medium'
  } else if (isRunningLastLine(input)) {
    lifecycle = observed('running')
    turn = observed('in_progress')
    if (input.itemOrToolFailed) {
      cause = observed('tool_failed')
      item = observed('failed')
      outputIntegrity = observed('partial')
    }
  } else if (isTextCompletion(input)) {
    lifecycle = observed('completed_signal')
    turn = unknownDimension()
    retryability = unknownDimension()
    confidence = 'low'
  }

  const keptLifecycle = lifecycle.presence === 'observed' ? lifecycle.value : 'unknown'
  const conflicts: AgentStateConflict[] = []
  const conflict = textHintConflictsWith(keptLifecycle, input)
  if (conflict) conflicts.push(conflict)

  const derived: AgentDerivedState = {
    agentId: 'cursor',
    adapterId: CURSOR_TRANSCRIPT_IDENTITY.adapterId,
    lifecycle,
    cause,
    connection: projectConnection(input.connection),
    process: unsupportedDimension(),
    session,
    turn,
    item,
    outputIntegrity,
    taskSemantics: observed('not_verified'),
    retryability,
    confidence,
    evidence: [evidenceOf(input, observation)],
    conflicts,
    observedAt: input.observedAt,
    extension: {
      agent: 'cursor',
      process: 'not_observed',
      lastLineKind: input.lastLineKind,
      turnEndedStatus: input.turnEndedStatus,
      textHint: input.textHint,
      sampleKind: input.sampleKind
    } satisfies CursorProjectionExtension
  }
  if (sessionRef) derived.sessionRef = sessionRef
  if (turnRef) derived.turnRef = turnRef
  if (itemRef) derived.itemRef = itemRef
  return derived
}

export function projectCursor(input: CursorAdapterInput): AgentAdapterOutput {
  return {
    observations: [projectCursorObservation(input)],
    derived: projectCursorDerivedState(input)
  }
}
