/* ============================================================
   capture-spots.js — 景点候选抓取（半自动流水线第 1 环，S12）
   用法：node tools/capture-spots.js --route <routeId>

   铁律：「值不值得去是人的判断」——本脚本只抓候选（autoCaptured:true,
   reviewed:false），入库必须经 review-spots.html 人工审核。

   抓取：沿线路走廊（≤35km，复用 build-stations 的投影工具）抓高德 POI
     · 风景名胜类 typecode 1101xx（风景名胜 各级）——不含 1102 公园（城区会爆）
     · 纪念馆 1103xx / 寺观教堂 1104xx（318 人文景观 relevant）
     · 关键词兜底：「观景台」「垭口」（typecode 覆盖不到的高原景观）
   防城区淹没：25km 里程桶配额（每桶 ≤4，按贴路距离取最近）+ 单区上限
     （普通区 ≤8；大城市城区 ≤3）。
   输出：候选写入 data/db/spots.json（WGS-84 基准，srcCoord 留 GCJ 原值），
     与手打 81 条共存；已是人工库同名的候选直接跳过（不重复送审）。
   ============================================================ */
const fs = require('fs');
const {
    loadAmapKey, maskKey, amapGet, wgs2gcj, gcj2wgs, sleep,
    loadRoutePackage, buildProjection, ROOT
} = require('./lib/build-lib');
const { readDb, writeDb, normName } = require('./lib/db-lib');

const ROUTE_ID = (process.argv.filter(a => a.indexOf('--route=') === 0)[0] || '').split('=')[1]
    || process.argv[process.argv.indexOf('--route') + 1];
if (!ROUTE_ID) { console.error('用法: node tools/capture-spots.js --route <routeId>'); process.exit(1); }

const KEY = loadAmapKey();
console.log('候选抓取：' + ROUTE_ID + '（Key ' + maskKey(KEY) + '）');

const { pkg } = loadRoutePackage(ROUTE_ID);
const REGIONS = (pkg.ROUTE_BUILD || {}).poiRegions || [];
if (!REGIONS.length) throw new Error(ROUTE_ID + ' 缺少 poiRegions');
const PROJ = buildProjection(pkg);
const MAX_DIST = 35;

/* 大城市城区：单区上限更严（防城区 POI 淹没） */
const BIG_REGIONS = ['青羊区', '武侯区', '双流区', '温江区', '崇州市', '蒲江县', '名山区', '雨城区',
    '城关区', '七里河区', '安宁区', '巴宜区', '康定市', '都江堰市'];
const REGION_CAP = rg => BIG_REGIONS.indexOf(rg) >= 0 ? 5 : 12;
const BUCKET_KM = 25, BUCKET_CAP = 6;

/* typecode → kind（审核页徽标与回灌文案用） */
function kindOf(amapType, kw) {
    const t = String(amapType || '');
    if (kw === '观景台') return 'viewpoint';
    if (kw === '垭口') return 'pass';
    if (t.indexOf('1101') === 0) return 'spot';
    if (t.indexOf('1103') === 0) return 'memorial';
    if (t.indexOf('1104') === 0) return 'temple';
    return 'spot';
}
const KIND_LABEL = { spot: '风景', viewpoint: '观景台', pass: '垭口', memorial: '纪念馆', temple: '寺观' };

/* 检索任务：每区 1 组 typecode + 2 组关键词兜底 */
const TYPE_QUERIES = [
    { types: '110100|110101|110102|110103|110104|110105', kw: null },   // 风景名胜（各级）
    { types: '110300|110301|110302', kw: null },                          // 纪念馆/陵园
    { types: '110400|110401|110402|110403|110404', kw: null },            // 寺/观/教堂/清真寺
    { types: null, kw: '观景台' },
    { types: null, kw: '垭口' }
];

/* 并发闸门（对齐 build-stations：CUQPS 上限内，瞬时超限退避） */
let inFlight = 0;
const queue = [];
function pump() {
    while (inFlight < 4 && queue.length) {
        const it = queue.shift();
        inFlight++;
        it.fn().then(it.resolve).finally(() => { inFlight--; pump(); });
    }
}
const gate = fn => new Promise(res => { queue.push({ fn, resolve: res }); pump(); });

async function searchAmap(rg, q, page) {
    const us = new URLSearchParams({ city: rg, citylimit: 'true', offset: '25', page: String(page), extensions: 'all' });
    if (q.types) us.set('types', q.types); else us.set('keywords', q.kw);
    return gate(() => amapGet('/v3/place/text?' + us.toString(), KEY));
}

(async () => {
    const spotDb = readDb('spots.json', { version: 1, spots: [] });
    const manualNames = {};
    spotDb.spots.filter(s => !s.autoCaptured).forEach(s => { manualNames[normName(s.name)] = 1; });

    const found = new Map();   // key = name|gcj5dp
    const stats = { req: 0, fail: 0 };
    const fetchedAt = new Date().toISOString().slice(0, 10);

    for (const q of TYPE_QUERIES) {
        // 阶段 1：所有区的第 1 页并发（拿 count）
        const first = await Promise.all(REGIONS.map(rg => searchAmap(rg, q, 1).then(r => ({ rg, r }))));
        const jobs = [];
        first.forEach(({ rg, r }) => {
            stats.req++;
            if (String(r.status) !== '1') { stats.fail++; return; }
            const pois = r.pois || [];
            const count = +(r.count != null ? r.count : pois.length);
            const pages = Math.min(4, Math.max(1, Math.ceil(count / 25)));
            for (let pg = 2; pg <= pages; pg++) jobs.push([rg, pg]);
            pois.forEach(p => eat(rg, p));
        });
        // 阶段 2：后续页并发
        await Promise.all(jobs.map(([rg, pg]) => searchAmap(rg, q, pg).then(r => {
            stats.req++;
            if (String(r.status) !== '1') { stats.fail++; return; }
            (r.pois || []).forEach(p => eat(rg, p));
        })));
    }

    function eat(rg, poi) {
        const c = String(poi.location || '').split(',');
        if (c.length !== 2) return;
        const gcj = [+c[1], +c[0]];
        const pr = PROJ.project(gcj[0], gcj[1]);
        if (pr.dist > MAX_DIST) return;
        const name = (poi.name || '').trim();
        if (!name) return;
        if (manualNames[normName(name)]) return;            // 人工库已有同名，不重复送审
        const key = name + '|' + gcj[0].toFixed(5) + ',' + gcj[1].toFixed(5);
        if (found.has(key)) return;
        found.set(key, {
            name, rg, gcj, km: pr.routeKm, d: pr.dist,
            address: Array.isArray(poi.address) ? poi.address.join('') : (poi.address || ''),
            poiType: poi.type || '', sourceId: poi.id || '',
            kind: kindOf(poi.type, null)
        });
    }

    // 关键词任务的 kind 修正（上面按 type 判了，这里简单覆盖：观景台/垭口关键词命中的）
    // （eat 里 q 未传——用 poiType 兜底即可；关键词命中的 type 常为空 → kind 已按 kw 需重判）
    // ——改为在 eat 时无法拿到 q，统一在收集后按名称再修一遍：
    found.forEach(v => {
        if (/观景台/.test(v.name)) v.kind = 'viewpoint';
        else if (/垭口/.test(v.name)) v.kind = 'pass';
    });

    let arr = Array.from(found.values());

    /* 防淹没配额：单区上限 + 25km 里程桶 ≤4（按贴路距离取最近） */
    const perRegion = {};
    arr = arr.filter(v => (perRegion[v.rg] = (perRegion[v.rg] || 0) + 1) <= REGION_CAP(v.rg));
    const buckets = {};
    arr.forEach(v => {
        const b = Math.floor(v.km / BUCKET_KM);
        (buckets[b] = buckets[b] || []).push(v);
    });
    arr = Object.keys(buckets).reduce((a, b) =>
        a.concat(buckets[b].sort((x, y) => x.d - y.d).slice(0, BUCKET_CAP)), []);

    /* 与库内既有候选去重（全名同 50m / 归一同 30m+括号相似——db-lib 同站规则） */
    const toAdd = [];
    arr.forEach(v => {
        const w = gcj2wgs(v.gcj[0], v.gcj[1]);
        const rec = {
            id: 'spo-auto-' + (spotDb.spots.length + toAdd.length),
            name: v.name, category: 'spot', kind: v.kind,
            lat: +w[0].toFixed(6), lng: +w[1].toFixed(6),
            srcCoord: { lat: +v.gcj[0].toFixed(6), lng: +v.gcj[1].toFixed(6), sys: 'gcj02' },
            desc: v.address, routes: [ROUTE_ID],
            autoCaptured: true, reviewed: false, approved: null,
            source: 'amap', sourceId: v.sourceId, fetchedAt,
            d: +v.d.toFixed(1), km: +v.km.toFixed(1),
            poiType: v.poiType, region: v.rg
        };
        const dup = spotDb.spots.concat(toAdd).some(s =>
            s.name === v.name ? Math.hypot(s.lat - rec.lat, s.lng - rec.lng) * 111320 < 50
                : (Math.hypot(s.lat - rec.lat, s.lng - rec.lng) * 111320 < 30 &&
                   normName(s.name) === normName(v.name)));
        if (!dup) toAdd.push(rec);
    });

    spotDb.spots = spotDb.spots.concat(toAdd);
    writeDb('spots.json', spotDb);
    console.log('候选：原始 ' + found.size + ' → 配额去重后 ' + arr.length + ' → 新入库 ' + toAdd.length +
        '（库总 ' + spotDb.spots.length + '）');
    console.log('API 请求 ' + stats.req + ' / 失败 ' + stats.fail);
    const byKind = {};
    toAdd.forEach(s => byKind[s.kind] = (byKind[s.kind] || 0) + 1);
    console.log('类别：' + Object.keys(byKind).map(k => KIND_LABEL[k] + ' ' + byKind[k]).join('、'));
})().catch(e => { console.error('抓取失败:', e.message); process.exit(1); });
