import type {
  AgentAdapterCapability,
  AgentAdapterId,
  AgentDerivedState,
  AgentObservationChannel,
  AgentStateDimension,
  Dimension,
  DimensionCapabilityKind,
  DimensionPresence,
  GenericAgentId
} from '@shared/agentObservation'
import { AGENT_STATE_DIMENSIONS, capabilityKey } from '@shared/agentObservation'

export function observed<T>(value: T): Dimension<T> {
  return { presence: 'observed', value }
}

export function unknownDimension<T = never>(): Dimension<T> {
  return { presence: 'unknown' }
}

export function unsupportedDimension<T = never>(): Dimension<T> {
  return { presence: 'unsupported' }
}

export function isObserved<T>(dimension: Dimension<T>): dimension is { presence: 'observed'; value: T } {
  return dimension.presence === 'observed'
}

export function isUnknown<T>(dimension: Dimension<T>): boolean {
  return dimension.presence === 'unknown'
}

export function isUnsupported<T>(dimension: Dimension<T>): boolean {
  return dimension.presence === 'unsupported'
}

export function presenceOf<T>(dimension: Dimension<T>): DimensionPresence {
  return dimension.presence
}

export function observedValue<T>(dimension: Dimension<T>): T | undefined {
  return isObserved(dimension) ? dimension.value : undefined
}

/**
 * 运行时缺省：每个维度都是 unknown，不是 unsupported。
 * unsupported 只能来自能力表，不能靠「没填」冒充。
 */
export function emptyAgentDerivedState(input: {
  agentId: GenericAgentId
  adapterId: AgentAdapterId
  observedAt: number
}): AgentDerivedState {
  return {
    agentId: input.agentId,
    adapterId: input.adapterId,
    lifecycle: unknownDimension(),
    cause: unknownDimension(),
    connection: unknownDimension(),
    process: unknownDimension(),
    session: unknownDimension(),
    turn: unknownDimension(),
    item: unknownDimension(),
    outputIntegrity: unknownDimension(),
    taskSemantics: unknownDimension(),
    retryability: unknownDimension(),
    confidence: 'low',
    evidence: [],
    conflicts: [],
    observedAt: input.observedAt
  }
}

export function dimensionCapabilityOf(
  capability: AgentAdapterCapability,
  dimension: AgentStateDimension
): DimensionCapabilityKind {
  return capability.dimensions[dimension]
}

export function scopedDimensionKey(
  capability: AgentAdapterCapability,
  dimension: AgentStateDimension
): string {
  return capabilityKey(capability.agentId, capability.adapterId, capability.channel, dimension)
}

export function capabilitiesShareDimensionScope(
  left: AgentAdapterCapability,
  right: AgentAdapterCapability,
  dimension: AgentStateDimension
): boolean {
  return scopedDimensionKey(left, dimension) === scopedDimensionKey(right, dimension)
}

export function listDimensionCapabilities(
  capability: AgentAdapterCapability
): ReadonlyArray<{
  agentId: GenericAgentId
  adapterId: AgentAdapterId
  channel: AgentObservationChannel
  dimension: AgentStateDimension
  kind: DimensionCapabilityKind
}> {
  return AGENT_STATE_DIMENSIONS.map((dimension) => ({
    agentId: capability.agentId,
    adapterId: capability.adapterId,
    channel: capability.channel,
    dimension,
    kind: capability.dimensions[dimension]
  }))
}
