# Cursor 真实 transcript 离线回放（阶段 4.1）

调查日期：2026-09-14。  
文档性质：只读离线回放。不接入 Monitor，不改变用户可见行为。不把原始 transcript 写入仓库。

实现：`src/main/agent/generic/cursorTranscriptReplay.ts`

---

## 1. 调查日期和 Cursor 数据来源

- 调查日期：2026-09-14
- 来源由现有代码确认：`cursorProjectsRoot()` → `$HOME/.cursor/projects/<slug>/agent-transcripts/**/*.jsonl`
- 与 `scanCursor` 相同：忽略 `subagents/`（子任务结束 ≠ 用户任务结束）
- 本轮真实读取了 transcript 的 **有界 tail**（默认 96000 字节），没有整文件载入，没有复制原文进仓库

证据等级：下列 3 个样本为 `REAL_CURSOR_TRANSCRIPT`。这不等于「Cursor 协议已完整验证」。

---

## 2. 样本选择和范围

| 项 | 值 |
|---|---|
| projects 根目录是否存在 | 是 |
| 父会话 jsonl 数量（排除 subagents） | 25 |
| 实际选择 | 最近修改的 3 个 |
| 选择理由 | 优先最近可读父会话；不扫全部历史 |
| 读取方式 | `readJsonlTail`，上限 96000 字节 |
| 是否完整读取 | 否。3 个样本文件均大于上限，`truncated=true` |
| 是否存在真实样本 | 是 |
| 是否用 fixture 冒充真实结论 | 否。工具单测用 fixture，下文真实结论只用这 3 个样本 |

mtime 范围（所选 3 个）：2026-09-12T05:15:57Z → 2026-09-14T09:05:38Z

未回放其余 22 个父会话。未回放 ≠ 无事件。

---

## 3. 是否真实读取 transcript

是。只读打开所选文件的 tail，解析最后一行的结构字段（`type` / `role` / `status` 是否存在）。

未写入、未删除、未修改原文件。  
报告不含 prompt、命令、路径、token 或 assistant/用户正文。

---

## 4. 旧路径回放结果

旧路径规则复现自 `parseCursorFile`（该函数未导出；`scanCursor` 未改）。Monitor **未启动**，因此 prime / dedup **not_evaluated**。  
`ignoredByFreshness=true` 只表示：若此刻跑生产扫描，这些文件会因 mtime 超过 `AGENT_FILE_FRESH_MS`（4 分钟）被跳过。**不要写成 Cursor 没有状态。**

| 样本 | 大小 | 末行 | 旧 kind | reason | working/done/needs_attention/failed | freshness | tail | prime/dedup | 证据 |
|---|---:|---|---|---|---|---|---|---|---|
| sample-001 `file-1c2e3a4fa0` | 389186 | `user` | `working` | 无 | working | 会被忽略 | 截断 | 未评估 | `REAL_CURSOR_TRANSCRIPT` |
| sample-002 `file-f3abcd08be` | 1712103 | `turn_ended` / `success` | `done` | `completed` | done | 会被忽略 | 截断 | 未评估 | `REAL_CURSOR_TRANSCRIPT` |
| sample-003 `file-70e4fe5912` | 620056 | `turn_ended` / `success` | `done` | `completed` | done | 会被忽略 | 截断 | 未评估 | `REAL_CURSOR_TRANSCRIPT` |

本批未见旧路径 `needs_attention` 或 `failed`。

---

## 5. 通用 Adapter 回放结果

`CursorAdapterInput` 只含已解析的末行形状。`sessionRef` / `turnRef` / `itemRef` 仅在 payload 明确出现时填写；本批均为缺失。`eventTime` 未填（行内无时间戳，mtime 不得冒充）。`dedupKey` 来源：`fileAlias+lastLineKind+status`。`userCancelled` 未设为 true。

| 项 | sample-001 | sample-002 | sample-003 |
|---|---|---|---|
| observation.eventName | `user` | `turn_ended` | `turn_ended` |
| recognition | recognized | recognized | recognized |
| confidence | medium | medium | medium |
| evidenceOrigin | cursor_transcript | cursor_transcript | cursor_transcript |
| session/turn/item ref | 均无 | 均无 | 均无 |
| eventTime | 无 | 无 | 无 |
| lifecycle | running | completed_signal | completed_signal |
| cause | 无（unknown） | 无 | 无 |
| connection | stale | stale | stale |
| process | unsupported；extension `not_observed` | 同左 | 同左 |
| session | 无（无 payload sessionRef） | 无 | 无 |
| turn | in_progress | completed | completed |
| item | 无 | 无 | 无 |
| outputIntegrity | 无 | 无 | 无 |
| taskSemantics | not_verified | not_verified | not_verified |
| retryability | 无 | 无 | 无 |
| evidence | 1 | 1 | 1 |
| conflicts | 0 | 0 | 0 |
| 证据等级 | REAL_CURSOR_TRANSCRIPT | REAL_CURSOR_TRANSCRIPT | REAL_CURSOR_TRANSCRIPT |

未产生 `succeeded`。未产生 `user_cancelled`。未产生 `process_exit`。stale 只出现在 connection。

---

## 6. session / turn / item 关联级别

| 级别 | 本批 |
|---|---|
| file | 可以（脱敏 `fileAlias`） |
| session | **unmatched**（payload 无 session id；文件名不得当 sessionRef） |
| turn | **UNMATCHED_CORRELATION**（payload 无 turnRef；不得用 mtime/顺序伪造） |
| item | unmatched |

当前最多做 **file 级对照**。

---

## 7. 状态迁移

| 样本 | 旧 → 通用 |
|---|---|
| sample-001 | `working` → `running`；connection=`stale` |
| sample-002 | `done` → `completed_signal`；turn=`completed`；taskSemantics=`not_verified` |
| sample-003 | 同 sample-002 |

`completed_signal` 只表示结构化 `turn_ended/success` 或协议轮次结束，**不代表用户任务完成**，本轮回放也没有产生成功展示。

---

## 8. 差异分类

| 分类 | 计数 | 样本 |
|---|---:|---|
| CONSISTENT | 1 | sample-001 |
| LEGACY_COMPATIBILITY | 2 | sample-002、sample-003（旧 done 仍会完成展示；通用层未验证任务成功） |
| GENERIC_MORE_CONSERVATIVE | 0 | — |
| GENERIC_MORE_INFORMATIVE | 0 | — |
| POTENTIAL_BUG | 0 | — |
| SAMPLE_NOT_COVERED | 0 | 本批已关联的 3 条均能分类；其它状态见第 10 节 |
| UNMATCHED_CORRELATION | turn 级全部 unmatched | 不作为 file 级差异主类 |

---

## 9. 是否出现潜在 bug

**没有。** 本批没有结构化证据支持 `POTENTIAL_BUG`。

---

## 10. 哪些状态仍未覆盖

| 状态 | 本轮 |
|---|---|
| 末行 `user` → working/running | 已在真实 transcript 观察到 |
| `turn_ended/success` → done / completed_signal | 已在真实 transcript 观察到 |
| 老格式末行纯文本 assistant | 只有 fixture / 源码推断 |
| `turn_ended/aborted` | 本轮未覆盖（真实） |
| `turn_ended/error` | 本轮未覆盖（真实）；fixture 不得冒充协议 |
| 明确用户取消 | 本轮未覆盖；当前架构不会从文案推断 |
| 单 item/tool error | 本轮未覆盖；末行未见独立 item id |
| payload sessionRef/turnRef | 本批不存在；当前架构无法从文件名确认 |
| 新鲜窗口内、Monitor 会派发的样本 | 本批 3 个均 freshness 忽略；**不是「无状态」** |
| process / taskSemantics 验证 | 当前架构无法从 transcript 确认 |

---

## 11. 是否产生任何用户可见行为

否。

- 未启动 Monitor
- 未注册生产 Adapter
- 未改变桌宠 / 气泡 / 声音
- 未自动重试
- 未修改用户文件
- 对照行 `userVisible=false`

---

## 12. 阶段 5 是否具备条件

**不具备。**

理由：

1. 只回放了 3/25 个父会话，且均为有界 tail。
2. 未见真实 aborted / error / 用户取消 / item 失败。
3. 没有稳定 turnRef，不能做 turn 级生产对照。
4. 本批样本若走生产扫描会被 freshness 跳过；尚未证明「Monitor 正在看的那条」与通用层长期并排。
5. `taskSemantics` 仍全部 `not_verified`。
6. 统一用户可见层仍需单独产品决策。

---

## 回滚

删除：

- `src/main/agent/generic/cursorTranscriptReplay.ts`
- `src/main/agent/generic/cursorTranscriptReplay.test.ts`
- `docs/cursor-real-transcript-shadow-replay.md`

不要回滚 `cursor.ts` / Monitor / Adapter。它们本轮未改。

---

## 13. 追加样本：2026-09-14 第二轮（上一轮只读检查对话）

追加日期：2026-09-14（同日第二轮）。  
目的：对上一轮只读检查刚生成的父会话做并列回放。  
实现未改：仍用 `replayCursorTranscripts({ maxFiles: 1 })`。未改 `scanCursor`、Cursor Adapter、Monitor、生产 registry。

### 13.1 样本确认

| 项 | 值 | 证据 |
|---|---|---|
| 父会话 jsonl 数量（排除 subagents） | 26（上一轮为 25） | `REAL_CURSOR_TRANSCRIPT` |
| 本轮选择 | 最近修改的 1 个父会话 | `CODE_INFERENCE`：按 mtime 取最新 |
| 脱敏 alias | `file-9cbb3275ca` | 与上一轮 sample-001/002/003 的 alias 均不同 |
| 大小 | 15640 字节 | `REAL_CURSOR_TRANSCRIPT` |
| mtime | 2026-09-14T09:27:30.748Z | 晚于上一轮最新样本 09:05:38Z |
| 读取方式 | `readJsonlTail`，上限 96000 字节 | 与生产扫描器相同 |
| 是否完整读取 | **是**。文件小于上限，`truncated=false` | 上一轮 3 个样本均为截断 |
| 是否复制进仓库 | 否 | — |
| 是否上一轮新生成 | **是**。数量 +1，mtime 落在上一轮检查开始之后，且不是历史大文件 | `REAL_CURSOR_TRANSCRIPT` + `CODE_INFERENCE` |

上一轮 3 个样本结论全部保留，不覆盖。

### 13.2 结构（脱敏，只记有无）

有界读取得到完整 8 行。未输出 prompt、正文、路径、token。

| 结构 | 本文件是否出现 |
|---|---|
| `user` | 是（且为**末行**） |
| `assistant` 纯文本 | 是（非末行） |
| `assistant` + `tool_use` | 是（非末行） |
| `turn_ended` | 是（非末行） |
| `turn_ended.status=success` | 是（非末行） |
| `turn_ended.status=error` | 是（非末行） |
| `turn_ended.status=aborted` | 否 |
| payload `session_id` / `turn_id` / `item_id` | 末行均无 |

证据：`REAL_CURSOR_TRANSCRIPT`。  
**不得**把非末行的 `turn_ended/error` 当成当前观察点的 `failed`。旧路径和 Adapter 都只认最后一行。

### 13.3 旧路径结果

Monitor **未启动**。prime / dedup 仍为 `not_evaluated`。

| 项 | sample-004 `file-9cbb3275ca` |
|---|---|
| 末行 | `user` |
| 旧 kind | `working` |
| reason | 无 |
| working/done/needs_attention/failed | working |
| ignoredByFreshness | **false**（上一轮 3 个均为 true） |
| ignoredByTailTruncation | false |
| ignoredByPrime | not_evaluated |
| ignoredByDedup | not_evaluated |
| 证据 | `REAL_CURSOR_TRANSCRIPT` |

`ignoredByFreshness=false` 只表示：若此刻跑生产扫描，**不会**因 mtime 过期被跳过。这不等于 Monitor 一定会派发：首轮 prime 与 seenIds 未评估。不要写成「生产已经提醒了」。

### 13.4 通用 Adapter 结果

`userCancelled` 未设为 true。`eventTime` 未填。`itemOrToolFailed` 未设。`dedupKey` 来源仍是 `fileAlias+lastLineKind+status`。

| 项 | sample-004 |
|---|---|
| observation.eventName | `user` |
| recognition | recognized |
| evidenceKind | structured |
| confidence | medium |
| evidenceOrigin | cursor_transcript |
| adapterId / channel | `cursor-transcript` / `transcript_file` |
| sessionRef / turnRef / itemRef | 均无 |
| eventTime | 无 |
| lifecycle | running |
| cause | 无（unknown） |
| connection | 无（unknown；**不是** stale） |
| process | unsupported；extension `not_observed` |
| session | 无（无 payload sessionRef） |
| turn | in_progress |
| item | 无 |
| outputIntegrity | 无 |
| taskSemantics | not_verified |
| retryability | 无 |
| evidence | 1 |
| conflicts | 0 |
| 证据等级 | `REAL_CURSOR_TRANSCRIPT` |

未产生 `succeeded`。未产生 `failed`。未产生 `user_cancelled`。未产生 `process_exit`。  
文件里虽有非末行 `turn_ended/error`，当前投影仍按末行 `user` → `running`。这是现有语义，不是本轮新规则。

### 13.5 关联级别

| 级别 | sample-004 |
|---|---|
| file | 可以（脱敏 `fileAlias`） |
| session | unmatched（payload 无 session id；文件名不得当 sessionRef） |
| turn | `UNMATCHED_CORRELATION`（payload 无 turnRef；不得用 mtime/顺序伪造） |
| item | unmatched |

当前仍最多做 **file 级对照**。

### 13.6 新旧对照

| 分类 | 本轮 |
|---|---|
| CONSISTENT | sample-004：旧 `working` ↔ 通用 `running` |
| LEGACY_COMPATIBILITY | 0（本轮末行不是 done） |
| GENERIC_MORE_CONSERVATIVE | 0 |
| GENERIC_MORE_INFORMATIVE | 0（connection=unknown，不是比旧路径多出来的终态） |
| POTENTIAL_BUG | 0 |
| SAMPLE_NOT_COVERED | 末行 error/aborted/取消仍未作为**当前观察点**出现 |
| UNMATCHED_CORRELATION | turn/session/item 仍 unmatched；不作为 file 级主类 |

`completed_signal` 未在本轮末行出现。上一轮 sample-002/003 的 `done` → `completed_signal` 结论仍有效。

### 13.7 真实状态覆盖（累计，不覆盖上一轮）

| 状态 | 第一轮（sample-001..003） | 本轮 sample-004 | 累计 |
|---|---|---|---|
| 末行 `user` → working/running | 有（但 freshness 忽略） | **有，且在新鲜窗口内** | `REAL_CURSOR_TRANSCRIPT` |
| 末行 `turn_ended/success` → done / completed_signal | 有 | 非末行再次出现，不是当前观察点 | 末行映射仍靠第一轮 |
| 老格式末行纯文本 assistant | 未覆盖 | 未覆盖 | `FIXTURE_ONLY` / `CODE_INFERENCE` |
| 末行 `turn_ended/aborted` | 未覆盖 | 未覆盖 | `SAMPLE_NOT_COVERED` |
| 末行 `turn_ended/error` | 未覆盖 | 文件中出现过，**不是末行** | 协议字段存在：`REAL_CURSOR_TRANSCRIPT`；末行映射：`SAMPLE_NOT_COVERED` |
| 明确用户取消 | 未覆盖 | 未覆盖 | `SAMPLE_NOT_COVERED`；架构不会从文案推断 |
| 单 item/tool error 作为当前 item 维 | 未覆盖 | tool_use 出现过，但末行是 user，item 未投影 | `SAMPLE_NOT_COVERED` |
| payload sessionRef/turnRef | 无 | 无 | `UNMATCHED_CORRELATION` |
| 新鲜窗口内样本 | 无 | **有** | 仍未评估 prime/dedup |
| process / taskSemantics 验证 | 无法从 transcript 确认 | 同左 | `CODE_INFERENCE` |

### 13.8 用户行为隔离

本轮同样：

- 未启动 Monitor
- 未注册生产 Adapter
- 未启动 PingPet / Codex
- 未改变桌宠 / 气泡 / 声音 / 默认开关
- 未自动重试
- 未修改用户文件、Cursor 配置或项目代码（本文件除外）
- 对照行 `userVisible=false`

### 13.9 阶段 5

仍**不具备**。

新增事实不足以启动统一可见层：

1. 本轮末行是进行中的 `user`，没有新的终态对照。
2. 真实 `turn_ended/error` 已在文件中出现，但不是末行，不能把 Adapter 的 last-line `failed` 映射标为已验证。
3. 仍无真实末行 aborted / 用户取消 / item 失败。
4. 仍无 payload turnRef。
5. prime / dedup 仍未评估。
6. `taskSemantics` 仍为 `not_verified`。
