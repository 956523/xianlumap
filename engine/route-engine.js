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
    /* S31 休整点层标记：琥珀圆 + 月亮（BRAND 同风格线性月亮的实心版，小尺寸可读） */
    var IC_REST = icon('<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="11.5" fill="#b45309" stroke="#fff" stroke-width="2.2"/><path d="M17.6 15.4A4.9 4.9 0 0 1 11.1 8.7 4.9 4.9 0 1 0 17.6 15.4z" fill="#fff"/></svg>');
    var IC = {
        city: pin('#1e3a5f'),
        citySmall: pin('#64748b'),   // S26：城镇钉减重——灰阶身（白描边在 pin() 里），60% 尺寸
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
    /* S26：城镇钉减重——60% 尺寸、灰阶身 + 白描边（IC.citySmall），与品牌灰阶一致；
       重建走状态位模式（S0 教训），远景稀疏与城名同构（renderCityLabels 同一口径） */
    var cityMarkerOn = true;
    var cityMarkers = null;
    function renderCityMarkers(zoom) {
        if (cityMarkers) { cityMarkers.setMap(null); cityMarkers = null; }
        if (!cityMarkerOn || typeof CITIES === 'undefined' || !CITIES) return;
        var z = (zoom == null) ? 7.3 : zoom;
        try { if (typeof map.getZoom === 'function') z = map.getZoom(); } catch (e) {}
        var mapW = 0;
        try { var me3 = document.getElementById('map'); mapW = (me3 && me3.clientWidth) || 0; } catch (e) {}
        var picked = CITIES;
        if (mapW > 0 && mapW < 700 && z < 8 && cityKmCache && cityKmCache.length) {   // 与城名同一 60km 桶口径（var 提升期可能未初始化）
            var buckets = {}, idx = [];
            CITIES.forEach(function (c, i) {
                var b = Math.floor((cityKmCache[i] || 0) / 60);
                (buckets[b] = buckets[b] || []).push(i);
            });
            Object.keys(buckets).forEach(function (b) { idx.push(buckets[b][0]); });
            picked = idx.sort(function (a, c) { return a - c; }).map(function (i) { return CITIES[i]; });
        }
        var idOf = {};
        CITIES.forEach(function (c, i) { idOf[c.n + '|' + c.p[0].toFixed(4)] = i; });
        cityMarkers = createMarkerLayer({
            map: map,
            styles: { city: ({ src: IC.citySmall, width: 14, height: 19, anchor: { x: 7, y: 19 } }) },
            geometries: picked.map(function (c) {
                var i = idOf[c.n + '|' + c.p[0].toFixed(4)];
                return { id: 'c' + (i == null ? 0 : i), styleId: 'city', position: LL(c.p[0], c.p[1]) };
            })
        });
    }
    renderCityMarkers();
    var _cityClick = function (e) {
        var c = CITIES[parseInt(e.geometry.id.slice(1), 10)];
        if (c) openInfo(c.p[0], c.p[1], [['城镇', 'c']], c.n, c.d);
    };
    if (cityMarkers && typeof cityMarkers.on === 'function') cityMarkers.on('click', _cityClick);
    var _renderCityMarkersBase = renderCityMarkers;
    renderCityMarkers = function (zoom) {
        _renderCityMarkersBase(zoom);
        if (cityMarkers && typeof cityMarkers.on === 'function') cityMarkers.on('click', _cityClick);
    };
    var spotMarkers = createMarkerLayer({
        map: null,   // S26：景点/垭口层默认关（图层弹层按需勾选）
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
    /* --- 城名分级（S18：与景点胶囊同构） ---
       CITIES 无沿线里程字段，用与景点同一个「最近路线点」表折算；手机全览（窄容器
       z<7）按 60km 桶只留主要城镇（数据顺序即沿线顺序，每桶取首个），近景全显。
       重建走状态位模式（S0 教训：开关不得持有图层引用）。 */
    var cityLabels = null;
    var cityLabelOn = true;
    var cityKmCache = [];
    function renderCityLabels(zoom) {
        if (cityLabels) { cityLabels.setMap(null); cityLabels = null; }
        if (!cityLabelOn || typeof CITIES === 'undefined' || !CITIES) return;
        var z = (zoom == null) ? 7.3 : zoom;
        try { if (typeof map.getZoom === 'function') z = map.getZoom(); } catch (e) {}
        var mapW = 0;
        try { var me2 = document.getElementById('map'); mapW = (me2 && me2.clientWidth) || 0; } catch (e) {}
        var picked = CITIES;
        if (mapW > 0 && mapW < NARROW_MAP_PX && z < SPOT_FAR_Z - 1 && cityKmCache.length) {
            var buckets = {}, idx = [];
            CITIES.forEach(function (c, i) {
                var b = Math.floor((cityKmCache[i] || 0) / SPOT_FAR_MOB_BUCKET_KM);
                (buckets[b] = buckets[b] || []).push(i);
            });
            Object.keys(buckets).forEach(function (b) { idx.push(buckets[b][0]); });   // 数据顺序=沿线顺序
            picked = idx.sort(function (a, c) { return a - c; }).map(function (i) { return CITIES[i]; });
        }
        try { window.__cityFarN = (picked === CITIES) ? CITIES.length : picked.length; } catch (e) {}
        cityLabels = createLabelLayer({
            map: map,
            zIndex: 120,
            styles: { default: ({ color: '#1f2937', size: 12, offset: { x: 0, y: 20 } }) },
            geometries: labelGeos(picked)
        });
    }

    /* --- 景点胶囊分级（S0 同构 + S17 移动远景降密） ---
       远景 z<8：每 25km 桶 1 个；中景 8≤z<10：每桶 2 个；近景 z≥10：全显。
       S17：窄容器（地图可视宽度 <700 CSS px，口径用容器宽而非纯 zoom——同 z 下
       窄屏每个标签占屏比例大得多）且 z<7（手机全览档）时改用 60km 桶 + 全局硬
       上限 12 个；优先级 = 名称强信号 > 手打文案（d 非"候选库收录"）> 距主线近。
       桌面 1600px 宽屏保持 25km 桶（屏幕容纳得下）。
       触发链复用 S0：planner 的 zoomchange 防抖回调里顺带调用 renderSpotLabels()。 */
    var SPOT_FAR_Z = 8, SPOT_MID_Z = 10, SPOT_BUCKET_KM = 25;
    var SPOT_FAR_MOB_BUCKET_KM = 60, SPOT_FAR_CAP = 12, NARROW_MAP_PX = 700;
    var SPOT_STRONG = /雪山|冰川|湖|海子|垭口|国家|大峡谷|瀑布|丹霞|雅丹|石窟|古城|遗址|草原/;
    var spotLabels = null;
    var spotLabelOn = false;     // S26 默认关：tgSpot 按需勾选（整层重建后旧引用失效，同 S0 状态位模式）
    /* 测试接缝：vm 断言用（模拟用户勾选图层弹层开关） */
    try {
        window.__spotLabels = function (on) { spotLabelOn = !!on; renderSpotLabels(); };
        window.__layerState = function (o) {
            if (o) {
                if (o.ev != null) layerOn.ev = !!o.ev;
                if (o.fuel != null) layerOn.fuel = !!o.fuel;
                if (o.rest != null) restLayerOn = !!o.rest;
            }
            return { ev: layerOn.ev, fuel: layerOn.fuel, rest: restLayerOn };
        };
    } catch (e) {}
    var spotKmCache = [];        // 每个景点的沿线里程（renderAll 时按环线表最近点算，供分桶）
    var spotOffKm = [];          // 距主线的垂直距离（km 近似，仅作优先级 tiebreak）
    function spotHand(s) { return !!(s.d && !/候选库/.test(s.d)); }   // 手打文案 vs 候选库收录
    function spotIdxCmp(a, c) {
        var sa = SPOT_STRONG.test(SPOTS[a].n) ? 0 : 1;
        var sc = SPOT_STRONG.test(SPOTS[c].n) ? 0 : 1;
        if (sa !== sc) return sa - sc;                 // ① 强信号词
        var ha = spotHand(SPOTS[a]) ? 0 : 1;
        var hc = spotHand(SPOTS[c]) ? 0 : 1;
        if (ha !== hc) return ha - hc;                 // ② 手打 > 候选库
        var da = spotOffKm[a] || 0, dc = spotOffKm[c] || 0;
        if (da !== dc) return da - dc;                 // ③ 距主线近
        return a - c;
    }
    function rebuildSpotKm() {
        // 环线 km→经纬度表（与 renderWarnings 同法：天 path 按 altKm 线性插值）
        // 景点与城名共用这张表折算沿线里程（S18 城名分级）
        var table = [];
        DAYS.forEach(function (d) {
            if (!d.path || !d.altKm) return;
            var n = d.path.length;
            d.path.forEach(function (p, i) {
                table.push([d.altKm[0] + (d.altKm[1] - d.altKm[0]) * i / (n - 1), p[0], p[1]]);
            });
        });
        spotKmCache = [];
        spotOffKm = [];
        SPOTS.forEach(function (s) {
            var best = 0, bd = 1e9;
            for (var i = 0; i < table.length; i++) {
                var dd = (table[i][1] - s.p[0]) * (table[i][1] - s.p[0]) + (table[i][2] - s.p[1]) * (table[i][2] - s.p[1]);
                if (dd < bd) { bd = dd; best = table[i][0]; }
            }
            spotKmCache.push(best);
            spotOffKm.push(Math.sqrt(bd) * 95);   // 度²→km 近似；只做相对排序，不追求精确
        });
        cityKmCache = (typeof CITIES !== 'undefined' && CITIES) ? CITIES.map(function (c) {
            var best = 0, bd = 1e9;
            for (var i = 0; i < table.length; i++) {
                var dd = (table[i][1] - c.p[0]) * (table[i][1] - c.p[0]) + (table[i][2] - c.p[1]) * (table[i][2] - c.p[1]);
                if (dd < bd) { bd = dd; best = table[i][0]; }
            }
            return best;
        }) : [];
    }
    function renderSpotLabels(zoom) {
        if (spotLabels) { spotLabels.setMap(null); spotLabels = null; }
        if (!spotLabelOn) return;
        var z = (zoom == null) ? 7.3 : zoom;
        try { if (typeof map.getZoom === 'function') z = map.getZoom(); } catch (e) {}
        var mapW = 0;   // 容器 CSS 宽：双维判定的「视口」口径
        try { var me = document.getElementById('map'); mapW = (me && me.clientWidth) || 0; } catch (e) {}
        var farMobile = mapW > 0 && mapW < NARROW_MAP_PX && z < SPOT_FAR_Z - 1;   // 窄屏 z<7
        var picked = SPOTS;
        if (z < SPOT_MID_Z) {
            var bucketKm = farMobile ? SPOT_FAR_MOB_BUCKET_KM : SPOT_BUCKET_KM;
            var cap = farMobile ? 1 : (z < SPOT_FAR_Z ? 1 : 2);
            var buckets = {};
            SPOTS.forEach(function (s, i) {
                var b = Math.floor((spotKmCache[i] || 0) / bucketKm);
                (buckets[b] = buckets[b] || []).push(i);
            });
            var idx = [];
            Object.keys(buckets).forEach(function (b) {
                buckets[b].sort(spotIdxCmp).slice(0, cap).forEach(function (i) { idx.push(i); });
            });
            if (farMobile) idx = idx.sort(spotIdxCmp).slice(0, SPOT_FAR_CAP);   // 远景全局硬上限
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
    /* S33 地图减重：主线 4→3px、描边 2→1（去光晕）；聚焦态同步收敛 */
    var NORMAL = ({
        color: '#0d9488', width: 3, borderWidth: 1, borderColor: '#ffffff',
        lineCap: 'round', arrowOptions: { width: 8 }
    });
    var ACTIVE = ({
        color: '#ea580c', width: 4.5, borderWidth: 1, borderColor: '#ffffff',
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

    /* --- S29 三类点按天归属：统一的「沿线里程 → 第几天」推导 ---
       口径与 edit.js wpDayIdx 一致（当前视角 DAYS altKm ±0.5 容差 + 最近天兜底），
       但基于本文件自维护的里程表（DAYS 当前区间，含 overlay 分段改动，renderAll 时重建）。
       三类点：休整（天 stay + kind=rest 途经点）、打卡（SPOTS + kind=spot 途经点）、
       补给（STATION_DATA 近线 ≤35km 站点——与景点库物化 MAX_DIST=35 同口径）。 */
    var _dayKmTable = [];
    function rebuildDayKmTable() {
        _dayKmTable = [];
        DAYS.forEach(function (d) {
            if (!d.path || !d.altKm) return;
            var n = d.path.length;
            d.path.forEach(function (p, i) {
                _dayKmTable.push([d.altKm[0] + (d.altKm[1] - d.altKm[0]) * i / (n - 1), p[0], p[1]]);
            });
        });
        _dayKmTable.sort(function (a, b) { return a[0] - b[0]; });
    }
    function kmOfPoint(lat, lng) {
        var best = 0, bd = 1e9;
        for (var i = 0; i < _dayKmTable.length; i++) {
            var t = _dayKmTable[i];
            var dd = (t[1] - lat) * (t[1] - lat) + (t[2] - lng) * (t[2] - lng);
            if (dd < bd) { bd = dd; best = t[0]; }
        }
        return best;
    }
    function dayIdxOfKm(km) {
        var merged = (typeof Edit !== 'undefined' && Edit._mergedIds) ? Edit._mergedIds() : [];
        for (var i = 0; i < DAYS.length; i++) {
            var d = DAYS[i];
            if (merged.indexOf(d.id) >= 0) continue;
            if (d.altKm && km >= d.altKm[0] - 0.5 && km <= d.altKm[1] + 0.5) return i;
        }
        var nearest = -1, nd = 1e18;   // 区间外归最近天（跨段点上/接入段不丢）
        for (var j = 0; j < DAYS.length; j++) {
            var dj = DAYS[j];
            if (!dj.altKm) continue;
            var dist = km < dj.altKm[0] ? dj.altKm[0] - km : km - dj.altKm[1];
            if (dist < nd) { nd = dist; nearest = j; }
        }
        return nearest;
    }

    /* --- S29 行程卡三类分组行（休整/打卡/补给） ---
       行内格式：线性图标 + 类型名 + 成员（· 分隔，超 4 个收「等N处」）；
       成员可点（data-spot/data-wp → 地图飞行 + 信息窗，edit.js 捕获监听）；空类整行不显示。
       补给行是计数摘要（沿线 X 充电 + Y 加油）——站点本身已在地图分级层可点。 */
    function dayPtsHTML(d, gIdx, supEv, supFuel) {
        var ic = function (name) {
            return '<span class="pt-ic">' + ((typeof BRAND !== 'undefined' && BRAND[name]) || '') + '</span>';
        };
        var msHTML = function (list, kind) {
            var shown = list.slice(0, 4);
            var h = shown.map(function (m) {
                var attr = kind === 'ckin' && m.spotIdx != null ? ' data-spot="' + m.spotIdx + '"' :
                    (m.wpIdx != null ? ' data-wp="' + m.wpIdx + '"' : '');
                return '<span class="pt-m"' + attr + '>' + m.n + '</span>';
            }).join('<span class="pt-sep">·</span>');
            if (list.length > 4) h += '<span class="pt-sep">·</span><span class="pt-cap">等' + list.length + '处</span>';
            return h;
        };
        var rows = '';
        /* ① 休整：住宿 + kind=rest 途经点（天归属按坐标） */
        var rest = [];
        if (d.stay) rest.push({ n: d.stay + '（住宿）' });
        if (typeof Wp !== 'undefined' && Wp && Wp.list && d.altKm) {
            Wp.list.forEach(function (w, wi) {
                if (w.kind !== 'rest') return;
                if (dayIdxOfKm(kmOfPoint(w.p[0], w.p[1])) !== gIdx) return;
                rest.push({ n: w.n, wpIdx: wi });
            });
        }
        if (rest.length) rows += '<div class="pt-row">' + ic('moon') + '<span class="pt-lb">休整</span><span class="pt-ms">' + msHTML(rest, 'rest') + '</span></div>';
        /* ② 打卡：SPOTS 归属天 + kind=spot（缺省打卡，向后兼容）途经点 */
        if (d.altKm) {
            var ckin = [];
            if (typeof SPOTS !== 'undefined' && SPOTS) {
                SPOTS.forEach(function (s, si) {
                    if (dayIdxOfKm(kmOfPoint(s.p[0], s.p[1])) !== gIdx) return;
                    ckin.push({ n: s.n, spotIdx: si });
                });
            }
            if (typeof Wp !== 'undefined' && Wp && Wp.list) {
                Wp.list.forEach(function (w, wi) {
                    if (w.kind === 'rest') return;   // 缺省/spot 都是打卡
                    if (dayIdxOfKm(kmOfPoint(w.p[0], w.p[1])) !== gIdx) return;
                    ckin.push({ n: w.n, wpIdx: wi });
                });
            }
            if (ckin.length) rows += '<div class="pt-row">' + ic('flag') + '<span class="pt-lb">打卡</span><span class="pt-ms">' + msHTML(ckin, 'ckin') + '</span></div>';
            /* ③ 补给：近线 ≤35km 站点按天归属，计数摘要 */
            var nEv = 0, nFuel = 0;
            supEv.forEach(function (s) { if (dayIdxOfKm(s.km) === gIdx) nEv++; });
            supFuel.forEach(function (s) { if (dayIdxOfKm(s.km) === gIdx) nFuel++; });
            if (nEv + nFuel > 0) {
                var sum = '沿线 ' + (nEv ? nEv + ' 充电' : '') + (nEv && nFuel ? ' + ' : '') + (nFuel ? nFuel + ' 加油' : '');
                rows += '<div class="pt-row">' + ic('bolt') + '<span class="pt-lb">补给</span><span class="pt-ms"><span class="pt-sum">' + sum + '</span></span></div>';
            }
        }
        return rows ? '<div class="day-pts">' + rows + '</div>' : '';
    }

    /* ============ S33 链式行程 + 逆行方向 ============
       模型：节点（起点/休整点/终点）+ 链段（天行程）。休整点 = 链段之间的「关节」，
       双时间属性（晚抵达 / 次日出发）。起点/终点不可删；节点删除 = 前后链段合并（mergeDay）。
       逆行（仅环线 ROUTE_META.loop）：显示层天序反排 + altKm 镜像（km' = T - km），
       overlay 保持原口径——seg 镜像 = 同一 overlay 在镜像坐标系的呈现，不重写数据。 */
    var routeDir = 1;   // 1 顺时针 / -1 逆时针（仅主出发地视角；overlay.meta.dir 持久）
    function isLoopRoute() { return !(typeof ROUTE_META !== 'undefined' && ROUTE_META && ROUTE_META.loop === false); }
    function mainTotalKm() { return STARTS[0].totalKm; }
    function mirrorDay(d) {
        var T = mainTotalKm();
        var m = { orig: d, id: d.id, title: d.title, note: d.note, km: d.km, zoom: d.zoom,
            energy: d.energy, stay: d.stay, center: d.center,
            altKm: d.altKm ? [+(T - d.altKm[1]).toFixed(1), +(T - d.altKm[0]).toFixed(1)] : null,
            path: d.path ? d.path.slice().reverse() : d.path };
        return m;
    }
    function origOf(d) { return d && d.orig ? d.orig : d; }
    function currentDisp() {
        var merged = (typeof Edit !== 'undefined' && Edit._mergedIds) ? Edit._mergedIds() : [];
        var vis = DAYS.filter(function (d) { return merged.indexOf(d.id) < 0; });
        return (routeDir < 0 && start === STARTS[0].id) ? vis.slice().reverse().map(mirrorDay) : vis;
    }
    function dayDest(d) {
        var p = String(d.title || '').split('→');
        return (p.length > 1 ? p[p.length - 1] : d.title || '').trim().slice(0, 20);
    }
    function nodeName(d) { return (d.stay || dayDest(d)).slice(0, 20); }
    function nodeDates(vi) {   // vi = 该节点前那条链段的显示序号（0 基）
        if (!ROUTE_META.departureDate) return '夜宿点';
        try {
            var a = new Date(ROUTE_META.departureDate + 'T00:00:00');
            a.setDate(a.getDate() + vi);
            var b = new Date(a); b.setDate(b.getDate() + 1);
            var f = function (x) { return (x.getMonth() + 1) + '月' + x.getDate() + '日'; };
            return '夜宿 · ' + f(a) + ' 晚抵达 · ' + f(b) + ' 出发';
        } catch (e) { return '夜宿点'; }
    }
    /* 站点/规划的按天标注 → 显示层编号（逆行时天序反排） */
    function dayTagOf(km) {
        var id = dayOf(km);
        var disp = currentDisp();
        for (var i = 0; i < disp.length; i++) if (origOf(disp[i]).id === id) return 'D' + (i + 1);
        return 'D' + id;
    }
    function setRouteDir(dir) {
        routeDir = (dir < 0) ? -1 : 1;
        if (typeof Edit !== 'undefined' && Edit.overlay) {
            Edit.overlay.meta = Edit.overlay.meta || {};
            Edit.overlay.meta.dir = routeDir;
            try { if (typeof editSave === 'function') editSave(); } catch (e) {}   // 草稿标脏（edit.js 运行时加载）
        }
        renderAll();
    }

    function escapeHtml2(t) {
        return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    function renderAll() {
        // 清掉旧线
        dayLines.forEach(function (pl) { if (pl) pl.setMap(null); });
        dayLines = [];
        DAYS = buildDays(start);
        /* S29：三类点归属的里程表 + 近线补给清单（每轮渲染只算一次，行内复用） */
        rebuildDayKmTable();
        var supEv = [], supFuel = [];
        if (typeof stationsAll === 'function' && typeof STATION_DATA !== 'undefined' && STATION_DATA) {
            try {
                supEv = stationsAll('ev').filter(function (s) { return (s.d == null ? 99 : s.d) <= 35; });
                supFuel = stationsAll('fuel').filter(function (s) { return (s.d == null ? 99 : s.d) <= 35; });
            } catch (e) {}
        }
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
        // S25 天数显示语义：merged（并入前一天）的天隐藏；区间被切空（<1km 或无区间）
        // 的天不消失，显示「休整」占位卡；编号按可见序列连续重排 D1..Dn，永不跳号。
        var mergedIds = (typeof Edit !== 'undefined' && Edit.overlay && Edit.overlay.meta &&
            Array.isArray(Edit.overlay.meta.merged)) ? Edit.overlay.meta.merged : [];
        var visibleDays = DAYS.filter(function (d) { return mergedIds.indexOf(d.id) < 0; });
        /* S33 逆行：显示层 = 可见天反排 + 镜像（仅主出发地视角；overlay 保持原口径） */
        if (typeof Edit !== 'undefined' && Edit.overlay && Edit.overlay.meta && Edit.overlay.meta.dir === -1) routeDir = -1;
        if (start !== STARTS[0].id) routeDir = 1;   // 第二出发地视角不镜像（口径保守）
        var disp = currentDisp();
        document.body.classList.toggle('has-dep', !!ROUTE_META.departureDate);
        var loopRt = isLoopRoute();
        var startNodeName = ((STARTS[0].head && STARTS[0].head.n) || STARTS[0].name);
        /* S30.5 完成态返场：行中打卡（overlay.progress.daysDone）在规划视图同样可见——
           已打卡的天卡带 ✓ 角标+绿边、链上节点/段保持完成态视觉、全完成出横幅。
           数据跨模式共享（同一份 overlay.progress），进度条仍只在行中态底部。 */
        var prog = (typeof Edit !== 'undefined' && Edit.overlay && Edit.overlay.progress) || null;
        function dayDoneP(id) { return !!(prog && prog.daysDone && prog.daysDone[id]); }
        disp.forEach(function (dd, vi) {
            var d = origOf(dd);   // 编辑/归属一律落原对象；显示用 dd（镜像时 altKm/path 已换）
            var li = document.createElement('li');
            li.className = 'ch-item';
            var rest = !dd.altKm || (dd.altKm[1] - dd.altKm[0]) < 1;   // 切空/无区间 = 休整占位
            if (rest) li.classList.add('rest');
            var doneDay = dayDoneP(d.id);
            if (doneDay) li.classList.add('done');
            li.title = dd.energy;
            var tag = 'D' + (vi + 1);   // 连续编号（显示层序；逆行自动反排）
            if (ROUTE_META.departureDate) {
                var dep = new Date(ROUTE_META.departureDate + 'T00:00:00');
                dep.setDate(dep.getDate() + vi);
                tag += ' · ' + (dep.getMonth() + 1) + '月' + dep.getDate() + '日 周' +
                    '日一二三四五六'.charAt(dep.getDay());
            }
            if (rest) tag += ' · 休整';
            if (doneDay) tag += ' ✓';   // S30.5 完成角标
            /* 起点节点（列表最顶） */
            var pre = '';
            if (vi === 0) {
                pre = '<div class="ch-node ch-start" data-node="start">' +
                    '<span class="ch-node-dot"></span>' +
                    '<div class="ch-node-tx"><b>' + escapeHtml2(startNodeName) + '</b>' +
                    '<span>起点' + (ROUTE_META.departureDate ? ' · ' + (function () { var a0 = new Date(ROUTE_META.departureDate + 'T00:00:00'); return (a0.getMonth() + 1) + '月' + a0.getDate() + '日'; })() + ' 出发' : '') + '</span></div></div>';
            }
            var noteTxt = rest ? '休整占位 · 链上点「＋」拆分，或并回前后段'
                : dd.note + (dd.stay ? ' · 住' + dd.stay : '');
            var card = '<div class="ch-card' + (rest ? ' rest' : '') + '">' +
                '<span class="day-top"><span class="day-tag">' + tag + '</span>' +
                '<span class="day-km">' + (rest ? '—' : (dd.km ? dd.km + 'km' : '—')) + '</span></span>' +
                '<span class="day-title">' + dd.title + '</span>' +
                '<span class="day-note">' + noteTxt + '</span>' +
                dayPtsHTML(dd, DAYS.indexOf(d), supEv, supFuel) +
                '<span class="et-chips">' + ((typeof wpChips === 'function') ? wpChips(d, true) : '') + '</span>' +
                '</div>';
            /* 中缝「＋」= 多住一晚（拆分该链段）；节点 = 夜宿关节 */
            var seam = rest ? '' : '<button class="ch-seam-add" data-seam="' + d.id + '" title="在此多住一晚（拆分）">＋</button>';
            var isLast = vi === disp.length - 1;
            var node = '';
            if (!isLast) {
                node = '<div class="ch-node' + (doneDay ? ' done' : '') + '" data-node-day="' + d.id + '">' +
                    '<span class="ch-node-ic">' + ((typeof BRAND !== 'undefined' && BRAND.moon) || '⛺') + '</span>' +
                    '<div class="ch-node-tx"><b>' + escapeHtml2(nodeName(dd)) + '</b><span>' + nodeDates(vi) + '</span></div></div>';
            } else {
                node = loopRt
                    ? '<div class="ch-node ch-end" data-node="end"><span class="ch-node-dot"></span>' +
                      '<div class="ch-node-tx"><b>' + escapeHtml2(startNodeName) + '</b><span>终点 · 环线闭合</span></div></div>'
                    : '<div class="ch-node ch-end" data-node="end"><span class="ch-node-dot"></span>' +
                      '<div class="ch-node-tx"><b>' + escapeHtml2(dayDest(dd)) + '</b><span>终点</span></div></div>';
            }
            li.innerHTML = pre + card + seam + node;
            li.onclick = rest ? null : (function (dayId) {
                return function () {
                    var idx = -1;
                    DAYS.forEach(function (x, j) { if (x.id === dayId) idx = j; });
                    if (idx >= 0) focusDay(idx);
                };
            })(d.id);
            listEl.appendChild(li);
        });
        /* S30.5：已完成天的链段在规划视图保持完成态视觉（粗实绿，与行中态同口径） */
        if (prog && prog.daysDone) {
            dayLines.forEach(function (pl, i) {
                if (!pl || !DAYS[i] || !prog.daysDone[DAYS[i].id]) return;
                try {
                    pl.setStyles({ default: { color: '#0f766e', width: 5, borderWidth: 1, borderColor: '#ffffff', lineCap: 'round', arrowOptions: { width: 8 } } });
                } catch (e) {}
            });
        }
        /* 全部完成横幅 */
        (function () {
            var old = document.getElementById('allDoneBanner');
            if (old && old.remove) old.remove();
            if (!prog || !prog.daysDone || !disp.length) return;
            var allOk = disp.every(function (d2) { return dayDoneP(origOf(d2).id); });
            if (!allOk) return;
            var b = document.createElement('div');
            b.id = 'allDoneBanner';
            b.className = 'all-done';
            b.textContent = '🎉 全程 ' + disp.length + ' 天全部完成';
            if (listEl.firstChild && listEl.insertBefore) listEl.insertBefore(b, listEl.firstChild);
            else listEl.appendChild(b);
        })();
        // 统计（全部从数据算出，不再写死 —— 写死的数会跟数据脱节）
        /* S33 修复 4259 叠加 bug：必须按【可见/显示天】合计——merged 天虽隐藏，其 km 仍挂在
           DAYS 里，而并入它的天已被 setSeg 延长，全量合计把同一段路算了两遍
           （全合并时 2164 → 4259）。 */
        var totalKm = 0, driveDays = 0;
        disp.forEach(function (d) {
            totalKm += d.km;
            if (d.km > 0) driveDays++;
        });
        document.getElementById('chipKm').textContent = totalKm;
        var chipDaysEl = document.getElementById('chipDays');
        chipDaysEl.textContent = disp.length;
        var chipDaysLb = document.getElementById('chipDaysLb');
        if (chipDaysLb) chipDaysLb.textContent = '天 · ' + (disp.length - 1 + (loopRt ? 0 : 1)) + ' 休整点';
        var altPeak = peakAlt();
        document.getElementById('chipMaxAlt').textContent = altPeak.alt;
        document.getElementById('chipMaxAlt').title = '最高点：' + altPeak.n + '（' + altPeak.alt + 'm）';
        // 视角复位
        fitAll();
        renderStations();
        renderWarnings();
        rebuildSpotKm();        // 景点胶囊/城名/城钉分级的里程基准（随出发地重算，S18/S26 共用表）
        renderSpotLabels();
        renderCityLabels();
        renderCityMarkers();
        // S28：行程卡默认态控件（住宿点入口等，就地编辑时代替原「编辑模式」注入）
        if (typeof Edit !== 'undefined' && Edit.refreshDayControls) Edit.refreshDayControls();
        renderRestMarkers();   // S31 休整点层（住宿/午休变动后随 renderAll 重建）
        try { renderDirSeg(); } catch (e) {}
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
        /* S26：按车型过滤——电车模式只看无充电段，油车模式只看无加油段 */
        var mode = 'ev';
        try { mode = window.__evMode || 'ev'; } catch (e) {}
        ws = ws.filter(function (w) { return (w.type || 'ev') === (mode === 'fuel' ? 'fuel' : 'ev'); });
        if (!ws.length) return;
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
                /* S33 减重：盲区段 大色块→红虚线警示（宽 6→3，去白描边）+ 单个胶囊标注 */
                styles: { default: ({ color: color, width: 3, dash: [7, 5], lineCap: 'round' }) },
                geometries: [{
                    id: 'warn' + wi, styleId: 'default',
                    paths: seg.map(function (t) { return LL(t[1], t[2]); })
                }]
            }));
            var mid = seg[Math.floor(seg.length / 2)];
            warnLabels.push(createLabelLayer({   /* S26：白底胶囊 + 加粗 + 高 z，不被钉/地名截断压盖 */
                map: map,
                zIndex: 145,
                styles: { default: ({ color: color, size: 11, bold: true, badge: true, offset: { x: 0, y: -18 } }) },
                geometries: [{
                    id: 'warnlb' + wi, position: LL(mid[1], mid[2]),
                    content: 'km' + Math.round(a) + '–' + Math.round(b) + ' ' + (w.label || '') + '（' + w.km + 'km）'
                }]
            }));
        });
    }

    /* ============ S31 「休整点」图层 ============
       成员 = 每天的住宿点（位置 = 天轨迹终点，名字 = stay 文本）+ kind=rest 的手动途经点。
       状态位重建模式（S0 教训）；归属/编号口径与行程卡三类行一致（merged 隐藏、可见序编号）。 */
    var restMarkers = null;
    var restData = [];
    function renderRestMarkers() {
        if (restMarkers) { restMarkers.setMap(null); restMarkers = null; }
        if (!restLayerOn) return;
        restData = [];
        var merged = (typeof Edit !== 'undefined' && Edit._mergedIds) ? Edit._mergedIds() : [];
        var vi = 0;
        DAYS.forEach(function (d) {
            if (merged.indexOf(d.id) >= 0) return;
            vi++;
            if (d.stay && d.path && d.path.length) {
                var p = d.path[d.path.length - 1];   // 住宿 = 当天到达端
                restData.push({ lat: p[0], lng: p[1], t: d.stay + '（住宿）', sub: 'D' + vi + ' · 住宿点' });
            }
        });
        if (typeof Wp !== 'undefined' && Wp && Wp.list) {
            Wp.list.forEach(function (w) {
                if (w.kind !== 'rest') return;
                restData.push({ lat: w.p[0], lng: w.p[1], t: w.n, sub: '☾ 休整点 · 途经点（待保存生效）' });
            });
        }
        restMarkers = createMarkerLayer({
            map: map,
            styles: { r: ({ src: IC_REST, width: 24, height: 24, anchor: { x: 12, y: 12 } }) },
            geometries: restData.map(function (r, i) {
                return { id: 'r' + i, styleId: 'r', position: LL(r.lat, r.lng) };
            })
        });
        restMarkers.on('click', function (e) {
            var r = restData[parseInt(e.geometry.id.slice(1), 10)];
            if (r) openInfo(r.lat, r.lng, [['☾ 休整点', 'c']], r.t, r.sub);
        });
    }

    var activeIdx = -1;
    /* S17：剖面把手「仅聚焦/手动展开常显」。聚焦 → 亮把手；返回全览 → 收起（不占布局）。
       由 fitAll/focusDay 两处驱动（含桌面——这是对桌面的小行为修正，docs §25 留痕）。 */
    function elevGripShow(on) {
        try {
            if (document.body && document.body.classList) document.body.classList.toggle('elev-hide', !on);
            if (typeof syncMapOccupy === 'function') syncMapOccupy();
        } catch (e) {}
    }
    function focusDay(i) {
        if (activeIdx === i) { fitAll(); return; } // 再点同一天 → 取消聚焦
        var d = DAYS[i];
        activeIdx = i;
        elevGripShow(true);
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
        var titleH = 0;   // S18：窄屏取景扣除标题条高度（fitAll 纵向居中同口径）

        if (panelEl && !panelEl.classList.contains('collapsed')) {
            var pr = panelEl.getBoundingClientRect();
            if (narrow) {
                // 窄屏：可见高度 = 视口 − 行程单抽屉露出的 peek（mobile.js 的 MOBILE_PEEK）− 标题条，宽度用整屏
                // S18：标题条（48px）压在地图顶部，取景时扣除，不再顶栏压图（桌面 titleH=0，零变化）
                titleH = 48;
                panelBottom = (typeof MOBILE_PEEK === 'number') ? MOBILE_PEEK : 112;
                h = vh - Math.max(panelBottom, 0) - 14 - titleH;
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
            narrow: narrow, titleH: titleH
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
        elevGripShow(false);   // S17：返回全览 → 剖面把手收起不占位（含桌面，docs §25 留痕）
        var listEl = document.getElementById('dayList');
        Array.prototype.forEach.call(listEl.children, function (li) { li.classList.remove('active'); });
        dayLines.forEach(function (pl) { if (pl) pl.setStyles({ default: NORMAL }); });

        // zoom：按"环线真实地理包围盒"装进"真正可见的像素区"反算，不再用经验常数。
        // 以前只吃容器高度 → 窄视口下路线被横向压扁、环线右侧出画。
        // S26：窄屏 padding 收紧（26→14），竖屏占比尽量吃满宽度口径。
        var box = visibleBox();
        var bbox = LOOP_BBOX[start] || LOOP_BBOX[STARTS[0].id];
        var z = zoomToFit(box, bbox, box.narrow ? 14 : 26);
        z = Math.max(4.5, Math.min(7.6, z));

        /* 中心点：让【环线包围盒】在【真正可见的矩形】里居中。
           注意不能写成"给 bbox 中心加一个像素偏量" —— 那是线性近似，
           在纬度高、跨度大时会偏（墨卡托纬度是非线性的，且地图容器的几何中心
           与"可见区中心"根本不是同一个点：地图容器高 = vh−抽屉，
           而窄屏下可见区是 [侧栏底, vh]）。
           正确做法：直接反解 —— 要把 bbox 的某个纬度对齐到屏幕某个 y。 */
        /* S26：中心解算独立成函数（midY 用真实容器高）；真机 AMap 渲染分数 zoom，
           solve==render 天然精确；headless 的取整 artifact 见 docs §18/§34 留痕 */
        var _fitBox = box, _fitBbox = bbox, _fitInfo = null;
        function solveCenter(zs) {
            var bboxMidLat = (_fitBbox.latMin + _fitBbox.latMax) / 2;
            var cx = bboxMidLat;
            var cy = (_fitBbox.lngMin + _fitBbox.lngMax) / 2;
            var pxPerDegLng = 256 * Math.pow(2, zs) / 360;
            var mapH = _fitBox.vh;
            try { var _mEl = document.getElementById('map'); if (_mEl && _mEl.clientHeight) mapH = _mEl.clientHeight; } catch (e) {}
            var midY = mapH / 2;
            _fitInfo = { mh: mapH, midY: midY, visMid: null };
            function mercY(lat) {
                var sn = Math.sin(lat * Math.PI / 180);
                return 0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI);
            }
            var ppxY = 256 * Math.pow(2, zs);
            if (_fitBox.narrow) {
                /* 可见区口径（S18 起 #map 高度 = 100vh − sheet-visible，容器底即抽屉顶）：
                   容器内 [标题条 + 6, 容器底 − 6]；容器底之外是抽屉，不是地图。
                   旧口径 visTop = panelBottom + titleH / visBot = vh − 6 把抽屉当浮层、
                   容器当全高，反解出的中心偏了一两百像素（真机"路线挤上半屏"的根源）。 */
                var visTop = (_fitBox.titleH || 0) + 6;
                var visBot = mapH - 6;
                var visMid = (visTop + visBot) / 2;
                _fitInfo.visMid = visMid;
                var mercTarget = mercY(bboxMidLat) + (midY - visMid) / ppxY;
                var n = Math.PI * (1 - 2 * mercTarget);
                cx = Math.atan(Math.sinh(n)) * 180 / Math.PI;
            } else if (_fitBox.panelRight > 0) {
                var shiftPx = ((_fitBox.panelRight + _fitBox.vw) / 2) - (_fitBox.vw / 2);
                cy -= shiftPx / pxPerDegLng;
            }
            return [cx, cy];   // cx=纬度 cy=经度
        }
        var _c0 = solveCenter(z);
        var cx = _c0[0], cy = _c0[1];

        // cx=纬度 cy=经度（引擎内部口径）；高德 center=[lng,lat]
        map.setZoomAndCenter(z, [cy, cx]);
        document.getElementById('curEnergy').textContent = '点选上方任意一天，看这段的海拔与能耗提示。';
        if (redraw !== false) drawProfile();
        // 全览落点记录：S16 移动端「全览」条件按钮的偏离判定基准（window 属性，桌面无副作用）
        try { window.__fitDebug = { z: z, c: [cx, cy], box: box, bbox: bbox, mh: _fitInfo ? _fitInfo.mh : 0, midY: _fitInfo ? _fitInfo.midY : 0, visMid: _fitInfo ? _fitInfo.visMid : 0 }; } catch (e) {}
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
        // S28：行程卡默认带就地编辑控件——任何出发地视角下都保持刷新（分段只在主视角可改，由 setSeg 守卫）
        if (typeof Edit !== 'undefined' && Edit.refreshDayControls) Edit.refreshDayControls();
    }
    renderStartButtons();
    /* S33 逆行方向切换（仅环线 ROUTE_META.loop !== false；单线 318 不显示） */
    function renderDirSeg() {
        var seg = document.getElementById('dirSeg');
        if (!seg) return;
        if (!isLoopRoute() || STARTS.length < 1) { seg.style.display = 'none'; return; }
        seg.style.display = 'inline-flex';   // CSS 默认 none，必须显式给值（空串会回落到 CSS 的 none）
        seg.innerHTML = '<button data-dir="1">顺时针</button><button data-dir="-1">逆时针</button>';
        Array.prototype.forEach.call(seg.querySelectorAll ? seg.querySelectorAll('button') : [], function (b) {
            if (!b.addEventListener || !b.getAttribute) return;
            if (b.classList) b.classList.toggle('on', +b.getAttribute('data-dir') === routeDir);
            b.addEventListener('click', function () { setRouteDir(+b.getAttribute('data-dir')); });
        });
    }

    /* --- 图层开关 ---
       tgFuel / tgEv 不绑到固定的 marker 变量上：它们控制的是【renderStations() 里
       动态重建的】dimEvM/dimFuelM，而每次重建都会 new 一个新的 MultiMarker →
       不能再持有旧引用。做法：开关只改一个状态位，然后触发重绘 → 重绘时按状态决定 setMap。 */
    // 站点图层开关：只记状态 + 重绘（重绘里会把新图层挂上/摘掉）
    /* S31 默认态（产品拍板）：主路线 + 城镇名 + 补给（两子开关开）+ 休整 = on；打卡 off。
       用户勾选记 localStorage（xlm.layers.<routeKey>），启动时覆盖默认。 */
    var layerOn = { fuel: true, ev: true };
    var restLayerOn = true;
    var LAYER_KEY = 'xlm.layers.' + ((typeof ROUTE_META !== 'undefined' && ROUTE_META && ROUTE_META.key) || 'default');
    function loadLayerPrefs() {
        try { return JSON.parse(localStorage.getItem(LAYER_KEY) || 'null') || null; } catch (e) { return null; }
    }
    function saveLayerPrefs() {
        try {
            localStorage.setItem(LAYER_KEY, JSON.stringify({
                ev: layerOn.ev, fuel: layerOn.fuel, rest: restLayerOn,
                spot: spotLabelOn, city: cityLabelOn, classic: !!(classicLine && document.getElementById('tgClassic') && document.getElementById('tgClassic').checked)
            }));
        } catch (e) {}
    }
    (function applyLayerPrefs() {
        var p = loadLayerPrefs();
        if (!p) return;
        if (p.ev != null) layerOn.ev = !!p.ev;
        if (p.fuel != null) layerOn.fuel = !!p.fuel;
        if (p.rest != null) restLayerOn = !!p.rest;
        if (p.spot != null) spotLabelOn = !!p.spot;
        if (p.city != null) { cityLabelOn = !!p.city; cityMarkerOn = !!p.city; }
        ['tgEv', 'tgFuel', 'tgRest', 'tgSpot', 'tgCity', 'tgClassic'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            if (id === 'tgEv') el.checked = layerOn.ev;
            else if (id === 'tgFuel') el.checked = layerOn.fuel;
            else if (id === 'tgRest') el.checked = restLayerOn;
            else if (id === 'tgSpot') el.checked = spotLabelOn;
            else if (id === 'tgCity') el.checked = cityLabelOn;
            else if (id === 'tgClassic') el.checked = !!p.classic;
        });
    })();
    document.getElementById('tgFuel').addEventListener('change', function (e) {
        layerOn.fuel = e.target.checked;
        saveLayerPrefs();
        renderStations();
    });
    document.getElementById('tgEv').addEventListener('change', function (e) {
        layerOn.ev = e.target.checked;
        saveLayerPrefs();
        renderStations();
    });
    /* S31 新「休整点」层：住宿点（天终点）+ kind=rest 途经点 */
    document.getElementById('tgRest').addEventListener('change', function (e) {
        restLayerOn = e.target.checked;
        saveLayerPrefs();
        renderRestMarkers();
    });
    document.getElementById('tgClassic').addEventListener('change', function (e) {
        saveLayerPrefs();
        if (classicLine) classicLine.setMap(e.target.checked ? map : null);
    });
    /* 更多 ▾：经典支线等低频层折叠 */
    (function bindLgMore() {
        var btn = document.getElementById('lgMoreBtn');
        var box = document.getElementById('lgMore');
        if (!btn || !box) return;
        btn.onclick = function () {
            var open = box.style.display === 'none';
            box.style.display = open ? '' : 'none';
            btn.textContent = open ? '更多 ▴' : '更多 ▾';
        };
    })();
    var tgCityEl = document.getElementById('tgCity');
    if (tgCityEl && tgCityEl.addEventListener) tgCityEl.addEventListener('change', function (e) {
        cityLabelOn = e.target.checked;
        cityMarkerOn = e.target.checked;
        saveLayerPrefs();
        renderCityLabels();
        renderCityMarkers();
    });
    var tgSpotEl = document.getElementById('tgSpot');
    if (tgSpotEl && tgSpotEl.addEventListener) tgSpotEl.addEventListener('change', function (e) {
        spotLabelOn = e.target.checked;
        saveLayerPrefs();
        spotMarkers.setMap(e.target.checked ? map : null);
        renderSpotLabels();
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
