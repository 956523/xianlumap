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
       收起态只露 peek，让位量就是 peek；展开态让位量是抽屉实际高度。
       S17：剖面把手改为「仅聚焦某天/手动展开时常显」——全览（body.elev-hide）时
       收起态让位量与露出的把手高度都归 0，不占布局。 */
    function syncMapOccupy() {
        var gripOn = !(document.body && document.body.classList && document.body.classList.contains('elev-hide'));
        var occupy = isOpen() ? drawerH : (gripOn ? PEEK : 0);
        var root = document.documentElement;
        if (root && root.style && typeof root.style.setProperty === 'function') {
            root.style.setProperty('--elev-occupy', occupy + 'px');
            root.style.setProperty('--elev-peek', gripOn ? (PEEK + 'px') : '0px');
        }
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

    /* --- 按天切片：从序列中取 [a,b] 区间（端点插值），返回 {pts, up, down} --- */    function altSlice(series, a, b) {
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

    /* --- Catmull-Rom → 三次贝塞尔平滑（S17：纯视觉插值，不改数据） ---
       曲线严格过所有采样点（CR 的固有性质），切线由相邻点估计。
       铁律：平滑不得越过真实尖峰制造假地形——单点尖峰被两侧控制点夹住过不去；
       数据侧的尖峰检测仍由 tools/validate V1 对原始数据负责，这里只管画。 */
    function smoothD(pts) {
        function f(v) { return (+v).toFixed(1); }
        if (!pts || pts.length < 3) {
            return 'M' + (pts || []).map(function (p) { return f(p[0]) + ',' + f(p[1]); }).join(' L');
        }
        var d = 'M' + f(pts[0][0]) + ',' + f(pts[0][1]);
        for (var i = 0; i < pts.length - 1; i++) {
            var p0 = pts[i - 1] || pts[i];
            var p1 = pts[i];
            var p2 = pts[i + 1];
            var p3 = pts[i + 2] || p2;
            d += ' C' + f(p1[0] + (p2[0] - p0[0]) / 6) + ',' + f(p1[1] + (p2[1] - p0[1]) / 6) +
                 ' ' + f(p2[0] - (p3[0] - p1[0]) / 6) + ',' + f(p2[1] - (p3[1] - p1[1]) / 6) +
                 ' ' + f(p2[0]) + ',' + f(p2[1]);
        }
        return d;
    }

    /* ============ S27/S28：剖面「天边界」拖把手（默认可用，无需任何模式） ============
       剖面可见的每个「天与天相接的里程边界」画可拖把手（全程模式 = 全部内边界；
       聚焦模式 = 该天左右两条边界——拖它就是在调这一天长短）；拖动中用 elevTip
       显示「D2 213km｜D3 159km」预览，松手走既有 Edit.setSeg 重切相邻两天
       （纯 overlay 即时生效，与终点下拉同一套守卫与持久化）。
       <1km 沿用既有守卫：minKm/maxKm 钳制（等价 makeBoundarySelect 的
       Math.max(v+1, other) 口径），不会切出不足 1km 的天。
       非主出发地视角分段只读（setSeg 同款守卫），不画把手、不给拖。 */
    var segDrag = null;        // {bi, km0, km, minKm, maxKm, el, clientX}
    var segPrevText = '';      // 拖动中的预览文案（测试接缝可读）
    var lastSegHandles = [];   // 最近一次 drawProfile 的把手表（测试接缝）

    function segHandlesFor(series, xF, boxRectLeft, L, R, W, totalKm) {
        var out = [];
        if (typeof Edit === 'undefined' || typeof Edit._mergedIds !== 'function') return out;   // S28：默认态可用，不再要求 Edit.on
        if (typeof STARTS !== 'undefined' && STARTS.length > 1 && typeof start !== 'undefined' && start !== STARTS[0].id) return out;
        var merged = Edit._mergedIds();
        var vis = DAYS.filter(function (d) { return merged.indexOf(d.id) < 0; });
        /* 边界容差 ±0.5km：数据里相邻天的端点可能差零点零几（如 D1 终点 211.58 vs
           D2 起点 211.6），宽容差纳入；松手 setSeg 会把两天切成同一 km，缝隙随拖动愈合 */
        var lo = series[0].km - 0.5, hi = series[series.length - 1].km + 0.5;
        for (var i = 0; i < vis.length - 1; i++) {
            var a = vis[i], b = vis[i + 1];
            if (!a.altKm || !b.altKm) continue;
            var km = a.altKm[1];
            if (km < lo || km > hi) continue;
            out.push({
                bi: out.length, km: km,
                x: Math.min(Math.max(xF(km), L + 2), W - R - 2),   // 显示位置钳在图内
                dayA: a, dayB: b,
                kmSeries0: series[0].km,
                pxPerKm: (W - L - R) / totalKm,
                rectLeft: boxRectLeft, L: L, W: W,
                scaleX: 1   // 挂载后按真实渲染尺寸回填（CSS 可能拉伸 svg，见 drawProfile）
            });
        }
        return out;
    }
    function segDragStart(bi, e) {
        var h = lastSegHandles.filter(function (x) { return x.bi === bi; })[0];
        if (!h || typeof Edit === 'undefined') return;
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (e && e.stopPropagation) e.stopPropagation();
        var minKm = +(h.dayA.altKm[0] + 1).toFixed(1);
        var maxKm = +(h.dayB.altKm[1] - 1).toFixed(1);
        if (minKm > maxKm) return;   // 两天总共不足 2km：无拖动空间（守卫拒绝）
        segDrag = { bi: bi, km0: h.km, km: h.km, minKm: minKm, maxKm: maxKm, el: e && e.currentTarget };
        segDragPaint();
    }
    function segDragMove(km) {
        if (!segDrag || !(km > -1e8)) return;
        segDrag.km = Math.min(segDrag.maxKm, Math.max(segDrag.minKm, +km.toFixed(1)));
        segDragPaint();
    }
    function segDragPaint() {
        var h = lastSegHandles.filter(function (x) { return x.bi === segDrag.bi; })[0];
        if (!h) return;
        var dx = (segDrag.km - segDrag.km0) * h.pxPerKm;
        if (segDrag.el && segDrag.el.setAttribute) segDrag.el.setAttribute('transform', 'translate(' + dx + ',0)');
        var ka = +(segDrag.km - h.dayA.altKm[0]).toFixed(1);
        var kb = +(h.dayB.altKm[1] - segDrag.km).toFixed(1);
        segPrevText = 'D' + h.dayA.id + ' ' + Math.round(ka) + 'km｜D' + h.dayB.id + ' ' + Math.round(kb) + 'km';
        try {
            tipEl.style.display = 'block';
            tipEl.innerHTML = segPrevText + '<br><span style="color:#94a3b8;font-size:10px">松手重切这两天</span>';
            var scaleX = h.scaleX || 1;
            var px = h.rectLeft + (h.L + (segDrag.km - h.kmSeries0) * h.pxPerKm) * scaleX;
            tipEl.style.left = Math.min(Math.max(px - 46, 8), h.rectLeft + h.W * scaleX - 140) + 'px';
            tipEl.style.top = '20px';
        } catch (e) {}
    }
    function segDragRelease() {
        if (!segDrag) return;
        var d = segDrag; segDrag = null;
        segPrevText = '';
        try { tipEl.style.display = 'none'; } catch (e) {}
        if (d.km === d.km0) return;   // 没动：不触发重切
        var h = lastSegHandles.filter(function (x) { return x.bi === d.bi; })[0];
        if (!h || typeof Edit === 'undefined' || !Edit.setSeg) return;
        Edit.setSeg(h.dayA.id, h.dayA.altKm[0], d.km);
        Edit.setSeg(h.dayB.id, d.km, h.dayB.altKm[1]);
    }
    /* 把手事件（真实浏览器）：window 级跟手，松开结算。
       像素→km 换算一律经 scaleX（CSS 拉伸下的真实映射） */
    function segKmFromClientX(h, clientX) {
        var scaleX = h.scaleX || 1;
        return ((clientX - h.rectLeft) / scaleX - h.L) / h.pxPerKm + h.kmSeries0;
    }
    window.addEventListener('mousemove', function (e) {
        if (!segDrag || e.clientX == null) return;
        var h = lastSegHandles.filter(function (x) { return x.bi === segDrag.bi; })[0];
        if (!h) return;
        segDragMove(segKmFromClientX(h, e.clientX));
    });
    window.addEventListener('touchmove', function (e) {
        if (!segDrag) return;
        if (e.cancelable && typeof e.preventDefault === 'function') e.preventDefault();
        var t = e.touches && e.touches[0];
        if (!t) return;
        var h = lastSegHandles.filter(function (x) { return x.bi === segDrag.bi; })[0];
        if (!h) return;
        segDragMove(segKmFromClientX(h, t.clientX));
    }, { passive: false });
    window.addEventListener('mouseup', segDragRelease);
    window.addEventListener('touchend', segDragRelease);
    window.addEventListener('touchcancel', segDragRelease);
    /* 测试接缝：vm 中断言「把手渲染 + 拖边界重算 + <1km 守卫」 */
    try {
        window.__profileSeg = {
            handles: function () { return lastSegHandles.slice(); },
            start: function (bi) { segDragStart(bi, null); return !!segDrag; },
            dragTo: function (km) { segDragMove(km); return segDrag ? segDrag.km : null; },
            release: function () { segDragRelease(); },
            preview: function () { return segPrevText; }
        };
    } catch (e) {}

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
        var curveD = smoothD(pts);   // S17：平滑曲线（过所有采样点）
        var area = curveD + ' L' + pts[pts.length - 1][0].toFixed(1) + ',' + (H - B) + ' L' + pts[0][0].toFixed(1) + ',' + (H - B) + ' Z';
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
        /* S27：编辑态天边界拖把手（两种模式都画：全程=全部内边界，聚焦=该天左右边界；
           命中区 16px 宽，线 + 顶部圆点示意可拖） */
        var boxRectLeft = 0;
        try { boxRectLeft = (box.getBoundingClientRect().left) || 0; } catch (e) {}
        var segHandles = segHandlesFor(series, xF, boxRectLeft, L, R, W, totalKm);
        lastSegHandles = segHandles;
        var segH = segHandles.map(function (h) {
            return '<g class="seg-handle" data-bi="' + h.bi + '">' +
                '<rect x="' + (h.x - 8) + '" y="' + T + '" width="16" height="' + (H - B - T) + '" fill="transparent" style="cursor:ew-resize"/>' +
                '<line x1="' + h.x + '" y1="' + (T + 4) + '" x2="' + h.x + '" y2="' + (H - B) + '" stroke="#0f766e" stroke-width="2" stroke-dasharray="3 3" opacity=".45"/>' +
                '<circle cx="' + h.x + '" cy="' + (T + 10) + '" r="5.5" fill="#0f766e" stroke="#fff" stroke-width="1.6" style="cursor:ew-resize"/>' +
                '</g>';
        }).join('');
        box.querySelector('svg') && box.querySelector('svg').remove();
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', W); svg.setAttribute('height', H);
        svg.innerHTML =
            '<defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="' + (focus ? '#f97316' : '#14b8a6') + '" stop-opacity=".32"/>' +
            '<stop offset="1" stop-color="' + (focus ? '#f97316' : '#14b8a6') + '" stop-opacity=".04"/></linearGradient></defs>' +
            grid +
            '<path d="' + area + '" fill="url(#eg)"/>' +
            '<path d="' + curveD + '" fill="none" stroke="' + LINE_C + '" stroke-width="' + (focus ? 3 : 2.5) + '" stroke-linejoin="round"/>' +
            dots + labels + ends + segH +
            (focus ? '<text x="' + L + '" y="14" font-size="11.5" font-weight="600" fill="#c2410c">' + focusTitle + '</text>' : '');
        box.appendChild(svg);
        /* 真实渲染尺寸回填：CSS 会把 svg 拉伸到容器宽（.elev-chart svg{width:100%}），
           用户单位 → 屏幕 px 有缩放，命中与换算都必须按真实矩形来（mock 下 getBounding
           ClientRect 恒返回 1200 宽，scaleX 回填仅影响 tooltip 像素位置，断言走 dragTo 无碍） */
        try {
            var sr = svg.getBoundingClientRect && svg.getBoundingClientRect();
            if (sr && sr.width > 0 && W > 0) segHandles.forEach(function (h) {
                h.rectLeft = sr.left || 0;
                h.scaleX = sr.width / W || 1;
            });
        } catch (e) {}
        /* 把手拖拽事件（真实 DOM；mock 下 querySelectorAll 为空，自动跳过） */
        Array.prototype.forEach.call(svg.querySelectorAll ? svg.querySelectorAll('.seg-handle') : [], function (gEl) {
            if (!gEl.addEventListener) return;
            var bi = gEl.getAttribute ? +(gEl.getAttribute('data-bi') || 0) : 0;
            gEl.addEventListener('mousedown', function (e) { segDragStart(bi, e); });
            gEl.addEventListener('touchstart', function (e) { segDragStart(bi, e); }, { passive: false });
        });

        // hover（聚焦模式下显示"距当天起点"；S27：拖把手期间让位给边界预览）
        svg.onmousemove = function (ev) {
            if (segDrag) return;
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
