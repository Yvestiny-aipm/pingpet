# DesktopPetMVP（桌宠 v0.1）

一个安静住在 macOS 桌面上的小伙伴：透明置顶小窗、可拖拽、点击有反应、偶尔冒出简短的陪伴气泡，带菜单栏托盘和设置窗口。

> v0.1 只做桌面基础形态。Agent 监控（Codex / Claude Code）、DIY 生成宠物、提醒类功能、Windows 版等均为后续版本范围。

## 开发

```bash
pnpm install
pnpm dev        # 启动开发模式（HMR）
```

## 构建与打包

```bash
pnpm build      # 类型检查 + 产物构建（out/）
pnpm dist:mac   # 产出 macOS DMG + ZIP（release/）
```

## 技术栈

- Electron + electron-vite + React + TypeScript
- electron-store 本地持久化（无任何网络请求 / 无遥测）
- electron-builder 打包 macOS DMG/ZIP

## 目录结构

```
src/
  main/       主进程：窗口、托盘、存储、气泡调度、IPC
  preload/    contextBridge 安全桥接（window.petApi）
  renderer/   React UI：宠物视图 + 设置页（hash 路由区分窗口）
  shared/     跨进程共享类型、默认值、宠物元数据
build/        应用图标 + 托盘模板图标（脚本生成的原创素材）
```

## 设置存储位置

- 开发模式：`~/Library/Application Support/desktop-pet-mvp/config.json`
- 打包后：`~/Library/Application Support/DesktopPetMVP/config.json`

存储字段：`selectedPetId`、`petScale`、`bubblesEnabled`、`bubbleFrequencySeconds`、`petPosition`、`petVisible`。

## 已知限制（v0.1）

- **本地 ad-hoc 签名，未公证**：`dist:mac` 产物会补一个本地测试用签名，方便 Dock/Finder 正常启动；它不是 Developer ID 公开分发签名。首次给别人安装时仍可能被 Gatekeeper 拦截，需要右键 →「打开」，或在「系统设置 → 隐私与安全性」里放行。公开分发前需要：
  1. Apple Developer Program 会员
  2. Developer ID Application 证书签名
  3. 公证（notarytool）并 staple 到 DMG
- 应用保留 Dock 图标。点击 Dock 图标可唤起设置；也可以从顶部应用菜单 `DesktopPetMVP → 设置…` 或快捷键 `⌘,` 打开设置。顶部菜单栏入口仅作为备用。
- 渲染页面在开发模式下不注入 CSP（HMR 内联脚本限制），生产构建时自动注入；应用本身不加载任何远程内容。

## v0.2+ 计划（本版本刻意不做）

- Codex / Claude Code 本地会话监控（working / done / needs attention / failed）
- 自定义提醒、更多宠物状态、气泡动作
- DIY 生成宠物（上传参考图 → AI 生成原创宠物）
- Windows 版、签名 + 公证 + 自动更新、落地页
