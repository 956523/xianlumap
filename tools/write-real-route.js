/* ============================================================
   write-real-route.js — 把真实路线数据写入 qinghai-gansu-loop.html
   替换：ALT / P_LZ_XN / CORE / TAIL / LZ_XN_KM / STATION_DATA / 地名标注 / 支线
   ============================================================ */
const fs = require('fs');
const path = require('path');
const dir = __dirname;

let html = fs.readFileSync(path.join(dir, 'qinghai-gansu-loop.html'), 'utf8');
const B = JSON.parse(fs.readFileSync(path.join(dir, '.patch-blocks.json'), 'utf8'));
const CLASSIC = fs.readFileSync(path.join(dir, 'route-classic-branch.js'), 'utf8').match(/var ROUTE_CLASSIC = (\{[\s\S]*\});\s*$/)[1];

function must(cond, msg) { if (!cond) { console.error('❌ ' + msg); process.exit(1); } console.log('✅ ' + msg); }

/* ---------- A. 替换 ALT 数组 + LZ_XN_KM ---------- */
const altStart = html.indexOf('    /* ============ 海拔基准点');
const altEnd = html.indexOf('    /* ============ 路线');
must(altStart > 0 && altEnd > altStart, '定位 ALT 区块');

const realAltHeader = `    /* ============ 海拔基准点（真实地形采样，open-meteo；km 为距西宁累计里程） ============ */
    /* 采样：沿腾讯地图真实驾车轨迹每 ~2.5km 取一点，共 ${B.ALT.split('],').length} 个基准点 */
    var ALT_REAL = ${B.ALT};
    var ALT_MARKS = ${B.MARKS};
    /* 兼容旧结构：把密集采样 + 地名标注合成 ALT（地名点覆盖同里程的采样点） */
    var ALT = (function () {
        var m = {}, out = [];
        ALT_MARKS.forEach(function (p) { m[p.km] = p; });
        ALT_REAL.forEach(function (p) { out.push(m[p[0]] || { km: p[0], alt: p[1] }); });
        ALT_MARKS.forEach(function (p) {
            if (!out.some(function (q) { return q.km === p.km; })) out.push(p);
        });
        out.sort(function (a, b) { return a.km - b.km; });
        return out;
    })();
    var LZ_XN_KM = ${B.LZ_KM}; // 兰州—西宁 真实里程
    var LZ_HEAD = { km: 0, alt: 1520, n: '兰州' };
    var TOTAL_XN = ${B.TOTAL_XN}; // 西宁版总里程

`;
html = html.slice(0, altStart) + realAltHeader + html.slice(altEnd);
console.log('✅ ALT 区块替换');

/* ---------- B. 替换路线段（P_LZ_XN / CORE / TAIL） ---------- */
const rtStart = html.indexOf('    /* ============ 路线（密集拐点');
const rtEnd = html.indexOf('    /* ============ 城镇 / 景点 ============ */');
must(rtStart > 0 && rtEnd > rtStart, '定位路线区块');

const realRouteBlock = `    /* ============ 路线（腾讯地图驾车路线 API 真实轨迹，GCJ-02） ============ */
    /* 数据源：腾讯地图 WebService 驾车路线规划；每段 240 个真实轨迹点 */
    var P_LZ_XN = ${B.LZ_PATH};
    var CORE = ${B.CORE};
    var TAIL = ${B.TAIL};
    /* 经典支线（虚线显示）：西宁 → 塔尔寺 → 拉脊山垭口(3856m) → 倒淌河，不走高速 */
    var CLASSIC = ${CLASSIC};

`;
html = html.slice(0, rtStart) + realRouteBlock + html.slice(rtEnd);
console.log('✅ 路线区块替换（P_LZ_XN / CORE / TAIL / CLASSIC）');

fs.writeFileSync(path.join(dir, 'qinghai-gansu-loop.html'), html);
console.log('\n写入完成，文件大小', html.length, 'bytes');
