/* ============================================================
   db-seed.js — 共享库种子迁移（S10，一次性留档）
   从三个现有线路包反向种子入库：
     stations.json ← 各包 STATION_DATA（GCJ-02 → WGS-84 转回基准值；
                     vendor 按包内 source 标注：青甘=tencent，川西/318=amap）
     spots.json    ← 各包 CITIES（category=city）+ SPOTS（category=spot）
     regions.json  ← 各包 ROUTE_BUILD.poiRegions
   用法：node tools/db-seed.js
   ============================================================ */
const fs = require('fs');
const { loadRoutePackage, gcj2wgs, ROOT } = require('./lib/build-lib');
const { readDb, writeDb, upsertStation } = require('./lib/db-lib');

const ROUTES = ['qinghai-gansu', 'chuanxi', 'chengdu-lhasa-318'];

function vendorOf(sd) {
    return (sd.source || '').indexOf('腾讯') >= 0 ? 'tencent' : 'amap';
}

/* ---- stations ---- */
const stationDb = readDb('stations.json', { version: 1, stations: [] });
let seeded = 0, merged = 0;
ROUTES.forEach(id => {
    const { pkg } = loadRoutePackage(id);
    const sd = pkg.STATION_DATA;
    const vendor = vendorOf(sd);
    (sd.ev || []).concat(sd.fuel || []).forEach(st => {
        const w = gcj2wgs(st.lat, st.lng);
        const rec = {
            name: st.t,
            // 类型判定：含「充电」即 ev（腾讯类目是「汽车:加油站:充电站」，含两个词，必须先判充电）
            type: (st.cat || '').indexOf('充电') >= 0 ? 'ev' : 'fuel',
            brand: st.op || '', address: st.a || '', kind: '', tel: st.tel || '',
            lat: +w[0].toFixed(6), lng: +w[1].toFixed(6),
            srcCoord: { lat: st.lat, lng: st.lng, sys: 'gcj02' },
            slow: st.slow || 0, cat: st.cat || '',
            sources: [{ vendor, sourceId: '', fetchedAt: sd.builtAt, routeId: id }]
        };
        const r = upsertStation(stationDb, rec);
        r.merged ? merged++ : seeded++;
    });
    console.log(id + '：站点入库（厂商=' + vendor + '，数据日期 ' + sd.builtAt + '）');
});
writeDb('stations.json', stationDb);
console.log('stations.json：新增 ' + seeded + '，合并 ' + merged + '，总计 ' + stationDb.stations.length);

/* ---- spots（CITIES/SPOTS；autoCaptured=false 区分将来「抓的候选」） ---- */
const spotDb = readDb('spots.json', { version: 1, spots: [] });
let sNew = 0, sMerged = 0;
ROUTES.forEach(id => {
    const { pkg } = loadRoutePackage(id);
    const today = new Date().toISOString().slice(0, 10);
    (pkg.CITIES || []).map(c => ({ c, cat: 'city' })).concat((pkg.SPOTS || []).map(c => ({ c, cat: 'spot' })))
        .forEach(({ c, cat }) => {
            const w = gcj2wgs(c.p[0], c.p[1]);
            const hit = spotDb.spots.filter(s => s.name === c.n && s.category === cat)[0];
            if (hit) {
                if (hit.routes.indexOf(id) < 0) hit.routes.push(id);
                if (!hit.desc && c.d) hit.desc = c.d;
                sMerged++;
            } else {
                spotDb.spots.push({
                    id: 'spo-' + cat + '-' + spotDb.spots.length,
                    name: c.n, category: cat,
                    lat: +w[0].toFixed(6), lng: +w[1].toFixed(6),
                    srcCoord: { lat: c.p[0], lng: c.p[1], sys: 'gcj02' },
                    desc: c.d || '', routes: [id],
                    autoCaptured: false, source: 'manual', updatedAt: today
                });
                sNew++;
            }
        });
});
writeDb('spots.json', spotDb);
console.log('spots.json：新增 ' + sNew + '，并线 ' + sMerged + '，总计 ' + spotDb.spots.length);

/* ---- regions ---- */
const regionDb = readDb('regions.json', { version: 1, regions: [] });
ROUTES.forEach(id => {
    const { pkg } = loadRoutePackage(id);
    (pkg.ROUTE_BUILD.poiRegions || []).forEach(name => {
        const hit = regionDb.regions.filter(r => r.name === name)[0];
        if (hit) { if (hit.usedBy.indexOf(id) < 0) hit.usedBy.push(id); }
        else regionDb.regions.push({ name, usedBy: [id], purpose: 'poi-enumeration', source: 'ROUTE_BUILD' });
    });
});
writeDb('regions.json', regionDb);
console.log('regions.json：总计 ' + regionDb.regions.length + ' 个行政区（含用途与来源线）');
