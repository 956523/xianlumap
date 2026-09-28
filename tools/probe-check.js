/* ============================================================
   probe-check.js — S1.5 探针验收：两条线数据包都能被引擎加载且不崩
   做法与 c4-test.js 相同（mock TMap + DOM，node vm 跑主脚本），
   差异：按页面 loader 的方式先选数据包（?route= 参数 → route-defs/<key>.js），
   再拼主脚本执行。只查「不崩 + 基本渲染」，不查像素级行为。
   用法：node tools/probe-check.js
   ============================================================ */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// 主脚本：S2 起引擎拆分为 engine/*.js（index.html 按序以 <script src> 加载），
// 此处按页面相同顺序拼接执行
const engineSrcs = Array.from(html.matchAll(/<script src="(engine\/[^"]+)"><\/script>/g)).map(m => m[1]);
const mainScript = engineSrcs.map(s => fs.readFileSync(path.join(ROOT, s), 'utf8')).join('\n').trim();

/* ---------- mock（与 c4-test 同构，精简注释） ---------- */
const calls = { polyline: [], markers: [], labels: [] };
function FakeLayer(kind, opts) {
    this.kind = kind; this.opts = opts || {};
    this.setMap = function () {}; this.on = function () {}; this.setStyles = function () {}; this.setGeometries = function () { return this; };
    if (kind === 'polyline') calls.polyline.push(opts);
    if (kind === 'marker') calls.markers.push(opts);
    if (kind === 'label') calls.labels.push(opts);
}
const TMap = {
    Map: function () { this.on = function () {}; this.easeTo = function () {}; this.setCenter = function () {}; this.fitBounds = function () {}; this.destroy = function () {}; },
    LatLng: function (lat, lng) { this.lat = lat; this.lng = lng; },
    InfoWindow: function (o) { globalThis.__lastIW = o; this.open = function () {}; this.close = function () {}; this.setPosition = function () {}; },
    MultiMarker: function (o) { FakeLayer.call(this, 'marker', o); },
    MultiLabel: function (o) { FakeLayer.call(this, 'label', o); },
    MultiPolyline: function (o) { FakeLayer.call(this, 'polyline', o); },
    MarkerStyle: function (o) { this.o = o; },
    LabelStyle: function (o) { this.o = o; },
    PolylineStyle: function (o) { this.o = o; },
    LatLngBounds: function () { this.extend = function () {}; }
};
const created = [];
function fakeEl(id) {
    const el = {
        id: id, textContent: '', innerHTML: '', value: '500',
        checked: true, style: { setProperty() {}, getPropertyValue() { return ''; } },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {},
        getBoundingClientRect() { return { top: 0, left: 0, width: 1200, height: 300, bottom: 300, right: 1200 }; },
        children: [],
        _qs: {},
        querySelector(sel) { if (!this._qs[sel]) this._qs[sel] = fakeEl(this.id + '.*' + sel); return this._qs[sel]; },
        querySelectorAll() { return []; },
        onclick: null, oninput: null, onchange: null
    };
    return el;
}
const elCache = {};
const document = {
    getElementById(id) { if (!elCache[id]) elCache[id] = fakeEl(id); return elCache[id]; },
    createElement(tag) { const el = fakeEl('dyn:' + tag); created.push(el); return el; },
    createElementNS() { const el = fakeEl('svg'); created.push(el); return el; },
    querySelector() { return fakeEl('qs'); },
    addEventListener() {}
};
document.body = fakeEl('body');
document.documentElement = fakeEl('html');
document.documentElement.__vars = { '--elev-occupy': '46px' };
const getComputedStyle = (el) => ({ getPropertyValue(k) { return el && el.__vars && el.__vars[k] || ''; } });
const window = { addEventListener() {}, innerWidth: 1600, innerHeight: 900 };

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  [' + extra + ']' : '')); }
    else { fail++; console.log('  ❌ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

/* ---------- 按页面 loader 的方式选数据包并执行 ---------- */
// 编辑模式断言需要 localStorage（overlay 存这里；跨 boot 共享，模拟真实浏览器）
const lsStore = {};
const localStorageMock = {
    getItem: k => (k in lsStore ? lsStore[k] : null),
    setItem: (k, v) => { lsStore[k] = String(v); },
    removeItem: k => { delete lsStore[k]; }
};
function bootRoute(routeKey) {
    // 与 index.html 内联 loader 等价：?route=<key> → route-defs/<key>.js，先于主脚本加载
    const dataSrc = fs.readFileSync(path.join(ROOT, 'route-defs', routeKey + '.js'), 'utf8');
    created.length = 0;
    let err = null;
    const sandbox = {
        TMap, document, window, console, localStorage: localStorageMock,
        setTimeout: (fn) => { try { fn(); } catch (e) {} return 0; }, clearTimeout: () => {},
        encodeURIComponent, parseFloat, parseInt, getComputedStyle,
        ResizeObserver: function (cb) { this.observe = function () {}; this.disconnect = function () {}; }
    };
    try {
        vm.runInNewContext(dataSrc + '\n' + mainScript, sandbox);
    } catch (e) { err = e; }
    return { err: err, routeKey: routeKey, sandbox: sandbox };
}

/* ---------- 青甘（默认线，回归） ---------- */
console.log('\n【1】青甘大环线（默认）');
const qh = bootRoute('qinghai-gansu');
ok('主脚本执行无异常', !qh.err, qh.err ? qh.err.message.slice(0, 120) : '');
const qhDays = created.filter(el => el.id === 'dyn:li');
ok('每日列表渲染 10 天', qhDays.length === 10, qhDays.length + ' 项');
ok('总里程 chip ≈2164（日行程合计口径）', Math.abs(parseInt(elCache['chipKm'].textContent, 10) - 2164) <= 25, elCache['chipKm'].textContent);
ok('最高海拔 chip >3700（祁连段去噪后）', parseInt(elCache['chipMaxAlt'].textContent, 10) > 3700, elCache['chipMaxAlt'].textContent);
ok('续航规划输出 + 长盲区上图（无桩段渲染为图层）',
    elCache['planBox'].innerHTML.includes('全程需充电') &&
    calls.polyline.some(function (p) { return (p.geometries || []).some(function (g) { return String(g.id).indexOf('warn') === 0; }); }),
    '');
// 信息窗站点来源日期透出（S4）：站点信息窗统一拼 stationSourceNote()（数据包 sourceShort/builtAt）
let srcNote = '';
try { srcNote = qh.sandbox.stationSourceNote(); } catch (e) { srcNote = 'ERR ' + e.message; }
ok('站点来源日期透出（来源+快照日期）', /POI · \d{4}-\d{2}-\d{2}/.test(srcNote), srcNote);
ok('标题来自 ROUTE_META', document.title.includes('青甘'), document.title);
ok('纯电提示来自 ROUTE_META（青甘文案）', elCache['evNotice'].querySelector('span').innerHTML.includes('大柴旦'), '');
ok('出发地切换按钮保留（青甘）', !elCache['startSeg'] || elCache['startSeg'].style.display !== 'none', '');

/* ---------- 川西（探针） ---------- */
console.log('\n【2】川西小环线（探针包）');
const cx = bootRoute('chuanxi');
ok('主脚本执行无异常（真实站点/空支线）', !cx.err, cx.err ? cx.err.message.slice(0, 160) : '');
if (cx.err) { console.log(cx.err.stack); console.log('\n结果: ' + pass + ' pass / ' + fail + ' fail（中断）'); process.exit(1); }
const cxDays = created.filter(el => el.id === 'dyn:li');
ok('每日列表渲染 5 天', cxDays.length === 5, cxDays.length + ' 项');
ok('总里程 chip ≈850（高德轨迹）', Math.abs(parseInt(elCache['chipKm'].textContent, 10) - 850) <= 25, elCache['chipKm'].textContent);
ok('最高海拔 chip ≈4298（折多山）', Math.abs(parseInt(elCache['chipMaxAlt'].textContent, 10) - 4298) <= 150, elCache['chipMaxAlt'].textContent);
ok('续航规划输出真实结果 + 截断透出（快照声明含截断提示）',
    elCache['planBox'].innerHTML.includes('全程需充电') && /截断/.test(elCache['dataCaveat'].textContent),
    elCache['dataCaveat'].textContent.slice(0, 60));
ok('标题来自 ROUTE_META', document.title.includes('川西'), document.title);
ok('副标题如实描述真实数据口径（不再是探针包）', elCache['routeSub'].textContent.includes('真实数据') && !elCache['routeSub'].textContent.includes('探针包'), elCache['routeSub'].textContent);
ok('纯电提示标注山区盲区', elCache['evNotice'].querySelector('span').innerHTML.includes('无快充'), '');
ok('单出发地按钮与经典支线行均隐藏', elCache['startSeg'].style.display === 'none' && elCache['classicRow'].style.display === 'none', '');
// 交互冒烟：点第 1 天 → focusDay + 剖面重画不崩
let focusErr = null;
try { cxDays[0].onclick(); } catch (e) { focusErr = e; }
ok('聚焦 D1 不崩（zoom/center/剖面）', !focusErr, focusErr ? focusErr.message.slice(0, 120) : '');
ok('聚焦后能耗提示为川西文案', elCache['curEnergy'].innerHTML.includes('四姑娘山'), elCache['curEnergy'].innerHTML.slice(0, 60));

/* ---------- 编辑模式（S5：overlay 改 → 存 → 刷新仍在 → 恢复） ---------- */
console.log('\n【3】编辑模式（overlay 架构）');
const ed = bootRoute('chuanxi');
ok('编辑模式默认关闭（非编辑用户无编辑态）', !ed.err && ed.sandbox.Edit && ed.sandbox.Edit.isOn() === false, ed.err ? ed.err.message.slice(0, 80) : '');
ed.sandbox.Edit.enter();
ed.sandbox.Edit.setDayField(2, 'title', '测试标题');
const titleNow = ed.sandbox.DAYS.filter(d => d.id === 2)[0].title;
ok('改标题即时生效（DAYS 更新）', titleNow === '测试标题', titleNow);
ok('改动写入 localStorage（overlay 按 routeId 隔离）', /测试标题/.test(lsStore['xianlumap.overlay.chuanxi'] || ''), (lsStore['xianlumap.overlay.chuanxi'] || '').slice(0, 60));
const ed2 = bootRoute('chuanxi');   // 模拟刷新：线路包 + overlay 合并生效
ok('刷新后 overlay 仍在（合并生效）', ed2.sandbox.DAYS.filter(d => d.id === 2)[0].title === '测试标题');
ed2.sandbox.Edit.setMarkName('折多山垭口', '折多山口');
ok('地名显示名可改（ALT_MARKS 更新）', ed2.sandbox.ALT_MARKS.some(m => m.n === '折多山口'));
ed2.sandbox.Edit.setSeg(2, 250, 320);
const segDay = ed2.sandbox.DAYS.filter(d => d.id === 2)[0];
ok('分段可改（选地名重切区间/里程）', segDay.altKm[0] === 250 && segDay.altKm[1] === 320 && segDay.km === 70,
    JSON.stringify(segDay.altKm) + ' ' + segDay.km + 'km path=' + (segDay.path || []).length + '点');
ed2.sandbox.Edit.reset();
ok('恢复原始数据（pristine 写回 + 清 overlay）',
    ed2.sandbox.DAYS.filter(d => d.id === 2)[0].title === '四姑娘山镇 → 丹巴' &&
    ed2.sandbox.ALT_MARKS.some(m => m.n === '折多山垭口') &&
    !lsStore['xianlumap.overlay.chuanxi'],
    '');

console.log('\n结果: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);
