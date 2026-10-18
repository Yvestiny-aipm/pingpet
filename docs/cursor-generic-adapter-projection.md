# Cursor → 通用层 Adapter 投影（阶段 3）

调查日期：2026-09-14。  
文档性质：只读投影说明。本阶段**不接入 Monitor**，不改变 `scanCursor` 语义，不改变用户可见行为。

对照：

- 通用设计：`docs/通用Agent状态层设计方案.md`
- Codex 投影先例：`docs/codex-generic-adapter-projection.md`
- 实现：`src/main/agent/generic/cursorAdapter.ts`

---

## 1. Cursor 当前真实链路

旧路径（本轮未改）：

```text
~/.cursor/projects/<slug>/agent-transcripts/<sid>/<sid>.jsonl
  → scanCursor / parseCursorFile（只看最后一行）
  → 旧 kind：working / done / needs_attention / failed
  → AgentMonitor
  → handleAgentEvent → 桌宠 / 气泡 / 完成音
```

末行规则：

| 最后一行 | 旧 Monitor |
|---|---|
| `type=turn_ended` 且 `status=success` | `done`；文本可改 `needs_attention` |
| `type=turn_ended` 且 `status=aborted` | `failed` / `interrupted` |
| `type=turn_ended` 且 `status=error` 或其他 | `failed` / `error` |
| 老格式：末行纯文本 assistant | `done`（当 success） |
| assistant + `tool_use` / user / 其他 | `working` |
| `subagents/` | 不产出 |

行内没有时间戳。旧路径用 **mtime** 当 `timestampMs`，用 **文件名** 当 `sessionKey=cursor:<basename>`。这两项都不是通用层的 `eventTime` / `sessionRef`。

`parseCursorFile` 未导出。本轮 **没有** 修改 `scanCursor` 来制造新输入。

---

## 2. Cursor Adapter 输入和输出

输入是独立的最小封装 `CursorAdapterInput`，只表示**已经存在的解析结果和证据**：

| 可接收 | 不可接收 |
|---|---|
| 现有末行种类、`turn_ended.status` | 直接读 Cursor 文件 / 扫目录 |
| 调用方已明确的 `userCancelled` | 重新执行 `classifyStopText` |
| 已脱敏的 `textHint` | 把旧 `done` 当成任务成功 |
| 真实提供的 session / turn / item 标识 | 用文件名、mtime 伪造 `turnRef` |
| 现有稳定 `dedupKey`、观察时间 | 从一行 assistant 正文推导任务完成 |
| 已有连接状态（如 stale） | 复用 Codex 的 turn/item/event 规则 |
| 结构字段存在性 | 写入 prompt / 命令 / 路径 / token / 全文 |

输出：

| 输出 | 含义 |
|---|---|
| `AgentObservation` | 这一次末行被看到了什么 |
| `AgentDerivedState` | 各维度的通用存在性表示 |

Adapter **不**读 `~/.cursor`，不调用 `scanCursor`，不启动 Monitor，不发送旧事件。

默认 registry 仍是空表。测试里可以手动 `register(createCursorTranscriptBoundary())`。应用启动路径不得调用 `register`。

---

## 3. Cursor 事件到通用状态的映射

### 3.1 身份与通道

| 项 | 值 |
|---|---|
| `agentId` | `cursor` |
| `adapterId` | `cursor-transcript` |
| 通用 channel | `transcript_file` |
| `evidenceOrigin` | `cursor_transcript` |

不得复用 Codex 的 `session_file`、`official_stream`、`exec_json`、`session_jsonl`，也不得使用 Codex event name（`turn.started` / `turn.completed` / `event_msg.*`）。

`eventName` 只用 Cursor 自己的末行名：`turn_ended`、`assistant_text`、`assistant_tool_use`、`user`、`other`。

### 3.2 `AgentObservation`

| 通用字段 | 映射 |
|---|---|
| `recognition` | `turn_ended` / tool_use / user = recognized；纯文本 = partial；other = unknown |
| `confidence` | 结构化末行 `medium`；纯文本 / 关键词 `low`。文本不得 `high` |
| `observedAt` | PingPet 观察时间 |
| `eventTime` | 仅原始输入明确提供且来源不是 mtime / observedAt |
| `sessionRef` / `turnRef` / `itemRef` | 仅 `acceptIdentityRef(..., 'payload')`；缺省来源按 filename 丢弃 |
| `dedupKey` | 调用方给出的现有稳定标识 |
| `payloadDigest` | 只记结构键是否存在，`redacted: true` |

### 3.3 `AgentDerivedState`

| 输入 | lifecycle | 其他维度 |
|---|---|---|
| 末行仍在工作（tool_use / user / other） | `running` | session=active（有 payload session 时）；turn=`in_progress`；`taskSemantics=not_verified` |
| 结构化 `turn_ended/success` | `completed_signal` | turn=`completed`；retryability=`unknown`；**不是 succeeded** |
| 老格式 / 文本 success、done | `completed_signal` | confidence=`low`；turn 无结构则 unknown；**不是 succeeded** |
| 明确整轮 `turn_ended/error` | `failed` + `turn_failed` | **FIXTURE_ONLY**，见第 12 节 |
| 单 item / tool error | 保持 `running` | cause=`tool_failed`；item=`failed`；**不**把 turn 写成 failed |
| 普通 `aborted` | `unknown` | turn=`interrupted`；**不是** cancelled |
| 调用方明确 `userCancelled=true` | `cancelled` + `user_cancelled` | retryability=`user_action`；**FIXTURE_ONLY** |
| stale | 不改 lifecycle | 只改 `connection` |
| process | 通用 `unsupported` | `extension.process='not_observed'`；不产生 `process_exit` |

`taskSemantics` 一律 observed `not_verified`。不得由完成信号或文本升成 `completed` / 成功。

---

## 4. 结构化信号与文本关键词的可信度

| 证据 | confidence | 能否单独决定 lifecycle |
|---|---|---|
| `type=turn_ended` + status | `medium` | 可以。本轮不用 `high`：协议样本未在生产对照中验证 |
| 末行 tool_use / user | `medium` | 可以写成 `running` |
| 老格式末行纯文本、`textHint` | `low` | 最多 `completed_signal`；不得 `succeeded`，不得 `high` |
| 文件名 / mtime | 不进入标识 | 不得当 `sessionRef` / `turnRef` / `eventTime` |

结构化优先于低可信文本。例如 `turn_ended/success` + 文本 failed / needs_attention：lifecycle 仍是 `completed_signal`，冲突写入 `conflicts`。

Adapter **不**调用 `classifyStopText`。`textHint` 必须是调用方已经算好的脱敏结果。

---

## 5. success / done 与 `completed_signal` 的区别

旧路径：

- `turn_ended/success` 或老格式末行文本 → `kind=done` → 用户仍会看到完成气泡 / 完成音。

通用层：

- 同一信号最多是 `lifecycle=completed_signal`。
- 通用 lifecycle **没有** `succeeded`。
- `completed_signal` 只表示这一轮/这一行看起来结束了，不是任务成功。
- 文本判为 success / done **不会**把 confidence 抬成 high。
- 投影 **不会反向修改** 旧 `done`。旧 Monitor 继续收原事件。

---

## 6. aborted 与 `user_cancelled` 的区别

旧路径把 `turn_ended/aborted`（含 error 文案「用户取消」）一律映射为 `failed/interrupted`。那是兼容行为，不是已验证的用户取消协议。

通用层：

- 普通 aborted / interrupted → lifecycle/cause = `unknown`，turn = `interrupted`。
- 不得因为文案里有「用户取消」自动写成 `cancelled`。
- 只有输入字段 `userCancelled === true`（调用方已明确用户主动取消）才允许 `cancelled` + `user_cancelled` + `retryability=user_action`。
- 仓库没有真实 Cursor 用户取消协议样本：该分支标 **FIXTURE_ONLY**。

---

## 7. process / stale 的处理

- Cursor Adapter **不观察**外部进程退出。
- 不把「文件停止写入」当成进程退出。
- 能力表：`process = not_observed_by_adapter`。
- 通用 `process` 维度：`unsupported`。
- `extension.process = not_observed`。
- 不产生 `cause=process_exit`。

stale：

- 只写入 `connection=stale`。
- 不改变 lifecycle。
- 不把 stale 写成 failed。
- 不把 stale 写成 process_exit。

---

## 8. 旧 Monitor 兼容边界

| 项 | 本轮 |
|---|---|
| `scanCursor` | 未改，仍输出现有 kind |
| `AgentMonitor` / `handleAgentEvent` | 未改 |
| 旧 Cursor `done` | 保持；完成气泡 / 完成音不变 |
| 通用 `completed_signal` | 只存在于 Adapter 输出，不回写旧 done |
| 其他 Agent 的完成提示 | 不统一 |
| 生产 registry | 仍为空，不自动注册 Cursor Adapter |

不要把旧链路改成通用层链路。两套语义并存，本轮互不驱动。

---

## 9. 为什么本轮不接入生产

- 旧 `AgentMonitorEvent` 仍是用户可见路径。Cursor `done` 仍会触发完成展示。
- 投影尚未与旧 kind 做稳定对照（阶段 4）。
- `turn_ended/error` 与用户取消都还没有真实协议样本。
- 接入 Monitor 会改变事件形状或造成双写，超出阶段 3。
- 默认生产 registry 必须保持为空。

---

## 10. 如何回滚

删除：

- `src/main/agent/generic/cursorAdapter.ts`
- `src/main/agent/generic/cursorAdapter.test.ts`
- `docs/cursor-generic-adapter-projection.md`

如需一并撤销占位，只还原：

- `src/main/agent/generic/placeholders.ts` 里 `UNREGISTERED_CURSOR_TRANSCRIPT_*`
- `src/shared/agentObservation.ts` 里 channel `transcript_file`

不要回滚 `cursor.ts` / `monitor.ts` / `classify.ts`。它们本轮未改。

---

## 11. 阶段 4 新旧路径对照的前置条件

进入阶段 4 之前必须已经满足：

1. 本文件列出的投影用例稳定通过。
2. 现有 `cursor.test.ts` 以及全部旧 Agent 测试仍通过。
3. 生产 registry 仍为空；Monitor / 可见层无新引用。
4. 对照必须同时看：**旧 kind** 与 **通用 lifecycle**，不得用通用层改写旧 done。
5. `completed_signal` 对照旧 `done` 时，只能记「旧路径会完成展示，通用层未验证任务成功」。
6. 普通 aborted 对照旧 `failed/interrupted` 时，不得把通用层改成 failed 去迁就旧路径。
7. 仍不得读取用户真实 Cursor 目录来「补样本」。缺样本继续标 FIXTURE_ONLY。
8. 对照过程不得接入用户可见行为、不得改默认开关、不得自动重试。

---

## 12. 哪些结论只有 fixture / 单测证据

以下结论 **不得**声称已用真实 Cursor 协议验证：

| 结论 | 证据等级 |
|---|---|
| `turn_ended/success` → `completed_signal` | 现有扫描器形状 + 单测。真实任务是否成功：**未验证** |
| 老格式末行纯文本 → `completed_signal` | 现有启发式 + 单测。不是协议完成 |
| `turn_ended/error` → `failed` + `turn_failed` | **FIXTURE_ONLY**。设计方案仍写「待验证」 |
| `userCancelled=true` → `cancelled` | **FIXTURE_ONLY**。旧路径把「用户取消」文案只当 aborted 细节 |
| 单 item/tool error 不升 turn failed | 输入封装约定 + 单测。Cursor 文件本身几乎没有独立 item id |
| stale / process 未观察 | 能力声明 + 单测。Adapter 本轮不读文件、不看进程 |

真实 Cursor 是否还有其他 `status`、官方取消事件、item 级失败：**UNCONFIRMED**。不要为了制造样本而修改 Cursor 配置或破坏真实会话。
