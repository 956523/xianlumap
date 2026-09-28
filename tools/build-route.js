/* ============================================================
   build-route.js — 参数化构建「真实公路轨迹 + 真实高程」（S3）
   用法：node tools/build-route.js <routeId> [--source amap|tencent] [--compare-osrm]
   输入：route-defs/<routeId>.js 内的 ROUTE_BUILD 契约（途经点/分段/标注/文案）
   输出：重新生成 route-defs/<routeId>.js（STATION_DATA/CLASSIC/EXTRA_LINES 保留不动）
   数据源：
     --source amap（默认）：高德驾车路径规划 v3（GCJ-02 真实道路几何；
       途经点拆子段逐段请求再拼接，v3 无 waypoints 参数）
     --source tencent：腾讯 WebService 驾车 v1（保留路径，⚠️ 无 Key 未验证）
     --compare-osrm：额外拉 OSRM 公共路由做逐段里程对比（只打印，不影响输出）
   高程：open-meteo Elevation 沿轨迹每 ~2.5km 采样（GCJ-02 轨迹先近似反算
   WGS-84 再采样；失败用途经点标称海拔插值并在文件头注明「降级高程」）
   ============================================================ */
const fs = require('fs');
const path = require('path');
const {
    loadAmapKey, maskKey, getJSON, sleep, amapGet,
    wgs2gcj, gcj2wgs, haversine, loadRoutePackage, ROOT
} = require('./lib/build-lib');

const ARGS = process.argv.slice(2);
const ROUTE_ID = ARGS.filter(a => !a.startsWith('--'))[0];
const SOURCE = (ARGS.filter(a => a.indexOf('--source=') === 0)[0] || '--source=amap').split('=')[1];
const COMPARE_OSRM = ARGS.indexOf('--compare-osrm') >= 0;
if (!ROUTE_ID || ['amap', 'tencent'].indexOf(SOURCE) < 0) {
    console.error('用法: node tools/build-route.js <routeId> [--source amap|tencent] [--compare-osrm]');
    process.exit(1);
}

const { file: PKG_FILE, pkg } = loadRoutePackage(ROUTE_ID);
const B = pkg.ROUTE_BUILD;
const W = B.waypoints;
const INPUT_WGS = B.inputDatum === 'wgs84';   // 输入坐标系（页面轨迹一律 GCJ-02）
const toGcj = p => (INPUT_WGS ? wgs2gcj(p[0], p[1]) : [p[0], p[1]]);
const toWgs = p => (INPUT_WGS ? [p[0], p[1]] : gcj2wgs(p[0], p[1]));

let AMAP_KEY = null;
if (SOURCE === 'amap') {
    AMAP_KEY = loadAmapKey();
    console.log('数据源：高德驾车 v3（Key ' + maskKey(AMAP_KEY) + '）');
} else {
    console.log('数据源：腾讯驾车 v1（⚠️ 无 Key 未验证，保留路径）');
}
if (COMPARE_OSRM) console.log('对比：额外拉 OSRM 公共路由（只打印对比，不影响输出）');

/* ---------- 道路名过滤（高德返回含大量市区街巷，只留导航意义的干线） ---------- */
function cleanRoads(names) {
    const out = [];
    names.forEach(rn => {
        if (!rn) return;
        if (/入口|出口|立交|枢纽|辅路|匝道|大道|大街|步行街|内部道路/.test(rn)) return;
        if (!/(高速|公路|国道|省道|隧道|环线|快速|沪聂线|G\d|S\d)/.test(rn)) return;
        if (out.indexOf(rn) < 0) out.push(rn);
    });
    return out;
}

/* ---------- 高德：途经点拆子段，逐段 v3 请求后拼接 ---------- */
async function fetchLegAmap(leg) {
    const chain = [leg.from].concat(leg.via || [], [leg.to]).map(k => W[k]);
    let pts = [], roads = [], dist = 0, dur = 0, toll = 0;
    for (let i = 0; i < chain.length - 1; i++) {
        const a = chain[i].p, b = chain[i + 1].p;
        const q = `/v3/direction/driving?origin=${a[1]},${a[0]}&destination=${b[1]},${b[0]}`;
        const j = await amapGet(q, AMAP_KEY);
        const p = j.route.paths[0];
        dist += +p.distance; dur += +p.duration; toll += +(p.tolls || 0);
        (p.steps || []).forEach(s => {
            String(s.polyline || '').split(';').forEach(tok => {
                const c = tok.split(',');
                if (c.length === 2 && c[0] && c[1]) pts.push([+c[1], +c[0]]);
            });
            if (s.road) roads.push(String(s.road).trim());
        });
        await sleep(300); // QPS 保护
    }
    const seen = {}, dedup = [];
    pts.forEach(p => {
        const k = p[0].toFixed(6) + ',' + p[1].toFixed(6);
        if (!seen[k]) { seen[k] = 1; dedup.push([+p[0].toFixed(6), +p[1].toFixed(6)]); }
    });
    return { pts: dedup, apiKm: +(dist / 1000).toFixed(1), duration: dur, toll, roads: cleanRoads(roads) };
}

/* ---------- 腾讯：整段请求（无 Key 未验证） ---------- */
const TMAP_KEY = (process.env.TMAP_KEY || '').trim();
function decodePolyline(coors) {
    const out = [];
    const buf = coors.slice();
    for (let i = 2; i < buf.length; i++) buf[i] = buf[i - 2] + buf[i] / 1000000;
    for (let i = 0; i + 1 < buf.length; i += 2) out.push([buf[i], buf[i + 1]]);
    return out;
}
async function fetchLegTencent(leg) {
    if (!TMAP_KEY) throw new Error('tencent 源需要环境变量 TMAP_KEY（该路径无 Key 未验证）');
    const f = toGcj(W[leg.from].p), t = toGcj(W[leg.to].p);
    let url = `https://apis.map.qq.com/ws/direction/v1/driving/?from=${f[0]},${f[1]}&to=${t[0]},${t[1]}&output=json&key=${TMAP_KEY}`;
    if (leg.via && leg.via.length) {
        url += '&waypoints=' + leg.via.map(k => { const p = toGcj(W[k].p); return p[0] + ',' + p[1]; }).join(';');
    }
    const j = await getJSON(url);
    if (j.status !== 0) throw new Error('腾讯API status=' + j.status + ' ' + j.message);
    const route = j.result.routes[0];
    let pl = decodePolyline(route.polyline);
    const seen = {}, dedup = [];
    pl.forEach(p => {
        const k = p[0].toFixed(6) + ',' + p[1].toFixed(6);
        if (!seen[k]) { seen[k] = 1; dedup.push([+p[0].toFixed(6), +p[1].toFixed(6)]); }
    });
    const roads = [];
    (route.steps || []).forEach(s => {
        const rn = (s.road_name || '').replace(/[�]/g, '').trim();
        if (rn && rn !== '内部道路' && roads.indexOf(rn) < 0) roads.push(rn);
    });
    return { pts: dedup, apiKm: +(route.distance / 1000).toFixed(1), duration: route.duration, toll: route.toll || 0, roads };
}

/* ---------- OSRM 对比（只打印） ---------- */
async function fetchLegOsrmKm(leg) {
    const chain = [leg.from].concat(leg.via || [], [leg.to]).map(k => toWgs(W[k].p));
    const coords = chain.map(p => p[1] + ',' + p[0]).join(';');
    try {
        const j = await getJSON(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=false`, 2);
        if (j.code !== 'Ok' || !j.routes || !j.routes.length) return null;
        return +(j.routes[0].distance / 1000).toFixed(1);
    } catch (e) { return null; }
}

/* ---------- open-meteo 高程（50 点/批；失败返回 null 走标称海拔插值） ---------- */
async function fetchElevations(points) {
    const out = new Array(points.length).fill(null);
    for (let i = 0; i < points.length; i += 50) {
        const batch = points.slice(i, i + 50);
        const lat = batch.map(p => p[0].toFixed(5)).join(',');
        const lng = batch.map(p => p[1].toFixed(5)).join(',');
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`;
        let j = null;
        for (let r = 0; r < 4 && !j; r++) {
            try {
                const o = await getJSON(url, 1);
                if (o && o.elevation && o.elevation.length === batch.length) j = o;
            } catch (e) { /* retry */ }
            if (!j) await sleep(1200);
        }
        if (j) j.elevation.forEach((e, n) => { out[i + n] = Math.round(e); });
        process.stdout.write('\r  高程采样 ' + Math.min(i + 50, points.length) + '/' + points.length + '   ');
        await sleep(450);
    }
    console.log('');
    return out;
}

(async () => {
    const builtAt = new Date().toISOString().slice(0, 10);
    let degradedElev = false;

    /* 1) 逐 leg 拉轨迹（GCJ-02） */
    console.log('--- 拉取真实驾车轨迹（' + SOURCE + '）---');
    const legGeoms = [];
    for (const leg of B.legs) {
        process.stdout.write('D' + leg.id + ' ' + (leg.title || leg.name || '') + ' ... ');
        const r = SOURCE === 'amap' ? await fetchLegAmap(leg) : await fetchLegTencent(leg);
        console.log(r.pts.length + '点 ' + r.apiKm + 'km 路:' + r.roads.slice(0, 5).join('+'));
        legGeoms.push({ leg, geom: r.pts, apiKm: r.apiKm, roads: r.roads });
        await sleep(200);
    }

    /* --compare-osrm：逐段里程对比（公里数级差异正常，看走向是否一致） */
    if (COMPARE_OSRM) {
        console.log('--- OSRM 逐段对比 ---');
        let sumA = 0, sumO = 0;
        for (const lg of legGeoms) {
            const ok = await fetchLegOsrmKm(lg.leg);
            sumA += lg.apiKm;
            if (ok != null) {
                sumO += ok;
                const diff = (lg.apiKm - ok);
                console.log('  D' + lg.leg.id + ' ' + (lg.leg.title || '') + '：' + SOURCE + ' ' + lg.apiKm + 'km / OSRM ' + ok + 'km（' + (diff >= 0 ? '+' : '') + diff.toFixed(1) + 'km）');
            } else {
                console.log('  D' + lg.leg.id + '：OSRM 不可达');
            }
            await sleep(400);
        }
        console.log('  合计：' + SOURCE + ' ' + sumA.toFixed(1) + 'km / OSRM ' + sumO.toFixed(1) + 'km');
    }

    /* 2) 拼全程环（段间去重；累计里程用 GCJ-02 轨迹自身） */
    const loop = [];
    let cum = 0;
    legGeoms.forEach(function (lg, li) {
        lg.geom.forEach(function (p, pi) {
            if (li > 0 && pi === 0) return;
            if (loop.length) cum += haversine(loop[loop.length - 1].p, p);
            loop.push({ p: p, legIdx: li, cum: +cum.toFixed(2) });
        });
    });
    const totalKm = +cum.toFixed(1);
    console.log('\n全程 ' + totalKm + 'km，共 ' + loop.length + ' 个轨迹点');

    /* 3) 沿全程每 ~2.5km 采高程（GCJ-02 先近似反算 WGS-84 送 open-meteo） */
    console.log('--- open-meteo 高程采样 ---');
    const sampleIdx = [];
    let nextKm = 0;
    loop.forEach(function (p, i) { if (p.cum >= nextKm) { sampleIdx.push(i); nextKm = p.cum + 2.5; } });
    if (sampleIdx[sampleIdx.length - 1] !== loop.length - 1) sampleIdx.push(loop.length - 1);
    const samples = await fetchElevations(sampleIdx.map(i => toWgs(loop[i].p)));
    if (samples.some(a => a == null)) {
        degradedElev = true;
        console.error('  ⚠️ open-meteo 部分失败 → 用途经点标称海拔插值兜底');
        const anchors = [];
        Object.keys(W).forEach(function (k) {
            let best = 0, bd = 1e9;
            loop.forEach(function (p, i) {
                const d = haversine(p.p, toGcj(W[k].p));
                if (d < bd) { bd = d; best = i; }
            });
            anchors.push({ km: loop[best].cum, alt: W[k].alt });
        });
        anchors.sort((a, b) => a.km - b.km);
        samples.forEach(function (a, n) {
            if (a != null) return;
            const km = loop[sampleIdx[n]].cum;
            let prev = anchors[0], next = anchors[anchors.length - 1];
            for (let i = 0; i < anchors.length; i++) {
                if (anchors[i].km <= km) prev = anchors[i];
                if (anchors[i].km >= km) { next = anchors[i]; break; }
            }
            const t = next.km === prev.km ? 0 : (km - prev.km) / (next.km - prev.km);
            samples[n] = Math.round(prev.alt + (next.alt - prev.alt) * t);
        });
    }
    const ALT_REAL = sampleIdx.map((i, n) => [loop[i].cum, samples[n]]);

    /* 4) 海拔标注：显式 marks（p 吸附到最近采样点；km 直给的原样保留）+ 核心段途经点自动补 */
    const coreViaKeys = {};
    B.legs.forEach(function (leg) {
        if (leg.core === false || leg.rest) return;
        [leg.from].concat(leg.via || [], [leg.to]).forEach(k => { coreViaKeys[k] = 1; });
    });
    const markDefs = [];
    if (B.marksIncludeWaypoints !== false) {
        Object.keys(coreViaKeys).forEach(function (k) { markDefs.push({ n: W[k].n, p: W[k].p }); });
    }
    (B.marks || []).forEach(function (m) {
        const i = markDefs.findIndex(d => d.n === m.n);
        if (i >= 0) markDefs[i] = m; else markDefs.push(m);
    });
    const ALT_MARKS = markDefs.map(function (m) {
        if (m.km != null) { // 历史手调标注：km/alt 直给（原样保留）
            const o = { km: m.km, alt: m.alt, n: m.n };
            if (m.pass) o.pass = true;
            if (m.lowest) o.lowest = true;
            return o;
        }
        const g = toGcj(m.p);
        let best = 0, bd = 1e9;
        ALT_REAL.forEach(function (s, i) {
            const d = haversine(loop[sampleIdx[i]].p, g);
            if (d < bd) { bd = d; best = i; }
        });
        const o = { km: ALT_REAL[best][0], alt: m.alt != null ? m.alt : ALT_REAL[best][1], n: m.n };
        if (m.pass) o.pass = true;
        if (m.lowest) o.lowest = true;
        return o;
    }).sort((a, b) => a.km - b.km);

    /* 5) 每日 CORE/TAIL + 接入段路径（抽稀 ≤240 点、爬升统计、能耗文案） */
    function simplify(pts) {
        const keep = Math.min(pts.length, 240);
        const out = [];
        for (let i = 0; i < keep; i++) out.push(pts[Math.round(i * (pts.length - 1) / (keep - 1))]);
        return out.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]);
    }
    function buildDay(lg) {
        const leg = lg.leg;
        if (leg.rest) { // 休整日：无轨迹，文案/区间直给
            return { id: leg.id, title: leg.title, km: 0, zoom: leg.zoom, note: leg.note, altKm: leg.altKm, center: leg.center, energy: leg.energy };
        }
        const legPts = [];
        loop.forEach(function (p) { if (p.legIdx === legGeoms.indexOf(lg)) legPts.push(p); });
        const a = legPts[0].cum, b = legPts[legPts.length - 1].cum;
        const segAlts = ALT_REAL.filter(s => s[0] >= a - 0.01 && s[0] <= b + 0.01).map(s => s[1]);
        let up = 0, down = 0;
        for (let i = 1; i < segAlts.length; i++) { const d = segAlts[i] - segAlts[i - 1]; if (d > 0) up += d; else down -= d; }
        const minA = Math.min.apply(null, segAlts), maxA = Math.max.apply(null, segAlts);
        const energy = leg.energy ||
            ('本段真实爬升 ' + Math.round(up) + 'm / 下降 ' + Math.round(down) + 'm，海拔 ' + minA + '–' + maxA + 'm。' +
                (up > 800 ? '大爬升段，上坡电耗显著增加（每千爬升约 +4–5 度电）。' : '整体起伏不大，按平路能耗估算即可。') +
                (down > up * 1.5 ? '长下坡为主，动能回收友好，净能耗低于平路。' : '') +
                (lg.roads && lg.roads.length ? ' 主要道路：' + lg.roads.slice(0, 4).join('、') + '。' : ''));
        return {
            id: leg.id, title: leg.title, km: +(b - a).toFixed(0), zoom: leg.zoom, note: leg.note,
            altKm: [a, b], apiKm: lg.apiKm, up: Math.round(up), down: Math.round(down),
            minAlt: minA, maxAlt: maxA, roads: lg.roads || [], energy: energy,
            path: simplify(legPts.map(p => p.p))
        };
    }
    const dayGeoms = legGeoms.filter(lg => lg.leg.core !== false);
    const days = dayGeoms.map(buildDay);
    const CORE = days.slice(0, -1);
    const TAIL = days[days.length - 1];
    const pathByLegId = {};
    legGeoms.forEach(lg => {
        const pts = [];
        loop.forEach(function (p) { if (p.legIdx === legGeoms.indexOf(lg)) pts.push(p); });
        pathByLegId[lg.leg.id] = simplify(pts.map(p => p.p));
    });

    /* 6) 城镇 / 景点 */
    const CITIES = B.cities
        ? B.cities.map(c => ({ n: c.n, p: toGcj(c.p).map(v => +v.toFixed(5)), d: c.d }))
        : Object.keys(W).map(function (k) {
            const mk = ALT_MARKS.filter(m => m.n === W[k].n)[0];
            return { n: W[k].n, p: toGcj(W[k].p).map(v => +v.toFixed(5)), d: (mk ? mk.alt : W[k].alt) + 'm | ' + W[k].d };
        });
    const SPOTS = (B.spots || []).map(s => ({ n: s.n, p: toGcj(s.p).map(v => +v.toFixed(5)), d: s.d }));

    /* 7) ROUTE_STARTS：leadLegId → 接入段轨迹/里程平移（契约见 EXECUTION §7） */
    const leadStart = (B.starts || []).filter(s => s.leadLegId)[0];
    const apiKmByLegId = {};
    legGeoms.forEach(lg => { apiKmByLegId[lg.leg.id] = lg.apiKm; });
    const ROUTE_STARTS = (B.starts || [{ id: 'default', name: '默认' }]).map(function (s, i) {
        const out = { id: s.id, name: s.name, sub: s.sub || B.meta.sub };
        if (s.leadLegId) {
            out.offsetKm = apiKmByLegId[s.leadLegId];
            out.stationKm0 = 0;
            out.head = s.head;
            out.leadPath = pathByLegId[s.leadLegId];
            out.firstDay = s.firstDay;
            out.lastDay = s.lastDay;
        } else {
            out.offsetKm = 0;
            out.stationKm0 = leadStart ? apiKmByLegId[leadStart.leadLegId] : 0;
            if (i === 0) out.totalKm = totalKm;
        }
        return out;
    });

    /* 8) 写出数据包（保留段：STATION_DATA / CLASSIC / EXTRA_LINES 原样搬回） */
    const sd = pkg.STATION_DATA || { builtAt: '-', source: '未接入', ev: [], fuel: [] };
    const header = `/* ============================================================================
 * ${B.meta.name.replace(/ 🚗$/, '')} · 线路数据包（route-defs/${ROUTE_ID}.js）
 *
 * 本包由 tools/build-route.js 构建（${builtAt}，数据源 ${SOURCE}）。
 * 维护边界：ROUTE_BUILD 是【人写输入契约】（途经点/分段/文案/行政区），改线路改它；
 *           其余数据段由构建脚本生成，勿手改；站点由 tools/build-stations.js 生成。
 * 数据口径：
 *   - 轨迹：${SOURCE === 'amap' ? '高德驾车路径规划 v3（restapi.amap.com，GCJ-02 真实道路几何，途经点拆子段拼接）' : '腾讯 WebService 驾车 v1（⚠️ 无 Key 未验证）'}
 *   - 高程：open-meteo Elevation 沿轨迹每 ~2.5km 采样${degradedElev ? '（⚠️ 部分降级：open-meteo 不可达段为途经点标称海拔插值）' : '（GCJ-02 轨迹近似反算 WGS-84 后采样；垭口标注用标称值，因驾车轨迹走隧道时 DEM 采到隧道高程）'}
 *   - 站点：${sd.ev && sd.ev.length || sd.fuel && sd.fuel.length ? sd.source + '（' + sd.builtAt + '，' + (sd.ev || []).length + ' 充电 + ' + (sd.fuel || []).length + ' 加油）' : '未接入（STATION_DATA.ev/fuel = []，UI 显示"未接入"）'}
 *
 * 结构说明：
${(B.starts || []).length < 2 ? ' *   - ROUTE_STARTS 单出发地：无「双基准」概念，引擎隐藏出发地切换按钮\n' : ''}${pkg.CLASSIC && pkg.CLASSIC.simplified && pkg.CLASSIC.simplified.length ? '' : ' *   - CLASSIC = 空（无经典支线概念）\n'} *   - 站点 km 基准见 STATION_DATA.datumStartKm，与 ALT/ALT_MARKS/CORE.altKm 的同基准关系经 ROUTE_STARTS[].stationKm0 声明
 *
 * 页面通过 <script src> 加载；?route=${ROUTE_ID} 切换（默认 qinghai-gansu）。
 * ========================================================================== */`;

    const lines = [header, ''];
    function emit(name, value) { lines.push('var ' + name + ' = ' + JSON.stringify(value) + ';', ''); }
    emit('ROUTE_META', Object.assign({ key: ROUTE_ID }, B.meta));
    lines.push('/* ============ ROUTE_BUILD：人写输入契约（途经点/分段/标注/文案/行政区） ============',
        '   构建脚本（tools/build-route.js / build-stations.js）只读本段 + 拉取数据，',
        '   重新生成其余数据段。改线路 = 改这里，然后重跑构建。 */',
        'var ROUTE_BUILD = ' + JSON.stringify(B, null, 2) + ';', '');
    emit('ALT_REAL', ALT_REAL);
    emit('ALT_MARKS', ALT_MARKS);
    lines.push('var ALT = (function () {', // 与青甘包同一合成逻辑（引擎 altSeries 依赖此形状）
        '    var m = {}, out = [];',
        '    ALT_MARKS.forEach(function (p) { m[p.km] = p; });',
        '    ALT_REAL.forEach(function (p) { out.push(m[p[0]] || { km: p[0], alt: p[1] }); });',
        '    ALT_MARKS.forEach(function (p) {',
        '        if (!out.some(function (q) { return q.km === p.km; })) out.push(p);',
        '    });',
        '    out.sort(function (a, b) { return a.km - b.km; });',
        '    return out;',
        '})();', '');
    emit('TOTAL_XN', totalKm);
    emit('CORE', CORE);
    emit('TAIL', TAIL);
    emit('CLASSIC', pkg.CLASSIC || { name: '', km: 0, apiKm: 0, roads: [], simplified: [], elev: [] });
    emit('CITIES', CITIES);
    emit('SPOTS', SPOTS);
    emit('STATION_DATA', sd);
    emit('EXTRA_LINES', pkg.EXTRA_LINES || []);
    lines.push('/* ============ 出发地体系（S2 起进数据契约；引擎只读本契约，不认具体城市） ============',
        '   带接入段的出发地由 ROUTE_BUILD.starts[].leadLegId 声明，构建时展开为',
        '   offsetKm/head/leadPath/firstDay/lastDay；单出发地线路无这些字段。 */',
        'var ROUTE_STARTS = ' + JSON.stringify(ROUTE_STARTS, null, 4) + ';', '');

    fs.writeFileSync(PKG_FILE, lines.join('\n'));
    console.log('\n已写出 ' + PKG_FILE + '（' + fs.statSync(PKG_FILE).size + ' bytes）');
    days.forEach(d => console.log('D' + d.id + ' ' + d.title + ': ' + d.km + 'km ↑' + d.up + '↓' + d.down + ' ' + d.minAlt + '-' + d.maxAlt + 'm'));
    // STATION_DATA.totalKm 是 apiKm 缩放的投影总长，totalKm 是轨迹线累计长，两者口径不同，
    // 差 <1% 属正常（同一条轨迹）；只有轨迹真的变了（超 1%）才需要重跑 build-stations
    if (sd.builtAt !== '-' && sd.totalKm && Math.abs(sd.totalKm - totalKm) / totalKm > 0.01) {
        console.log('⚠️ 路线总里程已变（' + sd.totalKm + ' → ' + totalKm + '），请重跑 tools/build-stations.js ' + ROUTE_ID + ' 重投影站点');
    }
})().catch(e => { console.error('构建失败:', e.message); process.exit(1); });
