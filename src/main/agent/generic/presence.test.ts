import { describe, expect, it } from 'vitest'
import type { AgentAdapterCapability } from '@shared/agentObservation'
import {
  capabilitiesShareDimensionScope,
  dimensionCapabilityOf,
  emptyAgentDerivedState,
  isObserved,
  isUnknown,
  isUnsupported,
  listDimensionCapabilities,
  observed,
  observedValue,
  presenceOf,
  scopedDimensionKey,
  unknownDimension,
  unsupportedDimension
} from './presence'
import {
  UNREGISTERED_CODEX_PROCESS_HINT_CAPABILITY,
  UNREGISTERED_CODEX_SESSION_SHADOW_CAPABILITY
} from './placeholders'

function cursorTestCapability(): AgentAdapterCapability {
  return {
    agentId: 'cursor',
    adapterId: 'test-cursor-boundary',
    channel: 'session_file',
    channels: ['session_file'],
    dimensions: {
      lifecycle: 'supported',
      cause: 'unknown_only',
      connection: 'unknown_only',
      process: 'not_observed_by_adapter',
      session: 'supported',
      turn: 'supported',
      item: 'unsupported_by_agent',
      outputIntegrity: 'unknown_only',
      taskSemantics: 'unknown_only',
      retryability: 'unknown_only'
    },
    structuredLifecycleEvents: 'partial',
    userCancelEvidence: 'unsupported',
    processEvidence: 'not_observed_by_adapter',
    eventTime: 'unsupported',
    stableDedupKey: 'supported'
  }
}

describe('存在性辅助', () => {
  it('observed / unknown / unsupported 互不兼容', () => {
    const running = observed('running' as const)
    const unknown = unknownDimension<'running'>()
    const unsupported = unsupportedDimension<'running'>()

    expect(isObserved(running)).toBe(true)
    expect(isUnknown(unknown)).toBe(true)
    expect(isUnsupported(unsupported)).toBe(true)
    expect(observedValue(running)).toBe('running')
    expect(observedValue(unknown)).toBeUndefined()
    expect(observedValue(unsupported)).toBeUndefined()
    expect(presenceOf(running)).not.toBe(presenceOf(unknown))
    expect(presenceOf(unknown)).not.toBe(presenceOf(unsupported))
  })
})

describe('空派生状态', () => {
  it('缺省是 unknown，不是 unsupported，也不带展示字段', () => {
    const state = emptyAgentDerivedState({
      agentId: 'codex',
      adapterId: 'codex-session-shadow',
      observedAt: 10
    })
    expect(state.lifecycle).toEqual({ presence: 'unknown' })
    expect(state.process).toEqual({ presence: 'unknown' })
    expect(state.sessionRef).toBeUndefined()
    expect(state.turnRef).toBeUndefined()
    expect(state.evidence).toEqual([])
    expect(state).not.toHaveProperty('legacyEquivalent')
    expect(state).not.toHaveProperty('petState')
  })
})

describe('能力按 agent + adapter/channel + dimension 隔离', () => {
  it('Codex session shadow 不观察进程，不等于 Codex 永远没有 process', () => {
    const shadow = UNREGISTERED_CODEX_SESSION_SHADOW_CAPABILITY
    const processHint = UNREGISTERED_CODEX_PROCESS_HINT_CAPABILITY

    expect(dimensionCapabilityOf(shadow, 'process')).toBe('not_observed_by_adapter')
    expect(dimensionCapabilityOf(processHint, 'process')).toBe('supported')
    expect(shadow.processEvidence).toBe('not_observed_by_adapter')
    expect(processHint.processEvidence).toBe('supported')
    expect(capabilitiesShareDimensionScope(shadow, processHint, 'process')).toBe(false)
  })

  it('同一 Adapter 的 process 声明不会落到另一个 Agent', () => {
    const shadow = UNREGISTERED_CODEX_SESSION_SHADOW_CAPABILITY
    const cursor = cursorTestCapability()
    expect(scopedDimensionKey(shadow, 'process')).not.toBe(scopedDimensionKey(cursor, 'process'))
    expect(dimensionCapabilityOf(cursor, 'item')).toBe('unsupported_by_agent')
    expect(dimensionCapabilityOf(shadow, 'item')).toBe('supported')
  })

  it('列出的每条能力都带齐 agent / adapter / channel / dimension', () => {
    const rows = listDimensionCapabilities(UNREGISTERED_CODEX_SESSION_SHADOW_CAPABILITY)
    expect(rows).toHaveLength(10)
    for (const row of rows) {
      expect(row.agentId).toBe('codex')
      expect(row.adapterId).toBe('codex-session-shadow')
      expect(row.channel).toBe('session_file')
    }
    expect(rows.find((row) => row.dimension === 'process')?.kind).toBe('not_observed_by_adapter')
    expect(rows.find((row) => row.dimension === 'taskSemantics')?.kind).toBe('unknown_only')
  })
})
