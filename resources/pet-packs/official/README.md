# 官方内置皮肤包

这个目录下的每个子文件夹是一个「官方内置皮肤包」，会随 App 打包发布（由 `electron-builder.yml` 的 `extraResources` 打入 `Resources/pet-packs/official`）。

## 添加一个官方桌宠

1. 在本目录下新建一个文件夹，文件夹名建议和 `manifest.id` 一致（如 `sample-blob`）。
2. 放入 `manifest.json` 和各状态图片（至少 `idle`）。
3. `pnpm dev` 打开设置台，确认新桌宠出现（来源显示「官方」）。
4. `pnpm dist:mac` 打包，新桌宠会随 App 一起发布。

格式与字段说明见 `docs/pet-pack-format.md`。

## 素材版权

只能使用**原创、已授权、或你自己拥有权利**的素材。不要使用任何热门 IP / 受版权保护的形象。本目录的 `sample-blob` 是原创示例。
