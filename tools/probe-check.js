/* ============================================================
   probe-check.js — S1.5 探针验收：两条线数据包都能被引擎加载且不崩
   做法与 c4-test.js 相同（mock AMap + DOM，node vm 跑主脚本），
   差异：按页面 loader 的方式先选数据包（?route= 参数 → route-defs/<key>.js），
   再拼主脚本执行。只查「不崩 + 基本渲染」，不查像素级行为。
   用法：node tools/probe-check.js
   ============================================================ */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// 主脚本（S9）：index.html loader 引用 boot-route.js / picker.js；线路页引擎清单在
// boot-route.js 内部，把 boot-route.js 在序列中展开，保持页面执行顺序。
const bootSrc = fs.readFileSync(path.join(ROOT, 'engine', 'boot-route.js'), 'utf8');
const bootList = Array.from(bootSrc.matchAll(/<script src="(engine\/[a-z0-9-]+\.js)">/g)).map(m => m[1]);
const engineSrcs = [];
Array.from(html.matchAll(/<script src="(engine\/[a-z0-9-]+\.js)"><\\?\/script>/g)).forEach(m => {
    if (m[1] === 'engine/boot-route.js') engineSrcs.push('engine/boot-route.js', ...bootList);
    else engineSrcs.push(m[1]);
});
const mainScript = engineSrcs.map(s => fs.readFileSync(path.join(ROOT, s), 'utf8')).join('\n').trim();
// 选线器专用（S8）：manifest + picker，单独 boot 验证
const manifestSrc = fs.readFileSync(path.join(ROOT, 'route-defs', 'manifest.js'), 'utf8');
const pickerSrc = fs.readFileSync(path.join(ROOT, 'engine', 'picker.js'), 'utf8');

/* ---------- mock（与 c4-test 同构，精简注释） ---------- */
const calls = { polyline: [], markers: [], labels: [] };
function FakeLayer(kind, opts) {
    this.kind = kind; this.opts = opts || {};
    this.setMap = function () {}; this.on = function () {}; this.setStyles = function () {}; this.setGeometries = function () { return this; };
    if (kind === 'polyline') calls.polyline.push(opts);
    if (kind === 'marker') calls.markers.push(opts);
    if (kind === 'label') calls.labels.push(opts);
}
// AMap mock（S9）：形状对齐 engine/map-adapter.js 用到的高德原语（单实例记录 opts）
const AMap = {
    Map: function () { this.on = function () {}; this.getZoom = function () { return 7.3; }; this.resize = function () {}; this.setZoomAndCenter = function () {}; },
    LngLat: function (lng, lat) { this.lng = lng; this.lat = lat; },
    Pixel: function (x, y) { this.x = x; this.y = y; },
    Marker: function (o) { FakeLayer.call(this, 'marker', o); this.setMap = function () {}; this.on = function () {}; },
    Text: function (o) { FakeLayer.call(this, 'label', o); this.setMap = function () {}; this.on = function () {}; },
    Polyline: function (o) { FakeLayer.call(this, 'polyline', o); this.setMap = function () {}; this.on = function () {}; this.setOptions = function () {}; },
    InfoWindow: function (o) { globalThis.__lastIW = o; FakeLayer.call(this, 'iw', o); this.open = function () {}; this.close = function () {}; this.on = function () {}; }
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
function bootRoute(routeKey, opts) {
    // 与 index.html 内联 loader 等价：?route=<key> → route-defs/<key>.js，先于主脚本加载
    const dataSrc = fs.readFileSync(path.join(ROOT, 'route-defs', routeKey + '.js'), 'utf8');
    created.length = 0;
    let err = null;
    const win = Object.assign({}, window, {
        innerWidth: (opts && opts.innerWidth) || window.innerWidth,
        innerHeight: (opts && opts.innerHeight) || window.innerHeight
    });
    const sandbox = {
        AMap, document, window: win, console, localStorage: localStorageMock,
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
    calls.labels.some(function (l) { const t = (l.opts && l.opts.text) || l.text || ''; return /km\d+–\d+ .*（[\d.]+km）/.test(t); }),
    '');
// 信息窗站点来源日期透出（S4）：站点信息窗统一拼 stationSourceNote()（数据包 sourceShort/builtAt）
let srcNote = '';
try { srcNote = qh.sandbox.stationSourceNote(); } catch (e) { srcNote = 'ERR ' + e.message; }
ok('站点来源日期透出（来源+快照日期）', /POI · \d{4}-\d{2}-\d{2}/.test(srcNote), srcNote);
ok('标题来自 ROUTE_META', !!qh.sandbox.ROUTE_META && document.title === qh.sandbox.ROUTE_META.title && document.title.length > 0, document.title);
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
ok('续航规划输出真实结果 + 快照声明（截断提示按数据实有实无透出）',
    elCache['planBox'].innerHTML.includes('全程需充电') && /时点快照/.test(elCache['dataCaveat'].textContent),
    elCache['dataCaveat'].textContent.slice(0, 60));
ok('标题来自 ROUTE_META', !!cx.sandbox.ROUTE_META && document.title === cx.sandbox.ROUTE_META.title && document.title.length > 0, document.title);
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
// 导入编辑层（S8）：导出 → 改 → 导入 → 生效；线路不匹配拒绝
const expText = ed2.sandbox.Edit.exportText();
ok('导出含 route 标记与文件头说明', /\/\/ route-chuanxi\.custom\.json/.test(expText) && /"route": "chuanxi"/.test(expText), '');
const expJson = JSON.parse(expText.slice(expText.indexOf('{')));
expJson.days = Object.assign({}, expJson.days, { '2': { title: '导入的标题' } });
ok('导入编辑层生效（校验通过 → 应用 → 落盘）',
    ed2.sandbox.Edit.importOverlay(expJson) === true &&
    ed2.sandbox.DAYS.filter(d => d.id === 2)[0].title === '导入的标题' &&
    /导入的标题/.test(lsStore['xianlumap.overlay.chuanxi'] || ''),
    '');
ok('导入拒绝线路不匹配（route 标记校验）',
    ed2.sandbox.Edit.importOverlay({ route: 'some-other-line', days: { '2': { title: '不应生效' } } }) === false &&
    ed2.sandbox.DAYS.filter(d => d.id === 2)[0].title === '导入的标题',
    '');

/* ---------- 选线器（S8：只加载 manifest + picker，不加载任何线路包/引擎） ---------- */
console.log('\n【4】选线器（按需加载）与入口结构');
// 静态结构：线路包/引擎/底图只出现在 ROUTE_VALID 分支的 document.write 里，无静态标签
ok('选线器分支存在且按需加载（无静态 engine/线路包标签）',
    /ROUTE_VALID/.test(html) &&
    /document\.write\('<script src="engine\/picker\.js">/.test(html) &&
    !/<script src="engine\/[a-z0-9-]+\.js"><\/script>/.test(html),
    '');
// vm 级：picker 页（ROUTE_KEY=''）渲染出全部线路卡片
created.length = 0;
const pickerSb = vm.createContext({ document, console, ROUTE_KEY: '' });
let pickerErr = null;
try {
    vm.runInContext(manifestSrc + '\n' + pickerSrc, pickerSb);
} catch (e) { pickerErr = e; }
const pickerRoot = created.filter(el => el.id === 'pickerRoot')[0];
ok('选线器渲染全部线路卡片（数据只来自 manifest）',
    !pickerErr && !!pickerRoot &&
    pickerRoot.innerHTML.indexOf('?route=qinghai-gansu') >= 0 &&
    pickerRoot.innerHTML.indexOf('?route=chuanxi') >= 0 &&
    pickerRoot.innerHTML.indexOf('?route=chengdu-lhasa-318') >= 0,
    pickerErr ? pickerErr.message.slice(0, 80) : '3 张卡片');
// 线路页不渲染选线器：ROUTE_KEY 已设时 picker 是 no-op
created.length = 0;
const pickerSb2 = vm.createContext({ document, console, ROUTE_KEY: 'chuanxi' });
vm.runInContext(manifestSrc + '\n' + pickerSrc, pickerSb2);
ok('线路页 picker 安全 no-op（不抢渲染）', created.filter(el => el.id === 'pickerRoot').length === 0, '');

/* ---------- 体验修复 1/2：编辑模式 × 双出发地 + 途经点引导 ---------- */
console.log('\n【5】编辑模式 × 双出发地（反馈 1）与途经点引导（反馈 2）');
const qh2 = bootRoute('qinghai-gansu');
const S = qh2.sandbox;
S.Edit.enter();
const lzB2 = created.filter(el => el.id === 'dyn:button' && el.onclick && el.textContent === S.STARTS[1].name)[0];
lzB2.onclick();
ok('非主出发地视角可进入编辑模式（不再被静默跳回）',
    S.Edit.isOn() === true && S.start === S.STARTS[1].id,
    '当前视角=' + S.start);
S.Edit.setDayField(5, 'title', '兰州视角改的标题');
ok('非主出发地视角改标题生效', S.DAYS.filter(d => d.id === 5)[0].title === '兰州视角改的标题', '');
ok('非主出发地视角分段编辑被显式拒绝（不静默、数据不变）',
    S.Edit.setSeg(5, 100, 200) === false && S.DAYS.filter(d => d.id === 5)[0].altKm[0] !== 100,
    '');
ok('视角受限提示文案数据驱动（含两个出发地名）',
    (function () { const h = S.Edit.segViewHint(); return h.indexOf(S.STARTS[1].name) >= 0 && h.indexOf(S.STARTS[0].name) >= 0; })(),
    S.Edit.segViewHint());
ok('切回主视角后分段编辑恢复可用', (function () {
    const xnB = created.filter(el => el.id === 'dyn:button' && el.onclick && el.textContent === S.STARTS[0].name)[0];
    xnB.onclick();
    return S.Edit.setSeg(5, 800, 900) === true && S.DAYS.filter(d => d.id === 5)[0].altKm[0] === 800;
})(), 'D5 → [800,900]');
let wpOk = false;
try { wpOk = Object.keys(JSON.parse(S.Edit.waypointsExportText())).length >= 20; } catch (e) {}
ok('途经点清单可复制导出（JSON 可解析、含全部途经点）', wpOk, '');
ok('引导含按当前线路生成的确切构建命令',
    S.Edit.waypointGuideText().indexOf('node tools/build-route.js ' + S.ROUTE_META.key) >= 0 &&
    S.Edit.waypointGuideText().indexOf('ROUTE_BUILD.waypoints') >= 0,
    S.ROUTE_META.key);

/* ---------- 坐标策略（S10）：库内 WGS-84 基准的往返精度 + 库一致性 ---------- */
console.log('\n【6】坐标往返精度（S10 厂商中立坐标策略）');
const { gcj2wgs, wgs2gcj } = (() => { try { return require('./lib/build-lib.js'); } catch (e) { return {}; } })();
let rtMax = 0, rtN = 0;
['qinghai-gansu', 'chuanxi', 'chengdu-lhasa-318'].forEach(id => {
    const dataSrc = fs.readFileSync(path.join(ROOT, 'route-defs', id + '.js'), 'utf8');
    const sb2 = {};
    vm.runInNewContext(dataSrc, sb2);
    const sample = (sb2.STATION_DATA.ev || []).concat(sb2.STATION_DATA.fuel || []).slice(0, 12);
    sample.forEach(s => {
        const w = gcj2wgs(s.lat, s.lng);
        const g = wgs2gcj(w[0], w[1]);
        const d = Math.hypot((g[0] - s.lat) * 111320, (g[1] - s.lng) * 111320 * Math.cos(s.lat * Math.PI / 180));
        rtN++;
        if (d > rtMax) rtMax = d;
    });
});
ok('GCJ02→WGS84→GCJ02 往返偏差 <2m（' + rtN + ' 个抽样站）', rtMax < 2, '最大 ' + rtMax.toFixed(4) + ' m');
let dbOk = false, dbCount = 0;
try {
    const dbSrc = fs.readFileSync(path.join(ROOT, 'data', 'db', 'stations.json'), 'utf8');
    const db = JSON.parse(dbSrc);
    dbCount = db.stations.length;
    const wgs = db.stations.every(s => typeof s.lat === 'number' && typeof s.lng === 'number' &&
        Array.isArray(s.sources) && s.sources.length > 0 && s.srcCoord && s.srcCoord.sys === 'gcj02');
    const roundtrip = db.stations.slice(0, 20).every(s => {
        const g = wgs2gcj(s.lat, s.lng);
        return Math.hypot(g[0] - s.srcCoord.lat, g[1] - s.srcCoord.lng) * 111320 < 2;
    });
    dbOk = dbCount >= 900 && wgs && roundtrip;
} catch (e) { dbOk = false; }
ok('共享库存在且记录形状合规（WGS 基准 + 来源记录 + GCJ 原值）', dbOk, dbCount + ' 条');

/* ---------- 途经点向导（S13）：加点→排序→删点→导出可被 build-route 消费 ---------- */
console.log('\n【7】途经点增删向导（S13）');
const { spawnSync } = require('child_process');
const wiz = bootRoute('chuanxi');
const W = wiz.sandbox.Wp;
ok('向导可用（Wp API + 初始列表=包内途经点）', !wiz.err && !!W && W.list.length === Object.keys(wiz.sandbox.ROUTE_BUILD.waypoints).length,
    W ? W.list.length + ' 个' : '无');
W.add('向导测试点A', 30.7, 104.1);
W.add('向导测试点B', 30.5, 103.9);
const wpAfterAdd = W.list.length;
ok('加点（GCJ 输入→按包 datum 转 WGS）', wpAfterAdd === Object.keys(wiz.sandbox.ROUTE_BUILD.waypoints).length + 2, wpAfterAdd + ' 个');
ok('排序与删除', W.move(W.list.length - 1, -1) === true && W.remove(W.list.length - 1) === true && W.list.length === wpAfterAdd - 1, W.list.length + ' 个');
const wizJson = W.exportJson();
const wizKeys = Object.keys(wizJson.waypoints);
const legRefsOk = wizJson.legs.every(l => wizJson.waypoints[l.from] && wizJson.waypoints[l.to] && (l.via || []).every(v => wizJson.waypoints[v]));
ok('导出结构（waypoints+legs 引用自洽，inputDatum 标注）',
    wizKeys.length === W.list.length && wizJson.legs.length >= 1 && legRefsOk && (wizJson.inputDatum === 'wgs84' || wizJson.inputDatum === 'gcj02'),
    wizKeys.length + ' 点 / ' + wizJson.legs.length + ' 段 / ' + wizJson.inputDatum);
// 消费级验证：临时包跑 build-route --dry（不联网），跑完即删
let dryOut = '';
try {
    const wizPkg = 'var ROUTE_BUILD = ' + JSON.stringify({
        inputDatum: wizJson.inputDatum, meta: { key: '__wiztest' },
        waypoints: wizJson.waypoints, legs: wizJson.legs,
        starts: [{ id: 't', name: '测试' }], poiRegions: ['测试区']
    }) + ';\n';
    fs.writeFileSync(path.join(ROOT, 'route-defs', '__wiztest.js'), wizPkg);
    const r = spawnSync('node', ['tools/build-route.js', '__wiztest', '--dry'], { cwd: ROOT, encoding: 'utf8' });
    dryOut = (r.stdout || '') + (r.stderr || '');
    ok('导出物被 build-route --dry 消费（契约校验通过，不联网）', r.status === 0 && dryOut.indexOf('契约校验通过') >= 0,
        dryOut.split('\n').filter(Boolean).slice(-1)[0] || ('exit ' + r.status));
} catch (e) {
    ok('导出物被 build-route --dry 消费（契约校验通过，不联网）', false, e.message.slice(0, 80));
} finally {
    try { fs.unlinkSync(path.join(ROOT, 'route-defs', '__wiztest.js')); } catch (e) {}
}
W.clear();
ok('恢复原始数据清掉途经点 overlay', !lsStore['xianlumap.waypoints.chuanxi'] && W.list.length === Object.keys(wiz.sandbox.ROUTE_BUILD.waypoints).length,
    W.list.length + ' 个（回原值）');

/* ---------- 出发日期（S13 排期）：设日期→日卡带星期→导出/导入/清除 ---------- */
console.log('\n【8】出发日期（S13 排期）');
const dep = bootRoute('chuanxi');
const DS = dep.sandbox;
DS.Edit.setDeparture('2026-10-03');
const depLis = created.filter(el => el.id === 'dyn:li').slice(-5);
ok('设日期后每天卡渲染「周X」', depLis.length === 5 && depLis.every(el => /周[一二三四五六日]/.test(el.innerHTML)),
    depLis[0] ? depLis[0].innerHTML.slice(0, 40) : '无');
ok('导出 overlay 带 departureDate', /"departureDate":\s*"2026-10-03"/.test(DS.Edit.exportText()), '');
// 导入恢复（清掉本地再导入）
delete lsStore['xianlumap.overlay.chuanxi'];
delete DS.ROUTE_META.departureDate;
const depJson = JSON.parse(DS.Edit.exportText().slice(DS.Edit.exportText().indexOf('{')));
ok('导入编辑层恢复 departureDate', DS.Edit.importOverlay(depJson) === true && DS.ROUTE_META.departureDate === '2026-10-03', '');
DS.Edit.setDeparture(null);
const depLis2 = created.filter(el => el.id === 'dyn:li').slice(-5);
ok('清除回纯序号态（无日期无星期）', !DS.ROUTE_META.departureDate &&
    depLis2.every(el => /^<span class="day-tag">D\d+<\/span>/.test(el.innerHTML)),
    depLis2[0] ? depLis2[0].innerHTML.slice(0, 30) : '无');

/* ---------- 移动端底部抽屉（S14）：窄屏激活 + 三态档位 ---------- */
console.log('\n【9】移动端底部抽屉（S14）');
const mob = bootRoute('chuanxi', { innerWidth: 390, innerHeight: 844 });
const M = mob.sandbox.window.__mobile;
ok('窄屏 boot 后抽屉系统激活（__mobile.isMobile）', !mob.err && M && M.isMobile() === true,
    mob.err ? mob.err.message.slice(0, 80) : '');
ok('默认档位 peek（露手柄+概要）', M && M.state() === 'peek', M ? M.state() : '无 __mobile');
ok('setSheet 切档状态机记账',
    (M.setSheet('full'), M.state() === 'full') && (M.setSheet('hidden'), M.state() === 'hidden') && (M.setSheet('peek'), M.state() === 'peek'), '');
const desk = bootRoute('chuanxi');
ok('桌面 boot 不接管（isMobile=false，桌面渲染零变化）',
    !desk.err && desk.sandbox.window.__mobile && desk.sandbox.window.__mobile.isMobile() === false, '');

console.log('\n结果: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);
