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
- S6（川西小环线全量复验，PLATFORM.md A1–A6）已完成并验收 ✅（见 §12）
- S7（318 川藏南线，不闭合单线边界压测）已完成并验收 ✅（见 §13）
- S8（多线路入口：选线器 + 按需加载 + 导入编辑层）已完成并验收 ✅（见 §14）
- **平台化 S0–S8 全部完成** 🎓
- S9（底图迁移腾讯 GL JS → 高德 JS API v2，Key 本地化注入）已完成并验收 ✅（见 §15）
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
| **S6** ✅ | 川西小环线全量复验（重建 + A1–A6 实测） | PLATFORM.md A1–A6 全达标 |
| **S7** ✅ | 318 川藏南线（不闭合单线：2100km、海拔 500–5000m、无人区更多） | A1–A6 全达标；单线契约影响最小化（1 处引擎改动，见 §13） |
| **S8** ✅ | 多线路入口（选线器 + 按需加载 + 导入编辑层） | 打开页面选线，各自独立加载 |

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
- **双出发地**：编辑模式不再切视角（体验修复 1，见 §16）——文字类编辑在任意视角可用；
  分段编辑仅主出发地视角开放，其他视角界面明示「请切回 XX 视角」、API 显式拒绝。

## 12. S6 实测结论：川西小环线全量复验（PLATFORM.md A1–A6，2026-09-28）

### A1–A6 实测结果表

| # | 指标 | 目标 | 实测 | 结论 |
| --- | ---- | ---- | ---- | ---- |
| A1 | 引擎改动量 | 加/复验一条线，`engine/` 改动 **0 行** | 全量重建川西全程 `git diff --stat -- engine/` 为空 | ✅ |
| A2 | 数据文件 | 只新增/改动 2 个数据文件（route-defs 包） | 仅 `route-defs/chuanxi.js` 一个文件变动（另含构建工具自身的提速改动，见下） | ✅ |
| A3 | 构建时长 | 单线全量 < 5 分钟 | build-route 51s + build-stations 3m36s = **4分27秒** | ✅（优化后，见下） |
| A4 | 首屏可用 | < 2 秒（含按需加载） | 数据链（外壳 27KB + 引擎 95KB + 包 95~218KB）本地 http.server curl 串行 ≈ **8ms 级** | ✅（口径见下） |
| A5 | 回归测试 | 对任意线路包跑 | `c4-test.js [routeId]` 参数化，缺省轮跑全部包：**188 pass / 0 fail = 2 包 × 94 项** | ✅ |
| A6 | 新线体检 | V1–V4 全过或有标注 | `validate.js` 两线 PASS（川西 2 warnings / 青甘 4 warnings，全部为「持续陡坡/长盲区如实列出」类标注） | ✅ |

### A3 优化记录（诚实交代数字怎么降下来的）

原始串行实现实测 6分35秒（超预算）。瓶颈单测：高德单请求 ~3.2s 是服务器延迟，
Key 有 CUQPS 并发上限（实测 6 并发即触发 infocode=10021）。两项改动：

- 翻页 3 路并发（页间独立，批间 500ms 礼让）；两类关键词（充电/加油）双路并发——
  峰值并发 ≤4，实测 0 失败；CUQPS（10021）/QPS（10004/10044）统一进退避重试
- 顺带修了写回日志引用已删变量的崩溃（写回本身成功，日志行抛错）

### A4 测量口径

本地 `python3 -m http.server` + curl 逐资源计时，**无地图 Key**——底图瓦片不出，
但数据链（页面外壳 → engine/*.js 5 个 → route-defs/<id>.js 包）可精确计时：
单线合计传输 ~120-340KB 未压缩、串行总时间个位数毫秒；即使加 parse/渲染也远在 2s 内。
真实网络下底图瓦片（腾讯 CDN）另计且需 Key。

### 重建差异分析（S3 产物 vs 本次全量重建）

- **轨迹/分段/标注/元信息：逐字节一致**（5 天 altKm/path/apiKm、ALT_MARKS、ROUTE_META、
  ROUTE_BUILD 全部相同；高德路由与 open-meteo 采样位置完全复现）
- **ALT_REAL：328 点中 10 点值不同**（最大 794m @km190.69 巴朗山隧道口）——
  同一轨迹、同一采样点，open-meteo DEM 网格响应值本身在两次请求间不同；
  均按 V1 规则 `--fix` 中值滤波（这批点是系统性 DEM 噪声，会随每次重建复发，
  `build → validate --fix` 是既定流程）
- **站点：三轮重建（串行/并发翻页/双路并发）最终结果完全一致**（155 充电 + 64 加油，
  覆盖体检同口径：最大无桩 63.5km、截断清单相同）——构建可复现

### S5 overlay 兼容性结论

重建后 altKm tiling **逐字节稳定**（D1 [0,211.58] … D5 [614.64,850.05]、TOTAL_XN 850 不变）。
vm 实测：旧 overlay（seg D2 [250,320] + 标题 + 地名改名）在新包上全部照常生效——
S5 注意事项 1 的假设成立：**环线结构不变，overlay 的 seg km 就持续有效**。

### c4-test 参数化说明（A5 主要工程）

- 期望数值全部按包推导：天数（CORE+1）、行程日数、第二出发地（包内 ROUTE_STARTS[1]）、
  站点是否接入；青甘专属语义（兰州/2604km/D10/≥10 天）全部泛化
- 单出发地线路用等数量替代断言（不渲染按钮 / setStart 幂等 / 末天聚焦）；
  【12】【13】从「青甘遗留构建 HTML」改为检查参数化后的 tools/ 构建链
  （配额/覆盖体检/投影消费包内轨迹/行政区清单随包/双 POI 源/品牌白名单）
- 仓库级检查（CSS 层级/Key 预检等）每条线路运行时各计一次，保证每包恒 94 项

### S7（318 川藏南线）开工前需要准备的输入

- **途经点清单：仓库里还没有**。318 是「单线不闭合」结构（成都→拉萨 ~2100km），
  需要人定 25–35 个途经点（geometry 人定原则）写进 ROUTE_BUILD.waypoints；
  参考候选：成都-雅安-康定-新都桥-理塘-巴塘-芒康-左贡-八宿-然乌-波密-林芝-工布江达-松多-拉萨
- 分段初稿（days）与地名标注可 LLM 生成初稿、人审改（EXECUTION §5.3 既定分工）；
  文案（energy 模板）会自动生成，不必手写
- poiRegions 行政区清单：按 318 折线包围盒人工可审（四川甘孜/西藏昌都-林芝-拉萨沿线）
- 海拔跨度 500–5000m + 无人区段更多：validate 的 V1/V2 会更有戏，长盲区透出是卖点

## 13. S7 实测结论：318 川藏南线——不闭合单线的边界压测（2026-09-28）

### A1–A6 实测结果表

| # | 指标 | 目标 | 实测 | 结论 |
| --- | ---- | ---- | ---- | ---- |
| A1 | 引擎改动量 | 0 行（破了要交代） | **6 行（1 处缺陷修复，见下）** | ⚠️→✅ 已论证最小化 |
| A2 | 数据文件 | 只新增 route-defs 一个包 | 仅 `route-defs/chengdu-lhasa-318.js`（新建） | ✅ |
| A3 | 构建时长 | < 5 分钟 | build-route 1m45 + build-stations 1m20 = **3分05秒** | ✅（两阶段并发重写后） |
| A4 | 首屏可用 | < 2 秒 | 数据链（包 74KB）同 §12 口径，毫秒级 | ✅ |
| A5 | 回归测试 | 自动纳入新包 | `c4-test.js` 零改动自动轮跑：**282 pass / 0 fail = 3 包 × 94 项** | ✅ |
| A6 | 新线体检 | V1–V4 全过或有标注 | `validate.js chengdu-lhasa-318` PASS（8 warnings，全部为长盲区/持续陡坡如实标注） | ✅ |

### 环线假设试跑结论（小步验证记录）

先用 2 段（成都→雅安→泸定、泸定→康定）试跑，逐项验证不闭合单线的结构假设：

- **legs 拼接 / altKm tiling / 接缝去重：全部正确**——D1 [0,236.51]、D2 [236.52,288.22] 连续；
  段间接缝亚米级（D1 末点 ≈ D2 首点），线首成都、线末康定**不闭合**，全程无环路假设残留
- **build-route 通用性**：零改动吃下不闭合单线（`core.concat([TAIL])`、首末异点、
  ROUTE_STARTS 单出发地均无特殊处理）；`--compare-osrm` 逐段对比：合计 2456.8 vs 2481.8km
  （−1.0%），D4 巴塘—左贡差 +59.7km（OSRM 走觉巴山老路，高德走隧道，选路差异正常）

### 发现并修复的唯一引擎缺陷（A1 破例说明）

**`LOOP_BBOX` 只吃 CORE 不吃 TAIL**：环线时代 TAIL 回到起点附近，CORE 包围盒天然含全程；
不闭合单线的末段伸出 CORE 范围——318 实测拉萨在 CORE-only 包围盒外 **309km**，
fitAll 会把终点裁出视野。最小修复：`engine/route-engine.js` 1 处
（`CORE.forEach(eatBox)` → `CORE.concat([TAIL]).forEach(eatBox)`，+6 −2 行含注释）。
**对既有线路零行为变化**（实测：两条环线 bbox 增量 <0.001°，zoom 均被 7.6 上限钳住）。

### 单线对引擎的契约影响结论

除上述包围盒外，**零影响**：buildDays / altSeries / 站点 datum / warnings 端部盲区 /
续航规划 / 编辑模式分段重切，全部天然兼容不闭合单线。平台的「主折线 + 分段」抽象
被第三条线验证为形状正确——环线只是单线的特例（首尾同点）。

### 318 数据摘要

- **总里程 2404.7km**（轨迹线累计口径；路网里程 2456.8km），8 天，轨迹 38811 点，
  高程 875 采样（open-meteo 分钟限额已用「整分钟等待」策略兜住，无降级）
- 海拔跨度 442–4994m（DEM 采样；标注最高点东达山 5130m 标称）——翻 14 座 4000m 级山口
- 站点：22 行政区穷举（清单按折线包围盒列出、人工可审），134 请求 0 失败，
  配额后 **225 充电 + 105 加油**；**最大无桩段 203.8km（工布江达→拉萨，km2180–2383，
  米拉山前后）**，100km 级以上无加油站 5 段——全部上图 + evNotice 如实标注（无人区压测点如期出现）
- V1 高程尖峰 10 处已 `--fix`（横断山 DEM 噪声，同川西，属系统性）

### A3 提速记录（第二次：318 站点请求量 ≈ 川西，但仍是主要耗时）

S6 的翻页并发对 318 不够：region 内的第 1 页仍是串行 await，实测 5m38s 超预算。
改为**两阶段全并发**（阶段 1 全部区县的第 1 页过闸门并发拿 count；阶段 2 全部后续页
一次性过闸门并发，峰值并发由闸门压在 4），build-stations 4m+ → **1m20s**。
配套修复：keep-alive 连接复用 + 超时退避重试（僵死连接会毒化连接池）、
CUPS/QPS 错误码（10021/10004/10044）统一退避。
**复现性说明**：同一原始集合下结果完全确定（去重键改全精度 + 配额/补洞排序加确定性
tiebreaker）；跨次运行仍有 ±1-2 站的源端波动——高德 POI 索引本身分钟级变动所致，
非本地管线不确定性（四轮重建原始计数 1956/1957/1962/1964 即为证据）。

### V4 口径修正（318 逼出来的）

318 的 TOTAL_XN（轨迹线累计 2404.7）与 ΣapiKm（路网里程 2456.8）差 2.1%，
超过原 2% 容差——根因是**折线弦长累计对路网里程的系统性低估**（随线路变长、
弯道增多而放大；川西 0.2%、青甘 0.1% 时没暴露）。validate.js V4 改为按口径分别核对：
A 日合计 vs TOTAL_XN（同口径，取整差）；B TOTAL_XN vs ΣapiKm（跨口径，容差 3%，
抓陈旧常量的初衷不变——青甘当年差 13%）；C/D 站点表 apiKm 投影口径不变。

### S8（多线路入口）前注意事项

1. 三条包合计 ~390KB：现在 `index.html` 仍全量加载默认包（青甘 218KB）——选线器 +
   按需加载是 S8 的正题，loader 的 `document.write` 机制已支持 `?route=`，入口 UI 只差一层壳
2. 编辑模式 overlay 的 localStorage 键按 routeId 隔离 ✓，多线共存无冲突
3. probe-check 的标题断言按「川西/青甘」写的，S8 加选线器时若改默认线要同步
4. 构建管线已三线路通用：S8 之后新线 = 一个 ROUTE_BUILD + 两条命令 + validate

## 14. S8 实测结论：多线路入口——选线器 + 按需加载 + 导入编辑层（2026-09-28）

### 验收结果

1. `node tools/c4-test.js` → **282 pass / 0 fail（3 包 × 94）**；`route-defs/manifest.js`
   含 ROUTE_BUILD 过滤机制，**未被当成线路包轮跑**；新增「manifest 与包一致」交叉断言
   （name/totalKm/days/updatedAt/probe 逐项比对，防清单漂移）✅
2. `node tools/probe-check.js` → **33 pass / 0 fail**（新增选线器/导入 6 项）✅
3. 选线器页只加载 manifest（1.4KB）+ picker.js（3.8KB），**不加载任何线路包/引擎/底图**；
   vm 级断言 + http.server 资源冒烟双验证 ✅
4. 导入：导出（含 route 标记）→ 改 → 导入 → overlay 生效并落盘；线路不匹配如实拒绝——
   vm 级全链路验证 ✅
5. 三条线 `?route=` 正常（282 项回归即覆盖）；无 Key 泄漏；未执行 git 提交 ✅

### 实现要点

- **`route-defs/manifest.js`**：轻量登记清单（id/name/region/totalKm/days/updatedAt/probe）。
  选线器卡片数据源；**不是线路包**（无 ROUTE_BUILD），c4-test 按「含 ROUTE_BUILD」过滤轮跑名单。
- **loader（index.html）**：`?route=<id>` 且 id 已登记 → document.write 只写该线路包 +
  底图 SDK + 5 个引擎；无参数或 id 未登记 → 只写 picker.js（未登记 id 自动回选线器，
  不产生半加载状态）。引擎标签从静态改为按需，c4-test/probe-check 的加载链正则同步
  升级（兼容 `document.write` 的 `<\/script>` 转义、只认真实文件名避开模板串）。
- **`engine/picker.js`**：只在无参数页运行（线路页/测试 vm 里安全 no-op），自包含样式，
  卡片为 `<a href="?route=id">` 纯链接。
- **导入编辑层（edit.js）**：「导入编辑层」与导出/恢复并列；file input 读文件 →
  剥 `//` 文件头 → JSON.parse → `Edit.importOverlay(obj)` 校验（route 标记存在且
  与当前线路一致，不匹配明确拒绝）→ 复用启动合并同一 `applyOverlay` 函数应用 →
  存 localStorage。导出格式增加 `"route"` 字段（旧版导出无此字段会被拒绝并提示重导出）。
- **顺手修了一个潜伏 bug**：地图 Key 预检在 head 解析早期扫描 script 标签，
  **永远在 gljs 标签写入之前执行**（原实现等于没检）；扫描推迟到 DOMContentLoaded
  后真正生效，且选线器页（无 ?route=）整段跳过。

### 平台化收官状态（S0–S8）

三条线（环线双出发地 / 环线 / 不闭合单线）共用一套引擎与构建管线；加线 = 一个
ROUTE_BUILD + 两条构建命令 + validate + manifest 一行；回归与冒烟全自动。
剩余已知边界：底图需自配腾讯 Key（无 Key 时页面给出可操作指引，数据链完整可用）；
充电枪数无开放数据源（已降级）；高德 POI 单区 200 条分页上限（截断如实透出）。

## 15. S9 实测结论：底图迁移 TMap → 高德 JS API v2（2026-09-28）

> 平台化收官后的最后一块拼图：用户只要配一个高德浏览器端 Key 就能完整体验产品。

### 验收结果

1. `node tools/c4-test.js` → **282 pass / 0 fail**；`node tools/probe-check.js` → **33 pass / 0 fail**
   （数量不变；TMap mock 全面换为 AMap mock，断言语义对齐行为而非厂商）✅
2. `tools/make-key-local.js` 生成 key.local.js 后，headless Chrome 真实渲染冒烟：
   - 选线器页：三张线路卡片正常（不加载地图/线路包）✅
   - `?route=chengdu-lhasa-318`：高德底图 + 8 天轨迹 + 站点分级 + 必充站 + 长盲区标注
     （km2180–2383 无快充 203.7km 等）全部渲染 ✅
   - `?route=qinghai-gansu`：环线全览取景、西宁/兰州双出发地按钮、经典线图例、
     km747–947 无快充（199.9km）盲区染色 + 标注 ✅
3. 全仓 Key 泄漏扫描：两把高德浏览器端 Key 仅存在于 `.env.local` / `key.local.js`
   （均已 gitignore）；腾讯旧 Key/代理残留零命中 ✅
4. 未执行 git 提交 ✅

### 改动结构

- **`engine/map-adapter.js`（新）**：高德原语 → 引擎惯用 layer 接口（setMap/on，
  点击回调保持 `{geometry:{id}}` 形状）。厂商差异在适配层吸收并注释留痕：
  坐标序（数据 [lat,lng] → LngLat(lng,lat)）、borderWeight/borderColor、showDir、
  strokeDasharray、AMap.Text 默认白底需显式透明、setZoomAndCenter 对应 easeTo。
  **两家同为 GCJ-02，所有线路数据零改动**（三条线 route-defs 文件未动）。
- **`engine/boot-route.js`（新）**：线路页加载序——key.local.js → 安全密钥注入
  （`window._AMapSecurityConfig`）→ 高德 SDK v2 → 线路包 → 引擎。无 Key 时全跳过，
  页面只显示引导遮罩，不产生半加载状态。
- **`index.html`**：删除 WorkBuddy 腾讯密钥代理块（S9 起由 key.local.js 取代）；
  Key 预检改为读 `__KEY_LOCAL__.amapKey`（顺带修复了预检永远在标签写入前扫描的
  潜伏 bug 的剩余部分——现在数据源是 key.local.js，DOMContentLoaded 时必然已加载）；
  引导文案改为高德申请指引。
- **route-engine.js / planner.js**：图层构造全面换适配层；easeTo→setZoomAndCenter；
  缩放事件 zoom/idle → zoomchange/moveend（引擎自带防抖逻辑不变）。
- **c4-test / probe-check**：AMap mock（单实例 opts 记录）；「paths 字段」「borderWidth
  整数」等厂商形状断言对齐高德（path/borderWeight）；加载链解析升级——loader 只引用
  boot-route.js，引擎清单在 boot-route.js 内部，测试按页面执行顺序展开拼接。
- **`tools/make-key-local.js`（新）**：从 `.env.local` 生成 key.local.js（日志脱敏）；
  `.gitignore` 新增 `key.local.js`。

### 数据史说明（不造假）

青甘 `STATION_DATA.sourceShort` 仍标「腾讯地图 POI · 2026-09-26」——那是该线站点数据的
真实来源（腾讯时期抓取固化），底图换高德不影响数据来源事实，信息窗的来源+日期透出保持原样。

### 部署到 GitHub Pages 的 Key 处理建议

浏览器端 Key 运行时必然公开（JS 地图厂商的常态），防护靠**高德控制台的域名白名单**：
1. 控制台给 Key 配白名单 = 你的 Pages 域名（如 `xxx.github.io`），本地开发另加 `localhost`
2. 部署环境没有 `.env.local` 这一步——Pages 上直接手写一份 `key.local.js` 放进仓库？
   **不要**：那份文件会带着 Key 进 git。两个合规选项：
   - 推荐：Pages 部署后用 CI（GitHub Actions）在构建步骤从 Secrets 生成 `key.local.js`
     （Secret 存高德 Key，仓库历史依然干净）
   - 或：该 Key 是白名单限域的公开 Key，接受它出现在仓库里（高德官方对 Web 端 Key 的
     默认用法就是白名单防护，很多开源项目直接提交）——团队自己拍板，本仓库选择不提交

## 16. 体验修复（2026-09-28，三条真实用户反馈）

### 反馈 1（bug）：编辑模式 × 兰州出发——「似乎进入不了编辑模式」

**根因**：S5 的实现是进入编辑模式时**静默切回主出发地视角**（分段编辑依赖环线里程 0 点
基准），用户在兰州视角下点编辑，界面被悄悄切走，感知为「坏了」。

**修法**：
- 删掉静默切换。文字类编辑（天标题/备注/住宿/地名显示名/副标题/纯电提示）在任意
  出发地视角都可用——`setDayField` 现在同时写基础对象和当前视角 DAYS 的活副本
  （接入段出发地的 DAYS 是 buildDays 的拼接副本，只写基础对象不会立即生效）
- 分段编辑保持真实限制（接入段拼接天的 km 基准不同），但**明示而非静默**：非主视角下
  分段位置显示一行提示「兰州视角下不可调整分段，请切回西宁视角」（出发地名从
  ROUTE_STARTS 数据驱动，引擎无硬编码）；`Edit.setSeg` 在其他视角显式拒绝并返回 false
- 编辑中切换出发地时，分段控件随视角重建（setStart → refreshDayControls 挂钩）

**验证**：probe-check【5】7 项断言（lz 视角进入编辑/改标题生效/分段被拒且数据不变/
提示文案含两个出发地名/切回主视角分段恢复可用）全绿。

### 反馈 2（UX）：途经点增删操作不明——只有一句提示

**修法**：「＋新增途经点…」改为三步可见引导（`Edit.showWaypointGuide` 弹层）：
① 写明途经点存在哪（`route-defs/<id>.js` 的 `ROUTE_BUILD.waypoints`，字段含义）；
② 「复制当前途经点清单」按钮——`waypointsExportText()` 导出 JSON，剪贴板写入
（clipboard API + execCommand 双通道兜底），用户改完直接粘回；
③ 按当前 routeId 生成确切命令：`node tools/build-route.js <id>`（+ 站点变了再跑
build-stations/validate 的完整链路）。「改几何必须重建」的产品铁律保持诚实，
但操作路径一步不错。

**验证**：probe-check 断言（导出 JSON 可解析且含全部途经点 / 引导含按线路生成的命令）。

### 反馈 3（设计）：地图标签没有主次——全平铺

**修法**：标签三级体系（map-adapter 增加 badge/halo/zIndex 样式能力）：
- **景点 SPOTS = 最高层级**：13px 粗体 + 白底紫边胶囊 + zIndex 130，默认显示
  （由原「默认隐藏」升级为最高优先——数量少、信息密度高，配得上主表达）
- **城镇 CITIES = 中层级**：12px 标准标注，zIndex 120
- **站点 = 图标即主表达**：站名文字只在近景（z≥10）出现（`NEAR_LABEL_Z`，与 S0
  的 near 档协同、复用其防抖重绘链，不另起一套逻辑）；10px + 白色描边 + 截断 10 字，
  zIndex 110 压在景点/城镇之下；跟随各自图层开关

**验证**：headless Chrome 三档截图对比（青甘线）：
- `?z=5.5`：站点只有图标，胶囊景点标注清晰，无站名拥挤（/tmp/tier-z5.5.png）
- `?z=7.3`（默认全览）：城镇名 + 景点胶囊 + 盲区标注，站点仍无文字（/tmp/tier-z7.png）
- `?z=11`：近景站名全出（白描边压底图），细节可查（/tmp/tier-z11.png）
（`?z=` 为 ui.js 新增的调试钩子，供层级验收与后续截图用）

### 回归

`c4-test` 282/0（新增「标签层级」断言替换原纯数学断言，总数不变）；`probe-check`
40/0。三条线 vm 级全绿；headless Chrome 青甘/318 冒烟通过。

## 17. S10：全站共享数据库——厂商中立坐标策略（2026-09-28）

### 设计决策（已拍板，照此实现）

- **库内坐标唯一基准 = WGS-84**（≈CGCS2000，米级等价），不存 GCJ-02 作为唯一值
- 每条记录同时保留：`lat/lng`（WGS-84 基准）+ `srcCoord:{lat,lng,sys:'gcj02'}`（原始抓取值）
  + `sources[]`（vendor / sourceId / fetchedAt / routeId，跨厂商合并保留全部来源）
- 边界转换：**入库时 GCJ-02→WGS-84；物化线路包时 WGS-84→GCJ-02**（页面渲染零改动，
  三条线 route-defs 几何数据一个没动）。转换用 build-lib 的公开算法实现
  （transformLat/transformLng 多项式逼近，注释注明来源；gcj2wgs 为迭代逼近）
- 字段语义自定义（name/type[ev|fuel]/brand/address/kind/tel…），不抄厂商结构

### 库文件（data/db/，进 git，数据即资产）

| 文件 | 规模 | 内容 |
| ---- | ---- | ---- |
| stations.json | **950 站**（ev 605 / fuel 341；来源记录 tencent 471 / amap 540；跨线合并 74 组） | 站点 + WGS 基准 + GCJ 原值 + 全量来源 |
| spots.json | 81 条（城镇 53 / 景点 28） | CITIES/SPOTS 同款；`autoCaptured:false` 预留「抓的候选 vs 人审入库」区分 |
| regions.json | 91 个行政区 | 名字 + 用途 + 来源线（usedBy） |

种子迁移：`node tools/db-seed.js`（一次性留档）——从三个线路包 STATION_DATA 反向入库，
GCJ→WGS 转回基准值，vendor 按包内 source 标注（青甘=tencent，川西/318=amap）。

### build-stations 查库优先（S10 改造）

流程：包围盒+35km 走廊线性粗筛（WGS→GCJ 投影，与 API 数据同口径）→ 类型级新鲜度
闸门（走廊内新鲜候选 ≥ ev 120 / fuel 60 则该类型跳过 API；`--refresh` 可强制全抓）
→ 未达阈值的走原高德穷举并把 35km 内结果**入库去重合并** → 配额/覆盖体检/物化不变。

**川西重跑实测**：库命中 218/218（100%），**API 请求 0 次**，构建耗时 **0.04s**
（S7 优化后仍需 1m20s）。产物对账：fuel 64/64 逐站一致；ev 154/155（差异 1 站，
原因：同名同址的国家电网站被川西班与 318 两次抓取合并为一条规范记录后，25km 桶配额
选型变化——属「同一物理站去重」的规范集差异，坐标往返 0.000m、覆盖口径逐字节一致）。
**坐标往返精度实测**：36 站抽样 GCJ→WGS→GCJ 最大偏差 **0.0044m**（断言阈值 2m）。

### 同站判定的实战教训（两次修正，probe-check 留证）

初版「50m + 归一名互含」误并了三个真实案例：① 同名链不同门店（享悦充电的三个民宿店，
48m）；② 高德把不同门店坐标打到同一点（乐来电两民宿 0m）；③ 两次构建命名差
（国网「…城市」vs「…城市公共充电站」，同站应并）。终版规则：
**全名同 → 50m；归一同（剥括号）→ 30m 且括号内容相似（互含或公共前缀≥4 字）**。
案例②与③只差在括号内容是否相似——判定从「距离+名称」细化为「距离+名称+括号内容」。

### 刷新节奏与 validate 联动

- 新鲜度 90 天（FRESH_DAYS）：`fetchedAt` 超期的类型自动回退 API 检索并回写库
- 建议每季度：`build-stations <线>`（自动只抓过期类型）→ `validate <线> --fix`
- validate 的 V2/V3 对库物化同样适用（物化产物与 API 产物同形同口径）

### 与「半自动景点库」的后续流程

spots.json 的 `autoCaptured` 字段是开关：后续接入「地图抓候选 → 人审入库」时，
候选记 `autoCaptured:true, status:'candidate'`，人审通过改 `status:'approved'`；
build-route 物化 CITIES/SPOTS 时改为「库导出 + 包内覆盖」双通道（现阶段仍读包内数据）。

### 下一步衔接：自定义线路 / 云端构建服务（已拍板方向）

这个库就是云端构建服务的**数据底座**：
1. **新线零抓取冷启动**：候选 = 库内走廊站点（任何线路来源）+ API 补缺——本次实现的
   候选筛选已经是线路无关的，新线首次构建即可「带嫁妆」起步
2. **去重/合并逻辑已在库层**（db-lib.js），云端化时整体搬移，语义不变
3. **90 天新鲜度 + sources 审计**给了增量刷新与计费的天然口径（按 vendor 统计调用）
4. spots/regions 同库后，「加线」的人工输入只剩途经点清单（几何人定）与分段审改

## 18. 部署与云端构建（2026-09-28，S11）

### 分层架构决策：展示层 Pages + 构建层 Actions + 后期 VPS

| 层 | 载体 | 职责 | 为什么 |
| ---- | ---- | ---- | ---- |
| 展示层 | **GitHub Pages** | 静态托管（index.html + engine + route-defs + data/db 只读展示） | 零成本、全球 CDN、push 即部署；站点数据本来就是构建产物，静态足够 |
| 构建层 | **GitHub Actions** | 手动触发单线构建 / 季度全量刷新（调高德、跑体检、回归后 bot 提交） | 构建需要 Web 服务 Key 与分钟级联网任务，不适合在浏览器/ Pages 里做；Actions 的 Secrets 管 Key 干净 |
| 后期（已拍板方向） | VPS 云端构建服务 | 自定义线路的实时/按需构建 | 等「用户自定义线路」需求出现，把 tools/ 管线原样搬上 VPS（db-lib 已是独立层） |

**Key 安全边界（再次明确）**：浏览器端 Key（AMAP_JS_KEY）运行时必然出现在页面源码——
这是 JS 地图厂商的常态，防护靠高德控制台**域名白名单**；仓库（git 历史）与 workflow
文件里一个 Key 字符都没有（只出现 `${{ secrets.* }}` 引用）。Web 服务 Key 只存在于
Actions Secrets，构建时写入 `.env.local`（全程日志脱敏），构建完不提交。

### deploy.yml（Pages 部署）

- 触发：push main / workflow_dispatch；官方 actions（upload-pages-artifact v3 +
  deploy-pages v4），permissions: pages:write + id-token:write
- Key 注入：secrets → `.env.local` → **`node tools/make-key-local.js` 复用生成
  key.local.js**（与 engine/boot-route.js 的 `{amapKey, amapSecurity}` 约定永不跑偏）
- 关键坑（workflow 注释留痕）：upload-artifact v4 **遵循 .gitignore**，会把被忽略的
  key.local.js 排除出 artifact——CI 工作区临时追加 `!key.local.js` 取消排除（只影响
  artifact 上传，本 workflow 从不提交），并 `test -f` + grep 字段自检后才上传

### build.yml（云端构建器）

- `workflow_dispatch`：`routeId`（必填）+ `refresh_stations`（布尔，--refresh）
  → build-route → build-stations → validate（严格模式，不 --fix）→
  c4-test && probe-check → bot 提交（注明触发人与方式）；**任一失败即中止，不提交半成品**
- `schedule`（cron `0 2 1 3,6,9,12 *`，每年 3/6/9/12 月 1 日 02:00 UTC）：
  manifest 全部线路 `build-stations --refresh` + `validate --fix`（DEM 尖峰按既定流程
  修复写回）+ 全量回归 → 有变化才提交。定时任务**不重跑 build-route**（季度刷新不动几何）
- 目标线路解析：手动 = 输入的 routeId；定时 = 从 `route-defs/manifest.js` 解析 id 列表
  （新增线路自动纳入季度刷新，无需改 workflow）
- 提交范围：`route-defs data/db`（构建产物 + 共享库沉淀），bot 身份
  `github-actions[bot]`；cloud-build 的 push 会联动触发 deploy.yml 重新部署

### 首次部署操作清单（主会话照单执行）

1. 提交本仓库全部改动（含 `.github/workflows/`）并 push 到 main
2. Settings → Secrets and variables → Actions，建三个 secret：
   `AMAP_JS_KEY` / `AMAP_JS_SECURITY_CODE`（高德「Web 端(JS API)」应用的 Key + 安全密钥）、
   `AMAP_WEB_SERVICE_KEY`（高德 Web 服务 Key，云端构建用）
3. Settings → Pages：Source 选 **GitHub Actions**
4. 高德控制台：给浏览器端 Key 配域名白名单 = `https://<用户名>.github.io` + `localhost`
5. Actions → cloud-build → Run workflow（routeId 填 `chuanxi` 试跑）验证构建链路；
   成功后 push 任意提交或手动触发 deploy-pages，访问 `https://<用户名>.github.io/xianlumap/`
   应见选线器（注意仓库名路径；若用自定义域名/CNAME 另配）
