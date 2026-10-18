# Codex 影子观察失联（observation_stale）

`observation_stale` 是 PingPet 的产品策略，不是 Codex 官方状态，也不是协议终态。

当影子观察层已经 priming 完成、真实见过新事件、当前 turn 曾经 running / in_progress，却在一段可配置时间内再也看不到新事件时，PingPet 只能承认：**无法确认 Agent 当前最终状态**。这不是 Agent 失败，不是用户取消，也不是任务成功。

## 1. 这是产品策略，不是官方协议

Codex `exec --json` 和 session JSONL 都没有规定“多久没事件就算失联”。

阈值、进入条件、恢复规则全部由 PingPet 决定。不得把 `connection=stale` 写回 Codex，也不得把它当成 `turn.failed`、`turn.cancelled` 或 `process_exit`。

## 2. 当前默认阈值

`CODEX_OBSERVATION_STALE_AFTER_MS = 120000`（120 秒）。

这是待产品调优的临时默认值。判断失联只用 PingPet 读取/处理事件时的 `observedAt`，不用 Codex `eventTime`。

测试必须注入更短的 `observationStaleAfterMs`，并用可注入 clock，禁止真实长 sleep。

## 3. 为什么阈值还要按真实使用调优

过短：模型正常思考、工具空档、用户还没继续输入时，会被误标成失联。  
过长：观察已经停很久，影子状态仍假装一切正常。

120 秒只是和现有事件新鲜度窗口对齐的起点，不是测量过的最佳值。等有更多真实 Codex 空档样本后再改。

## 4. stale 和 process_exit 的区别

| | observation_stale | process_exit |
|---|---|---|
| 证据 | PingPet 一段时间没看到新事件 | 已关联的 Codex 进程异常退出（exitCode ≠ 0 或 signal） |
| 改什么 | 只改 `connection=stale` | `lifecycle=incomplete`，`cause=process_exit`，`process=exited` |
| 当前能否产出 | 能（影子层产品策略） | Detector 能；Monitor 还不能可靠关联进程 |

没有进程证据时，文件停止写入、mtime 过旧、stderr 出现 error，都不能当成 `process_exit`。  
未来一旦有可靠 process_exit，它的优先级高于 stale：已 incomplete 的 session 不再进入 stale。

## 5. stale 和 user_cancelled 的区别

| | observation_stale | user_cancelled |
|---|---|---|
| 证据 | 观察超时 | 官方 `turn.cancelled` 或本地 `turn_aborted` 带明确用户取消词 |
| candidate | `unknown` | `cancelled` |

单独出现 `event_msg.turn_aborted` 且没有明确取消词，不得写成 `user_cancelled`，也不得立刻写成 stale。只有超过阈值的失联才标 stale。

## 6. stale 和 failed 的区别

| | observation_stale | failed |
|---|---|---|
| 含义 | PingPet 看丢了 | 协议确认这一轮失败 |
| lifecycle | 保留最近已知值，通常仍是 `running` | `failed` |
| cause | 保留已确认事实（例如 `tool_failed`），不改成 `turn_failed` | `turn_failed` |
| candidate | `unknown` | `failed` |

此前若已有 `tool_failed` / `partial_failure` / `outputIntegrity=partial`，进入 stale 后必须保留。stale 不覆盖这些事实，也不把它们升级成 turn 失败。

## 7. 如何恢复

重新收到真实新事件后：

1. `connection` 回到 `connected`
2. candidate 按最新证据重算；turn 仍在进行则回到 `working`
3. 已有 item 失败事实继续保留
4. 若随后收到 `turn.completed`，进入 `completed_signal`
5. 只写一次 `observation_recovered` 诊断
6. 历史 stale 不是新的 Agent 失败
7. `shouldNotify` 仍为 `false`

同一 session 连续多个无事件 tick 只写一次 stale。恢复后再失联，可以再写一次新的 stale。多个 session 互相隔离。

## 8. 为什么不直接驱动用户通知

- 失联只说明 PingPet 不再确定，不说明用户要立刻处理。
- 正式 Monitor / 桌宠 / 气泡 / 声音仍走旧路径，本轮不得打开 `shouldNotify`。
- 启动时 priming 历史文件、旧文件长时间不更新、文件暂时不在扫描列表、文件删除或轮换，都不得标 stale，以免刚打开应用就把旧 session 标成未知并打扰用户。

进入 stale 的必要条件：

1. 该 session 文件已 priming 完成
2. priming 之后真实观察到过新事件
3. 当前 turn 曾进入 `in_progress` / `running`
4. 尚未收到 `turn.completed` / `turn.failed` / 明确 `turn.cancelled`
5. 没有可靠 `process_exit` 证据
6. 距最后一次真实新事件的 `observedAt` 超过阈值
