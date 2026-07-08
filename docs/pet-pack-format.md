# 桌宠皮肤包格式（Pet Pack Format）· v0.3

桌宠形象从 v0.3 起支持「皮肤包」：一组图片 + 一个 `manifest.json`。两类来源：

- **官方内置**：放进 `resources/pet-packs/official/<id>/`，随 App 打包发布。
- **用户导入**：在设置台点「导入皮肤包文件夹」，App 校验通过后复制到
  `~/Library/Application Support/desktop-pet-mvp/pet-packs/imported/<id>/`。

---

## 目录结构

```text
my-pet/
  manifest.json        必需
  thumbnail.svg        可选（缺省用 idle 当预览）
  idle.svg             必需
  happy.svg            可选
  sleepy.svg           可选
  attention.svg        可选
  thinking.svg         可选
  failed.svg           可选
```

最小可用包只需 `manifest.json` + `idle` 素材，其余状态缺失时按规则 fallback。

---

## manifest.json 字段

```json
{
  "schemaVersion": 1,
  "id": "soft-blob",
  "name": "软软团",
  "version": "1.0.0",
  "author": "official",
  "description": "一只软乎乎的小桌宠",
  "accentColor": "#7AA7FF",
  "thumbnail": "thumbnail.svg",
  "states": {
    "idle": "idle.svg",
    "happy": "happy.svg",
    "sleepy": "sleepy.svg",
    "attention": "attention.svg",
    "thinking": "thinking.svg",
    "failed": "failed.svg"
  }
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `id` | 是 | 小写字母 / 数字 / `-` / `_`，长度 2-40。imported 目录名即此 id |
| `name` | 是 | 显示名，长度 1-30 |
| `description` | 否 | 最长 80 |
| `accentColor` | 否 | `#RRGGBB`；非法时用默认蓝 `#7AA7FF` |
| `version` / `author` | 否 | 元信息 |
| `thumbnail` | 否 | 相对路径的缩略图；缺省用 `states.idle` |
| `states` | 是 | 状态名 → 相对路径。**必须含 `idle`** |

### 支持的状态

`idle` / `happy` / `sleepy` / `attention` / `thinking` / `failed`。

> 注意：本项目没有独立的 `done` 状态——任务完成时桌宠复用 `happy`。所以皮肤包不需要 `done` 图。

### 缺失状态的 fallback 规则

- `happy` / `sleepy` / `attention` / `thinking` 缺失 → 用 `idle`
- `failed` 缺失 → 先用 `attention`，`attention` 也没有 → 用 `idle`

---

## 素材要求

- 允许格式：`.png` / `.webp` / `.svg`。**不支持** gif 动图 / 视频 / Lottie / 远程 URL 图片。
- 建议画布 140×140，形象居中、`object-fit: contain` 显示（不会撑破桌宠窗口）。
- 单个素材 ≤ 5MB，整包 ≤ 30MB。

## 安全约束（导入时强校验，任一不过则整包拒绝）

- `states` / `thumbnail` 里的路径必须是**相对路径**，且 resolve 后仍落在包目录内——**禁止 `../` 路径穿越**。
- `id` / `name` / `accentColor` 按上表校验；非法 `accentColor` 降级为默认色而非报错。
- 导入采用「复制到临时目录 → 再次校验 → 原子替换正式目录」，避免半导入状态。

---

## 开发者：添加官方内置桌宠

1. 在 `resources/pet-packs/official/` 下新建文件夹（名同 `id`）。
2. 写好 `manifest.json`，放入至少 `idle` 图。
3. `pnpm dev` → 设置台确认新桌宠出现（来源「官方」）。
4. `pnpm build` / `pnpm dist:mac` 打包，官方桌宠随 App 发布
   （`electron-builder.yml` 已配置 `extraResources` 把本目录打入安装包）。

## 用户：制作并导入本地桌宠

1. 按上面的结构建一个文件夹，写 `manifest.json`，放入状态图（至少 `idle`）。
2. 设置台 →「导入皮肤包文件夹」→ 选这个文件夹。
3. 校验通过后自动复制、选中；可在设置台「打开导入目录」查看，或删除已导入的桌宠。

## 版权提醒

只能使用**原创、已授权、或自己拥有权利**的素材，不要使用受版权保护的热门 IP 形象。
