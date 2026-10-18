# Codex 真实运行影子对照（阶段 6）

## 1. 执行结论

**BLOCKED_NO_LIVE_DATA**

未找到真实运行期间产生的诊断文件，因此不能声称对照已完成。

缺失：
- `codex-legacy.jsonl`
- `codex-shadow.jsonl`
- `codex-candidate.jsonl`

- 尚未产生真实运行数据。
- 不能用单元测试或 fixture 冒充真实运行。
- 不能据此替换正式 Monitor。

候选状态不是正式用户状态。`shouldNotify` 必须为 false。本报告不改变桌宠、气泡、声音或 Monitor。

## 2. 数据范围

- 诊断目录：`$HOME/Library/Application Support/desktop-pet-mvp/diagnostics`（不存在）
- 时间窗口：2026-09-05T09:02:51.871Z → 2026-09-12T09:02:51.871Z
- 每文件最大读取 2097152 字节；byteOffset=0
- `codex-legacy.jsonl`：不存在；文件 0 字节；读入 0 字节；解析 0；去重后 0；重复 observationId 0；malformed 0
- `codex-shadow.jsonl`：不存在；文件 0 字节；读入 0 字节；解析 0；去重后 0；重复 observationId 0；malformed 0
- `codex-candidate.jsonl`：不存在；文件 0 字节；读入 0 字节；解析 0；去重后 0；重复 observationId 0；malformed 0

## 3. 旧路径统计

- 文件不存在。不能把缺失当成旧路径无事件或新检测器误判。

## 4. 新检测器统计

- 文件不存在。不能把缺失当成状态不一致。

## 5. 候选状态统计

- 文件不存在。不能把缺失当成候选状态不一致。

## 6. 新旧对照

当前最多 session 级对照，不是完整 turn 级对照。
缺少对应记录 ≠ 误判。无法可靠关联标记为 `UNMATCHED_CORRELATION`。

| 关联 | 旧事件 | 新 DerivedState | CandidateState | 是否允许用户通知 | 当前结论 |
|---|---|---|---|---|---|
| 无 | 无 | 无 | 无 | 否 | 无法确认 |

- 对照分类：无

## 7. 专项检查

- 无影子/候选数据，专项检查样本未覆盖。
- 多个 turn 状态污染：本报告不做 turn 级一一对应，标记为无法确认。
- 多个 session 串线：只按已有脱敏 sessionId / fileAlias 分组，不按时间猜。
- 重复 observationId：legacy 0，shadow 0，candidate 0
- prime 重放：诊断回调在 prime 时不发射；本报告只读已落盘记录，不能反证 prime 行为。
- candidatePetState 未进入用户行为：本报告为只读统计，未改桌宠/气泡/声音。

## 8. 尚未完成项

以下官方事件若本窗口未出现，只能写样本未覆盖，不能写不支持：

- `turn.failed`
- `turn.cancelled`
- 顶层 `error`
- 限流 / 鉴权 / 审批 / 断流 / 超时

## 9. 下一步

仍不能替换正式 Monitor。候选状态与 `shouldNotify=false` 必须保持影子诊断。
