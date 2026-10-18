# Codex 真实运行影子对照（阶段 6）

## 1. 执行结论

**PARTIAL**

三个诊断文件均存在。当前最多做 session 级对照，可辅以 fileAlias；不能做完整 turn 级一一对应。

本报告只读取真实 userData 诊断 JSONL。
- 真实运行数据：下面列出的 `codex-*.jsonl`。
- fixture / 单元测试数据：未计入本报告。
- 不能用单元测试结果冒充真实运行。

候选状态不是正式用户状态。`shouldNotify` 必须为 false。本报告不改变桌宠、气泡、声音或 Monitor。

## 2. 数据范围

- 诊断目录：`$HOME/Library/Application Support/desktop-pet-mvp/diagnostics`（存在）
- 时间窗口：2026-10-11T13:09:40.996Z → 2026-10-18T13:09:40.996Z
- 每文件最大读取 2097152 字节；byteOffset=0
- `codex-legacy.jsonl`：存在；文件 23526 字节；读入 23526 字节；解析 0；去重后 0；重复 observationId 0；malformed 0
- `codex-shadow.jsonl`：存在；文件 17854 字节；读入 17854 字节；解析 0；去重后 0；重复 observationId 0；malformed 0
- `codex-candidate.jsonl`：存在；文件 23220 字节；读入 23220 字节；解析 0；去重后 0；重复 observationId 0；malformed 0

## 2.1 关联结果

关联优先级：脱敏 sessionId/sessionKey → fileAlias。不按时间或顺序猜 turnId，不猜造真实 sessionId。
- 无分组。

## 3. 旧路径统计

- legacyKind：无
- dispatched=true：0
- ignoredBy：无

## 4. 新检测器统计

- lifecycle：无
- cause：无
- process：无
- connection：无
- item：无
- outputIntegrity：无
- confidence：无
- unknown lifecycle：0
- incomplete lifecycle：0
- completed_signal：0
- item=partial_failure：0
- 影子记录本身不一定带 turn / taskSemantics / retryability；这些字段以候选诊断 derived 为准。
- candidate.derived.turn：无
- candidate.derived.taskSemantics：无
- candidate.derived.retryability：无

## 5. 候选状态统计

- candidate：无
- candidatePetState（仅影子统计）：无
- shouldNotify=true：0（必须为 0）
- shouldNotify 始终 false：是

## 6. 新旧对照

当前最多 session 级对照，不是完整 turn 级对照。
缺少对应记录 ≠ 误判。无法可靠关联标记为 `UNMATCHED_CORRELATION`。

| 关联 | 旧事件 | 新 DerivedState | CandidateState | 是否允许用户通知 | 当前结论 |
|---|---|---|---|---|---|
| 无 | 无 | 无 | 无 | 否 | 无法确认 |

- 对照分类：无

## 7. 专项检查

- completed_signal 区分：普通 0，partial_failure 0
- item=partial_failure 保留：0 条影子记录
- cause=tool_failed 保留：0 条
- outputIntegrity=partial 保留：0 条
- retryability=unknown 保留：0 条候选记录
- incomplete/process_exit 未变成 cancelled：是
- unknown 未被猜成 failed/succeeded：是
- shouldNotify 始终 false：是
- incomplete 记录数：0
- 多个 turn 状态污染：本报告不做 turn 级一一对应，标记为无法确认。
- 多个 session 串线：fileAlias 组 0 个；只按已有脱敏 sessionId / fileAlias 分组，不按时间猜。同一 fileAlias 上旧 sessionKey 与影子 sessionId 哈希不同 ≠ 串线。
- 重复 observationId：legacy 0，shadow 0，candidate 0
- prime 重放：legacy ignoredBy 含 prime 0 条。诊断回调在 prime 时不发射；仅凭落盘记录不能反证未落盘的 prime 行为。
- candidatePetState 未进入用户行为：本报告为只读统计，未改桌宠/气泡/声音。

## 7.1 保持 unknown 的字段

- `completed_signal` 只表示协议发出结束信号，不等于任务成功；candidate 不得映射为 succeeded。
- shadow item=unknown：0/0。source=n/a。本地 session JSONL 不一定带官方 item status，不能写成协议不支持。
- shadow cause=unknown：0/0。本窗口无 tool_failed / turn_failed 结构化证据。
- shadow outputIntegrity=unknown：0/0。无 complete/partial 的结构化证据。
- 旧路径 turnId/threadId：0/0 条为 unknown 或缺失。旧 Monitor 未提供则不得猜造。

## 8. 尚未完成项

以下官方事件若本窗口未出现，只能写样本未覆盖，不能写不支持：

- `turn.failed`
- `turn.cancelled`
- 顶层 `error`
- 限流 / 鉴权 / 审批 / 断流 / 超时

## 9. 下一步

仍不能替换正式 Monitor。候选状态与 `shouldNotify=false` 必须保持影子诊断。
