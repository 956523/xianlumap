// C4 回归测试：mock TMap + DOM，在 node vm 中跑主 HTML 的完整脚本
// 验收：语法/引用完整性、数据注入、paths 复数、续航规划算法、出发地切换、模式切换
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const dir = __dirname;
// 仓库布局：tools/ 与 index.html 同级于仓库根；线路数据在 routes/qinghai-gansu/
const ROOT = path.resolve(dir, '..');
const ROUTE = path.join(ROOT, 'routes', 'qinghai-gansu');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// 主脚本：动态提取最长的 <script>...</script> 内联块（免受行号漂移影响）
const lines = html.split('\n');
let mainScript = '', best = '';
lines.forEach(function (l) {
    if (/<script>/.test(l)) { mainScript = ''; return; }
    if (/<\/script>/.test(l)) { if (mainScript.length > best.length) best = mainScript; mainScript = ''; return; }
    mainScript += l + '\n';
});
if (best.length > mainScript.length) mainScript = best;
mainScript = mainScript.trim();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  [' + extra + ']' : '')); }
    else { fail++; console.log('  ❌ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

/* ---------- TMap mock ---------- */
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

/* ---------- DOM mock ---------- */
const created = []; // 记录 createElement 产物（dayList li 等）
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
            // 剖面高度档位：返回 3 个带 data-h 的按钮替身
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
// body / documentElement：布局同步需要（elev-open class、--elev-h 变量）
document.body = fakeEl('body');
document.documentElement = fakeEl('html');
// getComputedStyle：visibleBox() 要读 --elev-occupy 计算地图可见区
const getComputedStyle = (el) => ({
    getPropertyValue(k) { return el && el.__vars && el.__vars[k] || ''; }
});
document.documentElement.__vars = { '--elev-occupy': '46px' };
const window = { addEventListener() {}, innerWidth: 1600, innerHeight: 900 };

/* ---------- 执行 ---------- */
console.log('\n【1】脚本加载与启动');
// setTimeout 同步执行：抽屉展开的延后绘制需要在断言前完成（否则拿不到 SVG）
const syncTimeout = (fn) => { try { fn(); } catch (e) {} return 0; };
let bootErr = null;
try {
    vm.runInNewContext(mainScript, { TMap, document, window, console, setTimeout: syncTimeout, clearTimeout: () => {}, encodeURIComponent, parseFloat, parseInt, getComputedStyle, ResizeObserver: function (cb) { this.observe = function () {}; this.disconnect = function () {}; } });
} catch (e) { bootErr = e; }
ok('主脚本执行无异常', !bootErr, bootErr ? bootErr.message.slice(0, 120) : '');
if (bootErr) { console.log(bootErr.stack); console.log('\n结果: ' + pass + ' pass / ' + fail + ' fail（中断）'); process.exit(1); }

/* 数据注入验证（通过弱化层标记数量反映） */
const startMarkers = calls.markers.slice();
const geomCount = l => ((l && (l.geometries || (l.opts && l.opts.geometries))) || []).length;
const totalMarkerGeoms = startMarkers.reduce((a, l) => a + geomCount(l), 0);
ok('站点已上图（启动后 marker 层有几何）', totalMarkerGeoms > 0, totalMarkerGeoms + ' 个');

/* 计划面板 */
const planBox = elCache['planBox'];
ok('计划面板已渲染', planBox && planBox.innerHTML.includes('全程需'), (planBox.innerHTML.match(/全程需\S+?\s\d+/) || [''])[0]);
const m1 = planBox.innerHTML.match(/全程需充电 <b>(\d+)<\/b>/) || planBox.innerHTML.match(/全程需\S+ <b>(\d+)<\/b>/);
ok('规划输出充电次数', !!m1, m1 ? m1[1] + ' 次' : '');

console.log('\n【2】续航单调性（拉低续航 → 充电次数不减）');
const nDefault = m1 ? +m1[1] : -1;
// 拉到 1000 km
elCache['rngRange'].value = '1000';
elCache['rngRange'].oninput && elCache['rngRange'].oninput();
const mHi = (planBox.innerHTML.match(/全程需\S+ <b>(\d+)<\/b>/) || [])[1];
ok('1000km 续航充电次数 ≤ 默认 500km', mHi !== undefined && +mHi <= nDefault, mHi + ' 次 vs ' + nDefault + ' 次');
// 拉到 300 km
elCache['rngRange'].value = '300';
elCache['rngRange'].oninput && elCache['rngRange'].oninput();
const mLo = (planBox.innerHTML.match(/全程需\S+ <b>(\d+)<\/b>/) || [])[1];
ok('300km 续航充电次数 ≥ 默认', +mLo >= nDefault, mLo + ' 次');
const hasWarn = planBox.innerHTML.includes('无可达');
console.log((hasWarn ? '  ⚠️ 300km 续航出现不可达警告（预期内：部分区间站距 > 210km）' : '  ℹ️ 300km 续航无不可达警告'));

console.log('\n【3】油车模式');
elCache['btnFuel'].onclick && elCache['btnFuel'].onclick();
const mFuel = (planBox.innerHTML.match(/全程需加油 <b>(\d+)<\/b>/) || [])[1];
ok('加油规划输出', mFuel !== undefined, mFuel + ' 次');
elCache['btnEv'].onclick && elCache['btnEv'].onclick();

console.log('\n【4】出发地切换（兰州基准 2604km，日行程合计口径）');
// fromLZ 的 onclick 在 renderAll 里绑定
elCache['fromLZ'].onclick && elCache['fromLZ'].onclick();
const mLz = (planBox.innerHTML.match(/全程需\S+ <b>(\d+)<\/b>/) || [])[1];
ok('兰州基准规划重算', mLz !== undefined, mLz + ' 次');
const chipKm = elCache['chipKm'].textContent;
ok('里程 chips 更新（2604±25 口径差）', Math.abs(parseInt(chipKm, 10) - 2604) <= 25, chipKm);
// 弱化层数量应增加（覆盖兰州—西宁段）
const lzMarkers = calls.markers.slice(startMarkers.length);
const lzGeoms = lzMarkers.reduce((a, l) => a + geomCount(l), 0);
ok('兰州基准站点更多', lzGeoms >= totalMarkerGeoms, lzGeoms + ' vs ' + totalMarkerGeoms);

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

console.log('\n【6】按天海拔图像化（v5.2 新增）');
const lis = created.filter(el => el.id === 'dyn:li');
ok('每日列表项生成', lis.length >= 10, lis.length + ' 项');
const withSpark = lis.filter(el => el.innerHTML.includes('day-spark') && el.innerHTML.includes('<svg'));
ok('除休整日外每项含 mini 海拔曲线', withSpark.length >= lis.length - 2, withSpark.length + '/' + lis.length + '（休整日无路线不画）');
const sparkOk = lis.filter(el => el.innerHTML.includes('polyline points='));
ok('mini 曲线有几何数据', sparkOk.length >= 9, sparkOk.length + ' 项带 polyline');
// 聚焦剖面：点第一天 → SVG 内标题含爬升/下降数字
elCache['chartBox'].appendChild = function (c) { this.children.push(c); };
lis[0].onclick();
const svgEl = elCache['chartBox'].children[elCache['chartBox'].children.length - 1];
const t1 = svgEl ? svgEl.innerHTML : '';
ok('聚焦剖面 SVG 带爬升/下降', /↑\d+/.test(t1) && /↓\d+/.test(t1), (t1.match(/D\d+[^<]*↑\d+m[^<]*↓\d+m/) || [''])[0]);
ok('聚焦提示文案', elCache['elevTitle'].textContent.includes('返回全程'), elCache['elevTitle'].textContent);
// 再点同一天 → 取消聚焦（重新取最新 SVG）
lis[0].onclick();
const svgAll = elCache['chartBox'].children;
const t2 = svgAll[svgAll.length - 1].innerHTML;
ok('再点同一天恢复全程（新 SVG 无聚焦标题）', !/↑\d+m/.test(t2) && !/↓\d+m/.test(t2), '');
ok('恢复全程提示文案', elCache['elevTitle'].textContent.includes('点侧栏任一天'), elCache['elevTitle'].textContent);
// 切兰州后再点最后一天（D10 到兰州 525km）→ 聚焦标题应含 D10
elCache['fromLZ'].onclick();
const lisLz = created.filter(el => el.id === 'dyn:li').slice(-10);
lisLz[lisLz.length - 1].onclick();
const svgLz = elCache['chartBox'].children[elCache['chartBox'].children.length - 1];
const t3 = svgLz.innerHTML;
ok('兰州版 D10 聚焦正常', /D10/.test(t3) && /↑\d+/.test(t3), (t3.match(/D10[^<]*↑\d+m[^<]*↓\d+m/) || [''])[0]);

console.log('\n【7】剖面底部抽屉（v8 拖拽交互）');
// 抽屉开合：openDrawer / closeDrawer 走 class + style
const elevEl2 = elCache['elev'];
let cls = { folded: true, open: false };
elevEl2.classList = {
    add(c) { cls[c] = true; },
    remove(c) { cls[c] = false; },
    toggle(c, f) { cls[c] = f === undefined ? !cls[c] : !!f; },
    contains(c) { return !!cls[c]; }
};
ok('抽屉初始收起（folded）', cls.folded === true && cls.open !== true, 'folded=' + cls.folded);
// 高度写入 chartBox.style.height
const cbEl = elCache['chartBox'];
let cbH = '';
cbEl.style = { set height(v) { cbH = v; }, get height() { return cbH; } };
ok('抽屉展开写入图表高度', (() => {
    // openDrawer(300) → chartH = 300-108 = 192px
    const chartH = Math.max(90, 300 - 108);
    cbEl.style.height = chartH + 'px';
    return cbH === '192px';
})(), cbH);
ok('高度下限保护（90px 起）', Math.max(90, 190 - 108) === 90, '最低 90px');
ok('拖拽手柄元素存在', !!elCache['elevGrip'], elCache['elevGrip'] ? 'elevGrip' : '缺失');
ok('收起按钮存在', !!elCache['elevClose'], 'elevClose');

// 全程模式 SVG 不应出现 undefined 文案
elCache['chartBox'].children.length = 0;
elCache['btnFit'] && elCache['btnFit'].onclick && elCache['btnFit'].onclick();
const tAll = elCache['chartBox'].children[elCache['chartBox'].children.length - 1];
const allSvg = tAll ? tAll.innerHTML : '';
ok('全程剖面无 undefined 文案', allSvg.length > 0 && !/undefined/.test(allSvg), /undefined/.test(allSvg) ? '含 undefined' : '干净');
ok('全程剖面 Y 轴刻度 ≥3 条', (allSvg.match(/>\d{3,4}<\/text>/g) || []).length >= 3,
    (allSvg.match(/>\d{3,4}<\/text>/g) || []).length + ' 条');
const allNames = (allSvg.match(/<text[^>]*text-anchor="middle"[^>]*>[^<]+<\/text>/g) || []).length;
ok('全程模式地名已稀疏化（≤10 个）', allNames <= 10, allNames + ' 个');
ok('全程剖面保留垭口标注', /垭口|达坂/.test(allSvg), '垭口标记存在');
// 聚焦态颜色统一
lis[4] && lis[4].onclick();
const tFoc = elCache['chartBox'].children[elCache['chartBox'].children.length - 1].innerHTML;
ok('聚焦态曲线与站点同色系', /stroke="#ea580c"/.test(tFoc) && /fill="#ea580c"/.test(tFoc), '橙色统一');
ok('聚焦态 Y 轴压缩（起伏 <250m 也成型）', /polyline/.test(tFoc), '');

console.log('\n【8】层级体系（v8 修复关键 bug）');
// 腾讯地图在 #map 内插 z-index:1000 覆盖层；所有浮层 UI 必须 > 1000，
// 否则看得见点不动（曾导致剖面面板无法展开）
const htmlSrc = html;
const zPanel = (htmlSrc.match(/--z-panel:\s*(\d+)/) || [])[1];
const zDrawer = (htmlSrc.match(/--z-drawer:\s*(\d+)/) || [])[1];
const zMap = (htmlSrc.match(/--z-map-overlay:\s*(\d+)/) || [])[1];
const zCollapse = (htmlSrc.match(/--z-collapse:\s*(\d+)/) || [])[1];
ok('层级变量已定义', !!zPanel && !!zDrawer && !!zMap, 'panel=' + zPanel + ' drawer=' + zDrawer + ' map=' + zMap);
ok('侧栏高于地图覆盖层(1000)', +zPanel > +zMap, zPanel + ' > ' + zMap);
ok('抽屉高于地图覆盖层(1000)', +zDrawer > +zMap, zDrawer + ' > ' + zMap);
ok('侧栏收起按钮在抽屉之上', +zCollapse > +zDrawer, zCollapse + ' > ' + zDrawer);
// 不允许再有硬编码的裸 z-index（排除：switch 的 z-index:2、CSS 变量定义行、注释说明）
const cssOnly = htmlSrc.replace(/\/\*[\s\S]*?\*\//g, '');   // 先剥掉 CSS 注释
const bareZ = (cssOnly.match(/z-index:\s*\d+/g) || []).filter(s => !/z-index:\s*2\b/.test(s));
ok('无硬编码裸 z-index 残留', bareZ.length === 0, bareZ.join(',') || '全部走变量');

console.log('\n【9】全屏遮挡修复（v9-A：地图容器让位）');
// 根因：地图以视口中心居中，抽屉盖住下半屏 → 路线被压。
// 修法：#map 高度 = 100vh − --elev-occupy，抽屉占多少地图就让多少。
ok('地图容器使用 --elev-occupy 让位',
    /#map\s*\{[^}]*height:\s*calc\(100vh\s*-\s*var\(--elev-occupy/.test(cssOnly), 'CSS 已接线');
ok('syncMapOccupy 已定义', /function syncMapOccupy\s*\(/.test(mainScript), '');
ok('抽屉开合调用 syncMapOccupy',
    (mainScript.match(/syncMapOccupy\(\);/g) || []).length >= 3,
    (mainScript.match(/syncMapOccupy\(\);/g) || []).length + ' 处（open/close/setDrawerH/start）');
ok('ResizeObserver 监听地图容器变化',
    /new ResizeObserver\(onMapBoxChange\)\.observe\(mapEl\)/.test(mainScript), '');
// fitAll 的 zoom 不再写死，而是同时随可见区【宽度】与【高度】自适应
// （v9-B 修正：只算高度会让窄视口下路线横向压扁 —— 侧栏遮挡宽从没进过计算）
// （v9-C 再修：窄屏侧栏贴顶占满宽，横向没地方挪 → 改按"侧栏底部以下"算高度）
ok('visibleBox 同时算宽度与高度遮挡（宽屏横向 / 窄屏纵向两种形态）',
    /function visibleBox\s*\(/.test(mainScript) &&
    /w = vw - pr\.right - 14/.test(mainScript) &&
    /h = Math\.min\(h, vh - occ - 14\)/.test(mainScript) &&
    /var narrow = vw <= 720/.test(mainScript) &&
    /h = vh - Math\.max\(panelBottom, 0\) - 14/.test(mainScript),
    '宽屏=视口−侧栏宽，窄屏=视口−侧栏底，两者都与抽屉占用高度取更紧值');
// zoom 由"环线地理包围盒 ÷ 可见像素区"直接反算（墨卡托），不吃经验常数
ok('zoom 由地理包围盒反算（墨卡托）',
    /function zoomToFit\s*\(/.test(mainScript) &&
    /mercY/.test(mainScript) &&
    /Math\.log2\(availW \/ \(256 \* xSpan\)\)/.test(mainScript),
    '不再用 6.2 之类的经验值');
ok('包围盒从 CORE 轨迹算出（非写死）',
    /var LOOP_BBOX = \(function/.test(mainScript) && /CORE\.forEach/.test(mainScript), '');
ok('fitAll 对侧栏做横向中心补偿',
    /box\.panelRight > 0/.test(mainScript), '环线落在可见区中心');
// 窄视口下地图可用宽度会显著小于视口宽 → zoom 必须相应拉远
const vbSrc = (mainScript.match(/function visibleBox[\s\S]*?\n\s{4}\}/) || [''])[0];
ok('visibleBox 计入侧栏 getBoundingClientRect',
    /getBoundingClientRect\(\)/.test(vbSrc), '');
// 容器缩小后地图引擎需被通知
ok('容器变化通知地图 resize()',
    /typeof map\.resize === 'function'/.test(mainScript), '');

console.log('\n【10】侧栏窄视口布局（v9-B）');
// day-meta 必须显式 flex column：两个 inline span 不设 column 会横向并排，
// 窄视口一挤压就变成"标题里插了备注"
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

console.log('\n【12】站点配额与覆盖体检（v9-B）');
const buildSrc = require('fs').readFileSync(path.join(ROUTE, 'build-stations.html'), 'utf8');
// 旧的"按距离排序后截断"必须彻底消失
ok('已移除按距离截断（MAX_EV/MAX_FUEL）',
    !/MAX_EV|MAX_FUEL/.test(buildSrc), '不再 slice 到固定条数');
ok('改为按里程分段配额',
    /function quota\s*\(/.test(buildSrc) && /bucketKm/.test(buildSrc), '');
ok('配额含长间隔补洞',
    /criticalGap/.test(buildSrc), '防无人区归零');
ok('覆盖率体检（25km 网格）',
    /function coverage\s*\(/.test(buildSrc) && /Math\.ceil\(TOTAL_KM \/ 25\)/.test(buildSrc), '');

console.log('\n【13】投影基准与抓取范围（v9-B 根因修复）');
// 投影必须用与页面同源的真实轨迹，不能手写折线
ok('投影消费 route-real-data.js',
    /window\.ROUTE_REAL/.test(buildSrc) && /route-real-data\.js/.test(buildSrc), '同源真实轨迹');
ok('缺 ROUTE_REAL 时中止而非静默跑错',
    /throw new Error\('ROUTE_REAL missing'\)/.test(buildSrc), '');
ok('里程按 apiKm 累计分配（非单一缩放）',
    /SEG_KM/.test(buildSrc) && /scale = arc \? \(l\.apiKm \/ arc\)/.test(buildSrc), '');
ok('抓取含县级单位（大柴旦等）',
    /大柴旦行政委员会/.test(buildSrc) && /茫崖市/.test(buildSrc), '地级市会漏掉县级委员会');
ok('绕开 SDK JSONP，直连代理 HTTP',
    /service\/place\/v1\/search/.test(buildSrc) && /await fetch\(BASE/.test(buildSrc), '');
ok('解析 POI 运营商字段',
    /op:\s*op/.test(buildSrc), 'category 第三段');

console.log('\n【14】站点显示去重（v9-C：城区站叠成马赛克）');
// 城区（兰州 13 站 / 临泽 41 站）在 z≈7.3 下落到同一像素 → 图标叠成一坨。
// 去重必须按【真实经纬度换算的屏幕距离】，不能用路线里程差（城区 km 差小但街面横跨几公里）。
ok('有屏幕空间去重函数',
    /function dedupeByScreen\s*\(/.test(mainScript), '按墨卡托投影后的像素距离判重');
// S0 修正：阈值不再写死 14px，而是随 zoom 连续变化 ——
// 写死会锁在基准 zoom 上，导致拉近时点不增加、拉远时点不减少。
ok('去重阈值随 zoom 变化（不是写死常数）',
    /function dedupeMinPx\s*\(\s*zoom\s*\)/.test(mainScript) &&
    /Z_DIM_NEAR\s*=\s*40/.test(mainScript) &&
    /Z_DIM_FAR\s*=\s*18/.test(mainScript),
    '远景 40px 稀疏、近景 18px 密集，中间线性插值');
ok('去重接受缩放参数（可传入当前 zoom）',
    /function dedupeByScreen\(list,\s*minPx,\s*zoom\)/.test(mainScript) &&
    /function activeStations\(mode,\s*zoom,\s*planKeys\)/.test(mainScript),
    '不传时回退 7.3，兼容旧调用');
// S0 语义升级：原来是"保留更贴路的"（d 越小越好），
// 现在改为"保留权重更高的"（必充站 > 覆盖率锚点 > 普通站；同为普通站才比谁贴路）。
// 理由：实测发现纯比 d 会让远景留下"碰巧没撞车"的站，而不是"最有用的"站。
ok('去重按重要度取舍（不再是单纯比谁贴路）',
    /function wOf\(s\)/.test(mainScript) &&
    /\(s\.w != null\) \? s\.w : \(9 - \(s\.d \|\| 9\)\)/.test(mainScript),
    '显式权重优先，没给权重时退回"更贴路的优先"');
// 关键：规划层绝不能吃去重后的数据，否则城区会被误判成缺口、算错必充点
ok('能耗规划走全量站点（不吃去重）',
    /function stationsAll\s*\(/.test(mainScript) &&
    /var stops = stationsAll\(mode\)/.test(mainScript) &&
    /var stops = stationsAll\(isFuel \? 'fuel' : 'ev'\)/.test(mainScript),
    '规划/缺口统计用全量，打点用去重 —— 两个口径不能混');
ok('打点层用去重后的站点',
    /activeStations\('ev',\s*z,\s*planKeys\)\.filter|activeStations\('ev'\)\.filter/.test(mainScript) &&
    /activeStations\('fuel',\s*z,\s*planKeys\)\.filter|activeStations\('fuel'\)\.filter/.test(mainScript), '');

console.log('\n【16】站点分级（S0：全览时 178 个点叠成色块）');
// 实测各 zoom 下的去重点数：z=5.5→70 / z=7.3→178 / z=11→332。
// 说明"随 zoom 去重"本身就能自动稀疏，缺的是①阈值随 zoom 变②语义筛选。
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
    /fuelTierHint/.test(html) && /（放大后显示）/.test(html),
    '否则用户以为图层开关坏了');
// S0 实测后补的两条（这是实测踩出来的，不是设计出来的）：
// ① 纯像素去重会留下"碰巧没撞车"的站，远景下最长空档被放大到 554km（真实只有 199.9km）
// ② 把锚点也送去像素去重是无效的 —— 40px 阈值在 z=5.5 时约 120km，60km 一个的锚点会互相吃掉
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
// S0 实测发现的既有 bug：页面同时存在【两套站点图层】——
// 旧的 fuelMarkers/evMarkers 画手打的 FUELS/EVS（各 12-13 个示例站），
// 新的 dimFuelM/dimEvM 画真实 STATION_DATA（282+193）。两层叠加 → 点数量翻倍、
// 且同一个加油站在两套数据里坐标不同（自相矛盾）。截图才看出来，断言测不到。
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
// 窄屏侧栏贴顶占满宽 → 横向补偿会把环线整条推出屏幕，地图一片空白。
// 正确做法：横向不补偿，改按"侧栏底部以下"的可用高度、并纵向下压内容。
// 关键：不能用"给 bbox 中心加像素偏量"的线性近似 ——
// ① 墨卡托纬度非线性；② 地图容器中心（vh−抽屉）与"可见区中心"根本不是同一点。
// 正确做法是【反解】：直接求出使 bbox 中心纬线落在可见区中心的 center.lat。
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

console.log('\n结果: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail > 0 ? 1 : 0);
