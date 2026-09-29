/* ============================================================================
 * engine/route-engine.js — 地图初始化 / 取景 / 图层 / 每日路线
 *
 * 平台化 S2 从 index.html 主脚本拆分而来（纯搬家 + 消硬编码，逻辑未重写）：
 *   - 出发地双基准体系收进数据契约 ROUTE_STARTS，本文件不认任何具体城市
 *   - 地图初始视角由主基准出发地的包围盒算出（原为写死的经验值）
 *   - 经典支线/固定支线全部由数据包（CLASSIC / EXTRA_LINES）驱动
 * 依赖：route-defs/<route>.js（数据包）先于本文件加载；planner/profile/ui 后加载，
 * 跨文件调用全部发生在运行时（点击/启动），加载期无交叉调用。
 * ========================================================================== */

    /* ============ 图标（运行时生成 data URI，避免外部图片依赖） ============ */
    function icon(svg) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }
    function pin(fill) {
        return icon('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="32" viewBox="0 0 24 32"><path d="M12 1C5.9 1 1 5.9 1 12c0 8 11 19 11 19s11-11 11-19C23 5.9 18.1 1 12 1z" fill="' + fill + '" stroke="#fff" stroke-width="1.6"/><circle cx="12" cy="12" r="4.2" fill="#fff"/></svg>');
    }
    var IC = {
        city: pin('#1e3a5f'),
        spot: pin('#7c3aed'),
        fuel: icon('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30"><circle cx="15" cy="15" r="13.5" fill="#dc2626" stroke="#fff" stroke-width="2.2"/><rect x="9.5" y="8" width="7" height="13" rx="1.4" fill="#fff"/><rect x="11.2" y="10" width="3.6" height="3.4" rx="0.6" fill="#dc2626"/><path d="M17.5 11h2.2c.7 0 1.3.6 1.3 1.3v5.2c0 .9.6 1.5 1.3 1.5s1.3-.6 1.3-1.5v-5.4l-1.8-1.8" stroke="#fff" stroke-width="1.4" fill="none" stroke-linecap="round"/><rect x="9.5" y="19.4" width="10" height="1.8" rx="0.9" fill="#fff"/></svg>'),
        ev:   icon('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30"><circle cx="15" cy="15" r="13.5" fill="#16a34a" stroke="#fff" stroke-width="2.2"/><path d="M16.6 6.5L10 16.8h4.2l-1.2 6.7 6.8-10.5h-4.4l1.2-6.5z" fill="#fff"/></svg>')
    };

    /* 全程最高点：从真实高程序列算，不写死。
       注意：ALT_REAL 有高程采样噪声（open-meteo DEM 网格点会落到路旁山脊），
       曾出现 3km 内跳 556m 的假峰（路面上不可能）
       → 必须先 altDenoised() 去尖峰，否则最高点显示的是噪声。 */
    function peakAlt() {
        var best = { alt: 0, km: 0, n: '' };
        var clean = altDenoised();
        clean.forEach(function (p) {
            if (p[1] > best.alt) best = { alt: p[1], km: p[0], n: '' };
        });
        // 用最近的地名标注给最高点命名
        var nearest = null, nd = 1e9;
        ALT_MARKS.forEach(function (m) {
            var dd = Math.abs(m.km - best.km);
            if (dd < nd) { nd = dd; nearest = m; }
        });
        if (nearest && nd <= 15) { best.n = nearest.n; best.alt = Math.max(best.alt, nearest.alt); }
        else best.n = best.km.toFixed(0) + 'km 处';
        return { alt: Math.round(best.alt), km: best.km, n: best.n };
    }
    /* 去掉高程采样噪声尖峰：
       open-meteo 的 DEM 网格点有时落在路旁山脊上，造成单点跳升 500m+ 的假峰
       （如某段 3km 内上下 556m，路面上不可能）
       用 5 点滑动中值滤波，只剔除孤立尖峰，保留真实山口的持续高值 */
    var _denoised = null;
    function altDenoised() {
        if (_denoised) return _denoised;
        var w = 2; // 左右各 2 点
        _denoised = ALT_REAL.map(function (p, i) {
            var win = [];
            for (var j = Math.max(0, i - w); j <= Math.min(ALT_REAL.length - 1, i + w); j++) win.push(ALT_REAL[j][1]);
            win.sort(function (a, b) { return a - b; });
            var med = win[Math.floor(win.length / 2)];
            // 偏离中值超过 300m 视为噪声，拉回中值；否则保留原值
            return [p[0], Math.abs(p[1] - med) > 300 ? med : p[1]];
        });
        return _denoised;
    }
    /* 全程最低点，同理 */
    function lowAlt() {
        var best = { alt: 1e9, km: 0, n: '' };
        ALT_REAL.forEach(function (p) {
            if (p[1] < best.alt) best = { alt: p[1], km: p[0], n: '' };
        });
        var nearest = null, nd = 1e9;
        ALT_MARKS.forEach(function (m) {
            var dd = Math.abs(m.km - best.km);
            if (dd < nd) { nd = dd; nearest = m; }
        });
        if (nearest && nd <= 8) best.n = nearest.n;
        return best;
    }

    /* ============ 出发地契约（S2：双基准体系收进数据包 ROUTE_STARTS） ============
       数据包用 ROUTE_STARTS 声明出发地列表，引擎只认契约，不认任何具体城市：
       - starts[0] 是主基准出发地（环线里程 0 点），totalKm = 环线总里程
       - 其余出发地可带 offsetKm（接入段里程平移）、leadPath（接入轨迹）、
         head（接入端海拔点）、firstDay/lastDay（首末日文案）、sub（副标题）、
         stationKm0（行程起点在站点里程基准上的 km）
       - 单出发地线路（length < 2）不渲染切换按钮，buildDays 直接返回 CORE+TAIL */
    var STARTS = (typeof ROUTE_STARTS !== 'undefined' && ROUTE_STARTS && ROUTE_STARTS.length)
        ? ROUTE_STARTS
        : [{ id: 'default', name: '默认', sub: '', offsetKm: 0, stationKm0: 0, totalKm: 0 }];
    var start = STARTS[0].id;
    function startById(id) {
        for (var i = 0; i < STARTS.length; i++) if (STARTS[i].id === id) return STARTS[i];
        return STARTS[0];
    }
    function curStart() { return startById(start); }

    /* 线路地理包围盒（从 CORE+TAIL 全程轨迹现算；TAIL 必须并入——不闭合单线的
       末段会伸出 CORE 范围）。带接入段的出发地另并入其接入轨迹，
       否则切到该出发地时按主基准 bbox 算 zoom 会装不下接入段。 */
    var LOOP_BBOX = (function () {
        function eatBox(b, pts) {
            (pts || []).forEach(function (p) {
                if (p[0] < b.latMin) b.latMin = p[0];
                if (p[0] > b.latMax) b.latMax = p[0];
                if (p[1] < b.lngMin) b.lngMin = p[1];
                if (p[1] > b.lngMax) b.lngMax = p[1];
            });
            return b;
        }
        var base = { latMin: 99, latMax: -99, lngMin: 999, lngMax: -999 };
        // S7：不闭合单线的末段（TAIL）会伸出 CORE 范围（如 318 的拉萨端），
        // 包围盒必须含全程，否则 fitAll 把终点裁出视野。环线 TAIL 回到起点附近，
        // 并入后 bbox 不变（实测两条环线 zoom 恒被 7.6 上限钳住，行为零变化）。
        CORE.concat([TAIL]).forEach(function (d) { eatBox(base, d.path); });
        var out = {};
        STARTS.forEach(function (s) {
            out[s.id] = (s.leadPath && s.leadPath.length)
                ? eatBox({ latMin: base.latMin, latMax: base.latMax, lngMin: base.lngMin, lngMax: base.lngMax }, s.leadPath)
                : base;
        });
        return out;
    })();

    /* ============ 初始化地图（S9：高德 JS API v2） ============
       初始视角取主基准出发地包围盒的中心（数据算出；boot 后 fitAll 会精算）。
       高德中心坐标序为 [lng,lat]，与数据/引擎的 [lat,lng] 相反，此处显式调换。 */
    var _b0 = LOOP_BBOX[STARTS[0].id];
    var map = new AMap.Map('map', {
        zoom: 6.2,
        center: [(_b0.lngMin + _b0.lngMax) / 2, (_b0.latMin + _b0.latMax) / 2],
        minZoom: 5,
        maxZoom: 15,
        viewMode: '2D'
    });

    function openInfo(lat, lng, tags, title, body) {
        var tagHtml = tags.map(function (t) { return '<span class="tag ' + t[1] + '">' + t[0] + '</span>'; }).join('');
        openInfoWindow(map, lat, lng,
            '<div class="iw"><h3>' + title + '</h3>' + tagHtml + '<p>' + body + '</p></div>', -30);
    }

    /* --- 标注层（一次性创建） --- */
    var cityMarkers = createMarkerLayer({
        map: map,
        styles: { city: ({ src: IC.city, width: 24, height: 32, anchor: { x: 12, y: 32 } }) },
        geometries: CITIES.map(function (c, i) {
            return { id: 'c' + i, styleId: 'city', position: LL(c.p[0], c.p[1]) };
        })
    });
    cityMarkers.on('click', function (e) {
        var c = CITIES[parseInt(e.geometry.id.slice(1), 10)];
        openInfo(c.p[0], c.p[1], [['城镇', 'c']], c.n, c.d);
    });
    var spotMarkers = createMarkerLayer({
        map: map,
        styles: { spot: ({ src: IC.spot, width: 22, height: 30, anchor: { x: 11, y: 30 } }) },
        geometries: SPOTS.map(function (s, i) {
            return { id: 's' + i, styleId: 'spot', position: LL(s.p[0], s.p[1]) };
        })
    });
    spotMarkers.on('click', function (e) {
        var s = SPOTS[parseInt(e.geometry.id.slice(1), 10)];
        var isPass = s.n.indexOf('垭口') >= 0;
        openInfo(s.p[0], s.p[1], [[isPass ? '垭口' : '景点', 's']], s.n, s.d);
    });
    /* ⚠️ 历史教训（S0 实测）：旧版曾同时存在两套站点图层 —— 手打示例站与真实
       STATION_DATA 各画一层，同一个站两个位置（数据自相矛盾）。旧图层已删除，
       手打示例站变量也已于 S2 从数据包移除；真实站点统一走 planner.js 的
       renderStations()（dimEvM/dimFuelM/planM）。 */

    /* --- 地名标注层（体验修复 3：标签分三级） ---
       ① 景点 SPOTS = 最高层级：更大字号 + 白底胶囊 + 最高 zIndex，默认显示
       ② 城镇 CITIES = 中层级：标准标注
       ③ 站点 = 图标即主表达，站名文字只在近景出现（planner.js 的 z>=10 标签层）
       景点胶囊的缩放分级（S12 补）：复用 S0 站点分级的思路——25km 里程桶按 zoom 稀疏。
       铁律同 S0：显示层不得放大数据缺陷——稀疏只减同屏数量，放大即全显，
       绝不制造「这段没景点」的假象。 */
    function labelGeos(arr) {
        return arr.map(function (it, i) {
            return { id: 'l' + i, position: LL(it.p[0], it.p[1]), content: it.n };
        });
    }
    var SPOT_LABEL_STYLE = { color: '#6d28d9', size: 13, bold: true, badge: true, offset: { x: 0, y: 22 } };
    var cityLabels = createLabelLayer({
        map: map,
        zIndex: 120,
        styles: { default: ({ color: '#1f2937', size: 12, offset: { x: 0, y: 20 } }) },
        geometries: labelGeos(CITIES)
    });

    /* --- 景点胶囊分级（S0 同构：桶选代表点，优先级 = 名称强信号 > 原顺序） ---
       远景 z<8：每 25km 桶 1 个；中景 8≤z<10：每桶 2 个；近景 z≥10：全显。
       触发链复用 S0：planner 的 zoomchange 防抖回调里顺带调用 renderSpotLabels()。 */
    var SPOT_FAR_Z = 8, SPOT_MID_Z = 10, SPOT_BUCKET_KM = 25;
    var SPOT_STRONG = /雪山|冰川|湖|海子|垭口|国家|大峡谷|瀑布|丹霞|雅丹|石窟|古城|遗址|草原/;
    var spotLabels = null;
    var spotLabelOn = true;      // tgSpot 图层开关状态位（整层重建后旧引用失效，同 S0 状态位模式）
    var spotKmCache = [];        // 每个景点的沿线里程（renderAll 时按环线表最近点算，供分桶）
    function rebuildSpotKm() {
        // 环线 km→经纬度表（与 renderWarnings 同法：天 path 按 altKm 线性插值）
        var table = [];
        DAYS.forEach(function (d) {
            if (!d.path || !d.altKm) return;
            var n = d.path.length;
            d.path.forEach(function (p, i) {
                table.push([d.altKm[0] + (d.altKm[1] - d.altKm[0]) * i / (n - 1), p[0], p[1]]);
            });
        });
        spotKmCache = SPOTS.map(function (s) {
            var best = 0, bd = 1e9;
            for (var i = 0; i < table.length; i++) {
                var dd = (table[i][1] - s.p[0]) * (table[i][1] - s.p[0]) + (table[i][2] - s.p[1]) * (table[i][2] - s.p[1]);
                if (dd < bd) { bd = dd; best = table[i][0]; }
            }
            return best;
        });
    }
    function renderSpotLabels(zoom) {
        if (spotLabels) { spotLabels.setMap(null); spotLabels = null; }
        if (!spotLabelOn) return;
        var z = (zoom == null) ? 7.3 : zoom;
        try { if (typeof map.getZoom === 'function') z = map.getZoom(); } catch (e) {}
        var picked = SPOTS;
        if (z < SPOT_MID_Z) {
            var cap = z < SPOT_FAR_Z ? 1 : 2;
            var buckets = {};
            SPOTS.forEach(function (s, i) {
                var b = Math.floor((spotKmCache[i] || 0) / SPOT_BUCKET_KM);
                (buckets[b] = buckets[b] || []).push(i);
            });
            var idx = [];
            Object.keys(buckets).forEach(function (b) {
                buckets[b].sort(function (a, c) {
                    var sa = SPOT_STRONG.test(SPOTS[a].n) ? 0 : 1;
                    var sc = SPOT_STRONG.test(SPOTS[c].n) ? 0 : 1;
                    return sa - sc || a - c;   // 强信号优先；同信号按原顺序（手打在前）
                }).slice(0, cap).forEach(function (i) { idx.push(i); });
            });
            picked = idx.sort(function (a, c) { return a - c; }).map(function (i) { return SPOTS[i]; });
        }
        spotLabels = createLabelLayer({
            map: map,
            zIndex: 130,   // 景点优先避让权：压在城镇与站点标签之上（分级只稀疏同层数量，不动层级）
            styles: { default: SPOT_LABEL_STYLE },
            geometries: labelGeos(picked)
        });
    }

    /* --- 经典支线（虚线；图例文案随数据包 CLASSIC.label） ---
       数据包可给空 CLASSIC（无支线概念的线路），此时不建图层并隐藏图例行 */
    var hasClassic = !!(typeof CLASSIC !== 'undefined' && CLASSIC && CLASSIC.simplified && CLASSIC.simplified.length);
    var classicLine = null;
    if (hasClassic) {
        classicLine = createPolylineLayer({
            map: map,
            styles: { default: ({ color: '#c026d3', width: 3, dashArray: [10, 7], lineCap: 'round' }) },
            geometries: [{
                id: 'classic', styleId: 'default',
                paths: CLASSIC.simplified.map(function (p) { return LL(p[0], p[1]); })
            }]
        });
        classicLine.setMap(null); // 默认关闭，由图层开关控制
        var classicLabelEl = document.getElementById('classicLabel');
        if (classicLabelEl && CLASSIC.label) classicLabelEl.textContent = CLASSIC.label;
    } else {
        var classicRowEl = document.getElementById('classicRow');
        if (classicRowEl) classicRowEl.style.display = 'none';
    }

    /* --- 固定支线（虚线；坐标收在数据包 EXTRA_LINES，引擎不写死） --- */
    (typeof EXTRA_LINES !== 'undefined' ? EXTRA_LINES : []).forEach(function (br) {
        createPolylineLayer({
            map: map,
            styles: { default: ({ color: br.color || '#94a3b8', width: br.width || 3, dashArray: br.dash || [10, 8], lineCap: 'round' }) },
            geometries: [{
                id: br.id || 'branch', styleId: 'default',
                paths: br.pts.map(function (p) { return LL(p[0], p[1]); })
            }]
        });
    });

    /* ============ 出发地 & 每日路线构建 ============
       S2：出发地差异全部由数据包 ROUTE_STARTS 声明（接入轨迹/海拔点/首末日文案），
       引擎按契约拼接；无接入段的出发地直接返回 CORE+TAIL。 */
    var NORMAL = ({
        color: '#0d9488', width: 4, borderWidth: 2, borderColor: '#ffffff',
        lineCap: 'round', arrowOptions: { width: 8 }
    });
    var ACTIVE = ({
        color: '#ea580c', width: 7, borderWidth: 2, borderColor: '#ffffff',
        lineCap: 'round', arrowOptions: { width: 10 }
    });
    var dayLines = [];
    var DAYS = [];

    function buildDays(st) {
        var cur = startById(st);
        if (!cur.leadPath || !cur.leadPath.length) return CORE.concat([TAIL]);
        var off = cur.offsetKm || 0;
        var d1 = {
            id: 1, title: cur.firstDay.title, km: Math.round(CORE[0].km + off), zoom: cur.firstDay.zoom,
            note: cur.firstDay.note,
            altKm: [0, +(CORE[0].altKm[1] + off).toFixed(1)],
            energy: cur.firstDay.energy,
            path: cur.leadPath.concat(CORE[0].path.slice(1))
        };
        var dN = {
            id: TAIL.id, title: cur.lastDay.title, km: Math.round(TAIL.km + off), zoom: cur.lastDay.zoom,
            note: cur.lastDay.note,
            altKm: [+(TAIL.altKm[0] + off).toFixed(1), +(TAIL.altKm[1] + off).toFixed(1)],
            energy: cur.lastDay.energy,
            path: TAIL.path.concat(cur.leadPath.slice(1).reverse())
        };
        // 带接入段的出发地：中间天 altKm 统一平移 +off（首末日原生即该出发地基准）
        return [d1].concat(CORE.slice(1).map(function (c) {
            return Object.assign({}, c, { altKm: [c.altKm[0] + off, c.altKm[1] + off] });
        }), [dN]);
    }

    function renderAll() {
        // 清掉旧线
        dayLines.forEach(function (pl) { if (pl) pl.setMap(null); });
        dayLines = [];
        DAYS = buildDays(start);
        DAYS.forEach(function (d) {
            if (!d.path) { dayLines.push(null); return; }
            dayLines.push(createPolylineLayer({
                map: map,
                styles: { default: NORMAL },
                geometries: [{
                    id: 'day' + d.id, styleId: 'default',
                    paths: d.path.map(function (pt) { return LL(pt[0], pt[1]); })
                }]
            }));
        });
        // 侧栏
        var listEl = document.getElementById('dayList');
        listEl.innerHTML = '';
        // 出发日期（S13 排期）：overlay 存在时每天卡显示真实日期+星期；
        // 按 DAYS 顺序顺延（休整日只占序号不改里程）。日期源是 ROUTE_META.departureDate
        // （edit.js 的 overlay 合并时写入，通用字段、不写死任何线路）。
        document.body.classList.toggle('has-dep', !!ROUTE_META.departureDate);
        DAYS.forEach(function (d, i) {
            var li = document.createElement('li');
            li.title = d.energy;
            var tag = 'D' + d.id;
            if (ROUTE_META.departureDate) {
                var dep = new Date(ROUTE_META.departureDate + 'T00:00:00');
                dep.setDate(dep.getDate() + i);   // 第 i 天 = 出发 + i 天（含休整顺延）
                tag += ' · ' + (dep.getMonth() + 1) + '月' + dep.getDate() + '日 周' +
                    '日一二三四五六'.charAt(dep.getDay());
            }
            li.innerHTML = '<span class="day-tag">' + tag + '</span>' +
                '<span class="day-meta"><span class="day-title">' + d.title + '</span>' +
                '<span class="day-note">' + d.note + (d.stay ? ' · 住' + d.stay : '') + '</span></span>' +
                sparkSVG(d) +
                '<span class="day-km">' + (d.km ? d.km + 'km' : '—') + '</span>';
            li.onclick = function () { focusDay(i); };
            listEl.appendChild(li);
        });
        // 统计（全部从数据算出，不再写死 —— 写死的数会跟数据脱节）
        var totalKm = 0, driveDays = 0;
        DAYS.forEach(function (d) {
            totalKm += d.km;
            if (d.km > 0) driveDays++;
        });
        document.getElementById('chipKm').textContent = totalKm;
        document.getElementById('chipDays').textContent = driveDays;
        var altPeak = peakAlt();
        document.getElementById('chipMaxAlt').textContent = altPeak.alt;
        document.getElementById('chipMaxAlt').title = '最高点：' + altPeak.n + '（' + altPeak.alt + 'm）';
        // 视角复位
        fitAll();
        renderStations();
        renderWarnings();
        rebuildSpotKm();        // 景点胶囊分级的里程基准（随出发地重算）
        renderSpotLabels();
    }

    /* --- 长盲区上图（S4 可信度透出）---
       STATION_DATA.warnings 是体检/构建产出的 >100km 无站段（站点表 datum 空间），
       按当前出发地 stationKm0 换算成行程基准后叠画在每日轨迹上 + 文字标注。
       全部读数据包字段：任何线路有长盲区都会自动上图，引擎不认具体路段。 */
    var warnLines = [], warnLabels = [];
    function clearWarnings() {
        warnLines.forEach(function (l) { l.setMap(null); });
        warnLabels.forEach(function (l) { l.setMap(null); });
        warnLines = []; warnLabels = [];
    }
    function renderWarnings() {
        clearWarnings();
        var ws = (typeof STATION_DATA !== 'undefined' && STATION_DATA && STATION_DATA.warnings) || [];
        if (!ws.length || !DAYS.length) return;
        // km → 经纬度表：每天 path 按 altKm 线性插值（画盲区带足够，精度 ~天/240 点）
        var table = [];
        DAYS.forEach(function (d) {
            if (!d.path || !d.altKm) return;
            var n = d.path.length;
            d.path.forEach(function (p, i) {
                table.push([d.altKm[0] + (d.altKm[1] - d.altKm[0]) * i / (n - 1), p[0], p[1]]);
            });
        });
        table.sort(function (a, b) { return a[0] - b[0]; });
        if (table.length < 2) return;
        var off = curStart().stationKm0 || 0;
        ws.forEach(function (w, wi) {
            var a = w.from - off, b = w.to - off;
            var seg = table.filter(function (t) { return t[0] >= a && t[0] <= b; });
            if (seg.length < 2) return;
            var color = w.type === 'fuel' ? '#b45309' : '#dc2626';
            warnLines.push(createPolylineLayer({
                map: map,
                styles: { default: ({ color: color, width: 6, borderWidth: 2, borderColor: '#ffffff', lineCap: 'round' }) },
                geometries: [{
                    id: 'warn' + wi, styleId: 'default',
                    paths: seg.map(function (t) { return LL(t[1], t[2]); })
                }]
            }));
            var mid = seg[Math.floor(seg.length / 2)];
            warnLabels.push(createLabelLayer({
                map: map,
                styles: { default: ({ color: color, size: 11, offset: { x: 0, y: -16 } }) },
                geometries: [{
                    id: 'warnlb' + wi, position: LL(mid[1], mid[2]),
                    content: 'km' + Math.round(a) + '–' + Math.round(b) + ' ' + (w.label || '') + '（' + w.km + 'km）'
                }]
            }));
        });
    }

    var activeIdx = -1;
    function focusDay(i) {
        if (activeIdx === i) { fitAll(); return; } // 再点同一天 → 取消聚焦
        var d = DAYS[i];
        activeIdx = i;
        var listEl = document.getElementById('dayList');
        Array.prototype.forEach.call(listEl.children, function (li, j) {
            li.classList.toggle('active', j === i);
        });
        dayLines.forEach(function (pl, j) {
            if (pl) pl.setStyles({ default: j === i ? ACTIVE : NORMAL });
        });
        var center, zoom = d.zoom;
        if (d.center) { center = d.center; }
        else {
            var mid = d.path[Math.floor(d.path.length / 2)];
            center = [mid[0], mid[1]];
        }
        // 高德 setZoomAndCenter(zoom, [lng,lat])：对应原 easeTo({center, zoom}) 语义，
        // 动画时长由地图全局动画设置接管
        map.setZoomAndCenter(zoom, [center[1], center[0]]);
        document.getElementById('curEnergy').innerHTML = '<b>D' + d.id + ' ' + d.title + '（' + (d.km || 0) + 'km）：</b>' + d.energy;
        // 点了某天却看不到剖面是反直觉的 → 抽屉收起时自动展开
        if (!isOpen()) openDrawer(300);
        else drawProfile();
        // 窄屏：行程单是底部抽屉，点日卡后回 peek（露概要），别把抽屉整栏藏掉
        if (window.innerWidth <= 768 && typeof setSheet === 'function') setSheet('peek');
        else if (window.innerWidth <= 768) setPanelOpenLater(false);
    }

    /* 地图"真正可见区域"的估算：扣掉被侧栏（横向）和抽屉（纵向）遮掉的部分。
       这两种遮挡的形态随视口宽度完全不同，必须分开处理：
       · 宽屏（>768）：侧栏贴左、只占一条，地图可用区 = 视口减去侧栏右边缘 → 往【东】平移即可
       · 窄屏（≤768）：侧栏变底部抽屉（mobile.js 三态），横向占满、只露 peek 概要
                       → 横向不补偿，用【抽屉 peek 以上的上半屏】当可见区
       以前一刀切按横向补偿，窄屏上侧栏 right≈376 → 环线被推出屏幕外，地图一片空白。 */
    function visibleBox() {
        var vw = window.innerWidth, vh = window.innerHeight;
        var panelEl = document.getElementById('panel');
        var w = vw, h = vh, panelRight = 0, panelBottom = 0;
        var narrow = vw <= 768;

        if (panelEl && !panelEl.classList.contains('collapsed')) {
            var pr = panelEl.getBoundingClientRect();
            if (narrow) {
                // 窄屏：可见高度 = 视口 − 行程单抽屉露出的 peek（mobile.js 的 MOBILE_PEEK），宽度用整屏
                panelBottom = (typeof MOBILE_PEEK === 'number') ? MOBILE_PEEK : 92;
                h = vh - Math.max(panelBottom, 0) - 14;
                w = vw - 28;
            } else {
                panelRight = pr.right;
                w = vw - pr.right - 14;   // 侧栏右边缘到视口右边之间才是地图可用宽
            }
        } else {
            w = vw - 56;
        }
        // 底部抽屉占高（与侧栏遮挡取更紧的那个）
        var occ = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--elev-occupy')) || 0;
        h = Math.min(h, vh - occ - 14);

        return {
            w: Math.max(200, w), h: Math.max(200, h),
            vw: vw, vh: vh, panelRight: panelRight, panelBottom: panelBottom,
            narrow: narrow
        };
    }

    /* 给定可用像素区，算出刚好装下环线的 zoom（墨卡托） */
    function zoomToFit(box, bbox, padPx) {
        var lngSpan = bbox.lngMax - bbox.lngMin;
        // 墨卡托：纬度方向要用投影后的 y 差
        function mercY(lat) {
            var s = Math.sin(lat * Math.PI / 180);
            return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
        }
        var ySpan = Math.abs(mercY(bbox.latMin) - mercY(bbox.latMax));
        var xSpan = lngSpan / 360;
        var availW = Math.max(120, box.w - padPx * 2);
        var availH = Math.max(120, box.h - padPx * 2);
        var zx = Math.log2(availW / (256 * xSpan));
        var zy = Math.log2(availH / (256 * ySpan));
        return Math.min(zx, zy);
    }

    function fitAll(redraw) {
        activeIdx = -1;
        var listEl = document.getElementById('dayList');
        Array.prototype.forEach.call(listEl.children, function (li) { li.classList.remove('active'); });
        dayLines.forEach(function (pl) { if (pl) pl.setStyles({ default: NORMAL }); });

        // zoom：按"环线真实地理包围盒"装进"真正可见的像素区"反算，不再用经验常数。
        // 以前只吃容器高度 → 窄视口下路线被横向压扁、环线右侧出画。
        var box = visibleBox();
        var bbox = LOOP_BBOX[start] || LOOP_BBOX[STARTS[0].id];
        var z = zoomToFit(box, bbox, 26);
        z = Math.max(4.5, Math.min(7.6, z));

        /* 中心点：让【环线包围盒】在【真正可见的矩形】里居中。
           注意不能写成"给 bbox 中心加一个像素偏量" —— 那是线性近似，
           在纬度高、跨度大时会偏（墨卡托纬度是非线性的，且地图容器的几何中心
           与"可见区中心"根本不是同一个点：地图容器高 = vh−抽屉，
           而窄屏下可见区是 [侧栏底, vh]）。
           正确做法：直接反解 —— 要把 bbox 的某个纬度对齐到屏幕某个 y。 */
        var bboxMidLat = (bbox.latMin + bbox.latMax) / 2;
        var cx = bboxMidLat;
        var cy = (bbox.lngMin + bbox.lngMax) / 2;
        var pxPerDegLng = 256 * Math.pow(2, z) / 360;

        // 地图容器的几何中心（AMap 的 center 同样落在容器的正中心）
        var mapH = box.vh - 46;
        var midY = mapH / 2;

        function mercY(lat) {
            var s = Math.sin(lat * Math.PI / 180);
            return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
        }
        var ppxY = 256 * Math.pow(2, z);   // 墨卡托 y 的像素比（每单位），与经度同为这个世界宽度

        if (box.narrow) {
            // 窄屏：横向占满，纵向要让环线整体落在 [panelBottom, vh] 内居中。
            // 可见区中心的屏幕 y（用 vh 口径，因为它是相对视口的 CSS 像素）
            var visTop = box.panelBottom + 6;
            var visBot = box.vh - 6;
            var visMid = (visTop + visBot) / 2;
            // 反解：让 bbox 中心纬线落在 visMid → center.lat 使 mercY(lat) 满足下式
            //   visMid = midY + (mercY(centerLat) − mercY(bboxMidLat)) · ppxY
            // ⇒ mercY(centerLat) = mercY(bboxMidLat) + (visMid − midY) / ppxY
            var mercTarget = mercY(bboxMidLat) + (visMid - midY) / ppxY;
            // mercY 反函数：y = 0.5 − ln((1+s)/(1−s))/(4π) ⇒ lat = asin(1 − 2/(e^(4π(0.5−y))+1)) 的等价形式
            var n = Math.PI * (1 - 2 * mercTarget);
            cx = Math.atan(Math.sinh(n)) * 180 / Math.PI;
        } else if (box.panelRight > 0) {
            // 宽屏：横向平移，把 bbox 中心经线对齐到可见区中心
            // 经度是线性的，直接按像素差折算即可
            var shiftPx = ((box.panelRight + box.vw) / 2) - (box.vw / 2);
            cy -= shiftPx / pxPerDegLng;
        }

        // cx=纬度 cy=经度（引擎内部口径）；高德 center=[lng,lat]
        map.setZoomAndCenter(z, [cy, cx]);
        document.getElementById('curEnergy').textContent = '点选上方任意一天，看这段的海拔与能耗提示。';
        if (redraw !== false) drawProfile();
        if (window.__fitDebug) window.__fitDebug = { z: z, box: box, bbox: bbox };
    }
    document.getElementById('btnFit').onclick = function () { fitAll(); };

    /* --- 出发地切换（按钮由 ROUTE_STARTS 渲染；单出发地线路整段隐藏） --- */
    var startBtns = [];
    function renderStartButtons() {
        var seg = document.getElementById('startSeg');
        if (!seg) return;
        seg.innerHTML = '';
        startBtns = [];
        if (STARTS.length < 2) { seg.style.display = 'none'; return; }
        seg.style.display = '';
        STARTS.forEach(function (s) {
            var btn = document.createElement('button');
            btn.textContent = s.name;
            if (s.id === start) btn.className = 'on';
            btn.onclick = function () { setStart(s.id); };
            seg.appendChild(btn);
            startBtns.push(btn);
        });
    }
    function setStart(st) {
        if (start === st) return;
        start = st;
        var cur = curStart();
        startBtns.forEach(function (b, i) {
            b.classList.toggle('on', STARTS[i].id === st);
        });
        var subEl = document.querySelector('#panel .sub');
        if (subEl && cur.sub) subEl.textContent = cur.sub;
        renderAll();
        // 编辑模式开着时切换出发地：分段控件的可用性随视角变化，需要重建（编辑层注入）
        if (typeof Edit !== 'undefined' && Edit.isOn && Edit.isOn()) Edit.refreshDayControls();
    }
    renderStartButtons();

    /* --- 图层开关 ---
       tgFuel / tgEv 不绑到固定的 marker 变量上：它们控制的是【renderStations() 里
       动态重建的】dimEvM/dimFuelM，而每次重建都会 new 一个新的 MultiMarker →
       不能再持有旧引用。做法：开关只改一个状态位，然后触发重绘 → 重绘时按状态决定 setMap。 */
    function bindToggle(inputId, layers) {
        document.getElementById(inputId).addEventListener('change', function (e) {
            layers.forEach(function (l) { l.setMap(e.target.checked ? map : null); });
        });
    }
    bindToggle('tgCity', [cityMarkers, cityLabels]);
    // 景点开关改走状态位：胶囊标签按 zoom 整层重建，不能持有旧图层引用（同 S0 站点开关模式）
    document.getElementById('tgSpot').addEventListener('change', function (e) {
        spotLabelOn = e.target.checked;
        spotMarkers.setMap(e.target.checked ? map : null);
        renderSpotLabels();
    });

    // 站点图层开关：只记状态 + 重绘（重绘里会把新图层挂上/摘掉）
    var layerOn = { fuel: true, ev: true };
    document.getElementById('tgFuel').addEventListener('change', function (e) {
        layerOn.fuel = e.target.checked;
        renderStations();
    });
    document.getElementById('tgEv').addEventListener('change', function (e) {
        layerOn.ev = e.target.checked;
        renderStations();
    });
    document.getElementById('tgClassic').addEventListener('change', function (e) {
        if (classicLine) classicLine.setMap(e.target.checked ? map : null);
    });

    /* --- 侧栏折叠（全尺寸可用，地图软件惯例：面板自带折叠把手） --- */
    var panelEl = document.getElementById('panel');
    var handleEl = document.getElementById('panelHandle');
    function setPanelOpen(open) {
        panelEl.classList.toggle('collapsed', !open);
        handleEl.classList.toggle('show', !open);
        // 侧栏开合会改变地图可视区域，稍后重画剖面宽度
        setTimeout(function () { if (isOpen()) drawProfile(); }, 260);
    }
    // focusDay 在窄屏自动收侧栏（早于此定义，靠函数声明提升安全调用）
    function setPanelOpenLater(open) { setPanelOpen(open); }
    document.getElementById('panelFold').addEventListener('click', function () { setPanelOpen(false); });
    handleEl.addEventListener('click', function () { setPanelOpen(true); });
