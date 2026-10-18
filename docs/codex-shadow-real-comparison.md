# Codex 影子路径真实 session 对照（阶段 4B）

## 1. 执行结论

**PARTIAL**

已对真实本地 session JSONL 按事件覆盖抽样回放，并实现在线双轨诊断。官方 `codex exec --json` 点号事件流仍未验证（如有候选文件，仅为疑似，仍需人工或真实回放确认）。不具备进入 Monitor 行为替换阶段的条件。

官方 exec JSONL 尚未验证，因此不能进入 Monitor 行为替换阶段。

当前在线双轨可做到 session 级对照，尚不能做到完整 turn 级一一对应。

## 2. 官方 exec JSONL 可用性

- 结论： **BLOCKED**
- Codex CLI 可执行：否
- 疑似官方 JSONL 文件：0（当前扫描未找到疑似官方 JSONL；不能据此判断协议是否支持；发现候选 ≠ 协议已验证）
- 仓库 fixture（不计为真实）：14
- 扫描边界：
  - 检查目录：`$HOME/.codex/sessions`、`$HOME/.codex/archived_sessions`、`$HOME/.codex/tmp`、`$HOME/.codex/cache`、`$HOME/.codex/logs`、`$HOME/Library/Application Support/desktop-pet-mvp/diagnostics`、`repo:src/main/agent/fixtures/codex`
  - 每个目录最多检查 40 个 `.jsonl/.json/.log` 文件
  - 每个文件最多读取 16384 字节或 32 行
  - 因文件数量上限未检查全部：否；因大小/行数上限只读头部：是
  - `$HOME/.codex/sessions`：见到 37 个可疑文件，peek 37 个；文件上限截断=false；只读头部=true
  - `$HOME/.codex/archived_sessions`：见到 0 个可疑文件，peek 0 个；文件上限截断=false；只读头部=false
  - `$HOME/.codex/tmp`：见到 0 个可疑文件，peek 0 个；文件上限截断=false；只读头部=false
  - `$HOME/.codex/cache`：见到 13 个可疑文件，peek 13 个；文件上限截断=false；只读头部=true
  - `$HOME/Library/Application Support/desktop-pet-mvp/diagnostics`：见到 3 个可疑文件，peek 3 个；文件上限截断=false；只读头部=true
  - `repo:src/main/agent/fixtures/codex`：见到 16 个可疑文件，peek 16 个；文件上限截断=false；只读头部=false
- 已检查位置：
  - `PATH / 常见安装位置的 `codex` 可执行文件`：不存在 — 未发现可执行 Codex CLI，不能据此判断协议缺事件
  - `$HOME/.codex/sessions`：存在 — 目录存在；每目录最多 40 个文件，每文件最多 16384 字节 / 32 行
  - `$HOME/.codex/archived_sessions`：存在 — 目录存在；每目录最多 40 个文件，每文件最多 16384 字节 / 32 行
  - `$HOME/.codex/tmp`：存在 — 目录存在；每目录最多 40 个文件，每文件最多 16384 字节 / 32 行
  - `$HOME/.codex/cache`：存在 — 目录存在；每目录最多 40 个文件，每文件最多 16384 字节 / 32 行
  - `$HOME/.codex/logs`：不存在 — 日志目录不存在
  - `$HOME/Library/Application Support/desktop-pet-mvp`：存在 — 目录存在；每目录最多 40 个文件，每文件最多 16384 字节 / 32 行
  - `$HOME/Library/Application Support/PingPet`：不存在 — PingPet userData 不存在
  - `repo:src/main/agent/fixtures/codex`：存在 — 仓库手写 fixture，不得当作真实 exec --json
- 不能安全取得真实官方流的原因：
  - 本机 PATH/常见位置没有可执行 Codex CLI，且禁止为取样自动安装或调用。
  - 当前扫描未找到疑似真实 `codex exec --json` 点号事件流。当前扫描未找到 ≠ Codex 不支持这些事件。
  - 仓库内有 14 个手写 fixture 含点号 type，只能测解析器，不能证明真实协议。
  - 真实日志只允许本地读取，禁止上传或复制进仓库。
- 仍未用真实官方流验证的事件（本批样本未出现或仅发现候选，不能据此判断协议是否支持）：
  - `thread.started`
  - `turn.started`
  - `turn.completed`
  - `turn.failed`
  - `turn.cancelled`
  - `item.started`
  - `item.completed`
  - `item.failed`
  - `error`
  - `rate limit / quota`
  - `authentication / permission`
  - `approval / input waiting`
  - `stream disconnect / timeout / retry`
- 官方 exec JSONL 尚未验证，因此不能进入 Monitor 行为替换阶段。

本地 `~/.codex/sessions` 里的 `session_meta` / `event_msg.*` 不是 `codex exec --json` 官方点号事件。本机没有 CLI ≠ 协议没有这些事件。

## 3. 调查日期、项目版本、Codex 版本

- 调查日期：2026-10-18
- 项目版本：0.6.2
- Codex 版本：本机 `codex` CLI 不可用；~/.codex/config.toml 仅能看到本地 model 名，不能当作 Codex 应用版本

## 4. 目录概况（全部 session 文件，不等于已回放）

- 扫描目录：`$HOME/.codex/sessions`（通过 `codexSessionsRoot()`，报告不写绝对路径）
- 目录存在：是
- session 文件数量：37
- 可 stat/打开：37
- 文件大小范围：462 – 53008614 字节
- 最早 mtime：2026-07-07T09:22:58.214Z
- 最晚 mtime：2026-10-17T06:37:33.241Z
- 本报告没有回放全部 37 个 session。

### 文件检查分层（禁止把未检查写成不支持）

- 已检查的文件（目录 stat）：37
- 详细回放的文件：6
- 探测过（读头部/抽样，超大文件不整文件载入）：36
- 只做目录统计 / 未详细回放：31
- 因体积跳过探测、只记 size/mtime：1
- 官方 JSONL 发现器因扫描上限没有检查全部文件：否
- 样本未出现 / 无法确认 / 协议尚未验证：见第 12–13 节。当前扫描未找到 ≠ Codex 不支持。

## 5. 详细回放样本选择

按事件覆盖挑选 6 个详细样本，不是按「前 N 个小文件」。目录共 37 个文件，未回放 31 个。
- 探测过的文件：36（超大文件只记 size/mtime，不整文件载入）
- 因体积跳过探测：1

| 别名 | 选择原因 | 大小 | 回放上限 |
|---|---|---:|---:|
| session-001 | 正常完成 session；最近活跃 | 128277 | 128277 |
| session-009 | 含 item/tool 失败 | 2951573 | 2048000 |
| session-002 | 多个连续 turn | 215083 | 215083 |
| session-037 | 历史较旧 | 462 | 462 |
| session-008 | 含未知/malformed 行 | 1342359 | 1342359 |
| session-004 | 较大文件增量扫描 | 27644721 | 512000 |

## 6. 未回放的文件

- 未做详细对照的文件数：31
- 未回放原因：未命中覆盖桶、或已有同类样本、或体积过大只做目录统计。
- 未回放 ≠ 无事件；不能把未抽样文件写成“已验证”。

## 7. 本批样本事件类型统计

统计仅来自上面的详细回放样本，不是目录全部 文件。官方点号事件只在 `codex exec --json` 顶层出现。

| 事件类型 | 次数 | 类别 |
|---|---:|---|
| `response_item` | 316 | 本地 session JSONL |
| `event_msg.other` | 125 | 本地 session JSONL |
| `token_usage_record` | 94 | 其他信封 |
| `event_msg.item_completed` | 92 | 本地 session JSONL |
| `event_msg.task_started` | 20 | 本地 session JSONL |
| `turn_context` | 19 | 其他信封 |
| `event_msg.task_complete` | 17 | 本地 session JSONL |
| `unsupported` | 12 | 未识别/损坏 |
| `world_state` | 9 | 其他信封 |
| `session_meta` | 8 | 本地 session JSONL |
| `event_msg.turn_aborted` | 1 | 本地 session JSONL |

本批样本中出现过的官方点号事件：无

## 8. 旧路径与新路径对照表

### session-001

- 选择原因：正常完成 session；最近活跃
- 大小：128277 字节；回放 128277 字节；截断=false
- 标识存在：session_id=true thread_id=true turn_id=true
- 新路径终态：lifecycle=`completed_signal` cause=`unknown` item=`unknown` taskSemantics=`not_verified`
- 标识：sessionKey 仅 session 级；threadId/turnId 仅在原始事件提供时记录，缺失为 unknown。
- 旧路径识别事件：6（生产可见 0；其余为生产不可见）

| 时间/事件 | 旧路径 | 新影子路径 | 是否一致 | 证据 | 是否影响用户行为 |
|---|---|---|---|---|---|
| task_started → running | working（生产不可见（freshness/outside_tail/file_not_in_recent_scan）） | running | 一致 | old working=3; new running rows=29 | 否（生产不可见） |
| 单个 item/tool 失败且 turn 继续 | 本文件未见 item failed | 本文件未见 | 样本未覆盖 | itemFailedRows=0 | 否（生产不可见） |
| item 失败后 turn 完成 / task_complete → completed_signal | done（生产不可见（freshness/outside_tail/file_not_in_recent_scan）） | completed_signal | 一致 | oldDone=true; newCompleted=true; newSucceeded=false | 否（生产不可见） |
| turn 明确失败 | 未见 failed | 未见 turn.failed | 样本未覆盖 | turnFailed=false | 否（生产不可见） |
| 用户取消或中断 | 未见 turn_aborted | 未见 | 样本未覆盖 | abortRows=0 | 否（生产不可见） |
| 只有 error、没有 turn 终态 | 旧路径不识别官方 error 事件 | 未见官方 error | 样本未覆盖 | errorRows=0 | 否（生产不可见） |
| 跨 turn item 失败隔离 | 无 item 状态，无法表达污染 | 后一轮未继承 partial_failure | 一致 | task/turn starts=3 | 否（生产不可见） |
| 旧路径文本完成 vs 新路径信号 | 未见文本 done | not_verified | 样本未覆盖 | assistantTextDone=false; taskSemantics=not_verified | 否（生产不可见） |
| 生产 Monitor 能否看到本文件 | 识别 6 条，全部为生产不可见（freshness/outside_tail/file_not_in_recent_scan），不能当成无事件 | 从文件头完整（或截断上限内）回放，仍能看到历史事件 | 新检测器更精确 | oldVisible=0/6 | 否（生产不可见） |
| 冲突时是否强行成功/失败 | 旧路径只有单一 kind | 无 conflict；lifecycle=completed_signal（不是 succeeded） | 一致 | conflicts=0; lifecycle=completed_signal | 否（影子不进桌宠） |

### session-009

- 选择原因：含 item/tool 失败
- 大小：2951573 字节；回放 2048000 字节；截断=true
- 标识存在：session_id=true thread_id=true turn_id=true
- 新路径终态：lifecycle=`running` cause=`unknown` item=`unknown` taskSemantics=`not_verified`
- 截断回放停在 running，不能写成 Agent 仍在运行。
- 标识：sessionKey 仅 session 级；threadId/turnId 仅在原始事件提供时记录，缺失为 unknown。
- 旧路径识别事件：45（生产可见 0；其余为生产不可见）

| 时间/事件 | 旧路径 | 新影子路径 | 是否一致 | 证据 | 是否影响用户行为 |
|---|---|---|---|---|---|
| task_started → running | working（生产不可见（freshness/outside_tail/file_not_in_recent_scan）） | running | 一致 | old working=41; new running rows=228 | 否（生产不可见） |
| 单个 item/tool 失败且 turn 继续 | 通常不单独成事件 | running + tool_failed | 新检测器更精确 | itemFailedRows=23 | 否（生产不可见） |
| item 失败后 turn 完成 / task_complete → completed_signal | done（生产不可见（freshness/outside_tail/file_not_in_recent_scan）） | completed_signal（不升格 failed） | 新检测器更精确 | oldDone=true; newCompleted=true; newSucceeded=false | 否（生产不可见） |
| turn 明确失败 | failed | 未见 turn.failed | 样本未覆盖 | turnFailed=false | 否（生产不可见） |
| 用户取消或中断 | failed/interrupted | unknown | 一致 | abortRows=1 | 否（生产不可见） |
| 只有 error、没有 turn 终态 | 旧路径不识别官方 error 事件 | 未见官方 error | 样本未覆盖 | errorRows=0 | 否（生产不可见） |
| 跨 turn item 失败隔离 | 无 item 状态，无法表达污染 | 后一轮未继承 partial_failure | 一致 | task/turn starts=5 | 否（生产不可见） |
| 旧路径文本完成 vs 新路径信号 | 未见文本 done | not_verified | 样本未覆盖 | assistantTextDone=false; taskSemantics=not_verified | 否（生产不可见） |
| 生产 Monitor 能否看到本文件 | 识别 45 条，全部为生产不可见（freshness/outside_tail/file_not_in_recent_scan），不能当成无事件 | 从文件头完整（或截断上限内）回放，仍能看到历史事件 | 新检测器更精确 | oldVisible=0/45 | 否（生产不可见） |
| 冲突时是否强行成功/失败 | 旧路径只有单一 kind | 无 conflict；lifecycle=running（不是 succeeded） | 一致 | conflicts=0; lifecycle=running | 否（影子不进桌宠） |

### session-002

- 选择原因：多个连续 turn
- 大小：215083 字节；回放 215083 字节；截断=false
- 标识存在：session_id=true thread_id=true turn_id=true
- 新路径终态：lifecycle=`completed_signal` cause=`unknown` item=`unknown` taskSemantics=`not_verified`
- 标识：sessionKey 仅 session 级；threadId/turnId 仅在原始事件提供时记录，缺失为 unknown。
- 旧路径识别事件：8（生产可见 0；其余为生产不可见）

| 时间/事件 | 旧路径 | 新影子路径 | 是否一致 | 证据 | 是否影响用户行为 |
|---|---|---|---|---|---|
| task_started → running | working（生产不可见（freshness/outside_tail/file_not_in_recent_scan）） | running | 一致 | old working=4; new running rows=31 | 否（生产不可见） |
| 单个 item/tool 失败且 turn 继续 | 本文件未见 item failed | 本文件未见 | 样本未覆盖 | itemFailedRows=0 | 否（生产不可见） |
| item 失败后 turn 完成 / task_complete → completed_signal | done（生产不可见（freshness/outside_tail/file_not_in_recent_scan）） | completed_signal | 一致 | oldDone=true; newCompleted=true; newSucceeded=false | 否（生产不可见） |
| turn 明确失败 | 未见 failed | 未见 turn.failed | 样本未覆盖 | turnFailed=false | 否（生产不可见） |
| 用户取消或中断 | 未见 turn_aborted | 未见 | 样本未覆盖 | abortRows=0 | 否（生产不可见） |
| 只有 error、没有 turn 终态 | 旧路径不识别官方 error 事件 | 未见官方 error | 样本未覆盖 | errorRows=0 | 否（生产不可见） |
| 跨 turn item 失败隔离 | 无 item 状态，无法表达污染 | 后一轮未继承 partial_failure | 一致 | task/turn starts=4 | 否（生产不可见） |
| 旧路径文本完成 vs 新路径信号 | 未见文本 done | not_verified | 样本未覆盖 | assistantTextDone=false; taskSemantics=not_verified | 否（生产不可见） |
| 生产 Monitor 能否看到本文件 | 识别 8 条，全部为生产不可见（freshness/outside_tail/file_not_in_recent_scan），不能当成无事件 | 从文件头完整（或截断上限内）回放，仍能看到历史事件 | 新检测器更精确 | oldVisible=0/8 | 否（生产不可见） |
| 冲突时是否强行成功/失败 | 旧路径只有单一 kind | 无 conflict；lifecycle=completed_signal（不是 succeeded） | 一致 | conflicts=0; lifecycle=completed_signal | 否（影子不进桌宠） |

### session-037

- 选择原因：历史较旧
- 大小：462 字节；回放 462 字节；截断=false
- 标识存在：session_id=true thread_id=false turn_id=false
- 新路径终态：lifecycle=`completed_signal` cause=`unknown` item=`none` taskSemantics=`not_verified`
- 标识：sessionKey 仅 session 级；threadId/turnId 仅在原始事件提供时记录，缺失为 unknown。
- 旧路径识别事件：2（生产可见 0；其余为生产不可见）

| 时间/事件 | 旧路径 | 新影子路径 | 是否一致 | 证据 | 是否影响用户行为 |
|---|---|---|---|---|---|
| task_started → running | working（生产不可见（freshness/file_not_in_recent_scan）） | running | 一致 | old working=1; new running rows=1 | 否（生产不可见） |
| 单个 item/tool 失败且 turn 继续 | 本文件未见 item failed | 本文件未见 | 样本未覆盖 | itemFailedRows=0 | 否（生产不可见） |
| item 失败后 turn 完成 / task_complete → completed_signal | done（生产不可见（freshness/file_not_in_recent_scan）） | completed_signal | 一致 | oldDone=true; newCompleted=true; newSucceeded=false | 否（生产不可见） |
| turn 明确失败 | 未见 failed | 未见 turn.failed | 样本未覆盖 | turnFailed=false | 否（生产不可见） |
| 用户取消或中断 | 未见 turn_aborted | 未见 | 样本未覆盖 | abortRows=0 | 否（生产不可见） |
| 只有 error、没有 turn 终态 | 旧路径不识别官方 error 事件 | 未见官方 error | 样本未覆盖 | errorRows=0 | 否（生产不可见） |
| 跨 turn item 失败隔离 | 少于两个 turn 开始 | 不足两个 turn | 样本未覆盖 | task/turn starts=1 | 否（生产不可见） |
| 旧路径文本完成 vs 新路径信号 | 未见文本 done | not_verified | 样本未覆盖 | assistantTextDone=false; taskSemantics=not_verified | 否（生产不可见） |
| 生产 Monitor 能否看到本文件 | 识别 2 条，全部为生产不可见（freshness/file_not_in_recent_scan），不能当成无事件 | 从文件头完整（或截断上限内）回放，仍能看到历史事件 | 新检测器更精确 | oldVisible=0/2 | 否（生产不可见） |
| 冲突时是否强行成功/失败 | 旧路径只有单一 kind | 无 conflict；lifecycle=completed_signal（不是 succeeded） | 一致 | conflicts=0; lifecycle=completed_signal | 否（影子不进桌宠） |

### session-008

- 选择原因：含未知/malformed 行
- 大小：1342359 字节；回放 1342359 字节；截断=false
- 标识存在：session_id=true thread_id=true turn_id=true
- 新路径终态：lifecycle=`completed_signal` cause=`unknown` item=`none` taskSemantics=`not_verified`
- 标识：sessionKey 仅 session 级；threadId/turnId 仅在原始事件提供时记录，缺失为 unknown。
- 旧路径识别事件：44（生产可见 0；其余为生产不可见）

| 时间/事件 | 旧路径 | 新影子路径 | 是否一致 | 证据 | 是否影响用户行为 |
|---|---|---|---|---|---|
| task_started → running | working（生产不可见（freshness/outside_tail/file_not_in_recent_scan）） | running | 一致 | old working=41; new running rows=293 | 否（生产不可见） |
| 单个 item/tool 失败且 turn 继续 | 本文件未见 item failed | 本文件未见 | 样本未覆盖 | itemFailedRows=0 | 否（生产不可见） |
| item 失败后 turn 完成 / task_complete → completed_signal | done（生产不可见（freshness/outside_tail/file_not_in_recent_scan）） | completed_signal | 一致 | oldDone=true; newCompleted=true; newSucceeded=false | 否（生产不可见） |
| turn 明确失败 | 未见 failed | 未见 turn.failed | 样本未覆盖 | turnFailed=false | 否（生产不可见） |
| 用户取消或中断 | 未见 turn_aborted | 未见 | 样本未覆盖 | abortRows=0 | 否（生产不可见） |
| 只有 error、没有 turn 终态 | 旧路径不识别官方 error 事件 | 未见官方 error | 样本未覆盖 | errorRows=0 | 否（生产不可见） |
| 跨 turn item 失败隔离 | 无 item 状态，无法表达污染 | 后一轮未继承 partial_failure | 一致 | task/turn starts=3 | 否（生产不可见） |
| 旧路径文本完成 vs 新路径信号 | 未见文本 done | not_verified | 样本未覆盖 | assistantTextDone=false; taskSemantics=not_verified | 否（生产不可见） |
| 生产 Monitor 能否看到本文件 | 识别 44 条，全部为生产不可见（freshness/outside_tail/file_not_in_recent_scan），不能当成无事件 | 从文件头完整（或截断上限内）回放，仍能看到历史事件 | 新检测器更精确 | oldVisible=0/44 | 否（生产不可见） |
| 冲突时是否强行成功/失败 | 旧路径只有单一 kind | 无 conflict；lifecycle=completed_signal（不是 succeeded） | 一致 | conflicts=0; lifecycle=completed_signal | 否（影子不进桌宠） |

### session-004

- 选择原因：较大文件增量扫描
- 大小：27644721 字节；回放 512000 字节；截断=true
- 标识存在：session_id=true thread_id=true turn_id=true
- 新路径终态：lifecycle=`running` cause=`unknown` item=`unknown` taskSemantics=`not_verified`
- 截断回放停在 running，不能写成 Agent 仍在运行。
- 标识：sessionKey 仅 session 级；threadId/turnId 仅在原始事件提供时记录，缺失为 unknown。
- 旧路径识别事件：10（生产可见 0；其余为生产不可见）

| 时间/事件 | 旧路径 | 新影子路径 | 是否一致 | 证据 | 是否影响用户行为 |
|---|---|---|---|---|---|
| task_started → running | working（生产不可见（freshness/outside_tail/file_not_in_recent_scan）） | running | 一致 | old working=7; new running rows=92 | 否（生产不可见） |
| 单个 item/tool 失败且 turn 继续 | 本文件未见 item failed | 本文件未见 | 样本未覆盖 | itemFailedRows=0 | 否（生产不可见） |
| item 失败后 turn 完成 / task_complete → completed_signal | done（生产不可见（freshness/outside_tail/file_not_in_recent_scan）） | completed_signal | 一致 | oldDone=true; newCompleted=true; newSucceeded=false | 否（生产不可见） |
| turn 明确失败 | 未见 failed | 未见 turn.failed | 样本未覆盖 | turnFailed=false | 否（生产不可见） |
| 用户取消或中断 | 未见 turn_aborted | 未见 | 样本未覆盖 | abortRows=0 | 否（生产不可见） |
| 只有 error、没有 turn 终态 | 旧路径不识别官方 error 事件 | 未见官方 error | 样本未覆盖 | errorRows=0 | 否（生产不可见） |
| 跨 turn item 失败隔离 | 无 item 状态，无法表达污染 | 后一轮未继承 partial_failure | 一致 | task/turn starts=4 | 否（生产不可见） |
| 旧路径文本完成 vs 新路径信号 | 未见文本 done | not_verified | 样本未覆盖 | assistantTextDone=false; taskSemantics=not_verified | 否（生产不可见） |
| 生产 Monitor 能否看到本文件 | 识别 10 条，全部为生产不可见（freshness/outside_tail/file_not_in_recent_scan），不能当成无事件 | 从文件头完整（或截断上限内）回放，仍能看到历史事件 | 新检测器更精确 | oldVisible=0/10 | 否（生产不可见） |
| 冲突时是否强行成功/失败 | 旧路径只有单一 kind | 无 conflict；lifecycle=running（不是 succeeded） | 一致 | conflicts=0; lifecycle=running | 否（影子不进桌宠） |

## 9. 已确认的一致行为

- 本地 `event_msg.task_started` 与旧路径 `working` 都表示 turn 开始；新路径记 `running`，不映射成用户态。
- 本地 `event_msg.task_complete` 与旧路径 `done` 都表示收到结束信号；新路径只给 `completed_signal`，`taskSemantics` 保持 `not_verified`。
- 两条路径都不会把未知 JSON 当成成功。
- 在线双轨诊断与回放都不进入桌宠 / 气泡 / 声音。

## 10. 新检测器发现的新增信息

- item/tool 失败可保持 `running + tool_failed`，不把整轮标成 failed。
- 多维状态（cause / item / outputIntegrity / confidence）可与旧的单一 kind 对照。
- 从文件头回放历史 session，不受 120s freshness 和 96KB tail 限制。
- 旧路径被 freshness/tail 忽略时标记为「生产不可见」，不是「无事件」。

## 11. 误判或漏判候选

- 旧路径：`turn_aborted` 一律 `failed`；新路径在缺少明确用户取消词时为 `unknown`。
- 本地 session 出现 `turn_aborted` ≠ 已确认用户取消协议。
- 旧路径：assistant 文本匹配 `classifyStopText` 时可能给出 `done`/`needs_attention`/`failed`，这不是任务语义完成。
- 旧路径：历史文件上的事件会被 freshness/tail/最近文件上限丢掉；报告必须写生产不可见。
- 新检测器误判候选：仅在对照表里出现“后一轮仍是 partial_failure”时成立；本批以表内 verdict 为准。

## 12. 尚未被真实样本覆盖的状态 / 官方事件

- 正常 turn 完成：本批样本出现
- 单个 item/tool 失败后 turn 继续：本批样本出现
- item 失败后 turn 正常完成：本批样本出现
- 多个 turn 连续：本批样本出现
- 输出被截断或最后一行不完整：本批样本出现
- 未知事件 / malformed：本批样本出现
- session/thread/turn id 缺失：本批样本出现
- 进程退出但没有完整终态：本批只回放 session JSONL，没有进程 exit 证据。本批样本未出现，不能据此判断协议是否支持。

官方 `codex exec --json` 事件（无真实官方流时一律如下）：

- `thread.started`：本批样本未出现，不能据此判断协议是否支持。
- `turn.started`：本批样本未出现，不能据此判断协议是否支持。
- `turn.completed`：本批样本未出现，不能据此判断协议是否支持。
- `turn.failed`：本批样本未出现，不能据此判断协议是否支持。
- `turn.cancelled`：本批样本未出现，不能据此判断协议是否支持。
- `item.started`：本批样本未出现，不能据此判断协议是否支持。
- `item.completed`：本批样本未出现，不能据此判断协议是否支持。
- `item.failed`：本批样本未出现，不能据此判断协议是否支持。
- `error`：本批样本未出现，不能据此判断协议是否支持。
- `rate limit / quota`：本批样本未出现，不能据此判断协议是否支持。
- `authentication / permission`：本批样本未出现，不能据此判断协议是否支持。
- `approval / input waiting`：本批样本未出现，不能据此判断协议是否支持。
- `stream disconnect / timeout / retry`：本批样本未出现，不能据此判断协议是否支持。

## 13. 未知、无法确认和证据不足

- 对照 verdict 计数：一致=23；样本未覆盖=29；新检测器更精确=8
- 没有进程级 exit/signal，不能对“进程退出”下结论。
- 没有把 assistant 正文当任务成功或失败。
- 官方结构化事件在本批回放中未作为真实 exec --json 验证。
- 禁止把「当前扫描未找到」写成「Codex 不支持」。协议尚未验证 ≠ 协议不支持。
- 禁止把「截断回放停在 running」写成「Agent 仍在运行」。

## 14. 时间字段语义与关联级别

- `eventTime`：原始 Codex 事件自身携带的时间（若存在）。缺失则为 null/unknown，不得猜测。
- `observedAt`：PingPet 读取和处理该事件的时间。
- `migration.observedAt`：检测器应用该事件的时间（PingPet）。
- 影子诊断不得把 `observedAt` 伪装成 `eventTime`。
- `sessionKey`：可用于 session 级关联。
- `threadId` / `turnId`：只有原始事件确实提供时才记录；缺失保留 unknown。
- 不得从文件名、sessionKey 或时间戳猜造 threadId/turnId。
- 当前在线双轨可做到 session 级对照，尚不能做到完整 turn 级一一对应。

## 15. 诊断文件长期运行风险（最小说明）

- 单文件上限：8MB（`CODEX_DIAGNOSTIC_MAX_FILE_BYTES`）。
- 超过上限后：停止追加，不轮转、不删除旧文件。
- 同步 `appendFileSync`：高频 item 事件可能短暂阻塞主进程；当前未见明显拖慢 Monitor，本轮不改异步。
- 进程重启后：内存去重丢失，同一 observationId 可能再写一次。
- 诊断失败：写入异常被吞掉，不影响 Monitor / onEvent / 桌宠。
- 当前暂不轮转：这是对照诊断，不是日志平台；扩成轮转/采样会改变诊断边界，留给后续。
- 方案 A：只把 `source=codex` 的旧事件写入 `codex-legacy.jsonl`；Claude/Cursor/Grok 不混入。
- 两条路径写不同文件（`codex-legacy.jsonl` / `codex-shadow.jsonl`），互不影响。

## 16. 是否具备进入 Monitor 行为替换阶段的条件

**否。** 官方 exec JSONL 尚未验证，因此不能进入 Monitor 行为替换阶段。

## 17. 脱敏说明

- 报告只用 `session-001` 这类别名。
- session/thread/turn/file 如出现，已哈希为 `sess-` / `th-` / `turn-` / `file-` 前缀。
- 未输出 prompt、assistant 正文、命令、文件内容、token 或绝对路径。
- 真实 JSONL 没有复制进仓库，也没有上传。

## 附录：旧路径离线限制

- production scanCodex only opens the 12 newest files
- production skips files with mtime older than 240000ms
- production only reads the last 96000 bytes of each file
- production drops events older than 120000ms relative to now
- offline replay therefore uses a read-only adapter and records these ignore reasons instead of faking the clock

- 生产最近文件扫描上限：12；mtime 窗口：240000ms。