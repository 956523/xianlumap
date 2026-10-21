# iOS App（自驾线路图）

> iOS 端由本目录独立构建；产品代码仍在仓库根（网页版），此处只是壳。
> 状态：**壳方案已可用**（加载托管站点，PWA 离线接管）；完全内置离线方案为已知遗留。

## 架构

```
Sources/
  AppDelegate.swift      入口 + xianlumap://route=<id> 深度链接
  ViewController.swift   WKWebView 全屏壳 + 定位权限（行中模式）
  MiniServer.swift       [遗留] 内置 HTTP 服务器（iOS 26 模拟器拦截 http/https 均 SIGABRT，停用）
  SchemeHandler.swift    [遗留] WKURLSchemeHandler 尝试（同上原因停用）
  Info.plist             ATS 全开 / 定位用途文案 / URL scheme 注册
  Assets.xcassets        AppIcon（scripts/make-icon.swift 矢量生成）
build-app.sh             一键流水线：打包 www → xcodegen → 编译 → 装模拟器（run 模式含截图冒烟）
scripts/make-icon.swift  山海一线图标生成（CoreGraphics，免第三方）
```

## 使用

```bash
cd ios-native
./build-app.sh        # 构建 + 安装
./build-app.sh run    # 构建 + 安装 + 启动 + 截图（/tmp/xianlumap-app-*.png）
./build-app.sh icon   # 重新生成图标
```

- Xcode 在 T 卷：免 `xcode-select`（sudo 不可用），脚本用 `DEVELOPER_DIR` 注入
- 默认模拟器 iPhone 16e（UDID 可在脚本头部改）
- 版本号：`Sources/Info.plist` 的 CFBundleShortVersionString/CFBundleVersion，发版时 bump

## 当前形态与边界（诚实清单）

| 项 | 状态 |
| --- | --- |
| 渲染/交互/数据 | 完整（网页版全部能力，23 轮迭代成果零重写） |
| 定位（行中模式） | 原生权限申请已接，模拟器可用 |
| 离线 | 依赖站点 PWA 缓存（首启需联网） |
| 完全内置（安装包直带全部文件、零网络） | **遗留**：WKURLSchemeHandler/内置服务器在 iOS 26 模拟器被系统 SIGABRT 拒绝（http 与 https 拦截均试）；待真机验证或 CocoaPods 通路后走 Capacitor iOS |
| App 图标 | 已生成（make-icon.swift），粗细/配色可调 |
| 深度链接 | xianlumap://route=<id> |

## 真机安装（待办）

需要 Apple ID 签名：Xcode → 项目 Signing → Team 选个人账号（免费 7 天证书）→
`xcodebuild -allowProvisioningUpdates` 出真机包。或装 Xcode 用图形界面 Run 到手机。

## 发版流程

1. 网页版发版（Kimi 部署）→ 2. 本目录 bump 版本 → 3. `./build-app.sh run` 冒烟 → 4. 提交（ios-native 已入 git）
