import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AGENT_FILE_FRESH_MS, AGENT_MAX_FILES_PER_SOURCE } from '@shared/defaults'
import type { CoverageSampleSelection, SessionReplayResult } from './codexReplay'
import {
  CODEX_REPLAY_OFFICIAL_TYPES,
  aggregateEventTypes,
  discoverCodexSessionFiles,
  explainOldPathOfflineLimits,
  listCodexSessionPaths,
  replayCodexSessionFile,
  selectCoverageSamples
} from './codexReplay'
import { findRecentFiles } from './findFiles'
import { discoverOfficialExecJsonl, officialExecMarkdown } from './codexOfficialDiscover'

export interface CodexRealReplaySummary {
  hasRealSessions: boolean
  fileCount: number
  officialVerdict: 'PASS' | 'PARTIAL' | 'BLOCKED'
  markdown: string
}

function iso(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : 'n/a'
}

function coverage(results: SessionReplayResult[], pred: (r: SessionReplayResult) => boolean): string {
  return results.some(pred) ? '本批样本出现' : '本批样本未出现，不能据此判断协议是否支持'
}

const SAMPLE_REASON_LABEL: Record<string, string> = {
  completed_session: '正常完成 session',
  item_or_tool_failure: '含 item/tool 失败',
  multi_turn: '多个连续 turn',
  recently_active: '最近活跃',
  older_history: '历史较旧',
  unknown_or_malformed: '含未知/malformed 行',
  incomplete_last_line: '最后一行不完整',
  large_incremental: '较大文件增量扫描'
}

export function buildCodexReplayMarkdown(args: {
  projectVersion: string
  investigatedAt: string
  codexVersionNote: string
  discovery: ReturnType<typeof discoverCodexSessionFiles>
  results: SessionReplayResult[]
  selection: CoverageSampleSelection
  official: ReturnType<typeof discoverOfficialExecJsonl>
}): string {
  const { discovery, results, selection, official } = args
  const sizes = discovery.files.map((f) => f.size)
  const mtimes = discovery.files.map((f) => f.mtimeMs).filter((n) => n > 0)
  const readable = discovery.files.filter((f) => f.readable).length
  const types = aggregateEventTypes(results)
  const officialSeen = CODEX_REPLAY_OFFICIAL_TYPES.filter((t) => (types[t] ?? 0) > 0)
  const verdicts = new Map<string, number>()
  for (const result of results) {
    for (const row of result.comparisons) {
      verdicts.set(row.verdict, (verdicts.get(row.verdict) ?? 0) + 1)
    }
  }

  const lines: string[] = []
  const push = (s = '') => lines.push(s)
  const conclusion =
    discovery.files.length === 0 ? 'BLOCKED' : official.verdict === 'BLOCKED' ? 'PARTIAL' : official.verdict

  push('# Codex 影子路径真实 session 对照（阶段 4B）')
  push()
  push('## 1. 执行结论')
  push()
  push(`**${conclusion}**`)
  push()
  if (discovery.files.length === 0) {
    push('本机未找到可回放的真实 Codex session JSONL，因此不能声称真实协议已验证。')
  } else {
    push(
      '已对真实本地 session JSONL 按事件覆盖抽样回放，并实现在线双轨诊断。官方 `codex exec --json` 点号事件流仍未验证（如有候选文件，仅为疑似，仍需人工或真实回放确认）。不具备进入 Monitor 行为替换阶段的条件。'
    )
    push()
    push('官方 exec JSONL 尚未验证，因此不能进入 Monitor 行为替换阶段。')
    push()
    push('当前在线双轨可做到 session 级对照，尚不能做到完整 turn 级一一对应。')
  }
  push()
  push('## 2. 官方 exec JSONL 可用性')
  push()
  for (const line of officialExecMarkdown(official)) push(line)
  push()
  push('本地 `~/.codex/sessions` 里的 `session_meta` / `event_msg.*` 不是 `codex exec --json` 官方点号事件。本机没有 CLI ≠ 协议没有这些事件。')
  push()
  push('## 3. 调查日期、项目版本、Codex 版本')
  push()
  push(`- 调查日期：${args.investigatedAt}`)
  push(`- 项目版本：${args.projectVersion}`)
  push(`- Codex 版本：${args.codexVersionNote}`)
  push()
  push('## 4. 目录概况（全部 session 文件，不等于已回放）')
  push()
  push('- 扫描目录：`$HOME/.codex/sessions`（通过 `codexSessionsRoot()`，报告不写绝对路径）')
  push(`- 目录存在：${discovery.rootExists ? '是' : '否'}`)
  push(`- session 文件数量：${discovery.files.length}`)
  push(`- 可 stat/打开：${readable}`)
  if (sizes.length) {
    push(`- 文件大小范围：${Math.min(...sizes)} – ${Math.max(...sizes)} 字节`)
    push(`- 最早 mtime：${iso(Math.min(...mtimes))}`)
    push(`- 最晚 mtime：${iso(Math.max(...mtimes))}`)
  }
  push(`- 本报告没有回放全部 ${discovery.files.length} 个 session。`)
  push()
  push('### 文件检查分层（禁止把未检查写成不支持）')
  push()
  push(`- 已检查的文件（目录 stat）：${discovery.files.length}`)
  push(`- 详细回放的文件：${results.length}`)
  push(`- 探测过（读头部/抽样，超大文件不整文件载入）：${selection.probedCount}`)
  push(`- 只做目录统计 / 未详细回放：${selection.notReplayedCount}`)
  push(`- 因体积跳过探测、只记 size/mtime：${selection.skippedProbeCount}`)
  push(
    `- 官方 JSONL 发现器因扫描上限没有检查全部文件：${official.scanBounds.anyHitFileCap ? '是' : '否'}`
  )
  push('- 样本未出现 / 无法确认 / 协议尚未验证：见第 12–13 节。当前扫描未找到 ≠ Codex 不支持。')
  push()
  push('## 5. 详细回放样本选择')
  push()
  push(selection.note)
  push(`- 探测过的文件：${selection.probedCount}（超大文件只记 size/mtime，不整文件载入）`)
  push(`- 因体积跳过探测：${selection.skippedProbeCount}`)
  push()
  push('| 别名 | 选择原因 | 大小 | 回放上限 |')
  push('|---|---|---:|---:|')
  for (const result of results) {
    const reasons = (result.selectionReasons ?? []).map((r) => SAMPLE_REASON_LABEL[r] ?? r).join('；')
    push(`| ${result.alias} | ${reasons || '—'} | ${result.size} | ${result.replayedBytes} |`)
  }
  if (!results.length) push('| （无） | | | |')
  push()
  push('## 6. 未回放的文件')
  push()
  push(`- 未做详细对照的文件数：${selection.notReplayedCount}`)
  push('- 未回放原因：未命中覆盖桶、或已有同类样本、或体积过大只做目录统计。')
  push('- 未回放 ≠ 无事件；不能把未抽样文件写成“已验证”。')
  push()
  push('## 7. 本批样本事件类型统计')
  push()
  push('统计仅来自上面的详细回放样本，不是目录全部 文件。官方点号事件只在 `codex exec --json` 顶层出现。')
  push()
  push('| 事件类型 | 次数 | 类别 |')
  push('|---|---:|---|')
  for (const [type, n] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
    const kind = (CODEX_REPLAY_OFFICIAL_TYPES as readonly string[]).includes(type)
      ? '官方结构化'
      : type.startsWith('event_msg.') || type === 'session_meta' || type === 'response_item'
        ? '本地 session JSONL'
        : type === 'unknown' || type === 'malformed' || type === 'unsupported' || type === 'partial_line'
          ? '未识别/损坏'
          : '其他信封'
    push(`| \`${type}\` | ${n} | ${kind} |`)
  }
  if (!Object.keys(types).length) push('| （无） | 0 | |')
  push()
  push(`本批样本中出现过的官方点号事件：${officialSeen.length ? officialSeen.map((t) => `\`${t}\``).join(', ') : '无'}`)
  push()
  push('## 8. 旧路径与新路径对照表')
  push()
  for (const result of results) {
    push(`### ${result.alias}`)
    push()
    push(`- 选择原因：${(result.selectionReasons ?? []).map((r) => SAMPLE_REASON_LABEL[r] ?? r).join('；') || '—'}`)
    push(`- 大小：${result.size} 字节；回放 ${result.replayedBytes} 字节；截断=${result.truncated}`)
    push(`- 标识存在：session_id=${result.hasSessionId} thread_id=${result.hasThreadId} turn_id=${result.hasTurnId}`)
    push(
      `- 新路径终态：lifecycle=\`${result.newFinal.lifecycle}\` cause=\`${result.newFinal.cause}\` item=\`${result.newFinal.item}\` taskSemantics=\`${result.newFinal.taskSemantics}\``
    )
    if (result.truncated && result.newFinal.lifecycle === 'running') {
      push('- 截断回放停在 running，不能写成 Agent 仍在运行。')
    }
    push('- 标识：sessionKey 仅 session 级；threadId/turnId 仅在原始事件提供时记录，缺失为 unknown。')
    push(
      `- 旧路径识别事件：${result.oldEvents.length}（生产可见 ${result.oldEvents.filter((e) => e.ignoredByProduction.length === 0).length}；其余为生产不可见）`
    )
    push()
    push('| 时间/事件 | 旧路径 | 新影子路径 | 是否一致 | 证据 | 是否影响用户行为 |')
    push('|---|---|---|---|---|---|')
    for (const row of result.comparisons) {
      push(
        `| ${row.phase} | ${row.oldResult} | ${row.newResult} | ${row.verdict} | ${row.evidence} | ${row.userImpact} |`
      )
    }
    push()
  }

  push('## 9. 已确认的一致行为')
  push()
  push('- 本地 `event_msg.task_started` 与旧路径 `working` 都表示 turn 开始；新路径记 `running`，不映射成用户态。')
  push('- 本地 `event_msg.task_complete` 与旧路径 `done` 都表示收到结束信号；新路径只给 `completed_signal`，`taskSemantics` 保持 `not_verified`。')
  push('- 两条路径都不会把未知 JSON 当成成功。')
  push('- 在线双轨诊断与回放都不进入桌宠 / 气泡 / 声音。')
  push()
  push('## 10. 新检测器发现的新增信息')
  push()
  push('- item/tool 失败可保持 `running + tool_failed`，不把整轮标成 failed。')
  push('- 多维状态（cause / item / outputIntegrity / confidence）可与旧的单一 kind 对照。')
  push('- 从文件头回放历史 session，不受 120s freshness 和 96KB tail 限制。')
  push('- 旧路径被 freshness/tail 忽略时标记为「生产不可见」，不是「无事件」。')
  push()
  push('## 11. 误判或漏判候选')
  push()
  push('- 旧路径：`turn_aborted` 一律 `failed`；新路径在缺少明确用户取消词时为 `unknown`。')
  push('- 本地 session 出现 `turn_aborted` ≠ 已确认用户取消协议。')
  push('- 旧路径：assistant 文本匹配 `classifyStopText` 时可能给出 `done`/`needs_attention`/`failed`，这不是任务语义完成。')
  push('- 旧路径：历史文件上的事件会被 freshness/tail/最近文件上限丢掉；报告必须写生产不可见。')
  push('- 新检测器误判候选：仅在对照表里出现“后一轮仍是 partial_failure”时成立；本批以表内 verdict 为准。')
  push()
  push('## 12. 尚未被真实样本覆盖的状态 / 官方事件')
  push()
  push(`- 正常 turn 完成：${coverage(results, (r) => r.turnCompletedCount > 0)}`)
  push(`- 单个 item/tool 失败后 turn 继续：${coverage(results, (r) => r.itemFailedCount > 0)}`)
  push(`- item 失败后 turn 正常完成：${coverage(results, (r) => r.itemFailedCount > 0 && r.turnCompletedCount > 0)}`)
  push(`- 多个 turn 连续：${coverage(results, (r) => r.turnStartedCount >= 2)}`)
  push(`- 输出被截断或最后一行不完整：${coverage(results, (r) => r.truncated)}`)
  push(`- 未知事件 / malformed：${coverage(results, (r) => r.unknownCount + r.malformedCount + r.unsupportedCount > 0)}`)
  push(`- session/thread/turn id 缺失：${coverage(results, (r) => !r.hasSessionId || !r.hasThreadId || !r.hasTurnId)}`)
  push('- 进程退出但没有完整终态：本批只回放 session JSONL，没有进程 exit 证据。本批样本未出现，不能据此判断协议是否支持。')
  push()
  push('官方 `codex exec --json` 事件（无真实官方流时一律如下）：')
  push()
  for (const name of official.unverifiedOfficialEvents) {
    push(`- \`${name}\`：本批样本未出现，不能据此判断协议是否支持。`)
  }
  push()
  push('## 13. 未知、无法确认和证据不足')
  push()
  push(`- 对照 verdict 计数：${[...verdicts.entries()].map(([k, n]) => `${k}=${n}`).join('；') || '无'}`)
  push('- 没有进程级 exit/signal，不能对“进程退出”下结论。')
  push('- 没有把 assistant 正文当任务成功或失败。')
  push('- 官方结构化事件在本批回放中未作为真实 exec --json 验证。')
  push('- 禁止把「当前扫描未找到」写成「Codex 不支持」。协议尚未验证 ≠ 协议不支持。')
  push('- 禁止把「截断回放停在 running」写成「Agent 仍在运行」。')
  push()
  push('## 14. 时间字段语义与关联级别')
  push()
  push('- `eventTime`：原始 Codex 事件自身携带的时间（若存在）。缺失则为 null/unknown，不得猜测。')
  push('- `observedAt`：PingPet 读取和处理该事件的时间。')
  push('- `migration.observedAt`：检测器应用该事件的时间（PingPet）。')
  push('- 影子诊断不得把 `observedAt` 伪装成 `eventTime`。')
  push('- `sessionKey`：可用于 session 级关联。')
  push('- `threadId` / `turnId`：只有原始事件确实提供时才记录；缺失保留 unknown。')
  push('- 不得从文件名、sessionKey 或时间戳猜造 threadId/turnId。')
  push('- 当前在线双轨可做到 session 级对照，尚不能做到完整 turn 级一一对应。')
  push()
  push('## 15. 诊断文件长期运行风险（最小说明）')
  push()
  push('- 单文件上限：8MB（`CODEX_DIAGNOSTIC_MAX_FILE_BYTES`）。')
  push('- 超过上限后：停止追加，不轮转、不删除旧文件。')
  push('- 同步 `appendFileSync`：高频 item 事件可能短暂阻塞主进程；当前未见明显拖慢 Monitor，本轮不改异步。')
  push('- 进程重启后：内存去重丢失，同一 observationId 可能再写一次。')
  push('- 诊断失败：写入异常被吞掉，不影响 Monitor / onEvent / 桌宠。')
  push('- 当前暂不轮转：这是对照诊断，不是日志平台；扩成轮转/采样会改变诊断边界，留给后续。')
  push('- 方案 A：只把 `source=codex` 的旧事件写入 `codex-legacy.jsonl`；Claude/Cursor/Grok 不混入。')
  push('- 两条路径写不同文件（`codex-legacy.jsonl` / `codex-shadow.jsonl`），互不影响。')
  push()
  push('## 16. 是否具备进入 Monitor 行为替换阶段的条件')
  push()
  push('**否。** 官方 exec JSONL 尚未验证，因此不能进入 Monitor 行为替换阶段。')
  push()
  push('## 17. 脱敏说明')
  push()
  push('- 报告只用 `session-001` 这类别名。')
  push('- session/thread/turn/file 如出现，已哈希为 `sess-` / `th-` / `turn-` / `file-` 前缀。')
  push('- 未输出 prompt、assistant 正文、命令、文件内容、token 或绝对路径。')
  push('- 真实 JSONL 没有复制进仓库，也没有上传。')
  push()
  push('## 附录：旧路径离线限制')
  push()
  for (const item of explainOldPathOfflineLimits()) push(`- ${item}`)
  push()
  push(`- 生产最近文件扫描上限：${AGENT_MAX_FILES_PER_SOURCE}；mtime 窗口：${AGENT_FILE_FRESH_MS}ms。`)
  return lines.join('\n')
}

export function runCodexRealReplay(options?: { nowMs?: number; detailLimit?: number }): CodexRealReplaySummary {
  const discovery = discoverCodexSessionFiles()
  const paths = listCodexSessionPaths()
  const nowMs = options?.nowMs ?? Date.now()
  const recentScanPaths = findRecentFiles(
    discovery.root,
    ['.jsonl'],
    AGENT_MAX_FILES_PER_SOURCE,
    8,
    { minMtimeMs: nowMs - AGENT_FILE_FRESH_MS }
  )
  const official = discoverOfficialExecJsonl({
    projectRoot: resolve(process.cwd())
  })
  const selection = selectCoverageSamples({
    paths,
    aliases: discovery.files.map((f) => f.alias),
    nowMs,
    maxDetail: options?.detailLimit ?? 8
  })
  const detail: SessionReplayResult[] = selection.picks.map((pick) =>
    replayCodexSessionFile(pick.filePath, pick.alias, {
      nowMs,
      recentScanPaths,
      maxBytes: pick.maxBytes,
      maxBytesPerSlice: 256_000,
      selectionReasons: pick.reasons
    })
  )
  return {
    hasRealSessions: discovery.files.length > 0,
    fileCount: discovery.files.length,
    officialVerdict: official.verdict,
    markdown: buildCodexReplayMarkdown({
      projectVersion: '0.6.2',
      investigatedAt: new Date(nowMs).toISOString().slice(0, 10),
      codexVersionNote:
        '本机 `codex` CLI 不可用；~/.codex/config.toml 仅能看到本地 model 名，不能当作 Codex 应用版本',
      discovery,
      results: detail,
      selection,
      official
    })
  }
}

export function writeCodexReplayDocs(outPath: string, summary: CodexRealReplaySummary): void {
  writeFileSync(outPath, summary.markdown)
}

export function writeBlockedReplayDocs(outPath: string): void {
  const official = discoverOfficialExecJsonl({ projectRoot: resolve(process.cwd()) })
  writeFileSync(
    outPath,
    [
      '# Codex 影子路径真实对照（BLOCKED）',
      '',
      '## 1. 执行结论',
      '',
      '**BLOCKED**',
      '',
      '本机没有可读取的真实 Codex session JSONL，因此不能声称真实协议已验证，也不能用仓库 fixture 冒充。',
      '',
      '官方 exec JSONL 尚未验证，因此不能进入 Monitor 行为替换阶段。当前扫描未找到 ≠ Codex 不支持。',
      '',
      '## 2. 官方 exec JSONL 可用性',
      '',
      ...officialExecMarkdown(official),
      '',
      '## 已检查的 session 目录',
      '',
      '- `codexSessionsRoot()` → `$HOME/.codex/sessions`',
      '- 未把真实路径写入报告。',
      ''
    ].join('\n')
  )
}
