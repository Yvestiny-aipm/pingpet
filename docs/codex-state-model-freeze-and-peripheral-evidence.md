# Codex 专用状态模型冻结与外围错误证据盘点

调查日期：2026-09-13。  
文档目的：冻结当前 Codex 专用状态模型，作为后续开发依据；盘点额度、鉴权、权限、审批、等待、网络、超时等外围情况的证据等级。本文件不修改状态枚举，不接入新的用户可见行为。

对照来源：

- 代码：`src/shared/types.ts`、`codexObserve.ts`、`codexState.ts`、`codexCandidate.ts`、`codexShadow.ts`、`src/shared/codexCandidateSettings.ts`
- 方案：仓库根目录 `Agent状态检测功能实现方案.md`
- 真实验证：本轮及此前对 `codex exec --json` / 本地 session JSONL 的只读回放
- 测试与 fixture：`src/main/agent/codex*.test.ts`、`src/main/agent/fixtures/codex/`

证据等级：

| 标签 | 含义 |
|---|---|
| `REAL_OFFICIAL` | 真实 `codex exec --json` 结构化事件 |
| `REAL_SESSION` | 真实本地 session JSONL |
| `REAL_EXTERNAL` | 真实退出码、signal、stderr、文件行为等外围信号 |
| `FIXTURE_ONLY` | 仓库 fixture 或单元测试 |
| `CODE_INFERENCE` | 根据现有源码推断，尚无对应真实结构化样本 |
| `UNOBSERVABLE_CURRENT_ARCH` | 当前观察架构无法可靠确认 |

禁止：把 fixture 写成真实协议证据；把「本次未出现」写成「协议不支持」；把 stderr 关键词写成结构化事件。

---

## 1. 已验证环境

| 项 | 值 |
|---|---|
| Codex CLI | ChatGPT.app 捆绑 `/Applications/ChatGPT.app/Contents/Resources/codex` |
| 版本 | `codex-cli 0.153.4` |
| 观察通道 | `codex exec --json`（`source=exec_json`）；`~/.codex/sessions`（`source=session_jsonl`） |
| 安全约束 | `--sandbox read-only`、`--skip-git-repo-check`；不扩权；不改认证 / 配置 / 钥匙串 |
| 未接入 | App Server JSON-RPC（见则记 `unsupported`）、process observer、Monitor 行为替换 |

`CODEX_STRUCTURED_EVENT_TYPES` 只表示解析器已准备识别，不等于真实协议已全部验证。`turn.cancelled` 仍在该表中，但真实 `exec --json` 尚未出现。

---

## 2. 冻结后的生命周期

| lifecycle | 是否终态 | 冻结定义 | 当前如何进入 | 证据等级 |
|---|---|---|---|---|
| `running` | 否 | 观察到当前轮次正在进行 | 官方 `turn.started` / `item.started` / `item.updated`；本地 `task_started` / `item_started` / `item_updated`；以及未升格的 `item.completed` | `REAL_OFFICIAL` + `REAL_SESSION` |
| `waiting_input` | 否 | Codex 明确等待用户回答 | 类型已预留；`interpret()` **不产出** | `CODE_INFERENCE`；真实样本未取得 |
| `waiting_approval` | 否 | Codex 明确等待授权 | 同上 | `CODE_INFERENCE`；真实样本未取得 |
| `completed_signal` | 是 | 协议轮次结束，**不是**任务成功 | 官方 `turn.completed`；本地 `event_msg.task_complete` | `REAL_OFFICIAL` + `REAL_SESSION` |
| `succeeded` | 是 | 任务语义已确认完成 | 检测器 `commit()` **拒绝产出**，强制打回 `unknown` | 模型预留；当前必须保持不可达 |
| `cancelled` | 是 | 协议取消，或明确用户取消文本 | 官方 `turn.cancelled`（未真实取得）；本地 `turn_aborted` 且文本命中用户取消词（未真实取得） | `FIXTURE_ONLY` |
| `failed` | 是 | **整轮**失败 | **仅**官方 `turn.failed` → `cause=turn_failed` | `REAL_OFFICIAL`（无效模型触发） |
| `incomplete` | 是 | 轮次未终态且输出/观察无法完整确认 | 仅 `finalizeIncomplete` / 异常 `applyProcess`；Shadow **不调用** | `FIXTURE_ONLY`；生产路径不可达 |
| `unknown` | 否 | 证据不足或未确认 | 初始态；官方 `error`；普通 `turn_aborted(reason=interrupted)`；无法识别的行 | `REAL_OFFICIAL` + `REAL_SESSION` |

相对旧方案 §7.2 的冻结收紧：官方顶层 `error`、进程异常退出 **不得** 单独进入 `failed`。只有官方 `turn.failed` 才能产生整轮 `failed`。

---

## 3. 冻结后的 cause

`cause` 不替代 lifecycle，只解释为何进入当前状态。

### 3.1 检测器实际会写出的 cause

| cause | 何时写出 | 证据等级 |
|---|---|---|
| `tool_failed` | `item.completed` / 本地 `item_completed` 且 `status` 为 `failed`/`error`/`declined`/`rejected` | `REAL_OFFICIAL` + `REAL_SESSION` |
| `turn_failed` | 官方 `turn.failed` | `REAL_OFFICIAL` |
| `user_cancelled` | 官方 `turn.cancelled` 或本地 `turn_aborted` 的 reason/message **明确**命中用户取消词 | `FIXTURE_ONLY` |
| `unknown` | 默认；官方 `error`；普通 `interrupted` abort；多数 item 无失败 status | `REAL_OFFICIAL` + `REAL_SESSION` |
| `process_exit` | `applyProcess` 异常退出且 turn 仍打开 → `incomplete` | `FIXTURE_ONLY`；Shadow 不调用 |
| `output_truncated` | 显式 `finalizeIncomplete('output_truncated')` | `FIXTURE_ONLY` |
| `monitor_disconnected` | 显式 `finalizeIncomplete('observation_timeout')`（不是 stale） | `FIXTURE_ONLY` |

用户取消词（必须原文包含，不得用 SIGINT 代替）：`user_cancelled`、`user_canceled`、`cancelled by user`、`canceled by user`、`stopped by user`、`user abort`、`user_abort`、`用户取消`、`用户已取消`、`用户按了`、`用户中断`。

### 3.2 类型已预留、当前事件解释器不赋值的 cause

`waiting_for_input`、`waiting_for_approval`、`network_error`、`stream_disconnected`、`rate_limited`、`usage_limit`、`session_budget_exceeded`、`auth_failed`、`permission_denied`、`sandbox_denied`、`context_window_exceeded`、`timeout`。

冻结：不得凭 stderr、退出码、文本关键词或「本次没看到输出」写入这些 cause。取得真实结构化事件前，保持 `unknown` 或现有已验证 cause。

---

## 4. 分层维度（冻结）

| 维度 | 冻结规则 | 当前生产路径 |
|---|---|---|
| `process` | `not_observed / alive / exited / unknown`。只有显式 `applyProcess` 才改。正常退出不改 lifecycle | Shadow **不**调用 `applyProcess`；默认 `not_observed` |
| `connection` | `connected`：刚应用过结构化事件。`stale`：PingPet 观察超时，**不是** Agent 失败。`disconnected`：仅 `markConnection`，Shadow 不用 | Shadow 在活动 turn、priming 后、超过 `CODEX_OBSERVATION_STALE_AFTER_MS`（120s）且无协议终态时 `markObservationStale` |
| `session` | `thread.started` / `session_meta` → `active`。不从文件名猜 session | `REAL_OFFICIAL` + `REAL_SESSION` |
| `turn` | `turn.started`/`task_started` → `in_progress`；`turn.completed`/`task_complete` → `completed`；`turn.failed` → `failed`；取消/abort → `interrupted` | 官方事件通常无 `turn_id`；本地 abort 常有 |
| `item` | 工具 `status=failed` → `failed`，随后普通 item 收成 `partial_failure`。`item.type=error` 且无 status → `unknown`，**不是** `tool_failed`，也不是 succeeded | `REAL_OFFICIAL` + `REAL_SESSION` |
| `outputIntegrity` | 本轮已有失败或未验证 item 时保持 `partial`；`turn.completed` 不得把 partial 改成 complete | 已验证 |
| `taskSemantics` | **固定 `not_verified`**。不得由完成信号、assistant 文本或 `confidence` 推导 | 检测器每次 apply 写回 `not_verified` |
| `retryability` | `turn.completed` 用 `unknown`，不得写成 `never`（`never` 只表示产品禁止自动重试）。明确用户取消 → `user_action`。当前实现 **不自动重试** | 已验证 |
| `confidence` | 表示结构化事件/迁移是否成立：官方 `high`，已识别本地 `medium`，其余 `low`。**不是**任务成功置信度 | 已验证 |
| `shouldNotify` | candidate / 气泡 / 声音 / 静默姿态全部为 `false` | 写死 |

来源隔离：官方点号事件必须同时满足 `source=exec_json`、`evidenceOrigin=codex_exec_json`、已识别。同一字符串出现在 session JSONL 中不得伪装成官方事件。

---

## 5. 冻结核对（十二条核心规则）

| 规则 | 当前代码 | 结论 |
|---|---|---|
| `running` = 观察到轮次进行中 | `turn.started` 等 → `running` | 符合 |
| `completed_signal` ≠ 任务成功 | `turn.completed` / `task_complete` 只给 `completed_signal` | 符合 |
| item/tool failed ≠ turn failed | 失败 item 保持 `running` + `tool_failed` | 符合 |
| `completed_with_partial_failure` 保留工具失败 | candidate 在 `completed_signal` + 失败事实时单独成类 | 符合 |
| 只有官方 `turn.failed` 才整轮 `failed` | `isTurnLevelFailed` 要求 lifecycle=`failed` 且 `turn_failed` | 符合 |
| 普通 `turn_aborted(reason=interrupted)` 保持 `unknown` | 无用户取消词则 lifecycle=`unknown` | 符合（`REAL_SESSION`） |
| 无 `turn.cancelled` 时不得把 SIGINT/退出码 1 猜成用户取消 | 官方 SIGINT 样本停在 `running`；`process` 保持 `not_observed` | 符合 |
| `incomplete`/`process_exit` 需要可靠进程证据；Shadow 不自动产生 | Shadow 注释与实现均不调用 `applyProcess`/`finalizeIncomplete` | 符合 |
| `stale` 只表示观察连接 | `markObservationStale` 只改 `connection` | 符合 |
| `taskSemantics=not_verified` 必须保留 | apply / stale / process 均写回 | 符合 |
| `succeeded` 不得由 `turn.completed`、文本或 confidence 推导 | `commit` 拒绝 `succeeded` | 符合 |
| `shouldNotify` 保持 false | candidate 与各 presentation 写死 | 符合 |
| 未知证据不得猜成功/失败/取消/等待 | 官方 `error`、未知 item、普通 abort → `unknown` | 符合 |

---

## 6. 外围错误证据矩阵

对每一类：官方结构化是否已出现；本地 session 是否已出现；是否只有 fixture；是否只有外围信号；检测器能确认到哪一层；不能确认什么；能否进 lifecycle / 只能进 cause / 只能 `unknown`；是否允许自动重试；是否需要用户操作；误判风险。

### 6.1 额度不足 / rate limit / quota exhausted

| 项 | 记录 |
|---|---|
| 官方结构化 | 当前真实样本未取得 |
| 本地 session | 当前真实样本未取得 |
| fixture/单测 | cause 类型预留；无专用真实事件 fixture |
| 外围信号 | 未安全采集（禁止故意耗额度） |
| 能确认 | 无 |
| 不能确认 | 协议字段名、是否出现顶层 `error` / `turn.failed`、是否可恢复 |
| lifecycle | 不得进入 `failed` |
| cause | 不得写入 `rate_limited` / `usage_limit` / `session_budget_exceeded` |
| 只能 unknown | 是 |
| 自动重试 | 否 |
| 用户操作 | 未知 |
| 误判风险 | 把 stderr「quota/limit」写成结构化失败 |
| 等级 | `UNOBSERVABLE_CURRENT_ARCH` + `CODE_INFERENCE` |
| 安全验证建议 | 仅在用户自然碰到限额时只读采集官方 JSONL；禁止故意打满额度 |

### 6.2 鉴权失败 / token 失效 / 登录失效

| 项 | 记录 |
|---|---|
| 官方 / session | 未取得（禁止改认证） |
| fixture | cause `auth_failed` 预留 |
| 能确认 | 无 |
| lifecycle / cause | 不得进 `failed`；不得写 `auth_failed` |
| 只能 unknown | 是 |
| 自动重试 | 否（即使将来有结构化事件，也应 `reauth` / 用户操作，不得自动重试） |
| 等级 | `UNOBSERVABLE_CURRENT_ARCH` |
| 安全验证建议 | 只读观察用户已失效会话的官方事件；禁止登出或改钥匙串 |

### 6.3 权限不足 / 文件权限拒绝 / 沙箱拒绝

| 项 | 记录 |
|---|---|
| 官方 | 只读沙箱下见过 `item.completed(command_execution, status=failed)` 和 `item.type=error`，**不能**据此写成 `permission_denied` / `sandbox_denied` |
| session | 对应 item 失败 / `task_complete` 或 abort |
| 能确认 | 工具失败事实（`tool_failed`）或未验证 error item（`unknown`） |
| 不能确认 | 失败是否等于权限/沙箱拒绝 |
| lifecycle | 工具失败保持 `running` 或随后 `completed_signal`；不得 `failed` |
| cause | 只允许已验证的 `tool_failed`；不得猜 `permission_denied`/`sandbox_denied` |
| 自动重试 | 否 |
| 误判风险 | 把任意 command failed 当成沙箱拒绝 |
| 等级 | 工具失败：`REAL_OFFICIAL`；权限语义：`UNOBSERVABLE_CURRENT_ARCH` |

### 6.4 审批等待 / 用户授权等待

| 项 | 记录 |
|---|---|
| 官方 / session | 未取得。`exec --json` 在 `approval never` 或不触发审批的只读任务中未见等待事件 |
| fixture | lifecycle `waiting_approval`、cause `waiting_for_approval` 预留；candidate=`waiting` 仅单测 |
| 能确认 | 无 |
| lifecycle | 不得进入 `waiting_approval` |
| 只能 unknown | 是（在出现明确结构化审批事件之前） |
| 自动重试 | 否；若将来确认，需要用户操作 |
| 等级 | `CODE_INFERENCE` + `UNOBSERVABLE_CURRENT_ARCH` |
| 安全验证建议 | 在临时目录用公开审批策略触发一次只读审批，采集官方 type；禁止 `--approve-for-me` 扩权冒充 |

### 6.5 等待用户输入

| 项 | 记录 |
|---|---|
| 官方 / session | 未取得 |
| fixture | `waiting_input` / `waiting_for_input` 预留 |
| lifecycle | 不得进入 |
| 只能 unknown | 是 |
| 「一段时间没有输出」 | **不得**产生等待 |
| 等级 | `CODE_INFERENCE` + `UNOBSERVABLE_CURRENT_ARCH` |

### 6.6 网络断开 / 响应流断开

| 项 | 记录 |
|---|---|
| 官方 / session | 未取得（禁止故意断用户网） |
| fixture | `network_error` / `stream_disconnected` 预留 |
| 能确认 | PingPet 侧文件停更超过阈值 → `connection=stale`（产品策略，不是协议断流） |
| 不能确认 | Codex 进程是否仍在、流是否真的断、是否应 `incomplete` |
| lifecycle | stale **不改** lifecycle |
| cause | 不得写 `network_error` / `stream_disconnected` |
| 自动重试 | 否 |
| 误判风险 | 把 session 心跳间隔或文件停写当成断网/进程退出 |
| 等级 | stale：`CODE_INFERENCE`（阈值已实现，真实 ≥120s 无新行未稳定复现）；协议断流：`UNOBSERVABLE_CURRENT_ARCH` |

### 6.7 超时 / 重试耗尽

| 项 | 记录 |
|---|---|
| 官方 | 运行时 `output_token_limit=8` 仍得到 `turn.completed`，不是超时终态 |
| session | 对应 `task_complete` |
| fixture | cause `timeout` 预留 |
| 能确认 | 无协议超时事件 |
| lifecycle | 不得因耗时猜测 `failed`/`incomplete` |
| 只能 unknown | 对「是否超时」而言：是 |
| 自动重试 | 否 |
| 等级 | 限 token 完成：`REAL_OFFICIAL`（证明限额≠turn.failed）；协议超时：`UNOBSERVABLE_CURRENT_ARCH` |

### 6.8 顶层 `error`

| 项 | 记录 |
|---|---|
| 官方 | **已出现**（无效模型样本：`error` 后接 `turn.failed`）。字段 `{ type, message }` |
| session | 该次 `turn.failed` 无稳定对齐的 session 终态 |
| fixture | `exec-error.jsonl` 等 |
| 能确认 | 官方 `error` → lifecycle=`unknown`，`outputIntegrity=partial`，**不是** failed/succeeded |
| 不能确认 | message 文本语义（额度/鉴权/网络等）；不得用 message 关键词升格 cause |
| lifecycle | 单独 `error`：保持 `unknown`。其后若有 `turn.failed`：才 `failed` |
| cause | 单独 `error`：`unknown` |
| 自动重试 | 否 |
| 用户操作 | 未知 |
| 误判风险 | 把 `item.type=error` 或 stderr 的 error 字样当成顶层 `error` |
| 等级 | `REAL_OFFICIAL` + `FIXTURE_ONLY`（无后续 `turn.failed` 的单独 error 路径） |

### 6.9 `item.completed(status=failed)`

| 项 | 记录 |
|---|---|
| 官方 | **已出现**（`command_execution` + `status=failed`） |
| session | **已出现**（随后可有 `task_complete`） |
| 能确认 | `running` + `tool_failed` + item=`failed`/`partial_failure`；若再来 `turn.completed` → `completed_signal` + candidate=`completed_with_partial_failure` |
| 不能确认 | 任务是否失败；是否应重试 |
| lifecycle | 不得 `failed` |
| 自动重试 | 否；candidate `retryRecommendation=user_decision` 只是对照，未实现重试 |
| 用户操作 | 部分失败提醒打开时：查看结果（默认关） |
| 等级 | `REAL_OFFICIAL` + `REAL_SESSION` |

独立顶层 `item.failed`：**本次未出现**，不能判断协议是否支持。

### 6.10 `turn.failed`

| 项 | 记录 |
|---|---|
| 官方 | **已出现**（`-m` 不存在模型：`… → error → turn.failed`）。字段 `{ type, error.message }` |
| session | 无稳定对应 |
| fixture | `exec-turn-failed.jsonl` |
| 能确认 | `lifecycle=failed`，`cause=turn_failed`，`turn=failed`，`confidence=high`，candidate=`failed` |
| 不能确认 | 失败原因分类；`retryability` 保持 `unknown` |
| lifecycle | **是**，整轮 `failed` |
| 自动重试 | 否 |
| 用户操作 | candidate 对照为需要，但可见层 **未接线**（`failed_or_incomplete_not_wired`） |
| 误判风险 | 把工具失败或顶层 `error` 当成 `turn.failed` |
| 等级 | `REAL_OFFICIAL` |

### 6.11 `turn.cancelled`

| 项 | 记录 |
|---|---|
| 官方 | **未取得**。`exec --help` 无 cancel 参数；SIGINT 后官方序列只有 `thread.started → turn.started`。管道 stdin 是 prompt 追加，不是取消通道 |
| session | 对应 SIGINT 只有 `turn_aborted(reason=interrupted)`，不是官方 `turn.cancelled` |
| fixture | `exec-turn-cancelled.redacted.jsonl`：无用户词 → `cancelled` + `cause=unknown`；带用户词 → `user_cancelled` |
| 外围 | SIGINT + 退出码 1：`REAL_EXTERNAL`，**不得**冒充协议取消 |
| 能确认 | 无真实协议取消 |
| 不能确认 | `exec --json` 是否会在其他入口发出该事件 |
| lifecycle | 真实路径不得进入 `cancelled` |
| 自动重试 | 否 |
| 等级 | 事件本身：`FIXTURE_ONLY`；SIGINT 外围：`REAL_EXTERNAL`。**不得**写成「协议不支持」 |

### 6.12 `event_msg.turn_aborted`

| 项 | 记录 |
|---|---|
| 官方 | 不是官方点号事件 |
| session | **已大量出现**。存量约 137 条，`reason` 全部为 `interrupted`。字段常有 `turn_id`、`started_at`、`completed_at`、`duration_ms` |
| 明确用户取消文本 | **0**。`FIXTURE_ONLY` 才覆盖 `reason=user_cancelled` |
| 能确认 | 普通 abort → `unknown` / `cause=unknown` / `turn=interrupted` / `outputIntegrity=partial` |
| 不能确认 | 是谁中断的；不得写成 `user_cancelled` |
| lifecycle | 普通 abort：`unknown`。仅明确用户取消词：才 `cancelled`（未真实取得） |
| 自动重试 | 否 |
| 误判风险 | 把 `interrupted`、SIGINT、退出码 1 写成用户取消 |
| 等级 | 普通 abort：`REAL_SESSION`；明确用户取消：`FIXTURE_ONLY` |

同一 session 在 `turn_aborted` 之后仍可能出现 `item_completed`。`unknown` 不是终态锁。后续结构化 item 可回到 `running`。这不把 abort 升格为用户取消。

---

## 7. 证据等级总表

| 对象 | 等级 |
|---|---|
| `thread.started` / `turn.started` / `turn.completed` | `REAL_OFFICIAL` |
| `item.started` / `item.completed`（含 `status=failed`） | `REAL_OFFICIAL` |
| 顶层 `error`、`turn.failed` | `REAL_OFFICIAL` |
| `item.completed` 且 `item.type=error`、无 status | `REAL_OFFICIAL`（不当成 turn failed / tool_failed） |
| `session_meta` / `task_started` / `task_complete` / `item_completed` | `REAL_SESSION` |
| `turn_aborted` + `reason=interrupted` | `REAL_SESSION` |
| SIGINT、退出码 1、stderr「Reading additional input from stdin...」 | `REAL_EXTERNAL` |
| `turn.cancelled`、带用户取消词的 abort、`waiting_*`、额度/鉴权/审批结构化事件 | `FIXTURE_ONLY` 或未取得 |
| `applyProcess` → `incomplete`/`process_exit` | `FIXTURE_ONLY`；生产 Shadow 不走 |
| stale 阈值与恢复 | `CODE_INFERENCE`（已实现）；真实长静默 `UNOBSERVABLE_CURRENT_ARCH` |
| App Server JSON-RPC、外部 Codex PID/退出码关联、文件停写=进程退出 | `UNOBSERVABLE_CURRENT_ARCH` |
| 官方 `item.failed`、官方 `turn_id`/时间戳 | 本次未出现，不能判断协议是否支持 |

---

## 8. 当前明确禁止的推断

1. `turn.completed` / `task_complete` / assistant 文本 / `confidence=high` → `succeeded` 或「任务已完成」。
2. `item.completed(status=failed)` 或 `item.type=error` → 整轮 `failed`。
3. 顶层 `error` 单独 → `failed` 或额度/鉴权/网络 cause。
4. `turn_aborted(reason=interrupted)` / SIGINT / 退出码 1 / stderr → `user_cancelled` 或 `turn.cancelled`。
5. 文件停写、mtime、session 轮换 → `process_exit` 或进程已退出。
6. 观察 `stale` → Agent `failed` / `cancelled` / `incomplete`。
7. 「一段时间没输出」→ `waiting_input` / `waiting_approval`。
8. stderr 或文本含 quota / auth / permission / timeout → 对应 cause。
9. 把 session JSONL 的点号字符串当成官方 `exec --json`。
10. 把 fixture 或「CLI 二进制里有/没有某字符串」写成协议支持或不支持。
11. 自动重试任何 Codex 轮次。
12. 打开默认视觉 / 气泡 / 声音开关，或把 `shouldNotify` 设为 true。

---

## 9. 当前允许的用户可见行为

默认三个开关均为 `false`。声音开关不在设置页展示。

仅当用户**主动打开**对应 Codex 实验开关，且观察为 live（非 priming）时：

| 开关 | 允许 |
|---|---|
| `codexCandidateVisualEnabled` | `working` → 桌宠 `thinking`；普通 `completed_signal` → `idle`（中性，不是庆祝）；`completed_with_partial_failure` → `attention` |
| `codexCandidateBubbleEnabled` | 仅 `completed_with_partial_failure` 且气泡真正发出后，文案：「这一轮结束了，但有工具失败，请查看结果。」气泡 `sound=false` |
| `codexCandidateSoundEnabled`（隐藏） | 仅在部分失败气泡已发送、已 acknowledge、未 pending、资源可读时，播放独立 attention 音；不回退 `playDing` |

旧 Monitor 的 Codex `working`/`done` 路径在视觉开关打开时让位，避免双切。其他 Agent 行为不变。

---

## 10. 当前不允许接入的用户可见行为

- `failed` / `incomplete` / `waiting` 桌宠或气泡（代码明确 `*_not_wired`）
- `cancelled` 作为已验证的用户取消文案（真实协议取消未取得；姿态对照即使打开也只是中性 idle）
- `stale` / `unknown` 改姿态或打扰（保持当前姿态）
- 成功气泡、完成音、庆祝姿态（`celebrating` 只是 candidate 对照字段）
- 系统通知（`shouldNotify` 恒 false）
- 自动重试、process observer、Monitor 用户行为替换
- 把额度/鉴权/权限/网络直接做成失败气泡

---

## 11. 尚未确认的问题及验证方法

| 问题 | 为何未确认 | 安全验证方法 | 模型动作 |
|---|---|---|---|
| `exec --json` 能否发出 `turn.cancelled` | 无公开 cancel 参数；SIGINT 未产生该事件 | 继续只读观察；不把 SIGINT 补写成取消 | 暂不改 |
| 明确用户取消文本的 `turn_aborted` | 137 条真实 abort 全是 `interrupted` | 自然出现时只读采集；不改检测器猜词 | 暂不改 |
| 额度 / 鉴权 / 审批 / 等待输入的官方 type | 禁止破坏登录、耗额度、扩权 | 用户自然触发后只读 JSONL | 暂不改；保持 unknown |
| 协议级断流 / 超时事件 | 禁止故意断网 | 自然故障时对照官方事件与 stale | stale 只改 connection |
| 外部 Codex 进程退出 | PingPet 不启动该进程；JSONL 无 pid | 在未实现可靠关联前不观测 | 不实现 process observer |
| 真实 ≥120s 无 session 新行 | sleep 样本约 30s 仍有心跳 | 注入 clock 的单测已覆盖逻辑；真实误报率未定 | 不据此改 lifecycle |
| App Server 信封 | 观察层不解包 | 在协议确认前保持 `unsupported` | 不新增状态 |

---

## 12. 进入通用 Agent 状态层前的前置条件

Codex 专用层在本文件规则下可以冻结。进入通用层之前必须同时满足：

1. 通用层复用「完成信号 ≠ 成功」「工具失败 ≠ 整轮失败」「失联 ≠ Agent 失败」「未知保持 unknown」。
2. 不得把 Codex 预留但未验证的 cause（额度、鉴权、等待等）当成其他 Agent 的已验证能力。
3. 不得把旧 Monitor 的 `done` 映射为任务成功。
4. 不得为了通用化而放宽 Codex 的 `failed` / `user_cancelled` / `process_exit` 规则。
5. 其他 Agent 仍走现有 Monitor，直到各自有同等证据等级的样本。
6. 默认开关保持关闭；`shouldNotify` 保持 false，直到单独产品决策。

后续不要无目的扩展 Codex 状态枚举。缺的是真实外围结构化样本，不是新的 lifecycle。
