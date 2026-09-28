/* ============================================================
   build-probe-route.js — 川西小环线「探针包」构建器（S1.5）
   定位：平台化改造的探针，目的是让引擎同时加载两条线、暴露写死青甘的
   假设。正式构建管线（S3）会参数化，本脚本届时退役或重写。

   数据源：
     1) OSRM 公共路由（router.project-osrm.org，OSM 数据，免费无需 Key）
        → 真实驾车轨迹（WGS-84 坐标）
     2) WGS84 → GCJ-02 转换（火星坐标，标准公开算法）——腾讯地图用 GCJ-02，
        不转会在国内地图上偏移几百米
     3) open-meteo Elevation API → 真实海拔（与 build-route.js 相同的分批/插值做法）

   降级策略（不许静默失败）：
     - OSRM 不通 → 途经点直线插值几何，产出文件头注明「降级轨迹」
       （可用 PROBE_OFFLINE=1 强制走该分支验证）
     - open-meteo 不通 → 用途经点标称海拔插值，文件头注明「降级高程」

   用法：node build-probe-route.js
   输出：../route-defs/chuanxi.js
   ============================================================ */
const fs = require('fs');
const path = require('path');
const https = require('https');
const dir = __dirname;
const ROOT = path.resolve(dir, '..');

/* --- 途经点（WGS-84，lat,lng；alt 为标称海拔，仅作 open-meteo 失败时的降级插值） --- */
const W = {
    chengdu:      { n: '成都',       p: [30.657, 104.066], alt: 500,  d: '环线起终点。出发满油/满电、检查胎压——后面要翻 4298m 折多山。' },
    dujiangyan:   { n: '都江堰',     p: [30.989, 103.606], alt: 700,  d: '成都平原西缘，都江堰景区在此，出城第一站。' },
    yingxiu:      { n: '映秀',       p: [31.063, 103.485], alt: 900,  d: '5·12 汶川特大地震震中，G213 沿线纪念地。' },
    wolong:       { n: '卧龙',       p: [31.020, 103.160], alt: 2000, d: '大熊猫栖息地，进山前最后一个低海拔补给点。' },
    siguniang:    { n: '四姑娘山镇', p: [31.005, 102.838], alt: 3200, d: '日隆镇，游览双桥沟/长坪沟的基地，注意高反。' },
    xiaojin:      { n: '小金',       p: [30.999, 102.363], alt: 2300, d: '小金县城，四姑娘山—丹巴之间的河谷城镇。' },
    danba:        { n: '丹巴',       p: [30.878, 101.891], alt: 1800, d: '大渡河上游，甲居藏寨观景台在县城以北。' },
    bamei:        { n: '八美',       p: [30.478, 101.555], alt: 3500, d: '道孚八美镇，亚拉雪山观景沿线的补给点。' },
    tagong:       { n: '塔公',       p: [30.315, 101.524], alt: 3700, d: '塔公草原与塔公寺，天气好时远眺亚拉雪山。' },
    xinduqiao:    { n: '新都桥',     p: [30.042, 101.494], alt: 3300, d: '「摄影天堂」，G318 与 G248 交汇，光影著名。' },
    kangding:     { n: '康定',       p: [30.050, 101.957], alt: 2500, d: '甘孜州府，翻折多山前最后的大城市，补给充足。' },
    luding:       { n: '泸定',       p: [29.914, 102.234], alt: 1300, d: '大渡河畔，泸定桥纪念地，海拔骤降的休整点。' },
    yaan:         { n: '雅安',       p: [30.010, 103.013], alt: 600,  d: '雨城，回成都前最后的补给与检查点。' }
};

/* --- 分段初稿：D1 成都→四姑娘山镇 … D5 泸定→成都（环线） --- */
const LEGS = [
    { id: 1, title: '成都 → 四姑娘山镇', zoom: 7.6, note: '都江堰 · 映秀 · 卧龙 · 巴朗山（现走隧道）',
      via: ['chengdu', 'dujiangyan', 'yingxiu', 'wolong', 'siguniang'] },
    { id: 2, title: '四姑娘山镇 → 丹巴', zoom: 8.4, note: '小金 · 牦牛河谷一路下降',
      via: ['siguniang', 'xiaojin', 'danba'] },
    { id: 3, title: '丹巴 → 新都桥', zoom: 7.9, note: '八美 · 亚拉雪山 · 塔公草原',
      via: ['danba', 'bamei', 'tagong', 'xinduqiao'] },
    { id: 4, title: '新都桥 → 泸定', zoom: 8.0, note: '折多山垭口(4298m) · 康定',
      via: ['xinduqiao', 'kangding', 'luding'] },
    { id: 5, title: '泸定 → 成都', zoom: 7.2, note: '雅安 · 成雅高速回程',
      via: ['luding', 'yaan', 'chengdu'] }
];

/* --- 海拔标注（WGS-84；pass=垭口。alt 为标称值，垭口用标称值因为驾车轨迹走隧道时
       DEM 采到的是隧道高程，与「垭口」这个地理事实不符，文件头已注明） --- */
const MARKS = [
    { n: '巴朗山垭口', p: [30.915, 102.908], alt: 4480, pass: true },
    { n: '折多山垭口', p: [30.176, 101.839], alt: 4298, pass: true },
    { n: '亚拉雪山观景台', p: [30.462, 101.572] }
];

/* --- 景点（手打文案，探针精度） --- */
const SPOT_DEFS = [
    { n: '都江堰景区', p: [30.998, 103.605], d: '千年水利工程，成都平原的起点。游览约 2–3 小时。' },
    { n: '映秀震中遗址', p: [31.059, 103.486], d: '5·12 汶川特大地震震中纪念地，免费参观，请保持肃穆。' },
    { n: '巴朗山垭口', p: [30.915, 102.908], d: '4480m | 卧龙—四姑娘山之间的历史垭口，现驾车走巴朗山隧道（约 3850m），垭口老路需专程前往。' },
    { n: '四姑娘山·双桥沟', p: [31.034, 102.798], d: '3200–3800m | 四姑娘山最易到达的沟，观光车直达，布达拉峰视角经典。' },
    { n: '亚拉雪山观景台', p: [30.462, 101.572], d: '八美—塔公沿线远眺亚拉雪山（5820m）的最佳机位之一。' },
    { n: '塔公草原·木雅金塔', p: [30.318, 101.523], d: '3700m | 塔公寺与金塔同框，背景即亚拉雪山。' },
    { n: '折多山垭口', p: [30.176, 101.839], d: '4298m | G318 康巴第一关，新都桥—康定必经，冬季易结冰暗冰。' },
    { n: '泸定桥', p: [29.914, 102.234], d: '大渡河上的铁索桥，红军飞夺泸定桥纪念地，县城停车后步行可达。' }
];

function getJSON(url, retries) {
    retries = retries === undefined ? 3 : retries;
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'chuanxi-probe-builder/1.0' } }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve(JSON.parse(d)); }
                catch (e) { reject(new Error('HTTP ' + res.statusCode + ' ' + d.slice(0, 120))); }
            });
        });
        req.on('error', e => {
            if (retries > 0) setTimeout(() => getJSON(url, retries - 1).then(resolve, reject), 900);
            else reject(e);
        });
    });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function haversine(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

/* --- WGS84 → GCJ-02（火星坐标）标准公开算法，约 30 行。
       来源：国内地图坐标转换的通用实现（transformLat/transformLng 多项式逼近，
       与高德/腾讯文档描述的算法一致）。局限：仅对中国大陆有效（境外不偏移）；
       是区域性逼近而非精确基准变换，误差通常在米级——探针阶段够用，
       正式数据仍以腾讯/高德系坐标为准（S3 管线参数化时替换数据源）。 --- */
const GCJ_A = 6378245.0, GCJ_EE = 0.00669342162296594323;
function outOfChina(lat, lng) {
    return (lng < 72.004 || lng > 137.8347) || (lat < 0.8293 || lat > 55.8271);
}
function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return ret;
}
function transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return ret;
}
function wgs2gcj(lat, lng) {
    if (outOfChina(lat, lng)) return [lat, lng];
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - GCJ_EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [lat + dLat, lng + dLng];
}

/* --- 拉一段 OSRM 真实驾车几何（WGS-84）。失败返回 null（调用方降级） --- */
async function fetchLeg(leg) {
    const coords = leg.via.map(k => W[k].p[1] + ',' + W[k].p[0]).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`;
    try {
        const j = await getJSON(url, 2);
        if (j.code !== 'Ok' || !j.routes || !j.routes.length) throw new Error('code=' + j.code);
        const r = j.routes[0];
        // 道路名过滤：OSM step 名混有市区街巷与断链关系名（"理县 - 石棉"这类），
        // 只保留有导航意义的干线名（高速/公路/国道/省道/隧道/环线等）
        const roads = [];
        (r.legs || []).forEach(function (l) {
            (l.steps || []).forEach(function (s) {
                const nm = (s.name || '').trim();
                if (!nm || / - |－/.test(nm)) return;
                if (!/(高速|公路|国道|省道|隧道|环线|沪聂线|G\d|S\d)/.test(nm)) return;
                if (/大道/.test(nm)) return; // 市区主干道（西芯大道等）无导航意义
                if (roads.indexOf(nm) < 0) roads.push(nm);
            });
        });
        return { distance: r.distance / 1000, coords: r.geometry.coordinates.map(c => [c[1], c[0]]), roads: roads };
    } catch (e) {
        console.error('  ⚠️ OSRM D' + leg.id + ' 失败（' + e.message + '）→ 降级为直线插值');
        return null;
    }
}

/* --- 降级几何：途经点之间直线插值（每 ~1.5km 一点） --- */
function fallbackGeometry(viaKeys) {
    const pts = [];
    for (let i = 0; i < viaKeys.length - 1; i++) {
        const a = W[viaKeys[i]].p, b = W[viaKeys[i + 1]].p;
        const d = haversine(a, b);
        const n = Math.max(2, Math.ceil(d / 1.5));
        for (let k = 0; k <= n; k++) {
            if (i > 0 && k === 0) continue;
            pts.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
        }
    }
    return pts;
}

/* --- open-meteo 高程（50 点/批，失败返回 null 走标称海拔插值） --- */
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
        await sleep(450);
    }
    return out;
}

(async () => {
    const builtAt = new Date().toISOString().slice(0, 10);
    let degradedRoute = false, degradedElev = false;

    /* 1) 逐段拉几何（WGS-84） */
    console.log('--- OSRM 拉取真实驾车轨迹 ---');
    const legGeoms = [];
    for (const leg of LEGS) {
        process.stdout.write('D' + leg.id + ' ' + leg.title + ' ... ');
        const r = process.env.PROBE_OFFLINE ? null : await fetchLeg(leg);
        let geom, apiKm, roads;
        if (r) {
            geom = r.coords; apiKm = +r.distance.toFixed(1); roads = r.roads;
            console.log(geom.length + '点 ' + apiKm + 'km 路:' + roads.slice(0, 5).join('+'));
        } else {
            degradedRoute = true;
            geom = fallbackGeometry(leg.via); apiKm = null; roads = [];
            console.log('降级 ' + geom.length + '点（直线插值）');
        }
        await sleep(400); // 公共实例限速保护
        legGeoms.push({ leg: leg, geom: geom, apiKm: apiKm, roads: roads });
    }

    /* 2) 拼全程环（WGS-84 用于高程采样；GCJ-02 用于页面轨迹） */
    const loop = []; // {wgs, gcj, legIdx, cum}
    let cum = 0;
    legGeoms.forEach(function (lg, li) {
        lg.geom.forEach(function (p, pi) {
            if (li > 0 && pi === 0) return; // 段间接缝点去重
            if (loop.length) cum += haversine(loop[loop.length - 1].wgs, p);
            loop.push({ wgs: p, gcj: wgs2gcj(p[0], p[1]), legIdx: li, cum: +cum.toFixed(2) });
        });
    });
    const totalKm = +cum.toFixed(1);
    console.log('\n全程 ' + totalKm + 'km，共 ' + loop.length + ' 个轨迹点');

    /* 3) 沿全程每 ~2.5km 采高程（WGS-84 坐标送 open-meteo） */
    console.log('--- open-meteo 高程采样 ---');
    const sampleIdx = [];
    let nextKm = 0;
    loop.forEach(function (p, i) { if (p.cum >= nextKm) { sampleIdx.push(i); nextKm = p.cum + 2.5; } });
    if (sampleIdx[sampleIdx.length - 1] !== loop.length - 1) sampleIdx.push(loop.length - 1);
    const samples = await fetchElevations(sampleIdx.map(i => loop[i].wgs));
    if (samples.some(a => a == null)) {
        degradedElev = true;
        console.error('  ⚠️ open-meteo 部分失败 → 用途经点标称海拔插值兜底');
        // 标称海拔插值：每个途经点按其累计里程锚定，线性内插
        const anchors = [];
        legGeoms.forEach(function (lg) {
            lg.leg.via.forEach(function (k) {
                // 找该途经点在环上最近点
                let best = 0, bd = 1e9;
                loop.forEach(function (p, i) {
                    const d = haversine(p.wgs, W[k].p);
                    if (d < bd) { bd = d; best = i; }
                });
                anchors.push({ km: loop[best].cum, alt: W[k].alt });
            });
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

    /* 4) 海拔标注：途经点 + MARKS，吸附到最近采样点 */
    const markDefs = [];
    Object.keys(W).forEach(function (k) { markDefs.push({ n: W[k].n, p: W[k].p }); });
    MARKS.forEach(function (m) { markDefs.push(m); });
    const ALT_MARKS = markDefs.map(function (m) {
        const g = wgs2gcj(m.p[0], m.p[1]);
        let best = 0, bd = 1e9;
        ALT_REAL.forEach(function (s, i) {
            const d = haversine(loop[sampleIdx[i]].gcj, g);
            if (d < bd) { bd = d; best = i; }
        });
        const o = { km: ALT_REAL[best][0], alt: m.alt != null ? m.alt : ALT_REAL[best][1], n: m.n };
        if (m.pass) o.pass = true;
        return o;
    }).sort((a, b) => a.km - b.km);

    /* 5) 每日 CORE/TAIL：path（GCJ-02，抽稀 ≤240 点）、altKm、爬升统计 */
    function buildDay(lg) {
        const leg = lg.leg;
        const legPts = [];
        legGeoms.forEach(function (g2, li) {
            if (g2 !== lg) return;
            loop.forEach(function (p) { if (p.legIdx === li) legPts.push(p); });
        });
        const a = legPts[0].cum, b = legPts[legPts.length - 1].cum;
        // 该天范围内的高程采样
        const segAlts = ALT_REAL.filter(s => s[0] >= a - 0.01 && s[0] <= b + 0.01).map(s => s[1]);
        let up = 0, down = 0;
        for (let i = 1; i < segAlts.length; i++) { const d = segAlts[i] - segAlts[i - 1]; if (d > 0) up += d; else down -= d; }
        // 抽稀
        const keep = Math.min(legPts.length, 240);
        const path = [];
        for (let i = 0; i < keep; i++) {
            const p = legPts[Math.round(i * (legPts.length - 1) / (keep - 1))].gcj;
            path.push([+p[0].toFixed(5), +p[1].toFixed(5)]);
        }
        const km = +(b - a).toFixed(0);
        const energy = '本段真实爬升 ' + Math.round(up) + 'm / 下降 ' + Math.round(down) + 'm，海拔 ' +
            Math.min.apply(null, segAlts) + '–' + Math.max.apply(null, segAlts) + 'm。' +
            (up > 800 ? '大爬升段，上坡电耗显著增加（每千爬升约 +4–5 度电）。' : '整体起伏适中，按平路能耗估算即可。') +
            (lg.roads && lg.roads.length ? ' 主要道路：' + lg.roads.slice(0, 4).join('、') + '。' : '') +
            '（探针包：爬升/下降为 open-meteo 沿轨迹采样估算）';
        return {
            id: leg.id, title: leg.title, km: km, zoom: leg.zoom, note: leg.note,
            altKm: [a, b], apiKm: lg.apiKm, up: Math.round(up), down: Math.round(down),
            minAlt: Math.min.apply(null, segAlts), maxAlt: Math.max.apply(null, segAlts),
            roads: lg.roads || [], energy: energy, path: path
        };
    }
    const days = legGeoms.map(buildDay);
    const CORE = days.slice(0, 4);
    const TAIL = days[4];

    /* 6) 城镇 / 景点（GCJ-02） */
    const CITIES = Object.keys(W).map(function (k) {
        const g = wgs2gcj(W[k].p[0], W[k].p[1]);
        const mk = ALT_MARKS.filter(m => m.n === W[k].n)[0];
        return { n: W[k].n, p: [+g[0].toFixed(5), +g[1].toFixed(5)], d: (mk ? mk.alt : W[k].alt) + 'm | ' + W[k].d };
    });
    const SPOTS = SPOT_DEFS.map(function (s) {
        const g = wgs2gcj(s.p[0], s.p[1]);
        return { n: s.n, p: [+g[0].toFixed(5), +g[1].toFixed(5)], d: s.d };
    });

    /* 7) 写出数据包（与 qinghai-gansu.js 相同的顶层 var 全局形状） */
    const gapNotes = [
        '缺口清单（青甘有、川西探针没有的，均给安全空值）：',
        '  - ROUTE_STARTS 单出发地（只有成都）：无「双基准」概念，offsetKm=0、无 leadPath，',
        '    引擎据此隐藏出发地切换按钮（S2 起 startButtons 字段废弃，由 starts.length 决定）',
        '  - CLASSIC = 空（无经典支线概念）；EXTRA_LINES = []（无固定支线）',
        '  - STATION_DATA.ev/fuel = []：无腾讯地图 Key，充电/加油站 POI 未接入',
        '    （契约语义：[] = 该线路未接入此类站点数据，UI 显示"未接入"；续航规划不可用，页面已如实标注）',
        '  - 站点 km 基准 = 成都起算累计里程（xnStart=0），与 ALT/ALT_MARKS/CORE.altKm 同基准',
        '  - S2 起不再产出：LZ_XN_KM / LZ_HEAD / P_LZ_XN（单出发地线路不需要，引擎只读 ROUTE_STARTS）、',
        '    FUELS / EVS（手打示例站变量已全线删除）'
    ];
    const header = `/* ============================================================================
 * 川西小环线 · 线路数据包（route-defs/chuanxi.js）· 探针包（S1.5）
 *
 * 平台化改造 S1.5 探针：让引擎同时加载两条线，暴露引擎里写死青甘的假设。
 * 本包由 tools/build-probe-route.js 构建（${builtAt}）。
 * 数据口径：
${degradedRoute ? ' *   ⚠️ 降级轨迹：OSRM 不可达，几何为途经点直线插值（非真实道路）\n' : ' *   - 轨迹：OSRM 公共路由（OSM 数据）真实驾车几何，WGS-84 → GCJ-02 标准算法转换\n'}${degradedElev ? ' *   ⚠️ 降级高程：open-meteo 不可达，海拔为途经点标称值插值\n' : ' *   - 高程：open-meteo Elevation 沿轨迹每 ~2.5km 采样（垭口标注用标称值，因驾车轨迹走隧道时 DEM 采到隧道高程）\n'} *   - 站点：未接入（见下方缺口清单）——续航规划结果不可用，页面已如实标注
 *
${gapNotes.map(l => ' * ' + l).join('\n')}
 *
 * 页面通过 <script src> 加载；?route=chuanxi 切换（默认 qinghai-gansu）。
 * ========================================================================== */`;

    const lines = [header, ''];
    function emit(name, value) { lines.push('var ' + name + ' = ' + JSON.stringify(value) + ';', ''); }
    emit('ROUTE_META', {
        key: 'chuanxi',
        name: '川西小环线 🚗',
        title: '川西小环线 · 自驾线路图（成都出发 · 探针包）',
        sub: '成都—四姑娘山—丹巴—新都桥—康定 · 探针包：轨迹/高程真实采样，充电/加油站数据未接入',
        direction: '逆时针方向',
        evNotice: '探针数据包：充电/加油站数据未接入，续航规划结果不可用（轨迹与高程为真实采样）',
        probe: true
    });
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
    emit('CLASSIC', { name: '', km: 0, apiKm: 0, roads: [], simplified: [], elev: [] });
    emit('CITIES', CITIES);
    emit('SPOTS', SPOTS);
    emit('STATION_DATA', {
        builtAt: builtAt,
        source: '探针包：充电/加油站数据未接入（无腾讯地图 Key，POI 抓取留待 S3/S4）',
        totalKm: totalKm, xnStart: 0, xnEnd: totalKm, ev: [], fuel: []
    });
    emit('EXTRA_LINES', []);
    // S2 起：出发地体系进数据契约（引擎只读 ROUTE_STARTS，不再产出 LZ_XN_KM/LZ_HEAD/P_LZ_XN）
    lines.push('/* ============ 出发地体系（S2 起进数据契约；引擎只读本契约，不认具体城市） ============',
        '   单出发地线路：starts 只有一项，无 offsetKm/leadPath/head/firstDay/lastDay，',
        '   引擎据此隐藏出发地切换按钮、buildDays 直接返回 CORE+TAIL。',
        '   stationKm0 = 站点里程基准上行程起点的 km（本包与 STATION_DATA.xnStart 同为 0）。 */',
        'var ROUTE_STARTS = [',
        '    ' + JSON.stringify({
            id: 'cd', name: '成都',
            sub: '成都—四姑娘山—丹巴—新都桥—康定 · 探针包：轨迹/高程真实采样，充电/加油站数据未接入',
            offsetKm: 0, stationKm0: 0, totalKm: totalKm
        }),
        '];', '');

    const outPath = path.join(ROOT, 'route-defs', 'chuanxi.js');
    fs.writeFileSync(outPath, lines.join('\n'));
    console.log('\n已写出 ' + outPath + '（' + fs.statSync(outPath).size + ' bytes）');
    days.forEach(d => console.log('D' + d.id + ' ' + d.title + ': ' + d.km + 'km ↑' + d.up + '↓' + d.down + ' ' + d.minAlt + '-' + d.maxAlt + 'm'));
})().catch(e => { console.error('构建失败:', e); process.exit(1); });
