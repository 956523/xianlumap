/* ============================================================================
 * engine/profile.js — 海拔剖面（底部抽屉）
 *
 * 平台化 S2 从 index.html 主脚本拆分而来（纯搬家 + 消硬编码，逻辑未重写）：
 *   - 海拔序列的出发地平移收进数据契约 ROUTE_STARTS（offsetKm/head），
 *     引擎不再写死任何接入端点名
 * 依赖：route-engine.js / planner.js 先加载；ui.js 后加载（启动序列在 ui.js）。
 * ========================================================================== */

    /* ============ 海拔剖面（底部抽屉） ============ */
    var tipEl = document.getElementById('elevTip');
    var foldHint = document.getElementById('elevFoldHint');
    var elevEl = document.getElementById('elev');
    var gripEl = document.getElementById('elevGrip');

    var PEEK = 46;          // 收起时露出的高度（手柄 + 标题一行）
    var DRAWER_MIN = 190;   // 展开最小高度
    var DRAWER_MAX = 520;   // 展开最大高度（别把地图全糊住）
    var drawerH = 300;      // 当前展开高度

    function drawerMax() {
        return Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, window.innerHeight - 150));
    }

    function setDrawerH(h) {
        drawerH = Math.max(DRAWER_MIN, Math.min(drawerMax(), Math.round(h)));
        // 图表高度 = 抽屉高度 − 手柄/标题/内边距等固定开销
        var chartH = Math.max(90, drawerH - 108);
        var cb = document.getElementById('chartBox');
        if (cb && cb.style) cb.style.height = chartH + 'px';
        document.documentElement.style.setProperty('--drawer-h', drawerH + 'px');
        syncMapOccupy();
    }

    /* 把抽屉实际占用的高度写进 --elev-occupy，地图容器据此让位。
       收起态只露 peek，让位量就是 peek；展开态让位量是抽屉实际高度。 */
    function syncMapOccupy() {
        var occupy = isOpen() ? drawerH : PEEK;
        document.documentElement.style.setProperty('--elev-occupy', occupy + 'px');
    }

    function isOpen() { return elevEl.classList.contains('open'); }

    function openDrawer(h) {
        setDrawerH(h || drawerH);
        elevEl.classList.remove('folded');
        elevEl.classList.add('open');
        foldHint.textContent = '向下拖到底收起';
        syncMapOccupy();
        // S14 移动端：剖面是第二张底部表，打开时把行程单抽屉压出屏外（互斥）
        if (document.body && document.body.classList) document.body.classList.add('mob-elev');
        // 等过渡走完再画，避免量到中间态尺寸
        setTimeout(function () { drawProfile(); }, 280);
    }

    function closeDrawer() {
        elevEl.classList.remove('open');
        elevEl.classList.add('folded');
        foldHint.textContent = '拖动或点击标题展开';
        tipEl.style.display = 'none';
        syncMapOccupy();
        if (document.body && document.body.classList) document.body.classList.remove('mob-elev');
    }

    function toggleDrawer() { isOpen() ? closeDrawer() : openDrawer(); }

    /* --- 拖拽手柄：调高度，下拖到底收起（地图软件抽屉惯例） --- */
    var drag = null;
    function onGripDown(e) {
        var pt = e.touches ? e.touches[0] : e;
        drag = { y0: pt.clientY, h0: isOpen() ? drawerH : PEEK, moved: false, wasOpen: isOpen() };
        elevEl.classList.add('dragging');
        e.preventDefault();
    }
    function onGripMove(e) {
        if (!drag) return;
        var pt = e.touches ? e.touches[0] : e;
        var dy = drag.y0 - pt.clientY;   // 上拖为正
        if (Math.abs(dy) > 3) drag.moved = true;
        var h = drag.h0 + dy;
        if (h < DRAWER_MIN - 30) {       // 拖到下限以下 → 预览收起
            if (isOpen()) closeDrawer();
            return;
        }
        if (!isOpen()) openDrawer(h);
        else setDrawerH(h);
        elevEl.classList.remove('folded');
        elevEl.classList.add('open');
        // 拖拽中实时让地图跟进（禁用过渡，避免跟手迟滞）
        document.getElementById('map').style.transition = 'none';
        syncMapOccupy();
        drag.h = h;
    }
    function onGripUp() {
        if (!drag) return;
        elevEl.classList.remove('dragging');
        document.getElementById('map').style.transition = '';
        if (drag.moved) {
            if (isOpen()) { setDrawerH(drag.h || drawerH); drawProfile(); }
        } else {
            toggleDrawer();               // 没拖动 = 点击 → 开合
        }
        drag = null;
    }
    gripEl.addEventListener('mousedown', onGripDown);
    gripEl.addEventListener('touchstart', onGripDown, { passive: false });
    window.addEventListener('mousemove', onGripMove);
    window.addEventListener('touchmove', onGripMove, { passive: false });
    window.addEventListener('mouseup', onGripUp);
    window.addEventListener('touchend', onGripUp);

    // 标题文字点击也能开合；✕ 收起
    document.getElementById('elevToggle').addEventListener('click', toggleDrawer);
    document.getElementById('elevClose').addEventListener('click', closeDrawer);

    function altSeries() {
        // 返回当前出发地的海拔序列（深拷贝 + 平移）；
        // 带接入段的出发地（ROUTE_STARTS 契约 offsetKm/head）在两端拼上接入端点
        var s = ALT.map(function (p) { return { km: p.km, alt: p.alt, n: p.n, pass: p.pass, lowest: p.lowest }; });
        var cur = curStart();
        if (cur.offsetKm) {
            s.unshift({ km: 0, alt: cur.head.alt, n: cur.head.n });
            s.forEach(function (p) { p.km += cur.offsetKm; });
            s.push({ km: curTotal(), alt: cur.head.alt, n: cur.head.n }); // 返程终点 = 出发地
        }
        return s;
    }

    /* --- 按天切片：从序列中取 [a,b] 区间（端点插值），返回 {pts, up, down} --- */
    function altSlice(series, a, b) {
        function interp(km) {
            for (var i = 1; i < series.length; i++) {
                if (series[i].km >= km) {
                    var p0 = series[i - 1], p1 = series[i];
                    var t = p1.km === p0.km ? 0 : (km - p0.km) / (p1.km - p0.km);
                    return { km: km, alt: p0.alt + (p1.alt - p0.alt) * t, n: (t < 0.5 ? p0 : p1).n };
                }
            }
            return series[series.length - 1];
        }
        var seg = series.filter(function (p) { return p.km > a && p.km < b; });
        var pts = [interp(a)].concat(seg, [interp(b)]);
        var up = 0, down = 0;
        for (var i = 1; i < pts.length; i++) {
            var dAlt = pts[i].alt - pts[i - 1].alt;
            if (dAlt > 0) up += dAlt; else down -= dAlt;
        }
        return { pts: pts, up: Math.round(up), down: Math.round(down) };
    }

    /* --- 侧栏每日 mini 海拔曲线 --- */
    function sparkSVG(d) {
        if (!d.altKm || !d.km) return '<span class="day-spark"></span>';
        var sl = altSlice(altSeries(), d.altKm[0], d.altKm[1]);
        if (sl.pts.length < 2) return '<span class="day-spark"></span>';
        var W = 62, H = 24, P = 3;
        var minA = Infinity, maxA = -Infinity;
        sl.pts.forEach(function (p) { minA = Math.min(minA, p.alt); maxA = Math.max(maxA, p.alt); });
        if (maxA - minA < 60) { maxA += 30; minA -= 30; }
        var x0 = sl.pts[0].km, x1 = sl.pts[sl.pts.length - 1].km;
        function fx(km) { return P + (km - x0) / (x1 - x0) * (W - 2 * P); }
        function fy(alt) { return (H - P) - (alt - minA) / (maxA - minA) * (H - 2 * P); }
        var line = sl.pts.map(function (p) { return fx(p.km).toFixed(1) + ',' + fy(p.alt).toFixed(1); }).join(' ');
        var dots = '';
        altSeries().forEach(function (p) {
            if (p.pass && p.km >= x0 && p.km <= x1) {
                dots += '<circle cx="' + fx(p.km).toFixed(1) + '" cy="' + fy(p.alt).toFixed(1) + '" r="2.4" fill="#7c3aed" stroke="#fff" stroke-width="1"/>';
            }
        });
        return '<span class="day-spark" title="海拔 ' + minA + '–' + maxA + 'm · 爬升' + sl.up + 'm / 下降' + sl.down + 'm">' +
            '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
            '<polyline points="' + line + '" fill="none" stroke="' + (sl.down > sl.up * 2 ? '#0ea5e9' : '#0d9488') + '" stroke-width="1.8" stroke-linejoin="round"/>' +
            dots + '</svg></span>';
    }

    function drawProfile() {
        var box = document.getElementById('chartBox');
        var W = Math.max(box.clientWidth || 0, 420);
        /* 高度直接量取容器实际尺寸（抽屉拖拽时由 setDrawerH 写入 style.height） */
        var H = Math.max(90, box.clientHeight || 200);
        var L = 46, R = 14, T = 26, B = 22;
        var full = altSeries();
        var titleEl = document.getElementById('elevTitle');

        /* --- 聚焦模式：点选某天 → 只画该天区间，y 轴自适应 --- */
        var d = activeIdx >= 0 ? DAYS[activeIdx] : null;
        var focus = d && d.altKm && d.km;
        var series, aKm, bKm, focusTitle = '';
        if (focus) {
            aKm = d.altKm[0];
            bKm = d.altKm[1];
            var sl = altSlice(full, aKm, bKm);
            series = sl.pts;
            focusTitle = 'D' + d.id + ' ' + d.title + ' · <tspan fill="#dc2626">↑' + sl.up + 'm</tspan> <tspan fill="#0284c7">↓' + sl.down + 'm</tspan> · 再点该天返回全程';
        } else {
            series = full;
        }
        titleEl.textContent = focus ? '再点该天返回全程' : '点侧栏任一天，看该天海拔细节';
        var totalKm = series[series.length - 1].km - series[0].km || 1;
        function xF(km) { return L + (km - series[0].km) / totalKm * (W - L - R); }
        // y 轴：全程/聚焦都由数据自适应（不再硬切 4000，避免 4000m 以上被削平）
        var lo = Infinity, hiA = -Infinity;
        series.forEach(function (p) { lo = Math.min(lo, p.alt); hiA = Math.max(hiA, p.alt); });
        var pad = focus ? 130 : 170;
        var yMin = Math.max(0, Math.floor((lo - pad) / 250) * 250);
        var yMax = Math.ceil((hiA + pad) / 250) * 250;
        if (yMax - yMin < (focus ? 500 : 1000)) yMax = yMin + (focus ? 500 : 1000);
        // 起伏压缩：当天真实落差很小时（盆地内就几十米），
        // 用"最小可视落差"把 y 轴收紧，否则画出来是一条毫无信息的直线
        var span = hiA - lo;
        var minVisible = focus ? 220 : 800;
        if (span * 1.0 < minVisible) {
            var midA = (hiA + lo) / 2;
            yMin = Math.floor((midA - minVisible / 2) / 100) * 100;
            yMax = Math.ceil((midA + minVisible / 2) / 100) * 100;
            if (yMin < 0) yMin = 0;
        }
        var yTicks = [];
        var range = yMax - yMin;
        var step = range <= 400 ? 100 : (range <= 750 ? 250 : (range <= 1600 ? 500 : 1000));
        for (var tv = Math.ceil(yMin / step) * step; tv <= yMax; tv += step) yTicks.push(tv);
        function yF(alt) { return (H - B) - (alt - yMin) / (yMax - yMin) * (H - T - B); }
        var pts = series.map(function (p) { return [xF(p.km), yF(p.alt)]; });
        var line = pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
        var area = 'M' + pts[0][0].toFixed(1) + ',' + (H - B) + ' L' + line.split(' ').join(' L') + ' L' + pts[pts.length - 1][0].toFixed(1) + ',' + (H - B) + ' Z';
        // 网格与刻度
        var grid = '';
        yTicks.forEach(function (a) {
            grid += '<line x1="' + L + '" y1="' + yF(a) + '" x2="' + (W - R) + '" y2="' + yF(a) + '" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="4 4"/>' +
                '<text x="' + (L - 6) + '" y="' + (yF(a) + 4) + '" font-size="10" fill="#94a3b8" text-anchor="end">' + a + '</text>';
        });
        // 点与垭口标记
        // 全程模式：文字密集（几十个地名摊在 ~1000px 上），只保留"垭口/最高点"标注，其余靠 hover
        // 聚焦模式：点少、空间宽裕，全部标名
        var dots = '', labels = '', marks = [], occupied = -1e9;
        var LINE_C = focus ? '#ea580c' : '#0d9488';   // 曲线主色
        var DOT_C = focus ? '#ea580c' : '#0f766e';   // 普通站点色（跟随主题）
        series.forEach(function (p) {
            var x = xF(p.km), y = yF(p.alt);
            if (p.pass) {
                marks.push({ x: x, y: y, n: p.n, alt: p.alt, pass: true, km: p.km });
                dots += '<circle cx="' + x + '" cy="' + y + '" r="3.5" fill="#7c3aed" stroke="#fff" stroke-width="1.5"/>';
            } else {
                dots += '<circle cx="' + x + '" cy="' + y + '" r="3" fill="' + (p.lowest ? '#0ea5e9' : DOT_C) + '" stroke="#fff" stroke-width="1.5"/>';
                if (p.n) marks.push({ x: x, y: y, n: p.n, alt: p.alt, pass: false, km: p.km });
            }
        });
        var WID = 10.2; // 10px 中文字宽约 10.2px，用于避让估算
        marks.forEach(function (m) {
            var showText = focus || m.pass;
            if (!showText) return;
            if (m.x - occupied < 14) return; // 与上一个标签太近，跳过（宁缺毋滥）
            var tw = String(m.n).length * WID + 8;
            var tx = Math.min(Math.max(m.x, L + tw / 2), W - R - tw / 2);
            if (m.pass) {
                labels += '<path d="M' + m.x + ' ' + (m.y - 16) + ' l5 8 h-10 z" fill="#7c3aed"/>' +
                    '<text x="' + tx + '" y="' + (m.y - 20) + '" font-size="10" fill="#6d28d9" text-anchor="middle" font-weight="600">' + m.n + ' ' + m.alt + '</text>';
            } else {
                labels += '<text x="' + tx + '" y="' + (m.y + 14) + '" font-size="9.5" fill="#64748b" text-anchor="middle">' + m.n + '</text>';
            }
            occupied = m.x + tw / 2;
        });
        // 起终点（若端点占位比自动命名，用"起点/终点"兜底，避免出现 undefined）
        var nameA = series[0].n || '起点';
        var nameZ = series[series.length - 1].n || '终点';
        var ends = '<text x="' + pts[0][0] + '" y="' + (H - 8) + '" font-size="10" fill="#475569" text-anchor="start">' + nameA + '</text>' +
            '<text x="' + pts[pts.length - 1][0] + '" y="' + (H - 8) + '" font-size="10" fill="#475569" text-anchor="end">' + nameZ + '</text>';
        ends += focus
            ? '<text x="' + (W - R) + '" y="14" font-size="10" fill="#94a3b8" text-anchor="end">D' + d.id + ' 全天 ' + d.km + ' km</text>'
            : '<text x="' + (W - R) + '" y="14" font-size="10" fill="#94a3b8" text-anchor="end">全程约 ' + totalKm + ' km</text>';
        box.querySelector('svg') && box.querySelector('svg').remove();
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', W); svg.setAttribute('height', H);
        svg.innerHTML =
            '<defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="' + (focus ? '#f97316' : '#14b8a6') + '" stop-opacity=".32"/>' +
            '<stop offset="1" stop-color="' + (focus ? '#f97316' : '#14b8a6') + '" stop-opacity=".04"/></linearGradient></defs>' +
            grid +
            '<path d="' + area + '" fill="url(#eg)"/>' +
            '<polyline points="' + line + '" fill="none" stroke="' + LINE_C + '" stroke-width="' + (focus ? 3 : 2.5) + '" stroke-linejoin="round"/>' +
            dots + labels + ends +
            (focus ? '<text x="' + L + '" y="14" font-size="11.5" font-weight="600" fill="#c2410c">' + focusTitle + '</text>' : '');
        box.appendChild(svg);

        // hover（聚焦模式下显示"距当天起点"）
        svg.onmousemove = function (ev) {
            var rect = svg.getBoundingClientRect();
            var mx = ev.clientX - rect.left;
            var best = null, bd = 1e9;
            series.forEach(function (p) {
                var dd = Math.abs(xF(p.km) - mx);
                if (dd < bd) { bd = dd; best = p; }
            });
            if (best && bd < 60) {
                tipEl.style.display = 'block';
                var rel = focus ? '距当天起点 ' + Math.round(best.km - aKm) + ' km' : '距起点 ' + best.km + ' km';
                tipEl.innerHTML = '<b>' + best.n + '</b> · ' + best.alt + ' m<br>' + rel;
                var tx = xF(best.km), ty = yF(best.alt);
                tipEl.style.left = Math.min(tx + 10, W - 130) + 'px';
                tipEl.style.top = Math.max(ty - 48, 0) + 'px';
            } else {
                tipEl.style.display = 'none';
            }
        };
        svg.onmouseleave = function () { tipEl.style.display = 'none'; };
    }
    /* 地图容器尺寸变化后，必须通知地图引擎重算画布，否则会拉伸/偏移。
       抽屉开合、拖拽、窗口缩放都会触发。用 ResizeObserver 一网打尽。
       注意：ResizeObserver 只在 #map 【自身】尺寸变化时触发；#map 高度写的是
       calc(100vh - var(--elev-occupy))，侧栏高度变化不会改变它 → 这时不会触发，
       所以启动阶段必须自己补一次强制定尺（见 ui.js 启动段）。 */
    var mapResizeTimer = null;
    function onMapBoxChange() {
        // 腾讯 GL JS 提供 resize()；没有就用 setCenter 触发一次重绘
        if (typeof map.resize === 'function') { try { map.resize(); } catch (e) {} }
        // 容器变了，全览视角需要重算（防抖，避开动画中间态）
        if (mapResizeTimer) clearTimeout(mapResizeTimer);
        mapResizeTimer = setTimeout(function () {
            if (activeIdx < 0) fitAll(false);
        }, 320);
    }
    var mapEl = document.getElementById('map');
    if (window.ResizeObserver) {
        new ResizeObserver(onMapBoxChange).observe(mapEl);
    }

    window.addEventListener('resize', function () {
        if (isOpen()) { setDrawerH(drawerH); drawProfile(); }
    });
