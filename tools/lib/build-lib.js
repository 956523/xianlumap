/* ============================================================
   tools/lib/build-lib.js — 构建管线共享库（Node 零依赖）
   职责：
     1) Key 加载：环境变量 AMAP_WEB_SERVICE_KEY 优先，否则读仓库根
        .env.local（已 gitignore）。保密铁律：Key 只从这里读，
        任何日志/报错只显示前 4 位（maskKey），禁止打印完整 Key 或含 Key 的 URL。
     2) DNS 绕行：本机默认 DNS 把 restapi.amap.com 污染到 0.0.0.0，
        系统解析失败时走阿里 DoH（223.5.5.5）取真实 A 记录。
     3) 请求封装：GET JSON、网络错误重试、QPS/日限错误退避重试；
        报错信息只含 infocode/info，不回显 Key。
     4) 坐标：GCJ-02 ↔ WGS-84（标准公开算法，米级逼近）。
     5) 线路包加载：route-defs/<id>.js 整体在 vm 里执行，取 ROUTE_BUILD
        输入契约与需保留的数据段（STATION_DATA/CLASSIC/EXTRA_LINES）。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');

function maskKey(key) {
    if (!key) return '(未配置)';
    return key.slice(0, 4) + '***（已脱敏）';
}

function loadAmapKey() {
    const env = (process.env.AMAP_WEB_SERVICE_KEY || '').trim();
    if (env) return env;
    const envFile = path.join(ROOT, '.env.local');
    if (fs.existsSync(envFile)) {
        const m = fs.readFileSync(envFile, 'utf8').match(/AMAP_WEB_SERVICE_KEY\s*=\s*(\S+)/);
        if (m) return m[1].trim();
    }
    throw new Error('缺少高德 Key：请设环境变量 AMAP_WEB_SERVICE_KEY 或在仓库根目录 .env.local 写入');
}

/* ---------- 通用 GET JSON（open-meteo / OSRM / DoH 用） ---------- */
function getJSON(url, retries) {
    retries = retries === undefined ? 3 : retries;
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'xianlumap-builder/1.0' } }, res => {
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

/* ---------- restapi.amap.com 解析（系统 DNS 被污染时走阿里 DoH） ---------- */
let amapIpCache = null;
async function resolveAmapIp() {
    if (amapIpCache) return amapIpCache;
    const sys = await new Promise(r => dns.lookup('restapi.amap.com', (e, a) => r(e ? null : a)));
    if (sys && sys !== '0.0.0.0') {
        amapIpCache = { ip: sys, via: 'system' };
        return amapIpCache;
    }
    const j = await getJSON('https://223.5.5.5/resolve?name=restapi.amap.com&type=A', 2);
    const ans = (j && j.Answer || []).filter(a => a.type === 1).map(a => a.data);
    if (!ans.length) throw new Error('restapi.amap.com 解析失败：系统 DNS 返回 0.0.0.0，阿里 DoH 也无 A 记录');
    amapIpCache = { ip: ans[0], via: 'alidns-doh' };
    return amapIpCache;
}

/* 高德业务错误码：可重试的（QPS/并发超限类） */
const RETRYABLE_INFOCODES = { '10004': 1, '10009': 1, '10044': 1 };

/* 高德 GET：path 以 / 开头且已含 query（不含 key，key 由本函数追加，绝不外泄） */
async function amapGet(pathWithQuery, key, retries) {
    retries = retries === undefined ? 3 : retries;
    const { ip, via } = await resolveAmapIp();
    const sep = pathWithQuery.indexOf('?') >= 0 ? '&' : '?';
    const full = pathWithQuery + sep + 'key=' + encodeURIComponent(key) + '&output=json';
    return new Promise((resolve, reject) => {
        const req = https.get({
            host: 'restapi.amap.com',
            path: full,
            method: 'GET',
            headers: { 'User-Agent': 'xianlumap-builder/1.0' },
            lookup: (h, o, cb) => {
                // Node 20+ autoSelectFamily 会以 all:true 调用，需返回数组
                if (o && o.all) cb(null, [{ address: ip, family: 4 }]);
                else cb(null, ip, 4);
            },
            timeout: 15000
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                let j;
                try { j = JSON.parse(d); }
                catch (e) { return reject(new Error('amap HTTP ' + res.statusCode + ' 非 JSON: ' + d.slice(0, 100))); }
                if (String(j.status) === '1') return resolve(j);
                const code = String(j.infocode || '');
                const msg = 'amap infocode=' + code + ' ' + (j.info || '');
                if (RETRYABLE_INFOCODES[code] && retries > 0) {
                    return setTimeout(() => amapGet(pathWithQuery, key, retries - 1).then(resolve, reject), 1200 * (4 - retries));
                }
                reject(new Error(msg));
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('amap 请求超时')); });
        req.on('error', e => {
            if (retries > 0) setTimeout(() => amapGet(pathWithQuery, key, retries - 1).then(resolve, reject), 900);
            else reject(e);
        });
    });
}

/* ---------- 坐标：GCJ-02 ↔ WGS-84（标准公开算法，米级逼近） ---------- */
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
/* GCJ-02 → WGS-84：迭代逼近（2 次迭代误差 < 1e-6 度，够 DEM 采样用） */
function gcj2wgs(lat, lng) {
    if (outOfChina(lat, lng)) return [lat, lng];
    let wlat = lat, wlng = lng;
    for (let i = 0; i < 2; i++) {
        const g = wgs2gcj(wlat, wlng);
        wlat += lat - g[0];
        wlng += lng - g[1];
    }
    return [wlat, wlng];
}

function haversine(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

/* ---------- 线路包加载：整包在 vm 执行，取输入契约与保留段 ---------- */
function loadRoutePackage(routeId) {
    const file = path.join(ROOT, 'route-defs', routeId + '.js');
    if (!fs.existsSync(file)) throw new Error('线路包不存在：' + file);
    const src = fs.readFileSync(file, 'utf8');
    const sb = {};
    vm.runInNewContext(src, sb);
    if (!sb.ROUTE_BUILD) {
        throw new Error(routeId + ' 包内没有 ROUTE_BUILD 输入契约（历史包未参数化，见 docs/EXECUTION.md §7）');
    }
    return { file, src, pkg: sb };
}

module.exports = { loadAmapKey, maskKey, getJSON, sleep, amapGet, resolveAmapIp, wgs2gcj, gcj2wgs, haversine, loadRoutePackage, ROOT };
