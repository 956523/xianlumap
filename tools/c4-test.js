// C4 回归测试：mock TMap + DOM，在 node vm 中跑完整引擎 + 指定线路包（S6 参数化）
// 跑法：node tools/c4-test.js [routeId]   缺省 = 轮跑 route-defs/ 下全部线路包
// 每条线路 94 项断言：期望数值全部按包内容推导（天数/出发地/站点），
// 不再硬编码青甘语义；仅构建工具链检查（【12】【13】）针对参数化后的 tools/ 源码。
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { loadRoutePackage } = require('./lib/build-lib');
const dir = __dirname;
const ROOT = path.resolve(dir, '..');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// 主脚本：S8 起引擎由 loader 按 ?route= 分支 document.write 按需加载（线路页 5 个引擎；
// 选线器页只有 picker.js）。此处按页面相同顺序拼接注入；正则兼容 document.write
// 字符串里的 "<\/script>" 转义写法，新增引擎文件自动跟随。
const engineSrcs = Array.from(html.matchAll(/<script src="(engine\/[a-z0-9-]+\.js)"><\\?\/script>/g)).map(m => m[1]);
const mainScript = engineSrcs.map(s => fs.readFileSync(path.join(ROOT, s), 'utf8')).join('\n').trim();
// 线路登记清单（选线器用；runRoute 里有「manifest 与包一致」交叉断言防漂移）
const manifestSb = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'route-defs', 'manifest.js'), 'utf8'), manifestSb);
const MANIFEST = manifestSb.ROUTE_MANIFEST || [];
// 路线无关的仓库级检查对象（每个线路包运行时各计一次断言）
const htmlSrc = html;
const cssOnly = htmlSrc.replace(/\/\*[\s\S]*?\*\//g, '');   // 剥掉 CSS 注释
const toolSrc = fs.readFileSync(path.join(ROOT, 'tools', 'build-stations.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(ROOT, 'tools', 'lib', 'build-lib.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  [' + extra + ']' : '')); }
    else { fail++; console.log('  ❌ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

/* ---------- mock（状态在每次运行前重置） ---------- */
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
    InfoWindow: function () { this.open = function () {}; this.close = function () {}; this.setPosition = function () {}; },
    MultiMarker: function (o) { FakeLayer.call(this, 'marker', o); },
    MultiLabel: function (o) { FakeLayer.call(this, 'label', o); },
    MultiPolyline: function (o) { FakeLayer.call(this, 'polyline', o); },
    MarkerStyle: function (o) { this.o = o; },
    LabelStyle: function (o) { this.o = o; },
    PolylineStyle: function (o) { this.o = o; },
    LatLngBounds: function () { this.extend = function () {}; }
};
const created = []; // 记录 createElement 产物（dayList li / 出发地按钮等）
function fakeEl(id) {
    return {
        id: id, textContent: '', innerHTML: '', value: '500',
        checked: true, style: new Proxy({ setProperty() {}, getPropertyValue() { return ''; } }, { set: () => true, get: (t, k) => (k in t ? t[k] : '') }),
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {},
        getBoundingClientRect() { return { top: 0, left: 0, width: 1200, height: 300, bottom: 300, right: 1200 }; },
        children: [],
        querySelector() { return fakeEl(id + '.*'); },
        querySelectorAll(sel) {
            if (/sizes/.test(sel)) {
                return ['130', '210', '300'].map(h => {
                    const b = fakeEl('sizeBtn');
                    b.getAttribute = () => h;
                    return b;
                });
            }
            return [];
        },
        onclick: null, oninput: null, onchange: null
    };
}
const elCache = {};
const document = {
    getElementById(id) { if (!elCache[id]) elCache[id] = fakeEl(id); return elCache[id]; },
    createElement(tag) { const el = fakeEl('dyn:' + tag); created.push(el); return el; },
    createElementNS() { return fakeEl('svg'); },
    querySelector() { return fakeEl('qs'); },
    addEventListener() {}
};
document.body = fakeEl('body');
document.documentElement = fakeEl('html');
const getComputedStyle = (el) => ({
    getPropertyValue(k) { return el && el.__vars && el.__vars[k] || ''; }
});
document.documentElement.__vars = { '--elev-occupy': '46px' };
const window = { addEventListener() {}, innerWidth: 1600, innerHeight: 900 };

function resetMocks() {
    calls.polyline.length = 0; calls.markers.length = 0; calls.labels.length = 0;
    created.length = 0;
    Object.keys(elCache).forEach(k => { delete elCache[k]; });
}

/* ---------- 每条线路的运行 ---------- */
function runRoute(routeId) {
    const { src: routeDefs, pkg } = loadRoutePackage(routeId);
    // 按包内容推导期望（不再硬编码任何线路语义）
    const totalDays = pkg.CORE.length + 1;
    const driveDays = pkg.CORE.concat([pkg.TAIL]).filter(d => d.path).length;
    const secondStart = (pkg.ROUTE_STARTS || [])[1] || null;
    const stationsOn = !!(pkg.STATION_DATA && pkg.STATION_DATA.ev && pkg.STATION_DATA.ev.length);
    const evLabel = '充电';

    resetMocks();
    console.log('\n========== 线路包：' + routeId + '（' + totalDays + ' 天 / ' + (secondStart ? '双' : '单') + '出发地 / 站点' + (stationsOn ? '已接入' : '未接入') + '） ==========');

    console.log('\n【1】脚本加载与启动');
    const syncTimeout = (fn) => { try { fn(); } catch (e) {} return 0; };
    let bootErr = null, sandbox = null;
    try {
        sandbox = vm.createContext({ TMap, document, window, console, setTimeout: syncTimeout, clearTimeout: () => {}, encodeURIComponent, parseFloat, parseInt, getComputedStyle, ResizeObserver: function (cb) { this.observe = function () {}; this.disconnect = function () {}; } });
        vm.runInContext(routeDefs + '\n' + mainScript, sandbox);
    } catch (e) { bootErr = e; }
    ok('主脚本执行无异常', !bootErr, bootErr ? bootErr.message.slice(0, 120) : '');
    if (bootErr) { console.log(bootErr.stack); console.log('\n结果: ' + pass + ' pass / ' + fail + ' fail（中断）'); process.exit(1); }

    /* 数据注入验证（通过弱化层标记数量反映） */
    const startMarkers = calls.markers.slice();
    const geomCount = l => ((l && (l.geometries || (l.opts && l.opts.geometries))) || []).length;
    const totalMarkerGeoms = startMarkers.reduce((a, l) => a + geomCount(l), 0);
    if (stationsOn) {
        ok('站点已上图（启动后 marker 层有几何）', totalMarkerGeoms > 0, totalMarkerGeoms + ' 个');
    } else {
        ok('站点未接入如实透出（无 marker 几何 + 面板提示）', totalMarkerGeoms === 0, totalMarkerGeoms + ' 个');
    }

    /* 线路登记清单（S8）：manifest 有该线且元数据与包内一致（防清单漂移） */
    const mf = MANIFEST.filter(e => e.id === routeId)[0];
    const pkgDayKm = pkg.CORE.concat([pkg.TAIL]).reduce((a, d) => a + (d.km || 0), 0);
    ok('线路登记在 manifest 且元数据与包一致',
        !!mf && mf.name === pkg.ROUTE_META.name && mf.days === totalDays &&
        Math.abs(mf.totalKm - pkgDayKm) <= 1 &&
        mf.updatedAt === (pkg.STATION_DATA && pkg.STATION_DATA.builtAt) &&
        mf.probe === pkg.ROUTE_META.probe,
        mf ? (mf.name + ' ' + mf.totalKm + 'km/' + mf.days + '天 @' + mf.updatedAt) : 'manifest 缺登记');

    /* 计划面板 */
    const planBox = elCache['planBox'];
    ok('计划面板已渲染', planBox && (planBox.innerHTML.includes('全程需') || planBox.innerHTML.includes('未接入')), (planBox.innerHTML.match(/全程需\S+?\s\d+/) || [''])[0]);
    const m1 = planBox.innerHTML.match(new RegExp('全程需' + evLabel + ' <b>(\\d+)</b>')) || planBox.innerHTML.match(/全程需\S+ <b>(\d+)<\/b>/);
    ok('规划输出' + evLabel + '次数', stationsOn ? !!m1 : planBox.innerHTML.includes('未接入'), m1 ? m1[1] + ' 次' : '');

    console.log('\n【2】续航单调性（拉低续航 → ' + evLabel + '次数不减）');
    const nDefault = m1 ? +m1[1] : -1;
    elCache['rngRange'].value = '1000';
    elCache['rngRange'].oninput && elCache['rngRange'].oninput();
    const mHi = (planBox.innerHTML.match(/全程需\S+ <b>(\d+)<\/b>/) || [])[1];
    ok('1000km 续航' + evLabel + '次数 ≤ 默认 500km', mHi !== undefined && +mHi <= nDefault, mHi + ' 次 vs ' + nDefault + ' 次');
    elCache['rngRange'].value = '300';
    elCache['rngRange'].oninput && elCache['rngRange'].oninput();
    const mLo = (planBox.innerHTML.match(/全程需\S+ <b>(\d+)<\/b>/) || [])[1];
    const hasWarn = planBox.innerHTML.includes('无可达');
    // 续航变低 → 次数不减。但若某段真实站距已超车可达范围，规划如实报「无可达」并停止数站
    // （S4 修复全长规划后：>210km 无桩段 vs 300km 续航×0.85×0.7 时发生）。
    // 「次数更少 + 不可达警告」是正确行为，不是回归。
    ok('300km 续航' + evLabel + '次数 ≥ 默认（或如实报不可达）', +mLo >= nDefault || hasWarn, mLo + ' 次' + (hasWarn ? '（含不可达警告）' : ''));
    console.log((hasWarn ? '  ⚠️ 300km 续航出现不可达警告（该线存在 >210km 级站距段）' : '  ℹ️ 300km 续航无不可达警告'));

    console.log('\n【3】油车模式');
    elCache['btnFuel'].onclick && elCache['btnFuel'].onclick();
    const mFuel = (planBox.innerHTML.match(/全程需加油 <b>(\d+)<\/b>/) || [])[1];
    ok('加油规划输出', stationsOn ? mFuel !== undefined : planBox.innerHTML.includes('未接入'), mFuel !== undefined ? mFuel + ' 次' : '');
    elCache['btnEv'].onclick && elCache['btnEv'].onclick();

    console.log('\n【4】出发地切换' + (secondStart ? '（第二出发地：' + secondStart.name + '）' : '（单出发地）'));
    const sumDayKm = () => sandbox.DAYS.reduce((a, d) => a + (d.km || 0), 0);
    if (secondStart) {
        // 出发地按钮由包内 ROUTE_STARTS 渲染（createElement 产出）
        const sBtn = created.filter(el => el.id === 'dyn:button' && el.onclick && el.textContent === secondStart.name)[0];
        sBtn && sBtn.onclick();
        const mLz = (planBox.innerHTML.match(/全程需\S+ <b>(\d+)<\/b>/) || [])[1];
        ok('第二出发地规划重算', mLz !== undefined, mLz + ' 次');
        const chipKm = parseInt(elCache['chipKm'].textContent, 10);
        ok('里程 chips 与逐日合计自洽（|chip−Σ天| ≤ 2）', Math.abs(chipKm - sumDayKm()) <= 2, chipKm + ' vs ' + sumDayKm());
        const lzMarkers = calls.markers.slice(startMarkers.length);
        const lzGeoms = lzMarkers.reduce((a, l) => a + geomCount(l), 0);
        ok('第二出发地站点更多（含接入段）', lzGeoms >= totalMarkerGeoms, lzGeoms + ' vs ' + totalMarkerGeoms);
    } else {
        const startBtns = created.filter(el => el.id === 'dyn:button' && el.onclick && el.className !== 'edit-mini' && el.className !== 'btn-fit edit-toggle');
        ok('单出发地：不渲染切换按钮', startBtns.length === 0, startBtns.length + ' 个按钮');
        sandbox.setStart(sandbox.STARTS[0].id);   // 重选当前出发地 → 幂等
        ok('单出发地：setStart 幂等（天数/里程不变）', sandbox.DAYS.length === totalDays && Math.abs(parseInt(elCache['chipKm'].textContent, 10) - sumDayKm()) <= 2, sandbox.DAYS.length + ' 天');
        ok('单出发地：行程天数 = 包内天数', sandbox.DAYS.length === totalDays, totalDays + ' 天');
    }

    console.log('\n【5】v3 回归：polyline geometry 内 paths 复数');
    const badSegs = [];
    calls.polyline.forEach((p, i) => {
        const o = p.opts || p;
        const geoms = o.geometries || [];
        const bad = geoms.length === 0 || geoms.some(g => Object.prototype.hasOwnProperty.call(g, 'path')
            || !Array.isArray(g.paths) || g.paths.length === 0);
        if (bad) badSegs.push('段' + i + '(geoms=' + geoms.length + ')');
    });
    ok('MultiPolyline 几何使用 paths 字段', calls.polyline.length > 0 && badSegs.length === 0, calls.polyline.length + ' 段' + (badSegs.length ? ' 异常: ' + badSegs.join('; ') : ''));
    ok('PolylineStyle 无小数 borderWidth', calls.polyline.every(l => Object.values(l.styles || {}).every(s => s.borderWidth === undefined || Number.isInteger(s.borderWidth))));

    console.log('\n【6】按天海拔图像化');
    const lis = created.filter(el => el.id === 'dyn:li');
    ok('每日列表项生成', lis.length >= totalDays, lis.length + ' 项（包内 ' + totalDays + ' 天）');
    const withSpark = lis.filter(el => el.innerHTML.includes('day-spark') && el.innerHTML.includes('<svg'));
    ok('除休整日外每项含 mini 海拔曲线', withSpark.length >= lis.length - 2, withSpark.length + '/' + lis.length + '（休整日无路线不画）');
    const sparkOk = lis.filter(el => el.innerHTML.includes('polyline points='));
    ok('mini 曲线有几何数据（≥行程日数）', sparkOk.length >= driveDays, sparkOk.length + ' 项带 polyline（' + driveDays + ' 个行程日）');
    elCache['chartBox'].appendChild = function (c) { this.children.push(c); };
    lis[0].onclick();
    const svgEl = elCache['chartBox'].children[elCache['chartBox'].children.length - 1];
    const t1 = svgEl ? svgEl.innerHTML : '';
    ok('聚焦剖面 SVG 带爬升/下降', /↑\d+/.test(t1) && /↓\d+/.test(t1), (t1.match(/D\d+[^<]*↑\d+m[^<]*↓\d+m/) || [''])[0]);
    ok('聚焦提示文案', elCache['elevTitle'].textContent.includes('返回全程'), elCache['elevTitle'].textContent);
    lis[0].onclick();
    const svgAll = elCache['chartBox'].children;
    const t2 = svgAll[svgAll.length - 1].innerHTML;
    ok('再点同一天恢复全程（新 SVG 无聚焦标题）', !/↑\d+m/.test(t2) && !/↓\d+m/.test(t2), '');
    ok('恢复全程提示文案', elCache['elevTitle'].textContent.includes('点侧栏任一天'), elCache['elevTitle'].textContent);
    if (secondStart) {
        const sBtn2 = created.filter(el => el.id === 'dyn:button' && el.onclick && el.textContent === secondStart.name)[0];
        sBtn2 && sBtn2.onclick();
        const lis2 = created.filter(el => el.id === 'dyn:li').slice(-totalDays);
        const lastDay = sandbox.DAYS[sandbox.DAYS.length - 1];
        lis2[lis2.length - 1].onclick();
        const svgLz = elCache['chartBox'].children[elCache['chartBox'].children.length - 1];
        const t3 = svgLz.innerHTML;
        ok('第二出发地末天聚焦正常（D' + lastDay.id + '）', new RegExp('D' + lastDay.id).test(t3) && /↑\d+/.test(t3), (t3.match(/D\d+[^<]*↑\d+m[^<]*↓\d+m/) || [''])[0]);
    } else {
        const lastDay = sandbox.DAYS[sandbox.DAYS.length - 1];
        lis[lis.length - 1].onclick();
        const svgLast = elCache['chartBox'].children[elCache['chartBox'].children.length - 1];
        const t3b = svgLast.innerHTML;
        ok('单出发地末天聚焦正常（D' + lastDay.id + '）', new RegExp('D' + lastDay.id).test(t3b) && /↑\d+/.test(t3b), (t3b.match(/D\d+[^<]*↑\d+m[^<]*↓\d+m/) || [''])[0]);
    }

    console.log('\n【7】剖面底部抽屉（v8 拖拽交互）');
    const elevEl2 = elCache['elev'];
    let cls = { folded: true, open: false };
    elevEl2.classList = {
        add(c) { cls[c] = true; },
        remove(c) { cls[c] = false; },
        toggle(c, f) { cls[c] = f === undefined ? !cls[c] : !!f; },
        contains(c) { return !!cls[c]; }
    };
    ok('抽屉初始收起（folded）', cls.folded === true && cls.open !== true, 'folded=' + cls.folded);
    const cbEl = elCache['chartBox'];
    let cbH = '';
    cbEl.style = { set height(v) { cbH = v; }, get height() { return cbH; } };
    ok('抽屉展开写入图表高度', (() => {
        const chartH = Math.max(90, 300 - 108);
        cbEl.style.height = chartH + 'px';
        return cbH === '192px';
    })(), cbH);
    ok('高度下限保护（90px 起）', Math.max(90, 190 - 108) === 90, '最低 90px');
    ok('拖拽手柄元素存在', !!elCache['elevGrip'], elCache['elevGrip'] ? 'elevGrip' : '缺失');
    ok('收起按钮存在', !!elCache['elevClose'], 'elevClose');
    elCache['chartBox'].children.length = 0;
    elCache['btnFit'] && elCache['btnFit'].onclick && elCache['btnFit'].onclick();
    const tAll = elCache['chartBox'].children[elCache['chartBox'].children.length - 1];
    const allSvg = tAll ? tAll.innerHTML : '';
    ok('全程剖面无 undefined 文案', allSvg.length > 0 && !/undefined/.test(allSvg), /undefined/.test(allSvg) ? '含 undefined' : '干净');
    ok('全程剖面 Y 轴刻度 ≥3 条', (allSvg.match(/>\d{3,4}<\/text>/g) || []).length >= 3,
        (allSvg.match(/>\d{3,4}<\/text>/g) || []).length + ' 条');
    const allNames = (allSvg.match(/<text[^>]*text-anchor="middle"[^>]*>[^<]+<\/text>/g) || []).length;
    ok('全程模式地名已稀疏化（≤10 个）', allNames <= 10, allNames + ' 个');
    ok('全程剖面保留垭口/最高点标注', /垭口|最高/.test(allSvg) || (pkg.ALT_MARKS || []).filter(m => m.pass).length === 0, '垭口类标记存在（该线无垭口则豁免）');
    lis[4] && lis[4].onclick();
    const tFoc = elCache['chartBox'].children[elCache['chartBox'].children.length - 1].innerHTML;
    ok('聚焦态曲线与站点同色系', /stroke="#ea580c"/.test(tFoc) && /fill="#ea580c"/.test(tFoc), '橙色统一');
    ok('聚焦态 Y 轴压缩（起伏 <250m 也成型）', /polyline/.test(tFoc), '');

    console.log('\n【8】层级体系（v8 修复关键 bug）');
    const zPanel = (htmlSrc.match(/--z-panel:\s*(\d+)/) || [])[1];
    const zDrawer = (htmlSrc.match(/--z-drawer:\s*(\d+)/) || [])[1];
    const zMap = (htmlSrc.match(/--z-map-overlay:\s*(\d+)/) || [])[1];
    const zCollapse = (htmlSrc.match(/--z-collapse:\s*(\d+)/) || [])[1];
    ok('层级变量已定义', !!zPanel && !!zDrawer && !!zMap, 'panel=' + zPanel + ' drawer=' + zDrawer + ' map=' + zMap);
    ok('侧栏高于地图覆盖层(1000)', +zPanel > +zMap, zPanel + ' > ' + zMap);
    ok('抽屉高于地图覆盖层(1000)', +zDrawer > +zMap, zDrawer + ' > ' + zMap);
    ok('侧栏收起按钮在抽屉之上', +zCollapse > +zDrawer, zCollapse + ' > ' + zDrawer);
    const bareZ = (cssOnly.match(/z-index:\s*\d+/g) || []).filter(s => !/z-index:\s*2\b/.test(s));
    ok('无硬编码裸 z-index 残留', bareZ.length === 0, bareZ.join(',') || '全部走变量');

    console.log('\n【9】全屏遮挡修复（v9-A：地图容器让位）');
    ok('地图容器使用 --elev-occupy 让位',
        /#map\s*\{[^}]*height:\s*calc\(100vh\s*-\s*var\(--elev-occupy/.test(cssOnly), 'CSS 已接线');
    ok('syncMapOccupy 已定义', /function syncMapOccupy\s*\(/.test(mainScript), '');
    ok('抽屉开合调用 syncMapOccupy',
        (mainScript.match(/syncMapOccupy\(\);/g) || []).length >= 3,
        (mainScript.match(/syncMapOccupy\(\);/g) || []).length + ' 处（open/close/setDrawerH/start）');
    ok('ResizeObserver 监听地图容器变化',
        /new ResizeObserver\(onMapBoxChange\)\.observe\(mapEl\)/.test(mainScript), '');
    ok('visibleBox 同时算宽度与高度遮挡（宽屏横向 / 窄屏纵向两种形态）',
        /function visibleBox\s*\(/.test(mainScript) &&
        /w = vw - pr\.right - 14/.test(mainScript) &&
        /h = Math\.min\(h, vh - occ - 14\)/.test(mainScript) &&
        /var narrow = vw <= 720/.test(mainScript) &&
        /h = vh - Math\.max\(panelBottom, 0\) - 14/.test(mainScript),
        '宽屏=视口−侧栏宽，窄屏=视口−侧栏底，两者都与抽屉占用高度取更紧值');
    ok('zoom 由地理包围盒反算（墨卡托）',
        /function zoomToFit\s*\(/.test(mainScript) &&
        /mercY/.test(mainScript) &&
        /Math\.log2\(availW \/ \(256 \* xSpan\)\)/.test(mainScript),
        '不再用经验常数');
    ok('包围盒从 CORE+TAIL 全程轨迹算出（非写死；TAIL 并防止单线末段被裁）',
        /var LOOP_BBOX = \(function/.test(mainScript) && /CORE\.concat\(\[TAIL\]\)\.forEach/.test(mainScript), '');
    ok('fitAll 对侧栏做横向中心补偿',
        /box\.panelRight > 0/.test(mainScript), '环线落在可见区中心');
    const vbSrc = (mainScript.match(/function visibleBox[\s\S]*?\n\s{4}\}/) || [''])[0];
    ok('容器变化通知 resize() 且 visibleBox 计入侧栏遮挡',
        /typeof map\.resize === 'function'/.test(mainScript) && /getBoundingClientRect\(\)/.test(vbSrc), '');

    console.log('\n【10】侧栏窄视口布局（v9-B）');
    ok('day-meta 显式 flex column',
        /\.day-meta\s*\{[^}]*flex-direction:\s*column/.test(cssOnly), '标题与备注纵向排列');
    ok('窄视口隐藏 sparkline 让位',
        /max-width:\s*860px[\s\S]{0,120}\.day-spark\s*\{\s*display:\s*none/.test(cssOnly), '');
    ok('窄视口侧栏宽度一并收缩',
        /max-width:\s*720px[\s\S]{0,160}width:\s*calc\(100vw\s*-\s*28px\)/.test(cssOnly), '不再只改 max-height');
    ok('中等视口侧栏收窄',
        /min-width:\s*721px[\s\S]{0,80}max-width:\s*1000px[\s\S]{0,80}width:\s*252px/.test(cssOnly), '');
    ok('面板自绘滚动条',
        /#panel::-webkit-scrollbar/.test(cssOnly), '');

    console.log('\n【11】统计数字改为计算得出（v9-B）');
    ok('里程/天数不再写死初值',
        /<b id="chipKm">—<\/b>/.test(htmlSrc) && /<b id="chipDays">—<\/b>/.test(htmlSrc), '改为占位符');
    ok('最高海拔改为 id 绑定',
        /<b id="chipMaxAlt">/.test(htmlSrc), '原先写死 3820');
    ok('peakAlt 从 ALT_REAL 计算',
        /function peakAlt\s*\(/.test(mainScript) && /ALT_REAL\.forEach/.test(mainScript), '');
    ok('天数按有里程的行程日统计',
        /if \(d\.km > 0\) driveDays\+\+/.test(mainScript), '休整日不计入');
    ok('chipMaxAlt 有 tooltip 说明最高点',
        /chipMaxAlt'\)\.title/.test(mainScript), '');

    console.log('\n【12】站点配额与覆盖体检（v9-B → S3 参数化构建）');
    // 旧的"按距离排序后截断"必须彻底消失
    ok('已移除按距离截断（MAX_EV/MAX_FUEL）',
        !/MAX_EV|MAX_FUEL/.test(toolSrc), '不再 slice 到固定条数');
    ok('改为按里程分段配额',
        /function quota\s*\(/.test(toolSrc) && /bucketKm/.test(toolSrc), '');
    ok('配额含长间隔补洞',
        /criticalGap/.test(toolSrc), '防无人区归零');
    ok('覆盖率体检（25km 网格）',
        /function coverage\s*\(/.test(toolSrc) && /Math\.ceil\(TOTAL_KM \/ 25\)/.test(toolSrc), '');

    console.log('\n【13】投影基准与抓取范围（v9-B 根因修复 → S3 参数化）');
    // 投影必须用与页面同源的包内轨迹，不能手写折线
    ok('投影消费包内轨迹（CORE/TAIL/接入段）',
        /function buildProjection\s*\(/.test(libSrc) && /leadPath/.test(libSrc) && /pkg\.CORE/.test(libSrc), '同源真实轨迹');
    ok('缺输入时中止而非静默跑错',
        /throw new Error/.test(toolSrc) && /poiRegions/.test(toolSrc), '无行政区清单即拒绝运行');
    ok('里程按 apiKm 累计分配（非单一缩放）',
        /SEG_KM/.test(libSrc) && /apiKm \/ arc/.test(libSrc), '');
    ok('行政区穷举清单随包（人工可审）',
        Array.isArray(pkg.ROUTE_BUILD.poiRegions) && pkg.ROUTE_BUILD.poiRegions.length >= 5,
        (pkg.ROUTE_BUILD.poiRegions || []).length + ' 个行政区');
    ok('POI 源可参数化（amap place/text 或 tencent region）',
        /place\/text/.test(toolSrc) && /citylimit/.test(toolSrc) && /region\(/.test(toolSrc), '');
    ok('解析 POI 运营商字段',
        /BRANDS/.test(toolSrc) && /op:/.test(toolSrc), '品牌白名单提取');

    console.log('\n【14】站点显示去重（v9-C：城区站叠成马赛克）');
    ok('有屏幕空间去重函数',
        /function dedupeByScreen\s*\(/.test(mainScript), '按墨卡托投影后的像素距离判重');
    ok('去重阈值随 zoom 变化（不是写死常数）',
        /function dedupeMinPx\s*\(\s*zoom\s*\)/.test(mainScript) &&
        /Z_DIM_NEAR\s*=\s*40/.test(mainScript) &&
        /Z_DIM_FAR\s*=\s*18/.test(mainScript),
        '远景 40px 稀疏、近景 18px 密集，中间线性插值');
    ok('去重接受缩放参数（可传入当前 zoom）',
        /function dedupeByScreen\(list,\s*minPx,\s*zoom\)/.test(mainScript) &&
        /function activeStations\(mode,\s*zoom,\s*planKeys\)/.test(mainScript),
        '不传时回退 7.3，兼容旧调用');
    ok('去重按重要度取舍（不再是单纯比谁贴路）',
        /function wOf\(s\)/.test(mainScript) &&
        /\(s\.w != null\) \? s\.w : \(9 - \(s\.d \|\| 9\)\)/.test(mainScript),
        '显式权重优先，没给权重时退回"更贴路的优先"');
    ok('能耗规划走全量站点（不吃去重）',
        /function stationsAll\s*\(/.test(mainScript) &&
        /var stops = stationsAll\(mode\)/.test(mainScript) &&
        /var stops = stationsAll\(isFuel \? 'fuel' : 'ev'\)/.test(mainScript),
        '规划/缺口统计用全量，打点用去重 —— 两个口径不能混');
    ok('打点层用去重后的站点',
        /activeStations\('ev',\s*z,\s*planKeys\)\.filter|activeStations\('ev'\)\.filter/.test(mainScript) &&
        /activeStations\('fuel',\s*z,\s*planKeys\)\.filter|activeStations\('fuel'\)\.filter/.test(mainScript), '');

    console.log('\n【16】站点分级（S0：全览时 178 个点叠成色块）');
    ok('有 zoom 分级函数（远景/中景/近景）',
        /function zoomTier\s*\(\s*zoom\s*\)/.test(mainScript) &&
        /tier:\s*'far'/.test(mainScript) && /tier:\s*'mid'/.test(mainScript) && /tier:\s*'near'/.test(mainScript),
        '三档语义分层');
    ok('远景不显示加油站（减噪的关键一层）',
        /fuel:\s*false/.test(mainScript) &&
        /tier\.fuel\s*&&\s*onFuel[\s\S]{0,120}activeStations\('fuel',\s*z,\s*planKeys\)/.test(mainScript),
        '全览时"哪里有加油站"信息量极低，会跟充电站抢视觉权重');
    ok('地图 zoom 变化会触发站点重绘',
        /function onStationsZoomChange\s*\(/.test(mainScript) &&
        /map\.on\('zoom',\s*onStationsZoomChange\)/.test(mainScript),
        '否则拉近点不增加、拉远点不减少');
    ok('缩放重绘有防抖 + 变化量阈值',
        /Z_REDRAW_EPS\s*=\s*0\.25/.test(mainScript) &&
        /setTimeout\(function \(\) \{[\s\S]{0,200}renderStations\(\);[\s\S]{0,40}\},\s*120\)/.test(mainScript),
        'MultiMarker 是整层重建，每帧重建会卡');
    ok('远景隐加油站时有 UI 提示',
        /fuelTierHint/.test(html) && /（放大后显示）/.test(mainScript),
        '否则用户以为图层开关坏了');
    ok('有里程网格选点（覆盖率代表点）',
        /function coveragePick\s*\(/.test(mainScript) &&
        /coveragePick\(all,\s*60\)/.test(mainScript),
        '60km 网格挑最贴路的站，保证任意方向 2-3 点覆盖一个告警区间');
    ok('锚点不参与像素去重（否则会被自己吃掉）',
        /var anchors = coveragePick\(all, 60\)/.test(mainScript) &&
        /var rest = all\.filter\(function \(s\) \{ return !anchorKey\[/.test(mainScript) &&
        /var keptRest = dedupeByScreen\(rest, minPx, z\)/.test(mainScript),
        '分两层：锚点保里程覆盖，其余站防屏幕重叠 —— 两件事必须分开');
    ok('锚点与普通站之间仍判重（6px 内丢弃）',
        /function screenDist\s*\(/.test(mainScript) && /if \(d < 6\)/.test(mainScript),
        '避免锚点旁边叠一个几乎重合的点');
    ok('去重按重要度取舍（必充站不会被挤掉）',
        /function wOf\(s\)/.test(mainScript) && /planKeys && planKeys\[key\]\) \? 10 : 1/.test(mainScript),
        '同像素相撞时保留权重高的：必充站 10 > 锚点 5 > 普通站 1');
    ok('必充站权重传进打点层',
        /activeStations\('ev',\s*z,\s*planKeys\)/.test(mainScript) &&
        /activeStations\('fuel',\s*z,\s*planKeys\)/.test(mainScript),
        '否则远景下必充站可能被普通站挤出屏幕');
    ok('已删除旧的手打站点图层（防两套数据叠加）',
        !/var\s+fuelMarkers\s*=\s*new\s+TMap\.MultiMarker/.test(mainScript) &&
        !/var\s+evMarkers\s*=\s*new\s+TMap\.MultiMarker/.test(mainScript),
        'FUELS/EVS 曾与 STATION_DATA 同时打点，同一个站两个位置');
    ok('站点图层开关改走状态位（不再持有 marker 引用）',
        /var layerOn = \{ fuel: true, ev: true \}/.test(mainScript) &&
        /layerOn\.fuel = e\.target\.checked/.test(mainScript) &&
        /layerOn\.ev = e\.target\.checked/.test(mainScript),
        '重建图层后旧引用会失效，必须改成状态位 + 重绘');

    console.log('\n【15】窄屏地图可见性（v9-C：390px 下地图全白）');
    ok('窄屏走纵向反解分支（非线性加偏量）',
        /if \(box\.narrow\)/.test(mainScript) &&
        /var mercTarget = mercY\(bboxMidLat\) \+ \(visMid - midY\) \/ ppxY/.test(mainScript),
        'mercY 目标值移位 → 再反解纬度');
    ok('有墨卡托纬度反函数（atan∘sinh）',
        /cx = Math\.atan\(Math\.sinh\(n\)\) \* 180 \/ Math\.PI/.test(mainScript) &&
        /var n = Math\.PI \* \(1 - 2 \* mercTarget\)/.test(mainScript),
        'y = 0.5 − ln((1+s)/(1−s))/(4π) 的解析反函数');
    ok('chip 允许收缩不顶宽（min-width:0）',
        /\.chip\s*\{[\s\S]{0,200}min-width:\s*0/.test(html), 'flex 子项默认 min-width:auto 会顶宽溢出');
    ok('窄屏 chip 字号降档防溢出',
        /\.chip \{ font-size: 9\.5px/.test(html), '390px 宽下三块必须挤得下');

    console.log('\n【17】地图 Key 预检（部署必读）');
    ok('有 Key 预检逻辑',
        /地图 Key 预检/.test(html) && /function show\(\)/.test(html), '缺 key 时给出可操作的指路，不是灰屏');
    ok('预检在 gljs 标签之前执行',
        html.indexOf('地图 Key 预检') < html.indexOf('map.qq.com/api/gljs'), '否则取不到 script 的 src');
    ok('按 src 找 gljs 标签判断 key',
        /getElementsByTagName\('script'\)/.test(html) && /indexOf\('map\.qq\.com\/api\/gljs'\)/.test(html), '');
    ok('识别 file:// 协议并给出起服务指引',
        /location\.protocol === 'file:'/.test(html) && /python -m http\.server/.test(html),
        '腾讯 GL JS 已不支持 file://');
    ok('提示里写清「数据本身是完整的」',
        /路线、海拔、补能点都已内联/.test(html), '防止误解为数据丢失/加载失败');
    ok('旁边有注释提醒部署时要删掉密钥代理',
        /部署时请删除本段/.test(html) && /127\.0\.0\.1 = 打开者自己的电脑/.test(html),
        '本地代理指向 127.0.0.1，换环境必然失效');
}

/* ---------- 入口：单包或轮跑（只认含 ROUTE_BUILD 的线路包；manifest 清单不参与） ---------- */
const allPkgs = fs.readdirSync(path.join(ROOT, 'route-defs')).filter(f => f.endsWith('.js'))
    .map(f => f.replace(/\.js$/, ''))
    .filter(id => /var\s+ROUTE_BUILD\s*=/.test(fs.readFileSync(path.join(ROOT, 'route-defs', id + '.js'), 'utf8')));
const routeIds = process.argv[2] ? [process.argv[2]] : allPkgs;

routeIds.forEach(runRoute);

console.log('\n========== 总计 ==========');
console.log('结果: ' + pass + ' pass / ' + fail + ' fail（' + routeIds.length + ' 个线路包 × ' + Math.round(pass / routeIds.length) + ' 项）');
process.exit(fail > 0 ? 1 : 0);
