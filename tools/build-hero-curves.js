#!/usr/bin/env node
/* ============================================================
   build-hero-curves.js — 选线器首页「抽象剖面线稿」物化（S21）
   从各线路包的 ALT_REAL（真实高程采样）抽稀 ~60 点 → 归一化
   坐标，写成 route-defs/hero-curves.js。选线器只加载本文件
   （+manifest），不碰线路包——保持首页轻量（probe 有断言）。
   用法：node tools/build-hero-curves.js
   ============================================================ */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const manifestSrc = fs.readFileSync(path.join(ROOT, 'route-defs', 'manifest.js'), 'utf8');
const manifestSb = {};
vm.runInNewContext(manifestSrc, manifestSb);
const MANIFEST = manifestSb.ROUTE_MANIFEST || [];

const SAMPLES = 60;

// 三点滑动平均轻去噪（纯视觉，不影响线路页任何口径——本文件只为首页线稿服务）
function smooth3(series) {
    return series.map(function (p, i) {
        var a = series[Math.max(0, i - 1)], b = p, c = series[Math.min(series.length - 1, i + 1)];
        return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    });
}

function heroFrom(altReal) {
    var series = smooth3(altReal);
    var km0 = series[0][0], km1 = series[series.length - 1][0];
    var lo = Infinity, hi = -Infinity;
    series.forEach(function (p) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); });
    var span = (hi - lo) || 1;
    var pts = [];
    for (var i = 0; i < SAMPLES; i++) {
        var km = km0 + (km1 - km0) * i / (SAMPLES - 1);
        // 二分找区间线性插值
        var alt = series[series.length - 1][1];
        for (var j = 1; j < series.length; j++) {
            if (series[j][0] >= km) {
                var p0 = series[j - 1], p1 = series[j];
                var t = p1[0] === p0[0] ? 0 : (km - p0[0]) / (p1[0] - p0[0]);
                alt = p0[1] + (p1[1] - p0[1]) * t;
                break;
            }
        }
        pts.push([+(i / (SAMPLES - 1)).toFixed(4), +((alt - lo) / span).toFixed(4)]);
    }
    return { km: Math.round(km1 - km0), pts: pts };
}

const out = {};
MANIFEST.forEach(function (r) {
    const src = fs.readFileSync(path.join(ROOT, 'route-defs', r.id + '.js'), 'utf8');
    const sb = {};
    vm.runInNewContext(src, sb);
    const alt = sb.ALT_REAL || (sb.ALT || []);
    if (!alt.length) { console.error('!! ' + r.id + ' 无 ALT_REAL，跳过'); return; }
    out[r.id] = heroFrom(alt);
    console.log('  ' + r.id + ': ' + alt.length + ' 采样 → ' + out[r.id].pts.length + ' 点, 全程 ' + out[r.id].km + 'km');
});

const body = '/* ============================================================================\n' +
    ' * hero-curves.js — 选线器首页线稿数据（S21，tools/build-hero-curves.js 物化）\n' +
    ' * 每条线路 ~60 个归一化坐标 [x(0..1 沿线里程), y(0..1 海拔归一)]，抽自包内 ALT_REAL。\n' +
    ' * 选线器只加载本文件 + manifest.js，不加载任何线路包（probe 有断言守护）。\n' +
    ' * 重新生成：node tools/build-hero-curves.js（新线构建后重跑即可）\n' +
    ' * ========================================================================== */\n\n' +
    'var HERO_CURVES = ' + JSON.stringify(out) + ';\n';

fs.writeFileSync(path.join(ROOT, 'route-defs', 'hero-curves.js'), body);
console.log('✓ route-defs/hero-curves.js（' + Object.keys(out).length + ' 条线）');
