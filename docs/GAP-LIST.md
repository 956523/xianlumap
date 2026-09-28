# GAP-LIST — 引擎里写死青甘的假设（S1.5 探针产出）

> 本文档是 S2 的工作输入。S1.5 用川西小环线探针包（`route-defs/chuanxi.js`）
> 把引擎（index.html 主脚本）跑了一遍，逐条记录所有「写死青甘」的假设、
> 在川西探针下的实际表现、以及 S2 的处置建议。
> 行号为 index.html 当前行号（S1.5 完成后，全文 1742 行）。
>
> **S2 已全部处置完毕（2026-09-28），逐条结果见文末「S2 处置结果」。
> 引擎已拆分为 `engine/` 四文件，index.html 只剩页面外壳（450 行）。**

## 探针方法

- `?route=chuanxi` 切换数据包（默认 qinghai-gansu），引擎逻辑不变；
- 探针包数据允许不全，但空值必须是「安全空值 + 页面如实标注」（铁律，PLATFORM.md §5.3）；
- 验收：`node tools/c4-test.js`（青甘回归 94/0）+ `node tools/probe-check.js`（两条线各加载一遍，20/0）。

## A. 展示层文案（S1.5 已大部分收进 ROUTE_META）

| # | 位置 | 写死的假设 | 川西探针下的表现 | S2 处置 |
|---|------|-----------|-----------------|---------|
| A1 | L6 `<title>` | 标题写死「青甘大环线 · 西宁/兰州出发」 | S1.5 已改为启动时由 `ROUTE_META.title` 覆盖，青甘显示不变 | 已解决，契约保留 ROUTE_META.title |
| A2 | L364 h1 | 线路名写死「青甘大环线 🚗」 | 已改 `#routeName` + `ROUTE_META.name` | 已解决 |
| A3 | L371 副标题 | 写死「青海湖—柴达木—敦煌—…」 | 已改 `#routeSub` + `ROUTE_META.sub`（川西显示「探针包：站点数据未接入」） | 已解决 |
| A4 | L425 evNotice | 写死「大柴旦 → 敦煌约 345km 沿线无桩」 | 已改 `ROUTE_META.evNotice`；数据包未给时移除该通知（不再展示旧线路提示） | 已解决 |
| A5 | L384 经典线图例 | 图例行写死「经典线（塔尔寺·拉脊山）」 | 无支线时整行隐藏（S1.5），但行文案仍是青甘 | S2：图例文案随数据包（branches[].label） |
| A6 | L428–443 rulesClimb/rulesEnv | 能耗教育文案举例全是青甘（柴达木、祁连、戈壁风） | 文案是通用高原知识，川西下不贴切但**不假**；探针不处理 | S2：举例文案参数化，或改成不写地名的通用版 |

## B. 出发地与双基准体系（最核心的契约缺口）

| # | 位置 | 写死的假设 | 川西探针下的表现 | S2 处置 |
|---|------|-----------|-----------------|---------|
| B1 | L366–367 + L659 | 出发地按钮写死西宁/兰州，`start='xn'` 二值 | 川西只有成都一个出发地：`ROUTE_META.startButtons=false` 隐藏按钮，start 永远 'xn' | **契约化 starts[]**：数据包声明出发地列表（名字/是否拼接 P_LZ_XN 类外延段），引擎按列表渲染按钮 |
| B2 | L663–684 buildDays('lz') 分支 | 写死「兰州版 = P_LZ_XN 拼接 CORE[0] / TAIL 反拼 + LZ_XN_KM 平移 + 兰州文案」 | 川西 `LZ_XN_KM=0 / P_LZ_XN=[]` 数值上不崩，但该分支标题/文案全是兰州→西宁，**不可达的死代码** | S2：随 starts[] 抽象删除或数据化 |
| B3 | L918–919 setStart | 副标题只有兰州/西宁两个写死文案 | 按钮隐藏后不可达 | S2：随 starts[] 数据化 |
| B4 | L850 fitAll | `var c = start==='lz' ? [37.7,98.6] : [38.0,98.2]`——**死变量**（后续被 bbox 反算的 cx/cy 覆盖，从未使用） | 无影响（死代码） | S2：直接删除 |
| B5 | L1148 curTotal / L1152 dayOf / L1510–1511 altSeries | `LZ_XN_KM` 平移渗透在总里程/按天定位/海拔序列三处 | =0 时全部安全；但「存在第二个出发地需要 km 平移」是隐含契约，数据包必须给 LZ_XN_KM 这个青甘命名变量 | S2：km 基准系写进契约（如 `datum: { baseKm, offset }`），变量改名去青甘化 |
| B6 | L549 地图初始视角 | `center: [38.0, 98.2], zoom: 6.2` 写死青甘位置 | boot 后 fitAll 用 LOOP_BBOX 立即纠正，仅首帧在青甘位置闪一下 | S2：用数据包 bbox 初始化 |

## C. 支线与固定线图层

| # | 位置 | 写死的假设 | 川西探针下的表现 | S2 处置 |
|---|------|-----------|-----------------|---------|
| C1 | L620–637 CLASSIC 图层 | 假设 `CLASSIC.simplified` 非空 | 空数组会建出空图层/报错——**S1.5 已加 hasClassic 守卫**：不建图层并隐藏图例行 | 已解决（守卫保留）；S2 支线进契约 |
| C2 | L639–650 丹霞支线 | 坐标 `[39.137,100.165]→[38.970,100.041]` 直接写在引擎里 | 川西页面会在千里之外画一条张掖附近的虚线——**S1.5 已收进数据包 `EXTRA_LINES`**（青甘包带原值，行为不变） | 已解决；S2 并入支线契约 |
| C3 | L1070 tgClassic 监听 | 假设 classicLine 存在 | 已加空守卫 | 已解决 |

## D. 站点数据与续航规划

| # | 位置 | 写死的假设 | 川西探针下的表现 | S2 处置 |
|---|------|-----------|-----------------|---------|
| D1 | L1068–1070 stationsAll | 隐含契约：站点 km 与 ALT 同基准，且有 `xnStart`（兰州基准）字段 | 川西 `xnStart=0` 安全；但「基准系」只是注释里的口头约定 | **契约写明**：站点 km 基准字段、与轨迹 km 的同基准关系 |
| D2 | L1188–1192 planCharging | 假设站点数组至少有一个元素 | 空数组 → `stops[j].km` 读 undefined → **整页崩。探针抓到的第一个真 bug，S1.5 已修（`stops[j] &&` 守卫）** | 契约定义 `ev/fuel = []` 的语义 = 「未接入」，引擎须区分「没站」与「没数据」并如实透出 |
| D3 | L596–605 FUELS/EVS | 手打示例站变量（S0 起已不打点，仅注释引用） | 川西给 []，引擎不读，安全 | S2：删除变量或随 S4 站点回写重新评估 |
| D4 | L1066–1095 activeStations/coveragePick | 「60km 里程网格铺锚点」假设站点密度足够 | 空站点时无锚点可铺，安全降级为空图层 | S4 复核阈值（与线路无关，但依赖站点密度前提） |

## E. 验证过无需改的通用逻辑

- `peakAlt` / `lowAlt` / `altDenoised`（L497–546）：只依赖 ALT_REAL/ALT_MARKS，探针下工作正常（川西最高点正确识别为折多山垭口 4298m）；
- `LOOP_BBOX` / `zoomToFit` / `fitAll` 的 bbox 反算（L796–906）：从 CORE+P_LZ_XN 现算，天然通用；
- 站点分级（zoomTier/dedupeByScreen/screenDist）：与线路无关；
- sparkSVG / drawProfile：只依赖 ALT 序列与 DAYS.altKm，通用。

## S1.5 顺手修复的引擎问题（均已通过 c4-test 94/0 回归）

1. **planCharging 空站点崩溃**（D2）：加 `stops[j] &&` 守卫——这是探针的第一个收获：「站点数据缺失」从「整页白屏」变成「规划面板如实警告」。
2. CLASSIC 空数组守卫（C1）+ tgClassic 空守卫（C3）。
3. 丹霞支线从引擎收进数据包 EXTRA_LINES（C2）。

## S2 处置结果（2026-09-28 回填，全部落地）

验收：`grep -ri 'qinghai|青甘|兰州|西宁|塔尔寺|拉脊山' engine/` 无匹配；
`node tools/c4-test.js` 94/0；`node tools/probe-check.js` 20/0；
新旧引擎 vm 对比（同一 mock 下跑 git HEAD 旧主脚本 vs engine/*.js），
青甘线在「每日列表/统计 chips/全程与聚焦剖面 SVG/站点全量与去重/包围盒/
兰州版全部状态」输出逐字节一致，唯一差异见 B5 注。

| # | 结果 | 处置 |
|---|------|------|
| A1 | ✅ 已解决（S1.5） | 契约保留 ROUTE_META.title，S2 原样保留 |
| A2 | ✅ 已解决（S1.5） | ROUTE_META.name → #routeName |
| A3 | ✅ 已解决（S1.5） | ROUTE_META.sub → #routeSub |
| A4 | ✅ 已解决（S1.5） | ROUTE_META.evNotice；未给时引擎移除通知条（ui.js） |
| A5 | ✅ S2 解决 | 图例文案随包：CLASSIC.label（青甘包带原值「经典线（塔尔寺·拉脊山）」）；无支线线路整行隐藏（守卫保留） |
| A6 | ✅ S2 解决 | 两段能耗文案收进 ROUTE_META.rulesClimb/rulesEnv（青甘包 verbatim 原值）；数据包未给时引擎用不写地名的通用版（engine/ui.js RULES_GENERIC） |
| B1 | ✅ S2 解决 | 契约化 ROUTE_STARTS：数据包声明出发地列表（id/name/sub/offsetKm/stationKm0/totalKm，接入段另含 head/leadPath/firstDay/lastDay）；按钮由 starts 渲染，length<2 隐藏；ROUTE_META.startButtons 废弃 |
| B2 | ✅ S2 解决 | buildDays 的写死分支删除，改为通用拼接：有 leadPath 的出发地 = 首末日接入段拼接 + 中间天 altKm 平移 offsetKm；首末日标题/备注/能耗文案全部进 firstDay/lastDay |
| B3 | ✅ S2 解决 | setStart 副标题读当前出发地的 sub 字段 |
| B4 | ✅ S2 解决 | fitAll 死变量直接删除 |
| B5 | ✅ S2 解决 | km 基准系进契约：offsetKm（平移）/stationKm0（站点基准）/totalKm（环线总长）/head（接入端海拔点）；LZ_XN_KM/LZ_HEAD/P_LZ_XN/TOTAL_XN 引擎不再读取（仅青甘包内部被 ROUTE_STARTS 引用）。**注意（唯一行为差异）**：旧 dayOf 对主基准出发地多减一次接入段里程，导致续航规划面板 D 前缀整体早一天、甚至出现 D?；契约化后站点 km 与 altKm 同属行程基准直接比对，D 前缀恢复正确。新旧对比实测仅此一处文本差异，其余逐字节一致 |
| B6 | ✅ S2 解决 | 地图初始视角由 LOOP_BBOX[starts[0]] 算出（boot 后 fitAll 精算不变） |
| C1 | ✅ 已解决（S1.5 守卫保留） | CLASSIC 空数组不建图层、隐藏图例行；图例文案随包（见 A5） |
| C2 | ✅ 已解决（S1.5） | EXTRA_LINES 在数据包，引擎只消费契约 |
| C3 | ✅ 已解决（S1.5 守卫保留） | tgClassic 空守卫 |
| D1 | ✅ S2 解决 | 契约写明：ROUTE_STARTS[].stationKm0（引擎读）+ STATION_DATA.xnStart（构建侧遗留命名，S3 管线参数化时统一改名）；站点 km 与轨迹 km 的同基准关系写进两个包头部注释 |
| D2 | ✅ S2 解决 | 契约语义落地：ev/fuel = [] = 「该线路未接入此类站点数据」→ planCharging 返回空规划、面板显示「未接入」；「已接入但这段真没站」仍走无桩段警告/最长间隔透出。S1.5 的 stops[j] 空守卫保留；probe-check 断言同步改为「未接入」 |
| D3 | ✅ S2 解决 | FUELS/EVS 从两个数据包删除（引擎自 S0 起不读，纯死数据）；无需等 S4 |
| D4 | ⏸ 无需改（留 S4） | 60km 网格与线路无关，空站点时安全降级为空图层；阈值随 S4 体检复核 |
