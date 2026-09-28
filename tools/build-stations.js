/* ============================================================
   build-stations.js — 参数化沿线站点构建（S3）
   用法：node tools/build-stations.js <routeId> [--source amap|tencent] [--dry]
   输入：route-defs/<routeId>.js（ROUTE_BUILD.poiRegions 行政区清单 +
        CORE/TAIL/ROUTE_STARTS 轨迹，站点投影到与页面同源的轨迹上）
   输出：就地更新包内 STATION_DATA（ev/fuel，含 regions/truncated 审计字段）
   做法对齐青甘版：35km 离路过滤 → 25km 里程桶配额（含长间隔补洞）→
        覆盖体检（最大无桩间隔 + 25km 网格盲区）。
   数据源：
     --source amap（默认）：高德 POI place/text，city+citylimit 行政区穷举
     --source tencent：腾讯 POI region()（⚠️ 无 Key 未验证；代理地址从
        环境变量 TMAP_SECRET/TMAP_PORT 读，不再硬编码）
   ============================================================ */
const fs = require('fs');
const {
    loadAmapKey, maskKey, sleep, amapGet,
    loadRoutePackage, buildProjection, longBlindWarnings, replaceVarBlock, ROOT
} = require('./lib/build-lib');
const http = require('http');

const ARGS = process.argv.slice(2);
const ROUTE_ID = ARGS.filter(a => !a.startsWith('--'))[0];
const SOURCE = (ARGS.filter(a => a.indexOf('--source=') === 0)[0] || '--source=amap').split('=')[1];
const DRY = ARGS.indexOf('--dry') >= 0;
if (!ROUTE_ID || ['amap', 'tencent'].indexOf(SOURCE) < 0) {
    console.error('用法: node tools/build-stations.js <routeId> [--source amap|tencent] [--dry]');
    process.exit(1);
}

const { file: PKG_FILE, src: PKG_SRC, pkg } = loadRoutePackage(ROUTE_ID);
const B = pkg.ROUTE_BUILD;
const REGIONS = B.poiRegions || [];
if (!REGIONS.length) throw new Error(ROUTE_ID + ' 的 ROUTE_BUILD 没有 poiRegions 行政区清单');

let AMAP_KEY = null;
if (SOURCE === 'amap') {
    AMAP_KEY = loadAmapKey();
    console.log('数据源：高德 POI place/text（Key ' + maskKey(AMAP_KEY) + '）');
} else {
    console.log('数据源：腾讯 POI region()（⚠️ 无 Key 未验证，保留路径）');
}

const MAX_DIST = 35;   // 站点离路线超过这个距离就丢弃（km）

/* ---------- 1. 投影主线（与页面同源；tools/lib/build-lib.js 与 validate.js 共用同口径） ---------- */
const STARTS = pkg.ROUTE_STARTS || [];
const PROJ = buildProjection(pkg);
const ROUTE_ALL = PROJ.ROUTE_ALL, SEG_KM = PROJ.SEG_KM;
const TOTAL_KM = PROJ.TOTAL_KM;
const COSLAT = PROJ.COSLAT;
const XN_START = (STARTS[0] && STARTS[0].stationKm0) || 0;

/* 折线包围盒（行政区清单人工可审的依据） */
const bbox = ROUTE_ALL.reduce((b, p) => ({
    latMin: Math.min(b.latMin, p[0]), latMax: Math.max(b.latMax, p[0]),
    lngMin: Math.min(b.lngMin, p[1]), lngMax: Math.max(b.lngMax, p[1])
}), { latMin: 99, latMax: -99, lngMin: 999, lngMax: -999 });
console.log(`路线：投影点 ${ROUTE_ALL.length} / 总里程 ${TOTAL_KM.toFixed(1)}km / 站点基准 datumStartKm=${XN_START}`);
console.log(`折线包围盒：lat ${bbox.latMin.toFixed(2)}–${bbox.latMax.toFixed(2)}，lng ${bbox.lngMin.toFixed(2)}–${bbox.lngMax.toFixed(2)}`);
console.log(`行政区穷举清单（${REGIONS.length} 个，人工可审）：${REGIONS.join('、')}`);

if (DRY) {
    console.log('--dry：不抓取、不写回。预计请求 ≈ ' + (REGIONS.length * 2) + '–' + (REGIONS.length * 16) + ' 次（每区每类 1–8 页）');
    process.exit(0);
}

function projectRoute(lat, lng) { return PROJ.project(lat, lng); }

/* ---------- 2. POI 查询封装 ---------- */
const BRANDS = ['特来电', '星星充电', '特斯拉', '驴充充', '云快充', '国家电网', '小桔充电',
    '快电', '昆仑网电', '中国铁塔', '比亚迪', '蔚景云', '乐来电', '万桩', '闪开',
    '车电网', '智充', '观途速电', '鼎瑞', '兴达', '蔚享天成', '塔能', '海尔'];

function normAddr(a) { return Array.isArray(a) ? a.join('') : (a || ''); }
function normTel(t) { return Array.isArray(t) ? t.join(';') : (t || ''); }

async function searchAmap(keyword, region, page) {
    const q = `/v3/place/text?keywords=${encodeURIComponent(keyword)}&city=${encodeURIComponent(region)}&citylimit=true&offset=25&page=${page}&extensions=all`;
    return amapGet(q, AMAP_KEY);
}

/* 腾讯保留路径（无 Key 未验证）：代理地址全部走环境变量 */
const TSECRET = process.env.TMAP_SECRET || '';
const TPORT = process.env.TMAP_PORT || '49234';
/* 源分发器：amap 默认 / tencent 保留。所有请求过并发闸门（CUQPS 上限内） */
let gateInFlight = 0;
const gateQueue = [];
function gatePump() {
    while (gateInFlight < 4 && gateQueue.length) {
        const item = gateQueue.shift();
        gateInFlight++;
        item.fn().then(item.resolve).finally(() => { gateInFlight--; gatePump(); });
    }
}
function gate(fn) {
    return new Promise(resolve => { gateQueue.push({ fn, resolve }); gatePump(); });
}
function search(keyword, region, page) {
    return gate(() => SOURCE === 'amap' ? searchAmap(keyword, region, page) : searchTencent(keyword, region, page));
}
function searchTencent(keyword, region, page) {
    if (!TSECRET) return Promise.resolve({ status: -1, message: 'tencent 源需要环境变量 TMAP_SECRET/TMAP_PORT（无 Key 未验证）' });
    const base = `http://127.0.0.1:${TPORT}/_TMapService/_wbt/${TSECRET}/service/place/v1/search`;
    const us = new URLSearchParams({ keyword, boundary: `region(${region},0)`, output: 'json', page_size: '20', page_index: String(page) });
    return new Promise(resolve => {
        const req = http.get(base + '?' + us.toString(), { timeout: 12000 }, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ status: -1, message: 'parse fail' }); } });
        });
        req.on('error', e => resolve({ status: -1, message: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ status: -1, message: 'timeout' }); });
    });
}

/* ---------- 3. 抓取 ---------- */
async function main() {
    const raw = { ev: [], fuel: [] };
    const seen = new Set();
    const stats = { req: 0, fail: 0, empty: [] };
    const truncated = [];   // 抓到上限但未抓完的 region+kw（如实记录，不假装抓全）

    function push(bucket, item) {
        const loc = item.location; // amap: "lng,lat" 字符串；tencent: {lat,lng}
        let lat, lng;
        if (typeof loc === 'string') { const c = loc.split(','); lng = +c[0]; lat = +c[1]; }
        else if (loc && loc.lat != null) { lat = +loc.lat; lng = +loc.lng; }
        if (!lat || !lng) return;
        // 类别过滤：关键词搜索会带进邻近类目（如「充电」的维修点），按 type/category 收紧
        const cat = item.type || item.category || '';
        if (bucket === 'ev' && cat && cat.indexOf('充电') < 0) return;
        if (bucket === 'fuel' && cat && cat.indexOf('加油') < 0) return;
        const pr = projectRoute(lat, lng);
        if (pr.dist > MAX_DIST) return;
        const title = item.name || item.title || '未命名站点';
        // 全精度去重键：跨区重复的同一 POI 坐标逐位一致，保留哪份内容都相同 →
        // 并发完成顺序不影响最终结果（内容级确定性）
        const key = title + '|' + lat.toFixed(5) + ',' + lng.toFixed(5);
        if (seen.has(key)) return;
        seen.add(key);
        const op = BRANDS.filter(b => title.indexOf(b) >= 0)[0] || '';
        raw[bucket].push({
            t: title,
            a: normAddr(item.address),
            tel: normTel(item.tel),
            lat: +lat.toFixed(5),
            lng: +lng.toFixed(5),
            km: +pr.routeKm.toFixed(1),
            d: +pr.dist.toFixed(1),
            op: op,
            slow: title.indexOf('慢充') >= 0 ? 1 : 0,
            cat: cat
        });
    }

    for (const job of [{ kw: '充电站', bucket: 'ev' }, { kw: '加油站', bucket: 'fuel' }]) {
        await fetchKeyword(job);
        console.log(`${job.kw} 完成：${raw[job.bucket].length} 条`);
    }
    async function fetchKeyword(job) {
        // 两阶段全并发：阶段 1 所有区县的第 1 页过闸门并发（拿 count）；
        // 阶段 2 把全部后续页一次性过闸门并发。单请求 ~3s 是服务器延迟，
        // 并发度靠闸门压在 CUQPS 上限内（S7 实测；瞬时超限退避重试兜住）。
        const maxPage = SOURCE === 'amap' ? 8 : 6; // amap offset=25×8=200 上限；tencent 20×6=120
        const per = SOURCE === 'amap' ? 25 : 20;
        const regions = REGIONS.map(rg => ({ rg, got: 0, count: null, ok: true }));

        await Promise.all(regions.map(async slot => {
            const res1 = await search(job.kw, slot.rg, 1);
            stats.req++;
            if (String(res1.status) !== '1' && res1.status !== 0) {
                stats.fail++;
                slot.ok = false;
                if (stats.fail <= 6) console.log(`  ⚠ ${slot.rg} ${job.kw} status=${res1.status} ${res1.message || res1.info || ''}`);
                return;
            }
            const p1 = res1.pois || res1.data || [];
            slot.count = +(res1.count != null ? res1.count : p1.length);
            slot.got += p1.length;
            p1.forEach(it => push(job.bucket, it));
        }));

        const pageJobs = [];
        regions.forEach(slot => {
            if (!slot.ok) return;
            const totalPages = Math.min(maxPage, Math.max(1, Math.ceil(slot.count / per)));
            for (let pg = 2; pg <= totalPages; pg++) pageJobs.push([slot, pg]);
        });
        await Promise.all(pageJobs.map(async ([slot, pg]) => {
            const res = await search(job.kw, slot.rg, pg);
            stats.req++;
            if (String(res.status) !== '1' && res.status !== 0) { stats.fail++; return; }
            const pois = res.pois || res.data || [];
            slot.got += pois.length;
            pois.forEach(it => push(job.bucket, it));
        }));

        regions.forEach((slot, r) => {
            if (!slot.ok) { stats.empty.push(job.kw + '@' + slot.rg); return; }
            if (slot.count != null && slot.got < slot.count) truncated.push(job.kw + '@' + slot.rg + '（' + slot.got + '/' + slot.count + '）');
            if (slot.got === 0) stats.empty.push(job.kw + '@' + slot.rg);
            if (r % 8 === 0) console.log(`  ${job.kw} ${r}/${REGIONS.length}（累计 ${raw[job.bucket].length}）`);
        });
    }
    console.log(`请求 ${stats.req} / 失败 ${stats.fail} / 零结果区县 ${stats.empty.length}`);
    if (truncated.length) console.log(`⚠️ 未抓全（分页上限截断）：${truncated.join('，')}`);
    if (stats.empty.length) console.log(`⚠️ 零结果：${stats.empty.join('，')}`);

    /* ---------- 4. 配额筛选（25km 桶 + 长间隔补洞，对齐青甘版参数） ---------- */
    function quota(list, { bucketKm, perBucket, criticalGap }) {
        const buckets = {};
        list.forEach(s => {
            const b = Math.floor(s.km / bucketKm);
            (buckets[b] = buckets[b] || []).push(s);
        });
        let kept = [];
        Object.keys(buckets).forEach(b => {
            kept = kept.concat(buckets[b].slice().sort((x, y) => x.d - y.d || x.km - y.km || (x.t < y.t ? -1 : 1)).slice(0, perBucket));
        });
        kept.sort((a, b) => a.km - b.km);
        const all = list.slice().sort((a, b) => a.km - b.km);
        let result = kept.slice();
        for (let i = 0; i < result.length; i++) {
            const cur = result[i], next = result[i + 1];
            const limit = next ? next.km : TOTAL_KM;
            if (limit - cur.km > criticalGap) {
                const cands = all.filter(s => s.km > cur.km && s.km < limit && result.indexOf(s) < 0);
                if (cands.length) {
                    cands.sort((a, b) =>
                        Math.abs(a.km - (cur.km + limit) / 2) - Math.abs(b.km - (cur.km + limit) / 2) || a.km - b.km || (a.t < b.t ? -1 : 1));
                    result.push(cands[0]);
                    result.sort((a, b) => a.km - b.km);
                    i = -1;
                }
            }
        }
        return result.sort((a, b) => a.km - b.km);
    }

    const before = { ev: raw.ev.length, fuel: raw.fuel.length };
    raw.ev = quota(raw.ev, { bucketKm: 25, perBucket: 5, criticalGap: 120 });
    raw.fuel = quota(raw.fuel, { bucketKm: 25, perBucket: 3, criticalGap: 100 });
    console.log(`配额：充电站 ${before.ev}→${raw.ev.length} / 加油站 ${before.fuel}→${raw.fuel.length}`);

    /* ---------- 5. 覆盖体检（盲区显式列出，不藏） ---------- */
    function maxGap(list) {
        let g = 0, prev = 0, at = 0;
        list.forEach(s => { if (s.km - prev > g) { g = s.km - prev; at = s.km; } prev = s.km; });
        if (TOTAL_KM - prev > g) { g = TOTAL_KM - prev; at = TOTAL_KM; }
        return { gap: g, at };
    }
    function coverage(list, label) {
        const blind = [];
        for (let k = 0; k < TOTAL_KM; k += 25) {
            if (!list.some(s => Math.abs(s.km - k) <= 12.5)) blind.push(k);
        }
        if (!blind.length) { console.log(`  ${label}：25km 网格全覆盖 ✅`); return; }
        const runs = []; let st = blind[0], pv = blind[0];
        blind.slice(1).forEach(k => { if (k - pv > 25) { runs.push([st, pv]); st = k; } pv = k; });
        runs.push([st, pv]);
        const bad = runs.filter(r => r[1] - r[0] >= 25);
        console.log(`  ${label}：盲区 ${blind.length}/${Math.ceil(TOTAL_KM / 25)} 格，长盲区 ${bad.length} 段`);
        bad.forEach(r => console.log(`    ⚠ km${r[0]}–${r[1] + 25}（约 ${r[1] + 25 - r[0]}km）`));
    }
    console.log('覆盖体检：');
    const gapEv = maxGap(raw.ev), gapFuel = maxGap(raw.fuel);
    console.log(`  最大无桩间隔 ${gapEv.gap.toFixed(1)}km（终点 km${gapEv.at.toFixed(0)} 前）`);
    console.log(`  最大无油间隔 ${gapFuel.gap.toFixed(1)}km（终点 km${gapFuel.at.toFixed(0)} 前）`);
    coverage(raw.ev, '充电站');
    coverage(raw.fuel, '加油站');

    /* ---------- 6. 就地写回 STATION_DATA ---------- */
    raw.ev.sort((a, b) => a.km - b.km);
    raw.fuel.sort((a, b) => a.km - b.km);
    const d = new Date();
    const builtAt = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
        '-' + String(d.getDate()).padStart(2, '0');
    const out = {
        builtAt,
        source: SOURCE === 'amap'
            ? '高德地图 POI（place/text 行政区穷举）沿真实驾车轨迹重投影'
            : '腾讯地图真实驾车轨迹重投影',
        totalKm: +TOTAL_KM.toFixed(1),
        datumStartKm: +XN_START.toFixed(1),   // 站点里程基准上主出发地行程起点的 km（S4 起由 xnStart 改名）
        datumEndKm: +(TOTAL_KM - XN_START).toFixed(1),
        regions: REGIONS,
        truncated: truncated,
        warnings: longBlindWarnings({ totalKm: TOTAL_KM, ev: raw.ev, fuel: raw.fuel }),
        ev: raw.ev, fuel: raw.fuel
    };
    fs.writeFileSync(PKG_FILE, replaceVarBlock(PKG_SRC, 'STATION_DATA', 'var STATION_DATA = ' + JSON.stringify(out) + ';'));
    console.log(`已写回 ${PKG_FILE}（${raw.ev.length} 充电 + ${raw.fuel.length} 加油，STATION_DATA ${(JSON.stringify(out).length / 1024).toFixed(0)}KB）`);
    if (SOURCE === 'amap' && truncated.length) {
        console.log('提醒：存在分页截断区域，如需更全覆盖可细分行政区后重跑（清单见 STATION_DATA.regions）');
    }
}
main().catch(e => { console.error('构建失败:', e.message); process.exit(1); });
