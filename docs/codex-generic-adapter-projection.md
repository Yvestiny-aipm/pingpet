# Codex → 通用层 Adapter 投影（阶段 2）

调查日期：2026-09-14。  
文档性质：只读投影说明。本阶段**不接入 Monitor**，不改变 Codex 检测器语义，不改变用户可见行为。

对照：

- 冻结：`docs/codex-state-model-freeze-and-peripheral-evidence.md`
- 通用设计：`docs/通用Agent状态层设计方案.md`
- 实现：`src/main/agent/generic/codexAdapter.ts`

---

## 1. Adapter 的输入和输出

输入必须已经是 Codex 专用层的结果：

| 输入 | 来源 | Adapter 会不会再解析 |
|---|---|---|
| `CodexObservationEvent` | `codexObserve` 已经认过的一行 | 否 |
| `CodexDerivedState` | `CodexStateDetector` 已经聚合过的状态 | 否 |

输出：

| 输出 | 含义 |
|---|---|
| `AgentObservation` | 这一行被看到了什么 |
| `AgentDerivedState` | 各维度的通用存在性表示 |

Adapter **不**读 `~/.codex/sessions`，不解析 JSONL，不调用 `observeCodexJsonlFile`，不启动进程，不发送旧 Monitor 事件。

默认 registry 仍是空表。测试里可以手动 `register(createCodexSessionShadowBoundary())`。应用启动路径不得调用 `register`。

---

## 2. 字段映射表

### 2.1 身份与通道

| Adapter | agentId | adapterId | 通用 channel | Codex source |
|---|---|---|---|---|
| session shadow | `codex` | `codex-session-shadow` | `session_file` | `session_jsonl` |
| exec JSONL | `codex` | `codex-exec-json` | `official_stream` | `exec_json` |

通用 channel 枚举不收录 Codex 源名 `exec_json`，以免污染阶段 1 类型。隔离靠 **不同的 adapterId + channel**。把 `exec_json` 事件交给 session Adapter（或反过来）会抛 `CodexAdapterChannelMismatchError`。

### 2.2 `CodexObservationEvent` → `AgentObservation`

| 通用字段 | 映射 |
|---|---|
| `agentId` | 固定 `codex` |
| `adapterId` / `channel` | 按事件 `source` 选 Adapter |
| `eventName` | 已有 `eventType` |
| `recognition` | 原值 |
| `evidenceOrigin` | `source`（`exec_json` 或 `session_jsonl`） |
| `confidence` | 复用检测器规则：官方 recognized=`high`，本地 recognized=`medium`，其余=`low` |
| `observedAt` | PingPet 观察时间 |
| `eventTime` | 仅当原始事件带有限数字；缺失则省略，不用 `observedAt` 填 |
| `sessionRef` / `threadRef` / `turnRef` / `itemRef` | 仅 `acceptIdentityRef(..., 'payload')`；`parseNote` 含 filename fallback 时丢掉 sessionRef |
| `dedupKey` | 原值 |
| `payloadDigest` | 只记结构键是否存在，`redacted: true` |

不写入：`sourcePath`、prompt、命令、路径、token、assistant 正文、candidate、legacy kind。

### 2.3 `CodexDerivedState` → `AgentDerivedState`

| 通用维度 | 规则 |
|---|---|
| `lifecycle` | `unknown`/`succeeded` → `{presence:'unknown'}`；其余 observed。**不产出 succeeded** |
| `cause` | 通用核心 cause 原样 observed；Codex 预留 cause 与 `unknown` → unknown；原值进 extension |
| `connection` / `session` / `turn` / `item` / `outputIntegrity` / `taskSemantics` / `retryability` | 值为 `unknown` 则 presence unknown，否则 observed |
| `process` | session/exec Adapter 均为 `{presence:'unsupported'}` |
| `confidence` / `observedAt` / `evidence` / `conflicts` | 保留 |
| `sessionRef` 等 | 检测器已有才抄，不猜造 |
| `extension` | `{ agent:'codex', process, cause, lifecycle }` 保留 Codex 专用原值 |

`taskSemantics=not_verified` 映射为 **observed `not_verified`**：这是检测器写出的明确事实，不是「任务成功未知所以维度不存在」。

---

## 3. observed / unknown / unsupported

| 情况 | 通用表示 | 例子 |
|---|---|---|
| Codex 有明确值 | `observed` | `lifecycle=running`，`cause=tool_failed` |
| 维度在范围内但证据不足 | `unknown` | 普通 abort 的 lifecycle；`retryability=unknown` |
| 当前 Adapter 声明不观察 | `unsupported` | session/exec 的 `process` |

`not_observed_by_adapter` 只描述 **这个 channel**。Codex Agent 并不永远没有 process；未来 `codex-process-hint` 仍可观察。

---

## 4. session_file 与 exec_json 的区别

- 本地 session JSONL 只进 `codex-session-shadow` / `session_file`。
- 官方 `codex exec --json` 只进 `codex-exec-json` / `official_stream`。
- 同一字符串出现在 session 文件里，不得改走 official_stream。这条规则仍由 Codex 专用层保证；投影只按已有 `source` 选通道。
- 两套 Adapter 都可以投影，但本轮都不注册到生产 registry，也不接入 Monitor。

---

## 5. process 维度

生产 Shadow **不**调用 `applyProcess`。检测器默认 `process=not_observed`。

投影：

1. 通用 `process` = `unsupported`（当前 channel 不观察外部进程）。
2. `extension.process` = 原始 `not_observed`（或检测器若被测试注入的 `exited`）。
3. 不把 `not_observed` 写成失败，不猜 PID/退出码，不产生 `process_exit`。

这不是「Codex 永远 unsupported process」。

---

## 6. 为什么投影不会改变 Codex 状态语义

- 不调用 `interpret()`，不重判 item/turn/取消。
- 先跑现有 `CodexStateDetector`，再抄结果。
- `completed_signal` 原样保留；通用 lifecycle 根本没有 `succeeded`。
- 工具失败仍是 `tool_failed` + 非 `failed` lifecycle。
- 普通 `turn_aborted(interrupted)` 仍是 unknown。
- stale 只出现在 `connection`。
- `taskSemantics` 保持 `not_verified`；`retryability` 不因完成信号变成 `never`。

若投影与检测器不一致，以检测器为准，应修投影而不是放宽 Codex。

---

## 7. 为什么本轮不接入 Monitor

- 旧 `AgentMonitorEvent` 仍是生产用户路径。
- Codex `done` 中性化、candidate 开关默认关，都还在旧链路上。
- 投影尚未与旧 kind 做稳定对照（阶段 4）。
- 接入 Monitor 会改变事件形状或双写风险，超出阶段 2。

---

## 8. 如何回滚

删除：

- `src/main/agent/generic/codexAdapter.ts`
- `src/main/agent/generic/codexAdapter.test.ts`
- `docs/codex-generic-adapter-projection.md`

如需一并撤销 exec 占位，只还原 `placeholders.ts` 里 `UNREGISTERED_CODEX_EXEC_JSON_*`。  
不要回滚 `codexState.ts` / `codexObserve.ts`。它们本轮未改。

---

## 9. 阶段 3 接入 Cursor 前的验收条件

1. 本文件列出的投影用例稳定通过。
2. 全部现有 `codex*.test.ts` 仍通过。
3. 生产 registry 仍为空；Monitor / 可见层无新引用。
4. Cursor Adapter 只投影 Cursor 自己的末行信号，不复用 Codex 事件名或 process 规则。
5. 不把 Cursor `turn_ended/success` 写成任务成功。
6. 不改 `scanCursor` 的旧 kind 输出。
