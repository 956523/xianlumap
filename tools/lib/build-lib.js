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

/* 高德业务错误码：可重试的（QPS/并发超限类；CUQPS=10021 实测会瞬时触发） */
const RETRYABLE_INFOCODES = { '10004': 1, '10009': 1, '10021': 1, '10044': 1 };

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

/* ---------- 站点投影主线（与页面同源：接入段 + CORE + TAIL，apiKm 缩放对齐） ----------
   build-stations.js（抓站）与 validate.js（V3/V4 体检）共用同一投影，保证口径一致。 */
function buildProjection(pkg) {
    const STARTS = pkg.ROUTE_STARTS || [];
    const lead = STARTS.filter(s => s.leadPath && s.leadPath.length)[0];
    const segs = [];
    if (lead) segs.push({ pts: lead.leadPath, apiKm: lead.offsetKm });
    (pkg.CORE || []).concat([pkg.TAIL]).forEach(d => {
        if (d && d.path && d.path.length) segs.push({ pts: d.path, apiKm: d.apiKm });
    });
    if (!segs.length) throw new Error('包内没有可用轨迹（CORE/TAIL path 为空）');
    const COSLAT = Math.cos(segs.reduce((a, s) => a + s.pts.reduce((x, p) => x + p[0], 0) / s.pts.length, 0) / segs.length * Math.PI / 180);
    const ROUTE_ALL = [], SEG_KM = [];
    let acc = 0;
    segs.forEach(sg => {
        const pts = sg.pts;
        const lens = [0]; let arc = 0;
        for (let i = 1; i < pts.length; i++) {
            const dx = (pts[i][1] - pts[i - 1][1]) * COSLAT, dy = pts[i][0] - pts[i - 1][0];
            arc += Math.sqrt(dx * dx + dy * dy); lens.push(arc);
        }
        const scale = arc ? (sg.apiKm / arc) : 0;
        for (let j = 0; j < pts.length; j++) {
            if (j === 0 && ROUTE_ALL.length) continue;
            ROUTE_ALL.push(pts[j]);
            SEG_KM.push(acc + lens[j] * scale);
        }
        acc += sg.apiKm;
    });
    const TOTAL_KM = SEG_KM[SEG_KM.length - 1];
    function project(lat, lng) {
        const px = lng * COSLAT, py = lat;
        let best = { d: 1e18, i: 1, t: 0 };
        for (let i = 1; i < ROUTE_ALL.length; i++) {
            const A = ROUTE_ALL[i - 1], B = ROUTE_ALL[i];
            const ax = A[1] * COSLAT, ay = A[0], bx = B[1] * COSLAT, by = B[0];
            const abx = bx - ax, aby = by - ay, ab2 = abx * abx + aby * aby || 1e-12;
            let t = ((px - ax) * abx + (py - ay) * aby) / ab2;
            t = Math.max(0, Math.min(1, t));
            const cx = ax + t * abx, cy = ay + t * aby, dx = px - cx, dy = py - cy, d = dx * dx + dy * dy;
            if (d < best.d) best = { d, i, t };
        }
        const k0 = SEG_KM[best.i - 1], k1 = SEG_KM[best.i];
        return { dist: Math.sqrt(best.d) * 111.32, routeKm: k0 + (k1 - k0) * best.t };
    }
    return { ROUTE_ALL, SEG_KM, TOTAL_KM, project, COSLAT };
}

/* ---------- 包内变量块替换（按行定位 + 括号配平找块尾，兼容缩进与多行数组） ----------
   用于 --fix 写回（validate）与 STATION_DATA 就地更新（build-stations）。 */
function replaceVarBlock(src, name, newCode) {
    const re = new RegExp('^[ \\t]*var ' + name + '[ \\t]*=');
    const lines = src.split('\n');
    const start = lines.findIndex(l => re.test(l));
    if (start < 0) throw new Error('包内找不到 var ' + name);
    let depth = 0, seen = false, end = start;
    for (let i = start; i < lines.length; i++) {
        for (const ch of lines[i]) {
            if (ch === '[' || ch === '{') { depth++; seen = true; }
            else if (ch === ']' || ch === '}') depth--;
        }
        if (seen && depth <= 0 && /;\s*$/.test(lines[i])) { end = i; break; }
    }
    lines.splice(start, end - start + 1, newCode);
    return lines.join('\n');
}

/* ---------- 长盲区（>100km）计算：站点表（datum 空间）→ warnings ----------
   build-stations 与 validate --fix 共用，产出引擎透出用的 warnings 契约。 */
function longBlindWarnings(sd) {
    const out = [];
    const totalKm = sd.totalKm;
    [['ev', '无快充'], ['fuel', '无加油站']].forEach(function ([type, label]) {
        const list = (sd[type] || []).slice().sort((a, b) => a.km - b.km);
        let prev = 0;
        list.forEach(s => {
            if (s.km - prev > 100) out.push({ type: type, from: +prev.toFixed(1), to: +s.km.toFixed(1), km: +(s.km - prev).toFixed(1), label: label });
            prev = s.km;
        });
        if (totalKm - prev > 100) out.push({ type: type, from: +prev.toFixed(1), to: +totalKm.toFixed(1), km: +(totalKm - prev).toFixed(1), label: label });
    });
    return out.sort((a, b) => a.from - b.from);
}

module.exports = { loadAmapKey, maskKey, getJSON, sleep, amapGet, resolveAmapIp, wgs2gcj, gcj2wgs, haversine, loadRoutePackage, buildProjection, longBlindWarnings, replaceVarBlock, ROOT };
