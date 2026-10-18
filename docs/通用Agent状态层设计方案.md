# 通用 Agent 状态层设计方案

调查日期：2026-09-13。  
文档性质：代码现状检查 + 模型设计 + 文件级实施方案。  
本轮**只新增本文档**，不修改生产代码，不接入新的用户行为，不打开任何默认开关。

对照来源：

- 冻结基准：`docs/codex-state-model-freeze-and-peripheral-evidence.md`
- 类型：`src/shared/types.ts`、`src/shared/agents.ts`
- 旧 Monitor：`src/main/agent/monitor.ts`、`src/main/agent/scanners.ts`、`src/main/agent/classify.ts`
- 各 Agent 扫描器：`codex.ts`、`claude.ts`、`cursor.ts`、`grok.ts`
- Codex 专用层：`codexObserve.ts`、`codexState.ts`、`codexShadow.ts`、`codexCandidate.ts`、`codexVisiblePresentation.ts`
- 用户可见层：`src/main/main.ts` 的 `handleAgentEvent`、`src/main/config.ts`、`codexLegacyPresentation.ts`
- 测试：`classify.test.ts`、`monitor.test.ts`、`codex.test.ts`、`claude.test.ts`、`cursor.test.ts`、`grok.test.ts`，以及 Codex 影子/候选/可见层测试

证据标签：

| 标签 | 含义 |
|---|---|
| `CODE_FACT` | 当前源码与测试已经这样实现 |
| `CODEX_FROZEN` | Codex 专用层已冻结，通用层不得放宽 |
| `FIXTURE_ONLY` | 只有单元测试 / fixture，不是真实协议样本 |
| `UNCONFIRMED` | 尚未用该 Agent 的真实运行样本验证 |

禁止：把 fixture 写成真实协议；把「本次未出现」写成「协议不支持」；把某个 Agent 的文本关键词提升为通用高可信证据；把旧 `done` 解释成任务成功。

---

## 1. 目标与边界

### 1.1 目标

在不破坏 Codex 专用层的前提下，设计一套可供 Claude、Cursor、Grok 以及未来 Agent 复用的**通用状态感知层**。

通用层只回答：

> 我们观察到了什么？证据在哪？哪些维度现在无法确认？哪些维度这个 Agent 根本没有？

通用层不回答：

> 桌宠该摆什么姿势、该不该弹气泡、该不该出声、该不该自动重试、任务有没有真正做完。

### 1.2 必须继承的冻结原则

这些原则已经在 Codex 层验证并冻结，通用层必须原样继承，不得为迁就其他 Agent 而放宽：

1. `completed_signal` 只是协议结束，不代表任务成功。
2. 工具 / item 失败不等于整轮失败。
3. 只有明确的 turn 级失败才能进入整轮 `failed`。
4. 普通中断不能自动判定为用户取消。
5. 证据不足时必须保留 `unknown`。
6. 进程、连接、会话、轮次、item、输出完整性、任务语义必须分层。
7. `taskSemantics` 不能从最终文本或协议完成信号直接推导。
8. 自动重试、成功提示、失败提示都必须建立在明确证据上。

### 1.3 本轮边界

做：

- 还原四类 Agent 的真实链路；
- 区分原始信号、通用状态、用户可见展示状态；
- 设计通用模型、Adapter 契约、聚合规则、兼容策略、分阶段落地。

不做：

- 修改 Codex 检测器、`classify`、Monitor 用户行为、桌宠 / 气泡 / 声音；
- 实现自动重试、新增成功状态、打开默认开关；
- 把旧 `done` 统一解释成任务成功；
- 把文本关键词提升为高可信结构化证据。

### 1.4 三条链路必须分开

```text
原始信号                通用状态层                 用户可见层
─────────              ──────────                ──────────
官方结构化事件          lifecycle                 thinking
本地 session JSONL      cause                     idle
CLI / 文本日志          connection                attention
文件 mtime              process                   failed
进程退出码              session                   unknown
观察端超时              turn                      （以及气泡、声音、文案）
工具调用结果            item
用户取消动作            outputIntegrity
roster / 未读数         taskSemantics
                        retryability
                        confidence
                        evidence
                        observedAt
```

用户可见状态不能反过来改写内部事实。旧 Monitor 的 `done` 也不得被当成任务成功。

---

## 2. 当前四类 Agent 的现状对照

### 2.1 共同旧链路

当前生产用户行为仍走旧 Monitor，四家最终都收成同一个四分类：

```text
本地文件 / roster
  → 各 Agent 扫描器（scanCodex / scanClaude / scanCursor / scanGrok）
  → AgentMonitorEvent { source, env, sessionKey, kind, reason, detail, timestampMs }
  → AgentMonitor.tick / ingest
       新鲜度 AGENT_EVENT_FRESH_MS（120s）
       环境过滤
       seenIds 去重
       首轮 prime 不派发
       终态需先见过同 session 的 working
  → handleAgentEvent
       working → thinking，不弹气泡
       非 Codex 的 done / needs_attention / failed → 气泡 + 可选完成音
       Codex 的 done → 内部保留，不弹成功气泡、不响完成音、不庆祝
```

`kind` 只有 `working | done | needs_attention | failed`。  
`reason` 只有 `completed | needs_input | error | interrupted`。

这套四分类把「协议结束」「任务成功」「未读回信」「文本里出现完成词」压成同一个 `done`。这是通用层必须拆开的核心问题。

Codex 另外有一条**只读影子链路**，不进旧 `onEvent`：

```text
~/.codex/sessions JSONL
  → codexObserve（CodexObservationEvent）
  → CodexStateDetector（CodexDerivedState）
  → CodexSessionShadow
  → 诊断 JSONL + 可选 candidate 静默姿态（默认关）
```

官方 `codex exec --json` 解析器已存在，但生产 Monitor **没有**接入 process observer，也没有把官方流接到用户可见层。

### 2.2 对照总表

| 项 | Codex | Claude | Cursor | Grok |
|---|---|---|---|---|
| 原始信号来源 | `~/.codex/sessions/*.jsonl`；解析器另支持 `codex exec --json`，生产未接官方流 | `~/.claude/projects/**/*.jsonl` | `~/.cursor/projects/*/agent-transcripts/**/*.jsonl` | `~/Library/Application Support/Grok Bot/sand-client-persistence/*.blob`（roster + transcript） |
| 当前解析器 | `scanCodex` / `classifyCodexLegacyLine`；影子：`codexObserve` + `codexState` | `scanClaude` | `scanCursor`（只看文件最后一行） | `scanGrok`（跨轮 `botStates` + roster） |
| 当前可识别状态（旧） | working / done / failed；assistant 文本可再出 needs_attention | working / done / needs_attention / failed | working / done / needs_attention / failed | working / done / needs_attention；**无 failed** |
| 文本关键词 | 旧路径 assistant 文本走 `classifyStopText`；新检测器**不**用它推导 lifecycle / taskSemantics | `end_turn` 后走 `classifyStopText`；认不出则兜底 `done` | `turn_ended/success` 或老格式末行纯文本后，仅允许文本把成功改成 `needs_attention` | 未读时可用文本改判 `needs_attention`；`awaitingUserResponse` 本身已是结构化等待 |
| session 概念 | 有。旧路径 `sessionKey=文件名`；新路径 payload `sessionId`，文件名只作 fallback | 有。优先行内 `sessionId`，否则 `项目目录/文件名` | 有。`sessionKey=文件名（去后缀）` | 有。一个 Bot = 一个 session（`grok:<botId>`） |
| turn 概念 | 有。官方 `turn.*` / 本地 `task_*`；`turnId` 经常缺失，不得猜造 | 无独立 turn id。`stop_reason=end_turn` 近似「一条 assistant 回合结束」 | 有弱 turn。`type=turn_ended`；无时间戳、无 turn id | **无 turn**。Bot 常驻，靠 mtime / 未读 / 等待字段 |
| item 概念 | 有。官方 / 本地 `item.*`，可识别 `status=failed` | 无独立 item 状态。`stop_reason=tool_use` 只表示还在调工具 | 无独立 item 状态。`tool_use` 只用来判断「还没结束」 | 无 |
| 结构化失败信号 | **有（新层）**：仅官方 `turn.failed` → 整轮 failed；item 失败保持 running。旧路径把 `turn_aborted` 误映射为 failed | **无**。失败只靠文本关键词 | **有弱信号**：`turn_ended.status=error/aborted` | **无** |
| 用户取消 | 新层：只有明确用户取消词或官方 `turn.cancelled`（后者真实样本未取得）。普通 `interrupted` 保持 unknown。旧路径：`turn_aborted` → failed/interrupted | 不能。文本含 cancelled/中断 会走 failed，但这是关键词，不是用户动作 | 不能可靠判断。`aborted` 被映射为 failed/interrupted；error 字段里的「用户取消」只当 detail | 不能 |
| 进程退出 | 检测器有 `applyProcess`，生产 Shadow **不调用**；默认 `process=not_observed` | 不观察 | 不观察 | 不观察 |
| 旧 Monitor 输出 | working；`task_complete` → done；`turn_aborted` → failed；assistant 文本可出 done/needs_attention/failed | tool_use/user → working；end_turn + 文本分类，否则 done | 末行 turn_ended 或纯文本 assistant → 终态；否则 working。子 Agent 忽略 | mtime 变 → working；awaiting → needs_attention；unread>0 → done |
| 用户可见差异 | Codex `done` 已被中性化：不弹成功气泡、不响完成音、不 celebrating | `done` 仍当完成：happy + 气泡「任务完成」+ 可选完成音 | 同 Claude | 同 Claude。unread 被当成完成 |
| 当前误判风险 | 旧路径：`turn_aborted` 被当成整轮失败；assistant「完成」词被当成成功。新路径已避免 | `end_turn` 兜底 done，把「说完一句话」当成任务完成；文本 failed 可能漏报或误报 | 老格式末行纯文本 = done；`aborted` 被当成失败；无时间戳，只能靠末行防重放 | unread ≠ 任务完成；无 turn 结束硬信号；自由文本提问不一定置位 awaiting |
| 接入通用层难度 | 低（已有观察事件 + 多维状态 + 影子对照）。必须保持现有保守语义 | 中。有 session 和 `stop_reason`，但无 turn/item 失败分层，高度依赖文本 | 中偏低。有 `turn_ended.status`，最容易做对照；缺时间戳和 item | 中偏高。无 turn，未读/等待语义与另外三家不同 |
| 应保留 | 整套 Codex 观察 / 检测 / 影子 / candidate；旧 `scanCodex` 作为兼容输出 | 扫描、entrypoint、sessionId、prime/去重 | 只认末行、忽略 subagents、`turn_ended` 状态分流 | 首轮基线、跨轮 mtime、awaiting 优先于 unread、删除后重建基线 |
| 应改造（仅通用层，不改旧行为） | 旧 `done` 继续只作兼容，不得回写成成功 | `end_turn` 应对齐 `completed_signal`，不再 internally 视为 succeeded | `turn_ended/success` 对齐 `completed_signal`；`aborted` 不得自动升格 user_cancelled | unread 不得映射为 succeeded 或高可信 completed_signal |
| 应降级 | 旧路径 assistant 文本分类：不得进入通用高可信 | `classifyStopText` 只能作为低可信 hint | 文本只允许提示 waiting，不能独立制造 failed/succeeded | 文本改判 waiting 保持低可信 |
| 应删除（现在不行） | 在通用层稳定对照之前，不删 `scanCodex` / 旧 kind | 不删 | 不删 | 不删 |

### 2.3 各 Agent 真实链路

#### Codex

```text
~/.codex/sessions JSONL
  ├─ 旧：classifyCodexLegacyLine
  │     event_msg.task_started / reasoning / function_call → working
  │     event_msg.task_complete → done + reason=completed
  │     event_msg.turn_aborted → failed + reason=interrupted
  │     assistant 文本 → classifyStopText（低可信）
  │         ↓
  │     AgentMonitorEvent → handleAgentEvent
  │         working → thinking
  │         done → 内部兼容，不弹成功气泡、不完成音、不庆祝
  │         failed / needs_attention → 仍可弹（旧行为，未改）
  │
  └─ 新：codexObserve → CodexObservationEvent
        → CodexStateDetector → CodexDerivedState
        → candidate / 静默姿态（默认关，不进旧 onEvent）
```

证据：`CODE_FACT` + `CODEX_FROZEN`。官方 `turn.completed` / 本地 `task_complete` 在新层只给 `completed_signal`，`taskSemantics=not_verified`。

#### Claude

```text
~/.claude/projects/**/*.jsonl
  → 行类型：
       assistant + stop_reason=tool_use → working
       user / last-prompt → working
       assistant + stop_reason=end_turn → classifyStopText(正文)
            命中 → done / needs_attention / failed
            未命中 → 兜底 done + completed
  → AgentMonitorEvent → 旧 Monitor → 用户可见层
       done 会弹「任务完成」并可达完成音
```

`stop_reason=end_turn` 是「这条 assistant 消息结束」，不是已验证的任务语义完成。当前旧路径把它兜底成 `done/completed`。证据：`CODE_FACT`。真实 Claude 协议是否还有别的 stop_reason / 结构化失败：`UNCONFIRMED`。

#### Cursor

```text
~/.cursor/projects/<slug>/agent-transcripts/<sid>/<sid>.jsonl
  → 忽略 subagents/
  → 只看最后一行（防 mtime 变化导致旧终态重放）
       turn_ended + status=success → 默认 done；文本可改 needs_attention
       turn_ended + status=aborted → failed / interrupted
       turn_ended + status=error/其他 → failed / error
       末行纯文本 assistant（无 tool_use）→ 与 success 相同（老格式兼容）
       其他 → working
  → 无行内时间戳，事件时间用文件 mtime
```

`turn_ended/success` 是协议回合结束，不是任务成功。当前旧路径仍输出 `done/completed`。`aborted` 被当成失败，不是已验证的用户取消。证据：`CODE_FACT`。真实 Cursor 是否还有其他 status / 官方取消事件：`UNCONFIRMED`。

#### Grok

```text
sand-client-persistence
  → roster.last-roster + transcript.replicas.<botId>
  → 首见 Bot 只记基线，不产出（防历史重放）
  → transcript mtime 变化 → working（timestamp=now，便于思考态续期）
  → mtime 稳定且曾见过活动：
       awaitingUserResponse ≠ null → needs_attention
       unreadCount > 0 → classifyStopText 可改 needs_attention，否则 done
```

Grok **没有** turn 结束硬信号。`unreadCount>0` 只表示「Bot 给你发了还没看的东西」。当前旧路径把它映射为 `done/completed`。证据：`CODE_FACT`。roster 字段的完整协议：`UNCONFIRMED`（当前实现按客户端模型推断）。

### 2.4 旧用户可见层在做什么

| 旧 kind | 桌宠 | 气泡 | 声音 | 例外 |
|---|---|---|---|---|
| `working` | `thinking` | 无 | 无 | Codex 视觉开关打开时改由 candidate 驱动，避免双切 |
| `done` | `happy` | 「输出结束了，任务完成」 | 可选完成音 | **仅 Codex**：不展示、不完成音、静默 `idle` |
| `needs_attention` | `attention` | 「需要你处理」 | 无 | 四家相同 |
| `failed` | `failed` | 「出错 / 被中断」 | 无 | Grok 当前扫描器不产出 failed |

`classifyStopText` 的优先级是 interrupted > error > needs_input > completed，且关键词表已收紧。它被 Claude / Cursor / Grok / Codex 旧路径共用，但**不是**结构化证据。

---

## 3. 通用状态模型

### 3.1 三个概念

| 层 | 作用 | 能否缺失 | 能否被展示层改写 |
|---|---|---|---|
| Agent 原始信号 | 某家 Agent 实际留下的字节、字段、mtime、退出码 | 可以没有某类信号 | 否 |
| 通用状态 | 所有 Agent 都可以尝试填充的共同维度 | 每个维度都允许 `unknown` 或 `unsupported` | 否 |
| 用户可见展示状态 | thinking / idle / attention / failed / unknown 以及气泡声音 | 可以暂不接线 | 否；它只读通用状态或旧兼容事件 |

### 3.2 字段归属

#### 通用核心（所有 Adapter 都必须给出）

这些字段描述的是**观察事实**，不是 Codex 事件名。名称可以接近 Codex，但语义按通用定义，不绑定 Codex JSONL。

| 字段 | 通用含义 | 允许的空值 | unknown 规则 |
|---|---|---|---|
| `agentId` | 来源 Agent，取值沿用现有 `AgentSource` | 不可空 | 无 |
| `adapterId` | 哪个适配器实例产出（如 `codex-session-jsonl`） | 不可空 | 无 |
| `observedAt` | PingPet 处理这条观察的时间 | 不可空 | 不得用 Agent 事件时间填 |
| `lifecycle` | 当前工作单元是否在跑、是否收到结束信号、是否整轮失败 | 默认 `unknown` | 证据不足必须 `unknown`，不得猜 succeeded/failed |
| `cause` | 为何进入当前 lifecycle | 默认 `unknown` | 不得用文本/stderr 关键词升格为额度、鉴权、网络等 |
| `connection` | PingPet 与观察通道的关系 | 默认 `unknown` | stale 只表示观察超时，不改 lifecycle |
| `process` | 目标 Agent 进程是否被观察到 | 默认见 3.3 | 无可靠 PID 关联时不得写成 exited |
| `session` | 会话是否已加载 / 活跃 | 默认 `unknown` 或 `unsupported` | 不得从文件名猜「官方 session 状态」 |
| `turn` | 当前轮次维度 | 默认 `unknown` 或 `unsupported` | 没有 turn 概念的 Agent 标 `unsupported`，不是 unknown |
| `item` | 当前工具/条目聚合 | 默认 `unknown` 或 `unsupported` | 单个失败不得写成整轮 failed |
| `outputIntegrity` | 本轮输出是否完整 | 默认 `unknown` | 结束信号不得把已有 partial 改成 complete |
| `taskSemantics` | 用户任务是否真的完成 | 默认 `not_verified` | **禁止**由完成信号、最终文本、confidence 推导 |
| `retryability` | 是否允许自动重试 | 默认 `unknown` | 完成信号不得写成 `never`；本阶段不实现重试 |
| `confidence` | 对**这条结构化迁移是否成立**的置信度 | 默认 `low` | 不是任务成功置信度 |
| `evidence` | 指向原始信号的证据列表 | 可空数组 | 空数组时不得进入明确终态 |
| `conflicts` | 被压下的冲突信号 | 可空数组 | 只记录，不自动选成功/失败 |

可选标识，**只有 Adapter 从原始信号拿到才填**，禁止猜造：

- `sessionRef`
- `threadRef`
- `turnRef`
- `itemRef`
- `sourcePath`
- `eventTime`（Agent 自己的时间，不是 `observedAt`）

这些名字刻意不用 Codex 的 `sessionId` / `threadId` / `turnId`，以免把「Codex 协议字段」误当成通用必填项。

#### Agent 专用扩展

放进 `extension`，通用聚合器不得把其中字段提升为核心事实。

| Agent | 扩展示例（不得进入通用枚举） |
|---|---|
| Codex | `exec_json` / `session_jsonl`；`turn.completed`、`event_msg.task_complete`、`turn.failed`；`originator`；官方点号事件表 |
| Claude | `stop_reason`（`tool_use` / `end_turn`）；`entrypoint` |
| Cursor | `turn_ended.status`；「是否末行」；project 边车环境推断；subagent 路径 |
| Grok | `unreadCount`；`awaitingUserResponse.reason`；base32 存储键；跨轮 `activitySeen` |

### 3.3 `unsupported` 与 `unknown`

这是通用层最容易写错的一点。两者**不能**共用一个值。

| | `unsupported` | `unknown` |
|---|---|---|
| 含义 | 这个 Agent **没有**这个维度，或当前 Adapter **声明不观察**它 | 这个维度存在或被支持，但**这一刻证据不够** |
| 谁声明 | Adapter 能力表，相对稳定 | 运行时每一条状态 |
| 例子 | Grok 的 `turn` / `item`；四家当前的 `process`（生产都不观察进程） | Codex 普通 `turn_aborted` 的 lifecycle；Claude 无法判断任务是否完成 |
| 聚合器怎么做 | 不参与该维度的冲突仲裁；不要求提供 `turnRef` | 保持 unknown，不得用其他维度填补 |
| 禁止 | 把「没看到 turn 事件」写成 unsupported | 把「Grok 没有 turn」写成 unknown |

建议每个维度使用带存在性的值，而不是把 `unsupported` 塞进业务枚举：

```text
Dimension<T> =
  | { presence: 'unsupported' }
  | { presence: 'unknown' }
  | { presence: 'observed'; value: T }
```

对 `process` 再保留 Codex 已验证的细差：

| 值 | 含义 |
|---|---|
| `unsupported` | 此 Adapter 声明不观察进程（当前四家生产路径都应如此） |
| `unknown` | 收到了无法解释的进程线索 |
| `not_observed` | Adapter **能**观察进程，但这一轮没收到 hint（Codex 检测器已有，Shadow 不用） |
| `alive` / `exited` | 显式进程观察 |

当前生产：四家都没有可靠 PID 关联，能力表应标 `process=unsupported`。Codex 检测器内部的 `not_observed` 继续留在 Codex 专用层，不提升为「我们已经在观察进程」。

### 3.4 通用 lifecycle / cause

lifecycle 可以复用 Codex 已经验证过的**概念**，因为它们描述的是观察，不是 Codex 事件名：

| lifecycle | 是否终态 | 通用定义 | 谁有资格写入 |
|---|---|---|---|
| `running` | 否 | 观察到当前工作单元正在进行 | 有进行中信号的 Adapter |
| `waiting_input` | 否 | Agent **明确**等待用户回答 | 仅结构化等待字段或等价官方事件 |
| `waiting_approval` | 否 | Agent **明确**等待授权 | 同上 |
| `completed_signal` | 是 | 收到协议/回合结束信号，**不是**任务成功 | 仅明确结束信号 |
| `succeeded` | 是 | 任务语义已确认 | 通用层 **禁止产出**；与 Codex 相同 |
| `cancelled` | 是 | 明确协议取消或明确用户取消 | 不得用普通 abort / SIGINT |
| `failed` | 是 | **整轮 / 整个工作单元**失败 | 仅 Adapter 声明的 turn 级失败信号 |
| `incomplete` | 是 | 工作单元未终态且输出/观察无法完整确认 | 仅显式 incomplete 触发器；当前生产不自动产生 |
| `unknown` | 否 | 证据不足 | 默认 |

cause 同样只解释 lifecycle，不替代它。通用核心只允许已经跨 Agent 说得清的值：

| 通用 cause | 何时允许 |
|---|---|
| `unknown` | 默认 |
| `tool_failed` | 结构化 item/工具失败 |
| `turn_failed` | Adapter 确认的工作单元级失败（Codex 仅官方 `turn.failed`） |
| `user_cancelled` | 明确用户取消证据 |
| `process_exit` | 显式进程观察 |
| `output_truncated` | 显式截断 |
| `monitor_disconnected` | 显式观察超时 incomplete，不是 stale |

以下 cause **继续只留在 Agent 扩展或预留表**，在该 Agent 出现真实结构化样本之前不得由通用层赋值：

`waiting_for_input`、`waiting_for_approval`、`network_error`、`stream_disconnected`、`rate_limited`、`usage_limit`、`session_budget_exceeded`、`auth_failed`、`permission_denied`、`sandbox_denied`、`context_window_exceeded`、`timeout`。

Grok 的 `awaitingUserResponse` 可以支持 `lifecycle=waiting_input` 或 `waiting_approval`，但 **cause 仍应先保持 unknown 或只放在 Grok 扩展里**，直到 reason 的协议枚举被真实样本确认。不得把任意 reason 字符串写成 `waiting_for_approval`。

### 3.5 如何标记来源、如何保留原始证据

每条观察和每条派生状态都必须带：

```text
agentId        哪个 Agent
adapterId      哪个适配器
channel        原始通道（文件 / roster / 官方流 / 进程），由 Adapter 自报
recognition    recognized | unknown | unsupported | malformed | partial
confidence     high | medium | low
evidence[]     { id, dedupKey, channel, rawType?, observedAt, note?, excerptHash? }
extension      仅该 Agent 能解释的原始摘要
```

规则：

- 通用层只存**安全摘要**，不存完整会话原文。
- `dedupKey` 必须由 Adapter 稳定计算；同一原始行重放得到同一键。
- Codex 现有规则继续有效：官方点号事件必须同时满足来源、evidenceOrigin、已识别；session JSONL 里出现相同字符串不得伪装成官方事件。这条规则留在 Codex Adapter 内，不写进通用枚举。

### 3.6 特殊情况如何表达

| 情况 | 通用层怎么做 |
|---|---|
| 没有 turn 概念的 Agent（Grok） | 能力表 `turn=unsupported`、`turnRef` 不出现。用 session 级工作单元。新活动用 session 级清理，不伪造 turn |
| 只有文本日志、没有结构化事件 | Adapter 仍可输出观察，但 `confidence=low`，`recognition` 不得为高可信 structured。lifecycle 默认 unknown；文本命中最多作为 hint，不能独立得到 failed/succeeded |
| 一个 Agent 多个 session | 状态按 `(agentId, sessionRef)` 隔离。禁止用文件名猜官方 id；没有 session 字段时可用 Adapter 声明的稳定 `sessionRef`（如 Cursor 文件名、Grok botId） |
| 多个 Agent 同时运行 | 状态按 `agentId` 完全隔离。规则表、关键词、失败定义不得共享。用户可见仲裁是另一层，本阶段不做跨 Agent 合并 |
| 同一 Agent 多个 turn | 仅当 Adapter 观察到**新工作单元开始**时，清理上一轮的 turn/item/outputIntegrity/cause。没有 turn 信号就不要做 turn 级清理 |
| 观察端失联 | 只改 `connection=stale`（或 disconnected，若 Adapter 显式标记）。不改 lifecycle，不写 failed/cancelled/incomplete |
| Agent 正常结束但任务是否完成未知 | `lifecycle=completed_signal`，`taskSemantics=not_verified`，`retryability=unknown`。禁止 succeeded，禁止成功文案 |

---

## 4. Agent Adapter 契约

### 4.1 身份注册

沿用现有 `AGENT_SOURCES` / `AGENT_SCANNERS` 的编译期完备思路，另建 Adapter 登记处：

```text
AgentAdapterRegistry[agentId] = {
  agentId,
  adapters: AgentAdapter[]   // 一家可以有多个通道，例如 Codex session 与未来 exec_json
}
```

新增 Agent 必须同时提供：

1. `AgentSource`（已有，决定设置项）；
2. 扫描器或观察器（已有或新增）；
3. **至少一个 Adapter**（通用层）；
4. 能力表。

缺登记则编译失败，避免静默漏接。

一家 Agent 的多个 Adapter 可以并存（Codex：session JSONL / 未来 exec_json / 未来 process）。它们写入**同一 session 槽**时，由该 Agent 自己的优先级规则仲裁；通用层只保证隔离，不把 Codex 的官方>本地规则套到别人头上。

### 4.2 输入

Adapter **不**直接读另一个 Agent 的文件。输入是该 Agent 自己的原始观察：

```text
AgentRawBatch {
  agentId
  observedAt
  items: Array<{
    channel          // session_file / roster / official_stream / process / text_log
    sourcePath?
    byteRange? / cursor?
    payload          // 已解析对象或原始行
    eventTime?       // 只有原始字段提供时
  }>
}
```

现有扫描器可以暂时继续自己读盘，再在 Adapter 边界把「已经读到的行」送进去。阶段 1–2 不要求先重写 IO。

### 4.3 输出

Adapter 输出两类对象，都不得直接驱动桌宠。

1. **通用观察事件** `AgentObservation`
   - 看到了什么，尚未聚合。
   - 类似 `CodexObservationEvent`，但去掉 Codex 事件名枚举。
2. **通用派生状态** `AgentDerivedState`
   - 本 session（以及可选 work unit）的多维状态。
   - 由「Agent 专用解释器 + 通用聚合器」共同得到。

建议阶段 2 的 Codex Adapter **先把现有 `CodexObservationEvent` / `CodexDerivedState` 投影到通用类型**，而不是重写检测器。投影必须可逆对照：通用字段不得比 Codex 更激进。

### 4.4 证据与可信度

| confidence | 何时允许 | 示例 |
|---|---|---|
| `high` | Adapter 声明的结构化通道，且 recognition=recognized | Codex 官方 `turn.failed`；Cursor `turn_ended`（若 Adapter 如此声明） |
| `medium` | 已识别的本地结构化会话行 | Codex `event_msg.task_complete`；Claude `stop_reason=end_turn`；Grok `awaitingUserResponse` 对象存在 |
| `low` | 文本关键词、mtime、未读数、环境边车 | `classifyStopText`；Grok `unreadCount`；Cursor 老格式末行纯文本 |

文本关键词**永远不能**单独变成 `high`。  
mtime / 文件新鲜度只能支持 `connection` 或「有活动」，不能单独得到 lifecycle 终态。

Adapter 无法判断时：

- 仍输出观察，`recognition=unknown` 或 `partial`；
- 派生状态对应维度保持 `unknown`；
- 不得为了「总要给一个 kind」而兜底 `done`。旧扫描器的兜底只留在兼容层。

### 4.5 如何声明不支持

能力表是 Adapter 的静态声明，不是运行时猜的：

```text
AgentCapability {
  structuredEvents: 'supported' | 'unsupported'
  session: 'supported' | 'unsupported'
  turn: 'supported' | 'unsupported'
  item: 'supported' | 'unsupported'
  process: 'supported' | 'unsupported'
  userCancel: 'supported' | 'partial' | 'unsupported'
  officialStream: 'supported' | 'unsupported'
}
```

建议初值（根据当前代码，不是协议承诺）：

| | Codex | Claude | Cursor | Grok |
|---|---|---|---|---|
| structuredEvents | supported | partial（`type`/`stop_reason`） | supported（`turn_ended`） | partial（roster 字段） |
| session | supported | supported | supported | supported |
| turn | supported | unsupported（只有 message stop_reason） | partial | unsupported |
| item | supported | unsupported | unsupported | unsupported |
| process | unsupported（生产） | unsupported | unsupported | unsupported |
| userCancel | partial（真实取消未取得） | unsupported | unsupported | unsupported |
| officialStream | supported（解析器有，Monitor 未接） | unsupported | unsupported | unsupported |

`partial` 表示「有一点结构，但不能按 Codex turn/item 那样分层」。不要把 partial 写成 supported 后再要求 `turnRef`。

### 4.6 避免规则互相污染

1. 关键词表、事件名、路径、失败定义全部留在 Adapter 内。
2. 通用聚合器只认通用维度和证据优先级，不 `import` 任何一家的 JSONL type。
3. `classifyStopText` 保持旧 Monitor 专用；通用层若需要文本 hint，必须由 Adapter 显式标 `evidenceKind=text_keyword` 且 `confidence=low`。
4. Codex 专用解析（`codexObserve` / `codexState` / official vs session 隔离）**原文件保留**，Adapter 只做包装。
5. 禁止「先做一个共用 classify 再让四家调用」——那会把 Claude 文本规则送进 Codex。

### 4.7 兼容旧 Monitor，且不把 legacy `done` 当成成功

Adapter 可另出只读投影：

```text
legacyEquivalent: 'working' | 'done' | 'needs_attention' | 'failed' | 'unknown'
legacyReason?: AgentStopReason
```

规则：

- 投影是**兼容输出**，不是内部事实。
- Codex：`completed_signal` → legacy `done`，但 `taskSemantics` 仍为 `not_verified`；现有 `shouldPresentAgentTerminalToUser` 继续拦截成功展示。
- 其他 Agent：阶段 3–4 即使通用层得到 `completed_signal`，旧 Monitor 仍按今天的 `done` 展示，直到阶段 5 单独做产品决策。
- 任何文档、气泡、测试都不得写「legacyEquivalent=done 表示任务成功」。

### 4.8 哪些字段是 Codex 实现细节，不能当通用必填

| Codex 当前字段 | 是否通用 |
|---|---|
| lifecycle / cause / connection / process / session / turn / item / outputIntegrity / taskSemantics / retryability / confidence / evidence / observedAt | 概念通用 |
| `CodexNormalizedEventType`、`CODEX_STRUCTURED_EVENT_TYPES` | 不通用 |
| `exec_json` / `session_jsonl` / `codex_exec_json` | 不通用 |
| `thread.started`、`event_msg.task_complete` | 不通用 |
| `turnId` / `threadId` 常缺失 | 通用层可选，不得要求 |
| `applyProcess` / `finalizeIncomplete` | Codex 检测器 API，生产未用 |
| `completed_with_partial_failure` | Codex candidate 对照类，不是通用 lifecycle |
| `shouldNotify` | 展示层，且当前恒 false |

---

## 5. 原始信号到通用状态的映射

### 5.1 通用映射原则

```text
原始信号
  → Adapter.recognize()     识别或标明 unknown/unsupported/malformed
  → Adapter.toObservation() 填 channel / evidence / 可选 refs
  → AgentInterpreter        该 Agent 自己的 Intent（允许 unknown）
  → GenericAggregator       只做冲突、优先级、隔离、清理
  → AgentDerivedState
  → （可选）LegacyProjector → AgentMonitorEvent
  → （更后）VisibleMapper   桌宠 / 气泡 / 声音
```

Interpreter 可以是 Codex 现有 `interpret()` 的包装，也可以是 Cursor 对 `turn_ended` 的小组规则。**GenericAggregator 里不得出现 Agent 专有 type 字符串。**

### 5.2 建议映射（对照，不在本轮实施）

#### Codex（冻结，只投影）

| 原始信号 | 通用 lifecycle | 其他维度 | 证据等级 |
|---|---|---|---|
| `turn.started` / `task_started` / item started\|updated | `running` | turn=in_progress | 官方 high / 本地 medium |
| `turn.completed` / `task_complete` | `completed_signal` | taskSemantics=not_verified | 同上 |
| item completed + failed status | 保持 `running` | cause=tool_failed，item=failed/partial_failure | 同上 |
| 官方 `turn.failed` | `failed` | cause=turn_failed | high |
| 官方 `error` 单独 | `unknown` | outputIntegrity=partial | high 观察，低语义 |
| 普通 `turn_aborted(interrupted)` | `unknown` | turn=interrupted | medium |
| 明确用户取消词 | `cancelled` | cause=user_cancelled | 目前 FIXTURE_ONLY |
| 观察超过阈值无新行 | 不改 lifecycle | connection=stale | 产品策略 |
| assistant 文本 | 不进入新层 lifecycle | 只留旧路径 | 低 |

#### Claude

| 原始信号 | 建议通用层 | 旧 Monitor 仍输出 | 注意 |
|---|---|---|---|
| `stop_reason=tool_use` / user / last-prompt | `running` | working | 无 item 维度 |
| `stop_reason=end_turn` | `completed_signal` | done（兜底 completed） | 不是 succeeded |
| end_turn + 高置信 needs_input 文本 | lifecycle 仍 `completed_signal` 或保持 unknown；waiting 不得仅凭文本升格 | needs_attention | 文本只是 hint |
| end_turn + 高置信 error 文本 | **不得**整轮 failed | failed | 无结构化失败 |
| 其他 type | 忽略 | 忽略 | |

Claude 没有已验证的 turn 失败事件。通用层不得因为 `classifyStopText` 命中「构建失败」就写 `lifecycle=failed`。

#### Cursor

| 原始信号 | 建议通用层 | 旧 Monitor 仍输出 | 注意 |
|---|---|---|---|
| 末行非结束 | `running` | working | |
| `turn_ended/success` | `completed_signal` | done | 不是任务成功 |
| 老格式末行纯文本 assistant | `completed_signal` + confidence=low | done | 兼容启发式 |
| `turn_ended/error` | 待验证：可能是工作单元失败，**先 unknown 或仅扩展** | failed/error | 尚未用真实协议样本确认 error 等于 turn failed |
| `turn_ended/aborted` | `unknown`，turn=interrupted；无用户取消词不得 cancelled | failed/interrupted | 对齐 Codex 普通 abort |
| 文本 needs_input | 不升格 succeeded；waiting 保持未确认 | needs_attention | |
| subagents/ | 不观察 | 不产出 | 子任务结束 ≠ 用户任务结束 |

阶段 3 建议选 Cursor，正是因为 `turn_ended` 是可对照的结构化结束信号，同时又足够简单，不会倒逼修改 Codex。

#### Grok

| 原始信号 | 建议通用层 | 旧 Monitor 仍输出 | 注意 |
|---|---|---|---|
| transcript mtime 变化 | `running` | working | 外围活动，不是官方 turn.started |
| `awaitingUserResponse` 对象存在 | 可 `waiting_input`（lifecycle），cause 先 unknown | needs_attention | reason 字符串进 extension |
| `unreadCount > 0` | **unknown 或仅 inbox 扩展**，不得当 succeeded | done | 未读 ≠ 协议结束 ≠ 任务完成 |
| 文本 needs_input | 低可信 hint | needs_attention | |
| 无 failed 通道 | failed 保持 unsupported/unknown | 无 | |

Grok 若进入通用层，必须先新增「收件箱/未读」这类**扩展维度**，不要把它塞进 `completed_signal`。否则会污染另外三家的结束语义。

---

## 6. 状态聚合与冲突处理

通用层使用「证据优先级 + 分维聚合」，禁止单枚举覆盖。

### 6.1 优先级

从高到低：

1. **该 Agent Adapter 声明的结构化信号**（官方流 > 本地结构化会话，规则由该 Agent 自定）。
2. **显式进程 / 连接观察**（当前生产都没有；有则只改 process/connection）。
3. **文件活动 / mtime / 轮询空窗**（只影响 connection 或 running 活动，不产生终态）。
4. **文本关键词**（永远最低；不得覆盖 1–2；不得独立产生 succeeded/failed/user_cancelled）。

冲突时：留下更高优先级；把被压下的信号写入 `conflicts`；lifecycle 不够格就保持 `unknown`。

### 6.2 分维规则

| 冲突 | 规则 |
|---|---|
| 结构化结束 vs 文本「已完成」 | 结构化 → `completed_signal`；文本不能改成 succeeded |
| 结构化结束 vs 文本「构建失败」 | 结束信号仍是 `completed_signal`；文本失败不能升格整轮 failed |
| Adapter 信号 vs 通用外围（mtime/超时） | Adapter 赢；超时只标 stale |
| item/工具失败 vs turn 失败 | 前者保持 running + tool_failed；只有工作单元级失败才能 failed |
| 正常结束 vs 任务完成 | 前者 `completed_signal`；后者保持 `not_verified` |
| 用户取消 vs 网络断开 vs 普通中断 | 无明确取消词则 unknown；无结构化断网则不得写 network_error；stale ≠ 断网 |
| 观察失联 vs Agent 失败 | 只改 connection；明确终态不被 stale 覆盖（Codex 已如此） |
| 同一 work unit 内 | 保留失败事实：后续普通成功 item 只能把 item 收成 `partial_failure`；completed_signal 不得清掉 tool_failed |
| 新 work unit | 仅在 Adapter 发出「新单元开始」时重置 turn/item/outputIntegrity/本轮 cause |
| 多 session | `(agentId, sessionRef)` 各有一份 DerivedState；禁止用另一 session 的 working 给本 session 终态开门（旧 Monitor 已有此规则） |
| 多 Agent | 完全隔离。禁止全局共用 lastEvent 作为事实源（`AgentMonitorStatus.lastEvent` 只是诊断） |
| 旧事件重复 | Adapter `dedupKey` + 通用 journal；与旧 `seenIds` 并行，不得互相删除 |
| 启动历史文件 | 通用层必须有与 Shadow/Monitor 相同的 **prime**：首轮只建 cursor、登记已见证据，不回调、不通知、不进可见层 |

### 6.3 不要做成单枚举状态机

错误模型：`status = 最后一条事件的 kind`。  
正确模型：每个维度独立 merge，再由只读映射得到 candidate / legacyEquivalent。

Codex 已证明必要的 merge：

- `mergeCause`：新 turn 才重置；`tool_failed` 不被普通完成冲掉。
- `mergeOutputIntegrity`：`turn.completed` 不得把 partial 改成 complete。
- `mergeItemAfterFailure`：失败后的普通 item 变成 `partial_failure`。

这些函数的**思想**可进通用聚合器；函数本身先留在 Codex，等第二家有同等分层需求再抽取。

---

## 7. 多 Agent、多 session、多 turn 规则

### 7.1 隔离键

```text
AgentStore
  agentId
    sessionRef
      current: AgentDerivedState
      journal: AgentObservation[]
      workUnitRef?: string    // 只有 Adapter 提供时存在
```

没有 `sessionRef` 时，Adapter 必须提供自己的稳定隔离键（文件路径哈希、botId）。通用层不从时间戳生成 id。

### 7.2 多 Agent

- 设置开关、环境过滤仍按现有 `MonitorConfig`。
- 通用层即使某家开关关闭，也不得读取另一家的证据来补自己的 unknown。
- 阶段 5 之前，**不做**跨 Agent 的全局桌宠仲裁。Codex 已有的多 session 视觉仲裁只属于 Codex。

### 7.3 多 session

- 一家 Agent 的多个 session 同时 running：通用层全部保留。
- 旧 Monitor 的 `workingSeenAt` 按 `sessionKey` 隔离，通用层必须同样隔离。
- 一个 session 的旧 `completed_signal` 不能覆盖另一个 session 的新 `running`（Codex 可见层已有对照测试，通用层应写成同一条规则）。

### 7.4 多 turn / 无 turn

| Agent | 新单元如何识别 | 清理什么 | 不清理什么 |
|---|---|---|---|
| Codex | 官方 `turn.started` / 本地 `task_started` | 本轮 item / outputIntegrity / 本轮 cause | session、process、历史 evidence |
| Cursor | 末行不再是上一行终态，且出现新的非结束行；**没有 turn id** | 建议：session 级「当前末行状态」整体替换，而不是伪造 turn 清理 | 不得创造 turnRef |
| Claude | 新的 user / tool_use 行 | 同上，message 级，不叫 turn | 不得创造 turnRef |
| Grok | mtime 再次变化视为新活动窗口 | 不清理 awaiting/unread 之外的虚构 turn | turn 保持 unsupported |

### 7.5 观察失联

通用层只提供：

- `markObservationStale(session)`：`connection=stale`；
- `markObservationConnected(session)`：恢复 `connected`。

阈值是产品策略，按 Adapter 配置，不写进协议。Codex 当前 120s 不得未经对照就套到 Grok（Grok 本就靠「mtime 不变」判停）。

---

## 8. unknown 和 unsupported 的区别

见 §3.3。落地时的检查清单：

1. 能力表是 `unsupported` 的维度，DerivedState 里必须是 `{ presence:'unsupported' }`，测试不得接受 `unknown` 冒充。
2. 能力表是 `supported` 但本轮没证据，必须是 `unknown`，测试不得改成 `unsupported`。
3. 「真实样本里没出现过某事件」不得把该事件标成协议 unsupported（Codex `turn.cancelled` 就是前例）。
4. `taskSemantics` 对当前四家都应是 observed=`not_verified`，不是 unsupported——维度存在，只是尚未验证。
5. Grok 的 `turn` 是 unsupported；Grok 的 `lifecycle` 仍 supported（可以用 running / waiting / unknown）。

---

## 9. 与旧 Monitor 的兼容策略

### 9.1 旧 `AgentMonitorEvent` 继续保留

在阶段 5 的产品决策之前，旧事件仍是生产用户行为的唯一输入（Codex 实验开关除外）。

通用层并行运行，默认只写诊断，对标 Codex Shadow。

### 9.2 旧四分类如何作为兼容输出

| 旧 kind | 作为兼容输出的含义 | 能否直接驱动成功气泡 |
|---|---|---|
| `working` | 观察到活动 | 否（本来就不弹） |
| `done` | 「旧路径认为停下来了，且被归到完成档」 | **不能一刀切**。Codex 不能；其他 Agent 现阶段仍按旧产品行为 |
| `needs_attention` | 旧路径认为需要用户 | 可以继续驱动 attention 气泡（旧行为） |
| `failed` | 旧路径认为出错或中断 | 可以继续驱动 failed 气泡（旧行为）；内部不得等同于通用 `failed` |

### 9.3 哪些旧事件只能内部兼容

- **所有 Agent 的 `done`**：在通用层内部必须当作「可能只是协议结束 / 未读 / 文本像完成」，不能当作 `taskSemantics=completed`。
- **Codex `done`**：已经在展示层中性化，必须继续保持。
- **Codex `turn_aborted` 对应的旧 `failed`**：新层是 unknown；旧事件仍可存在于诊断，不能用来证明整轮失败。
- **Grok 因 unread 产生的 `done`**：兼容输出可以暂时保留，通用事实层不得写成 completed_signal/succeeded。

### 9.4 Codex 的 `done` 为什么必须继续保持中性

因为已经用真实官方 / session 样本证明：`task_complete` / `turn.completed` 只是轮次结束。旧文案「任务完成 ✅」是错的。`codexLegacyPresentation.ts` 把 Codex `done` 从成功气泡和完成音里拿掉，这是冻结行为，通用层接入后也不得恢复。

### 9.5 如何避免误伤其他 Agent

必须**分 Agent 兼容**：

| Agent | 旧用户行为（本阶段保持） | 通用层并行时 |
|---|---|---|
| Codex | `done` 中性；failed/needs_attention 仍按旧事件；candidate 三开关默认关 | 投影不得比检测器更激进 |
| Claude | `end_turn` 兜底仍可出完成气泡 | 通用层记 completed_signal；不改 handleAgentEvent |
| Cursor | `turn_ended/success` 仍可出完成气泡 | 同上 |
| Grok | unread 仍可出完成气泡 | 通用层不把 unread 当成功；不改旧扫描器 |

禁止做「通用层一上线，四家 `done` 全部改成中性 idle」。那会改变 Claude/Cursor/Grok 的现有产品语义，超出本轮和阶段 1–4。

### 9.6 何时可以删除旧路径

同时满足才能删：

1. 该 Agent 的 Adapter + 通用状态已有真实样本对照；
2. 旧 Monitor 与通用层的差异表稳定，且产品已决定可见层以通用层为准；
3. 历史 prime、去重、多 session、失联行为有测试；
4. 默认开关策略已单独评审。

当前：**四家都不满足**。Codex 最接近，但旧 `scanCodex` 仍要留作对照和回退。

---

## 10. 用户可见层的解耦原则

1. 可见层只读 `AgentDerivedState` 或显式兼容事件，不回写。
2. 不得从 `legacyEquivalent=done` 或旧 `kind=done` 推导 `succeeded`。
3. `confidence=high` 只表示事件识别成立，不是成功。
4. 桌宠状态集合保持现有 `idle | happy | sleepy | attention | thinking | failed`；不在通用层新增宠物状态。
5. 文案、声音资源、气泡是否弹出，全部留在各 Agent 的 presentation 或旧 `config.ts`。
6. `shouldNotify` 默认 false，直到单独产品决策。
7. Codex 已接线的实验可见层（视觉 / 部分失败气泡 / attention 音）继续只服务 Codex，不自动推广。
8. 阶段 5 之前，禁止「统一用户可见映射表」覆盖四家。

可见层候选（阶段 5 再讨论，本轮不定稿）：

| 通用事实 | 可能的展示 | 现在允许吗 |
|---|---|---|
| running | thinking | 旧层已有；Codex 实验层已有 |
| completed_signal | idle（中性） | 仅 Codex 中性化；其他家仍是 happy |
| completed_signal + item 失败 | attention | 仅 Codex 开关 |
| stale / unknown | 保持当前姿态 | 是 |
| failed / incomplete / cancelled | 未统一 | Codex 明确 not_wired |

---

## 11. 分阶段实施方案

原则：一次只加边界，不一次改四家。每个阶段默认开关关闭，可整阶段回退（删新文件或关诊断）。

### 阶段 1：只建立通用类型和适配器边界

目标：让编译器能表达通用状态，但没有任何 Agent 改行为。

| 做 | 不做 |
|---|---|
| 新增通用类型、能力表、Adapter 接口、空登记处 | 改 `classify.ts`、`monitor.ts`、各扫描器、`main.ts`、桌宠 |
| 文档保持本文 | 打开开关、写生产投影 |

建议新增文件：

- `src/shared/agentObservation.ts`（通用类型；**不要**把它们塞进 Codex 那段 types）
- `src/main/agent/generic/types.ts`（Adapter 接口）
- `src/main/agent/generic/registry.ts`（空登记，编译期完备）
- `src/main/agent/generic/presence.ts`（unsupported/unknown/observed 辅助）

不修改：`src/shared/types.ts` 里的 Codex 冻结类型（可从新文件 re-export 概念，但不得改枚举语义）。

验收：

- `pnpm test` / `pnpm typecheck` 全过；
- 用户行为零变化；
- 新类型能表达「Grok turn=unsupported」和「Codex turn=unknown」。

回滚：删除新文件。  
用户行为：无。

### 阶段 2：Codex 接入通用接口，保持现有行为

目标：Codex 检测器原样工作，外面加一层投影。

| 做 | 不做 |
|---|---|
| `codexAdapter.ts`：把 `CodexObservationEvent` / `CodexDerivedState` 映射到通用类型 | 改 `codexState.ts` 的 interpret/merge |
| 对照测试：投影后 lifecycle/cause/item/taskSemantics 与现有状态一致 | 改 Shadow 回调进 `handleAgentEvent` |
| 诊断可多写一份 generic 字段 | 降低 Codex 保守语义 |

不修改：`codex.ts` 旧扫描器、`classify.ts`、可见层开关默认值。

验收：

- 现有全部 `codex*.test.ts` 继续通过；
- 投影测试：`completed_signal` 不会变成 succeeded；item 失败不会变成 failed；stale 不改 lifecycle；
- 影子仍不进旧 onEvent。

回滚：删除 Adapter 与投影测试，检测器不动。  
用户行为：无（开关仍默认关）。

### 阶段 3：接入最容易验证的其他 Agent

选择：**Cursor**。

理由：

- 有结构化 `turn_ended` + `status`，比 Claude 纯 `stop_reason`/文本、Grok 未读语义更接近「协议结束信号」；
- 只看末行，隔离和去重规则清晰，测试已经钉死；
- 不需要 item 分层，不会倒逼通用层变复杂；
- 不会碰 Codex 冻结语义。

不选 Claude 的原因：`end_turn` 兜底 done 的产品包袱更重，且无结构化失败。  
不选 Grok 的原因：无 turn，unread 语义一旦进 `completed_signal` 会污染模型。

| 做 | 不做 |
|---|---|
| `cursorAdapter.ts`：读现有 `parseCursorFile` 已看到的最后一行，输出 Observation + DerivedState | 改 `scanCursor` 的 kind 输出 |
| 通用层：success → completed_signal；aborted → unknown；error 先 unknown 或 extension | 改 Cursor 完成气泡 |
| 影子诊断，默认不展示 | 把 aborted 写成 user_cancelled |

不修改：`cursor.ts` 用户可见映射、`handleAgentEvent`、`classify.ts`。

验收：

- `cursor.test.ts` 行为不变；
- 新对照测试：末行 success 的通用 lifecycle=`completed_signal` 且 taskSemantics=`not_verified`；
- 旧事件仍是 done，用户仍看到原来的完成提醒。

回滚：删除 Cursor Adapter。  
用户行为：无。

### 阶段 4：对照旧 Monitor 与通用层

目标：为 Codex（已有影子对照）和 Cursor 建稳定差异表。

| 做 | 不做 |
|---|---|
| 对照报告：旧 kind vs 通用 lifecycle/cause/item | 切换生产 onEvent |
| 明确列出「旧 done / 新 completed_signal」「旧 failed / 新 unknown」 | 用对照结果改文案 |

建议文件：`docs/cursor-legacy-generic-comparison.md`（阶段 4 才写，本轮不写假报告）。

验收：每条差异标明证据等级；禁止把 fixture 写成真实协议。  
回滚：停写对照。  
用户行为：无。

### 阶段 5：再考虑统一用户可见层

本阶段**现在不启动**。启动前必须单独产品决策：

- Claude / Cursor / Grok 的旧完成气泡要不要改成中性；
- 哪些通用状态允许出声；
- 是否删除旧 kind。

在那之前，可见层继续分 Agent。

---

## 12. 文件级修改清单

下列是**建议**，不是本轮已改文件。本轮只新增本文档。

### 12.1 阶段 1 建议新增

| 文件 | 作用 |
|---|---|
| `src/shared/agentObservation.ts` | 通用观察 / 派生状态 / 能力表 / presence |
| `src/main/agent/generic/types.ts` | Adapter 输入输出契约 |
| `src/main/agent/generic/registry.ts` | 按 AgentSource 登记 |
| `src/main/agent/generic/presence.ts` | unsupported vs unknown 辅助函数 |
| `src/shared/agentObservation.test.ts` | 只测类型辅助，不测 Agent 行为 |

### 12.2 阶段 2 建议新增 / 谨慎修改

| 文件 | 建议 |
|---|---|
| `src/main/agent/generic/codexAdapter.ts` | 新增包装 |
| `src/main/agent/generic/codexAdapter.test.ts` | 投影对照 |
| `src/main/agent/codexState.ts` | **不改逻辑**；最多导出已有函数供包装 |
| `src/shared/types.ts` | 尽量不改 Codex 冻结段；若要共享字面量，只允许从通用文件单向映射 |

### 12.3 阶段 3 建议新增

| 文件 | 建议 |
|---|---|
| `src/main/agent/generic/cursorAdapter.ts` | 新增 |
| `src/main/agent/generic/cursorAdapter.test.ts` | 用与 `cursor.test.ts` 相同的末行 fixture |
| `src/main/agent/cursor.ts` | **不改**扫描输出 |

### 12.4 明确不要改（阶段 1–4）

- `src/main/agent/classify.ts`
- `src/main/agent/monitor.ts` 的 ingest / prime / 去重 / onEvent
- `src/main/agent/codex.ts`、`claude.ts`、`grok.ts` 的事件映射
- `src/main/main.ts` 的 `handleAgentEvent` / 气泡 / 声音
- `src/main/config.ts` 文案（Codex done 中性文案已存在，勿改回成功）
- `src/main/agent/codexVisiblePresentation.ts` 等 Codex 可见层
- `src/shared/defaults.ts` 的默认开关
- 渲染层宠物 / `playDing`

### 12.5 若发现类型阻碍：只建议，不实施

当前 `src/shared/types.ts` 把 Codex 观察类型和 App 设置/IPC 放在同一文件。阶段 1 更适合**新文件**，避免误改冻结枚举。  
`AgentEventKind` 四分类不必扩展；扩展会诱使可见层继续用单枚举。

---

## 13. 测试矩阵

本轮不新增重复测试。下列是后续阶段应当补的测试，不是现在要写的代码。

### 13.1 单元测试

| 对象 | 断言 |
|---|---|
| presence | unsupported 不能被 unknown 赋值覆盖 |
| 通用聚合 | 文本 hint 不能压过结构化 completed_signal |
| 通用聚合 | item 失败 + 结束信号 → completed_signal，不是 failed |
| 通用聚合 | stale 不改 lifecycle |
| Codex 投影 | 与 `CodexDerivedState` 逐字段一致 |
| Cursor Adapter | 末行 success → completed_signal + not_verified |
| Cursor Adapter | aborted → 非 user_cancelled |
| 登记处 | 每个 AgentSource 都有能力表（阶段 3 后可先只登记 Codex/Cursor） |

### 13.2 集成测试

| 对象 | 断言 |
|---|---|
| Monitor + 通用影子并行 | 旧 onEvent 序列不变 |
| prime | 启动历史不进通用回调 |
| 多 session | working/终态按 sessionRef 隔离 |
| 多 Agent | Cursor fixture 不影响 Codex detector |

### 13.3 真实日志回放

| 对象 | 现状 |
|---|---|
| Codex session / official JSONL | 已有回放与影子对照，阶段 2 复用 |
| Cursor 真实 transcripts | **尚未**当协议样本入库；阶段 3 只能先用现有测试 fixture，并标明 `FIXTURE_ONLY` |
| Claude / Grok 真实文件 | 未做与通用层对照 |

### 13.4 真实运行验证

| 对象 | 要求 |
|---|---|
| Codex | 继续只读；不得为验证而降保守语义 |
| Cursor | 用户自然使用时只读末行与 `turn_ended`；禁止改 Cursor 配置 |
| 进程 / 断网 / 额度 | 四家都未建立通用观察；禁止故意断网或耗额度 |

---

## 14. 风险和回滚方案

| 风险 | 为何会出现 | 缓解 | 回滚 |
|---|---|---|---|
| 为统一而放宽 Codex | 其他 Agent 没有 turn.failed | Codex Adapter 只投影，检测器冻结 | 去掉投影 |
| 把旧 done 当成成功 | 四分类共用 done | 分 Agent 兼容；Codex 展示拦截保留 | 不改 handleAgentEvent |
| 文本关键词进入高可信 | classify 已被三家共用 | 通用层拒绝 text_keyword 作为 high | 删除通用 classify 调用 |
| Grok unread 污染 completed_signal | 旧路径已经这样做 | 阶段 3 不接 Grok；未读走扩展 | 不登记 Grok Adapter |
| Cursor aborted 被写成取消或失败 | 旧路径 failed/interrupted | 通用层 unknown | 只删 Adapter |
| 双写状态不一致 | 新旧并行 | 阶段 2–4 只对照，不驱动可见层 | 停影子 |
| 类型文件改坏 IPC/设置 | types.ts 过于拥挤 | 新类型放新文件 | revert 新文件 |
| 启动重放通知 | 忘记 prime | 复用 Monitor/Shadow 的 primed 语义 | 关通用回调 |

整阶段回滚口：

- 阶段 1–3：删除 `src/main/agent/generic/**` 与 `src/shared/agentObservation.ts`。
- 永远不要用改 classify / 改扫描器作为「接入通用层」的手段。

---

## 15. 仍需验证的问题

不得把下列未知写成不支持，也不得把 fixture 写成真实协议。

| 问题 | 已知 | 未知 | 验证方法 |
|---|---|---|---|
| Claude 是否还有除 `tool_use`/`end_turn` 以外的 `stop_reason` | 代码只处理这两类 | 真实协议完整集合 | 只读用户本地 jsonl，统计 type/stop_reason |
| Claude 是否有结构化失败 / 取消 | 旧路径只有文本 | 有无官方字段 | 同上；未出现不得标 unsupported |
| Cursor `turn_ended.status` 的完整枚举 | 代码认 success/aborted/其他→error | 是否还有 cancelled / timeout | 只读真实 transcripts |
| Cursor 行是否会在未来带时间戳 | 当前实现按无时间戳处理 | 协议是否会变 | 观察新版本文件，不猜测 |
| Grok `awaitingUserResponse.reason` 枚举 | 代码当任意字符串 | 是否区分审批 / 提问 | 只读 roster |
| Grok unread 与「一轮结束」的关系 | 旧路径当 done | 云端 Bot 是否有隐藏回合边界 | 对照连续 mtime 与用户操作；在确认前不映射 completed_signal |
| 四家外部进程 PID | 均无 | 能否安全关联 | 在无可靠关联前保持 process=unsupported |
| 跨 Agent 同时结束时的桌宠仲裁 | 旧层按时间排序 + 900ms 合并 | 通用层要不要统一 | 阶段 5 产品决策 |
| 其他家是否应对齐 Codex 的中性 `done` | Codex 已中性 | Claude/Cursor/Grok 用户是否接受「结束≠成功」 | 阶段 5 之前不改 |

---

## 16. 不应该通用化的内容

以下内容必须留在各 Agent Adapter、扫描器或可见层，禁止进入通用枚举或通用聚合器：

1. Codex 的具体 JSONL 事件名（`turn.completed`、`event_msg.task_complete`、`item.completed` 等）。
2. Codex 的 session 路径 `~/.codex/sessions`，以及 `exec --json` 通道细节。
3. Claude / Cursor / Grok / Codex 各自的文本关键词表；`classifyStopText` 本身。
4. Codex 特有的 turn 语义（官方无 turn_id、本地 abort 常有 turn_id）。
5. 某 Agent 的权限或审批协议（Codex approval、Grok awaiting reason、Cursor 授权文案）。
6. 某 Agent 的桌宠映射（Codex candidate → thinking/idle/attention）。
7. 某 Agent 的提示文案（`config.ts` 的「任务完成 ✅」、Codex「这一轮结束了」）。
8. 某 Agent 的声音资源（`playDing`、Codex 独立 attention 音）。
9. Cursor 的 subagents 过滤、project 边车环境推断、末行启发式。
10. Grok 的 base32 存储键、roster schema、unreadCount。
11. 环境推断字段：Claude `entrypoint`、Codex `originator`。
12. `completed_with_partial_failure`、`shouldNotify`、宠物皮肤状态。

---

## 17. 本轮结论（设计）

通用层可以建，而且边界已经清楚：

- 核心是分维状态 + presence（unsupported / unknown / observed）+ 分 Agent Adapter；
- Codex 继续当最保守的基准，只投影不改写；
- 旧 Monitor 继续当生产用户路径，且必须分 Agent 兼容；
- 下一阶段只建类型和接口，不接可见层，不改四家扫描器。

下一步唯一建议见实施报告第 12 节：进入阶段 1。
