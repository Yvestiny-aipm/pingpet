# Codex 候选用户状态（影子映射）

## 结论

候选状态不是正式用户状态。它只用于和旧 Monitor 并排对照、记录未来可能的桌宠/气泡策略，以及检查边界是否清晰。

当前不得用它替换 Monitor，不得驱动桌宠、气泡或声音。

## 1. 候选状态不是正式用户状态

`CodexCandidateState` 从 `CodexDerivedState` 算出，两者必须分开。

- 候选值只写本地 `diagnostics/codex-candidate.jsonl`。
- `shouldNotify` 永远是 `false`。
- `userVisible` / `productionVisible` 永远是 `false`。
- `legacyEquivalent=done` 只表示“如果仍走旧 Monitor，这一类事件以前会接近 done”，不是任务成功。

## 2. 当前为什么不接入桌宠

真实协议仍不完整：

- 官方 `turn.failed`、`turn.cancelled`、顶层 `error`、限流、鉴权、审批、断流、超时仍是样本未覆盖。
- `completed_signal` 只是协议结束，不是任务语义完成。
- item/tool 失败后 turn 仍可能继续，甚至打出 `turn.completed`。
- SIGINT 后真实 CLI 可以不发取消事件，只表现为进程中断和输出不完整。

在这些边界未验证前，把候选状态接到桌宠会把未证实的结论变成用户可见行为。

## 3. completed_signal 和 succeeded 的区别

| 名称 | 含义 | 当前是否产出 |
|---|---|---|
| `completed_signal` | 官方 `turn.completed` / 本地 `task_complete`：这一轮协议结束 | 是 |
| `succeeded` | 任务语义上确认完成 | 否。检测器拒绝产出；候选映射也不发明它 |

`taskSemantics` 当前固定 `not_verified`。因此：

- 无失败证据的 `completed_signal` 可以映射为候选 `completed_signal`，旧对应 `done`，影子宠物态可以是 `celebrating`；
- 这仍不是真正成功；
- 不得把 `confidence=high` 理解成任务成功。

## 4. item failure 和 turn failure 的区别

| 事实 | 检测器 | 候选 |
|---|---|---|
| 单个 item/tool `failed` / `partial_failure` | lifecycle 仍 `running` 或之后 `completed_signal` | `working`（谨慎）或 `completed_with_partial_failure` |
| 官方 `turn.failed` | lifecycle=`failed`，cause=`turn_failed` | `failed` |

不得因为 item 失败、stderr 出现 error、没有 turn 终态，就进入候选 `failed`。

## 5. process_exit 和 user_cancelled 的区别

| 事实 | 含义 | 候选 |
|---|---|---|
| `process_exit` / 观察结束无 turn 终态 | 监测端或进程中断，输出不完整 | `incomplete` |
| 官方 `turn.cancelled` 且 cause=`unknown` | 协议取消，未证实是用户取消 | `cancelled`，reason 不含 `user_cancelled` |
| 官方或本地事件明确用户取消词 | 用户取消 | `cancelled`，reason 可含 `user_cancelled` |

SIGINT 真实样本没有 `turn.cancelled`，只能确认进程中断，不能确认用户取消。

## 6. waiting 为什么不是终态

`waiting_input` / `waiting_approval` 表示 Agent 还在等用户或审批。当前检测器可能尚未稳定产出这些生命周期，映射已预留。

等待不是失败，也不是完成。候选为 `waiting`，旧对应 `needs_attention`，需要用户操作，不得自动重试。

## 7. unknown 为什么必须保留

缺少结构化证据时必须停在 `unknown`。不得猜成功、失败、取消或等待。

如果出现意外的 `lifecycle=succeeded`（检测器不应产出），候选也映射为 `unknown`，并记录 `unexpected_succeeded_lifecycle_not_mapped`。

## 8. 当前候选映射与旧 Monitor 的对应

| 候选 | 旧 Monitor 候选对应 | 影子宠物态 | 说明 |
|---|---|---|---|
| `working` | `working` | `working` 或 `cautious` | 无异常用 working；本轮已有 item 失败则 cautious，仍不通知 |
| `waiting` | `needs_attention` | `waiting` | 非终态 |
| `completed_signal` | `done` | `celebrating` | 只是兼容旧 done，不是任务成功 |
| `completed_with_partial_failure` | `needs_attention` | `cautious` | 协议结束但有工具失败 |
| `cancelled` | `needs_attention` | `cautious` | 不是 failed |
| `incomplete` | `needs_attention` | `cautious` | 进程中断 / 输出不完整 |
| `failed` | `failed` | `sad` | 仅明确 turn 级失败 |
| `unknown` | `unknown` | `unknown` | 不猜；观察失联时也用 unknown |

优先级：

`failed` > `cancelled` > `incomplete` > `observation_stale` > `waiting` > `completed_with_partial_failure` > `completed_signal` > `running_with_partial_failure` > `working` > `unknown`

补充：

- `completed_signal` + item 失败优先于普通 completed。
- `incomplete` 优先于 `running`。
- `process_exit` 不得被 `running` 盖掉，也优先于 `observation_stale`。
- `connection=stale` 是 PingPet 观察失联，不是 Agent 失败。lifecycle 通常仍为 `running`，candidate 为 `unknown`，reasonCodes 含 `observation_stale`。详见 [codex-observation-stale.md](./codex-observation-stale.md)。
- 新 turn 才清除上一轮 item/cause 聚合；候选只读当前 `CodexDerivedState`。
- 诊断同时保留 derived 摘要和 candidate，不得只存候选。

## 9. 之后需要哪些真实样本才能进入正式替换

至少还需要真实 `codex exec --json` 覆盖：

- `turn.failed`
- `turn.cancelled`
- 顶层 `error`
- 限流 / quota
- 鉴权 / 权限失败
- 审批 / 等待输入
- 断流 / 超时

并且要先证明：候选与旧 Monitor 长期对照稳定，用户不会因为 `completed_signal` 或 item 失败被误伤。

在此之前，正式 Monitor 仍走 classify / 旧 onEvent。

## 10. 哪些动作和气泡仍然禁止启用

禁止用候选状态启用：

- 桌宠动作（working / celebrating / sad / cautious / waiting）
- 桌宠视觉状态
- 完成气泡、失败气泡、需要注意气泡
- 声音
- 自动重试
- 把 `legacyEquivalent=done` 当成任务成功提示
- 把 `candidatePetState=celebrating` 接到 renderer
- 把 `notificationCandidate` 变成真实通知

`shouldNotify` 保持 `false`，直到另开一轮、并且真实协议样本足够，才能讨论 Monitor 行为替换。
