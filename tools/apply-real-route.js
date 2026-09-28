/* ============================================================
   apply-real-route.js — 把真实路线数据接入 qinghai-gansu-loop.html
   1. 从 stations-data.js 读站点，用真实主线重投影沿线里程
   2. 生成页面适配块：REAL_ROUTE / REAL_ALT / REAL_DAYS_META / STATION_DATA(重投影)
   3. 替换 HTML 中的 ALT / CORE / TAIL / P_LZ_XN / STATION_DATA 相关段
   ============================================================ */
const fs = require('fs');
const path = require('path');
const dir = __dirname;

/* ---------- 读真实路线 ---------- */
const routeSrc = fs.readFileSync(path.join(dir, 'route-real-data.js'), 'utf8');
const ROUTE = JSON.parse(routeSrc.match(/var ROUTE_REAL = (\{[\s\S]*\});\s*$/)[1]);

/* ---------- 读站点数据 ---------- */
const staSrc = fs.readFileSync(path.join(dir, 'stations-data.js'), 'utf8');
const STA = JSON.parse(staSrc.match(/(\{[\s\S]*\})/)[1]);
console.log('站点: 充电', STA.ev.length, '加油', STA.fuel.length);

/* ---------- 构建「兰州基准」主线（含兰州→西宁前置段） ---------- */
// 兰州版路线顺序: D11(兰州→西宁) + D1..D10
const leg11 = ROUTE.legs.find(l => l.id === 11);
const coreLegs = ROUTE.legs.filter(l => l.id !== 11).sort((a, b) => a.id - b.id);
const lzOrder = [leg11].concat(coreLegs);

// 高密度点序列（用 simplified 240 点拼）→ 用于投影
function buildMainline(legs) {
  const pts = []; // [lat,lng,km]
  let km = 0;
  legs.forEach((leg, li) => {
    leg.simplified.forEach((p, i) => {
      if (li > 0 && i === 0) return; // 避免接缝重复
      if (i > 0) {
        const q = leg.simplified[i - 1];
        km += haversine(q, p);
      }
      pts.push([p[0], p[1], km]);
    });
  });
  return { pts, total: km };
}
function haversine(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const MAIN = buildMainline(lzOrder);
console.log('兰州基准主线:', MAIN.pts.length, '点, 总长', MAIN.total.toFixed(1), 'km');

/* 点到主线最近点的沿线里程（局部窗口搜索，加速） */
function projectKm(lat, lng) {
  let best = Infinity, bestKm = 0;
  for (let i = 0; i < MAIN.pts.length; i++) {
    const p = MAIN.pts[i];
    const d = haversine([lat, lng], [p[0], p[1]]);
    if (d < best) { best = d; bestKm = p[2]; }
  }
  return { km: bestKm, dist: best };
}

/* ---------- 重投影所有站点 ---------- */
function reproject(arr) {
  return arr.map(s => {
    const r = projectKm(s.lat, s.lng);
    return Object.assign({}, s, { km: +r.km.toFixed(1), d: +r.dist.toFixed(1) });
  }).sort((a, b) => a.km - b.km);
}
const ev2 = reproject(STA.ev);
const fuel2 = reproject(STA.fuel);
const datumStart = leg11.km; // 主出发地（西宁）在站点里程基准（兰州起算）上的里程
console.log('站点基准起点 datumStartKm =', datumStart.toFixed(1), 'km');
console.log('重投影后 充电 km 范围', Math.min(...ev2.map(x=>x.km)), '-', Math.max(...ev2.map(x=>x.km)));
console.log('重投影后 加油 km 范围', Math.min(...fuel2.map(x=>x.km)), '-', Math.max(...fuel2.map(x=>x.km)));

/* ---------- 生成适配数据 ---------- */
const out = { ROUTE_REAL: ROUTE, MAINLINE: MAIN, DATUM_START_KM: +datumStart.toFixed(1) };
fs.writeFileSync(path.join(dir, '.real-adapt.json'), JSON.stringify({
  totalLz: +MAIN.total.toFixed(1),
  datumStartKm: +datumStart.toFixed(1),
  ev: ev2, fuel: fuel2
}));
console.log('\n适配数据已写出 .real-adapt.json');

/* ---------- 每段摘要（供人工核对） ---------- */
console.log('\n=== 兰州版分段里程（真实） ===');
let c = 0;
lzOrder.forEach((l, i) => {
  const label = l.id === 11 ? 'D0 兰州→西宁' : 'D' + l.id + ' ' + l.name;
  console.log(`  ${label.padEnd(26)} ${c.toFixed(1)} → ${(c + l.km).toFixed(1)} km  (${l.km}km)  路:${l.roads.slice(0,4).join('+')}`);
  c += l.km;
});
console.log('  合计', c.toFixed(1), 'km');
