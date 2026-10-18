import { acceptIdentityRef, digestAllowedFields } from '@shared/agentObservation'
import type {
  AgentAdapterCapability,
  AgentAdapterIdentity,
  AgentCause,
  AgentConfidence,
  AgentDerivedState,
  AgentLifecycle,
  AgentObservation,
  AgentObservationChannel,
  AgentStateConflict,
  AgentStateEvidence,
  Dimension
} from '@shared/agentObservation'
import type {
  CodexCause,
  CodexDerivedState,
  CodexLifecycleState,
  CodexObservationEvent,
  CodexObservationSource,
  CodexStateConflict,
  CodexStateEvidence
} from '@shared/types'
import { isLocalSessionEvent, isOfficialEvent } from '../codexState'
import {
  UNREGISTERED_CODEX_EXEC_JSON_CAPABILITY,
  UNREGISTERED_CODEX_EXEC_JSON_IDENTITY,
  UNREGISTERED_CODEX_SESSION_SHADOW_CAPABILITY,
  UNREGISTERED_CODEX_SESSION_SHADOW_IDENTITY
} from './placeholders'
import { observed, unknownDimension, unsupportedDimension } from './presence'
import type { AgentAdapterBoundary } from './types'

/**
 * Codex 只读投影 Adapter（阶段 2）。
 *
 * 只转换已经由 Codex 专用层解释好的事件/状态。
 * 不读文件、不解析 JSONL、不改检测器、不接入 Monitor、不自动注册。
 */

export const CODEX_SESSION_SHADOW_IDENTITY: AgentAdapterIdentity = {
  ...UNREGISTERED_CODEX_SESSION_SHADOW_IDENTITY,
  adapterVersion: 'phase-2-projection'
}

export const CODEX_SESSION_SHADOW_CAPABILITY: AgentAdapterCapability = {
  ...UNREGISTERED_CODEX_SESSION_SHADOW_CAPABILITY
}

export const CODEX_EXEC_JSON_IDENTITY: AgentAdapterIdentity = {
  ...UNREGISTERED_CODEX_EXEC_JSON_IDENTITY,
  adapterVersion: 'phase-2-projection'
}

export const CODEX_EXEC_JSON_CAPABILITY: AgentAdapterCapability = {
  ...UNREGISTERED_CODEX_EXEC_JSON_CAPABILITY
}

export const CODEX_SESSION_SHADOW_ADAPTER: AgentAdapterBoundary = {
  identity: CODEX_SESSION_SHADOW_IDENTITY,
  capability: CODEX_SESSION_SHADOW_CAPABILITY
}

export const CODEX_EXEC_JSON_ADAPTER: AgentAdapterBoundary = {
  identity: CODEX_EXEC_JSON_IDENTITY,
  capability: CODEX_EXEC_JSON_CAPABILITY
}

export type CodexProjectionAdapterId = 'codex-session-shadow' | 'codex-exec-json'

export class CodexAdapterChannelMismatchError extends Error {
  readonly adapterId: CodexProjectionAdapterId
  readonly source: CodexObservationSource

  constructor(adapterId: CodexProjectionAdapterId, source: CodexObservationSource) {
    super(`codex adapter ${adapterId} does not accept source=${source}`)
    this.name = 'CodexAdapterChannelMismatchError'
    this.adapterId = adapterId
    this.source = source
  }
}

const GENERIC_CAUSES = new Set<AgentCause>([
  'tool_failed',
  'turn_failed',
  'user_cancelled',
  'process_exit',
  'output_truncated',
  'monitor_disconnected',
  'unknown'
])

const STRUCTURAL_PAYLOAD_KEYS = [
  'type',
  'session_id',
  'sessionId',
  'thread_id',
  'threadId',
  'turn_id',
  'turnId',
  'item_id',
  'itemId',
  'status',
  'role',
  'ordinal'
] as const

export interface CodexProjectionExtension {
  agent: 'codex'
  process: CodexDerivedState['process']
  cause: CodexCause
  lifecycle: CodexLifecycleState
}

export function createCodexSessionShadowBoundary(): AgentAdapterBoundary {
  return { identity: CODEX_SESSION_SHADOW_IDENTITY, capability: CODEX_SESSION_SHADOW_CAPABILITY }
}

export function createCodexExecJsonBoundary(): AgentAdapterBoundary {
  return { identity: CODEX_EXEC_JSON_IDENTITY, capability: CODEX_EXEC_JSON_CAPABILITY }
}

export function adapterIdForCodexSource(source: CodexObservationSource): CodexProjectionAdapterId {
  return source === 'exec_json' ? 'codex-exec-json' : 'codex-session-shadow'
}

export function boundaryForCodexAdapter(adapterId: CodexProjectionAdapterId): AgentAdapterBoundary {
  return adapterId === 'codex-exec-json' ? CODEX_EXEC_JSON_ADAPTER : CODEX_SESSION_SHADOW_ADAPTER
}

function channelForAdapter(adapterId: CodexProjectionAdapterId): AgentObservationChannel {
  return boundaryForCodexAdapter(adapterId).identity.channel
}

function expectedSource(adapterId: CodexProjectionAdapterId): CodexObservationSource {
  return adapterId === 'codex-exec-json' ? 'exec_json' : 'session_jsonl'
}

function observationConfidence(event: CodexObservationEvent): AgentConfidence {
  if (isOfficialEvent(event)) return 'high'
  if (isLocalSessionEvent(event) && event.recognized) return 'medium'
  return 'low'
}

function sessionRefFromEvent(event: CodexObservationEvent): string | undefined {
  if (event.parseNote?.includes('fell back to filename')) return undefined
  return acceptIdentityRef(event.sessionId, 'payload')
}

function finiteEventTime(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function projectLifecycle(lifecycle: CodexLifecycleState): Dimension<AgentLifecycle> {
  if (lifecycle === 'unknown' || lifecycle === 'succeeded') return unknownDimension()
  return observed(lifecycle)
}

function projectCause(cause: CodexCause): Dimension<AgentCause> {
  if (cause === 'unknown') return unknownDimension()
  if (GENERIC_CAUSES.has(cause as AgentCause)) return observed(cause as AgentCause)
  return unknownDimension()
}

function projectKnownOrUnknown<T extends string>(value: T): Dimension<T> {
  if (value === 'unknown') return unknownDimension()
  return observed(value)
}

function projectEvidence(evidence: CodexStateEvidence): AgentStateEvidence {
  const adapterId = adapterIdForCodexSource(evidence.source)
  return {
    id: evidence.id,
    eventDedupKey: evidence.eventDedupKey,
    agentId: 'codex',
    adapterId,
    channel: channelForAdapter(adapterId),
    evidenceOrigin: evidence.source,
    eventName: evidence.eventType,
    observedAt: evidence.observedAt,
    evidenceKind: 'structured',
    note: evidence.note
  }
}

function projectConflict(conflict: CodexStateConflict): AgentStateConflict {
  const kept = projectLifecycle(conflict.keptLifecycle)
  return {
    observedAt: conflict.observedAt,
    keptLifecycle: kept.presence === 'observed' ? kept.value : 'unknown',
    ignoredEventName: conflict.ignoredEventType,
    ignoredChannel: conflict.ignoredSource === 'exec_json' ? 'official_stream' : 'session_file',
    reason: conflict.reason
  }
}

export function projectCodexObservation(
  event: CodexObservationEvent,
  adapterId: CodexProjectionAdapterId = adapterIdForCodexSource(event.source)
): AgentObservation {
  if (event.source !== expectedSource(adapterId)) {
    throw new CodexAdapterChannelMismatchError(adapterId, event.source)
  }
  const boundary = boundaryForCodexAdapter(adapterId)
  const digest = digestAllowedFields(event.payload, STRUCTURAL_PAYLOAD_KEYS)
  const observation: AgentObservation = {
    agentId: 'codex',
    adapterId: boundary.identity.adapterId,
    channel: boundary.identity.channel,
    eventName: event.eventType,
    recognition: event.recognition,
    payloadDigest: {
      ...digest,
      rawType: event.rawType
    },
    observedAt: event.observedAt,
    evidenceOrigin: event.source,
    confidence: observationConfidence(event),
    dedupKey: event.dedupKey,
    evidenceKind: event.recognized ? 'structured' : undefined
  }
  const sessionRef = sessionRefFromEvent(event)
  const threadRef = acceptIdentityRef(event.threadId, 'payload')
  const turnRef = acceptIdentityRef(event.turnId, 'payload')
  const itemRef = acceptIdentityRef(event.itemId, 'payload')
  const eventTime = finiteEventTime(event.eventTime)
  if (sessionRef) observation.sessionRef = sessionRef
  if (threadRef) observation.threadRef = threadRef
  if (turnRef) observation.turnRef = turnRef
  if (itemRef) observation.itemRef = itemRef
  if (eventTime !== undefined) observation.eventTime = eventTime
  return observation
}

export function projectCodexDerivedState(
  state: CodexDerivedState,
  adapterId: CodexProjectionAdapterId = 'codex-session-shadow'
): AgentDerivedState {
  const boundary = boundaryForCodexAdapter(adapterId)
  const derived: AgentDerivedState = {
    agentId: 'codex',
    adapterId: boundary.identity.adapterId,
    lifecycle: projectLifecycle(state.lifecycle),
    cause: projectCause(state.cause),
    connection: projectKnownOrUnknown(state.connection),
    process: unsupportedDimension(),
    session: projectKnownOrUnknown(state.session),
    turn: projectKnownOrUnknown(state.turn),
    item: projectKnownOrUnknown(state.item),
    outputIntegrity: projectKnownOrUnknown(state.outputIntegrity),
    taskSemantics: projectKnownOrUnknown(state.taskSemantics),
    retryability: projectKnownOrUnknown(state.retryability),
    confidence: state.confidence,
    evidence: state.evidence.map(projectEvidence),
    conflicts: state.conflicts.map(projectConflict),
    observedAt: state.observedAt,
    extension: {
      agent: 'codex',
      process: state.process,
      cause: state.cause,
      lifecycle: state.lifecycle
    } satisfies CodexProjectionExtension
  }
  const sessionRef = acceptIdentityRef(state.sessionId, 'payload')
  const threadRef = acceptIdentityRef(state.threadId, 'payload')
  const turnRef = acceptIdentityRef(state.turnId, 'payload')
  if (sessionRef) derived.sessionRef = sessionRef
  if (threadRef) derived.threadRef = threadRef
  if (turnRef) derived.turnRef = turnRef
  return derived
}
