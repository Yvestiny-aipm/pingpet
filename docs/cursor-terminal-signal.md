# Cursor 终止信号专项

调查日期：2026-10-20。  
目标：不做通用状态层迁移，只把 Cursor 的「这一轮结束 / 被中断 / 出错」提醒做到接近 Codex 的可靠度。

---

## 1. 真实样本

来源：本机 `~/.cursor/projects/**/agent-transcripts/**/*.jsonl`，排除 `subagents/`。

| 项 | 值 |
| --- | --- |
| 父会话文件 | 52 |
| 以 `turn_ended` 收尾 | 45 |
| 没有 `turn_ended` 的老会话 | 7（最后一行均为 assistant 文本，mtime 为数月前） |
| `turn_ended` 总行数 | 646 success / 23 error |
| `turn_ended` 字段 | `type` / `status` / `error`（error 为字符串） |
| 观察到 `status=aborted` | 0 |

23 条 error 的原始文案：

| error | 次数 | 归因 |
| --- | ---: | --- |
| `User aborted request` | 9 | 用户主动停止 |
| `Canceled` | 1 | 用户取消 |
| `[unavailable] PING timed out` | 6 | 超时 |
| `Other Models usage limit reached...` | 5 | 额度 / 限流 |
| `Connection failed repeatedly` | 2 | 网络失败 |

结论：

- Cursor 的「用户中断」不是 `status=aborted`，而是 `turn_ended/error` + 明确文案。
- `turn_ended` 是当前 Cursor 版本的硬终止信号；1 秒轮询即可读到，延迟与 Codex 同级。
- 没有 `turn_ended` 时不应该猜「完成」；只对老格式末行纯文本 assistant 保留低置信兜底。

---

## 2. 判定规则

```text
最后一行是 turn_ended
  ├─ success
  │    ├─ 最后 assistant 文本明确在提问 / 要授权 → needs_attention
  │    └─ 否则 → done / completed
  ├─ aborted
  │    └─ failed / interrupted
  ├─ error
  │    ├─ User aborted request / Canceled → failed / interrupted
  │    └─ 其它 → failed / error（detail 保留原始 error）
  └─ 其它 status → failed / error

最后一行不是 turn_ended
  ├─ assistant 带 tool_use / user → working
  ├─ assistant 纯文本（老格式）→ done / completed（低置信）
  └─ 其它 → working
```

用户中止的匹配必须收紧，不能使用宽泛的 `includes('abort')`，否则 `Connection aborted` 会被误判。当前只接受：

- `Canceled`
- `Cancelled`
- `User aborted request`
- `User aborted the request`
- `Request aborted by user`
- `Request was aborted by user`

允许大小写和末尾句号差异。

---

## 3. 用户可见行为

| 状态 | 气泡 |
| --- | --- |
| `turn_ended/success` | `Cursor 这一轮结束了，回去看看` |
| `turn_ended/success` + 提问/授权 | `Cursor 需要你处理一下 🙋` + detail |
| 用户中止 | `Cursor 输出被中断了 ⛔` + `User aborted request` |
| 超时 / 网络 / 额度 | `Cursor 出错停下了 ⚠️` + 原始 error |
| 正常工作中 | 不弹气泡，只切 `thinking` |

说明：Cursor 的 `success` 只代表「这一轮硬结束」，不代表任务成功。因此文案不再写「任务完成」；现有的完成提示音与 happy 姿态保留作为提醒。

---

## 4. 实现落点

- `src/main/agent/cursor.ts`
  - `isCursorUserAbort()`
  - `turn_ended/error` 的用户中止分支
- `src/main/config.ts`
  - `buildAgentBubbleHead()` 的 Cursor 中性结束文案
- `src/main/agent/cursorProcess.ts`
  - macOS `pgrep -x Cursor` 主进程探针（2 秒刷新）
- `src/main/agent/monitor.ts`
  - `working` 中主进程退出 → 2 秒宽限后补 `failed/interrupted`
  - 收到 `turn_ended`、退出后重启、环境过滤不通过都不补
- 测试
  - `src/main/agent/cursor.test.ts`
  - `src/main/agent/monitor.test.ts`
  - `src/main/agent/codexLegacyPresentation.test.ts`

---

## 5. 进程退出兜底

Cursor 被强制退出 / 崩溃时可能来不及写 `turn_ended`。当前增加一条保守兜底：

- 只对 `env=desktop` 的 Cursor 会话生效；
- 该会话最近一次状态必须仍是 `working`；
- Cursor 主进程从「运行中」变为「未运行」；
- 消失后等待 2 秒，给 `turn_ended` 最后写入留时间；
- 期间收到终态、进程重启、会话超过活跃窗口、环境过滤不通过，都不补提醒；
- 补出的气泡是 `Cursor 输出被中断了 ⛔` + `Cursor 进程已退出，未检测到 turn_ended`。

## 6. 仍未覆盖

- Cursor CLI 会话没有桌面主进程，套用进程兜底会误报；当前只对 `desktop` 生效。
- Cursor 云端任务没有本地 transcript；当前只覆盖本地桌面 / CLI。
- 没有稳定的 `turn_ended` 行内时间戳；事件时间仍使用文件 mtime。
- 末行策略保证不重复提醒，但无法区分「用户中止」与「Cursor 自己取消」的底层动作；只能按 error 文案区分。
- 主进程探针只在 macOS 启用；Windows / Linux 返回 `undefined`，不启用兜底。
