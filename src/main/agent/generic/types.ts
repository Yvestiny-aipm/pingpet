import type {
  AgentAdapterCapability,
  AgentAdapterIdentity,
  AgentDerivedState,
  AgentObservation
} from '@shared/agentObservation'

/**
 * 阶段 1 Adapter 边界。
 *
 * 这里只登记身份和能力，不读文件、不聚合状态、不输出旧 Monitor 事件。
 * observe / aggregate 属于阶段 2+，本接口故意不包含它们，以免被当成已实现。
 */
export interface AgentAdapterBoundary {
  identity: AgentAdapterIdentity
  capability: AgentAdapterCapability
}

/**
 * 未来 Adapter 的输出边界。阶段 1 只定义形状，没有实现者。
 * 不得带 legacyEquivalent、宠物状态、气泡或声音字段。
 */
export interface AgentAdapterOutput {
  observations: readonly AgentObservation[]
  derived?: AgentDerivedState
}

export function adapterRecordKey(identity: Pick<AgentAdapterIdentity, 'agentId' | 'adapterId'>): string {
  return `${identity.agentId}\u0000${identity.adapterId}`
}

export function assertCapabilityMatchesIdentity(
  identity: AgentAdapterIdentity,
  capability: AgentAdapterCapability
): void {
  if (capability.agentId !== identity.agentId || capability.adapterId !== identity.adapterId) {
    throw new AgentAdapterIdentityMismatchError(identity, capability)
  }
  if (capability.channel !== identity.channel) {
    throw new AgentAdapterIdentityMismatchError(identity, capability)
  }
  if (!capability.channels.includes(identity.channel)) {
    throw new AgentAdapterIdentityMismatchError(identity, capability)
  }
}

export class AgentAdapterIdentityMismatchError extends Error {
  readonly identity: AgentAdapterIdentity
  readonly capability: AgentAdapterCapability

  constructor(identity: AgentAdapterIdentity, capability: AgentAdapterCapability) {
    super(
      `adapter capability does not match identity: ${identity.agentId}/${identity.adapterId}/${identity.channel}`
    )
    this.name = 'AgentAdapterIdentityMismatchError'
    this.identity = identity
    this.capability = capability
  }
}

export class DuplicateAgentAdapterError extends Error {
  readonly agentId: string
  readonly adapterId: string

  constructor(agentId: string, adapterId: string) {
    super(`adapter already registered: ${agentId}/${adapterId}`)
    this.name = 'DuplicateAgentAdapterError'
    this.agentId = agentId
    this.adapterId = adapterId
  }
}
