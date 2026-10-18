import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { AGENT_FILE_FRESH_MS, AGENT_SCAN_MAX_DEPTH, AGENT_TAIL_BYTES } from '@shared/defaults'
import type { AgentEventKind, AgentStopReason } from '@shared/types'
import { classifyStopText } from '../classify'
import { cursorProjectsRoot } from '../cursor'
import { readJsonlTail } from '../readJsonl'
import {
  compareShadowPair,
  reportContainsSensitiveText,
  UNMATCHED_CORRELATION,
  type ShadowComparisonRow,
  type ShadowDiffClass
} from './agentShadowComparison'
import {
  projectCursor,
  type CursorAdapterInput,
  type CursorLastLineKind,
  type CursorTextHintKind,
  type CursorTurnEndedStatus
} from './cursorAdapter'
import { observedValue } from './presence'

/**
 * 真实 Cursor transcript 离线只读回放（阶段 4.1）。
 *
 * 不改 scanCursor，不接 Monitor，不写诊断，不产生用户事件。
 * 报告只保留脱敏字段；原文只在内存里用于旧路径 classify，用完即丢。
 */

export const REAL_CURSOR_SAMPLE_UNAVAILABLE = 'REAL_CURSOR_SAMPLE_UNAVAILABLE'

export type CursorReplayEvidenceGrade =
  | 'REAL_CURSOR_TRANSCRIPT'
  | 'CODE_INFERENCE'
  | 'FIXTURE_ONLY'
  | 'SAMPLE_NOT_COVERED'
  | typeof UNMATCHED_CORRELATION

export interface CursorTranscriptReplayOptions {
  projectsRoot?: string
  nowMs?: number
  maxFiles?: number
  maxBytesPerFile?: number
  evidenceGrade?: CursorReplayEvidenceGrade
}

interface InternalTranscriptFile {
  absPath: string
  size: number
  mtimeMs: number
}

export interface CursorReplayLegacyResult {
  kind?: AgentEventKind
  reason?: AgentStopReason
  source: 'cursor'
  working: boolean
  done: boolean
  needs_attention: boolean
  failed: boolean
  noEvent: boolean
  ignoredByFreshness: boolean
  ignoredByTailTruncation: boolean
  ignoredByPrime: 'not_evaluated'
  ignoredByDedup: 'not_evaluated'
}

export interface CursorReplayObservationView {
  agentId: 'cursor'
  adapterId: string
  channel: string
  eventName: string
  recognition: string
  confidence: string
  evidenceOrigin: string
  evidenceKind?: string
  fieldNames: readonly string[]
  redacted: true
  sessionRefPresent: boolean
  turnRefPresent: boolean
  itemRefPresent: boolean
  eventTimePresent: boolean
  observedAt: number
  dedupKeySource: 'fileAlias+lastLineKind+status'
}

export interface CursorReplayDerivedView {
  lifecycle?: string
  cause?: string
  connection?: string
  process?: string
  session?: string
  turn?: string
  item?: string
  outputIntegrity?: string
  taskSemantics?: string
  retryability?: string
  confidence: string
  evidenceCount: number
  conflictCount: number
  observedAt: number
  extensionProcess?: unknown
}

export interface CursorReplaySample {
  sampleId: string
  fileAlias: string
  fileBytes: number
  mtimeIso: string
  truncated: boolean
  lastLineKind: CursorLastLineKind
  lastLineFieldNames: readonly string[]
  rawTypePresent: boolean
  payloadHasSessionRef: boolean
  payloadHasTurnRef: boolean
  payloadHasItemRef: boolean
  turnEndedStatus?: CursorTurnEndedStatus
  legacy: CursorReplayLegacyResult
  observation: CursorReplayObservationView
  derived: CursorReplayDerivedView
  comparison: Pick<
    ShadowComparisonRow,
    | 'diffClass'
    | 'maxCorrelationLevel'
    | 'sessionCorrelationLevel'
    | 'turnCorrelationLevel'
    | 'itemCorrelationLevel'
    | 'reason'
    | 'userVisible'
    | 'primeReplay'
    | 'canConcludeTaskSemantics'
  >
  evidenceGrade: CursorReplayEvidenceGrade
}

export interface CursorReplayReport {
  surveyedAt: number
  projectsRootExists: boolean
  transcriptFileCount: number
  selectedCount: number
  selectedReason: string
  maxBytesPerFile: number
  unavailable: boolean
  unavailableCode?: typeof REAL_CURSOR_SAMPLE_UNAVAILABLE
  fixtureUsed: boolean
  samples: CursorReplaySample[]
  diffCounts: Record<ShadowDiffClass, number>
  userVisibleEffects: {
    startedMonitor: false
    registeredProductionAdapter: false
    petChanged: false
    bubbleShown: false
    soundPlayed: false
    autoRetried: false
    userFileModified: false
  }
}

const STRUCTURAL_KEYS = ['type', 'role', 'status', 'session_id', 'sessionId', 'turn_id', 'turnId', 'item_id', 'itemId'] as const

function hashAlias(parts: Array<string | number>): string {
  return `file-${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 10)}`
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function messageOf(line: Record<string, unknown>): Record<string, unknown> {
  return line.message && typeof line.message === 'object' ? (line.message as Record<string, unknown>) : {}
}

function extractText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (item && typeof item === 'object') {
      const it = item as Record<string, unknown>
      if (it.type === 'text' && typeof it.text === 'string') parts.push(it.text)
    }
  }
  return parts.join('\n')
}

function hasToolUse(message: Record<string, unknown>): boolean {
  const content = message.content
  if (!Array.isArray(content)) return false
  return content.some(
    (item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'tool_use'
  )
}

function payloadString(line: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = line[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function lastLineKindOf(last: Record<string, unknown>): CursorLastLineKind {
  if (last.type === 'turn_ended') return 'turn_ended'
  if (last.role === 'assistant' && hasToolUse(messageOf(last))) return 'assistant_tool_use'
  if (last.role === 'assistant') return 'assistant_text'
  if (last.role === 'user') return 'user'
  return 'other'
}

function turnEndedStatusOf(last: Record<string, unknown>): CursorTurnEndedStatus | undefined {
  if (last.type !== 'turn_ended' || typeof last.status !== 'string') return undefined
  if (last.status === 'success' || last.status === 'aborted' || last.status === 'error') return last.status
  return undefined
}

function fieldNamesOf(last: Record<string, unknown>): string[] {
  return STRUCTURAL_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(last, key))
}

function walkTranscripts(dir: string, depth: number, maxDepth: number, out: InternalTranscriptFile[]): void {
  if (depth > maxDepth) return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    if (full.includes(`${sep}subagents${sep}`)) continue
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      walkTranscripts(full, depth + 1, maxDepth, out)
      continue
    }
    if (stat.isFile() && name.endsWith('.jsonl')) {
      out.push({ absPath: full, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
}

function listCursorTranscriptOverview(projectsRoot: string): {
  rootExists: boolean
  files: InternalTranscriptFile[]
} {
  if (!existsDir(projectsRoot)) return { rootExists: false, files: [] }
  const files: InternalTranscriptFile[] = []
  let slugs: string[]
  try {
    slugs = readdirSync(projectsRoot)
  } catch {
    return { rootExists: true, files: [] }
  }
  for (const slug of slugs) {
    const transcripts = join(projectsRoot, slug, 'agent-transcripts')
    if (existsDir(transcripts)) walkTranscripts(transcripts, 0, AGENT_SCAN_MAX_DEPTH, files)
  }
  return { rootExists: true, files }
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

function textHintFromClassify(kind: AgentEventKind | undefined): CursorTextHintKind | undefined {
  if (kind === 'needs_attention') return 'needs_attention'
  if (kind === 'failed') return 'failed'
  if (kind === 'done') return 'done'
  return undefined
}

/**
 * 旧路径末行规则的只读复现，与 parseCursorFile 对齐，但不导出事件 message/detail。
 */
export function replayLegacyCursorLastLine(
  last: Record<string, unknown>,
  lines: Record<string, unknown>[]
): { kind: AgentEventKind; reason?: AgentStopReason } {
  const endedByStatus = last.type === 'turn_ended'
  const endedByFinalText = !endedByStatus && last.role === 'assistant' && !hasToolUse(messageOf(last))
  if (!endedByStatus && !endedByFinalText) return { kind: 'working' }

  let body = ''
  for (const line of lines) {
    if (line.role !== 'assistant') continue
    const text = extractText(messageOf(line))
    if (text.trim()) body = text
  }
  const status = endedByStatus && typeof last.status === 'string' ? last.status : 'success'
  if (status === 'success') {
    const classified = classifyStopText(body)
    if (classified && classified.kind === 'needs_attention') {
      return { kind: 'needs_attention', reason: 'needs_input' }
    }
    return { kind: 'done', reason: 'completed' }
  }
  if (status === 'aborted') return { kind: 'failed', reason: 'interrupted' }
  return { kind: 'failed', reason: 'error' }
}

function dim(value: string | undefined): string | undefined {
  return value
}

export function replayCursorTranscripts(options: CursorTranscriptReplayOptions = {}): CursorReplayReport {
  const nowMs = options.nowMs ?? Date.now()
  const maxFiles = options.maxFiles ?? 3
  const maxBytesPerFile = options.maxBytesPerFile ?? AGENT_TAIL_BYTES
  const evidenceGrade = options.evidenceGrade ?? 'REAL_CURSOR_TRANSCRIPT'
  const projectsRoot = options.projectsRoot ?? cursorProjectsRoot()
  const overview = listCursorTranscriptOverview(projectsRoot)
  const selected = [...overview.files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles)
  const fixtureUsed = evidenceGrade === 'FIXTURE_ONLY'
  const userVisibleEffects = {
    startedMonitor: false as const,
    registeredProductionAdapter: false as const,
    petChanged: false as const,
    bubbleShown: false as const,
    soundPlayed: false as const,
    autoRetried: false as const,
    userFileModified: false as const
  }

  if (selected.length === 0) {
    return {
      surveyedAt: nowMs,
      projectsRootExists: overview.rootExists,
      transcriptFileCount: overview.files.length,
      selectedCount: 0,
      selectedReason: overview.rootExists
        ? 'root exists but no readable parent-session jsonl'
        : 'Cursor projects root does not exist',
      maxBytesPerFile,
      unavailable: true,
      unavailableCode: REAL_CURSOR_SAMPLE_UNAVAILABLE,
      fixtureUsed,
      samples: [],
      diffCounts: emptyCounts(),
      userVisibleEffects
    }
  }

  const samples: CursorReplaySample[] = []
  const diffCounts = emptyCounts()

  selected.forEach((file, index) => {
    const fileAlias = hashAlias([basename(file.absPath), file.size, Math.trunc(file.mtimeMs)])
    const lines = readJsonlTail(file.absPath, maxBytesPerFile)
    const truncated = file.size > maxBytesPerFile
    const ignoredByFreshness = file.mtimeMs < nowMs - AGENT_FILE_FRESH_MS
    const last = lines[lines.length - 1]
    const emptyFile = !last
    const lastLineKind: CursorLastLineKind = last ? lastLineKindOf(last) : 'other'
    const turnEndedStatus = last ? turnEndedStatusOf(last) : undefined
    const lastLineFieldNames = last ? fieldNamesOf(last) : []
    const sessionFromPayload = last ? payloadString(last, ['session_id', 'sessionId']) : undefined
    const turnFromPayload = last ? payloadString(last, ['turn_id', 'turnId']) : undefined
    const itemFromPayload = last ? payloadString(last, ['item_id', 'itemId']) : undefined
    const legacyParsed = last ? replayLegacyCursorLastLine(last, lines) : { kind: 'working' as const }
    const textHint =
      lastLineKind === 'assistant_text' || legacyParsed.kind === 'needs_attention' || legacyParsed.kind === 'failed'
        ? textHintFromClassify(legacyParsed.kind) ?? (lastLineKind === 'assistant_text' ? 'done' : undefined)
        : undefined

    const adapterInput: CursorAdapterInput = {
      observedAt: nowMs,
      lastLineKind,
      turnEndedStatus,
      textHint,
      userCancelled: false,
      connection: ignoredByFreshness ? 'stale' : undefined,
      dedupKey: `cursor:transcript:${fileAlias}:${lastLineKind}:${turnEndedStatus ?? 'none'}`,
      fieldNames: lastLineFieldNames,
      rawType: last && typeof last.type === 'string' ? last.type : undefined,
      payload: last
        ? Object.fromEntries(lastLineFieldNames.map((key) => [key, true]))
        : undefined,
      sampleKind: fixtureUsed ? 'FIXTURE_ONLY' : 'live',
      sessionRef: sessionFromPayload,
      sessionRefSource: sessionFromPayload ? 'payload' : undefined,
      turnRef: turnFromPayload,
      turnRefSource: turnFromPayload ? 'payload' : undefined,
      itemRef: itemFromPayload,
      itemRefSource: itemFromPayload ? 'payload' : undefined
    }
    const projected = projectCursor(adapterInput)
    const observation = projected.observations[0]
    const derived = projected.derived
    if (!observation || !derived) {
      throw new Error('cursor replay adapter returned no projection')
    }

    const comparison = emptyFile
      ? {
          diffClass: 'SAMPLE_NOT_COVERED' as const,
          maxCorrelationLevel: 'file' as const,
          sessionCorrelationLevel: 'unmatched' as const,
          turnCorrelationLevel: 'unmatched' as const,
          itemCorrelationLevel: 'unmatched' as const,
          reason: 'old path emits no event for empty transcript; this is not “Cursor has no state”',
          userVisible: false,
          primeReplay: false,
          canConcludeTaskSemantics: false as const
        }
      : compareShadowPair({
      evidenceGrade: fixtureUsed ? 'FIXTURE_ONLY' : 'REAL_CURSOR',
      compareAt: turnFromPayload ? 'turn' : undefined,
      legacy: {
        agentId: 'cursor',
        source: 'cursor',
        kind: legacyParsed.kind,
        reason: legacyParsed.reason,
        fileIdentity: fileAlias,
        sessionRef: sessionFromPayload,
        sessionRefSource: sessionFromPayload ? 'payload' : undefined,
        turnRef: turnFromPayload,
        turnRefSource: turnFromPayload ? 'payload' : undefined,
        itemRef: itemFromPayload,
        itemRefSource: itemFromPayload ? 'payload' : undefined,
        dedupKey: adapterInput.dedupKey,
        observedAt: nowMs,
        userVisible: false
      },
      generic: {
        agentId: 'cursor',
        source: 'cursor',
        fileIdentity: fileAlias,
        sessionRef: sessionFromPayload,
        sessionRefSource: sessionFromPayload ? 'payload' : undefined,
        turnRef: turnFromPayload,
        turnRefSource: turnFromPayload ? 'payload' : undefined,
        itemRef: itemFromPayload,
        itemRefSource: itemFromPayload ? 'payload' : undefined,
        dedupKey: adapterInput.dedupKey,
        observation,
        derived,
        observedAt: nowMs,
        userCancelled: false,
        textHint
      }
    })

    diffCounts[comparison.diffClass] += 1

    samples.push({
      sampleId: `sample-${String(index + 1).padStart(3, '0')}`,
      fileAlias,
      fileBytes: file.size,
      mtimeIso: new Date(file.mtimeMs).toISOString(),
      truncated,
      lastLineKind,
      lastLineFieldNames,
      rawTypePresent: typeof last?.type === 'string',
      payloadHasSessionRef: Boolean(sessionFromPayload),
      payloadHasTurnRef: Boolean(turnFromPayload),
      payloadHasItemRef: Boolean(itemFromPayload),
      turnEndedStatus,
      legacy: {
        kind: emptyFile ? undefined : legacyParsed.kind,
        reason: emptyFile ? undefined : legacyParsed.reason,
        source: 'cursor',
        working: !emptyFile && legacyParsed.kind === 'working',
        done: !emptyFile && legacyParsed.kind === 'done',
        needs_attention: !emptyFile && legacyParsed.kind === 'needs_attention',
        failed: !emptyFile && legacyParsed.kind === 'failed',
        noEvent: emptyFile,
        ignoredByFreshness,
        ignoredByTailTruncation: truncated,
        ignoredByPrime: 'not_evaluated',
        ignoredByDedup: 'not_evaluated'
      },
      observation: {
        agentId: 'cursor',
        adapterId: observation.adapterId,
        channel: observation.channel,
        eventName: observation.eventName,
        recognition: observation.recognition,
        confidence: observation.confidence,
        evidenceOrigin: observation.evidenceOrigin,
        evidenceKind: observation.evidenceKind,
        fieldNames: observation.payloadDigest.fieldNames,
        redacted: true,
        sessionRefPresent: Boolean(observation.sessionRef),
        turnRefPresent: Boolean(observation.turnRef),
        itemRefPresent: Boolean(observation.itemRef),
        eventTimePresent: observation.eventTime !== undefined,
        observedAt: observation.observedAt,
        dedupKeySource: 'fileAlias+lastLineKind+status'
      },
      derived: {
        lifecycle: dim(observedValue(derived.lifecycle)),
        cause: dim(observedValue(derived.cause)),
        connection: dim(observedValue(derived.connection)),
        process: derived.process.presence,
        session: dim(observedValue(derived.session)),
        turn: dim(observedValue(derived.turn)),
        item: dim(observedValue(derived.item)),
        outputIntegrity: dim(observedValue(derived.outputIntegrity)),
        taskSemantics: dim(observedValue(derived.taskSemantics)),
        retryability: dim(observedValue(derived.retryability)),
        confidence: derived.confidence,
        evidenceCount: derived.evidence.length,
        conflictCount: derived.conflicts.length,
        observedAt: derived.observedAt,
        extensionProcess: derived.extension?.process
      },
      comparison: {
        diffClass: comparison.diffClass,
        maxCorrelationLevel: comparison.maxCorrelationLevel,
        sessionCorrelationLevel: comparison.sessionCorrelationLevel,
        turnCorrelationLevel: comparison.turnCorrelationLevel,
        itemCorrelationLevel: comparison.itemCorrelationLevel,
        reason: comparison.reason,
        userVisible: comparison.userVisible,
        primeReplay: comparison.primeReplay,
        canConcludeTaskSemantics: comparison.canConcludeTaskSemantics
      },
      evidenceGrade
    })
  })

  return {
    surveyedAt: nowMs,
    projectsRootExists: overview.rootExists,
    transcriptFileCount: overview.files.length,
    selectedCount: samples.length,
    selectedReason: 'most recently modified parent-session jsonl, excluding subagents',
    maxBytesPerFile,
    unavailable: false,
    fixtureUsed,
    samples,
    diffCounts,
    userVisibleEffects
  }
}

export function renderCursorReplayMarkdown(report: CursorReplayReport): string {
  const lines = [
    '# Cursor real transcript offline replay',
    '',
    `surveyedAt=${new Date(report.surveyedAt).toISOString()}`,
    `rootExists=${report.projectsRootExists}`,
    `transcriptFileCount=${report.transcriptFileCount}`,
    `selectedCount=${report.selectedCount}`,
    `selectedReason=${report.selectedReason}`,
    `maxBytesPerFile=${report.maxBytesPerFile}`,
    `unavailable=${report.unavailable}`,
    `unavailableCode=${report.unavailableCode ?? 'none'}`,
    `fixtureUsed=${report.fixtureUsed}`,
    `diff=${JSON.stringify(report.diffCounts)}`,
    `userVisibleEffects=${JSON.stringify(report.userVisibleEffects)}`,
    ''
  ]
  if (report.unavailable) {
    lines.push(REAL_CURSOR_SAMPLE_UNAVAILABLE)
  }
  for (const sample of report.samples) {
    lines.push(
      `- ${sample.sampleId} alias=${sample.fileAlias} bytes=${sample.fileBytes} mtime=${sample.mtimeIso} truncated=${sample.truncated}`
    )
    lines.push(
      `  lastLine=${sample.lastLineKind} status=${sample.turnEndedStatus ?? 'none'} fields=${sample.lastLineFieldNames.join(',')}`
    )
    lines.push(
      `  refs session=${sample.payloadHasSessionRef} turn=${sample.payloadHasTurnRef} item=${sample.payloadHasItemRef}`
    )
    lines.push(
      `  legacy kind=${sample.legacy.kind} reason=${sample.legacy.reason ?? 'none'} freshnessIgnored=${sample.legacy.ignoredByFreshness} prime=${sample.legacy.ignoredByPrime} dedup=${sample.legacy.ignoredByDedup}`
    )
    lines.push(
      `  generic lifecycle=${sample.derived.lifecycle ?? 'unknown'} cause=${sample.derived.cause ?? 'unknown'} connection=${sample.derived.connection ?? 'unknown'} process=${sample.derived.process} taskSemantics=${sample.derived.taskSemantics} confidence=${sample.derived.confidence}`
    )
    lines.push(
      `  compare ${sample.comparison.diffClass} corr=${sample.comparison.maxCorrelationLevel} turnCorr=${sample.comparison.turnCorrelationLevel} visible=${sample.comparison.userVisible} evidence=${sample.evidenceGrade}`
    )
    lines.push(`  reason: ${sample.comparison.reason}`)
  }
  const text = lines.join('\n')
  if (reportContainsSensitiveText(text)) {
    throw new Error('cursor replay markdown contained sensitive text')
  }
  return text
}
