# iOS App（自驾线路图）

> iOS 端由本目录独立构建；产品代码仍在仓库根（网页版），此处只是壳。
> 状态：**壳方案已可用**（加载托管站点，PWA 离线接管）；完全内置离线方案为已知遗留。

## 架构

```
Sources/
  AppDelegate.swift      入口 + xianlumap://open?route=<id>&… 深度链接（query 原样透传给网页）
  ViewController.swift   WKWebView 全屏壳 + 定位桥（S36）+ 定位权限
  MiniServer.swift       [遗留] 内置 HTTP 服务器（iOS 26 模拟器拦截 http/https 均 SIGABRT，停用）
  SchemeHandler.swift    [遗留] WKURLSchemeHandler 尝试（同上原因停用）
  Info.plist             ATS 全开 / 定位用途文案 / URL scheme 注册
  Assets.xcassets        AppIcon（scripts/make-icon.swift 矢量生成）
build-app.sh             一键流水线：打包 www → xcodegen → 编译 → 装模拟器（run 模式含截图冒烟）
scripts/make-icon.swift  山海一线图标生成（CoreGraphics，免第三方）
```

## S36 定位桥（行中定位的唯一通路）

**根因**：dev 站是 `http://<局域网IP>`（非安全上下文），WKWebView 直接拒绝
`navigator.geolocation`——网页版行中定位在 App 内不可用的原因。

**桥（ViewController.swift）**：
- `WKUserScript` 在 document start（mainWorld）注入 `window.__xlmNative=true`；
- script message handler `"xlm"`：网页 `window.webkit.messageHandlers.xlm.postMessage({action:"geo",on:true|false})`
  → 启停 `CLLocationManager.startUpdatingLocation/stopUpdatingLocation`（行中 enter/exit 时）；
- `didUpdateLocations` → `webView.evaluateJavaScript("window.__xlmGeo&&__xlmGeo(<lat>,<lng>)")`。

**网页侧（engine/enroute.js `_bindGeo`）**：检测到 `__xlmNative` 即注册 `__xlmGeo`
  并走 messageHandlers 启停；否则回落原 navigator.geolocation 路径（浏览器中零变化）。
  probe/c4 的 vm 无 webkit，`typeof` 守卫不报错。

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

## baseURL 口径

- 开发：`ViewController.baseURL = "http://192.168.1.108:8000/index.html"`（Mac 的 en1 局域网 IP，
  模拟器/同 WiFi 真机可达；本机服务由 pm2 守护 `python3 -m http.server 8000`）
- IP 变了先 `ipconfig getifaddr en1`（注意本机 en0 可能无 IP，active 接口是 en1）再改 static let
- 发版：切 `https://xianlumap-dev.ok.kimi.link`（注释在 baseURL 上方）

## 深度链接与调试钩子

- `xianlumap://open?route=<id>` 直达线路（注意必须是 `//open?` 形式，`xianlumap://route=…` 会被当成 host）
- query 原样透传，可用网页端调试钩子（与 `?mobsheet=`/`?z=` 同族）：
  - `?enr=1` 启动即入行中（**验证定位桥**：配合模拟器定位直接看行中卡出现真实位置数据）
  - `?enr=1&enrkm=400` 外加手动锚点；`?sup=1` 启动即开补给抽屉
- 模拟器定位：`DEVELOPER_DIR=/Volumes/T/Applications/Xcode.app/Contents/Developer xcrun simctl location <UDID> set <lat>,<lng>`
  （逗号单参数格式；截图用 `xcrun simctl io <UDID> screenshot <out.png>`）

## S36 变更备忘（2026-10-22）

- 网页版 S36 全部进 App 零壳改动：毛玻璃胶囊顶栏 / peek hero 大卡 / 补给抽屉（我的指定）/ 行中深色大卡（待出发·出发钮·计时·到达 toast）
- `index.html` viewport 加 `viewport-fit=cover`：App 内 env(safe-area-inset-*) 生效，胶囊顶栏/抽屉避让状态栏与 Home 条（桌面/移动浏览器无影响）
- App 内验收截图：/tmp/s36-app-plan.png（规划态）/ s36-app-enroute.png（行中·桥生效）/ s36-app-sup.png（补给抽屉）

## 当前形态与边界（诚实清单）

| 项 | 状态 |
| --- | --- |
| 渲染/交互/数据 | 完整（网页版全部能力，23+ 轮迭代成果零重写） |
| 定位（行中模式） | ✅ S36 原生桥已接（CLLocationManager → __xlmGeo）；模拟器 `simctl location` 验证过端到端 |
| 离线 | 依赖站点 PWA 缓存（首启需联网） |
| 完全内置（安装包直带全部文件、零网络） | **遗留**：WKURLSchemeHandler/内置服务器在 iOS 26 模拟器被系统 SIGABRT 拒绝（http 与 https 拦截均试）；待真机验证或 CocoaPods 通路后走 Capacitor iOS |
| App 图标 | 已生成（make-icon.swift），粗细/配色可调 |
| 深度链接 | xianlumap://open?route=<id>（query 透传） |

## 真机安装（待办）

需要 Apple ID 签名：Xcode → 项目 Signing → Team 选个人账号（免费 7 天证书）→
`xcodebuild -allowProvisioningUpdates` 出真机包。或装 Xcode 用图形界面 Run 到手机。
真机调试同样走局域网 baseURL（手机与 Mac 同 WiFi）；发版切托管站点。

## 发版流程

1. 网页版发版（Kimi 部署）→ 2. 本目录 bump 版本 → 3. `./build-app.sh run` 冒烟 → 4. 提交（ios-native 已入 git）
