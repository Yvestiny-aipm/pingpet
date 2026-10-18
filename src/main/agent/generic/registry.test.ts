import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentAdapterCapability, AgentAdapterIdentity } from '@shared/agentObservation'
import {
  UNREGISTERED_CODEX_PROCESS_HINT_CAPABILITY,
  UNREGISTERED_CODEX_PROCESS_HINT_IDENTITY,
  UNREGISTERED_CODEX_SESSION_SHADOW_CAPABILITY,
  UNREGISTERED_CODEX_SESSION_SHADOW_IDENTITY
} from './placeholders'
import { createAgentAdapterRegistry } from './registry'
import {
  AgentAdapterIdentityMismatchError,
  DuplicateAgentAdapterError,
  type AgentAdapterBoundary
} from './types'

function boundary(identity: AgentAdapterIdentity, capability: AgentAdapterCapability): AgentAdapterBoundary {
  return { identity, capability }
}

function testCursorBoundary(): AgentAdapterBoundary {
  const identity: AgentAdapterIdentity = {
    agentId: 'cursor',
    adapterId: 'test-cursor-boundary',
    channel: 'session_file',
    adapterVersion: 'test',
    experimental: true
  }
  const capability: AgentAdapterCapability = {
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
  return { identity, capability }
}

describe('默认空表', () => {
  it('新建 registry 不带任何生产或占位 Adapter', () => {
    const registry = createAgentAdapterRegistry()
    expect(registry.listAll()).toEqual([])
    expect(registry.get('codex', 'codex-session-shadow')).toBeUndefined()
    expect(registry.listByAgent('codex')).toEqual([])
  })
})

describe('同一 Agent 的多个 Adapter', () => {
  it('可以独立注册，互不影响维度声明', () => {
    const registry = createAgentAdapterRegistry()
    registry.register(
      boundary(UNREGISTERED_CODEX_SESSION_SHADOW_IDENTITY, UNREGISTERED_CODEX_SESSION_SHADOW_CAPABILITY)
    )
    registry.register(
      boundary(UNREGISTERED_CODEX_PROCESS_HINT_IDENTITY, UNREGISTERED_CODEX_PROCESS_HINT_CAPABILITY)
    )

    const all = registry.listByAgent('codex')
    expect(all).toHaveLength(2)
    expect(registry.dimensionCapability('codex', 'codex-session-shadow', 'process')).toBe(
      'not_observed_by_adapter'
    )
    expect(registry.dimensionCapability('codex', 'codex-process-hint', 'process')).toBe('supported')
    expect(registry.get('codex', 'codex-session-shadow')?.identity.channel).toBe('session_file')
    expect(registry.get('codex', 'codex-process-hint')?.identity.channel).toBe('process')
  })
})

describe('重复注册', () => {
  it('同一 agentId+adapterId 再次注册会抛错，且不覆盖原记录', () => {
    const registry = createAgentAdapterRegistry()
    const first = boundary(
      UNREGISTERED_CODEX_SESSION_SHADOW_IDENTITY,
      UNREGISTERED_CODEX_SESSION_SHADOW_CAPABILITY
    )
    registry.register(first)

    expect(() => registry.register(first)).toThrow(DuplicateAgentAdapterError)
    try {
      registry.register(first)
    } catch (error) {
      expect(error).toMatchObject({ agentId: 'codex', adapterId: 'codex-session-shadow' })
    }
    expect(registry.listByAgent('codex')).toHaveLength(1)
  })
})

describe('未注册 Agent 不得回退', () => {
  it('查找缺失的 Agent 或 Adapter 时返回空，不会给出另一家的记录', () => {
    const registry = createAgentAdapterRegistry()
    registry.register(
      boundary(UNREGISTERED_CODEX_SESSION_SHADOW_IDENTITY, UNREGISTERED_CODEX_SESSION_SHADOW_CAPABILITY)
    )
    registry.register(testCursorBoundary())

    expect(registry.get('claude', 'codex-session-shadow')).toBeUndefined()
    expect(registry.get('codex', 'test-cursor-boundary')).toBeUndefined()
    expect(registry.get('grok', 'missing')).toBeUndefined()
    expect(registry.listByAgent('claude')).toEqual([])
    expect(registry.listByAgent('grok')).toEqual([])
    expect(registry.dimensionCapability('claude', 'codex-session-shadow', 'lifecycle')).toBeUndefined()
    expect(registry.listByAgent('codex')).toHaveLength(1)
    expect(registry.listByAgent('cursor')).toHaveLength(1)
  })

  it('身份与能力的 agent/channel 不一致时拒绝注册', () => {
    const registry = createAgentAdapterRegistry()
    expect(() =>
      registry.register({
        identity: UNREGISTERED_CODEX_SESSION_SHADOW_IDENTITY,
        capability: {
          ...UNREGISTERED_CODEX_SESSION_SHADOW_CAPABILITY,
          agentId: 'cursor'
        }
      })
    ).toThrow(AgentAdapterIdentityMismatchError)
    expect(registry.listAll()).toEqual([])
  })
})

describe('注册表没有用户可见副作用', () => {
  it('源码不引用 Monitor、扫描器、classify 或桌宠入口', () => {
    const dir = __dirname
    const files = ['registry.ts', 'types.ts', 'presence.ts', 'placeholders.ts']
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8')
      expect(text).not.toContain("from '../monitor'")
      expect(text).not.toContain("from '../classify'")
      expect(text).not.toContain("from '../scanners'")
      expect(text).not.toContain("from '../codex'")
      expect(text).not.toContain("from '../claude'")
      expect(text).not.toContain("from '../cursor'")
      expect(text).not.toContain("from '../grok'")
      expect(text).not.toContain('handleAgentEvent')
      expect(text).not.toContain('sendBubble')
      expect(text).not.toContain('sendPetState')
      expect(text).not.toContain('playDing')
      expect(text).not.toContain('~/.codex')
    }
  })

  it('register / get 只返回已登记的边界对象，不含旧 kind', () => {
    const registry = createAgentAdapterRegistry()
    registry.register(testCursorBoundary())
    const found = registry.get('cursor', 'test-cursor-boundary')
    expect(found).toEqual(testCursorBoundary())
    expect(found).not.toHaveProperty('kind')
    expect(found).not.toHaveProperty('legacyEquivalent')
    expect(JSON.stringify(found)).not.toContain('"done"')
  })
})
