/* ============================================================
   triage-spots.js — 景点候选规则分诊（S12 减负环，Node 零依赖）
   用法：node tools/triage-spots.js

   背景：高德 POI 无评分接口，改为用已抓字段算置信度，不新增 API 调用。
   只对未审候选（autoCaptured && !reviewed）打 triage 标记：
     triage: 'auto-approve' | 'auto-reject' | 'manual'

   规则（宁缺勿滥；冲突一律落 manual 由人判）：
   【auto-approve】名字强信号 + 近线（d ≤ 5km），两者同时满足：
     强信号词：雪山/冰川/湖/海子/丹霞/雅丹/石窟/寺/庙/草原/垭口/观景台/
              遗址/古城/国家/省级/大峡谷/瀑布/泉/湿地
   【auto-reject】高置信拒绝，满足其一：
     · 弱信号词：公园/广场/乐园/采摘/农家/山庄/温泉度假/游乐/生态农庄
       ——防误杀红线：名字含「国家/省级」的受保护，绝不落 reject
       （如「国家湿地公园」→ 归 approve 侧候选）
     · 距主线 > 25km（走廊边缘远点）
   【manual】其余全部；规则冲突（同含强弱信号）也落 manual。

   红线裁决顺序：
     1. 含「国家/省级」→ 有强信号且 d≤5 → auto-approve；否则 manual（保护，不 reject）
     2. 强信号 && d≤5 → auto-approve
     3. 弱信号 || d>25 → auto-reject
     4. 其余 → manual
   ============================================================ */
const { readDb, writeDb } = require('./lib/db-lib');

const STRONG = ['雪山', '冰川', '湖', '海子', '丹霞', '雅丹', '石窟', '寺', '庙', '草原', '垭口',
    '观景台', '遗址', '古城', '国家', '省级', '大峡谷', '瀑布', '泉', '湿地'];
const WEAK = ['公园', '广场', '乐园', '采摘', '农家', '山庄', '温泉度假', '游乐', '生态农庄'];
const PROTECT = ['国家', '省级'];
/* 设施类词：出现在名字里说明是 POI 机刷设施而非景点本体——不自动通过（落 manual 人判） */
const GUARD = ['报警', '尾水', '人工湿地', '售票', '游客中心', '服务中心', '观光车', '导览',
    '机械博物馆', '休息亭', '乘车点', '停车场', '码头', '游船'];

function hasAny(name, list) { return list.filter(w => name.indexOf(w) >= 0); }

function triageOf(s) {
    if (typeof s.d !== 'number') return 'manual';           // 无距线数据不自动
    const name = s.name || '';
    const strong = hasAny(name, STRONG);
    const weak = hasAny(name, WEAK);
    const protect = hasAny(name, PROTECT);
    // 1. 保护前缀：有强信号且近线 → approve；其余一律 manual（不 reject）
    if (protect.length) {
        return (strong.length && s.d <= 5) ? 'auto-approve' : 'manual';
    }
    // 2. 冲突优先：同含强弱信号（龙王庙广场/玉湖公园/瀑布水景广场）→ manual，不自动通过
    if (strong.length && weak.length) return 'manual';
    // 2.5 设施类（报警柱/尾水湿地/售票处…）→ 不自动通过，落 manual 人判
    if (hasAny(name, GUARD).length) return 'manual';
    // 3. 强信号 + 近线
    if (strong.length && s.d <= 5) return 'auto-approve';
    // 4. 弱信号或走廊边缘远点
    if (weak.length || s.d > 25) return 'auto-reject';
    return 'manual';
}

const db = readDb('spots.json', { version: 1, spots: [] });
const dist = { 'auto-approve': 0, 'auto-reject': 0, manual: 0 };
let changed = 0;
db.spots.forEach(s => {
    if (!s.autoCaptured || s.reviewed) return;
    const t = triageOf(s);
    if (s.triage !== t) { s.triage = t; changed++; }
    dist[t]++;
});
writeDb('spots.json', db);
console.log('分诊完成：待审候选 ' + (dist['auto-approve'] + dist['auto-reject'] + dist.manual) +
    ' 条 → 自动通过 ' + dist['auto-approve'] + ' / 自动拒绝 ' + dist['auto-reject'] + ' / 待你审 ' + dist.manual +
    '（改标 ' + changed + ' 条）');
if (dist['auto-approve'] > 150) {
    console.error('⚠️ auto-approve 超 150，规则太松，请收紧强信号词表');
    process.exit(1);
}
