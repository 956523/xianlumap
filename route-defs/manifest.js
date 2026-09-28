/* ============================================================================
 * 线路登记清单（route-defs/manifest.js）—— 选线器专用
 *
 * 只有轻量元数据（id/name/region/totalKm/days/updatedAt/probe），供选线器页
 * 展示线路卡片；选线器页只加载本文件 + picker.js，不加载任何线路包。
 *
 * ⚠️ 本文件不是线路包：没有 ROUTE_BUILD。c4-test 只认含 ROUTE_BUILD 的文件，
 *    不会把本清单当线路包轮跑；tools/c4-test.js 有「manifest 数值与包一致」的
 *    交叉断言防止本清单与包内数据漂移。
 *
 * 字段口径：totalKm = 包内逐日 km 合计（页面 chip 同口径）；days = CORE+1；
 * updatedAt = 包内 STATION_DATA.builtAt（站点数据日期）。
 * 新增线路 = 加一行（跑完构建后从包内数据抄录）。
 * ========================================================================== */

var ROUTE_MANIFEST = [
    { id: 'qinghai-gansu',      name: '青甘大环线 🚗',   region: '青海 · 甘肃',   totalKm: 2164, days: 10, updatedAt: '2026-09-26', probe: false },
    { id: 'chuanxi',            name: '川西小环线 🚗',   region: '四川',           totalKm: 850,  days: 5,  updatedAt: '2026-09-28', probe: false },
    { id: 'chengdu-lhasa-318',  name: '318 川藏南线 🚗', region: '四川 · 西藏',   totalKm: 2404, days: 8,  updatedAt: '2026-09-28', probe: false }
];
