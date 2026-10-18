# Codex 官方 exec --json 最小实测（阶段 4B）

## 1. 执行结论

**PARTIAL**

已在临时目录成功取得一份真实 `codex exec --json` 事件流，并用现有观察层 / 状态检测器只读回放。本次只覆盖部分官方事件，不能声称全部协议已验证。不能进入 Monitor 行为替换阶段。

## 2. CLI 检查

- `command -v codex`：不在 PATH。
- 可用 CLI：ChatGPT 桌面应用捆绑的 `codex-cli`（未安装、未改 PATH）。
- 版本：`codex-cli 0.153.4`
- `codex exec --help` 确认：JSONL 参数为 `--json`；临时目录需要 `--skip-git-repo-check`；最严沙箱为 `--sandbox read-only`。
- 未使用 `--dangerously-bypass-approvals-and-sandbox`、`--approve-for-me` 或其它扩权参数。
- 登录检查：`codex login status` → Logged in using ChatGPT。未改认证或配置。
- 需要网络（ChatGPT 登录通道）。本次未见认证、审批、配额或沙箱失败。

## 3. 执行安全性

- 工作目录：`$TMP/pingpet-codex-exec-*`（不在仓库、不在用户项目、不用 `$HOME`）。
- 实际参数：`exec --json --skip-git-repo-check --sandbox read-only --ephemeral --color never --cd <tmp>`。
- 退出码：0；耗时：31709 ms；stdout：634 字节 / 5 行；stderr：39 字节。
- Codex 未在临时目录额外创建或修改文件。
- 事件中的 item 类型仅为 `error`（条目种类）和 `agent_message`，未见 command/shell 类 item。
- 未修改 PingPet 生产代码、Monitor、桌宠、气泡、声音、classify、onEvent。
- 原始 JSONL 未进入仓库；解析完成后已从临时目录删除。

## 4. 真实事件统计

| 事件类型 | 次数 | 是否真实 exec JSONL | 是否已被 PingPet 解析 | 备注 |
|---|---:|---|---|---|
| `thread.started` | 1 | 是 | 是 | 仅此行携带 `thread_id`（长度 36） |
| `turn.started` | 1 | 是 | 是 | 无 `turn_id` |
| `item.completed` | 2 | 是 | 是 | 无 `item.started`；无 `status`；item 种类分别为 `error` 与 `agent_message` |
| `turn.completed` | 1 | 是 | 是 | 带 `usage` 数值字段，无 `turn_id` |
| `turn.failed` | 0 | 否 | — | 本次真实样本未出现，不能据此判断协议是否支持。 |
| `turn.cancelled` | 0 | 否 | — | 本次真实样本未出现，不能据此判断协议是否支持。 |
| `item.started` | 0 | 否 | — | 本次真实样本未出现，不能据此判断协议是否支持。 |
| `item.failed` | 0 | 否 | — | 本次真实样本未出现，不能据此判断协议是否支持。 |
| `error`（顶层） | 0 | 否 | — | 本次真实样本未出现，不能据此判断协议是否支持。 |
| 未知顶层 type | 0 | — | — | 5 行全部是合法 JSON 对象 |

字段存在：`thread_id`=1 行；`turn_id`=0；`item_id`=2；`status`=0；顶层 `error`=0；`usage`=1；approval/input waiting=0。官方事件无时间戳，`eventTime` 保持 null。

事件顺序：`thread.started` → `turn.started` → `item.completed` → `item.completed` → `turn.completed`。

## 5. 状态检测结果

迁移（脱敏）：

1. `thread.started` → lifecycle=`unknown`，session 开始，turn=`not_started`
2. `turn.started` → lifecycle=`running`，turn=`in_progress`
3. `item.completed`（itemKind=`error`，无 status）→ 检测器记 item=`succeeded`，lifecycle 仍 `running`
4. `item.completed`（itemKind=`agent_message`）→ 状态未变（unchanged）
5. `turn.completed` → lifecycle=`completed_signal`，turn=`completed`

最终 CodexDerivedState：

- lifecycle=`completed_signal`
- cause=`unknown`
- process=`not_observed`
- connection=`connected`
- session=`active`
- turn=`completed`
- item=`succeeded`
- outputIntegrity=`unknown`
- taskSemantics=`not_verified`
- retryability=`never`
- confidence=`high`
- evidence=1；conflicts=0

明确证据：官方 `turn.completed` 只是协议完成信号；检测器没有升格 `succeeded`。`taskSemantics` 保持 `not_verified`。最终 assistant 文本长度=15，不等于任务成功。

仍然 unknown / 不能下的结论：

- 无 `turn.failed`，不能声称整轮失败。
- 无取消结构化信号，不能声称用户取消。
- 无顶层 `error`，不能把 itemKind=`error` 写成官方 `error` 事件。
- 无 `turn_id`，不能做 turn 级一一对应。
- 官方事件无时间戳，不得猜 `eventTime`。

解析差异（本轮不改生产代码，待审核）：

- `item.completed` + `item.type=error` 且无 `status` 时，检测器按成功 item 处理。影响：可能把错误条目记成 item=`succeeded`。不要在本轮改模型。

## 6. 官方协议覆盖边界

**本次已验证（真实 exec JSONL）：** `thread.started`、`turn.started`、`item.completed`、`turn.completed`。

**本地 session 已验证但本次未出现：** `session_meta`、`event_msg.task_started`、`event_msg.task_complete`、`event_msg.item_*`、`event_msg.turn_aborted` 等本地信封。它们不是 `exec --json` 官方点号事件。

**仅 fixture 覆盖：** 仓库手写 `turn.failed` / 顶层 `error` / `item.started` 等。fixture ≠ 真实协议验证。

**仍未覆盖 / 无法确认：** `turn.failed`、`turn.cancelled`、`item.started`、`item.failed`、顶层 `error`、rate limit / quota、authentication / permission、approval / input waiting、stream disconnect / timeout / retry。本次真实样本未出现，不能据此判断协议是否支持。

## 7. 对 PingPet 的影响

- 未修改生产代码、Monitor、桌宠、气泡、声音、classify、onEvent。
- 未把新状态映射成 working/done/failed。
- **仍不能进入 Monitor 行为替换阶段。**
