/* ============================================================
   build-route.js — Node 侧构建「真实公路轨迹 + 真实高程」
   数据源：
     1) 腾讯地图 WebService 驾车路线规划（apis.map.qq.com）→ 真实国道/高速轨迹、里程、道路名
     2) open-meteo Elevation API → 真实海拔
   输出：route-real-data.js（var ROUTE_REAL = {...}）
   用法：node build-route.js <腾讯WebServiceKey>
   ============================================================ */
const fs = require('fs');
const path = require('path');
const https = require('https');
const dir = __dirname;

const KEY = (process.argv[2] || process.env.TMAP_KEY || '').trim();
if (!KEY) { console.error('用法: node build-route.js <腾讯WebServiceKey>'); process.exit(1); }

/* --- 关键节点（真实坐标 lat,lng），保证路线走对路 --- */
const W = {
    lanzhou: [36.0611, 103.8343],
    haidong: [36.5020, 102.1040],
    xining: [36.6171, 101.7782],
    taersi: [36.4904, 101.5686],
    lajishan: [36.4320, 101.7080],
    daotanghe: [36.4440, 100.9380],
    erlangjian: [36.5820, 100.4880],
    heimahe: [36.7290, 99.7850],
    xiangpishan: [36.7900, 99.4320],
    chaka: [36.7576, 99.1014],
    wulan: [36.9320, 98.4810],
    delingha: [37.3740, 97.3710],
    dachaidan: [37.8240, 95.3570],
    dangjinshan: [39.0250, 94.2840],
    aksai: [39.6340, 94.3410],
    dunhuang: [40.1421, 94.6617],
    guazhou: [40.5177, 95.7826],
    yumen: [40.2950, 96.9750],
    jiayuguan: [39.7724, 98.2778],
    linze: [39.1450, 100.0950],
    zhangye: [38.9303, 100.4542],
    minle: [38.4286, 100.8186],
    biandukou: [38.1290, 101.0050],
    ebao: [37.8490, 101.1180],
    qilian: [38.1789, 100.2478],
    menyuan: [37.3769, 101.6199],
    dabanshan: [37.1930, 101.7230],
    datong: [36.9349, 101.6836]
};

/* --- 10 段行程（不带途经点：实测腾讯自主规划即沿 G6/G109/G315/G215/G227/G213，
       加途经点反而因坐标吸附错误导致绕远——如张掖→祁连带途经点 840km vs 无途经点 237km） --- */
const LEGS = [
    { id: 1, name: '西宁 → 青海湖二郎剑', from: 'xining', to: 'erlangjian', via: [] },
    { id: 2, name: '二郎剑 → 茶卡盐湖', from: 'erlangjian', to: 'chaka', via: [] },
    { id: 3, name: '茶卡 → 德令哈', from: 'chaka', to: 'delingha', via: [] },
    { id: 4, name: '德令哈 → 大柴旦', from: 'delingha', to: 'dachaidan', via: [] },
    { id: 5, name: '大柴旦 → 敦煌', from: 'dachaidan', to: 'dunhuang', via: [] },
    { id: 7, name: '敦煌 → 嘉峪关', from: 'dunhuang', to: 'jiayuguan', via: [] },
    { id: 8, name: '嘉峪关 → 张掖', from: 'jiayuguan', to: 'zhangye', via: [] },
    { id: 9, name: '张掖 → 祁连', from: 'zhangye', to: 'qilian', via: [] },
    { id: 10, name: '祁连 → 门源 → 西宁', from: 'qilian', to: 'xining', via: [] },
    { id: 11, name: '兰州 → 西宁', from: 'lanzhou', to: 'xining', via: [] }
];

function getJSON(url, retries) {
    retries = retries === undefined ? 3 : retries;
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'qgl-route-builder/1.0' } }, res => {
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

/* 腾讯 polyline 差分解压 → [[lat,lng], ...] */
function decodePolyline(coors) {
    const out = [];
    const buf = coors.slice();
    for (let i = 2; i < buf.length; i++) buf[i] = buf[i - 2] + buf[i] / 1000000;
    for (let i = 0; i + 1 < buf.length; i += 2) out.push([buf[i], buf[i + 1]]);
    return out;
}

/* 拉一段真实驾驶轨迹 */
async function fetchLeg(leg) {
    const f = W[leg.from], t = W[leg.to];
    let url = `https://apis.map.qq.com/ws/direction/v1/driving/?from=${f[0]},${f[1]}&to=${t[0]},${t[1]}&output=json&key=${KEY}`;
    if (leg.via && leg.via.length) url += '&waypoints=' + leg.via.map(k => W[k][0] + ',' + W[k][1]).join(';');
    const j = await getJSON(url);
    if (j.status !== 0) throw new Error('腾讯API status=' + j.status + ' ' + j.message);
    const route = j.result.routes[0];

    // 解压 + 去重
    let pl = decodePolyline(route.polyline);
    const seen = {}, dedup = [];
    pl.forEach(p => {
        const k = p[0].toFixed(6) + ',' + p[1].toFixed(6);
        if (!seen[k]) { seen[k] = 1; dedup.push([+p[0].toFixed(6), +p[1].toFixed(6)]); }
    });

    // 道路名（过滤噪声 + 清洗乱码字符）
    const roads = [];
    (route.steps || []).forEach(s => {
        let rn = (s.road_name || '').replace(/[\uFFFD]/g, '').trim();
        if (!rn || rn === '内部道路') return;
        if (roads.indexOf(rn) < 0) roads.push(rn);
    });

    return {
        id: leg.id, name: leg.name,
        apiKm: +(route.distance / 1000).toFixed(1),
        duration: route.duration,
        toll: route.toll || 0,
        polyline: dedup,
        roads: roads
    };
}

/* Haversine 里程 */
function haversine(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

/* --- Node 侧补真实高程（open-meteo，50 点/批，URL 过长会被拒） --- */
async function fillElevation(legs) {
    const total = legs.reduce((a, l) => a + l.elev.length, 0);
    let done = 0;
    for (const leg of legs) {
        for (let i = 0; i < leg.elev.length; i += 50) {
            const batch = leg.elev.slice(i, i + 50);
            const lat = batch.map(p => p[2].toFixed(5)).join(',');
            const lng = batch.map(p => p[3].toFixed(5)).join(',');
            const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`;
            let j = null;
            for (let r = 0; r < 4 && !j; r++) {
                try {
                    const o = await getJSON(url, 1);
                    if (o && o.elevation && o.elevation.length === batch.length) j = o;
                } catch (e) { /* retry */ }
                if (!j) await sleep(1200);
            }
            if (!j) { console.error(`\n  ⚠️ D${leg.id} @${i} 高程缺失(重试4次)，插值兜底`); continue; }
            j.elevation.forEach((e, n) => { batch[n][1] = Math.round(e); });
            done += batch.length;
            process.stdout.write(`\r  高程采样 ${done}/${total}   `);
            await sleep(450);
        }
    }
    console.log('');
    // 缺失插值
    legs.forEach(leg => {
        for (let i = 0; i < leg.elev.length; i++) {
            if (!leg.elev[i][1]) {
                const prev = leg.elev.slice(0, i).reverse().find(p => p[1]);
                const next = leg.elev.slice(i + 1).find(p => p[1]);
                leg.elev[i][1] = prev && next ? Math.round((prev[1] + next[1]) / 2) : ((prev || next || [0, 2000])[1]);
            }
        }
    });
}

(async () => {
    const RESULT = { builtAt: new Date().toISOString().slice(0, 10), source: '腾讯地图 WebService 驾车路线 + open-meteo 高程', legs: [] };
    for (const leg of LEGS) {
        process.stdout.write(`[${leg.id}] ${leg.name} ... `);
        const d = await fetchLeg(leg);
        await sleep(400); // 规避 WebService QPS 限制
        // 累计里程
        const cum = [0];
        for (let j = 1; j < d.polyline.length; j++) cum.push(cum[j - 1] + haversine(d.polyline[j - 1], d.polyline[j]));
        d.km = +cum[cum.length - 1].toFixed(1);
        // 抽稀轨迹（保留 ≤240 点）
        const keep = Math.min(d.polyline.length, 240);
        let simp = d.polyline;
        if (d.polyline.length > keep) {
            simp = [];
            for (let i = 0; i < keep; i++) simp.push(d.polyline[Math.round(i * (d.polyline.length - 1) / (keep - 1))]);
        }
        d.simplified = simp.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]);
        // 沿轨迹按 ~2.5km 采样高程点
        let sample = [], sIdx = [], nextKm = 0;
        for (let k = 0; k < d.polyline.length; k++) {
            if (cum[k] >= nextKm) { sample.push(d.polyline[k]); sIdx.push(k); nextKm = cum[k] + 2.5; }
        }
        if (sIdx[sIdx.length - 1] !== d.polyline.length - 1) {
            sample.push(d.polyline[d.polyline.length - 1]); sIdx.push(d.polyline.length - 1);
        }
        d.elev = sample.map((p, n) => [+cum[sIdx[n]].toFixed(2), 0, +p[0].toFixed(5), +p[1].toFixed(5)]);
        delete d.polyline;
        RESULT.legs.push(d);
        console.log(`${d.simplified.length}点 高程${d.elev.length} ${d.km}km 路:${d.roads.slice(0, 6).join('+')}`);
    }

    console.log('\n--- 拉取真实高程（open-meteo）---');
    await fillElevation(RESULT.legs);

    const js = '// 青甘大环线真实公路路线 + 真实高程（构建于 ' + RESULT.builtAt + '）\n' +
        '// 数据源：腾讯地图 WebService 驾车路线（真实国道/高速轨迹与道路名）+ open-meteo Elevation（真实海拔）\n' +
        'var ROUTE_REAL = ' + JSON.stringify(RESULT) + ';\n';
    fs.writeFileSync(path.join(dir, 'route-real-data.js'), js);
    console.log('\nroute-real-data.js 已写出: ' + js.length + ' bytes');

    RESULT.legs.forEach(l => {
        const alts = l.elev.map(p => p[1]);
        let up = 0, down = 0;
        for (let i = 1; i < alts.length; i++) { const dd = alts[i] - alts[i - 1]; if (dd > 0) up += dd; else down -= dd; }
        console.log(`D${l.id} ${l.name}: ${l.km}km(API ${l.apiKm}) 简化${l.simplified.length}点 高程${alts.length}点 ${Math.min(...alts)}-${Math.max(...alts)}m ↑${Math.round(up)}↓${Math.round(down)} 路:${l.roads.slice(0, 5).join('+')}`);
    });
})().catch(e => { console.error('构建失败:', e.message); process.exit(1); });
