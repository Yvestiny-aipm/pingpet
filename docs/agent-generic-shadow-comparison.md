# 通用 Agent 状态层新旧路径只读对照（阶段 4）

调查日期：2026-09-14。  
文档性质：只读对照。不接入 Monitor，不注册生产 Adapter，不改变用户可见行为。

对照工具：`src/main/agent/generic/agentShadowComparison.ts`

---

## 1. 对照目的

分别比较 Codex 与 Cursor 的两条路径，回答：

1. 是否识别到同一段活动；
2. 旧 `working/done/needs_attention/failed` 与通用 `lifecycle` 的对应；
3. 哪些差异是有意兼容；
4. 哪些差异可能是误判；
5. 哪些结论只是样本未覆盖；
6. 通用层比旧路径更丰富的信息；
7. 旧路径有、通用层暂时没有的信息；
8. 是否存在 session 串线、重复、prime 重放或旧状态覆盖新状态。

禁止用「新路径错误」「旧路径错误」「任务成功」「任务失败」替代证据分类。

---

## 2. 调查日期

- 调查日期：2026-09-14
- 对照工具完成日：2026-09-14
- 本轮读取的 Codex 诊断文件 mtime：2026-09-12（**历史记录，不当成本轮新数据**）

---

## 3. 数据来源

| 来源 | 数量 / 基线 | 本轮用法 | 证据等级 |
|---|---|---|---|
| Codex 诊断 `codex-legacy.jsonl` | 23526 字节 / 38 行 | 只读 stat；内容已在既有 live 对照中分析 | `REAL_CODEX`（历史） |
| Codex 诊断 `codex-shadow.jsonl` | 17854 字节 / 16 行 | 只读 stat；未改、未删、未复制进仓库 | `REAL_CODEX`（历史） |
| Codex 诊断 `codex-candidate.jsonl` | 23220 字节 / 16 行 | 只读 stat | `REAL_CODEX`（历史） |
| Codex 仓库 fixture | 16 个 jsonl | 只测对照工具与投影形状 | `FIXTURE_ONLY` |
| Cursor 磁盘 transcript | 目录存在，约 47 个 jsonl | **本轮未解析正文**（Adapter 不读文件，旧 parse 未导出，避免把用户文本写入报告） | `SAMPLE_NOT_COVERED` |
| Cursor Adapter fixture 形状 | 单测构造的 `CursorAdapterInput` | 工具测试 | `FIXTURE_ONLY` |

未把 fixture 结果写成真实 Cursor 协议结论。  
未启动或修改真实 Cursor。  
未把 2026-09-12 诊断当成本轮新采集。

---

## 4. Codex 对照结果

当前最多：**file / session 级**。payload 明确提供 `turnRef` 时才能做 turn 级。历史诊断里旧 `sessionKey` 与影子 `sessionId` 哈希口径不同，必须靠 `fileAlias`，不能把两套 ID 当成同一个。

| 场景 | 旧路径 | 通用层 | candidate | 分类 | 证据 |
|---|---|---|---|---|---|
| 正常运行 | `working` | `lifecycle=running` | `working` | `CONSISTENT` | 历史诊断 + fixture |
| 正常协议结束 | `done` | `completed_signal`；`taskSemantics=not_verified` | `completed_signal` | `CONSISTENT` | 历史诊断 + fixture。**done/completed_signal ≠ 任务成功** |
| 工具失败后完成 | 可能 `failed`→`done`，终态常为 `done` | `completed_signal` + `tool_failed` + `partial` | `completed_with_partial_failure` | `GENERIC_MORE_INFORMATIVE` | 历史诊断 2 组 + fixture |
| 普通 SIGINT / `turn_aborted` | 可能 `failed` | `unknown` 或 `running`；cause 不是 `user_cancelled` | `unknown` | `GENERIC_MORE_CONSERVATIVE` | fixture + 既有检测器语义。**不是已确认用户取消** |
| stale / unknown | 旧 kind 不表达 stale | stale 只改 `connection` | 仍按 lifecycle | `CONSISTENT` | fixture + 冻结规则。**不得写成 Agent failed** |
| process | 无 | 通用 `process=unsupported`；extension `not_observed` | 无 process_exit | `CONSISTENT` | 历史影子 16 条均为 `not_observed`。**没有安全外部进程关联** |

历史 live 对照（不当新数据，只引用）：6 个 fileAlias 组；`一致` 3；`候选状态更谨慎` 2（对应本表 `GENERIC_MORE_INFORMATIVE`）；`无法确认` 1（session 级不足以做 turn 判定）。

---

## 5. Cursor 对照结果

当前最多：**file / session 级**。Cursor 行内通常没有稳定 `turnRef`，**不得伪造成 turn 级对照**。

| 场景 | 旧路径 | 通用层 | 分类 | 证据 |
|---|---|---|---|---|
| working / running | `working` | `running` | `CONSISTENT` | `FIXTURE_ONLY` |
| 结构化 `turn_ended/success` | `done`（用户仍可能看到完成展示） | `completed_signal`；`taskSemantics=not_verified` | `LEGACY_COMPATIBILITY` | `FIXTURE_ONLY`。真实协议：`SAMPLE_NOT_COVERED` |
| 文本 success / done | `done` | `completed_signal`；`confidence=low` | `GENERIC_MORE_CONSERVATIVE` | `FIXTURE_ONLY` |
| item/tool error | 常仍是 `working` | `running` + `tool_failed`；turn 不升 failed | `CONSISTENT`（维度更细） | `FIXTURE_ONLY` / `CODE_INFERENCE` |
| 明确 turn-level error | `failed` | `failed` + `turn_failed` | fixture 可一致 | **FIXTURE_ONLY**，不得写成真实协议 |
| ordinary aborted | `failed/interrupted` | lifecycle/cause `unknown` | `GENERIC_MORE_CONSERVATIVE` | `FIXTURE_ONLY`。文案「用户取消」不能当 `user_cancelled` |
| 缺少 turnRef | session 仍可对 | turn 级必须 `UNMATCHED_CORRELATION` | `UNMATCHED_CORRELATION` | 代码契约 |
| 用户可见行为 | 完成气泡 / 完成音保持现状 | 不驱动可见层 | `LEGACY_COMPATIBILITY` | 本轮未改 `cursor.ts` / Monitor |

磁盘上存在 Cursor transcript 文件，但本轮没有把它们解析成通用投影，因此**没有 `REAL_CURSOR` 协议结论**。

---

## 6. session / turn / item 关联能力

| 级别 | Codex | Cursor |
|---|---|---|
| file | 可以（`fileIdentity` / 历史 `fileAlias`） | 可以（稳定别名，不得写路径） |
| session | 可以（仅 payload `sessionRef`） | 可以（仅 payload；文件名 sessionKey 不能当 sessionRef） |
| thread | 有 payload `threadRef` 时可以 | 通常没有 |
| turn | 仅双方都有 payload `turnRef` | **默认不能**。缺 `turnRef` 必须 `UNMATCHED_CORRELATION` |
| item | 有 payload `itemRef` 时可以 | 现有文件几乎没有独立 item id |
| 禁止 | 用时间戳 / 文件名 / 相邻顺序猜 turn；把 Codex 哈希口径和旧 sessionKey 当同一 ID | 同上 |

本轮对照工具最多声称：Codex 可做 file/session，条件满足时 turn；Cursor 可做 file/session，turn 未匹配则不能比较该级别。

---

## 7. 一致项

- 旧 `working` ↔ 通用 `running`（Codex candidate 亦为 `working`）。
- Codex 旧 `done` ↔ 通用 `completed_signal`，且双方都不能推出任务成功。
- stale 只留在 `connection`。
- process 未观察 ≠ `process_exit`。
- `taskSemantics` 保持 `not_verified`。
- Codex / Cursor 即使 ID 字符串相同也不会串线。
- 多 session 按 payload sessionRef 隔离。

---

## 8. 旧路径兼容差异

- Cursor 旧 `done` 仍会走完成展示；通用层只写 `completed_signal`。这是 `LEGACY_COMPATIBILITY`，不是通用层错误。
- Cursor `turn_ended/success` 后文本可改旧路径为 `needs_attention`；通用层不因文本升格 waiting。
- 旧路径普通 abort 输出 `failed`，是为了保持既有失败展示，不代表已验证用户取消。
- Codex 旧路径可能把「工具失败后仍完成」压成单一 `done`。

---

## 9. 通用层更谨慎或更丰富的地方

更谨慎：

- 普通 abort → `unknown`，不写 `cancelled`。
- 文本 success → `completed_signal` + `low`，不写 succeeded。
- 缺少 turnRef 时拒绝 turn 级结论。

更丰富：

- `cause` / `item` / `outputIntegrity` / `taskSemantics` / `retryability`。
- Codex `completed_with_partial_failure` 把协议结束和工具失败同时留下。
- `conflicts` 可记录结构化与文本冲突。

旧路径有、通用层暂时没有：

- 旧 `message` / `detail` 气泡正文（通用层故意不收）。
- 旧 `env`（desktop/terminal）。
- Cursor 文件名 `sessionKey`（通用层拒绝 filename sessionRef）。
- 旧路径 mtime 事件时间（通用层不把 mtime 当 `eventTime`）。
- 生产 Monitor 去重 / freshness / 是否真正派发给用户。

---

## 10. 潜在问题

本轮**没有**带结构化证据的 `POTENTIAL_BUG`。

历史 Codex 对照有 1 组「session 级可见、不足以做 turn 判定」。这是关联能力不足，不是已证实误判。

不得把下列现象写成 bug：

- 旧 `done` 对通用 `completed_signal`；
- 旧 `failed` 对通用 `unknown`（普通 abort）；
- 缺少 turnRef。

---

## 11. 样本未覆盖项

- 真实 Cursor `turn_ended` 全状态（尤其 error / 官方取消）：`SAMPLE_NOT_COVERED`
- Cursor item 级失败的真实文件形状：`SAMPLE_NOT_COVERED`
- Codex 官方 `exec --json` 点号事件流：既有报告仍为 **BLOCKED** / 未用真实流验证
- 未回放的本地 Codex session（历史报告 311 个文件中大部分未详细回放）
- process observer 与真实 PID 关联
- 已验证的 `taskSemantics=completed`

---

## 12. 不可确认项

- 真实 Cursor 协议是否还有其他 status；
- 旧 Cursor error 文案「用户取消」是否等于用户主动取消（旧路径只当 interrupted 细节）；
- 历史诊断中 sessionKey 与 sessionId 哈希不一致时，除 fileAlias 外的更细对齐；
- 未匹配记录是否漏判（无稳定键时只能 `UNMATCHED_CORRELATION`）。

---

## 13. 是否具备进入下一阶段的条件

**不具备进入阶段 5（统一用户可见层）的条件。**

原因：

1. 生产 Monitor 尚未对照切换；
2. Cursor 没有本轮真实协议投影对照（`REAL_CURSOR` 为空）；
3. `taskSemantics` 仍全部 `not_verified`；
4. process observer 未实现；
5. 对照工具刚建立，尚未长期并排。

阶段 5 启动前仍需单独产品决策：是否改 Cursor 完成气泡、哪些状态允许出声、是否删除旧 kind。

---

## 回滚

删除：

- `src/main/agent/generic/agentShadowComparison.ts`
- `src/main/agent/generic/agentShadowComparison.test.ts`
- `docs/agent-generic-shadow-comparison.md`

不要回滚 Adapter、扫描器、Monitor 或可见层。它们本轮未改。
