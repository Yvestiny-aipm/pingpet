#!/usr/bin/env bash
#
# 发一个 macOS 版本。用法：pnpm release:mac
#
# 为什么要有这个脚本：版本号有三个地方必须一致——package.json（决定 App 里显示的
# 版本号和「检查新版本」的比较基准）、git tag、GitHub release 的 tag。之前手敲 tag
# 时漂移过一次：package.json 停在 0.1.0，而代码注释与 README 已经在讲 v0.6.x，
# 用户在设置台看到的是 v0.1.0。更糟的是这种漂移不会报错——
#   tag 比 package.json 新 → 装了新版的用户被无限提醒「有新版本」（永远追不上）
#   tag 比 package.json 旧 → 真发了新版也没人收到提醒
# 所以这里只认 package.json 一个来源，tag 由它派生，不接受手敲参数。
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="Yvestiny-aipm/pingpet"

die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
step() { printf '\n\033[36m▶ %s\033[0m\n' "$1"; }

command -v gh >/dev/null || die "需要 gh（GitHub CLI）：brew install gh"
gh auth status >/dev/null 2>&1 || die "gh 未登录：gh auth login"

VERSION="$(node -p 'require("./package.json").version')"
TAG="v${VERSION}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "package.json 的 version 不是 x.y.z：${VERSION}"

# 发布必须能被 tag 精确定位到一次提交，否则事后无法复现这个二进制是哪份代码打的。
[[ -z "$(git status --porcelain)" ]] || die "工作区有未提交的改动，先提交再发版"

git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null && die "tag ${TAG} 已存在，请先在 package.json 里升版本号"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  die "GitHub 上已有 ${TAG} 这个 release，请先在 package.json 里升版本号"
fi

step "准备发 ${TAG}"

step "跑测试"
pnpm test

step "打包 DMG"
pnpm dist:mac

DMG="release/PingPet-macOS-arm64.dmg"
[[ -f "$DMG" ]] || die "没找到 ${DMG}（electron-builder.yml 的 dmg.artifactName 改了？）"

step "打 tag 并推送"
git tag -a "$TAG" -m "PingPet ${TAG}"
git push origin HEAD
git push origin "$TAG"

step "创建 GitHub release"
# README 和官网给的是 releases/latest/download/PingPet-macOS-arm64.dmg 这个固定地址，
# 靠的是 latest release 里存在同名附件，所以附件名不能带版本号。
gh release create "$TAG" "$DMG" \
  --repo "$REPO" \
  --title "PingPet ${TAG}" \
  --notes-file - <<EOF
下载：[PingPet-macOS-arm64.dmg](https://github.com/${REPO}/releases/latest/download/PingPet-macOS-arm64.dmg)

首次打开会被 macOS 拦（未做 Developer ID 公证）：右键 App →「打开」，或系统设置 → 隐私与安全性 →「仍要打开」。
EOF

printf '\n\033[32m✓ %s 已发布\033[0m\n' "$TAG"
gh release view "$TAG" --repo "$REPO" --json url --jq .url
