# Claude Code 终止信号专项

调查日期：2026-10-20。  
目标：不做通用状态层迁移，只把 Claude Code 的「这一轮结束 / 需要你 / 出错 / 截断」提醒建立在结构化信号上。

---

## 1. 真实样本

来源：本机 `~/.claude/projects/**/*.jsonl`。

| 项 | 值 |
| --- | --- |
| 会话文件 | 4（样本较少，结论只代表本机观察） |
| assistant 行 | 97 |
| `stop_reason=tool_use` | 80 |
| `stop_reason=end_turn` | 14 |
| `stop_reason=stop_sequence` | 3 |
| `isApiErrorMessage=true` | 3 |
| `system/api_error` | 1（retryAttempt=1 / maxRetries=10 / retryInMs=584） |
| 行内时间 | 有 `timestamp` |
| 稳定标识 | 有 `uuid` |
| 会话标识 | 有 `sessionId` |
| 子 Agent 标识 | 有 `isSidechain` |

关键结论：

- `end_turn` 是明确的「这一轮结束」信号，但不是任务成功；
- `tool_use` 是运行中，不是终态；
- `max_tokens` 是输出截断，不是正常结束；
- `isApiErrorMessage` / `system.api_error` 是结构化错误；
- `system.api_error` 在自动重试期间不能提前报错；
- `isSidechain=true` 是子 Agent，不能当成用户主任务结束。

---

## 2. 判定规则

```text
isSidechain === true
  → 忽略，不驱动主任务提醒

assistant + isApiErrorMessage / error
  → failed / error，detail 保留原始 error

assistant + stop_reason=tool_use
  → working

assistant + stop_reason=end_turn / stop_sequence
  ├─ 最后文本明确在提问 / 要授权 → needs_attention
  └─ 否则 → done / completed

assistant + stop_reason=max_tokens
  → failed / error，detail=输出被截断（max_tokens）

system + api_error / level=error
  ├─ retryAttempt < maxRetries 或 retryInMs > 0 → working（自动重试中）
  └─ 重试耗尽 → failed / error
```

文本分类只用于判断「是否在等用户」，不再把「构建失败」这类关键词升级成 failed。真正失败以 `isApiErrorMessage` / `system.api_error` 为准。

---

## 3. 用户可见行为

| 状态 | 气泡 |
| --- | --- |
| `end_turn` / `stop_sequence` | `Claude 这一轮结束了，回去看看` |
| `end_turn` + 提问/授权 | `Claude 需要你处理一下 🙋` + detail |
| `max_tokens` | `Claude 出错停下了 ⚠️` + 输出被截断 |
| API 错误 | `Claude 出错停下了 ⚠️` + 原始 error |
| `tool_use` / user / 自动重试 | 不弹气泡，只切 `thinking` |

说明：`end_turn` 不是任务成功，文案不再写「任务完成」；完成提示音与 happy 姿态保留作为提醒。

---

## 4. 实现落点

- `src/main/agent/claude.ts`
  - `isSidechain` 过滤
  - `stop_reason` / `max_tokens` / `stop_sequence`
  - `isApiErrorMessage` / `system.api_error` / 重试判定
  - `uuid` 作为稳定事件 id
- `src/main/config.ts`
  - Claude 中性结束文案
- 测试
  - `src/main/agent/claude.test.ts`
  - `src/main/agent/codexLegacyPresentation.test.ts`

---

## 5. 仍未覆盖

- 本机只有 4 个 Claude 会话样本，`max_tokens` / `system.api_error` 仍偏少；
- 自动重试耗尽的最终错误是否总有独立 system 行，未完全验证；
- Claude Code 是 CLI / IDE，没有单一桌面主进程，不套用 Cursor 的进程退出兜底；
- 文本分类只用于 needs_attention，可能漏掉「文本里说失败但没有结构化错误」的情况；
- 任务级成功语义仍未验证，`taskSemantics` 保持 not_verified。
