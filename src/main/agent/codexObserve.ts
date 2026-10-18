import { basename } from 'node:path'
import type {
  CodexEvidenceOrigin,
  CodexNormalizedEventType,
  CodexObservationEvent,
  CodexObservationSource,
  CodexParserRecognition
} from '@shared/types'
import { CODEX_STRUCTURED_EVENT_TYPES } from '@shared/types'
import {
  emptyJsonlFeedState,
  feedJsonlText,
  flushJsonlFeed,
  readFileTextFromOffset,
  type JsonlFeedLine,
  type JsonlFeedState
} from './readJsonl'

/**
 * Codex 信号适配 + 统一事件记录（阶段 1）。
 *
 * 只观察、记录、去重。不判断任务是否完成，不改 AgentMonitor，不驱动桌宠。
 * 现有 scanCodex() 仍走原来的 event_msg/response_item → working/done 路径。
 */

/** 仅官方 `codex exec --json` 已确认的顶层点号 type。下划线写法不得在这里当官方事件。 */
const OFFICIAL_TOP_TYPES = new Set<string>(CODEX_STRUCTURED_EVENT_TYPES)

const TURN_TERMINAL_TYPES = new Set<CodexNormalizedEventType>([
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'event_msg.task_complete',
  'event_msg.turn_aborted'
])

const OPEN_TURN_ITEM_TYPES = new Set<CodexNormalizedEventType>([
  'event_msg.item_started',
  'event_msg.item_updated',
  'event_msg.item_completed'
])

const KNOWN_SESSION_TOP_TYPES = new Set([
  'session_meta',
  'event_msg',
  'response_item',
  'turn_context',
  'token_usage_record',
  'world_state',
  'compacted'
])

const KNOWN_EVENT_MSG_TYPES = new Set([
  'task_started',
  'task_complete',
  'turn_aborted',
  'item_started',
  'item_updated',
  'item_completed',
  'item.started',
  'item.updated',
  'item.completed',
  'token_count',
  'thread_settings_applied',
  'user_message',
  'agent_message',
  'agent_reasoning',
  'context_compacted',
  'error'
])

const BIG_KEYS = new Set([
  'base_instructions',
  'encrypted_content',
  'thread_settings',
  'tools',
  'mcp_servers',
  'content',
  'aggregated_output',
  'last_agent_message',
  'output',
  'input',
  'message'
])

export interface CodexObserveContext {
  source: CodexObservationSource
  /** PingPet 读取该行的时间；不是 Codex 原始 eventTime */
  observedAt: number
  sourcePath?: string
  /** 明确的 session id（上一行继承的真实 id）。不得把文件名塞进这里。 */
  sessionId?: string
  /** 文件名等兜底；只有 payload 和 sessionId 都缺时才用 */
  fallbackSessionId?: string
  threadId?: string
  lineIndex?: number
  charOffset?: number
  byteOffset?: number
}

export interface CodexIngestResult {
  accepted: boolean
  reason: 'recorded' | 'duplicate'
  event: CodexObservationEvent
}

export interface CodexJsonlFileCursor {
  byteOffset: number
  feed: JsonlFeedState
}

export function emptyCodexJsonlFileCursor(): CodexJsonlFileCursor {
  return { byteOffset: 0, feed: emptyJsonlFeedState() }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const s = asString(value)
    if (s) return s
  }
  return undefined
}

/** ISO / 秒 / 毫秒都收；分辨不了的数字原样丢掉而不是猜。 */
export function coerceEventTimeMs(raw: unknown): number | undefined {
  if (typeof raw === 'string') {
    const t = Date.parse(raw)
    return Number.isFinite(t) ? t : undefined
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
  if (raw > 1e12) return raw
  if (raw > 1e9) return raw * 1000
  return undefined
}

function hashString(str: string): string {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i)
  }
  return (h >>> 0).toString(36)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const rec = value as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`
}

/** 截掉 MCP 工具表、长输出等，避免观察记录本身比会话还大。 */
export function summarizePayload(raw: unknown, depth = 0): unknown {
  if (raw === null || typeof raw !== 'object') {
    if (typeof raw === 'string' && raw.length > 240) return `${raw.slice(0, 240)}…`
    return raw
  }
  if (depth >= 4) return '[truncated]'
  if (Array.isArray(raw)) {
    const head = raw.slice(0, 6).map((item) => summarizePayload(item, depth + 1))
    return raw.length > 6 ? [...head, `…+${raw.length - 6}`] : head
  }
  const rec = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const keys = Object.keys(rec).slice(0, 24)
  for (const key of keys) {
    const value = rec[key]
    if (BIG_KEYS.has(key) && (typeof value === 'string' || Array.isArray(value) || typeof value === 'object')) {
      if (typeof value === 'string') out[key] = value.length > 80 ? `${value.slice(0, 80)}…` : value
      else out[key] = `[omitted ${Array.isArray(value) ? value.length : 'object'}]`
      continue
    }
    out[key] = summarizePayload(value, depth + 1)
  }
  if (Object.keys(rec).length > 24) out._omittedKeys = Object.keys(rec).length - 24
  return out
}

function itemRecord(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null
  return asRecord(payload.item) ?? asRecord(payload.Item)
}

function extractIds(root: Record<string, unknown>, payload: Record<string, unknown> | null): {
  sessionId?: string
  threadId?: string
  turnId?: string
  itemId?: string
  itemKind?: string
  itemStatus?: string
  ordinal?: number
} {
  const item = itemRecord(payload) ?? itemRecord(root)
  const sessionId = pickString(
    payload?.session_id,
    root.session_id,
    payload?.sessionId,
    root.sessionId,
    payload?.id && payload?.type === undefined ? payload.id : undefined
  )
  const threadId = pickString(root.thread_id, root.threadId, payload?.thread_id, payload?.threadId)
  const turnId = pickString(root.turn_id, root.turnId, payload?.turn_id, payload?.turnId)
  const itemId = pickString(item?.id, item?.item_id, payload?.item_id, payload?.itemId)
  const itemKind = pickString(item?.type, item?.item_type, item?.itemType)
  const itemStatus = pickString(item?.status)
  const ordinal = asFiniteNumber(root.ordinal)
  return { sessionId, threadId, turnId, itemId, itemKind, itemStatus, ordinal }
}

function extractEventTime(root: Record<string, unknown>, payload: Record<string, unknown> | null): number | undefined {
  return (
    coerceEventTimeMs(root.timestamp) ??
    coerceEventTimeMs(root.ts) ??
    coerceEventTimeMs(payload?.timestamp) ??
    coerceEventTimeMs(payload?.started_at) ??
    coerceEventTimeMs(payload?.completed_at) ??
    coerceEventTimeMs(payload?.started_at_ms) ??
    coerceEventTimeMs(payload?.completed_at_ms)
  )
}

function evidenceFor(source: CodexObservationSource): CodexEvidenceOrigin {
  return source === 'exec_json' ? 'codex_exec_json' : 'codex_session_jsonl'
}

function buildDedupKey(
  event: Omit<CodexObservationEvent, 'dedupKey'>,
  ctx: CodexObserveContext
): string {
  const position = [
    ctx.sourcePath ?? '',
    ctx.byteOffset ?? '',
    ctx.lineIndex ?? '',
    ctx.charOffset ?? '',
    event.ordinal ?? ''
  ].join(':')
  const identity = [
    event.source,
    event.eventType,
    event.sessionId ?? '',
    event.threadId ?? '',
    event.turnId ?? '',
    event.itemId ?? '',
    event.eventTime ?? '',
    event.rawType ?? '',
    event.itemStatus ?? '',
    event.itemKind ?? ''
  ].join('|')
  return `${position}\x1f${identity}\x1f${hashString(stableStringify(event.payload))}`
}

function finishEvent(
  partial: Omit<CodexObservationEvent, 'dedupKey' | 'recognized'>,
  ctx: CodexObserveContext
): CodexObservationEvent {
  const recognized = partial.recognition === 'recognized'
  const draft: Omit<CodexObservationEvent, 'dedupKey'> = { ...partial, recognized }
  return { ...draft, dedupKey: buildDedupKey(draft, ctx) }
}

function sessionTopEventType(topType: string): CodexNormalizedEventType | null {
  switch (topType) {
    case 'session_meta':
      return 'session_meta'
    case 'response_item':
      return 'response_item'
    case 'turn_context':
      return 'turn_context'
    case 'token_usage_record':
      return 'token_usage_record'
    case 'world_state':
      return 'world_state'
    case 'compacted':
      return 'compacted'
    default:
      return null
  }
}

function eventMsgNormalizedType(payloadType: string): {
  eventType: CodexNormalizedEventType
  recognition: CodexParserRecognition
  parseNote?: string
} {
  const sessionNote = 'session JSONL event_msg; not an official exec --json top-level event'
  if (payloadType === 'task_started') {
    return { eventType: 'event_msg.task_started', recognition: 'recognized', parseNote: sessionNote }
  }
  if (payloadType === 'task_complete') {
    return { eventType: 'event_msg.task_complete', recognition: 'recognized', parseNote: sessionNote }
  }
  if (payloadType === 'turn_aborted') {
    return { eventType: 'event_msg.turn_aborted', recognition: 'recognized', parseNote: sessionNote }
  }
  if (payloadType === 'item_started' || payloadType === 'item.started') {
    return { eventType: 'event_msg.item_started', recognition: 'recognized', parseNote: sessionNote }
  }
  if (payloadType === 'item_updated' || payloadType === 'item.updated') {
    return { eventType: 'event_msg.item_updated', recognition: 'recognized', parseNote: sessionNote }
  }
  if (payloadType === 'item_completed' || payloadType === 'item.completed') {
    return { eventType: 'event_msg.item_completed', recognition: 'recognized', parseNote: sessionNote }
  }
  if (KNOWN_EVENT_MSG_TYPES.has(payloadType)) {
    return { eventType: 'event_msg.other', recognition: 'recognized', parseNote: sessionNote }
  }
  return {
    eventType: 'unsupported',
    recognition: 'unsupported',
    parseNote: `unmapped event_msg payload.type=${payloadType}`
  }
}

function isJsonRpcEnvelope(root: Record<string, unknown>): boolean {
  if (root.jsonrpc !== undefined) return true
  const method = asString(root.method)
  return Boolean(method && (root.params !== undefined || root.id !== undefined) && root.type === undefined)
}

/**
 * 把一个已解析的 JSON 对象收成观察事件。
 * 数组 / 非对象不会走到这里；半行和坏行走 parseCodexJsonlLine。
 */
export function parseCodexObservation(raw: unknown, ctx: CodexObserveContext): CodexObservationEvent {
  const root = asRecord(raw)
  const observedAt = ctx.observedAt
  const source = ctx.source
  const origin = evidenceFor(source)

  if (!root) {
    return finishEvent(
      {
        source,
        eventType: 'unsupported',
        observedAt,
        payload: summarizePayload(raw),
        recognition: 'unsupported',
        evidenceOrigin: origin,
        rawType: typeof raw,
        sessionId: ctx.sessionId ?? ctx.fallbackSessionId,
        threadId: ctx.threadId,
        sourcePath: ctx.sourcePath,
        parseNote: 'value is not a JSON object'
      },
      ctx
    )
  }

  const payload = asRecord(root.payload)
  const topType = asString(root.type)
  const payloadType = asString(payload?.type)
  const ids = extractIds(root, payload)
  const eventTime = extractEventTime(root, payload)
  const sessionId = ids.sessionId ?? ctx.sessionId ?? ctx.fallbackSessionId
  const threadId = ids.threadId ?? ctx.threadId
  const sessionIdNote =
    !ids.sessionId && !ctx.sessionId && ctx.fallbackSessionId
      ? 'sessionId fell back to filename'
      : undefined
  const common = {
    source,
    observedAt,
    eventTime,
    sessionId,
    threadId,
    turnId: ids.turnId,
    itemId: ids.itemId,
    itemKind: ids.itemKind,
    itemStatus: ids.itemStatus,
    ordinal: ids.ordinal,
    sourcePath: ctx.sourcePath,
    payload: summarizePayload(raw),
    evidenceOrigin: origin
  }

  // 1) 仅官方点号顶层事件，且必须 source=exec_json。
  // thread_started / item_completed 等下划线顶层不得走这里。
  // 同一字符串在 session_jsonl 中不得伪装成官方事件。
  if (topType && OFFICIAL_TOP_TYPES.has(topType)) {
    if (source !== 'exec_json') {
      return finishEvent(
        {
          ...common,
          eventType: 'unknown',
          recognition: 'unknown',
          rawType: topType,
          parseNote: `top-level ${topType} is an official exec --json type; not recognized because source=${source}`
        },
        ctx
      )
    }
    return finishEvent(
      {
        ...common,
        eventType: topType as CodexNormalizedEventType,
        recognition: 'recognized',
        rawType: topType,
        parseNote: sessionIdNote
      },
      ctx
    )
  }

  // 2) App Server JSON-RPC 外层未确认，不解包成官方事件。
  if (isJsonRpcEnvelope(root)) {
    return finishEvent(
      {
        ...common,
        eventType: 'unsupported',
        recognition: 'unsupported',
        rawType: asString(root.method) ?? 'jsonrpc',
        parseNote: 'App Server JSON-RPC envelope is not parsed; protocol unconfirmed'
      },
      ctx
    )
  }

  // 2) 本地 session JSONL 信封
  if (topType === 'event_msg') {
    if (!payloadType) {
      return finishEvent(
        {
          ...common,
          eventType: 'unsupported',
          recognition: 'unsupported',
          rawType: 'event_msg',
          parseNote: 'event_msg missing payload.type'
        },
        ctx
      )
    }
    const mapped = eventMsgNormalizedType(payloadType)
    return finishEvent(
      {
        ...common,
        eventType: mapped.eventType,
        recognition: mapped.recognition,
        rawType: payloadType,
        parseNote: [mapped.parseNote, sessionIdNote].filter(Boolean).join('; ') || undefined
      },
      ctx
    )
  }

  if (topType && sessionTopEventType(topType)) {
    const eventType = sessionTopEventType(topType)!
    // session_meta 的 id/session_id 在 payload 里，上面 extractIds 对 payload.id 有戒心，这里补一次
    const metaSessionId =
      eventType === 'session_meta'
        ? pickString(payload?.session_id, payload?.id, sessionId)
        : sessionId
    const metaThreadId =
      eventType === 'token_usage_record' ? pickString(threadId, payload?.thread_id) : threadId
    return finishEvent(
      {
        ...common,
        sessionId: metaSessionId,
        threadId: metaThreadId,
        turnId: common.turnId ?? pickString(payload?.turn_id, payload?.root_turn_id),
        eventType,
        recognition: 'recognized',
        rawType: topType,
        parseNote: sessionIdNote
      },
      ctx
    )
  }

  if (topType) {
    return finishEvent(
      {
        ...common,
        eventType: KNOWN_SESSION_TOP_TYPES.has(topType) ? 'unsupported' : 'unknown',
        recognition: KNOWN_SESSION_TOP_TYPES.has(topType) ? 'unsupported' : 'unknown',
        rawType: topType,
        parseNote: [`unmapped top-level type=${topType}`, sessionIdNote].filter(Boolean).join('; ')
      },
      ctx
    )
  }

  return finishEvent(
    {
      ...common,
      eventType: 'unknown',
      recognition: 'unknown',
      parseNote: ['object has no type field', sessionIdNote].filter(Boolean).join('; ')
    },
    ctx
  )
}

export function parseCodexJsonlLine(
  line: JsonlFeedLine,
  ctx: Omit<CodexObserveContext, 'lineIndex' | 'charOffset'> & {
    lineIndex?: number
    charOffset?: number
  }
): CodexObservationEvent {
  const lineCtx: CodexObserveContext = {
    ...ctx,
    lineIndex: ctx.lineIndex ?? line.lineIndex,
    charOffset: ctx.charOffset ?? line.charOffset
  }

  if (line.kind === 'object') {
    return parseCodexObservation(line.value, lineCtx)
  }

  const recognition: CodexParserRecognition = line.kind === 'malformed' ? 'malformed' : 'unsupported'
  const eventType: CodexNormalizedEventType = line.kind === 'malformed' ? 'malformed' : 'unsupported'
  return finishEvent(
    {
      source: ctx.source,
      eventType,
      observedAt: ctx.observedAt,
      sessionId: ctx.sessionId ?? ctx.fallbackSessionId,
      threadId: ctx.threadId,
      sourcePath: ctx.sourcePath,
      payload: { raw: line.raw.slice(0, 240) },
      recognition,
      evidenceOrigin: 'jsonl_malformed',
      rawType: line.kind,
      parseNote: line.kind === 'malformed' ? 'invalid JSON line' : 'JSONL value is not an object'
    },
    lineCtx
  )
}

function parsePartialLine(raw: string, ctx: CodexObserveContext): CodexObservationEvent {
  return finishEvent(
    {
      source: ctx.source,
      eventType: 'partial_line',
      observedAt: ctx.observedAt,
      sessionId: ctx.sessionId ?? ctx.fallbackSessionId,
      threadId: ctx.threadId,
      sourcePath: ctx.sourcePath,
      payload: { raw: raw.slice(0, 240) },
      recognition: 'partial',
      evidenceOrigin: 'jsonl_partial',
      rawType: 'partial_line',
      parseNote: 'incomplete JSONL line (no terminating newline or still invalid after flush)'
    },
    ctx
  )
}

export class CodexObservationJournal {
  private readonly events: CodexObservationEvent[] = []
  private readonly seen = new Set<string>()
  private feed: JsonlFeedState = emptyJsonlFeedState()
  private lastSessionId?: string
  private lastThreadId?: string
  private lastTurnId?: string
  private lastTurnOpen = false

  get recorded(): readonly CodexObservationEvent[] {
    return this.events
  }

  get leftover(): string {
    return this.feed.leftover
  }

  attachFeed(feed: JsonlFeedState): void {
    this.feed = { leftover: feed.leftover, lineCount: feed.lineCount, charOffset: feed.charOffset }
  }

  snapshotFeed(): JsonlFeedState {
    return { leftover: this.feed.leftover, lineCount: this.feed.lineCount, charOffset: this.feed.charOffset }
  }

  /** 已记录事件里出现过的 session / thread / turn / item id，供阶段 2 做关系，本阶段只暴露观察结果。 */
  relations(): { sessionIds: string[]; threadIds: string[]; turnIds: string[]; itemIds: string[] } {
    const sessionIds = new Set<string>()
    const threadIds = new Set<string>()
    const turnIds = new Set<string>()
    const itemIds = new Set<string>()
    for (const event of this.events) {
      if (event.sessionId) sessionIds.add(event.sessionId)
      if (event.threadId) threadIds.add(event.threadId)
      if (event.turnId) turnIds.add(event.turnId)
      if (event.itemId) itemIds.add(event.itemId)
    }
    return {
      sessionIds: [...sessionIds],
      threadIds: [...threadIds],
      turnIds: [...turnIds],
      itemIds: [...itemIds]
    }
  }

  observe(raw: unknown, ctx: CodexObserveContext): CodexIngestResult {
    const inherited: CodexObserveContext = {
      ...ctx,
      sessionId: ctx.sessionId ?? this.lastSessionId,
      fallbackSessionId: ctx.fallbackSessionId,
      threadId: ctx.threadId ?? this.lastThreadId
    }
    const event = parseCodexObservation(raw, inherited)
    return this.ingest(this.withInheritedTurn(event))
  }

  observeJsonl(chunk: string, ctx: Omit<CodexObserveContext, 'lineIndex' | 'charOffset'>): CodexIngestResult[] {
    const fed = feedJsonlText(chunk, this.feed)
    this.feed = fed.state
    const out: CodexIngestResult[] = []
    for (const line of fed.lines) {
      const lineCtx: CodexObserveContext = {
        ...ctx,
        sessionId: ctx.sessionId ?? this.lastSessionId,
        fallbackSessionId: ctx.fallbackSessionId,
        threadId: ctx.threadId ?? this.lastThreadId,
        lineIndex: line.lineIndex,
        charOffset: line.charOffset
      }
      const parsed =
        line.kind === 'object'
          ? parseCodexObservation(line.value, lineCtx)
          : parseCodexJsonlLine(line, lineCtx)
      out.push(this.ingest(this.withInheritedTurn(parsed)))
    }
    return out
  }

  /**
   * 把还没有换行的残留交出去。
   * 半行若碰巧是完整 JSON，记成正常事件；否则记 partial_line，不得丢弃。
   */
  flushLeftover(ctx: Omit<CodexObserveContext, 'lineIndex' | 'charOffset'>): CodexIngestResult | null {
    const leftover = this.feed.leftover
    if (!leftover.trim()) {
      this.feed = { ...this.feed, leftover: '' }
      return null
    }
    const flushed = flushJsonlFeed(this.feed)
    this.feed = flushed.state
    if (!flushed.line) return null
    const lineCtx: CodexObserveContext = {
      ...ctx,
      sessionId: ctx.sessionId ?? this.lastSessionId,
      fallbackSessionId: ctx.fallbackSessionId,
      threadId: ctx.threadId ?? this.lastThreadId,
      lineIndex: flushed.line.lineIndex,
      charOffset: flushed.line.charOffset
    }
    if (flushed.line.kind === 'object') {
      return this.ingest(this.withInheritedTurn(parseCodexObservation(flushed.line.value, lineCtx)))
    }
    return this.ingest(parsePartialLine(leftover, lineCtx))
  }

  private withInheritedTurn(event: CodexObservationEvent): CodexObservationEvent {
    if (event.turnId) return event
    if (!this.lastTurnOpen || !this.lastTurnId) return event
    if (OPEN_TURN_ITEM_TYPES.has(event.eventType)) {
      return { ...event, turnId: this.lastTurnId }
    }
    return event
  }

  private updateTurnCursor(event: CodexObservationEvent): void {
    if (event.eventType === 'thread.started' || event.eventType === 'session_meta') {
      this.lastTurnId = undefined
      this.lastTurnOpen = false
      return
    }
    if (event.eventType === 'turn.started' || event.eventType === 'event_msg.task_started') {
      this.lastTurnId = event.turnId
      this.lastTurnOpen = Boolean(event.turnId)
      return
    }
    if (TURN_TERMINAL_TYPES.has(event.eventType)) {
      this.lastTurnId = undefined
      this.lastTurnOpen = false
    }
  }

  private ingest(event: CodexObservationEvent): CodexIngestResult {
    if (this.seen.has(event.dedupKey)) {
      return { accepted: false, reason: 'duplicate', event }
    }
    this.seen.add(event.dedupKey)
    this.events.push(event)
    if (event.sessionId) this.lastSessionId = event.sessionId
    if (event.threadId) this.lastThreadId = event.threadId
    this.updateTurnCursor(event)
    return { accepted: true, reason: 'recorded', event }
  }
}

/**
 * 增量读一个 JSONL 文件。默认 source=session_jsonl，以保持现有本地 session / Monitor 影子路径。
 * 官方 exec --json 回放必须显式传入 source='exec_json'，不得靠文件名猜 sessionId。
 */
export function observeCodexJsonlFile(
  filePath: string,
  journal: CodexObservationJournal,
  cursor: CodexJsonlFileCursor,
  observedAt: number,
  maxBytes = 256_000,
  source: CodexObservationSource = 'session_jsonl'
): { cursor: CodexJsonlFileCursor; results: CodexIngestResult[]; eof: boolean } {
  const slice = readFileTextFromOffset(filePath, cursor.byteOffset, maxBytes)
  journal.attachFeed(cursor.feed)
  const ctx: Omit<CodexObserveContext, 'lineIndex' | 'charOffset'> = {
    source,
    observedAt,
    sourcePath: filePath,
    fallbackSessionId: source === 'session_jsonl' ? basename(filePath) : undefined,
    byteOffset: cursor.byteOffset
  }
  const results = journal.observeJsonl(slice.text, ctx)
  return {
    cursor: {
      byteOffset: slice.nextOffset,
      feed: journal.snapshotFeed()
    },
    results,
    eof: slice.eof
  }
}
