/* 拉「西宁→塔尔寺→拉脊山→倒淌河」经典支线（AVOID_HIGHWAY 走 G227 翻拉脊山）+ 真实高程 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const dir = __dirname;
const KEY = process.argv[2];

function g(url, retries) {
    retries = retries === undefined ? 3 : retries;
    return new Promise((res, rej) => {
        const rq = https.get(url, { headers: { 'User-Agent': 'qgl/1.0' } }, r => {
            let d = ''; r.on('data', c => d += c);
            r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error('HTTP ' + r.statusCode)); } });
        });
        rq.on('error', e => { if (retries > 0) setTimeout(() => g(url, retries - 1).then(res, rej), 900); else rej(e); });
    });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function dec(coors) { const o = [], b = coors.slice(); for (let i = 2; i < b.length; i++) b[i] = b[i - 2] + b[i] / 1000000; for (let i = 0; i + 1 < b.length; i += 2) o.push([b[i], b[i + 1]]); return o; }
function hav(a, b) { const R = 6371, rd = Math.PI / 180; const dl = (b[0] - a[0]) * rd, dg = (b[1] - a[1]) * rd; const s = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * rd) * Math.cos(b[0] * rd) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); }

(async () => {
    // 经典支线：西宁 → 塔尔寺 → 拉脊山垭口(36.30,101.28) → 倒淌河；不走高速
    const url = 'https://apis.map.qq.com/ws/direction/v1/driving/' +
        '?from=36.6171,101.7782&to=36.4440,100.9380' +
        '&waypoints=36.4904,101.5686;36.3000,101.2800' +
        '&policy=AVOID_HIGHWAY&output=json&key=' + KEY;
    const j = await g(url);
    if (j.status !== 0) throw new Error('status=' + j.status + ' ' + j.message);
    const rt = j.result.routes[0];
    let pl = dec(rt.polyline);
    const seen = {}, dd = [];
    pl.forEach(p => { const k = p[0].toFixed(6) + ',' + p[1].toFixed(6); if (!seen[k]) { seen[k] = 1; dd.push(p); } });
    const roads = [];
    rt.steps.forEach(s => { const rn = (s.road_name || '').replace(/[\uFFFD]/g, '').trim(); if (rn && rn !== '内部道路' && roads.indexOf(rn) < 0) roads.push(rn); });

    // 累计里程 + 抽稀
    const cum = [0];
    for (let i = 1; i < dd.length; i++) cum.push(cum[i - 1] + hav(dd[i - 1], dd[i]));
    const km = cum[cum.length - 1];
    const keep = Math.min(dd.length, 240);
    const simp = [];
    for (let i = 0; i < keep; i++) simp.push(dd[Math.round(i * (dd.length - 1) / (keep - 1))]);

    // 高程采样（~2.5km）
    let sample = [], sIdx = [], nextKm = 0;
    for (let k = 0; k < dd.length; k++) { if (cum[k] >= nextKm) { sample.push(dd[k]); sIdx.push(k); nextKm = cum[k] + 2.5; } }
    if (sIdx[sIdx.length - 1] !== dd.length - 1) { sample.push(dd[dd.length - 1]); sIdx.push(dd.length - 1); }
    const elev = sample.map((p, n) => [+cum[sIdx[n]].toFixed(2), 0, +p[0].toFixed(5), +p[1].toFixed(5)]);

    console.log('支线', km.toFixed(1), 'km, 抽稀', simp.length, '点, 高程采样', elev.length, '点');
    console.log('道路:', roads.join(' > '));

    // 补高程
    let done = 0;
    for (let i = 0; i < elev.length; i += 50) {
        const batch = elev.slice(i, i + 50);
        const u = 'https://api.open-meteo.com/v1/elevation?latitude=' + batch.map(p => p[2].toFixed(5)).join(',') +
            '&longitude=' + batch.map(p => p[3].toFixed(5)).join(',');
        let ok = null;
        for (let r = 0; r < 4 && !ok; r++) {
            try { const o = await g(u, 1); if (o && o.elevation && o.elevation.length === batch.length) ok = o; } catch (e) { }
            if (!ok) await sleep(1200);
        }
        if (ok) { ok.elevation.forEach((v, n) => batch[n][1] = Math.round(v)); done += batch.length; }
        else console.error('  ⚠️ @' + i + ' 缺失');
        process.stdout.write('\r  高程 ' + done + '/' + elev.length + '   ');
        await sleep(450);
    }
    console.log('');

    const RES = {
        name: '西宁 → 塔尔寺 → 拉脊山 → 倒淌河（经典线·不走高速）',
        km: +km.toFixed(1), apiKm: +(rt.distance / 1000).toFixed(1),
        roads, simplified: simp.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]), elev
    };
    fs.writeFileSync(path.join(dir, 'route-classic-branch.js'),
        '// 经典支线（西宁→塔尔寺→拉脊山→倒淌河，AVOID_HIGHWAY 走 G227/扎哈公路）\n' +
        '// 数据源：腾讯地图 WebService 驾车路线 + open-meteo 高程\n' +
        'var ROUTE_CLASSIC = ' + JSON.stringify(RES) + ';\n');
    const alts = elev.map(e => e[1]);
    console.log('route-classic-branch.js 已写出; 海拔', Math.min(...alts), '-', Math.max(...alts), 'm');
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
