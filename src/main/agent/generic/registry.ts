import type { AgentAdapterId, AgentStateDimension, GenericAgentId } from '@shared/agentObservation'
import { dimensionCapabilityOf } from './presence'
import {
  adapterRecordKey,
  assertCapabilityMatchesIdentity,
  DuplicateAgentAdapterError,
  type AgentAdapterBoundary
} from './types'

/**
 * Adapter 注册表。
 *
 * 只保存身份和能力声明。不启动 Monitor、不读文件、不改旧事件、
 * 不触发桌宠 / 气泡 / 声音 / 自动重试。
 *
 * 默认是空表。阶段 1 不注册任何生产 Adapter。
 */
export class AgentAdapterRegistry {
  private readonly records = new Map<string, AgentAdapterBoundary>()

  register(boundary: AgentAdapterBoundary): void {
    assertCapabilityMatchesIdentity(boundary.identity, boundary.capability)
    const key = adapterRecordKey(boundary.identity)
    if (this.records.has(key)) {
      throw new DuplicateAgentAdapterError(boundary.identity.agentId, boundary.identity.adapterId)
    }
    this.records.set(key, boundary)
  }

  get(agentId: GenericAgentId, adapterId: AgentAdapterId): AgentAdapterBoundary | undefined {
    return this.records.get(adapterRecordKey({ agentId, adapterId }))
  }

  listByAgent(agentId: GenericAgentId): AgentAdapterBoundary[] {
    const out: AgentAdapterBoundary[] = []
    for (const record of this.records.values()) {
      if (record.identity.agentId === agentId) out.push(record)
    }
    return out
  }

  listAll(): AgentAdapterBoundary[] {
    return [...this.records.values()]
  }

  dimensionCapability(agentId: GenericAgentId, adapterId: AgentAdapterId, dimension: AgentStateDimension) {
    const record = this.get(agentId, adapterId)
    if (!record) return undefined
    return dimensionCapabilityOf(record.capability, dimension)
  }
}

export function createAgentAdapterRegistry(): AgentAdapterRegistry {
  return new AgentAdapterRegistry()
}
