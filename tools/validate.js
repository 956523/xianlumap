/* ============================================================
   validate.js — 线路包数据体检 V1–V4（PLATFORM.md §5.1，S4）
   用法：node tools/validate.js <routeId> [--fix]
   判据：
     V1 物理合理性  相邻点坡度 >120 m/km 的尖峰 → 中值滤波修（与引擎
                    altDenoised 同一规则：偏离 5 点中值 >300m 拉回中值）。
                    有尖峰而不 --fix → FAIL；--fix 修复后 PASS 并留痕。
                    持续陡坡（多点真实地形）只警告不判错。
     V2 补给覆盖    25km 网格站点覆盖；>100km 长盲区必须显式列出（warnings）。
                    站点为空（未接入语义）→ 跳过并注明。
     V3 投影自洽    站点存储 km 与用同源轨迹重投影的 km 偏差 >5km → FAIL
                    （防轨迹重建后站点表过期）；站点与其最近途经点的
                    里程差 >30km（且坐标距离 <30km）→ 警告。
     V4 里程对账    三个口径分别核对，超 2% → FAIL：
                    A 逐日 km 合计 vs ΣapiKm（日界取整差，容差放宽到 max(5,2%)）
                    B TOTAL_XN（契约环线长）vs ΣapiKm
                    C STATION_DATA.totalKm vs datumStartKm + ΣapiKm
                    D datumEndKm vs totalKm − datumStartKm
                    注：川西 TOTAL_XN=850 是轨迹线累计、totalKm=851.8 是
                    apiKm 缩放投影长，口径并存正常，按口径分别核对。
   退出码：有 FAIL → 1；仅 warnings → 0（有明确标注的算过）。
   --fix：应用 V1 修复并把重算的长盲区写回 STATION_DATA.warnings。
   ============================================================ */
const fs = require('fs');
const {
    loadRoutePackage, buildProjection, longBlindWarnings, replaceVarBlock,
    wgs2gcj, haversine
} = require('./lib/build-lib');

const ARGS = process.argv.slice(2);
const ROUTE_ID = ARGS.filter(a => !a.startsWith('--'))[0];
const FIX = ARGS.indexOf('--fix') >= 0;
if (!ROUTE_ID) {
    console.error('用法: node tools/validate.js <routeId> [--fix]');
    process.exit(1);
}

const { file: PKG_FILE, src: PKG_SRC, pkg } = loadRoutePackage(ROUTE_ID);
const sd = pkg.STATION_DATA || {};
const FIXES = [];   // --fix 落盘的修改说明
let fails = 0, warns = 0;

function ok(name, detail) { console.log('  ✅ ' + name + (detail ? '  [' + detail + ']' : '')); }
function warn(name, detail) { warns++; console.log('  ⚠️ ' + name + (detail ? '  [' + detail + ']' : '')); }
function fail(name, detail) { fails++; console.log('  ❌ ' + name + (detail ? '  [' + detail + ']' : '')); }

console.log('\n【' + ROUTE_ID + '】数据体检' + (FIX ? '（--fix）' : ''));

/* ================= V1 物理合理性 ================= */
console.log('\nV1 物理合理性（高程尖峰）');
(function () {
    const alt = pkg.ALT_REAL || [];
    const w = 2;
    const spikes = [];
    const fixed = alt.map(function (p, i) {
        const win = [];
        for (let j = Math.max(0, i - w); j <= Math.min(alt.length - 1, i + w); j++) win.push(alt[j][1]);
        win.sort((a, b) => a - b);
        const med = win[Math.floor(win.length / 2)];
        if (Math.abs(p[1] - med) > 300) { spikes.push([p[0], p[1], med]); return [p[0], med]; }
        return p;
    });
    // 持续陡坡（>120 m/km 且非单点尖峰）——真实地形，只警告
    let steepRuns = 0;
    for (let i = 1; i < alt.length; i++) {
        const dk = alt[i][0] - alt[i - 1][0];
        if (dk <= 0.05) continue;
        const isSpike = spikes.some(s => s[0] === alt[i][0] || s[0] === alt[i - 1][0]);
        if (!isSpike && Math.abs(alt[i][1] - alt[i - 1][1]) / dk > 120) steepRuns++;
    }
    if (!spikes.length) ok('无 >300m 离中值尖峰', alt.length + ' 个采样点');
    if (spikes.length) {
        if (FIX) {
            ok('尖峰已中值滤波修复 ' + spikes.length + ' 处', spikes.map(s => 'km' + s[0] + ' ' + s[1] + '→' + s[2]).join('；'));
            FIXES.push({ type: 'ALT_REAL', data: fixed });
        } else {
            fail('发现 ' + spikes.length + ' 处高程尖峰（跑 --fix 中值滤波修复）',
                spikes.slice(0, 5).map(s => 'km' + s[0] + ' ' + s[1] + 'm（中值 ' + s[2] + 'm）').join('；'));
        }
    }
    if (steepRuns) warn('持续陡坡点 ' + steepRuns + ' 个（>120 m/km 非单点尖峰，按真实地形保留）');
})();

/* ================= V2 补给覆盖 ================= */
console.log('\nV2 补给覆盖（25km 网格 + 长盲区）');
(function () {
    const totalKm = sd.totalKm || 0;
    if (!sd.ev || !sd.ev.length) {
        ok('站点未接入（STATION_DATA.ev = []，按契约跳过覆盖检查）');
        return;
    }
    const allWarn = longBlindWarnings(sd);
    [['ev', '充电'], ['fuel', '加油']].forEach(function ([type, label]) {
        const list = sd[type].slice().sort((a, b) => a.km - b.km);
        const blind = [];
        for (let k = 0; k < totalKm; k += 25) {
            if (!list.some(s => Math.abs(s.km - k) <= 12.5)) blind.push(k);
        }
        const recomputed = allWarn.filter(r => r.type === type);
        if (recomputed.length) {
            recomputed.forEach(r => warn(label + '长盲区 km' + r.from + '–' + r.to + '（' + r.km + 'km）', '须上图透出'));
        } else {
            ok(label + '无 >100km 长盲区', '25km 网格盲区 ' + blind.length + '/' + Math.ceil(totalKm / 25) + ' 格');
        }
    });
    // 存储的 warnings 与 datum 字段规范化：--fix 时统一写回（顺带 xnStart/xnEnd → datumStartKm/datumEndKm 改名）
    const want = longBlindWarnings(sd);
    const have = JSON.stringify(sd.warnings || []);
    if (FIX && sd.ev && sd.ev.length) {
        ok('STATION_DATA.warnings 已按重算写回', want.length + ' 条');
        FIXES.push({ type: 'WARNINGS', data: want });
    } else if (JSON.stringify(want) !== have) {
        warn('STATION_DATA.warnings 与重算不一致（存 ' + (sd.warnings || []).length + ' / 算 ' + want.length + '，跑 --fix 写回）');
    } else {
        ok('STATION_DATA.warnings 与重算一致', (sd.warnings || []).length + ' 条');
    }
})();

/* ================= V3 投影自洽 ================= */
console.log('\nV3 投影自洽（站点 km 重投影对账）');
(function () {
    if (!sd.ev || !sd.ev.length) { ok('站点未接入，跳过'); return; }
    const PROJ = buildProjection(pkg);
    let bad = [];
    ['ev', 'fuel'].forEach(type => {
        sd[type].forEach(s => {
            const r = PROJ.project(s.lat, s.lng);
            if (Math.abs(r.routeKm - s.km) > 5) bad.push(type + ':' + s.t.slice(0, 14) + ' 存 ' + s.km + ' / 算 ' + r.routeKm.toFixed(1));
        });
    });
    if (bad.length) fail(bad.length + ' 个站点存储 km 与重投影偏差 >5km（站点表可能过期，重跑 build-stations）', bad.slice(0, 5).join('；'));
    else ok('全部站点重投影偏差 ≤5km', (sd.ev.length + sd.fuel.length) + ' 个站点');

    // 途经点交叉核对（轨迹与站点是否对得上）
    const B = pkg.ROUTE_BUILD;
    const wps = Object.keys(B.waypoints || {}).map(k => {
        const p = B.waypoints[k].p;
        const g = B.inputDatum === 'wgs84' ? wgs2gcj(p[0], p[1]) : p;
        const r = PROJ.project(g[0], g[1]);
        return { n: B.waypoints[k].n, p: g, km: r.routeKm, dist: r.dist };
    });
    let wpWarn = 0;
    ['ev', 'fuel'].forEach(type => {
        sd[type].forEach(s => {
            let best = null, bd = 1e9;
            wps.forEach(wp => {
                const d = haversine([s.lat, s.lng], wp.p);
                if (d < bd) { bd = d; best = wp; }
            });
            if (best && bd < 30 && Math.abs(s.km - best.km) > 30) wpWarn++;
        });
    });
    if (wpWarn) warn(wpWarn + ' 个站点与最近途经点里程差 >30km（近途经点但 km 对不上，核对轨迹走向）');
    else ok('站点—途经点里程交叉核对通过');
})();

/* ================= V4 里程对账 ================= */
console.log('\nV4 里程对账（分口径）');
(function () {
    const days = (pkg.CORE || []).concat([pkg.TAIL]).filter(d => d && d.path);
    const sumDayKm = days.reduce((a, d) => a + d.km, 0);
    const sumApiKm = +days.reduce((a, d) => a + (d.apiKm || 0), 0).toFixed(1);
    const totalXn = pkg.TOTAL_XN;
    console.log('  口径：日km合计 ' + sumDayKm + ' / ΣapiKm ' + sumApiKm + ' / TOTAL_XN ' + totalXn + ' / STATION_DATA.totalKm ' + (sd.totalKm || '—') + ' / datumStartKm ' + (sd.datumStartKm != null ? sd.datumStartKm : sd.xnStart != null ? sd.xnStart : '—'));
    const tol = x => Math.max(5, x * 0.02);
    // A：逐日 km（界面口径，整数取整）vs ΣapiKm
    if (Math.abs(sumDayKm - sumApiKm) <= tol(sumApiKm)) ok('A 日km合计 ≈ ΣapiKm', (sumDayKm - sumApiKm).toFixed(1) + 'km');
    else fail('A 日km合计与 ΣapiKm 差 ' + (sumDayKm - sumApiKm).toFixed(1) + 'km（超 2%）');
    // B：契约环线长 TOTAL_XN vs ΣapiKm
    if (Math.abs(totalXn - sumApiKm) <= tol(sumApiKm)) ok('B TOTAL_XN ≈ ΣapiKm', (totalXn - sumApiKm).toFixed(1) + 'km');
    else fail('B TOTAL_XN（' + totalXn + '）与 ΣapiKm（' + sumApiKm + '）差 ' + (totalXn - sumApiKm).toFixed(1) + 'km（超 2%，常量陈旧？）');
    // C/D：站点表口径
    if (sd.totalKm) {
        const dStart = sd.datumStartKm != null ? sd.datumStartKm : (sd.xnStart != null ? sd.xnStart : 0);
        const dEnd = sd.datumEndKm != null ? sd.datumEndKm : (sd.xnEnd != null ? sd.xnEnd : sd.totalKm - dStart);
        if (Math.abs(sd.totalKm - (dStart + sumApiKm)) <= tol(sumApiKm)) ok('C STATION_DATA.totalKm ≈ datumStartKm + ΣapiKm', (sd.totalKm - dStart - sumApiKm).toFixed(1) + 'km');
        else fail('C STATION_DATA.totalKm（' + sd.totalKm + '）与 datumStartKm+ΣapiKm（' + (dStart + sumApiKm).toFixed(1) + '）差 ' + (sd.totalKm - dStart - sumApiKm).toFixed(1) + 'km（超 2%）');
        if (Math.abs(dEnd - (sd.totalKm - dStart)) <= tol(sumApiKm)) ok('D datumEndKm ≈ totalKm − datumStartKm');
        else fail('D datumEndKm（' + dEnd + '）与 totalKm−datumStartKm（' + (sd.totalKm - dStart).toFixed(1) + '）不一致');
    } else {
        warn('无 STATION_DATA.totalKm，C/D 跳过');
    }
})();

/* ================= --fix 写回 ================= */
if (FIX && FIXES.length) {
    let src = PKG_SRC;
    FIXES.forEach(f => {
        if (f.type === 'ALT_REAL') {
            src = replaceVarBlock(src, 'ALT_REAL', 'var ALT_REAL = ' + JSON.stringify(f.data) + ';');
        } else if (f.type === 'WARNINGS') {
            // 与 build-stations 写回同一方式：整体替换 STATION_DATA 块
            const sd2 = Object.assign({}, sd, { warnings: f.data });
            delete sd2.xnStart; delete sd2.xnEnd; // 顺手完成 datum 字段改名（旧字段不再产出）
            if (sd2.datumStartKm == null) sd2.datumStartKm = sd.xnStart != null ? sd.xnStart : 0;
            if (sd2.datumEndKm == null) sd2.datumEndKm = sd.xnEnd != null ? sd.xnEnd : sd.totalKm - sd2.datumStartKm;
            src = replaceVarBlock(src, 'STATION_DATA', 'var STATION_DATA = ' + JSON.stringify(sd2) + ';');
        }
    });
    fs.writeFileSync(PKG_FILE, src);
    console.log('\n已写回 ' + PKG_FILE + '（' + FIXES.map(f => f.type).join(' + ') + '）');
}

console.log('\n结果：' + (fails ? fails + ' FAIL / ' : '') + warns + ' warnings');
process.exit(fails ? 1 : 0);
