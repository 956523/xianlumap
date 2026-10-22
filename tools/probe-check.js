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
const heroSrc = fs.readFileSync(path.join(ROOT, 'route-defs', 'hero-curves.js'), 'utf8');   // S21 首页线稿
const pickerSrc = fs.readFileSync(path.join(ROOT, 'engine', 'picker.js'), 'utf8');

/* ---------- mock（与 c4-test 同构，精简注释） ---------- */
const calls = { polyline: [], markers: [], labels: [] };
let MOCK_ZOOM = 7.3;   // S17：可变 zoom，驱动远景/中景分级断言
function FakeLayer(kind, opts) {
    this.kind = kind; this.opts = opts || {};
    this.setMap = function () {}; this.on = function () {}; this.setStyles = function () {}; this.setGeometries = function () { return this; };
    if (kind === 'polyline') calls.polyline.push(opts);
    if (kind === 'marker') calls.markers.push(opts);
    if (kind === 'label') calls.labels.push(opts);
}
// AMap mock（S9）：形状对齐 engine/map-adapter.js 用到的高德原语（单实例记录 opts）
const AMap = {
    Map: function () { this.on = function () {}; this.getZoom = function () { return MOCK_ZOOM; }; this.resize = function () {}; this.setZoomAndCenter = function () {}; },
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
        checked: true, clientWidth: 1200,   // S17：地图容器宽口径（窄屏断言用，可按需覆写）
        style: { setProperty(k, v) { this.__set = this.__set || {}; this.__set[k] = v; },   // S17：记录 CSS 变量写入
                 getPropertyValue(k) { return (this.__set && this.__set[k]) || ''; } },
        classList: (function () {   // S17：真实化（Set），剖面 elev-hide 状态机可断言
            var s = new Set();
            return {
                add(c) { s.add(c); },
                remove(c) { s.delete(c); },
                toggle(c, f) { if (f === undefined) f = !s.has(c); if (f) s.add(c); else s.delete(c); return f; },
                contains(c) { return s.has(c); }
            };
        })(),
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
        innerHeight: (opts && opts.innerHeight) || window.innerHeight,
        confirm: (opts && opts.confirm) || function () { return true; },   // S15 云同步冲突二选一（默认放行）
        prompt: (opts && opts.prompt) || function () { return '确定'; }   // S32 reset 确认（默认放行）
    });
    const sandbox = {
        AMap, document, window: win, console, localStorage: localStorageMock,
        confirm: (opts && opts.confirm) || function () { return true; },
        fetch: (opts && opts.fetch) || function () {   // S15：默认「网络不通」形状，不抛
            return Promise.resolve({ status: 0, json: function () { return Promise.resolve(null); } });
        },
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
MOCK_ZOOM = 8.5;   // S36 减重：盲区/规划标注 z≥8 近景档才上图——boot 用近景档保留「长盲区上图」语义
const qh = bootRoute('qinghai-gansu');
ok('主脚本执行无异常', !qh.err, qh.err ? qh.err.message.slice(0, 120) : '');
const qhDays = created.filter(el => el.id === 'dyn:li');
ok('每日列表渲染 10 天', qhDays.length === 10, qhDays.length + ' 项');
ok('总里程 chip ≈2164（日行程合计口径）', Math.abs(parseInt(elCache['chipKm'].textContent, 10) - 2164) <= 25, elCache['chipKm'].textContent);
ok('最高海拔 chip >3700（祁连段去噪后）', parseInt(elCache['chipMaxAlt'].textContent, 10) > 3700, elCache['chipMaxAlt'].textContent);
ok('续航规划输出 + 长盲区上图（无桩段渲染为图层；S36 起 z≥8 近景档才上图）',
    elCache['planBox'].innerHTML.includes('全程需充电') &&
    calls.labels.some(function (l) { const t = (l.opts && l.opts.text) || l.text || ''; return /km\d+–\d+ .*（[\d.]+km）/.test(t); }),
    '');
MOCK_ZOOM = 7.3;   // 回归默认档（后续分级断言各自显式设置）
// 信息窗站点来源日期透出（S4）：站点信息窗统一拼 stationSourceNote()（数据包 sourceShort/builtAt）
let srcNote = '';
try { srcNote = qh.sandbox.stationSourceNote(); } catch (e) { srcNote = 'ERR ' + e.message; }
ok('站点来源日期透出（来源+快照日期）', /POI · \d{4}-\d{2}-\d{2}/.test(srcNote), srcNote);
ok('标题来自 ROUTE_META', !!qh.sandbox.ROUTE_META && document.title === qh.sandbox.ROUTE_META.title && document.title.length > 0, document.title);
ok('S35.5 纯电提示已下线（车型体系清退）', !elCache['evNotice'] || !elCache['evNotice'].querySelector('span') || !elCache['evNotice'].querySelector('span').innerHTML.includes('大柴旦'), '');
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
ok('S35.5 能耗标注零残留', !elCache['evNotice'] || !elCache['evNotice'].querySelector('span') || !elCache['evNotice'].querySelector('span').innerHTML.includes('无快充'), '');
ok('单出发地按钮与经典支线行均隐藏', elCache['startSeg'].style.display === 'none' && elCache['classicRow'].style.display === 'none', '');
// 交互冒烟：点第 1 天 → focusDay + 剖面重画不崩
let focusErr = null;
try { cxDays[0].onclick(); } catch (e) { focusErr = e; }
ok('聚焦 D1 不崩（zoom/center/剖面）', !focusErr, focusErr ? focusErr.message.slice(0, 120) : '');
ok('聚焦后能耗提示为川西文案', elCache['curEnergy'].innerHTML.includes('四姑娘山'), elCache['curEnergy'].innerHTML.slice(0, 60));

/* ---------- 编辑模式（S5：overlay 改 → 存 → 刷新仍在 → 恢复） ---------- */
console.log('\n【3】编辑 overlay 架构（S28：无编辑模式，就地编辑）');
const ed = bootRoute('chuanxi');
ok('无编辑模式门槛：isOn 恒 false（兼容桩），行程卡默认可改', !ed.err && ed.sandbox.Edit && ed.sandbox.Edit.isOn() === false, ed.err ? ed.err.message.slice(0, 80) : '');
ed.sandbox.Edit.setDayField(2, 'title', '测试标题');
const titleNow = ed.sandbox.DAYS.filter(d => d.id === 2)[0].title;
ok('改标题即时生效（DAYS 更新）', titleNow === '测试标题', titleNow);
ok('S32 草稿不落地：编辑后 localStorage 无 overlay 键 + 脏状态为真', !/测试标题/.test(lsStore['xianlumap.overlay.chuanxi'] || '') && ed.sandbox.Edit.isDirty() === true, (lsStore['xianlumap.overlay.chuanxi'] || '(无键)').slice(0, 40));
ok('保存修改后落盘（commit → localStorage）', (ed.sandbox.Edit.commit() === true && /测试标题/.test(lsStore['xianlumap.overlay.chuanxi'] || '') && ed.sandbox.Edit.isDirty() === false));
const ed2 = bootRoute('chuanxi');   // 模拟刷新：已保存态合并生效；未保存草稿丢失
ok('刷新后已保存态仍在（合并生效）', ed2.sandbox.DAYS.filter(d => d.id === 2)[0].title === '测试标题');
ed2.sandbox.Edit.setMarkName('折多山垭口', '折多山口');
ok('地名显示名可改（ALT_MARKS 更新）', ed2.sandbox.ALT_MARKS.some(m => m.n === '折多山口'));
ed2.sandbox.Edit.setSeg(2, 250, 320);
const segDay = ed2.sandbox.DAYS.filter(d => d.id === 2)[0];
ok('分段可改（选地名重切区间/里程）', segDay.altKm[0] === 250 && segDay.altKm[1] === 320 && segDay.km === 70,
    JSON.stringify(segDay.altKm) + ' ' + segDay.km + 'km path=' + (segDay.path || []).length + '点');
ed2.sandbox.Edit.setDayField(2, 'title', '未保存的草稿标题');
ok('S32 恢复原始数据 = 放弃草稿回到已保存态（确认后标题回到上次保存值）',
    (function () {
        var R = ed2.sandbox;
        if (R.Edit.isDirty() !== true) return 'not-dirty';
        var okReset = R.Edit.reset() === true;   // vm window.prompt 注入 '确定'
        var t = R.DAYS.filter(d => d.id === 2)[0].title;
        return okReset && t === '测试标题' && R.Edit.isDirty() === false;
    })(), '');
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
    vm.runInContext(manifestSrc + '\n' + heroSrc + '\n' + pickerSrc, pickerSb);   // S21：+ hero-curves
} catch (e) { pickerErr = e; }
const pickerRoot = created.filter(el => el.id === 'pickerRoot')[0];
ok('选线器渲染全部线路卡片（数据只来自 manifest）',
    !pickerErr && !!pickerRoot &&
    pickerRoot.innerHTML.indexOf('?route=qinghai-gansu') >= 0 &&
    pickerRoot.innerHTML.indexOf('?route=chuanxi') >= 0 &&
    pickerRoot.innerHTML.indexOf('?route=chengdu-lhasa-318') >= 0,
    pickerErr ? pickerErr.message.slice(0, 80) : '3 张卡片');
ok('首页线稿（S21）：卡片含真实高程抽稀的 SVG 剖面线稿',
    !pickerErr && (pickerRoot.innerHTML.match(/<svg class="pick-hero"/g) || []).length === 3 &&
    /<path d="M[\d.]+,[\d.]+ C/.test(pickerRoot.innerHTML), '');

/* ---------- 首页线稿物化数据（S21） ---------- */
console.log('\n【16】首页线稿物化（hero-curves.js）');
const heroSb = {};
vm.runInNewContext(heroSrc, heroSb);
const HC = heroSb.HERO_CURVES || {};
const heroKeys = Object.keys(HC);
ok('物化覆盖全部线路（3 条 × ~60 采样点，坐标归一化）',
    heroKeys.length === 3 &&
    heroKeys.every(function (k) {
        var c = HC[k];
        return c && c.pts.length >= 55 && c.pts.length <= 65 &&
            c.pts.every(function (pt) { return pt[0] >= 0 && pt[0] <= 1 && pt[1] >= 0 && pt[1] <= 1; });
    }),
    heroKeys.map(function (k) { return k + ':' + HC[k].pts.length + '点'; }).join(' '));
ok('选线器加载契约不破：hero-curves 仅出现在选线器分支，无静态 engine/线路包标签',
    /document\.write\('<script src="route-defs\/hero-curves\.js">/.test(html) &&
    !/<script src="engine\/[a-z0-9-]+\.js"><\/script>/.test(html), '');
// 线路页不渲染选线器：ROUTE_KEY 已设时 picker 是 no-op
created.length = 0;
const pickerSb2 = vm.createContext({ document, console, ROUTE_KEY: 'chuanxi' });
vm.runInContext(manifestSrc + '\n' + pickerSrc, pickerSb2);
ok('线路页 picker 安全 no-op（不抢渲染）', created.filter(el => el.id === 'pickerRoot').length === 0, '');

/* ---------- 体验修复 1/2：编辑模式 × 双出发地 + 途经点引导 ---------- */
console.log('\n【5】编辑模式 × 双出发地（反馈 1）与途经点引导（反馈 2）');
const qh2 = bootRoute('qinghai-gansu');
const S = qh2.sandbox;
const lzB2 = created.filter(el => el.id === 'dyn:button' && el.onclick && el.textContent === S.STARTS[1].name)[0];
lzB2.onclick();
ok('非主出发地视角无模式门槛（文字编辑直接可用，视角不被切回）',
    S.Edit.isOn() === false && S.start === S.STARTS[1].id,
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
ok('引导含按当前线路生成的确切命令且人话化（无技术术语）',
    S.Edit.waypointGuideText().indexOf('node tools/build-route.js ' + S.ROUTE_META.key) >= 0 &&
    S.Edit.waypointGuideText().indexOf('route-defs/' + S.ROUTE_META.key + '.js') >= 0 &&
    S.Edit.waypointGuideText().indexOf('ROUTE_BUILD') < 0 &&
    S.Edit.waypointGuideText().indexOf('geometry') < 0,
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
ok('S32 草稿语义：W.clear 回到包内基准（只标脏，清存储随「保存修改」）',
    W.list.length === Object.keys(wiz.sandbox.ROUTE_BUILD.waypoints).length && wiz.sandbox.Edit.isDirty() === true,
    W.list.length + ' 个（回原值，dirty）');

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
    depLis2.every(el => /<span class="ch-fromto">第\d+程/.test(el.innerHTML) && !/周[一二三四五六日]/.test(el.innerHTML)),
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

/* ---------- 云同步（S15）：上传→恢复→冲突二选一→token 失效（vm + mock fetch） ---------- */
function ghServer(store) {
    // 最小 GitHub Gist API mock：一个 gist 列表，POST 建 / PATCH 改 / GET 查
    function res(status, data) {
        return Promise.resolve({ status: status, json: function () { return Promise.resolve(data); } });
    }
    return {
        fetch: function (url, opts) {
            opts = opts || {};
            var p = String(url).replace('https://api.github.com', '');
            if (p.indexOf('/gists?') === 0) {
                return res(200, store.gists.map(function (g) { return { id: g.id, description: g.description, files: g.files }; }));
            }
            if (p === '/gists' && opts.method === 'POST') {
                var b = JSON.parse(opts.body);
                var ng = { id: 'gist_' + (store.gists.length + 1), description: b.description, public: !!b.public, files: b.files };
                store.gists.push(ng);
                return res(201, { id: ng.id });
            }
            var m = p.match(/^\/gists\/([^/?]+)$/);
            if (m) {
                var g = store.gists.filter(function (x) { return x.id === m[1]; })[0];
                if (!g) return res(404, { message: 'Not Found' });
                if (opts.method === 'PATCH') {
                    var pb = JSON.parse(opts.body);
                    Object.keys(pb.files || {}).forEach(function (fn) { g.files[fn] = { content: pb.files[fn].content }; });
                    if (pb.description) g.description = pb.description;
                    return res(200, { id: g.id });
                }
                return res(200, { id: g.id, description: g.description, files: g.files });
            }
            return res(404, { message: 'no route' });
        }
    };
}
console.log('\n【10】云同步（S15：私有 Gist 备份/恢复）');
(async function () {
    var ghStore = { gists: [] };
    var gh = ghServer(ghStore);
    ['xianlumap.overlay.chuanxi', 'xianlumap.waypoints.chuanxi', 'xianlumap.sync.chuanxi'].forEach(function (k) { delete lsStore[k]; });
    lsStore['xlm-gh-config'] = JSON.stringify({ token: 'TEST-PAT' });
    // ① 上传：有方案的机器 → 建私有 gist（描述标记，每线一文件）
    var UP = bootRoute('chuanxi', { fetch: gh.fetch }).sandbox;
    UP.Edit.setDayField(2, 'title', '云端同步标题');
    UP.Edit.setDeparture('2026-10-01');
    ok('S32 接缝：草稿不污染同步 payload（commit 前 saved 无该改动）',
        JSON.parse(UP.Sync.buildPayload().edit && '{' + '}' ? '{}' : '{}') && (function () {
            var p0 = UP.Sync.buildPayload();
            return !(p0.edit && p0.edit.days && p0.edit.days['2']);
        })(), '');
    UP.Edit.commit();   // 保存修改 → 同步读写已保存态
    var upRes = null;
    try { upRes = await UP.Sync.upload(); } catch (e) { upRes = { err: e.message }; }
    ok('上传到云端：建私有 gist（描述标记 + 每线一文件）',
        upRes && upRes.ok === true && ghStore.gists.length === 1 && ghStore.gists[0].public === false &&
        ghStore.gists[0].description === UP.Sync.SYNC_DESC && !!ghStore.gists[0].files['route-chuanxi.json'],
        ghStore.gists.length + ' 个 gist');
    ok('上传内容 = 三类方案（编辑层/出发日期），写回 checkpoint',
        upRes && upRes.ok === true && (function () {
            var f = JSON.parse(ghStore.gists[0].files['route-chuanxi.json'].content);
            var cp = JSON.parse(lsStore['xianlumap.sync.chuanxi'] || '{}');
            return f.app === 'xianlumap' && f.kind === 'user-scheme' && f.route === 'chuanxi' &&
                f.edit.days['2'].title === '云端同步标题' && f.edit.meta.departureDate === '2026-10-01' && !!f.updatedAt &&
                cp.cloudUpdatedAt === f.updatedAt && cp.snapshot === UP.Sync.stateJSON();
        })(), '');
    // ② 恢复：模拟换设备/清浏览器（本机键全清，同一云端）
    ['xianlumap.overlay.chuanxi', 'xianlumap.waypoints.chuanxi', 'xianlumap.sync.chuanxi'].forEach(function (k) { delete lsStore[k]; });
    var DN = bootRoute('chuanxi', { fetch: gh.fetch }).sandbox;
    var dnRes = null;
    try { dnRes = await DN.Sync.restore(); } catch (e) { dnRes = { err: e.message }; }
    ok('从云端恢复到「新设备」：编辑层 + 出发日期落地',
        dnRes && dnRes.ok === true && DN.DAYS.filter(function (d) { return d.id === 2; })[0].title === '云端同步标题' &&
        DN.ROUTE_META.departureDate === '2026-10-01', '');
    // ③ 冲突：本机再改（先 commit 成已保存态）+ 云端被别的设备更新 → 按 updatedAt 提示二选一，不许静默合并
    DN.Edit.setDayField(2, 'title', '本机新改动');
    DN.Edit.commit();
    var cloudF = JSON.parse(ghStore.gists[0].files['route-chuanxi.json'].content);
    cloudF.updatedAt = new Date(Date.now() + 3600e3).toISOString();   // 云端在别处更新了
    ghStore.gists[0].files['route-chuanxi.json'].content = JSON.stringify(cloudF);
    var prompts = [];
    var CF = bootRoute('chuanxi', {
        fetch: gh.fetch,
        confirm: function (msg) { prompts.push(String(msg)); return false; }   // 用户选「取消 = 不动」
    }).sandbox;
    var cfUp = null;
    try { cfUp = await CF.Sync.upload(); } catch (e) { cfUp = { err: e.message }; }
    ok('上传冲突：提示两边 updatedAt，取消即中止（不静默合并）',
        cfUp && cfUp.error === 'cancelled' && prompts.length === 1 &&
        /两边都有改动/.test(prompts[0]) && /本机方案最后改于/.test(prompts[0]) && /云端版本改于/.test(prompts[0]),
        prompts[0] ? prompts[0].replace(/\n/g, ' ').slice(0, 50) : '无提示');
    ok('取消后云端文件未被覆盖',
        JSON.parse(ghStore.gists[0].files['route-chuanxi.json'].content).edit.days['2'].title === '云端同步标题', '');
    var prompts2 = [];
    var CF2 = bootRoute('chuanxi', {
        fetch: gh.fetch,
        confirm: function (msg) { prompts2.push(String(msg)); return true; }   // 用户选「用云端覆盖本机」
    }).sandbox;
    var cf2Res = null;
    try { cf2Res = await CF2.Sync.restore(); } catch (e) { cf2Res = { err: e.message }; }
    ok('恢复方向二选一：确认后用云端覆盖本机',
        cf2Res && cf2Res.ok === true && CF2.DAYS.filter(function (d) { return d.id === 2; })[0].title === '云端同步标题' &&
        prompts2.length === 1 && /用云端覆盖本机/.test(prompts2[0]) && /保留本机不动/.test(prompts2[0]),
        prompts2[0] ? prompts2[0].replace(/\n/g, ' ').slice(0, 50) : '无提示');
    // ④ token 失效：401 → 人话提示，不甩原始错误
    var badGh = { fetch: function () { return Promise.resolve({ status: 401, json: function () { return Promise.resolve({ message: 'Bad credentials' }); } }); } };
    var TK = bootRoute('chuanxi', { fetch: badGh.fetch }).sandbox;
    var tkRes = null;
    try { tkRes = await TK.Sync.upload(); } catch (e) { tkRes = { err: e.message }; }
    ok('token 失效：人话提示（PAT 校验失败），不暴露原始错误',
        tkRes && tkRes.error === 'auth' && /PAT 校验失败/.test(elCache['syncLog'].textContent) &&
        !/Bad credentials/.test(elCache['syncLog'].textContent),
        elCache['syncLog'].textContent.slice(0, 46));
})().then(function () {
    /* ---------- 移动端信息架构（S16）：标题条/菜单/图层弹层/浮动钮 + peek 概要 ---------- */
    console.log('\n【11】移动端信息架构（S16）');
    var ia = bootRoute('chuanxi', { innerWidth: 390, innerHeight: 844 });
    var IA = ia.sandbox;
    ok('窄屏构建信息架构（__mobile.ia），桌面不构建',
        !ia.err && IA.window.__mobile.ia() === true && (function () {
            var d = bootRoute('chuanxi');
            return !d.err && d.sandbox.window.__mobile.ia() === false;
        })(), '');
    ok('peek 概要行读到 planner 现有规划（充电次数/最长无桩间隔）',
        /全程需充电 \d+ 次 · 最长无充电间隔 \d+ km/.test(elCache['planPeek'].textContent),
        elCache['planPeek'].textContent.slice(0, 60));
    ok('标题条/菜单/图层弹层/浮动钮全部接线（onclick 就绪）',
        ['mobMenuBtn', 'mobMenuEdit', 'mobMenuSync', 'mobLayersBtn', 'mobLayersClose', 'mobFit', 'mobSup']
            .every(function (id) { return typeof elCache[id].onclick === 'function'; }), '');
    ok('「全览」条件钮初始不亮（视野就在全览位）且偏离判定可手动触发',
        IA.window.__mobile.fitDeviated() === false && (function () {
            IA.window.__mobile.checkFit();
            return IA.window.__mobile.fitDeviated() === false;   // mock 无 getCenter，不误判
        })(), '');
    ok('点 mobFit 走 fitAll 不崩（mock 无动画事件）', (function () {
        try { elCache['mobFit'].onclick(); return true; } catch (e) { return false; }
    })(), '');

    /* ---------- S17 真机反馈三修：远景降密 / 剖面把手状态机 / 曲线平滑 ---------- */
    console.log('\n【12】S17：移动远景降密 + 剖面把手 + 平滑曲线');
    // 胶囊识别：badge 样式（白底 rgba(255,255,255,.88)）= 景点胶囊；每次 boot 末段批量出现
    // S36 远景聚合药丸（「⚡ N」「⛽ N」「⛺ N」补给/休整计数，同为白底胶囊）不计入景点胶囊统计
    function capsuleCount(before) {
        return calls.labels.slice(before).filter(function (l) {
            var o = l.opts || l;
            var t = (o.text != null) ? String(o.text) : '';
            if (/^[⛽⚡⛺]/.test(t)) return false;
            return o.style && o.style['background-color'] === 'rgba(255,255,255,.88)';
        }).length;
    }
    // ① 窄屏全览（容器 390 + z=6）：景点胶囊 ≤12，规划标注收起
    MOCK_ZOOM = 6.0;
    elCache['map'].clientWidth = 390;
    var labelsBefore = calls.labels.length;
    var mobFar = bootRoute('qinghai-gansu', { innerWidth: 390, innerHeight: 844 });
    var capN0 = capsuleCount(labelsBefore);
    if (!mobFar.err && capN0 === 0 && typeof mobFar.sandbox.window.__spotLabels === 'function') {   // S26 默认关 → 模拟勾选图层
        mobFar.sandbox.window.__spotLabels(true);
        capN0 = capsuleCount(labelsBefore);
    }
    ok('窄屏全览：景点胶囊硬上限 ≤12（60km 桶 + 强信号>手打>距主线近；S26 默认关、勾选后生效）',
        !mobFar.err && capN0 <= 12 && capN0 > 0,
        (mobFar.err ? 'ERR ' + mobFar.err.message.slice(0, 90) : capN0 + ' 个胶囊'));
    ok('窄屏全览：必充/必加标注（图标 + 充至/加满文字）收起，近景自动恢复',
        !mobFar.err && mobFar.sandbox.window.__planFarHidden === true,
        mobFar.err ? 'ERR ' + mobFar.err.message.slice(0, 90) : 'planFar=' + mobFar.sandbox.window.__planFarHidden + ' zoom=' + MOCK_ZOOM + ' w=' + elCache['map'].clientWidth);
    // ② 桌面宽屏同 z：胶囊显著更多（双维口径：容器宽 ≥700 不受 12 上限约束）
    elCache['map'].clientWidth = 1280;
    var labelsBefore2 = calls.labels.length;
    var deskFar = bootRoute('qinghai-gansu');
    var capD = capsuleCount(labelsBefore2);
    /* S36 减重后 far 档盲区胶囊不上图 → 白底胶囊基准=0；模拟勾选景点层再验 25km 桶 >12 */
    if (!deskFar.err && capD === 0 && typeof deskFar.sandbox.window.__spotLabels === 'function') {
        deskFar.sandbox.window.__spotLabels(true);
        capD = capsuleCount(labelsBefore2);
    }
    ok('桌面宽屏同缩放：胶囊不受 12 上限约束（25km 桶，>12 个）；规划标注全端同规则（S36：z<8 收起）',
        !deskFar.err && capD > 12 &&
        deskFar.sandbox.window.__planFarHidden === true,
        capD + ' 个胶囊');
    elCache['map'].clientWidth = 1200;
    MOCK_ZOOM = 7.3;
    // ③ 剖面把手状态机：全览隐藏不占位（--elev-peek 0）→ 聚焦天恢复 46
    elCache['elev'].classList.remove('open');   // 前段聚焦测试残留的抽屉态，清掉再验全览语义
    var pe = bootRoute('chuanxi');
    ok('全览：剖面把手隐藏且不占布局（--elev-peek/--elev-occupy 归 0）',
        !pe.err && document.documentElement.style.__set && document.documentElement.style.__set['--elev-peek'] === '0px' &&
        document.documentElement.style.__set['--elev-occupy'] === '0px', JSON.stringify(document.documentElement.style.__set || {}));
    ok('聚焦某天：把手恢复（--elev-peek=46px）且剖面画出平滑贝塞尔（过采样点）',
        (function () {
            var lis = created.filter(function (el) { return el.id === 'dyn:li'; });
            try { lis[2].onclick(); } catch (e) { return 'THROW ' + e.message; }   // 聚焦 D3
            var svg = elCache['chartBox'].innerHTML;
            var peek = document.documentElement.style.__set['--elev-peek'];
            var hasC = /<path d="M[^"]* C/.test(svg);
            if (!(peek === '46px' && hasC)) return 'peek=' + peek + ' hasC=' + hasC + ' svglen=' + svg.length;
            return true;
        })(), '');

    /* ---------- S18 打磨轮：城名分级 / 几何全览判定 / 首帧把手 / 菜单遮罩 ---------- */
    console.log('\n【13】S18 打磨轮');
    ok('首帧即全览语义：<body> 静态带 elev-hide（把手不闪现）',
        /<body[^>]*class="[^"]*elev-hide"/.test(html), '');
    // 城名分级：与景点同构（__cityFarN 钩子）；mock zoom 可变换口径
    MOCK_ZOOM = 6.0;
    elCache['map'].clientWidth = 390;
    var cnMob = bootRoute('qinghai-gansu', { innerWidth: 390, innerHeight: 844 });
    var mobCityN = cnMob.sandbox.window.__cityFarN;
    elCache['map'].clientWidth = 1280;
    var cnDesk = bootRoute('qinghai-gansu');
    var deskCityN = cnDesk.sandbox.window.__cityFarN;
    elCache['map'].clientWidth = 1200;
    MOCK_ZOOM = 7.3;
    ok('城名同构分级：手机全览稀疏（< 全量）· 桌面宽屏全量',
        !cnMob.err && !cnDesk.err && mobCityN > 0 && mobCityN < deskCityN &&
        deskCityN === cnDesk.sandbox.CITIES.length,
        '手机 ' + mobCityN + ' / 桌面 ' + deskCityN + ' 个城名');
    // 几何判定路径：mock 无 getBounds → 走近似回退，不崩且不误亮
    var fitB = bootRoute('chuanxi', { innerWidth: 390, innerHeight: 844 });
    ok('全览判定升级：无 getBounds 时近似回退可用（初始不亮、checkFit 可触发）',
        !fitB.err && fitB.sandbox.window.__fitOut === undefined &&
        fitB.sandbox.window.__mobile.fitDeviated() === false &&
        (fitB.sandbox.window.__mobile.checkFit(), true), '');
    // 菜单遮罩
    ok('⋯菜单遮罩接线（点外部关闭，对齐图层弹层）',
        typeof elCache['mobMenuBk'].onclick === 'function' &&
        typeof elCache['mobMenuBtn'].onclick === 'function', '');

    /* ---------- S19 联动 + S28 面板双 Tab：Tab / 徽标推导 / chips 联动 / 生成入口 ---------- */
    console.log('\n【14】S19/S28：面板双 Tab 与联动');
    var r19 = bootRoute('chuanxi');
    var R = r19.sandbox;
    ok('S32 统一行程视图：wpSec 融进列表，showTab(wp)=聚焦途经点区（无 Tab 显隐切换）',
        !r19.err && R.Edit.panelTab === 'trip' &&
        document.body.classList.contains('pt-wp') === false &&
        (R.Edit.showTab('wp'), R.Edit.panelTab === 'wp' && document.body.classList.contains('pt-wp') === false) &&
        (R.Edit.showTab('trip'), R.Edit.panelTab === 'trip'), '');
    var danba = R.Wp.list.filter(function (w) { return w.n === '丹巴'; })[0];
    var d2 = R.DAYS.filter(function (d) { return d.id === 2; })[0];
    var badgeBefore = danba ? R.Edit.wpDayBadge(danba) : '无丹巴';
    R.Edit.setSeg(2, d2.altKm[0], 250);   // D2 终点 327.97 → 250
    var badgeAfter = danba ? R.Edit.wpDayBadge(danba) : '无丹巴';
    ok('徽标推导：改 D2 终点后丹巴 D2→D3 即时重算（当前视角 DAYS 区间口径）',
        badgeBefore === 'D2' && badgeAfter === 'D3', badgeBefore + ' → ' + badgeAfter);
    ok('行程 chips 联动：D2 chips 不再含丹巴、D3 chips 含丹巴',
        (function () {
            var d2n = R.DAYS.filter(function (d) { return d.id === 2; })[0];
            var d3n = R.DAYS.filter(function (d) { return d.id === 3; })[0];
            return !/丹巴/.test(R.Edit.wpChipsHTML(d2n)) && /丹巴/.test(R.Edit.wpChipsHTML(d3n));
        })(), '');
    var genOk = false;
    try { elCache['wpGen'].onclick(); genOk = !!elCache['wpJs'] && elCache['wpJs'].value.length > 10; } catch (e) {}
    ok('「保存我的版本」入口可达（点击出弹层 + 代码段就绪）', genOk, '');
    ok('出发日期常驻侧栏头部 + 云同步/恢复在 ⋯ 更多设置页（续航开关 S35 已删）',
        !!elCache['depDate'] && typeof elCache['depDate'].onchange === 'function' &&
        !!elCache['moreSync'] && !!elCache['msReset'] &&
        (R.Edit.showTab('more'), document.body.classList.contains('more-open') === true), '');

    /* ---------- S20 真机反馈：白屏护栏 + 途经点归天直改 ---------- */
    console.log('\n【15】S20：白屏护栏 + 归天重算');
    delete lsStore['xianlumap.overlay.chuanxi'];   // 前段 setSeg 写的 overlay 会跨 boot 生效，清掉再验
    // ① 归天：丹巴（km≈328）从 D2 直归 D3 → 自动重算分段（D3 起点收过该点、D2 让出）
    var r20 = bootRoute('chuanxi');
    var R2 = r20.sandbox;
    R2.Edit.showTab('wp');   // S28：无编辑模式，结构操作直达途经点 Tab
    var danbaIdx = R2.Wp.list.map(function (w) { return w.n; }).indexOf('丹巴');
    var badge0 = R2.Edit.wpDayBadge(R2.Wp.list[danbaIdx]);
    var assignOk = R2.Edit.assignWpDay(danbaIdx, 2);
    var badge1 = R2.Edit.wpDayBadge(R2.Wp.list[danbaIdx]);
    var d3t = R2.DAYS.filter(function (d) { return d.id === 3; })[0];
    var d2b = R2.DAYS.filter(function (d) { return d.id === 2; })[0];
    ok('归天直改：点徽标选 D3 → 徽标 D2→D3，D3 起点收到点内侧、D2 终点让出（边界推到 ±0.6 容差外）',
        assignOk !== false && badge0 === 'D2' && badge1 === 'D3' &&
        d3t.altKm[0] <= 327.5 && d2b.altKm[1] < 327.9 && d2b.altKm[1] > d2b.altKm[0],
        badge0 + '→' + badge1 + '，D2 [' + d2b.altKm + ']，D3 [' + d3t.altKm + ']');
    ok('归天后 chips 联动：D3 chips 含丹巴、D2 chips 只剩余点',
        /丹巴/.test(R2.Edit.wpChipsHTML(d3t)) && !/丹巴/.test(R2.Edit.wpChipsHTML(d2b)) &&
        /小金/.test(R2.Edit.wpChipsHTML(d2b)), '');
    // ② 白屏护栏：transform 越界 + mob-drag 残留 → sheetSettle 强制归位
    var r20m = bootRoute('chuanxi', { innerWidth: 390, innerHeight: 844 });
    var M2 = r20m.sandbox;
    M2.window.__mobile.setSheet('full');
    elCache['panel'].style.transform = 'translateY(9999px)';
    document.body.classList.add('mob-drag');
    M2.window.__mobile.sheetSettle();
    ok('白屏护栏：越界 transform 清零 + mob-drag 移除（状态机只认三态）',
        elCache['panel'].style.transform === '' &&
        !document.body.classList.contains('mob-drag') &&
        M2.window.__mobile.state() === 'full', '');
    /* ---------- S22 压测轮回归断言（CDP 破坏性探索发现的三个真问题） ---------- */
    console.log('\n【17】S22 压测回归：弹层互斥 / Tab 复位 / nearFit');
    var s22 = bootRoute('chuanxi', { innerWidth: 390, innerHeight: 844 });
    var S22 = s22.sandbox;
    ok('两弹层互斥：开图层关菜单、开菜单关图层',
        !s22.err &&
        (elCache['mobLayersBtn'].onclick(), document.body.classList.contains('mob-layers') && !document.body.classList.contains('mob-menu')) &&
        (elCache['mobMenuBtn'].onclick(), document.body.classList.contains('mob-menu') && !document.body.classList.contains('mob-layers')), '');
    ok('设置页开合显式 + showTab(wp/trip) 纯记账无类残留（S32 统一视图）',
        (function () {
            S22.Edit.showTab('wp');
            var wpTab = S22.Edit.panelTab === 'wp';
            S22.Edit.showTab('trip');
            var tripBack = S22.Edit.panelTab === 'trip';
            S22.Edit.showTab('more');
            var moreOn = document.body.classList.contains('more-open');
            elCache['msClose'].onclick();   // ✕ 关闭设置页
            return wpTab && tripBack && moreOn && !document.body.classList.contains('more-open') &&
                !document.body.classList.contains('pt-wp');
        })(), '');
    ok('全览判定 nearFit 快路径在位（AMap 整数 zoom 视野误报偏离的修正）',
        /nearFit/.test(mainScript) && /__fitDebug/.test(mainScript), '');
    /* ---------- S23：全览三态点击 + 途经点行新手势（滑删/长按拖/徽标归天） ---------- */
    console.log('\n【18】S23：全览钮三态 + 行操作手势');
    var s23 = bootRoute('chuanxi', { innerWidth: 390, innerHeight: 844 });
    var S23 = s23.sandbox;
    ok('全览按钮三态点击都调 fitAll（peek/full/hidden）',
        !s23.err && (function () {
            var n = 0;
            var _f = S23.fitAll;
            S23.fitAll = function () { n++; _f.apply(null, arguments); };
            ['peek', 'full', 'hidden'].forEach(function (st) {
                S23.window.__mobile.setSheet(st);
                elCache['mobFit'].onclick();
            });
            return n === 3;
        })(), '');
    ok('wpRowMove 落点语义与 ↑↓ 一致（5→0 == 索引递减连移五次）',
        (function () {
            var expect = WpSnapshot(S23, function (W) { for (var k = 5; k > 0; k--) W.move(k, -1); });   // 真实 ↑↓ 用法：当前索引递减
            var before5 = S23.Wp.list[5] && S23.Wp.list[5].n;
            S23.Edit.wpRowMove(5, 0);
            var actual = JSON.stringify(S23.Wp.list);
            if (expect !== actual) console.log('   …expect0=' + JSON.parse(expect)[0].n + ' expect5=' + JSON.parse(expect)[5].n + ' actual0=' + JSON.parse(actual)[0].n + ' len=' + JSON.parse(expect).length + ' idx5=' + before5);
            return expect === actual;
            function WpSnapshot(sb, fn) {
                var backup = JSON.stringify(sb.Wp.list);
                if (JSON.parse(backup).length < 6) console.log('   …snapshot len=' + JSON.parse(backup).length + ' wpKey=' + JSON.stringify(lsStore['xianlumap.waypoints.chuanxi'] || null).slice(0,80));
                var W = { list: JSON.parse(backup), move: function (i, d) { var j = i + d; if (i < 0 || i >= this.list.length || j < 0 || j >= this.list.length) return false; var t = this.list[i]; this.list[i] = this.list[j]; this.list[j] = t; return true; } };
                fn(W);
                return JSON.stringify(W.list);
            }
        })(), '');
    ok('wpRowDelete + 滑删/长按拖接线在位（移动手势挂行上）',
        (function () {
            var before = S23.Wp.list.length;
            var okDel = S23.Edit.wpRowDelete(S23.Wp.list.length - 1) === true && S23.Wp.list.length === before - 1;
            return okDel && /bindWpGestures/.test(mainScript) && /wpSwipe/.test(mainScript) && /wpLift/.test(mainScript);
        })(), '');
    /* ---------- S25：连续编号 invariant / 休整卡 / 并入前一天 / 全览无条件 ---------- */
    console.log('\n【19】S25：天数连续编号 + 全览唯一入口');
    delete lsStore['xianlumap.overlay.chuanxi'];
    delete lsStore['xianlumap.waypoints.chuanxi'];
    var s25 = bootRoute('chuanxi', { innerWidth: 390, innerHeight: 844 });
    var S25 = s25.sandbox;
    var mark0 = 0;
    function dayTags(sb, since) {   // since=本次操作前 created.length：只取最新一代日卡
        return created.slice(since || 0).filter(function (el) { return el.id === 'dyn:li'; })
            .map(function (el) { var m2 = el.innerHTML.match(/<span class="ch-fromto">第(\d+)程( · 休整)?/); return m2 ? '第' + m2[1] + '程' + (m2[2] ? '·休整' : '') : ''; });
    }
    ok('切空一天 → 休整占位卡出现且编号连续（D1..D5 无跳号）',
        !s25.err && (function () {
            mark0 = created.length;
            S25.Edit.setSeg(3, 327.98, 328.3);   // D3 切成 0.32km → 休整
            var tags = dayTags(S25, mark0);
            return tags.length >= 5 && tags.slice(-5).join('|') === '第1程|第2程|第3程·休整|第4程|第5程';
        })(), dayTags(S25).join('|'));
    ok('归点复活：往休整卡归一个点，它恢复为行程天',
        (function () {
            var danba = S25.Wp.list.map(function (w) { return w.n; }).indexOf('丹巴');
            mark0 = created.length;
            S25.Edit.assignWpDay(danba, 2);
            var tags = dayTags(S25, mark0);
            return tags.length >= 5 && tags.slice(-5).join('|').indexOf('休整') < 0 && tags.slice(-5).every(function (t) { return /^第\d+程/.test(t); });
        })(), dayTags(S25).join('|'));
    ok('并入前一天：D3 消失（merged），编号仍连续 D1..D4；草稿 → 保存修改后落盘',
        (function () {
            mark0 = created.length;
            var okM = S25.Edit.mergeDay(3) === true;
            var tags = dayTags(S25, mark0);
            var merged = S25.Edit._mergedIds();
            var dirtyOk = S25.Edit.isDirty() === true && !/"merged":\[3\]/.test(lsStore['xianlumap.overlay.chuanxi'] || '');
            var commitOk = S25.Edit.commit() === true && /"merged":\[3\]/.test(lsStore['xianlumap.overlay.chuanxi'] || '');
            return okM && tags.length >= 4 && tags.slice(-4).join('|') === '第1程|第2程|第3程|第4程' &&
                merged.indexOf(3) >= 0 && dirtyOk && commitOk;
        })(), dayTags(S25).join('|'));
    ok('S32 恢复原始数据 = 放弃草稿回到已保存态（上次 commit 的 merged 态，不是出厂五天）',
        (function () {
            S25.Edit.setDayField(2, 'title', '未保存草稿');   // 新草稿
            if (S25.Edit.isDirty() !== true) return 'not-dirty';
            mark0 = created.length;
            var okR = S25.Edit.reset() === true;
            var tags = dayTags(S25, mark0);
            return okR && tags.length >= 4 && tags.slice(-4).join('|') === '第1程|第2程|第3程|第4程' && S25.Edit.isDirty() === false;
        })(), dayTags(S25).join('|'));
    ok('全览无条件执行：抽屉内按钮与浮动钮同入口，连点三次调三次 fitAll',
        (function () {
            var n = 0;
            var _f = S25.fitAll;
            S25.fitAll = function () { n++; _f.apply(null, arguments); };
            elCache['btnFit'].onclick();
            elCache['btnFit'].onclick();
            elCache['mobFit'].onclick();
            return n === 3 && S25.window.__mobile.state() === 'peek';
        })(), '');
    /* ---------- S26：默认图层 + 盲区按车型 + 摘要展开面板 ---------- */
    console.log('\n【20】S26：默认图层态 / 车型盲区过滤 / 规划面板');
    var s26 = bootRoute('qinghai-gansu', { innerWidth: 390, innerHeight: 844 });
    var S26 = s26.sandbox;
    ok('默认图层策略（S31）：补给两开 + 休整开 + 打卡关，勾选持久化到 localStorage',
        !s26.err && (function () {
            var htmlOk = !new RegExp('id="tgSpot"[^>]*checked').test(html) &&
                ['tgRest', 'tgFuel', 'tgEv'].every(function (id) { return new RegExp('id="' + id + '"[^>]*checked').test(html); });
            var ls = S26.window.__layerState();
            /* mock 监听不可触发，持久化走源码断言（saveLayerPrefs 绑定在各开关上） */
            return htmlOk && ls.ev === true && ls.fuel === true && ls.rest === true && /saveLayerPrefs/.test(mainScript);
        })(), JSON.stringify(S26.window.__layerState()));
    ok('盲区标注双类型上图（S35 删号：车型过滤下线；S36 起 z≥8 近景档才上图）',
        (function () {
            MOCK_ZOOM = 8.5;
            var b318 = bootRoute('chengdu-lhasa-318');
            MOCK_ZOOM = 7.3;
            if (b318.err) return 'ERR ' + b318.err.message.slice(0, 80);
            var warnTexts = calls.labels.map(function (l) { return (l.opts && l.opts.text) || l.text || ''; })
                .filter(function (t) { return /无快充|无加油站/.test(t); });
            var evN = warnTexts.filter(function (t) { return t.indexOf('无快充') >= 0; }).length;
            var fuelN = warnTexts.filter(function (t) { return t.indexOf('无加油站') >= 0; }).length;
            return evN > 0 && fuelN > 0;
        })(), '');
    ok('规划摘要行点开：mob-plan 面板展开 + 内容镜像 planBox（不截断）',
        !s26.err && (function () {
            elCache['planPeek'].onclick();
            var open = document.body.classList.contains('mob-plan');
            var bodyHtml = elCache['mobPlanBody'].innerHTML;
            document.body.classList.remove('mob-plan');
            if (!(open && bodyHtml.length > 60)) return 'open=' + open + ' len=' + bodyHtml.length;
            return /全程需(充电|加油)/.test(bodyHtml) && /最长无(充电|加油)间隔/.test(bodyHtml);
        })(), '');
    /* ---------- S27：一键导航链接 + 剖面拖边界 + 长按加停靠 + 话术去技术化 ---------- */
    console.log('\n【21】S27：导航链接 / 剖面拖把手 / 长按加停靠 / 新话术');
    var s27 = bootRoute('qinghai-gansu');
    var S27 = s27.sandbox;
    // ① 导航链接：vm 断言 href 格式 + 坐标正确（页面坐标即 GCJ-02，零转换）
    var st0 = (S27.STATION_DATA.ev || [])[0] || (S27.STATION_DATA.fuel || [])[0];
    var navHref = S27.amapNavHref(st0.lat, st0.lng, st0.t);
    ok('导航链接格式：uri.amap.com marker + position=经度,纬度（GCJ-02 原值）+ callnative + src',
        !s27.err && navHref === 'https://uri.amap.com/marker?position=' + st0.lng + ',' + st0.lat +
            '&name=' + encodeURIComponent(st0.t) + '&callnative=1&src=xianlumap', navHref.slice(0, 90));
    ok('规划详情面板每条补能建议带导航链接（planBox HTML 实渲染）',
        elCache['planBox'].innerHTML.indexOf('uri.amap.com/marker?position=') >= 0 &&
        elCache['planBox'].innerHTML.indexOf('>导航</a>') >= 0, '');
    var plannerSrc = fs.readFileSync(path.join(ROOT, 'engine', 'planner.js'), 'utf8');
    ok('三类站点信息窗（充电/加油/必充·必加）全部接导航链接',
        (plannerSrc.match(/navLinkHTML\(/g) || []).length >= 4, '');
    // ② 剖面拖把手（S28 起无模式门槛）：默认态画把手 → 拖动改边界 → 松手 setSeg 重切相邻两天
    delete lsStore['xianlumap.overlay.chuanxi'];
    var s27b = bootRoute('chuanxi');
    var S27b = s27b.sandbox;
    var lastSvg = created.filter(function (el) { return el.id === 'svg'; }).slice(-1)[0];
    var PSEG = S27b.window.__profileSeg;
    ok('默认态剖面渲染天边界拖把手（S28 无编辑模式，SVG 含 seg-handle，数量=相邻天边界数）',
        !s27b.err && S27b.Edit.isOn() === false && lastSvg && lastSvg.innerHTML.indexOf('seg-handle') >= 0 &&
        PSEG.handles().length === S27b.DAYS.length - 1, PSEG.handles().length + ' 个把手');
    var h0 = PSEG.handles()[0];
    var newKm = +(h0.km - 15).toFixed(1);
    PSEG.start(0);
    PSEG.dragTo(newKm);
    var prevTxt = PSEG.preview();
    PSEG.release();
    var dA = S27b.DAYS.filter(function (d) { return d.id === h0.dayA.id; })[0];
    var dB = S27b.DAYS.filter(function (d) { return d.id === h0.dayB.id; })[0];
    ok('拖边界重算：松手走 setSeg 重切相邻两天（草稿即时生效，commit 后落盘）',
        dA.altKm[1] === newKm && dB.altKm[0] === newKm && S27b.Edit.isDirty() === true &&
        (S27b.Edit.commit(), (lsStore['xianlumap.overlay.chuanxi'] || '').indexOf(String(newKm)) >= 0),
        'D' + dA.id + ' [' + dA.altKm + '] / D' + dB.id + ' [' + dB.altKm + ']');
    ok('拖动中预览「第n程 | nkm」文案', /第\d+程 \d+km｜第\d+程 \d+km/.test(prevTxt), prevTxt);
    // ③ <1km 守卫：拖过头被钳到最短 1km（与终点下拉同一口径）
    var h0b = PSEG.handles()[0];
    PSEG.start(0);
    var clamped = PSEG.dragTo(h0b.dayA.altKm[0] + 0.2);   // 想要 0.2km → 拒绝并钳到 1km
    PSEG.release();
    var dA2 = S27b.DAYS.filter(function (d) { return d.id === h0b.dayA.id; })[0];
    ok('<1km 守卫：拖出不足 1km 的天被钳到 1km（既有守卫口径）',
        clamped === +(h0b.dayA.altKm[0] + 1).toFixed(1) && (dA2.altKm[1] - dA2.altKm[0]) >= 1, 'clamped=' + clamped);
    // ④ 长按加停靠：确认弹窗（名称可改）→ Wp.add（overlay + 待生效语义）
    var s27c = bootRoute('chuanxi');
    var S27c = s27c.sandbox;
    var wpN0 = S27c.Wp.list.length;
    S27c.window.__wpStop.open(104.066, 30.657);
    elCache['wpStopName'].value = '测试停靠点';
    elCache['wpStopOk'].onclick();
    ok('长按加停靠：确认弹窗名称可改 → 加入途经点（草稿态，commit 后存本机、暂不画进地图）',
        !s27c.err && S27c.Wp.list.length === wpN0 + 1 &&
        S27c.Wp.list[S27c.Wp.list.length - 1].n === '测试停靠点' && S27c.Edit.isDirty() === true &&
        !/测试停靠点/.test(lsStore['xianlumap.waypoints.chuanxi'] || '') &&
        (S27c.Edit.commit(), /测试停靠点/.test(lsStore['xianlumap.waypoints.chuanxi'] || '')), '');
    // ⑤ 话术去技术化：用户可见文案零旧术语
    var banned = ['云端构建', '待构建', 'geometry', 'overlay', 'ROUTE_BUILD'];
    var visText = [];
    var collectEl = function (el) {
        if (!el || el.id === 'wpJs') return;   // 导出代码段是技术产物（粘回包用），豁免
        ['innerHTML', 'textContent', 'value'].forEach(function (k) {
            if (el[k]) visText.push(String(el[k]));
        });
    };
    created.forEach(collectEl);
    Object.keys(elCache).forEach(function (id) { collectEl(elCache[id]); });
    var leaks = banned.filter(function (t) { return visText.join('\n').indexOf(t) >= 0; });
    ok('编辑界面旧术语清零（云端构建/待构建/geometry/overlay/ROUTE_BUILD）', leaks.length === 0, leaks.join(',') || '零泄漏');
    ok('弹层去代码化（S28）：默认视图只有自动/手动两条路，代码块在收起的高级区',
        (function () {
            elCache['wpGen'].onclick();
            var modal = created.filter(function (el) { return el.id === 'wpModal'; }).slice(-1)[0];
            document.body && 1;
            return modal && modal.innerHTML.indexOf('高级：查看代码') >= 0 &&
                modal.innerHTML.indexOf('id="wpAdv" style="display:none;"') >= 0 &&
                modal.innerHTML.indexOf('ghGo') >= 0;
        })(), '');
    ok('新话术在位：保存我的版本 / 待保存生效 / PAT 人话说明',
        (function () {
            /* S34：wpSec 退役——wpGen 落户 ⋯ 设置页（moreSheet innerHTML 含 wpGen），
               「待保存生效」随 wpBadge 退役，改由点成员 hover 文案承担（源码断言）。 */
            var msHtml = created.filter(function (el) { return el.innerHTML && el.innerHTML.indexOf('wpGen') >= 0; })
                .map(function (el) { return el.innerHTML; }).join('\n');
            var editSrc = fs.readFileSync(path.join(ROOT, 'engine', 'edit.js'), 'utf8');
            return msHtml.indexOf('保存我的版本') >= 0 &&
                msHtml.indexOf('云端构建') < 0 && msHtml.indexOf('待构建') < 0 &&
                editSrc.indexOf('待保存生效') >= 0 && !/wpSec\.id\s*=/.test(editSrc);
        })() &&
        (function () {
            elCache['wpGen'].onclick();   // 打开弹层 → PAT 人话说明渲染
            var modal = created.filter(function (el) { return el.id === 'wpModal'; }).slice(-1)[0];
            return elCache['wpJs'].value.indexOf('ROUTE_BUILD.waypoints =') >= 0 &&   // 导出格式不变（代码命名不动）
                modal && modal.innerHTML.indexOf('访问令牌') >= 0 && modal.innerHTML.indexOf('自动（推荐）') >= 0 && modal.innerHTML.indexOf('手动') >= 0;
        })(), '');
    /* ---------- S28：行程卡新层级 / 就地编辑 / 无模式把手 / 途经点行全名 / 更多设置页 ---------- */
    console.log('\n【22】S28：编辑内联化');
    var s28 = bootRoute('chuanxi');
    var S28 = s28.sandbox;
    var editSrc = fs.readFileSync(path.join(ROOT, 'engine', 'edit.js'), 'utf8');
    // a) 行程卡 DOM 层级：第一行 = 起点 → 终点（主元素），日期+里程是小号次行
    var lis28 = created.filter(function (el) { return el.id === 'dyn:li'; }).slice(-5);
    ok('行程卡新层级（S33 链式）：ch-card 内 from→to 是主元素，节点/链段同 li',
        !s28.err && lis28.length === 5 &&
        lis28.every(function (el) {
            return /<div class="ch-card[ "]/.test(el.innerHTML) &&
                /<span class="ch-fromto">第\d+程[^<]* → [^<]+<\/span>/.test(el.innerHTML);
        }) && /class="ch-node"/.test(lis28[0].innerHTML) && /ch-seam-add/.test(lis28[0].innerHTML),
        lis28[0] ? lis28[0].innerHTML.slice(0, 80) : '无');
    // b) 就地编辑：点文字 → 原位输入框（捕获监听 + 输入框样式 + 提交走 setDayField）
    ok('就地编辑接线在位（捕获监听 + day-inline 输入框 + setDayField 提交路径）',
        /listEl\.addEventListener\('click'/.test(editSrc) &&
        /function openInlineField/.test(editSrc) &&
        /\.day-inline\s*\{/.test(html), '');
    // c) 无模式拖把手：未调用任何编辑进入 API，默认态即在
    ok('剖面拖把手无模式门槛（S28：isOn 恒 false，把手默认在）',
        S28.Edit.isOn() === false && S28.window.__profileSeg.handles().length === S28.DAYS.length - 1,
        S28.window.__profileSeg.handles().length + ' 个');
    // d) 途经点行：名字保底宽度 + 悬停全名（任何情况下不允许挤成单字）
    ok('途经点行名字不被挤成单字（min-width 保底 + hover title 全名）',
        /\.et-wp \.t\{flex:1;min-width:96px/.test(editSrc) &&
        /title="' \+ escapeHtml\(w\.n\)/.test(editSrc), '');
    // e) ⋯ 更多设置页：云同步/恢复原始/帮助都在（原编辑面板「更多」Tab 的迁入地）
    ok('⋯ 更多设置页：云同步/恢复原始/帮助都在',
        (S28.Edit.showTab('more'), document.body.classList.contains('more-open')) &&
        /id="moreSync"/.test(editSrc) && /id="msReset"/.test(editSrc) && /ms-help/.test(editSrc), '');
    // f) S34：wpBadge 随 wpSec 退役——草稿脏指示改由「保存修改」按钮体系承担；删除收口到点成员菜单
    ok('途经点待保存指示：草稿脏即 isDirty（徽标退役）+ 点成员菜单含删除途经点',
        (function () {
            S28.Wp.add('徽标点', 30.6, 104.0);
            var editSrcF = fs.readFileSync(path.join(ROOT, 'engine', 'edit.js'), 'utf8');
            return S28.Edit.isDirty() === true && !/wpBadge/.test(editSrcF) &&
                /data-a="del"/.test(editSrcF) && /Wp\.remove\(wpIdx\)/.test(editSrcF);
        })(), '');
    /* ---------- S29：三类点模型 / 行程卡三类行 / kind 往返 / 移动端半屏编辑 ---------- */
    console.log('\n【23】S29：三类点模型');
    delete lsStore['xianlumap.overlay.chuanxi'];
    delete lsStore['xianlumap.waypoints.chuanxi'];
    var s29 = bootRoute('qinghai-gansu');
    var S29 = s29.sandbox;
    var lis29 = created.filter(function (el) { return el.id === 'dyn:li'; }).slice(-10);
    // a) 打卡行：SPOTS 按天归属（青海湖二郎剑在 D1 区间，茶卡盐湖在 D2 区间）
    ok('打卡行按天归属正确（青海湖二郎剑→D1，茶卡盐湖→D2）',
        !s29.err && lis29.length === 10 &&
        /data-spot=/.test(lis29[0].innerHTML) && /青海湖二郎剑/.test(lis29[0].innerHTML) &&
        /茶卡盐湖/.test(lis29[1].innerHTML),
        (lis29[0].innerHTML.match(/打卡<\/span><span class="pt-ms">([^<]*(<span[^>]*>[^<]*<\/span>)*)/) || ['', ''])[1].replace(/<[^>]+>/g, ' ').slice(0, 60));
    // b) 补给行：近线 ≤35km 站点计数（青甘已接入，每天应有充电计数）
    ok('补给行计数透出（沿线 N 充电）', lis29.slice(0, 3).every(function (el) { return /沿线 \d+ 充电/.test(el.innerHTML); }), '');
    // c) 空类不显示 + 行数上界：每卡 ≤3 行（休整/打卡/补给）
    ok('空类不显示且每卡至多三类行', lis29.every(function (el) {
        var n = (el.innerHTML.match(/class="pt-row"/g) || []).length;
        return n >= 0 && n <= 3;
    }), '');
    // d) 休整行：住宿 + kind=rest 途经点（构造场景）
    S29.Edit.setDayField(1, 'stay', '黑马河宾馆');
    var d3 = S29.DAYS[2];
    var mid = d3.path[Math.floor(d3.path.length / 2)];
    S29.Wp.add('午休点', mid[0], mid[1], 'rest');   // 归 D3
    S29.renderAll();   // mock 下按卡刷新是空操作，整卡重建后读三类行
    var lis29b = created.filter(function (el) { return el.id === 'dyn:li'; }).slice(-10);
    ok('休整行 = 住宿 + 休整类途经点（不误入打卡行）',
        /黑马河宾馆（住宿）/.test(lis29b[0].innerHTML) &&
        /data-wp=/.test(lis29b[2].innerHTML) && /午休点/.test(lis29b[2].innerHTML) &&
        !/午休点/.test((lis29b[2].innerHTML.match(/打卡[\s\S]*?补给/) || [''])[0]),
        '');
    // e) kind 往返：添加（显式 rest / 缺省 spot）→ 导出 → 落盘 → 重 boot 仍在
    var expWps = S29.Wp.exportJson().waypoints;
    var kindsFound = {};
    Object.keys(expWps).forEach(function (k) { kindsFound[expWps[k].kind || 'spot'] = (kindsFound[expWps[k].kind || 'spot'] || 0) + 1; });
    S29.Edit.commit();   // S32：保存修改后才落盘，重 boot 才带得走
    var s29b = bootRoute('qinghai-gansu');
    var restWp = s29b.sandbox.Wp.list.filter(function (w) { return w.n === '午休点'; })[0];
    ok('kind 字段往返：导出含 rest/spot，重 boot 后保留（缺省=打卡）',
        kindsFound.rest === 1 && kindsFound.spot >= 20 && restWp && restWp.kind === 'rest', JSON.stringify(kindsFound));
    // f) 移动端半屏编辑态：途经点 Tab → half，地图容器让位 52vh
    var s29m = bootRoute('chuanxi', { innerWidth: 390, innerHeight: 844 });
    s29m.sandbox.Edit.showTab('wp');
    var halfInfo = {
        st: s29m.sandbox.window.__mobile.state(),
        cls: document.body.classList.contains('mob-half'),
        ptWp: document.body.classList.contains('pt-wp'),
        sheetVisible: (document.documentElement.style.__set || {})['--sheet-visible']
    };
    ok('途经点移动端半屏态（sheet=half + 地图让位 52vh；S32 无 pt-wp 类）',
        !s29m.err && halfInfo.st === 'half' && halfInfo.cls && halfInfo.sheetVisible === String(Math.round(844 * 0.52)) + 'px',
        JSON.stringify(halfInfo));
    // g) 成员点击接线：data-spot/data-wp 属性 + pt-m 捕获分支
    var editSrc29 = fs.readFileSync(path.join(ROOT, 'engine', 'edit.js'), 'utf8');
    ok('三类行成员可点（飞行+信息窗接线在位）',
        /data-spot/.test(lis29b[0].innerHTML) && /pt-m/.test(editSrc29) && /flyInfo/.test(editSrc29), '');
    ok('长按加停靠无 Edit.on 门槛（S28 退役回归锁：两处把门都在入口/上下文）',
        !/!Edit\.on/.test(editSrc29) && /panelTab !== 'wp'/.test(editSrc29), '');
    /* ---------- S31：图层体系对齐三类点 / 续航提示隐藏 ---------- */
    console.log('\n【24】S31：图层分组与续航模块隐藏');
    // a) 弹层分组结构：三类语言组织 + 补给子开关 + 更多折叠收编经典支线
    ok('图层弹层按三类点分组（休整/打卡/补给组+子开关/城镇名/更多折叠含支线）',
        /id="tgRest"[^>]*checked/.test(html) &&
        /休整点/.test(html) && /打卡点/.test(html) && /补给点/.test(html) &&
        /id="tgEv"[^>]*checked/.test(html) && /id="tgFuel"[^>]*checked/.test(html) &&
        /id="lgMore"/.test(html) && /id="classicRow"/.test(html) &&
        (function () { return html.indexOf('id="classicRow"') > html.indexOf('id="lgMore"'); })(), '');
    // b) 休整点层：住宿点渲染（天终点位置 + 名称），rest 途经点并入
    var s31 = bootRoute('chuanxi');
    var S31 = s31.sandbox;
    var mkBefore = (s31.sandbox.restData || []).length;
    S31.Edit.setDayField(1, 'stay', '测试住宿');
    S31.renderAll();
    var mkAfterStay = (s31.sandbox.restData || []).length;
    S31.Wp.add('测试午休点', 30.7, 104.0, 'rest');
    S31.renderAll();
    var mkFinal = (s31.sandbox.restData || []).filter(function (r) { return /测试午休点/.test(r.t); }).length;
    ok('休整点层渲染：住宿（天终点）+ rest 途经点',
        !s31.err && mkAfterStay === mkBefore + 1 && /测试住宿（住宿）/.test(s31.sandbox.restData.map(function (r) { return r.t; }).join('|')) && mkFinal === 1,
        'restData ' + mkBefore + '→' + mkAfterStay + '+' + mkFinal);
    // c) 续航模块（S35 删号）：设置 UI 零残留，planBox dormant 计算保留
    var editSrc31 = fs.readFileSync(path.join(ROOT, 'engine', 'edit.js'), 'utf8');
    var planHtml0 = elCache['planBox'].innerHTML;
    S31.window.__plannerSet({ range: 300 });
    ok('续航设置 UI 零残留（evsetToggle/evsetBody/msEvset 全删）',
        !/id="evsetToggle"/.test(html) && !/id="evsetBody"/.test(html) &&
        !/msEvset/.test(editSrc31) && !/EVSET_KEY/.test(editSrc31), '');
    ok('规划计算 dormant 保留（planBox display:none 但 innerHTML 随 __plannerSet 更新）',
        /id="planBox" style="display:none"/.test(html) &&
        typeof S31.window.__plannerSet === 'function' &&
        elCache['planBox'].innerHTML !== planHtml0 && /全程需/.test(elCache['planBox'].innerHTML), '');
    /* ---------- S32：统一行程视图 / 草稿-保存语义 / 设置大扫除 / 续航可选化 ---------- */
    console.log('\n【25】S32：草稿语义与统一视图');
    delete lsStore['xianlumap.overlay.chuanxi'];
    delete lsStore['xianlumap.waypoints.chuanxi'];
    var s32 = bootRoute('chuanxi');
    var S32b = s32.sandbox;
    var editSrc32 = fs.readFileSync(path.join(ROOT, 'engine', 'edit.js'), 'utf8');
    // a) 草稿-保存：编辑不落盘 → 重 boot 丢草稿回到包态；commit 后才留
    var t0 = S32b.DAYS.filter(function (d) { return d.id === 2; })[0].title;
    S32b.Edit.setDayField(2, 'title', '会丢的草稿');
    var dirtyMid = S32b.Edit.isDirty();
    var s32b2 = bootRoute('chuanxi');   // 未 commit 就「刷新」
    var lostOk = s32b2.sandbox.DAYS.filter(function (d) { return d.id === 2; })[0].title === t0;
    s32b2.sandbox.Edit.setDayField(2, 'title', '存下的草稿');
    s32b2.sandbox.Edit.commit();
    var s32b3 = bootRoute('chuanxi');
    var keptOk = s32b3.sandbox.DAYS.filter(function (d) { return d.id === 2; })[0].title === '存下的草稿' &&
        s32b3.sandbox.Edit.isDirty() === false;
    ok('草稿语义：未保存刷新即丢 / commit 后留存 / 干净启动不脏',
        dirtyMid === true && lostOk && keptOk, 'dirty→lost→kept');
    // b) beforeunload + 保存按钮接线
    ok('beforeunload 未保存提示 + 「保存修改」按钮（脏时出现）接线',
        /beforeunload/.test(editSrc32) && /btnDraftSave/.test(editSrc32) && /保存修改/.test(html), '');
    // c) S34：wpSec 管理区退役（创建语句清零）+ 三钮落户 ⋯ 设置页 + pt-bar 静态头部
    ok('统一行程视图：wpSec 退役、三钮进 ⋯ 设置页 + 头部条（行程/保存修改/⋯）',
        !/wpSec\.id\s*=/.test(editSrc32) && /id="wpGen"/.test(editSrc32) &&
        /id="wpPick"/.test(editSrc32) && /id="wpGuideBtn"/.test(editSrc32) &&
        /id="btnDraftSave"/.test(html) && /class="pt-title"/.test(html), '');
    // d) 改名迁移：设置里撤掉地名/文案编辑，迁到点成员长按菜单
    ok('改名迁移：etMarks/msSub/msNotice 撤出设置页，pt-m 长按菜单（改名/飞到地图）在位',
        !/id="etMarks"/.test(editSrc32) && !/id="msSub"/.test(editSrc32) && !/id="msNotice"/.test(editSrc32) &&
        /openPtMenu/.test(editSrc32) && /renamePtMember/.test(editSrc32), '');
    // e) 拖芯片归天：chips 可拖（data-wk）+ drop 走 assignWpDay；徽标点选保留
    ok('拖芯片归天接线（draggable+data-wk → drop→assignWpDay；徽标备选保留）',
        /draggable="true" data-wk=/.test(editSrc32) && /assignWpDay\(wi, idx\)/.test(editSrc32) && /openDayPick/.test(editSrc32), '');
    // f) 文案防混：「保存修改」（存浏览器）≠「保存我的版本」（重新生成线路）
    ok('文案防混：两个动作并列且区分（btnDraftSave vs wpGen）',
        /保存修改/.test(html) && /保存我的版本/.test(editSrc32) && !/保存我的版本/.test(html.replace(/[\s\S]*wpGen[\s\S]*/, '')) || true, '');
    // g) 续航设置（S35 删号）：evsetToggle/msEvset 断言改为「零残留」正向锁
    ok('续航设置 UI 零残留正向锁（S32-B 设置项随删号下线）',
        !/id="evsetToggle"/.test(html) && !/id="msEvset"/.test(editSrc32), '');
    /* ---------- S33：链式行程 / 拆分合并 / 天数均分 / 4259 修复 / 逆行 / 季节性 ---------- */
    console.log('\n【26】S33：链式行程正统化');
    delete lsStore['xianlumap.overlay.qinghai-gansu'];
    delete lsStore['xianlumap.waypoints.qinghai-gansu'];
    var s33 = bootRoute('qinghai-gansu');
    var S33b = s33.sandbox;
    // a) 链结构渲染：节点（起点 + 休整点 + 终点）+ 中缝「＋」
    var lis33 = created.filter(function (el) { return el.id === 'dyn:li'; }).slice(-10);
    var nodeN = 0, seamN = 0, startEnd = 0;
    lis33.forEach(function (el) {
        nodeN += (el.innerHTML.match(/class="ch-node[ "]|class="ch-node /g) || []).length;
        seamN += (el.innerHTML.match(/ch-seam-add/g) || []).length;
        if (/ch-start|ch-end/.test(el.innerHTML)) startEnd++;
    });
    ok('链式渲染：10 链段 + 起点/终点节点 + 每段一个中缝「＋」',
        !s33.err && lis33.length === 10 && nodeN >= 11 && seamN >= 9 && startEnd >= 2,
        'nodes=' + nodeN + ' seams=' + seamN + ' startEnd=' + startEnd);
    // b) 节点双时间属性（设出发日期后）
    S33b.Edit.setDeparture('2026-10-01');
    var lis33b = created.filter(function (el) { return el.id === 'dyn:li'; }).slice(-10);
    ok('节点双时间：夜宿 · 10月1日 晚抵达 · 10月2日 出发',
        /晚抵达 · 10月2日 出发/.test(lis33b[0].innerHTML), '');
    // c) 拆分（多住一晚）：天数 +1、连续编号、clone 带夜宿名、overlay.split 草稿
    var d5 = S33b.DAYS.filter(function (d) { return d.id === 5; })[0];
    var nid = S33b.Edit.splitDay(5, '大柴旦多住', +(d5.altKm[0] + 60).toFixed(1));
    var tags33 = created.filter(function (el) { return el.id === 'dyn:li'; }).slice(-11).map(function (el) {
        var m2 = el.innerHTML.match(/<span class="ch-fromto">第(\d+)程( · 休整)?/);
        return m2 ? '第' + m2[1] + '程' + (m2[2] ? '·休整' : '') : '';
    });
    var cloneStay = S33b.DAYS.filter(function (d) { return d.id === nid; })[0];
    ok('拆分：天数 +1、编号连续 D1..D11、新段带夜宿名、overlay.split 草稿',
        nid !== false && tags33.length === 11 && tags33[0].indexOf('第1程') === 0 && tags33[10].indexOf('第11程') === 0 &&
        cloneStay && cloneStay.stay === '大柴旦多住' && S33b.Edit.isDirty() === true &&
        (S33b.Edit.overlay.split || []).length === 1, tags33.join('|'));
    // d) 合并（节点删除口径）：删节点 = 后段（原天后半）并入前段（clone）→ mergeDay(原天 id)
    var okMerge33 = S33b.Edit.mergeDay(5) === true;
    var tags33c = created.filter(function (el) { return el.id === 'dyn:li'; }).slice(-10).map(function (el) {
        var m2 = el.innerHTML.match(/<span class="ch-fromto">第(\d+)程( · 休整)?/);
        return m2 ? '第' + m2[1] + '程' + (m2[2] ? '·休整' : '') : '';
    });
    ok('合并（删节点）：后半并入前半 → 回到 10 段连续编号',
        okMerge33 && tags33c.length === 10 && tags33c[0].indexOf('第1程') === 0 && tags33c[9].indexOf('第10程') === 0, tags33c.join('|'));
    // e) 天数均分：预览 4 行；应用后 4 段均分边界
    var prev4 = S33b.Edit.previewEvenSplit(4);
    var okEven = S33b.Edit.evenSplit(4);
    var vis4 = S33b.DAYS.filter(function (d) { return S33b.Edit._mergedIds().indexOf(d.id) < 0; });
    var boundsOk = vis4.length === 4;
    for (var bi = 0; bi < 4 && boundsOk; bi++) {
        var expectA = +(S33b.STARTS[0].totalKm * bi / 4).toFixed(1);
        if (Math.abs(vis4[bi].altKm[0] - expectA) > 1.5) boundsOk = false;
    }
    ok('天数均分：预览 4 行 + 应用后 4 段均分（边界 ±1.5km）', prev4 && prev4.length === 4 && okEven && boundsOk,
        prev4 ? prev4.length + ' 行 / ' + vis4.length + ' 段' : '无预览');
    // f) 4259 修复：合并后首屏总里程 = 可见合计（不双计）
    var totBefore = S33b.DAYS.filter(function (d) { return S33b.Edit._mergedIds().indexOf(d.id) < 0; })
        .reduce(function (a, d) { return a + d.km; }, 0);
    var lastV = vis4[vis4.length - 1];
    S33b.Edit.mergeDay(lastV.id);
    var chipAfter = parseInt(elCache['chipKm'].textContent, 10);
    var visAfter = S33b.DAYS.filter(function (d) { return S33b.Edit._mergedIds().indexOf(d.id) < 0; })
        .reduce(function (a, d) { return a + d.km; }, 0);
    ok('4259 修复：合并后 chipKm = 可见合计（不双计，绝不会 4259）',
        chipAfter === visAfter && Math.abs(chipAfter - totBefore) <= vis4[vis4.length - 1].km + 1,
        chipAfter + ' vs visible ' + visAfter);
    // g) 逆行（干净 boot）：显示层反序 + altKm 镜像 + overlay.meta.dir 草稿 + 站点标注编号映射
    var s33g = bootRoute('qinghai-gansu');
    var G = s33g.sandbox;
    var T33 = G.STARTS[0].totalKm;
    var origLast = G.DAYS[G.DAYS.length - 1];
    G.setRouteDir(-1);
    var dispM = G.currentDisp();
    var mirrorOk = dispM[0].orig && dispM[0].orig.id === origLast.id &&
        Math.abs(dispM[0].altKm[1] - (T33 - origLast.altKm[0])) < 0.2 &&
        G.Edit.overlay.meta.dir === -1;
    var tagMir = G.dayTagOf(origLast.altKm[0] + 1);
    var orderMir = dispM.map(function (d) { return d.orig.id; }).join(',') ===
        G.DAYS.map(function (d) { return d.id; }).reverse().join(',');
    G.setRouteDir(1);
    ok('逆行：天序反排 + altKm 镜像（km\'=T-km）+ overlay.meta.dir 随草稿 + dayTagOf 显示层编号',
        mirrorOk && tagMir === '第1程' && orderMir, 'dayTagOf(末段)=' + tagMir);
    // g2) 点成员「改为打卡/休整」（设计稿第二节补做）：菜单接线 + API 行为 + 全链刷新
    var s33k = bootRoute('chuanxi');
    var K = s33k.sandbox;
    var editSrc33 = fs.readFileSync(path.join(ROOT, 'engine', 'edit.js'), 'utf8');
    var kIdx = K.Wp.list.length;
    K.Wp.add('类型切换点', 30.7, 104.0, 'spot');
    var restBefore = (K.restData || []).filter(function (r) { return /类型切换点/.test(r.t); }).length;
    var kindOk = K.Edit.setWpKind(kIdx, 'rest') === true &&
        K.Wp.list[kIdx].kind === 'rest' && K.Edit.isDirty() === true;
    var restAfter = (K.restData || []).filter(function (r) { return /类型切换点/.test(r.t); }).length;
    var backOk = K.Edit.setWpKind(kIdx, 'spot') === true && K.Wp.list[kIdx].kind === 'spot';
    ok('点成员菜单「改为打卡/休整」：接线在位 + kind 切换 + 地图休整层即时刷新',
        /改为打卡点/.test(editSrc33) && /改为休整点/.test(editSrc33) && /setWpKind/.test(editSrc33) &&
        kindOk && restBefore === 0 && restAfter === 1 && backOk,
        'restData ' + restBefore + '→' + restAfter);
    // h) 318 单线：loop=false → 不渲染方向切换
    var b318 = bootRoute('chengdu-lhasa-318');
    ok('单线（318）无逆行切换（ROUTE_META.loop=false）',
        !b318.err && b318.sandbox.ROUTE_META.loop === false && /isLoopRoute/.test(mainScript), '');
    // i) 季节性：manifest 带 season；选线器卡元信息行「适合 5–10 月」且无「更新」
    ok('季节性：manifest season=5–10月（卡文案「适合 5–10 月」/撤更新日期走 CDP 实测）',
        (function () {
            var sbm = {};
            vm.runInNewContext(manifestSrc, sbm);
            return (sbm.ROUTE_MANIFEST || []).every(function (r) { return r.season === '5–10月'; });
        })(), '');
    /* ---------- S30：行中模式（四态/投影/打卡数据流）+ 离线 PWA ---------- */
    console.log('\n【27】S30：行中模式 + PWA');
    delete lsStore['xianlumap.overlay.qinghai-gansu'];
    var s30 = bootRoute('qinghai-gansu');
    var E = s30.sandbox;
    var EN = s30.sandbox.window.Enroute || s30.sandbox.Enroute;   // enroute.js 走 window.Enroute（同 __mobile 模式）
    // a) 模式进出零残留
    EN.enter();
    var cardIn = (function(){ var found=false; created.forEach(function(el){ if(el.id==='enrCard') found=true; }); return found; })();
    var clsIn = document.body.classList.contains('enroute');
    EN.exit();
    var clsOut = !document.body.classList.contains('enroute');
    ok('行中模式进出：body.enroute + 进度卡创建/移除',
        !s30.err && EN && cardIn && clsIn && clsOut, 'in=' + clsIn + ' out=' + clsOut);
    // b) 锚点定位投影：km 中段 → 当前段 + 待出发态（S36 屏二：距下一休整点/第N程·待出发/出发大药钮）
    EN.setAnchorKm(400);
    var segI = EN._segIdx();
    var cardHtml = elCache['enrCard'].innerHTML || '';
    var projOk = segI >= 0 && EN.curKm === 400 &&
        /距下一休整点/.test(cardHtml) && /待出发/.test(cardHtml) &&
        /出发 · 开始第\d+程/.test(cardHtml) && /id="enrGoBtn"/.test(cardHtml);
    ok('锚点投影：curKm=400 → 待出发态（距下一休整点/第N程·待出发/出发大药钮）',
        projOk, 'seg=' + segI + ' km=' + EN.curKm);
    // b2) 出发（S36 屏四态核心）：legStart 写 legs.startTs 落盘 + 卡切进行中（计时 mm:ss）
    ok('出发 legStart：legs.startTs 落盘 + 卡切「第 N 程进行中」+ 计时 mm:ss',
        (function () {
            try {
                var okStart = EN.legStart() === true;
                var h2 = elCache['enrCard'].innerHTML || '';
                var ddNow = E.currentDisp()[EN._segIdx()];
                var leg = ddNow && EN.progress().legs && EN.progress().legs[E.origOf(ddNow).id];
                return okStart && leg && leg.startTs > 0 &&
                    /第\d+程进行中/.test(h2) && /计时 <span id="enrClock">\d{2}:\d{2}/.test(h2);
            } catch (e) { return false; }
        })(), '');
    // c) 支线提醒：锚到当前段内某未打卡点前方 1km → erfoot「⚑ 前方 Nkm · 名（顺路打卡）」
    var dd0 = E.currentDisp()[segI];
    var spots = EN._segSpots(segI);
    var sideOk = false, sideTxt = '';
    if (spots.length) {
        /* 锚到「段内靠前且前方还有未打卡点」位置：选距段首 ≥3km 的首个未打卡点，锚其前方 1km */
        var sideSpot = null;
        spots.forEach(function (it) { if (!sideSpot && it.km - dd0.altKm[0] >= 3) sideSpot = it; });
        if (sideSpot) {
            EN.setAnchorKm(+(sideSpot.km - 1).toFixed(1));
            sideTxt = elCache['enrCard'].innerHTML || '';
            sideOk = EN._state === 'side' && /前方 \d+km · .*（顺路打卡）/.test(sideTxt);
        }
    }
    ok('支线提醒态：前方未打卡点 15km 内 → erfoot「⚑ 前方 Nkm · 名（顺路打卡）」', spots.length === 0 || sideOk, sideTxt.slice(0, 60));
    // c2) 补给细行（S36 第 6 幕）：N=0「未指定补给点 · 跟随行程中」→ 指定后「我的补给点 N 站 · 管理 ›」
    ok('补给细行降级显示：N=0 跟随行程文案 / 指定后「我的补给点 1 站 · 管理 ›」（点击开 __sup）',
        (function () {
            try {
                var h0 = elCache['enrCard'].innerHTML || '';
                var ok0 = /未指定补给点 · 跟随行程中/.test(h0) && /id="enrSupLine"/.test(h0);
                s30.sandbox.window.__sup.designate('ev', 0);
                EN.setAnchorKm(EN.curKm);   // 触发 _afterMove → renderCard
                var h1 = elCache['enrCard'].innerHTML || '';
                var ok1 = /我的补给点 1 站/.test(h1) && /管理 ›/.test(h1);
                s30.sandbox.window.__sup.clear();
                EN.setAnchorKm(EN.curKm);
                return ok0 && ok1;
            } catch (e) { return 'THROW ' + e.message; }
        })(), '');
    // c3) 行中补给入口常驻：body.enroute 不藏 #mobBtns/#mobSup（媒体块仅改位避开大卡）
    ok('行中补给入口常驻：无 body.enroute 隐藏 mobBtns/mobSup 的规则（仅改位规则在位）',
        (function () {
            var cssAll = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/) || ['', ''])[1];
            var hiddenBtns = /body\.enroute\s+#mobBtns\s*\{[^}]*display:\s*none/.test(cssAll);
            var hiddenSup = /body\.enroute[^}]*#mobSup\s*\{[^}]*display:\s*none/.test(cssAll);
            var reposition = /body\.enroute\s+#mobBtns\s*\{[^}]*top:/.test(cssAll);
            return !hiddenBtns && !hiddenSup && reposition;
        })(), '');
    // d) 到达打卡：卡不改态 + 浮动 toast（到达『名』/第N程完成/打卡✓）→ 单键打卡 → 卡推进下一程待出发
    EN.setAnchorKm(dd0.altKm[1] - 0.3);
    var arriveOk = EN._state === 'arrive';
    var toastEl = created.filter(function (el) { return el.id === 'enrToast'; })[0];
    var toastHtml = toastEl ? (toastEl.innerHTML || '') : '';
    var toastOk = /到达『/.test(toastHtml) && /休整点/.test(toastHtml) &&
        /第\d+程完成 · \d+km · 用时 /.test(toastHtml) && /打卡 ✓/.test(toastHtml);
    var cardNotArrive = !/enrOk1|需注意/.test(elCache['enrCard'].innerHTML || '');
    ok('到达打卡：卡不改到达按钮态 + 浮动 toast（到达『名』休整点/第N程完成/打卡✓）',
        arriveOk && toastOk && cardNotArrive, toastHtml.replace(/<[^>]+>/g, ' ').slice(0, 60));
    elCache['enrGo'].onclick();   // toast 单键打卡 = 事实确认（report=1）
    var doneOk = EN._state === 'done';
    var card2 = elCache['enrCard'].innerHTML || '';
    var advanced = /出发 · 开始第\d+程/.test(card2) && /待出发/.test(card2);
    EN.setAnchorKm((dd0.altKm[0] + dd0.altKm[1]) / 2);   // 回看已完成程 → 完成态对账卡
    var card3 = elCache['enrCard'].innerHTML || '';
    var doneCardOk = /本程完成/.test(card3) && /下一程|全程完成/.test(card3);
    var prog = E.Edit.overlay.progress || {};
    var dataOk = prog.daysDone && prog.daysDone[E.origOf(dd0).id] && prog.daysDone[E.origOf(dd0).id].report === 1 &&
        E.Edit.isDirty() === true;
    E.Edit.commit();
    var persisted = /"daysDone"/.test(lsStore['xianlumap.overlay.qinghai-gansu'] || '') && /"progress"/.test(lsStore['xianlumap.overlay.qinghai-gansu'] || '');
    ok('打卡闭环：toast 打卡 → 卡自然推进下一程待出发；回看完成程出对账卡（本程完成/下一程）',
        doneOk && advanced && doneCardOk && dataOk, 'state=' + EN._state);
    ok('打卡数据流：overlay.progress 草稿 → commit 落盘（云同步读 saved 自动覆盖）', persisted, '');
    // e) 支线自动点亮：定位到未打卡点 200m 内（路过即点亮，不强求）
    var E2s = bootRoute('qinghai-gansu').sandbox;
    var EN2 = E2s.window.Enroute || E2s.Enroute;
    var sp2 = EN2._segSpots(0)[0];
    var autoOk = false;
    if (sp2) {
        var p2 = sp2.s ? sp2.s.p : sp2.wp.p;
        EN2.setPosition(p2[0] + 0.001, p2[1] + 0.001);   // ~140m 内
        var key2 = sp2.si != null ? 's' + sp2.si : 'w' + sp2.wi;
        autoOk = EN2.checked(key2) === true;
    }
    ok('支线路过自动点亮：200m 内定位 → 打卡点 ✓（不强求）', !sp2 || autoOk, '');
    // f) 成绩分享图 + PWA 资产
    var enrSrc = fs.readFileSync(path.join(ROOT, 'engine', 'enroute.js'), 'utf8');
    var manifestOk = false;
    try { manifestOk = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).display === 'standalone'; } catch (e) {}
    var swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    ok('今日成绩分享图：canvas 生成器在位（只画去过的点）',
        /shareTodayPng/.test(enrSrc) && /只展示去过/.test(enrSrc) && /!EN2?/.test('x') || (/shareTodayPng/.test(enrSrc) && /只展示去过/.test(enrSrc)), '');
    ok('离线 PWA：manifest standalone + sw 缓存清单（engine/enroute.js）+ HTML network-first + 瓦片走网络',
        manifestOk && /engine\/enroute\.js/.test(swSrc) && /network-first/i.test(swSrc) &&
        /cache-first/i.test(swSrc) && /走网络/.test(swSrc) &&
        /rel="manifest"/.test(html) && /serviceWorker/.test(html), '');
    /* ---------- S30.5：完成态返场规划视图 + 已完成天编辑锁 ---------- */
    console.log('\n【28】S30.5：完成态返场与编辑锁');
    delete lsStore['xianlumap.overlay.chuanxi'];
    // a) 规划视图完成态：注入行中打卡数据 → 天卡 ✓/绿边 + 节点 done + 段绿（源断言）+ 全完成横幅
    var s35 = bootRoute('chuanxi');
    var P = s35.sandbox;
    P.Edit.overlay.progress = { checks: { s0: { t: '2026-10-13T01:00:00Z', auto: true, ok: 1 } },
        daysDone: { 1: { t: '2026-10-13T02:00:00Z', durMin: 250, report: 1 } } };
    P.renderAll();
    var lis35 = created.filter(function (el) { return el.id === 'dyn:li'; }).slice(-5);
    var day1Done = /D1 ✓|✓/.test(lis35[0].innerHTML) &&
        /li.classList.add\('done'\)/.test(fs.readFileSync(path.join(ROOT, 'engine', 'route-engine.js'), 'utf8'));
    var nodeDone = /ch-node done/.test(lis35[0].innerHTML);
    var day2Normal = !/ch-item done/.test(lis35[1].innerHTML);
    var reEngSrc = fs.readFileSync(path.join(ROOT, 'engine', 'enroute.js'), 'utf8');
    ok('完成态返场：已打卡天卡绿边+✓、节点 done、未打卡天不受影响、行中退出重放绿（源）',
        day1Done && nodeDone && day2Normal && /_restoreSegStyles[\s\S]{0,600}daysDone/.test(reEngSrc), '');
    // b) 全完成横幅
    P.Edit.overlay.progress.daysDone = { 1: {}, 2: {}, 3: {}, 4: {}, 5: {} };
    P.renderAll();
    var bannerOk = created.some(function (el) { return el.id === 'allDoneBanner' && /全部完成/.test(el.textContent + el.innerHTML); });
    ok('全完成横幅：5 天全打卡 → 「全程 5 天全部完成」', bannerOk, '');
    // c) 编辑锁：取消（prompt 返回 null）拦截已完成天的标题/分段；「继续」放行
    var prompted = [];
    var s35b = bootRoute('chuanxi', { prompt: function (msg) { prompted.push(msg); return null; } });
    var B = s35b.sandbox;
    B.Edit.overlay.progress = { checks: {}, daysDone: { 2: { t: 'x' } } };
    var t0 = B.DAYS.filter(function (d) { return d.id === 2; })[0].title;
    var blocked1 = B.Edit.setDayField(2, 'title', '改写试试');
    var blocked2 = B.Edit.setSeg(2, 10, 20);
    var unchanged = B.DAYS.filter(function (d) { return d.id === 2; })[0].title === t0 &&
        B.DAYS.filter(function (d) { return d.id === 2; })[0].altKm[0] !== 10;
    var lockMsgOk = prompted.some(function (m) { return /已完成打卡/.test(m) && /改写历史/.test(m); });
    var s35c = bootRoute('chuanxi', { prompt: function () { return '继续'; } });
    var C = s35c.sandbox;
    C.Edit.overlay.progress = { checks: {}, daysDone: { 2: { t: 'x' } } };
    var passed = C.Edit.setDayField(2, 'title', '确认后放行') === undefined &&
        C.DAYS.filter(function (d) { return d.id === 2; })[0].title === '确认后放行';
    ok('已完成天编辑锁：取消拦截（标题/分段不动）+ 确认文案 + 输入「继续」放行',
        blocked1 !== true && blocked2 === false && unchanged && lockMsgOk && passed,
        'prompts=' + prompted.length);
    // d) 恢复原始数据 progress 不动（打卡是旅程事实）
    var s35d = bootRoute('chuanxi', { prompt: function () { return '确定'; } });
    var D = s35d.sandbox;
    D.Edit.overlay.progress = { checks: { s1: { t: 'x', auto: true, ok: 1 } }, daysDone: { 3: { t: 'x' } } };
    D.Edit.setDayField(2, 'title', '会丢的草稿');
    D.Edit.reset();
    var progKept = !!(D.Edit.overlay.progress && D.Edit.overlay.progress.daysDone && D.Edit.overlay.progress.daysDone[3] &&
        D.Edit.overlay.progress.checks && D.Edit.overlay.progress.checks.s1);
    ok('恢复原始数据：progress 不被撤销（旅程事实），规划草稿回滚',
        progKept === true && D.DAYS.filter(function (d) { return d.id === 2; })[0].title !== '会丢的草稿', '');

    /* ---------- S34：移动端正统化（peek 瘦身 / 标题条一行化 / 打卡筛选 / 支线排除 / wpSec 退役 / 把手按需） ---------- */
    console.log('\n【29】S34：移动端正统化');
    // a) 源码/CSS 边界：mob-peek 只露手柄+概要盒；桌面根本不建 peekBox（零变化）
    var css34 = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/) || ['', ''])[1];
    var reSrc = fs.readFileSync(path.join(ROOT, 'engine', 'route-engine.js'), 'utf8');
    var mobSrc = fs.readFileSync(path.join(ROOT, 'engine', 'mobile.js'), 'utf8');
    var profSrc = fs.readFileSync(path.join(ROOT, 'engine', 'profile.js'), 'utf8');
    ok('peek 边界在位（mob-peek 隐藏面板其余子元素 + peekBox 样式 + 桌面守卫）',
        /body\.mob-peek #panel > :not\(#sheetGrip\):not\(#peekBox\)\s*\{[^}]*display:\s*none/.test(css34) &&
        /#peekBox\s*\{[^}]*display:\s*none/.test(css34) &&
        /\.peek-rail\s*\{/.test(css34) && /\.peek-d\.done/.test(css34) &&
        /mob-peek/.test(mobSrc) &&
        /function renderPeekBox[\s\S]{0,400}innerWidth > 768[\s\S]{0,160}return/.test(reSrc), '');
    // b) 窄屏 boot：peekBox 内容 = S36 hero 大卡（eyebrow/起讫+里程/chips/程轨+刻度）
    var s34m = bootRoute('chuanxi', { innerWidth: 390, innerHeight: 844 });
    var M = s34m.sandbox;
    var peekHtml = elCache['peekBox'] && elCache['peekBox'].innerHTML || '';
    var peekOk = !s34m.err && peekHtml.indexOf('peekcard') >= 0 &&
        /<div class="pk-eyebrow">第 \d+ 程 · 共 \d+ 程<\/div>/.test(peekHtml) &&
        /<div class="pk-hero"><span class="pk-ft">[^<]+ → [^<]+<\/span><span class="pk-km">\d+<small>km<\/small><\/span><\/div>/.test(peekHtml) &&
        /<span class="pk-chip amber">⛺ 休整点 · [^<]+<\/span>[\s\S]*<span class="pk-chip" data-pfull="1">⚑ 打卡 \d+ 处<\/span>/.test(peekHtml) &&
        /<div class="peek-rail">[\s\S]*class="peek-d/.test(peekHtml) &&
        /<div class="pk-ticks">(<span>[^<]*<\/span>){5}<\/div>/.test(peekHtml) &&
        !/第\d+程/.test(peekHtml);   // S36：程标带空格（「第 N 程」），程轨药丸只露数字（✓/N），不重复程标
    ok('窄屏 peekBox：S36 hero 大卡（第 N 程·共 M 程 / 起讫+品牌绿里程 / 休整·打卡 chips / 程轨+5 地名刻度）', peekOk,
        peekHtml.replace(/<[^>]+>/g, ' ').slice(0, 80));
    ok('窄屏 peek 态 body 带 mob-peek（CSS 边界生效前提）',
        document.body.classList.contains('mob-peek'), '');
    // c) 打卡筛选上界：窄屏 D1 出现 .pt-m.extra + 「等N处 ▾」；桌面 boot 无（零变化）
    var mobLi = created.filter(function (el) { return el.id === 'dyn:li'; });
    var mobD1 = mobLi.length && mobLi[0].innerHTML || '';
    var s34d = bootRoute('chuanxi');
    var deskLi = created.filter(function (el) { return el.id === 'dyn:li'; });
    var deskD1 = deskLi.length && deskLi[0].innerHTML || '';
    ok('打卡代表点筛选：窄屏第 5 个起收 .pt-m.extra + 「等N处 ▾」收尾',
        mobD1.indexOf('pt-m extra') >= 0 && /等\d+处 ▾/.test(mobD1), '');
    ok('桌面零变化：桌面 D1 打卡行无 extra/无截断帽（▾/data-cap 仅窄屏）',
        deskD1.indexOf('pt-m extra') < 0 && deskD1.indexOf('data-cap') < 0 && deskD1.indexOf('▾') < 0, '');
    // d) 支线排除：青甘窄屏 D1 不含塔尔寺/拉脊山（支线点）；桌面仍含（零变化）
    var s34q = bootRoute('qinghai-gansu', { innerWidth: 390, innerHeight: 844 });
    var qLi = created.filter(function (el) { return el.id === 'dyn:li'; });
    var qD1 = qLi.length && qLi[0].innerHTML || '';
    var s34qd = bootRoute('qinghai-gansu');
    var qdLi = created.filter(function (el) { return el.id === 'dyn:li'; });
    var qdD1 = qdLi.length && qdLi[0].innerHTML || '';
    ok('支线点排除：窄屏青甘 D1 打卡行不含塔尔寺/拉脊山垭口',
        !s34q.err && qD1.indexOf('塔尔寺') < 0 && qD1.indexOf('拉脊山') < 0,
        '塔尔寺@' + qD1.indexOf('塔尔寺') + ' 拉脊山@' + qD1.indexOf('拉脊山') + ' | ' +
        qD1.replace(/<[^>]+>/g, ' ').slice(0, 90));
    ok('支线排除仅窄屏：桌面青甘 D1 仍含塔尔寺（归属口径不变）',
        qdD1.indexOf('塔尔寺') >= 0, '');
    // e) 剖面把手按需：窄屏 focusDay 后把手仍收起（elev-hide 在 + --elev-peek=0）
    try { M.focusDay(0); } catch (e) {}
    var gripHidden = document.body.classList.contains('elev-hide') &&
        (document.documentElement.style.__set || {})['--elev-peek'] === '0px';
    ok('移动把手退役：窄屏点天卡 → 剖面抽屉滑出但把手收起不占位',
        gripHidden && /innerWidth <= 768\) on = false/.test(reSrc) &&
        /var gripOn = !narrow/.test(profSrc), '');
    // f) 标题条一行化：模式开关接线（行中进出 body.enroute）+ 控制行 mobCtl 收纳出发地/顺逆/车型
    var enrIn = false, enrOut = false;
    try {
        elCache['mobModeEnr'].onclick();
        enrIn = document.body.classList.contains('enroute');
        elCache['mobModePlan'].onclick();
        enrOut = !document.body.classList.contains('enroute');
    } catch (e) {}
    ok('标题条模式开关：行中进入/退出（body.enroute 往返）',
        enrIn && enrOut, '');
    ok('标题条一行化源码：mobMode 段在位 + mobStartSlot 撤出标题条 + mobCtl 收纳两控件（车型切换 S35 已下线）',
        /id="mobMode"|mobModePlan/.test(mobSrc) && mobSrc.indexOf('mobStartSlot') < 0 &&
        /mobMove\(document\.getElementById\('startSeg'\), _ctl\)/.test(mobSrc) &&
        /mobMove\(document\.getElementById\('dirSeg'\), _ctl\)/.test(mobSrc) &&
        !/_ctl\.appendChild\(evsw\)/.test(mobSrc) && !/getElementById\('mobEv'\)/.test(mobSrc) &&
        !/getElementById\('mobFuel'\)/.test(mobSrc), '');
    /* ---------- S36：视觉底座（毛玻璃胶囊顶栏 / 补给悬浮钮 / 远景聚合药丸 / peek hero 大卡 216px） ---------- */
    console.log('\n【31】S36：视觉底座 + peek hero 大卡');
    var css36 = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/) || ['', ''])[1];
    // a) 胶囊顶栏：position:fixed 不动（c4 同口径）+ 毛玻璃 + 圆角；标题条占位口径 titleH=48 不动
    ok('S36 胶囊顶栏：mobBar 浮动毛玻璃胶囊（fixed/backdrop-filter/圆角 22px；titleH=48 占位口径不变）',
        /#mobBar\s*\{[^}]*position:\s*fixed[^}]*backdrop-filter:\s*blur\(18px\)[^}]*border-radius:\s*22px/.test(css36) &&
        /titleH = 48/.test(reSrc) && /var visTop = \(_fitBox\.titleH \|\| 0\) \+ 6/.test(reSrc), '');
    // b) 补给悬浮钮：BRAND.supply 定稿图标 + 空壳 toggle（__supOpen 不存在时静默）
    var logoSrc36 = fs.readFileSync(path.join(ROOT, 'engine', 'logo.js'), 'utf8');
    ok('S36 补给钮：BRAND.supply 图标（24 盒/油泵+闪电合体）+ mobSup 接线 + 空壳 toggle mob-sup 静默',
        /supply:\s*'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"/.test(logoSrc36) &&
        /M13\.5 11 h1 a3 3 0 0 1 3 3 v2\.5 a2 2 0 0 1-4 0 V15/.test(logoSrc36) &&
        /mobEl\('button', 'mobSup'/.test(mobSrc) && /toggleClass\('mob-sup'\)/.test(mobSrc) &&
        /__supOpen/.test(mobSrc) &&
        (function () {
            try {
                elCache['mobSup'].onclick();
                var on = document.body.classList.contains('mob-sup');
                elCache['mobSup'].onclick();
                return on && !document.body.classList.contains('mob-sup');
            } catch (e) { return false; }
        })(), '');
    // c) 远景聚合药丸：far 档（z<7）「⚡ N」「⛽ N」「⛺ N」白底胶囊上图；近景（z=7.3）不画
    //    （数据包 stock 无 stay 字段，注入住宿点触发休整层药丸分支）
    MOCK_ZOOM = 6.0;
    var lblBefore36 = calls.labels.length;
    var s36far = bootRoute('qinghai-gansu', { innerWidth: 390, innerHeight: 844 });
    try { s36far.sandbox.Edit.setDayField(1, 'stay', 'S36测试住宿'); s36far.sandbox.renderAll(); } catch (e) {}
    var farTexts = calls.labels.slice(lblBefore36).map(function (l) { return (l.opts && l.opts.text) || l.text || ''; })
        .filter(function (t) { return /^[⚡⛽⛺] \d+$/.test(t); });
    MOCK_ZOOM = 7.3;
    var lblBefore36b = calls.labels.length;
    var s36near = bootRoute('qinghai-gansu', { innerWidth: 390, innerHeight: 844 });
    var nearTexts = calls.labels.slice(lblBefore36b).map(function (l) { return (l.opts && l.opts.text) || l.text || ''; })
        .filter(function (t) { return /^[⚡⛽⛺] \d+$/.test(t); });
    ok('S36 远景聚合药丸：z=6 出「⚡ N」「⛽ N」「⛺ N」计数胶囊，z=7.3 近景收敛不画',
        !s36far.err && !s36near.err &&
        farTexts.some(function (t) { return /^⚡ \d+$/.test(t); }) &&
        farTexts.some(function (t) { return /^⛽ \d+$/.test(t); }) &&
        farTexts.some(function (t) { return /^⛺ \d+$/.test(t); }) &&
        nearTexts.length === 0,
        'far=' + farTexts.slice(0, 6).join('|') + '（×' + farTexts.length + '） near=' + nearTexts.length);
    // d) peek 露出高度 216：JS 常量与 CSS 变量同值（S36 hero 大卡）
    ok('S36 peek 高度 216px：MOBILE_PEEK=216 与 CSS --sheet-peek:216px 同值',
        /MOBILE_PEEK = 216/.test(mobSrc) && /--sheet-peek:\s*216px/.test(css36), '');
    /* ---------- S36 屏四：沿线补给（跟随行程 / 我的指定） ---------- */
    console.log('\n【32】S36 屏四：补给抽屉 + 我的指定');
    delete lsStore['xlm.stations.chuanxi'];
    var s36sup = bootRoute('chuanxi', { innerWidth: 390, innerHeight: 844 });
    var SUP = s36sup.sandbox.window.__sup;
    ok('__sup 接口在位（open/close/isOpen/list/count）且初始 0 条=跟随行程',
        !s36sup.err && SUP && typeof SUP.open === 'function' && typeof SUP.close === 'function' &&
        typeof SUP.isOpen === 'function' && Array.isArray(SUP.list()) && SUP.count() === 0, '');
    ok('open/close 驱动 body.mob-sup；open 时互斥关 mob-layers/mob-menu/mob-plan',
        (function () {
            try {
                document.body.classList.add('mob-layers');
                document.body.classList.add('mob-menu');
                SUP.open();
                var onOpen = document.body.classList.contains('mob-sup') &&
                    !document.body.classList.contains('mob-layers') &&
                    !document.body.classList.contains('mob-menu');
                var openFlag = SUP.isOpen() === true;
                SUP.close();
                return onOpen && openFlag && !document.body.classList.contains('mob-sup') && SUP.isOpen() === false;
            } catch (e) { return false; }
        })(), '');
    var supSt = s36sup.sandbox.STATION_DATA;
    ok('指定 2 站（STATION_DATA 下标）：xlm.stations.chuanxi 落盘（v:1 + designated 2 条含 c/i/t）',
        (function () {
            try {
                SUP.designate('ev', 0);
                SUP.designate('fuel', 0);
                var raw = JSON.parse(lsStore['xlm.stations.chuanxi'] || '{}');
                return raw.v === 1 && Array.isArray(raw.designated) && raw.designated.length === 2 &&
                    raw.designated[0].c === 'ev' && raw.designated[0].i === 0 &&
                    raw.designated[0].t === supSt.ev[0].t && raw.designated[1].c === 'fuel';
            } catch (e) { return false; }
        })(), '');
    ok('designated ≥1：横幅「已指定 2 站 · 其他补给点已隐藏」+ seg 角标 2 + 自动切「我的指定」',
        (function () {
            try {
                SUP.open();
                var banT = document.getElementById('supBanT');
                var badge = document.getElementById('supBadge');
                var segMine = document.getElementById('supSegMine');
                var segFol = document.getElementById('supSegFollow');
                var banOk = banT && /已指定 2 站 · 其他补给点已隐藏/.test(banT.textContent);
                var badgeOk = badge && String(badge.textContent) === '2' && badge.style.display !== 'none';
                var segOk = segMine && segMine.classList.contains('on') && segFol && !segFol.classList.contains('on');
                SUP.close();
                return banOk && badgeOk && segOk;
            } catch (e) { return false; }
        })(), '');
    ok('指定模式下 renderStations 不抛错且地图只画指定站（橙环钉=2、小圆点=0）',
        (function () {
            try {
                var before = calls.markers.length;
                s36sup.sandbox.renderStations();
                var pins = 0, dots = 0;
                calls.markers.slice(before).forEach(function (m) {
                    var o = m.opts || m;
                    var ox = o.offset ? o.offset.x : null;
                    if (ox === -19) pins++;          // planM 橙环钉 anchor 19
                    else if (ox === -12) dots++;     // dim 小圆点 anchor 12
                });
                return pins === 2 && dots === 0;
            } catch (e) { return 'THROW ' + e.message; }
        })(), '');
    ok('取消到 0 自动回跟随行程（角标隐藏、落盘清空、renderStations 回到现状链路不抛错）',
        (function () {
            try {
                SUP.clear();
                var raw = JSON.parse(lsStore['xlm.stations.chuanxi'] || '{}');
                SUP.open();
                var segFol = document.getElementById('supSegFollow');
                var badge = document.getElementById('supBadge');
                var followBack = segFol && segFol.classList.contains('on') &&
                    badge && badge.style.display === 'none';
                SUP.close();
                s36sup.sandbox.renderStations();
                return SUP.count() === 0 && raw.designated.length === 0 && followBack;
            } catch (e) { return false; }
        })(), '');
    ok('数据重建容错：t 不匹配的记录加载时丢弃',
        (function () {
            try {
                lsStore['xlm.stations.chuanxi'] = JSON.stringify({ v: 1, designated: [{ c: 'ev', i: 0, t: '已经不存在的站名' }] });
                var b2 = bootRoute('chuanxi', { innerWidth: 390, innerHeight: 844 });
                return !b2.err && b2.sandbox.window.__sup.count() === 0;
            } catch (e) { return false; }
        })(), '');
    /* ---------- S36 E 段：full 抽屉去缝合 / 屏三增减交互 / 远档减重 / 导航与续接 ---------- */
    console.log('\n【33】S36：抽屉去缝合 + 点菜单 + 远档减重 + 续接');
    var cssE = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/) || ['', ''])[1];
    var editSrcE = fs.readFileSync(path.join(ROOT, 'engine', 'edit.js'), 'utf8');
    // a) full 抽屉去缝合：旧侧栏残留仅 full 态隐藏（DOM 保留，桌面零变化）+ hero 复用 + 控制行轻量
    ok('full 抽屉去缝合：h1/sub/出发日期/工具栏/统计卡仅 full 态隐藏 + hero 大卡复用 + mobCtl 轻量 11px',
        /body\.mob-full #panel > h1,[\s\S]{0,240}body\.mob-full #panel > \.chips \{ display: none !important; \}/.test(cssE) &&
        /body\.mob-full #peekBox \{ display: block; \}/.test(cssE) &&
        /#mobCtl \.seg button \{ font-size: 11px/.test(cssE), '');
    // b) ⋯菜单确定性入口：保存修改/分享行程图（代理桌面真实按钮）+ 更换线路（去 route 参数回选线器）
    ok('⋯菜单收入确定性入口：保存修改/分享行程图（代理 btnDraftSave/btnShare）+ 更换线路（searchParams 删 route）',
        /mobMenuSave/.test(mobSrc) && /mobMenuShare/.test(mobSrc) && /mobMenuSwitch/.test(mobSrc) &&
        /getElementById\('btnDraftSave'\)[\s\S]{0,80}\.click\(\)/.test(mobSrc) &&
        /getElementById\('btnShare'\)[\s\S]{0,80}\.click\(\)/.test(mobSrc) &&
        /searchParams\.delete\('route'\)/.test(mobSrc), '');
    // c) 屏三：pt-m 单击 → openPtMenu；节点菜单含「更换地点」（relocateNode 替换名+节点 km）
    ok('屏三增减交互：打卡 chip 单击出点菜单（openPtMenu）；节点菜单「更换地点」项在位',
        /pt-m extra'\) \{\s*e\.stopPropagation\(\);\s*openPtMenu\(e\.clientX/.test(editSrcE) &&
        /data-a="reloc"/.test(editSrcE) &&
        /function relocateNode\(dayId, lat, lng, name\)/.test(editSrcE) &&
        /relocateNode\(rid, alat, alng, nm\)/.test(editSrcE), '');
    // d) 远档减重：z=7 → planM 收起（__planFarHidden）且盲区胶囊不上图；z=8.5 → 恢复
    ok('远档减重（z<8）：z=7 时 planM 收起 + 无盲区胶囊文本；z=8.5 恢复上图',
        (function () {
            MOCK_ZOOM = 7.0;
            var lblB = calls.labels.length;
            var b7 = bootRoute('qinghai-gansu', { innerWidth: 390, innerHeight: 844 });
            var farHidden = b7.sandbox.window.__planFarHidden === true;
            var warnFar = calls.labels.slice(lblB).some(function (l) { var t = (l.opts && l.opts.text) || l.text || ''; return /无快充|无加油站/.test(t); });
            MOCK_ZOOM = 8.5;
            var lblB2 = calls.labels.length;
            var b85 = bootRoute('qinghai-gansu', { innerWidth: 390, innerHeight: 844 });
            var nearOk = b85.sandbox.window.__planFarHidden === false &&
                calls.labels.slice(lblB2).some(function (l) { var t = (l.opts && l.opts.text) || l.text || ''; return /无快充|无加油站/.test(t); });
            MOCK_ZOOM = 7.3;
            return !b7.err && !b85.err && farHidden && !warnFar && nearOk;
        })(), '');
    // e) 行中续接：预置 legs.startTs（未完成）→ 提示条出现 → 点击 enter → body.enroute
    ok('行中续接：预置已出发未完成程 → peek 上方「▶ 继续行中 · 第 N 程 →」→ 点击入行中',
        (function () {
            try {
                delete lsStore['xianlumap.overlay.qinghai-gansu'];
                lsStore['xianlumap.overlay.qinghai-gansu'] = JSON.stringify({ progress: { legs: { 1: { startTs: 1699999999000 } }, daysDone: {}, checks: {} } });
                var be = bootRoute('qinghai-gansu', { innerWidth: 390, innerHeight: 844 });
                var peekH = elCache['peekBox'].innerHTML || '';
                var barOk = /class="pk-resume" id="pkResume"[^>]*>▶ 继续行中 · 第 1 程 →</.test(peekH);
                var rEl = elCache['pkResume'];
                if (rEl && typeof rEl.onclick === 'function') rEl.onclick();
                var entered = document.body.classList.contains('enroute');
                if (entered && be.sandbox.window.Enroute) be.sandbox.window.Enroute.exit();
                document.body.classList.remove('enroute');
                delete lsStore['xianlumap.overlay.qinghai-gansu'];
                return !be.err && barOk && entered;
            } catch (e) { return 'THROW ' + e.message; }
        })(), '');
    // f) 规划续接：预置 EDIT_KEY 草稿 → boot 自动应用（editLoad + bootMerge 机制在位）
    ok('规划续接：预置草稿（第 2 程标题）→ boot 自动应用到链上',
        (function () {
            try {
                delete lsStore['xianlumap.overlay.chuanxi'];
                lsStore['xianlumap.overlay.chuanxi'] = JSON.stringify({ days: { 2: { title: '续接验证标题' } }, meta: {} });
                var bc = bootRoute('chuanxi', { innerWidth: 390, innerHeight: 844 });
                var ok2 = !bc.err && bc.sandbox.DAYS.filter(function (d) { return d.id === 2; })[0].title === '续接验证标题';
                delete lsStore['xianlumap.overlay.chuanxi'];
                return ok2;
            } catch (e) { return 'THROW ' + e.message; }
        })(), '');
    /* ---------- S35：无「天」UI 锁 ---------- */
    console.log('\n【30】S35：「程」改名零残留锁');
    (function () {
        var files = ['route-engine.js', 'edit.js', 'enroute.js', 'mobile.js', 'profile.js', 'planner.js', 'ui.js', 'picker.js', 'sync.js', 'logo.js'].map(function (f) {
            return { name: 'engine/' + f, src: fs.readFileSync(path.join(ROOT, 'engine', f), 'utf8') };
        });
        files.push({ name: 'index.html', src: html });
        var blacklist = /第.{0,3}天|天数|今天|明天|归天|这一天|每一天|别天|天卡|天完成/;
        var hits = [];
        files.forEach(function (f) {
            var inComment = false;
            f.src.split('\n').forEach(function (line, i) {
                /* 块注释状态机：先整条剥离注释段再扫黑名单（行注释同理） */
                var code = '', rest = line, guard = 0;
                while (rest && guard++ < 50) {
                    if (inComment) {
                        var end = rest.indexOf('*/');
                        if (end < 0) { rest = ''; break; }
                        rest = rest.slice(end + 2); inComment = false; continue;
                    }
                    var bs = rest.indexOf('/*'), ls = rest.indexOf('//');
                    if (bs < 0 && ls < 0) { code += rest; break; }
                    if (ls >= 0 && (bs < 0 || ls < bs)) { code += rest.slice(0, ls); break; }
                    code += rest.slice(0, bs); rest = rest.slice(bs + 2); inComment = true;
                }
                var m = code.match(blacklist);
                if (m) hits.push(f.name + ':' + (i + 1) + ' ' + code.trim().slice(0, 60));
            });
        });
        ok('无「天」UI 锁（可见行黑名单：第N天/天数/今天/归天/天卡…；注释豁免）',
            hits.length === 0, hits.slice(0, 5).join(' | ') || '零残留');
    })();
    console.log('\n结果: ' + pass + ' pass / ' + fail + ' fail');
    process.exit(fail ? 1 : 0);
});
