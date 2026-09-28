/* ============================================================
   tools/lib/db-lib.js — 全站共享数据库层（S10）
   库文件：data/db/{stations,spots,regions}.json（进 git，数据即资产）

   坐标策略（厂商中立，已定）：
   - 库内唯一坐标基准 = WGS-84（≈CGCS2000，米级等价）
   - 每条记录保留 srcCoord（原始抓取值+坐标系）与 sources[]（厂商/抓取时间/来源线）
   - 入库时 GCJ-02→WGS-84；物化线路包时 WGS-84→GCJ-02（页面渲染基准，现状零改动）
   - GCJ↔WGS 转换：build-lib.js 的公开算法实现（transformLat/transformLng 多项式逼近，
     中国大陆米级精度；gcj2wgs 为迭代逼近，往返误差 <0.1m，实测见 probe-check）
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { gcj2wgs, wgs2gcj, haversine, ROOT } = require('./build-lib');

const DB_DIR = path.join(ROOT, 'data', 'db');
const FRESH_DAYS = 90;   // 库记录新鲜度：超过则重建时重新抓取

function readDb(name, fallback) {
    const file = path.join(DB_DIR, name);
    if (!fs.existsSync(file)) return fallback;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeDb(name, obj) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    obj.updatedAt = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(DB_DIR, name), JSON.stringify(obj, null, 1));
}

/* ---------- 站点 ---------- */
/* stations.json = { version, updatedAt, stations: [ {
     id, name, type: 'ev'|'fuel', brand, address, kind, tel,
     lat, lng,                        // WGS-84 基准值（库内唯一坐标）
     srcCoord: { lat, lng, sys },     // 原始抓取值
     slow, cat,
     sources: [ { vendor, sourceId, fetchedAt, routeId } ]
   } ] }
   字段语义自定义，不抄厂商结构；跨厂商同站合并保留全部来源记录。 */

function normName(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[\s　]/g, '')
        .replace(/[（(【\[].*?[)）】\]]/g, '')   // 括号后缀（路名/说明）各家不一，归一化时剥掉
        .replace(/(汽车)?充电站$/, '')
        .replace(/加油站$/, '');
}
function distM(a, b) { return haversine([a.lat, a.lng], [b.lat, b.lng]) * 1000; }

/* 同一站点判定（S10 两次修正后的实战版）：
   - 全名相同：50m 内算同站（跨厂商/跨区重复抓取，坐标逐位一致或亚米级）
   - 归一名相同（括号后缀剥掉后）：<30m 且括号内容相似才算同站——
     ・「国家电网(…城市)」vs「国家电网(…城市公共充电站)」→ 括号内容互含 = 同站（两次构建的命名差）
     ・「乐来电(嘎央登民宿)」vs「乐来电(藏地人家民宿)」→ 不同门店 = 分开（高德把坐标打到了同一点）
     ・「享悦充电(清风雅舍)」vs「享悦充电(桂花林)」→ 相邻门店 = 分开 */
function bracketOf(s) {
    const m = String(s || '').match(/[（(【\[](.*?)[)）】\]]/);
    return m ? m[1] : '';
}
function commonPrefix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
}
function sameStation(a, b) {
    if (a.type !== b.type) return false;
    const d = distM(a, b);
    if (a.name === b.name) return d < 50;
    if (d >= 30 || normName(a.name) !== normName(b.name)) return false;
    const ca = bracketOf(a.name), cb = bracketOf(b.name);
    if (!ca || !cb) return true;
    return ca.indexOf(cb) >= 0 || cb.indexOf(ca) >= 0 || commonPrefix(ca, cb) >= 4;
}

function stationId(rec) {
    return 'sta-' + rec.type + '-' + Math.round(rec.lat * 1e5).toString(36) + Math.round(rec.lng * 1e5).toString(36);
}

/* 入库：命中则合并（追加来源记录，空缺字段用新记录补），未命中则新增 */
function upsertStation(db, rec) {
    const hit = db.stations.filter(s => sameStation(s, rec))[0];
    if (!hit) {
        rec.id = rec.id || stationId(rec);
        rec.sources = rec.sources || [];
        db.stations.push(rec);
        return { merged: false, station: rec };
    }
    (rec.sources || []).forEach(src => {
        const dup = hit.sources.filter(s => s.vendor === src.vendor && s.sourceId === src.sourceId && s.routeId === src.routeId)[0];
        if (!dup) hit.sources.push(src);
        else if (src.fetchedAt > dup.fetchedAt) dup.fetchedAt = src.fetchedAt;
    });
    ['brand', 'address', 'kind', 'tel', 'slow', 'cat'].forEach(k => {
        if ((hit[k] === undefined || hit[k] === '' || hit[k] === null) && rec[k] !== undefined) hit[k] = rec[k];
    });
    return { merged: true, station: hit };
}

function latestFetchedAt(station) {
    return station.sources.reduce((m, s) => (s.fetchedAt > m ? s.fetchedAt : m), '');
}
function isFresh(station, days) {
    const lim = Date.now() - (days || FRESH_DAYS) * 864e5;
    const f = latestFetchedAt(station);
    return !!f && new Date(f + 'T00:00:00').getTime() >= lim;
}

/* 站点记录 → 库记录（lat/lng 转 WGS-84 基准；srcCoord 保留 GCJ 原值） */
function toDbStation(st, vendor, routeId, fetchedAt, sourceId) {
    const w = gcj2wgs(st.lat, st.lng);
    return {
        name: st.t,
        type: (st.cat || '').indexOf('加油') >= 0 ? 'fuel' : 'ev',
        brand: st.op || '', address: st.a || '', kind: '', tel: st.tel || '',
        lat: +w[0].toFixed(6), lng: +w[1].toFixed(6),
        srcCoord: { lat: st.lat, lng: st.lng, sys: 'gcj02' },
        slow: st.slow || 0, cat: st.cat || '',
        sources: [{ vendor, sourceId: sourceId || '', fetchedAt: fetchedAt || '', routeId }]
    };
}

/* 库记录 → 物化站点（GCJ-02 渲染坐标，与既有 STATION_DATA 条目同形） */
function fromDbStation(st) {
    const g = wgs2gcj(st.lat, st.lng);
    return {
        t: st.name, a: st.address || '', tel: st.tel || '',
        lat: +g[0].toFixed(5), lng: +g[1].toFixed(5),
        op: st.brand || '', slow: st.slow || 0, cat: st.cat || ''
    };
}

/* 库内 POI 抓取记录 → 库记录（高德 place/text 原始条目，坐标即 GCJ-02） */
function fromAmapPoi(poi, routeId, fetchedAt) {
    const c = String(poi.location || '').split(',');
    const gcj = [+c[1], +c[0]];
    const type = (poi.type || '').indexOf('加油') >= 0 ? 'fuel' : 'ev';
    const w = gcj2wgs(gcj[0], gcj[1]);
    return {
        name: poi.name || '未命名站点', type,
        brand: '', address: Array.isArray(poi.address) ? poi.address.join('') : (poi.address || ''),
        kind: '', tel: Array.isArray(poi.tel) ? poi.tel.join(';') : (poi.tel || ''),
        lat: +w[0].toFixed(6), lng: +w[1].toFixed(6),
        srcCoord: { lat: +gcj[0].toFixed(6), lng: +gcj[1].toFixed(6), sys: 'gcj02' },
        slow: (poi.name || '').indexOf('慢充') >= 0 ? 1 : 0,
        cat: poi.type || '',
        sources: [{ vendor: 'amap', sourceId: poi.id || '', fetchedAt, routeId }]
    };
}

module.exports = {
    DB_DIR, FRESH_DAYS, readDb, writeDb,
    normName, sameStation, upsertStation, latestFetchedAt, isFresh,
    toDbStation, fromDbStation, fromAmapPoi
};
