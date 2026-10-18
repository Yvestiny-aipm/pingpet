# Codex 用户可见表现映射（提案）

本文件只做设计和审计。不接入桌宠、气泡、声音，不打开 `shouldNotify`，不替换正式 Monitor，不实现 process observer。

每条结论标注：

- **已验证事实**：真实 Codex 样本或已落地实现/测试已经证明。
- **根据现有实现推断**：代码已经这样算，但真实协议或用户观感尚未完全证明。
- **产品设计建议**：本轮提出的可见层方案，尚未实现。

当前影子 candidate 的 `shouldNotify` 必须继续为 `false`。`candidatePetState=celebrating` 只是对照字段，不得接到 renderer。

---

## 1. 当前已验证能力

| 能力 | 证据性质 | 说明 |
|---|---|---|
| 官方 `turn.started` → lifecycle=`running`，candidate=`working` | 已验证事实 | 最小回复、工具失败、sleep、SIGINT 样本均见过 |
| 官方 `turn.completed` / 本地 `task_complete` → `completed_signal`，不是 `succeeded` | 已验证事实 | 检测器拒绝产出 `succeeded`；`taskSemantics` 固定 `not_verified` |
| 工具 `item.completed` + `status=failed` 后仍可 `turn.completed` | 已验证事实 | 真实工具失败样本；candidate=`completed_with_partial_failure` |
| 进行中的 tool fail 保持 `running` + `tool_failed`，candidate 仍是 `working`（谨慎） | 已验证事实 | 不得升格 turn `failed` |
| SIGINT 后官方流可以没有 `turn.completed` / `turn.failed` / `turn.cancelled` | 已验证事实 | 退出码非 0；不能猜 `user_cancelled` |
| detector `applyProcess` 能产出 `incomplete` / `process_exit` | 已验证事实 | 仅单元测试与显式注入；生产 Monitor 未调用 |
| 进程/session 无法安全关联 | 已验证事实 | PingPet 不启动 Codex，JSONL 无 pid，无法取得非本进程 exitCode/signal |
| `connection=stale` + candidate=`unknown` + `observation_stale` | 已验证事实（单元/注入 clock） | 影子层已实现；连续空 tick 只写一次，恢复只写一次 |
| 真实 sleep 130 秒未观察到 stale | 已验证事实 | 官方 stdout 静默，但 session JSONL 约每 30 秒仍有 tool/token 心跳 |
| priming 历史文件不回调、不通知 | 已验证事实 | 启动读旧文件不进 `onCodexState` |
| 影子路径不进 `handleAgentEvent` | 已验证事实 | 只写诊断；旧 Monitor 仍走 classify / onEvent |
| `shouldNotify` 恒为 false | 已验证事实 | 候选映射写死 |

旧 Monitor 现有用户可见行为（对照，不是本提案的实现）：

- `working` → 宠物 `thinking`，不弹气泡。**已验证事实**（`handleAgentEvent`）
- `done` / `needs_attention` / `failed` → 停下来才弹气泡；`done` 可按设置播放完成音。**已验证事实**
- 宠物状态只有 `idle / happy / sleepy / attention / thinking / failed`。**已验证事实**

---

## 2. 当前不能确认的能力

| 缺口 | 性质 | 对可见层的影响 |
|---|---|---|
| 官方真实 `turn.failed` | 未确认 | 不能把 `failed` 当成已验证的用户可见终态 |
| 官方真实 `turn.cancelled` | 未确认 | 不能把安静取消当成已验证路径 |
| 顶层 `error`、限流、鉴权、审批、等待输入、断流 | 未确认 | `waiting` / 部分 cause 只是预留 |
| 任务语义是否真正完成 | 未确认 | `taskSemantics` 一直是 `not_verified` |
| 外部 Codex 进程退出 | 不能可靠观察 | `incomplete` / `process_exit` 不得作为当前用户可见状态 |
| 真实 session 出现 ≥120s 无新行 | 未确认 | 真实 stale 文案和误报率还不能定稿 |
| `confidence=high` 是否表示任务成功 | 已验证事实：不是 | 只表示结构化事件可信，不得写成成功文案 |

---

## 3. 必须逐项讨论的 candidate

以下“建议桌宠动作”映射到现有宠物状态，而不是发明新动画。`cautious` 建议落成 `attention`，`unknown` 建议保持当前姿态或短暂 `attention`，不要用 `failed`。

### 3.1 working

**当前实现（根据现有实现推断）**

- lifecycle 通常 `running`，turn=`in_progress`
- 无 item 失败：`candidatePetState=working`，`notificationCandidate=none`，`requiresUserAction=false`，`retryRecommendation=none`
- 已有 `tool_failed` / `partial_failure`：仍是 candidate=`working`，宠物对照为 `cautious`，仍不通知
- `outputIntegrity=partial` 且 item=`unknown`：同样谨慎 working，不升格失败

**产品设计建议**

| 维度 | 建议 |
|---|---|
| 桌宠 | 普通工作 → `thinking`。本轮已有工具失败 → 静默 `attention`，不要改成 `failed` |
| 气泡 | 不显示 |
| 声音 | 不播放 |
| 用户操作 | 不需要 |
| 重复提醒 | 禁止。每个 poll / 每个 item 更新都不得弹 |

**为什么不能频繁打扰**

Codex 一轮里会连续写出 `item.started` / `item.completed` / `token_count` / reasoning。真实 sleep 样本里，官方流静默时 session 仍约 30 秒写一次心跳。**已验证事实**。若 working 弹气泡或出声，用户会被心跳和工具进度淹没。旧 Monitor 已经选择“干活只思考、不停不说话”。**已验证事实**。可见层应继承这条，而不是加进度播报。

---

### 3.2 completed_signal

**已验证事实**

- 只表示官方 `turn.completed` 或本地 `task_complete`：协议这一轮结束了。
- 不等于任务真正成功。检测器不会产出 `succeeded`。
- `taskSemantics=not_verified`。`reasonCodes` 含 `not_succeeded`、`legacy_done_is_not_task_success`。
- 无工具失败的真实最小回复、以及 sleep 后正常结束，最终都是这个 candidate。
- 当前影子对照把 `candidatePetState` 写成 `celebrating`，只为兼容旧 `done`→`happy`，**不是**已经批准的用户文案。

**产品设计建议**

| 维度 | 建议 |
|---|---|
| 桌宠 | **不要用庆祝作为默认。** 优先中性收尾：短暂 `idle`，或沿用旧 `happy` 但必须搭配“中性结束”文案。若使用庆祝动作，气泡必须写明“这一轮结束了，还没确认任务是否做完” |
| 气泡 | 允许**一条**中性气泡。禁止“任务已完成 / 成功了 / 搞定了” |
| 声音 | 默认关。旧路径在 `done` 上会响完成音；新映射不应照搬，以免用户把完成音理解成成功 |
| 用户操作 | 默认不要求。用户如果关心结果，自己去看 Codex |
| 任务语义 | 在 `taskSemantics` 仍为 `not_verified` 之前，任何成功措辞都禁止 |

**如何避免误以为任务已完成**

1. 文案用“这一轮结束了”，不用“任务已完成”。**产品设计建议**
2. 不把 `legacyEquivalent=done` 或 `confidence=high` 显示给用户。**已验证事实 + 产品设计建议**
3. 等以后有任务语义验证，再单独开 `succeeded` 可见层。现在没有这条路。**已验证事实**

---

### 3.3 completed_with_partial_failure

**已验证事实**

- 真实工具失败样本：item failed 之后仍收到 `turn.completed`。
- lifecycle=`completed_signal`，cause=`tool_failed`，item=`partial_failure` 或 `failed`，`outputIntegrity=partial`。
- candidate=`completed_with_partial_failure`，`candidatePetState=cautious`，`requiresUserAction=true`，`retryRecommendation=user_decision`。
- 这不是 turn 级 `failed`。

**产品设计建议**

| 维度 | 建议 |
|---|---|
| 桌宠 | `attention`（谨慎）。禁止 `failed` / `sad` |
| 气泡 | 一条。告诉用户：“这一轮结束了，但有工具失败，建议看一下结果。” 不要说整轮失败，也不要说已经成功 |
| 声音 | 可选轻提示，且必须和失败音区分；默认宁可静音 |
| 用户操作 | 建议用户查看结果。不自动打开文件、不自动重试 |
| 自动重试 | 禁止 |
| 与完整失败的差异 | 失败用 `failed` 姿态 + “这一轮失败了”；本态用 `attention` + “结束但有工具问题”。颜色/文案都要能一眼分开 |

进行中的 `tool_failed`（lifecycle 仍 `running`）不属于本态，仍按 working 静默谨慎处理。**已验证事实**

---

### 3.4 unknown / observation_stale

**已验证事实**

- `connection=stale` 时 lifecycle 通常仍是 `running`，candidate=`unknown`，`reasonCodes` 含 `observation_stale`。
- 表示 PingPet 无法确认 Agent 当前最终状态，不是 Agent 失败，不是用户取消，不是 `process_exit`。
- 失败事实（`tool_failed` / `partial_failure`）进入 stale 后保留。
- 注入 clock 下可恢复 `connected`，并写一次 `observation_recovered`。
- 真实 sleep 未进入 stale，因为 session 心跳短于 120 秒阈值。
- priming、文件缺席、删除、mtime 过旧不会单独进 stale。

**产品设计建议**

| 维度 | 建议 |
|---|---|
| 桌宠 | 静默保持上一姿态，或极弱 `attention`。禁止 `failed` |
| 气泡 | 默认不显示。若将来显示，只允许一次：“暂时无法确认 Agent 状态”。禁止“Agent 失败了 / 已取消” |
| 声音 | 不播放 |
| 恢复提醒 | **默认不提醒。** 恢复后静默回到 working / 对应终态。历史 stale 不是新失败 |
| 心跳误报 | 120 秒阈值在真实 Codex 下可能偏短或偏长都尚未定论。在真实 stale 样本出现前，**不要**把 stale 做成强提醒。阈值是产品策略，不是协议 |

`unknown`（非 stale，只是证据不足）必须保留，不得猜成功/失败/取消。**已验证事实**。可见层同样不猜。

---

### 3.5 incomplete / process_exit

**已验证事实（限制）**

- detector 在显式 `applyProcess({ status:'exited', exitCode≠0 或 signal })` 且 turn 未结束时，能得到 `lifecycle=incomplete`，`cause=process_exit`，`process=exited`，`turn=unknown`，`outputIntegrity=partial`。
- candidate=`incomplete`，`candidatePetState=cautious`，不得变成 cancelled/failed。
- PingPet **不能**安全取得外部 Codex 的 PID、启动时间、exitCode 或 signal。
- 因此 **暂时不能把它作为可靠的用户可见状态**。文件停写、mtime、stderr、`turn_aborted`、item failed 都不能代替进程退出。

**未来若有可靠进程证据（产品设计建议）**

| 维度 | 建议 |
|---|---|
| 桌宠 | `attention`。禁止 `failed`，禁止当成取消 |
| 气泡 | 一条：“进程中断了，输出可能不完整。” 不说用户取消，不说任务失败 |
| 声音 | 默认关 |
| 用户操作 | 需要用户自己决定是否重开 |
| 自动重试 | 禁止 |

**区别**

| | incomplete / process_exit | unknown / stale | failed | cancelled |
|---|---|---|---|---|
| 证据 | 已关联进程异常退出 | PingPet 看丢了 | 官方 `turn.failed` | 协议取消 / 明确用户取消词 |
| 当前可见？ | 否 | 弱，默认不可见 | 仅当真实 `turn.failed` 被确认后 | 仅当真实取消协议被确认后 |

`exitCode=0` 且无 turn 终态：现有实现不自动改成 `process_exit`。**根据现有实现推断**。可见层也不要发明“正常退出但没结束”。

---

### 3.6 cancelled

**根据现有实现推断**

- lifecycle=`cancelled`。有明确用户取消词时 cause=`user_cancelled`，否则 cause=`unknown`。
- candidate=`cancelled`，宠物对照 `cautious`，`requiresUserAction=true`，`retryRecommendation=user_decision`。
- 本地 `turn_aborted` 没有明确取消词时，**不是** cancelled，而是 lifecycle=`unknown`。真实 SIGINT 也没有官方 `turn.cancelled`。

**产品设计建议**

| 维度 | 建议 |
|---|---|
| 桌宠 | 安静收尾：回到 `idle` 或短暂 `attention`。禁止 `failed` |
| 气泡 | 可选一条：“已经停下来了。” 有 `user_cancelled` 时可以说“你取消了这一轮”，没有则不要猜是谁取消的 |
| 声音 | 不播放 |
| 自动重试 | 禁止 |
| 用户操作 | 不强迫。用户已经停了 |

官方 `turn.cancelled` 尚未被真实样本覆盖。在那之前，取消可见层只是预留。**已验证事实（缺口）**

---

### 3.7 failed

只讨论明确的 **turn 级失败**：lifecycle=`failed` 且 cause=`turn_failed`（或 turn=`failed`）。item/tool 失败、process_exit、stale、stderr 文本都不算。

**根据现有实现推断**

- candidate=`failed`，`candidatePetState=sad`，`notificationCandidate=candidate_failure`，`requiresUserAction=true`，`retryRecommendation=unknown`
- 真实官方 `turn.failed` 样本仍未见到。**已验证事实（缺口）**

**产品设计建议**

| 维度 | 建议 |
|---|---|
| 桌宠 | `failed` |
| 气泡 | 一条：“这一轮失败了。” 不要附带未证实的原因（限流/鉴权等） |
| 声音 | 可以，但应与完成音区分；默认跟随用户“完成提示音”开关并不合适，更宜单独开关或先静音 |
| 用户操作 | 需要用户查看 |
| 重试 | 不自动重试。`retryability` 现为 `unknown`，可见层写“你可以再试”，不要替用户点 |

**区别**

- vs item/tool failed：工具失败后 turn 仍可能继续并 `turn.completed`。**已验证事实**
- vs process_exit：那是进程没了，不是协议宣布失败。当前还不能对用户说。**已验证事实**

---

## 4. candidate 到桌宠表现的建议映射表

现有宠物状态：`idle` / `happy` / `sleepy` / `attention` / `thinking` / `failed`。

| candidate | 建议宠物状态 | 是否静默改姿态 | 现在能否对用户启用 | 结论性质 |
|---|---|---|---|---|
| `working`（无失败事实） | `thinking` | 是 | 暂不。旧 Monitor 已有同类行为，但不要接 candidate | 产品设计建议 |
| `working`（有 tool_failed） | `attention` | 是 | 暂不 | 产品设计建议 |
| `completed_signal` | `idle`（首选）或谨慎 `happy` | 是 | 暂不。禁止默认庆祝 | 产品设计建议 |
| `completed_with_partial_failure` | `attention` | 是 | 暂不 | 产品设计建议 |
| `unknown` / `observation_stale` | 保持原姿态，或弱 `attention` | 是 | 暂不 | 产品设计建议 |
| `incomplete` | `attention` | 是 | **否**。进程证据未接入 | 已验证事实 + 产品设计建议 |
| `cancelled` | `idle` 或弱 `attention` | 是 | 暂不。缺真实 `turn.cancelled` | 产品设计建议 |
| `failed` | `failed` | 是 | 暂不。缺真实 `turn.failed` | 产品设计建议 |
| `waiting` | `attention` | 是 | 否。检测器尚未稳定产出 | 根据现有实现推断 |

禁止：把 `celebrating` 直接接到 `happy` 并配“完成了”文案。**产品设计建议**  
禁止：把 `cautious` 接到 `failed`。**产品设计建议**

---

## 5. candidate 到气泡的建议映射表

| candidate | 是否气泡 | 次数 | 建议文案方向 | 禁止文案 |
|---|---|---|---|---|
| `working` | 否 | 0 | — | 任何进度播报 |
| `completed_signal` | 可选一条 | 1 | “这一轮结束了” | “任务已完成 / 成功” |
| `completed_with_partial_failure` | 是 | 1 | “结束了，但有工具失败，建议看结果” | “任务失败了 / 已经成功” |
| `unknown` / stale | 默认否；最多一条弱提示 | 0 或 1 | “暂时无法确认 Agent 状态” | “失败 / 取消 / 崩溃” |
| `incomplete` | 未来一条 | 1 | “进程中断，输出可能不完整” | “你取消了 / 任务失败” |
| `cancelled` | 可选一条 | 1 | “已经停下来了” | “失败” |
| `failed` | 是 | 1 | “这一轮失败了” | 未证实的具体原因 |
| `waiting` | 未来一条 | 1 | “在等你” | 当做成失败 |

所有气泡在正式接入前都不得发出。`shouldNotify` 保持 false。**已验证事实 + 产品设计建议**

---

## 6. candidate 到声音的建议映射表

| candidate | 声音 | 说明 |
|---|---|---|
| `working` | 无 | 已验证事实：干活不应出声 |
| `completed_signal` | 默认无 | 产品设计建议：避免完成音 = 成功 |
| `completed_with_partial_failure` | 默认无；最多轻提示 | 产品设计建议：不得用失败音 |
| `unknown` / stale | 无 | 产品设计建议 |
| `incomplete` | 无（未来也默认无） | 产品设计建议 |
| `cancelled` | 无 | 产品设计建议 |
| `failed` | 可选，且与完成音分开 | 产品设计建议；真实 `turn.failed` 未验证 |

旧设置 `agentCompletionSoundEnabled` 只服务旧 `done`。新映射不要复用它当“成功音”。**根据现有实现推断 + 产品设计建议**

---

## 7. 用户操作建议

| candidate | requiresUserAction（当前实现） | 可见层建议 |
|---|---|---|
| `working` | false | 不打断 |
| `completed_signal` | false | 不强迫查看；文案保持中性 |
| `completed_with_partial_failure` | true | 建议看结果，不自动打开、不自动修 |
| `unknown` / stale | false | 不要求用户处理 PingPet 自己的观察空档 |
| `incomplete` | true（实现已写） | 未来才对用户说；现在不对用户说 |
| `cancelled` | true | 不强迫；用户多半已经停了 |
| `failed` | true | 请用户看这一轮为什么失败 |

`retryRecommendation`：

- `none`：working / 普通 completed_signal → 不要提重试
- `user_decision`：partial failure、cancelled → “要不要再试由你决定”
- `unknown`：failed、incomplete、stale → 不要替用户重试，也不要假装知道能不能重试

**自动重试一律禁止。** 已验证原则，不是本轮新发明。

---

## 8. 用户提醒优先级

从高到低（用户可见打扰程度，不是 detector 内部覆盖顺序）：

1. **failed** — 一条气泡；姿态 `failed`；声音可选且单独策略。当前因缺真实样本，**先不启用**。
2. **completed_with_partial_failure** — 一条注意气泡；姿态 `attention`；默认无声。当前**先不启用**。
3. **cancelled** — 安静收尾；最多一条“已停止”。当前**先不启用**。
4. **incomplete** — 预留注意气泡。**现在不可启用**。
5. **completed_signal** — 一条中性结束；不庆祝成功；默认无声。当前**先不启用**。
6. **unknown / observation_stale** — 默认不通知；最多一次弱提示。当前**先不启用**。
7. **working** — 只允许静默改桌宠。当前也不要接 candidate，以免和旧 Monitor 双通道打架。

### 哪些状态不应该通知

- working（含 running + tool_failed）
- stale / 普通 unknown（默认）
- priming、历史回放、恢复瞬间
- 任何 `shouldNotify=false` 的当前影子输出

### 哪些状态只应该静默改变桌宠

- working → `thinking` 或静默 `attention`
- stale → 最好连姿态都不抢；最多弱 attention
- completed_signal 若采用中性 idle，也可以只改姿态、不说话（比乱庆祝更安全）

### 哪些状态应该显示一次气泡

- 未来：failed、completed_with_partial_failure
- 谨慎未来：cancelled、中性 completed_signal、incomplete
- stale 默认零次

### 哪些状态可以播放声音

- 当前：无
- 未来仅 failed 可考虑独立提示音
- completed_signal 不要默认响

---

## 9. 通知去重策略

**产品设计建议**（对照已实现的影子去重）：

1. 键：`fileAlias` + `sessionId`（若有）+ `turnId`（仅当真实提供，不得猜）+ `candidate`。
2. 同一键只打扰一次。连续 tick 的 running / stale 不得重复写气泡。
3. stale 进入一次、恢复一次；恢复默认不打扰。
4. 新 turn 才允许同一 candidate 再提醒一次。没有 `turnId` 时退回 session 级，宁可漏提醒，不要按时间猜 turn。
5. 多个 session 隔离。合并窗口可参考旧 `AGENT_TERMINAL_COALESCE_MS`，但新映射未接入前不要改旧合并逻辑。
6. `shouldNotify` 仍是总闸，当前恒 false。

影子诊断已经按 observationId 去重，并且 stale/recover 各一次。**已验证事实**。可见层应抄策略，不要抄输出。

---

## 10. 历史重放保护

**已验证事实**

- 首轮扫描只 priming，不派发旧 onEvent，也不发影子回调。
- 旧文件长时间不更新不会自动 stale。
- 文件轮换/截断会重新 priming，不把旧终态再提醒一遍。

**产品设计建议**

- 可见层必须复用同一套 prime：启动时读到的历史 `completed_signal` / `failed` / `cancelled` 一律不弹、不响。
- 不得在应用刚打开时把昨夜的 Codex session 标成“未知”或“失败”。
- 不得用文件 mtime 或“文件不在本轮列表”补一条过期通知。

---

## 11. 可恢复性和自动重试建议

| 状态 | 可恢复？ | 自动重试 | 说明 |
|---|---|---|---|
| working | 本身就是进行中 | 否 | — |
| stale | 是，新事件后回到 connected | 否 | 恢复不当成失败 |
| completed_signal | 否（协议已结束） | 否 | 语义未验证，不能说“不用重试因为成功了” |
| completed_with_partial_failure | 否 | 否 | 用户自己决定要不要再跑 |
| incomplete | 未来：用户重开 | 否 | 现在不对用户说 |
| cancelled | 否 | 否 | 用户已停 |
| failed | 未知 | 否 | `retryability=unknown` |

`retryability=never` 若出现在旧回放文档里，只表示产品禁止自动重试或历史字段，**不得**解释成“已经成功所以不必重试”。当前 candidate 对 completed_signal 用 `retryRecommendation=none`，含义是“不要提自动重试”，不是任务成功。**根据现有实现推断**

---

## 12. 暂不实现的状态与能力

现在不要做：

1. 把 candidate 接到 `handleAgentEvent` / 桌宠 / 气泡 / 声音
2. 打开 `shouldNotify`
3. 把 `completed_signal` 显示成成功或默认庆祝
4. 把 `incomplete` / `process_exit` 做成用户可见状态
5. 实现 process observer
6. 把 stale 做成强提醒（真实心跳会短于阈值）
7. 自动重试
8. 修改 classify、旧 working/done/failed
9. 为限流、鉴权、审批、断流编造可见文案
10. 发明 `succeeded` 用户状态

等待中的 `waiting_input` / `waiting_approval` 只保留映射，不做可见层。**根据现有实现推断**

---

## 13. 后续实施顺序

在 `shouldNotify` 仍为 false 的前提下，若以后要做可见层，建议按风险从低到高：

1. **只读对照再跑一段时间**：candidate 与旧 Monitor 并排，确认没有把 tool fail 写成 failed。  
   条件：已有；继续即可。
2. **静默桌宠（无气泡无声音）且仅 working → thinking**  
   条件：必须保证不和旧 Monitor 双写打架。更稳妥的是先关旧 Codex 可见通道，再接新通道。当前**不具备**。
3. **一条中性 completed_signal 气泡**（禁止成功措辞）  
   条件：文案评审通过；与旧 `done`+完成音隔离。当前**不具备**。
4. **completed_with_partial_failure 一条注意气泡**  
   条件：工具失败真实样本已有；仍需确认文案不会被看成整轮失败。当前**接近但未批准接入**。
5. **stale 弱提示**  
   条件：先有真实 session 空档 ≥ 阈值的样本，并调阈值。当前**不具备**。
6. **cancelled / failed 可见层**  
   条件：真实官方 `turn.cancelled` / `turn.failed`。当前**不具备**。
7. **incomplete / process_exit 可见层**  
   条件：安全的进程/session 关联。当前**不具备**。

---

## 14. 字段如何进入可见层（只设计，不实现）

可见层以后不得只看 `candidate` 一个字段。建议读取顺序：

1. `taskSemantics`：只要是 `not_verified`，禁止成功文案。**已验证事实 + 产品设计建议**
2. `lifecycle` + `cause`：区分 turn failed / cancelled / incomplete / completed_signal
3. `connection`：`stale` 只影响“我们看没看丢”，不改任务结论
4. `item` + `outputIntegrity`：决定是否“有工具失败 / 输出不完整”
5. `retryability` / `retryRecommendation`：只影响要不要提重试，不自动做
6. `requiresUserAction`：只影响要不要请用户看一眼
7. `confidence`：低置信度时降级为不说话或 unknown，**不得**把 high 显示成成功
8. `reasonCodes`：给诊断和文案选择，不直接展示原始 code

文件级以后若实施（本轮不建这些文件）：

| 建议文件 | 职责 | 现在做吗 |
|---|---|---|
| `docs/codex-user-visible-state-mapping-proposal.md` | 本提案 | 本轮只写这个 |
| 未来 `src/main/agent/codexVisiblePresentation.ts` | 纯函数：Derived+Candidate → 文案/姿态/是否出声；`shouldNotify` 仍 false | 否 |
| 未来其测试 | 冻结“completed_signal 无成功词 / stale 非失败 / tool_failed 非 turn failed” | 否 |
| `src/main/main.ts` `handleAgentEvent` | 保持旧路径 | 不改 |
| `src/main/agent/classify.ts` | 保持旧路径 | 不改 |
| 桌宠 / 气泡 / 声音模块 | 不改 | 不改 |

---

## 15. 和旧 Monitor 的冲突

若同时启用旧 Codex onEvent 和新 candidate 可见层，用户会看到：

- 旧路径：`working` 思考；`done` 可能 `happy` + “完成”气泡 + 完成音
- 新路径：`completed_signal` 想说“只是协议结束”

这会直接违反“completed_signal 不得等于成功”。**根据现有实现推断**。所以正式可见层开发的第一刀不是加气泡，而是决定 **Codex 是否退出旧 done 文案**。本轮不做这个决定的实现。

---

## 16. 结论：现在能不能进用户可见层开发

**不能。** 设计可以停在本文。实现可见层还缺：

- 成功/庆祝文案的产品否决已经写清，但旧 Monitor 仍会把 `done` 当完成提醒
- `turn.failed` / `turn.cancelled` 真实样本
- 安全的 process_exit 观察
- 真实 stale（session 也静音超过阈值）后再谈 stale 文案
- 明确 Codex 不再走旧 onEvent，或旧文案先改成中性

在此之前，继续只写影子诊断。`shouldNotify=false`。
