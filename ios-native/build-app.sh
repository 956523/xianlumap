#!/bin/bash
# ============================================================
# build-app.sh — 自驾线路图 iOS App 构建流水线
# 用法：
#   ./build-app.sh           打包 www → 生成工程 → 编译 → 装模拟器
#   ./build-app.sh run       编译 + 装 + 启动 + 截图冒烟
#   ./build-app.sh icon      重新生成 App 图标
# 环境：Xcode（任意卷），xcodegen（brew）；免 sudo（DEVELOPER_DIR 注入）
# ============================================================
set -e
cd "$(dirname "$0")"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Volumes/T/Applications/Xcode.app/Contents/Developer}"
UDID="${UDID:-D85DE6BE-A9D5-4BDC-BC6B-663E1EC31003}"
REPO="$(cd .. && pwd)"

step() { echo "—— $1"; }

if [ "$1" = "icon" ]; then
  step "生成 App 图标（CoreGraphics 绘制山海一线）"
  swift scripts/make-icon.swift
  exit 0
fi

step "1/5 打包 www（仓库干净文件，含 engine/ route-defs/ 目录结构）"
rm -rf www && mkdir www
rsync -a "$REPO/index.html" "$REPO/favicon.svg" "$REPO/manifest.json" "$REPO/sw.js" www/
if [ -f "$REPO/key.local.js" ]; then rsync -a "$REPO/key.local.js" www/; fi
rsync -a "$REPO/engine" "$REPO/route-defs" www/

step "2/5 xcodegen 生成工程"
xcodegen --spec project.yml >/dev/null

step "3/5 编译（iOS 模拟器）"
xcodebuild -project XianluMap.xcodeproj -scheme XianluMap \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build build | tail -1

step "4/5 安装到模拟器"
xcrun simctl install "$UDID" build/Build/Products/Debug-iphonesimulator/XianluMap.app

if [ "$1" = "run" ]; then
  step "5/5 启动 + 截图冒烟"
  xcrun simctl terminate "$UDID" com.xianlumap.app 2>/dev/null || true
  xcrun simctl launch "$UDID" com.xianlumap.app
  sleep 14
  OUT="/tmp/xianlumap-app-$(date +%H%M).png"
  xcrun simctl io "$UDID" screenshot "$OUT" >/dev/null 2>&1
  echo "截图：$OUT"
fi
echo "✅ 完成（v$(grep -o '1\.[0-9.]*' Sources/Info.plist | head -1)）"
