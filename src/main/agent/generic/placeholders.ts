import type { AgentAdapterCapability, AgentAdapterIdentity } from '@shared/agentObservation'

/**
 * 未注册的占位能力。只用来说明契约，不得当作生产 Adapter，也不得自动进 registry。
 *
 * Codex session shadow 当前不观察外部进程退出；
 * 这不等于 Codex 的 process 维度永远不存在。
 */
export const UNREGISTERED_CODEX_SESSION_SHADOW_IDENTITY: AgentAdapterIdentity = {
  agentId: 'codex',
  adapterId: 'codex-session-shadow',
  channel: 'session_file',
  adapterVersion: 'phase-1-placeholder',
  protocolLabel: 'session-jsonl',
  experimental: true
}

export const UNREGISTERED_CODEX_SESSION_SHADOW_CAPABILITY: AgentAdapterCapability = {
  agentId: 'codex',
  adapterId: 'codex-session-shadow',
  channel: 'session_file',
  channels: ['session_file'],
  dimensions: {
    lifecycle: 'supported',
    cause: 'supported',
    connection: 'supported',
    process: 'not_observed_by_adapter',
    session: 'supported',
    turn: 'supported',
    item: 'supported',
    outputIntegrity: 'supported',
    taskSemantics: 'unknown_only',
    retryability: 'unknown_only'
  },
  structuredLifecycleEvents: 'supported',
  userCancelEvidence: 'partial',
  processEvidence: 'not_observed_by_adapter',
  eventTime: 'supported',
  stableDedupKey: 'supported'
}

/**
 * 官方 exec --json 通道占位。阶段 2 可做投影，但不自动注册、不接入生产 Monitor。
 * channel 用 official_stream，避免把 Codex 源名写进通用枚举。
 */
export const UNREGISTERED_CODEX_EXEC_JSON_IDENTITY: AgentAdapterIdentity = {
  agentId: 'codex',
  adapterId: 'codex-exec-json',
  channel: 'official_stream',
  adapterVersion: 'phase-2-placeholder',
  protocolLabel: 'exec-json',
  experimental: true
}

export const UNREGISTERED_CODEX_EXEC_JSON_CAPABILITY: AgentAdapterCapability = {
  agentId: 'codex',
  adapterId: 'codex-exec-json',
  channel: 'official_stream',
  channels: ['official_stream'],
  dimensions: {
    lifecycle: 'supported',
    cause: 'supported',
    connection: 'supported',
    process: 'not_observed_by_adapter',
    session: 'supported',
    turn: 'supported',
    item: 'supported',
    outputIntegrity: 'supported',
    taskSemantics: 'unknown_only',
    retryability: 'unknown_only'
  },
  structuredLifecycleEvents: 'supported',
  userCancelEvidence: 'partial',
  processEvidence: 'not_observed_by_adapter',
  eventTime: 'supported',
  stableDedupKey: 'supported'
}

/** 同一 Agent 的另一个未来通道：可以观察进程。阶段 1 同样未注册。 */
export const UNREGISTERED_CODEX_PROCESS_HINT_IDENTITY: AgentAdapterIdentity = {
  agentId: 'codex',
  adapterId: 'codex-process-hint',
  channel: 'process',
  adapterVersion: 'phase-1-placeholder',
  protocolLabel: 'explicit-process-hint',
  experimental: true
}

export const UNREGISTERED_CODEX_PROCESS_HINT_CAPABILITY: AgentAdapterCapability = {
  agentId: 'codex',
  adapterId: 'codex-process-hint',
  channel: 'process',
  channels: ['process'],
  dimensions: {
    lifecycle: 'unknown_only',
    cause: 'supported',
    connection: 'unknown_only',
    process: 'supported',
    session: 'unknown_only',
    turn: 'unknown_only',
    item: 'unknown_only',
    outputIntegrity: 'unknown_only',
    taskSemantics: 'unknown_only',
    retryability: 'unknown_only'
  },
  structuredLifecycleEvents: 'unsupported',
  userCancelEvidence: 'unsupported',
  processEvidence: 'supported',
  eventTime: 'supported',
  stableDedupKey: 'supported'
}

/**
 * Cursor transcript 通道占位。阶段 3 可做只读投影，但不自动注册、不接入生产 Monitor。
 * channel 必须用 transcript_file，不得复用 Codex 的 session_file / official_stream。
 */
export const UNREGISTERED_CURSOR_TRANSCRIPT_IDENTITY: AgentAdapterIdentity = {
  agentId: 'cursor',
  adapterId: 'cursor-transcript',
  channel: 'transcript_file',
  adapterVersion: 'phase-3-placeholder',
  protocolLabel: 'cursor-transcript',
  experimental: true
}

export const UNREGISTERED_CURSOR_TRANSCRIPT_CAPABILITY: AgentAdapterCapability = {
  agentId: 'cursor',
  adapterId: 'cursor-transcript',
  channel: 'transcript_file',
  channels: ['transcript_file'],
  dimensions: {
    lifecycle: 'supported',
    cause: 'supported',
    connection: 'supported',
    process: 'not_observed_by_adapter',
    session: 'supported',
    turn: 'supported',
    item: 'unknown_only',
    outputIntegrity: 'unknown_only',
    taskSemantics: 'unknown_only',
    retryability: 'unknown_only'
  },
  structuredLifecycleEvents: 'partial',
  userCancelEvidence: 'partial',
  processEvidence: 'not_observed_by_adapter',
  eventTime: 'unsupported',
  stableDedupKey: 'supported'
}
