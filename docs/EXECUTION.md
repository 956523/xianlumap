# 平台化执行计划 v1.0

> 本文档是 `PLATFORM.md` 的执行层补充：PLATFORM.md 讲「做成什么样」，本文档讲「按什么顺序做、每步怎么验收」。
> 评审状态：§9 五问的建议结论见本文档 §2（待开洋签字确认，确认前按本计划推进 S1——S1 只搬数据，任何结论下都无损）。

---

## 1. 现状（2026-09-28 盘点）

- S0（缩放分级）已完成并验收 ✅
- S1（青甘数据 verbatim 抽出为 route-defs/qinghai-gansu.js）已完成并验收 ✅（实测结论见 §4）
- S1.5（川西小环线探针）已完成并验收 ✅：引擎可同时加载两条线（`?route=chuanxi`），
  引擎写死青甘的假设已盘点为 docs/GAP-LIST.md 并全部处置（见该文文末回填）
- S2（引擎消硬编码 + engine/ 拆分）已完成并验收 ✅（实测结论与契约终形见 §7）
- S3（构建管线参数化 + 接入高德数据源 + 川西全量真实数据）已完成并验收 ✅（见 §8）
- S4（体检 V1–V4 + 可信度透出 + 青甘 281km 修正）已完成并验收 ✅（见 §10）
- S5（页面内编辑模式，overlay 架构）已完成并验收 ✅（用法见 §11）
- S6–S8 未开工
- 已知待清理项（与平台化并行处理，不阻塞）：
  - `routes/qinghai-gansu/stations-new.json`（2026-09-26 新抓取，多 `op/slow/cat` 字段）未回写 `stations-data.js`
  - `tools/write-real-route.js` 引用旧文件名 `qinghai-gansu-loop.html`，疑似死代码
  - README 写测试 88 条，实际 94 条
  - `index.html` 顶部残留 WorkBuddy 开发环境密钥代理块（`__WB_*__`）

## 2. 对 PLATFORM.md §9 五问的建议结论

| # | 问题 | 建议结论 |
| --- | ---- | ---- |
| 1 | 抽象粒度：主折线 + 分段 + 支线，不做路网 | **同意**。网格路网是另一个产品，硬塞会四不像 |
| 2 | 执行顺序 | **修订**（见 §3）：第二条线从 S6 提前为「探针」，抽象由真实差异驱动 |
| 3 | 第二条线 | **先川西小环线（快验证），再 318（狠压测）**，与 PLATFORM.md 倾向一致 |
| 4 | 成本分工：几何人定、文案人改、中间脚本算 | **同意**，并加一条：地名/分段/文案的初稿由 LLM 生成、人审改（见 §5.3） |
| 5 | 数据可信度硬规矩 | **同意**。「抓不到的不假装抓到」是产品底线，不是技术取舍 |

## 3. 修订后的执行顺序

PLATFORM.md 原计划：S1 → S2 → S3 → S4 → S5 → **S6 第二条线** → S7 → S8。
问题：文档自己写明「不做第二条线的抽象都是纸上谈兵」，却把验证放在五个准备阶段之后——抽象先行、验证滞后，正是 §0 警惕的失败路径。

**修订原则：抽象被第二条线逼出来，而不是被设计出来。**

| 阶段 | 内容 | 验收 |
| ---- | ---- | ---- |
| **S1** | 线路包落地（薄做）：青甘数据 verbatim 抽出为 `route-defs/qinghai-gansu.js`，页面改读它。**只搬数据不改行为，不追求契约完美** | 页面行为逐像素一致；c4-test 94 全绿；抽出值与原值逐字节一致 |
| **S1.5** | 手写川西小环线**最小探针包**（约 20 途经点 + 粗分段，数据允许不全） | 引擎能同时加载两条线（哪怕川西显示粗糙） |
| **S2** ✅ | 引擎消硬编码：由两条线的真实差异驱动契约补全与 `engine/` 改造 | `engine/` grep 不到青甘/川西地名里程；两条线均正常渲染 |
| **S3** ✅ | 构建管线参数化：`build-route.js <线路包>` / `build-stations.js <线路包>` | 用青甘包重跑，产出与现有数据一致 |
| **S4** ✅ | 体检 V1–V4（tools/validate.js）+ 可信度透出（长盲区上图、站点来源日期、侧栏快照声明与截断提示） | 体检全绿或有明确标注；青甘 199.9km 无桩段在页面可见 |
| **S5** ✅ | 页面内编辑模式（改文案存 localStorage、可导出；overlay 架构） | 改天标题/分段/地名刷新保留，可导出 JSON，可一键恢复 |
| **S6** | 川西小环线全量补数据（高程/站点穷举） | PLATFORM.md A1–A6 全达标 |
| **S7** | 318 川藏南线 | 同上，引擎改动仍为 0 |
| **S8** | 多线路入口（选线器 + 按需加载） | 打开页面选线，各自独立加载 |

**不变的原则**：每步独立验收、青甘线全程可跑、不做破坏性重构、不引入 webpack/vite/TS。

## 4. S1 构建计划（已完成）

### 产出物

- 新增 `route-defs/qinghai-gansu.js`：包含从 `index.html` 抽出的全部数据变量，顶层 `var` 保持全局，**值逐字节不动**：
  - `ALT_REAL`（L464）、`ALT_MARKS`（L522）、`ALT`（L524，是 IIFE 合成逻辑，原样搬走）、`LZ_XN_KM`（L534）、`TOTAL_XN`（L536）、`P_LZ_XN`（L593）、`CORE`（L594）、`TAIL`（L639）、`CLASSIC`（L648）、`CITIES`（L651）、`SPOTS`（L675）、`FUELS`（L694）、`EVS`（L711）、`STATION_DATA`（L1139）
  - 文件头加注释块：来源说明、禁止手改（构建产物/注入数据的边界说明）
- 修改 `index.html`：数据块原位删除，主 `<script>`（L449）前加 `<script src="route-defs/qinghai-gansu.js"></script>`

### 明确不做（留给 S2）

- 不把数据重组成 PLATFORM.md §2.1 的 `waypoints/days/marks` 契约形状（S1.5/S2 由真实差异驱动）
- 不回写 `stations-new.json`（会改变行为）
- 不动任何逻辑代码

### 验收

1. `node tools/c4-test.js` → 94 pass / 0 fail
2. 抽出值校验：Node 脚本分别加载原/新两处变量，`JSON.stringify` 全等
3. 手动起 `python -m http.server` 开页面，渲染与之前一致（有 Key 时）

> S1 实测结论（2026-09-28）：c4-test 94 pass / 0 fail；15 个变量（指定 14 个 + 一并搬出的 LZ_HEAD）
> 与原文件逐字节全等；index.html 1916 → 1701 行；c4-test.js 加了 2 行机械适配
> （vm 里按页面相同顺序先注入 route-defs 数据包，断言与工具逻辑未动）。

## 5. 工程补强（与阶段并行，量小）

1. **最小 CI**：GitHub Actions 跑 `node tools/c4-test.js`。项目零依赖，成本≈0。顺手修 README 数字、删 `write-real-route.js`、清 `__WB_*__` 残留
2. **站点数据刷新入口**：tools/ 固化「重抓 → 体检 → 回写」一条命令；不做自动调度，页面透出 `updatedAt`（契约已有字段），每季度手动跑一次
3. **LLM 辅助「加线」**：途经点人定后，地名标注、日均 250km 初分天数、文案骨架由 LLM 生成初稿、人审改。目标：把 §0 难题二的第 4/5/6 行从「手打」降为「审改」

## 6. 风险与边界（沿用 PLATFORM.md §8，不重复）

补充一条：**S8（多线路入口）不得提前**。三条线之前没有选线的必要；S5（编辑模式）也不急——现阶段唯一用户是开洋自己，「不依赖开洋」的开关等第二个真实用户出现再付它的成本。

## 7. S2 实测结论与数据包契约终形（2026-09-28）

### 验收结果

1. `grep -ri 'qinghai|青甘|兰州|西宁|塔尔寺|拉脊山' engine/` → 无匹配 ✅
2. `node tools/c4-test.js` → 94 pass / 0 fail ✅（加载链改为按 index.html 顺序拼接 engine/*.js，断言与工具逻辑未动）
3. `node tools/probe-check.js` → 20 pass / 0 fail ✅（川西「无可达警告」断言按新契约改为「未接入」透出）
4. 青甘行为一致性：用同一套 mock 在 node vm 里分别跑「git HEAD 旧主脚本」与「engine/*.js」，
   对比每日列表/统计 chips/全程与聚焦剖面 SVG/站点全量与去重/LOOP_BBOX/第二出发地全部状态/
   油车与 300km 续航档位——输出逐字节一致。**唯一差异**：续航规划面板的 D 前缀，
   修正了旧 dayOf 对主基准出发地多减一次接入段里程的既有 bug（详见 GAP-LIST B5 注）
5. 未执行 git 提交 ✅

### 文件清单

- `engine/route-engine.js`（516 行）：地图初始化/取景/图层/每日路线/出发地切换/侧栏折叠
- `engine/planner.js`（462 行）：续航规划/站点分级（去重/锚点/缩放分级）/规划面板
- `engine/profile.js`（326 行）：海拔剖面抽屉/拖拽/altSeries/剖面 SVG/尺寸监听
- `engine/ui.js`（75 行）：ROUTE_META 注入/能耗文案/启动序列
- `index.html`：1742 → 450 行，只剩页面外壳（DOM + Key 预检 + 数据加载器 + 按序加载 engine/*.js）
- 纯 script 标签加载，无构建工具，「改文件刷页面」回路不变

### 数据包契约终形（route-defs/<id>.js，顶层 var 全局）

```javascript
ROUTE_BUILD = {                     // 【人写输入契约，S3 起】改线路 = 改这里，然后重跑构建
  inputDatum: 'wgs84' | 'gcj02',    // 输入坐标系（页面轨迹一律 GCJ-02）
  meta: { name, title, sub, direction, evNotice, rulesClimb, rulesEnv, probe },
  waypoints: { key: { n, p, alt, d } },        // 途经点（几何人定）
  legs: [ { id, title, note, zoom, from, to, via, energy?,
            rest?, altKm?, center?,            // 休整日直给区间/中心
            core? } ],                         // core:false = 接入段（不进每日行程）
  marks: [ { n, p?, km?, alt?, pass?, lowest? } ],  // p 吸附到采样点；km 直给的原样保留
  cities / spots: [ { n, p, d } ],             // 有 cities 时城镇用 cities（文案更全）
  poiRegions: [ '行政区名', … ],               // 站点穷举清单（人工可审）
  starts: [ { id, name, sub?, leadLegId?,      // leadLegId → 构建时展开
              head?, firstDay?, lastDay? } ],
  marksIncludeWaypoints: false?               // 默认 true：核心段途经点自动补海拔标注
}

ROUTE_META = {
  key, name, title, sub,            // 标题/线路名/副标题（展示层文案全部随包）
  direction,                        // 图例主路线方向注记（缺省「沿线方向」）
  evNotice,                         // 纯电通知条；缺省 → 引擎移除该通知
  rulesClimb, rulesEnv,             // 能耗教育两段文案；缺省 → 引擎通用版（不写地名）
  probe                             // 是否探针包
  // startButtons 已废弃：出发地按钮显隐由 ROUTE_STARTS.length 决定
}

ROUTE_STARTS = [                    // 出发地列表；starts[0] = 主基准出发地（环线里程 0 点）
  { id, name, sub,                  // 切换按钮名 / 切到该出发地时的副标题
    offsetKm,                       // 接入段里程平移（主基准 = 0；中间天 altKm 由引擎 +offsetKm）
    stationKm0,                     // 行程起点在 STATION_DATA 站点里程基准上的 km
    totalKm,                        // 仅 starts[0]：环线总里程（curTotal = totalKm + offsetKm）
    head, leadPath,                 // 仅带接入段的出发地：接入端海拔点 {alt,n} / 接入轨迹
    firstDay, lastDay }             // 首末日 {title, zoom, note, energy}（km 由引擎按 CORE[0]/TAIL 推算）
]

// 几何/分段数据（verbatim 层，S1 抽出，S2 未动）：
ALT_REAL / ALT_MARKS / ALT / CORE / TAIL / CITIES / SPOTS
CLASSIC                            // 支线；含 label（图例文案随包）；空 simplified = 无支线
EXTRA_LINES                        // 固定支线（青甘包带丹霞支线原值）

STATION_DATA = {
  builtAt, source, sourceShort, totalKm,
  datumStartKm, datumEndKm,   // 站点里程基准上主出发地行程的起点/终点 km（S4 由 xnStart/xnEnd 改名）
  regions: [],      // 实际穷举的行政区清单（审计）
  truncated: [],    // 分页截断未抓全的「关键词@行政区」（如实记录，不假装抓全）
  warnings: [],     // >100km 长盲区 [{type: ev|fuel, from, to, km, label}]（体检/构建产出，引擎上图）
  ev: [], fuel: []
  // 契约语义：ev/fuel = [] 表示「该线路未接入此类站点数据」（UI 显示"未接入"，
  //   规划面板不产出结论）；与「已接入但这段真没站」（显示无桩段）严格区分。
  // 引擎不直读 datumStartKm，经 ROUTE_STARTS[].stationKm0 引用。
}

// 历史变量 LZ_XN_KM / LZ_HEAD / P_LZ_XN / TOTAL_XN 仅作为青甘包内部数据被
// ROUTE_STARTS 引用，引擎不读；FUELS / EVS（手打示例站）已全线删除。
```

### 数据段归属（S3 起）

- `build-route.js <id>` 重新生成：ROUTE_META / ALT_REAL / ALT_MARKS / ALT / TOTAL_XN / CORE / TAIL / CITIES / SPOTS / ROUTE_STARTS（全部来自 ROUTE_BUILD + 拉取数据）
- 同一次构建**原样保留**：STATION_DATA / CLASSIC / EXTRA_LINES（站点由 `build-stations.js <id>` 单独更新；支线由专项工具产出）
- `build-probe-route.js` 已退役（逻辑并入 build-route.js；OSRM 对比以 `--compare-osrm` 保留）
- 遗留：青甘包 totalKm（1882.4）与日行程合计（2163.4）差 281km 的陈旧常量仍在，S4 体检处理

## 8. S3 实测结论：构建管线参数化 + 高德数据源（2026-09-28）

### 验收结果

1. `node tools/c4-test.js` → 94 pass / 0 fail ✅（青甘数据未动，仅增量 ROUTE_BUILD）
2. `node tools/probe-check.js` → 20 pass / 0 fail ✅（川西「未接入」断言已改为断言真实数据）
3. 川西包三源全真实：轨迹（高德 v3 驾车）/ 高程（open-meteo）/ 站点（高德 POI 穷举）✅
4. 全程无 Key 泄漏：日志只显示前 4 位；grep 全仓无完整 Key；.env.local 已 gitignore ✅
5. 未执行 git 提交 ✅

### 川西重建数据摘要

- 总里程 850km（5 天）；轨迹 15356 点抽稀至每天 ≤240 点；高程 328 个采样点（无降级）
- 站点：穷举 16 行政区 × 2 类，125 请求 0 失败；原始 2050 充电 + 371 加油 → 配额后 **155 充电 + 64 加油**
- 覆盖体检：最大无桩间隔 **63.5km**（卧龙 → 四姑娘山镇，km146–209，巴朗山段）；最大无油间隔 **77.2km**（同段）；25km 网格 EV 盲区 3/35 格（无长盲区），加油长盲区 1 段（km150–200）——已如实写入 ROUTE_META.evNotice
- 22 个「关键词@行政区」组合触发分页截断（高德单区上限 200 条），如实记录在 STATION_DATA.truncated

### 数据源实测对比（轨迹）

川西线高德 vs OSRM 逐段（`--compare-osrm` 实测）：平原/高速段高度一致——
D1 +0.4km、D4 +1.3km、D5 −1.0km（同一条路）；山区段选路不同——
D2 −6.2km、D3 −9.0km（高德更短）；合计 851.8 vs 866.3km（−1.7%）。
结论：公里数级差异属正常，两条源走向一致；高德返回即 GCJ-02，
省去 WGS-84→GCJ-02 转换误差（探针期的转换算法已退役）。

| 维度 | 高德（默认源） | 腾讯（保留路径，无 Key 未验证） | OSRM（仅对比用） |
| ---- | ---- | ---- | ---- |
| 轨迹 | v3 驾车，GCJ-02 原生，途经点拆子段拼接 | v1 驾车，差分 polyline（青甘在用） | WGS-84，需自转 GCJ-02 |
| POI | place/text，city+citylimit 行政区穷举；type 分类干净（011100 充电站） | region() 只覆盖建成区，依赖本地代理（换环境不成立） | 无 |
| 字段 | name/location/address/tel/type（品牌可直接用） | title/location/address/tel/category（品牌靠标题白名单猜） | — |
| 限制 | 单区分页上限 200（截断已如实记录） | 需 WorkBuddy 代理 + 代理 secret | 无私家/山区选路偏差 |

### Key 管理规矩

- **存放**：仓库根 `.env.local`（gitignore 已覆盖；文件权限 600）；或环境变量 `AMAP_WEB_SERVICE_KEY`
- **读取**：`tools/lib/build-lib.js` 的 `loadAmapKey()` 是唯一入口（env 优先，.env.local 兜底）
- **脱敏**：日志只显示前 4 位（`maskKey`）；API 报错只含 infocode/info，不回显 Key；禁止打印含 Key 的完整 URL
- 腾讯保留路径的代理 secret 不再硬编码（旧 build-stations.js 曾内联 WorkBuddy secret），改从 `TMAP_SECRET`/`TMAP_PORT` 环境变量读

### 环境备注

- 本机默认 DNS 把 restapi.amap.com 污染到 0.0.0.0；build-lib 自动检测并切阿里 DoH（223.5.5.5）解析，日志可见 `via: alidns-doh`

## 10. S4 实测结论：体检 V1–V4 + 可信度透出（2026-09-28）

### 验收结果

1. `node tools/validate.js qinghai-gansu` / `chuanxi` → 均 PASS（warnings-only，退出码 0）✅
2. `node tools/c4-test.js` → 94 pass / 0 fail；`node tools/probe-check.js` → 20 pass / 0 fail ✅
   （c4-test 一条断言随全长规划修复合理放宽：300km 续航遇 >210km 真实站距时段会
   如实报「无可达」并停止数站，「次数更少 + 不可达警告」是正确行为）
3. 青甘页面总里程显示 2164（日合计口径，本就对）+ 续航规划从此覆盖全程 ✅；
   川西页面无 >100km 长盲区（最大 63.5km），evNotice 已标注 ✅
4. `grep -ri 'qinghai|青甘|兰州|西宁|塔尔寺|拉脊山' engine/` → 无匹配 ✅；无 Key 泄漏 ✅
5. 未执行 git 提交 ✅

### 两线体检明细（validate.js 实测）

**青甘（qinghai-gansu）**：V1 无尖峰（661 采样点干净）；V2 三条充电长盲区
km601.7–713.2（111.5km，德令哈—大柴旦）、km967.4–1167.3（**199.9km**，大柴旦—敦煌）、
km1957.1–2100.6（143.5km，祁连回程）——已写入 STATION_DATA.warnings 并上图；
V3 475 站点重投影全部 ≤5km；V4 在修正前 B 项 FAIL（TOTAL_XN 1882.4 vs ΣapiKm 2166.2）。

**川西（chuanxi）**：V1 发现 **10 处高程尖峰**（DEM 噪声，如 km190.69 的 4680m 假峰，
中值 3886m）→ `--fix` 中值滤波修复（与引擎运行时去噪同一规则，页面显示不变）；
另有 12 个持续陡坡点（>120 m/km 非单点尖峰，按真实地形保留并警告）。
V2 无 >100km 长盲区（最大 63.5km 已在 evNotice）；V3 全部 ≤5km；V4 全过。

### 青甘 281km 的处理方式（有意行为修正，留痕）

- `TOTAL_XN` 1882.4 → **2166.2**（= ΣapiKm，与 STATION_DATA.datumEndKm 精确一致）。
  旧值是漏了末段 ~281km 的陈旧常量（PROJECT.md 早有成因记录）。影响：西宁版
  续航规划原截断在 km1882、末段约 40 个站点被 datum 过滤——修正后规划覆盖全程
  （vm 实测：西宁版 5→**11 次**充电，兰州版 1→**12 次**）。
- 连带挖出第二个真 bug：规划循环 guard 固定 80 次，站点多的长线未遍历完就被截断
  （兰州版被截成「全程只需充电 1 次」）。guard 改为 `stops.length*2+50`。
- 这两处都是「数字从错误变正确」，侧栏/逐日列表/剖面等显示不变（chipKm 本就走日合计）。

### 可信度透出的 UI 落点（全部读数据包字段，引擎零硬编码）

| 透出 | 数据字段 | 代码位置 |
| ---- | ---- | ---- |
| 长盲区上图（>100km 无站段折线染色 + 「km382–493 无快充（111.5km）」标注，切换出发地自动换算） | STATION_DATA.warnings | engine/route-engine.js `renderWarnings()`（renderAll 内调用） |
| 站点来源日期（信息窗「腾讯地图 POI · 2026-09-26」） | STATION_DATA.sourceShort/builtAt | engine/planner.js `stationSourceNote()`（三类站点信息窗统一拼接） |
| 侧栏底部快照声明（「站点为 YYYY-MM-DD 时点快照，出行前请用地图 App 复核营业状态」） | STATION_DATA.builtAt | engine/ui.js `applyDataCaveat()` + index.html `#dataCaveat` |
| 截断透出（「其中 N 个城区数据量大被截断，城郊可能不全」） | STATION_DATA.truncated | 同上 |

### 顺延小项

- `STATION_DATA.xnStart/xnEnd` → **`datumStartKm/datumEndKm`**：构建侧
  （build-stations.js、apply-real-route.js）、routes/ 产物（stations-data.js、
  stations-new.json、build-stations*.html）、两个线路包、docs 全部连带改完；
  validate.js 保留对旧字段的读取兜底（老包兼容）。引擎侧本就走 stationKm0，未动。

### 工具链

- 新增 `tools/validate.js <routeId> [--fix]`：V1–V4 体检；--fix 应用 V1 中值滤波并写回
  warnings/datum 字段；FAIL 退出码 1，warnings-only 退出码 0。
- `tools/lib/build-lib.js` 新增 `buildProjection()`（站点投影主线，build-stations 与
  validate 共用同一口径）与 `longBlindWarnings()`（长盲区计算，构建/体检/引擎三方同一份）。
- build-stations.js 重构为共用 buildProjection，并在产出的 STATION_DATA 中带 warnings。

## 11. S5：页面内编辑模式（overlay 架构，2026-09-28）

### 验收结果

1. probe-check 新增 7 条编辑模式断言（默认关闭→改标题生效→写入 localStorage→
   刷新仍生效→地名可改→分段可改→恢复原始），**27 pass / 0 fail** ✅
2. `node tools/c4-test.js` → 94 pass / 0 fail（非编辑状态行为零变化）✅
3. 非编辑用户：页面只有「✏️ 编辑模式」一个入口按钮，无任何编辑痕迹（无下划线/下拉/工具条）✅
4. 无 Key 泄漏；未执行 git 提交 ✅

### 操作说明（写给使用者）

1. 点侧栏下方「✏️ 编辑模式」进入。会看到黄色提示条、文字下出现虚线。
2. **改文字**：直接点某天的标题、备注（或副标题、顶部纯电提示条），弹出输入框，
   改完即生效。「＋住宿 ✎」可设置当天的住宿点，会显示在备注行（`· 住XX`）。
3. **改分段**：编辑模式下每天出现两个下拉框（起点 → 终点），选项是沿线的地名。
   选一个边界，那天的里程区间和地图轨迹立刻重切。
4. **改地名显示名**：点开底部海拔剖面（点某一天看得更全），点图上的地名文字即可改。
5. **导出自己的版本**：编辑条里「导出编辑层」会下载 `route-<线路>.custom.json`
   （文件头有说明）。换电脑/换浏览器后把内容存进 localStorage 对应键即可恢复。
6. **恢复原始数据**：「恢复原始数据」一键清空本机全部改动。
7. **想改路线本身（加/减途经点）**：下拉里选「＋新增途经点…」会提示——
   这属于改几何，需要重新构建：编辑线路包里的 ROUTE_BUILD 后运行
   `node tools/build-route.js <线路id>`。

改动只存在你自己的浏览器里（localStorage，按线路隔离），不影响线路包文件，
别人打开页面看到的仍是原始数据。下次对这条线跑构建也不会冲掉你的改动。

### 实现要点（给维护者）

- **文件**：`engine/edit.js`（约 330 行，独立文件）；index.html 加载顺序
  route-engine → planner → profile → **edit** → ui（合并须在启动渲染前完成）。
  测试加载链自动跟随 index.html 的 script 标签，新增引擎文件无需改测试工具。
- **overlay 存储格式**（localStorage 键 `xianlumap.overlay.<routeId>`）：

```javascript
{
  "days": { "2": { "title": "…", "note": "…", "stay": "…" } },  // 按天 id
  "seg":  { "2": { "fromKm": 250, "toKm": 320 } },  // 环线基准 km（主出发地口径）
  "marks": { "折多山垭口": "折多山口" },              // 显示名：原始名 → 新名
  "meta": { "sub": "…", "evNotice": "…" }            // 仅展示层文案
}
```

- **合并与恢复**：启动时 edit.js 在 ui.js 之前把 overlay 合并进 CORE/TAIL/ALT_MARKS/
  ROUTE_META；pristine 快照（深拷贝）用于「恢复原始数据」就地写回。
  分段重切用包内原始环线 km→经纬度基准表（ALT_MARKS 提供边界候选，km 直存，
  地名日后改名/改文案不影响）；爬升/极值按高程序列重算，能耗文案不重写。
- **边界**：只动展示层数据，绝不写 ROUTE_BUILD；`tools/validate.js` 对 overlay
  无感知是刻意的——体检针对包内固化数据，编辑层不参与构建链路。
- **双出发地**：进入编辑模式自动切回主出发地视角（分段编辑基于环线里程 0 点），
  兰州版的首末日是接入段拼接天，其分段改动经 CORE[0]/TAIL 基础对象自然带入。
