/* ============================================================================
 * engine/planner.js — 续航规划 + 站点分级显示
 *
 * 平台化 S2 从 index.html 主脚本拆分而来（纯搬家 + 消硬编码，逻辑未重写）：
 *   - 站点 km 基准收进数据契约 ROUTE_STARTS[].stationKm0，引擎不认任何具体城市
 *   - 站点契约语义：STATION_DATA.ev/fuel = [] 表示「该线路未接入此类站点数据」
 *     （UI 显示"未接入"），与「已接入但某段真没站」（按真实缺口透出）严格区分
 * 依赖：route-engine.js 先加载（map / openInfo / layerOn / curStart 等）；
 * profile/ui 后加载，跨文件调用全部发生在运行时。
 * ========================================================================== */

    var evState = { mode: 'ev', range: 500, alt: true };

    /* ============ 站点显示分级（S0） ============
       背景：全量站点（数百个）在全览视角下会叠成一片色块。

       第一版想法是"按 zoom 分三档，远/中/近景显示不同图层"，**算完账发现是错的**：
       实测同一套屏幕去重算法在不同 zoom 下天然就能自动稀疏 ——
         z=5.5 → 70 个点 ｜ z=7.3 → 178 个点 ｜ z=11 → 332 个点
       真正的问题是旧代码【把去重按死在一个基准 zoom 上算了一次】，
       所以全览和拉到近景，看到的点一样多。

       修正后的方案 = 两件事：
       (1) 去重阈值随 zoom 连续变化（不看 zoom 的阶梯会产生"缩放时突然冒出一堆点"的跳变）
       (2) 按 zoom 做【语义筛选】—— 这是真正减噪的一层：
           全览时"哪里有加油站"是废话（高速服务区几十公里一个），
           "哪里能充电"才是这条线的核心信息。所以远景优先显充电站。

       注意：屏幕去重要用【当前 zoom】算，不能在别处按固定 zoom 算 ——
       否则拉近时点不增加（该密的还是稀的），拉远时点不减少（该稀的还是密的）。 */
    var Z_DIM_NEAR = 40;   // 远景去重阈值（px）：屏幕稀疏，只留代表性站
    var Z_DIM_FAR = 18;    // 近景去重阈值（px）：允许密集，小图标也留
    var Z_LO = 6, Z_HI = 10;   // 线性插值区间

    function dedupeMinPx(zoom) {
        if (zoom <= Z_LO) return Z_DIM_NEAR;
        if (zoom >= Z_HI) return Z_DIM_FAR;
        var t = (zoom - Z_LO) / (Z_HI - Z_LO);
        return Z_DIM_NEAR + (Z_DIM_FAR - Z_DIM_NEAR) * t;
    }

    /* 语义分层：给定 zoom，决定【是否显示加油站】以及【充电站的最低重要度】。
       重要度由 planCharging 的结果注入（必充站 > 覆盖率代表点 > 普通站）——
       引擎不知道"哪些站重要"，那是规划层算出来的，这里是消费方。
       返回 { fuel: bool, evOnlyPlanned: bool } */
    function zoomTier(zoom) {
        if (zoom < 7) return { tier: 'far', fuel: false, evOnlyPlanned: false, minPx: dedupeMinPx(zoom) };
        if (zoom < 9) return { tier: 'mid', fuel: true, evOnlyPlanned: false, minPx: dedupeMinPx(zoom) };
        return { tier: 'near', fuel: true, evOnlyPlanned: false, minPx: dedupeMinPx(zoom) };
    }

    /* 屏幕去重：同一片城区里十几个站，在 z≈7 时约 0.4km/px，落进同一像素就叠成"马赛克"。
       判据用【屏幕距离】而不是路线里程 —— 城区站 km 差 0.5 但可能横跨 3km 街面；
       反之戈壁上 km 差 8 却真在一条路上。必须以真实经纬度算。

       ⚠️ 实测发现的坑（S0）：纯按像素去重会留下【碰巧没撞车】的站，
       而不是【对自驾最有用的】站。z=5.5 时只剩 12 个点，出现 251km 的假空档，
       而这些点并没有任何"重要"的含义 —— 只是屏幕上没重叠而已。

       修法：去重时给每个站算一个【重要度权重】，同像素相撞时保留权重高的。
       权重由调用方注入（规划层知道"哪些站是必充站"），引擎不猜。
       没注入权重时退回旧规则（更贴路的优先），保持兼容。 */
    function dedupeByScreen(list, minPx, zoom) {
        var z = (zoom == null) ? 7.3 : zoom;
        var ppx = 256 * Math.pow(2, z) / 360;
        function mercY(lat) { var s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); }
        // 重要度：显式给的 w 优先；否则"更贴路"（d 小）当权重
        function wOf(s) { return (s.w != null) ? s.w : (9 - (s.d || 9)); }
        var kept = [];
        list.forEach(function (s) {
            var x = s.lng * ppx, y = mercY(s.lat) * 256 * Math.pow(2, z);
            for (var i = 0; i < kept.length; i++) {
                var k = kept[i];
                var dx = x - k.lng * ppx, dy = y - mercY(k.lat) * 256 * Math.pow(2, z);
                if (Math.sqrt(dx * dx + dy * dy) < minPx) {
                    if (wOf(s) > wOf(k)) kept[i] = s;
                    return;
                }
            }
            kept.push(s);
        });
        return kept;
    }

    /* ---------- 覆盖率代表点：远景稀疏时必须保证"每隔一段有个点" ⬅ S0 实测补的 ----------
       问题：纯屏幕去重在远景下会留下不成比例的点（城市密、荒漠几乎没有），
       实测 z=5.5 时最长空档被放大到 554km —— 用户会误判"前面 300km 没桩"，
       而实际最长无桩段只有 199.9km。**显示层放大了数据缺陷，这是不能接受的。**

       修法：远景不用"像素去重"的思路（那是为了防重叠），改用【里程网格选点】：
       每 gridKm 挑一个"最贴路"的站，直接进结果，**不再参与像素去重**。
       这保证任意两个显示点之间的里程间隔上界 ≈ gridKm（除非那一段真的没站）。

       阈值取 60km 的依据：车轮续航最低档 300km，60km 网格意味着
       任意方向上 2–3 个点就能覆盖一个"电量告警区间"，够用户判断可行性。 */
    function coveragePick(list, gridKm) {
        var grid = gridKm || 60;
        var buckets = {};
        list.forEach(function (s) {
            var b = Math.floor(s.km / grid);
            (buckets[b] = buckets[b] || []).push(s);
        });
        return Object.keys(buckets).map(function (b) {
            return buckets[b].slice().sort(function (a, c) { return (a.d || 9) - (c.d || 9); })[0];
        }).sort(function (a, c) { return a.km - c.km; });
    }

    /* 站点分两个口径，绝不能混：
       · stationsAll()  —— 全量，给【能耗规划】用。规划必须看到每个站，
                          去重会让它在城区误判成"有缺口"，算错必充点。
       · activeStations() —— 屏幕去重后，只给【地图打点】用，避免叠成马赛克。 */
    function stationsAll(mode) {
        var arr = mode === 'fuel' ? STATION_DATA.fuel : STATION_DATA.ev;
        // km 基准（S2 契约）：站点 km 是数据包自选的基准系，每个出发地声明自己行程起点
        // 在站点基准上的 km（stationKm0）；过滤 [起点, 起点+总里程] 并平移到行程基准。
        var cur = curStart();
        var lo = cur.stationKm0 || 0;
        var hi = lo + curTotal();
        var off = -lo;
        return arr.filter(function (s) { return s.km >= lo && s.km <= hi; })
            .map(function (s) {
                return { t: s.t, a: s.a, tel: s.tel, lat: s.lat, lng: s.lng, km: +(s.km + off).toFixed(1), d: s.d };
            })
            .sort(function (a, b) { return a.km - b.km; });
    }

    /* 站点契约（S2）：ev/fuel = [] 表示「该线路未接入此类站点数据」——
       与「已接入但某段真没站」严格区分：前者 UI 显示"未接入"且不产出规划，
       后者按真实缺口透出（无桩段警告/最长间隔）。 */
    function stationsConnected(mode) {
        return !!(typeof STATION_DATA !== 'undefined' && STATION_DATA && STATION_DATA[mode] && STATION_DATA[mode].length);
    }

    /* 当前出发地可用站点（km 平移到当前基准）+ 按【当前 zoom】屏幕去重。
       planKeys：可选，规划层算出的必充/必加站（key = t|km.1）。传了就享受最高权重，
       保证"必充站"在任何缩放下都不会被别的站挤掉 —— 它是这一屏最重要的信息。

       两段式（S0 实测后确定）：
         ① 覆盖率代表点：按 60km 网格选，直接入选，不参与像素去重
            → 保证"任意方向 2–3 个点覆盖一个告警区间"，远景不会出现假空档
         ② 其余站：走像素去重，权重 = 必充站(10) > 普通站(1)，
            同像素相撞时保留权重高的 → 城区不会叠成马赛克，必充站不会被挤掉 */
    function activeStations(mode, zoom, planKeys) {
        var z = (zoom == null) ? 7.3 : zoom;
        var all = stationsAll(mode);
        var minPx = dedupeMinPx(z);

        // ① 覆盖率代表点：直接入选，**不进像素去重**
        //    实测教训：把锚点也送去去重，40px 阈值在 z=5.5 时约等于 120km 实地距离，
        //    60km 一个的锚点会互相吃掉 —— 空档仍是 305km，等于没修。
        //    锚点的职责是"保证里程覆盖"，与"防止屏幕重叠"是两件事，必须分开处理：
        //    先按里程铺锚点，再把非锚点站按像素去重补进去，最后合并去重（只对坐标相同的）。
        var anchors = coveragePick(all, 60);
        var anchorKey = {};
        var picked = anchors.map(function (s) {
            anchorKey[s.t + '|' + s.km.toFixed(1)] = 1;
            var o = {};
            for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) o[k] = s[k];
            o.w = 5;
            return o;
        });

        // ② 其余站走像素去重（把锚点从候选里排除，避免同一站打两次）
        var rest = all.filter(function (s) { return !anchorKey[s.t + '|' + s.km.toFixed(1)]; })
            .map(function (s) {
                var key = s.t + '|' + s.km.toFixed(1);
                var o = {};
                for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) o[k] = s[k];
                o.w = (planKeys && planKeys[key]) ? 10 : 1;
                return o;
            });
        var keptRest = dedupeByScreen(rest, minPx, z);

        // ③ 合并。锚点之间不判重（已按里程网格隔开），锚点与普通站之间判重：
        //    普通站落在锚点 6px 内就丢掉，避免锚点旁边叠一个几乎重合的点。
        var merged = picked.slice();
        keptRest.forEach(function (s) {
            var dup = false;
            for (var i = 0; i < merged.length; i++) {
                var d = screenDist(s, merged[i], z);
                if (d < 6) { dup = true; break; }
            }
            if (!dup) merged.push(s);
        });
        return merged.map(function (s) {
            if (s.w == null) return s;
            var o = {};
            for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k) && k !== 'w') o[k] = s[k];
            return o;
        }).sort(function (a, b) { return a.km - b.km; });
    }

    /* 两点在给定 zoom 下的屏幕像素距离（墨卡托） */
    function screenDist(a, b, zoom) {
        var z = (zoom == null) ? 7.3 : zoom;
        var ppx = 256 * Math.pow(2, z) / 360;
        function my(lat) { var s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); }
        var dx = (a.lng - b.lng) * ppx;
        var dy = (my(a.lat) - my(b.lat)) * 256 * Math.pow(2, z);
        return Math.sqrt(dx * dx + dy * dy);
    }

    function curTotal() {
        return STARTS[0].totalKm + (curStart().offsetKm || 0);
    }

    function dayOf(km) {
        // 站点 km（stationsAll 已平移到当前出发地行程基准）与 DAYS[].altKm 同基准，直接比对
        for (var i = 0; i < DAYS.length; i++) {
            var d = DAYS[i];
            if (d.altKm && km >= d.altKm[0] && km <= d.altKm[1]) return d.id;
        }
        return '?';
    }

    /* 规划：满电出发，剩余 30% 红线，贪心找必充站 */
    function planCharging() {
        var mode = evState.mode;
        var R = evState.range * (evState.alt ? 0.85 : 1);
        var TH = 0.30;
        var total = curTotal();
        // 规划用全量站点（不能用屏幕去重后的 —— 会误判城区为缺口）
        var stops = stationsAll(mode);
        // 未接入站点数据：不产出规划（空数组 ≠ 全程无需补能，由面板如实透出）
        if (!stops.length) return [];
        var plan = [];
        var pos = 0, soc = 1.0, idx = 0;
        // guard 防死循环：上限与站点数挂钩——固定 80 次会把 280+ 站的长线规划
        // 中途截断（S4 实测：站点多的长线会被截成「全程只需充电 1 次」）
        var guard = 0, guardMax = stops.length * 2 + 50;
        while (pos < total - 1 && guard++ < guardMax) {
            var next = stops[idx] || null;
            var dNext = (next ? next.km : total) - pos;
            var canGo = (soc - TH) * R;
            if (dNext <= canGo) {
                soc -= dNext / R;
                pos += dNext;
                if (!next) break;
                var nn = stops[idx + 1];
                var nd = (nn ? nn.km : total) - pos;
                if (nd > (soc - TH) * R) {
                    var target = nd / R > 0.5 ? 1.0 : 0.8;
                    plan.push({ st: next, arrive: soc, target: target });
                    soc = target;
                }
                idx++;
            } else {
                // 到不了下一节点：回找可达范围内最后一个站
                // （S1.5 探针发现：站点为空数组时 stops[j] 可能 undefined，需守卫，否则整页崩）
                var j = idx, found = -1;
                while (j >= 0 && stops[j] && stops[j].km > pos) {
                    if (stops[j].km - pos <= canGo) { found = j; break; }
                    j--;
                }
                if (found < 0) {
                    plan.push({ warn: '距起点 ' + Math.round(pos) + ' km 处，剩余 ' + Math.round(soc * 100) + '% 但无可达' + (mode === 'fuel' ? '加油站' : '充电站') + '——请降低能耗或更改路线' });
                    break;
                }
                var st = stops[found];
                soc -= (st.km - pos) / R;
                pos = st.km;
                var nn2 = stops[idx];
                var nd2 = (nn2 ? nn2.km : total) - pos;
                var target2 = nd2 / R > 0.5 ? 1.0 : 0.8;
                plan.push({ st: st, arrive: soc, target: target2, force: true });
                soc = target2;
                idx = found + 1;
            }
        }
        return plan;
    }

    /* --- 图标：弱化层（半透明）+ 计划层（大号橙环） --- */
    function pinDim(fill) {
        return icon('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="32" viewBox="0 0 24 32"><path d="M12 1C5.9 1 1 5.9 1 12c0 8 11 19 11 19s11-11 11-19C23 5.9 18.1 1 12 1z" fill="' + fill + '" fill-opacity="0.42" stroke="#fff" stroke-width="1.6"/><circle cx="12" cy="12" r="4.2" fill="#fff" fill-opacity="0.75"/></svg>');
    }
    function circleDim(color) {
        return icon('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30"><circle cx="15" cy="15" r="13.5" fill="' + color + '" fill-opacity="0.42" stroke="#fff" stroke-width="2.2"/>' + (color === '#16a34a' ? '<path d="M16.6 6.5L10 16.8h4.2l-1.2 6.7 6.8-10.5h-4.4l1.2-6.5z" fill="#fff" fill-opacity="0.8"/>' : '<rect x="10.5" y="9" width="5.5" height="11" rx="1.2" fill="#fff" fill-opacity="0.8"/>') + '</svg>');
    }
    var IC_PLAN = {
        ev: icon('<svg xmlns="http://www.w3.org/2000/svg" width="38" height="38" viewBox="0 0 38 38"><circle cx="19" cy="19" r="16.5" fill="#16a34a" stroke="#ea580c" stroke-width="3.5"/><path d="M21.2 9L12.8 21.5h5l-1.4 8 8-12.4h-5.2L21.2 9z" fill="#fff"/></svg>'),
        fuel: icon('<svg xmlns="http://www.w3.org/2000/svg" width="38" height="38" viewBox="0 0 38 38"><circle cx="19" cy="19" r="16.5" fill="#dc2626" stroke="#ea580c" stroke-width="3.5"/><rect x="12" y="10.5" width="8.5" height="16" rx="1.8" fill="#fff"/><rect x="14" y="13" width="4.4" height="4" rx="0.7" fill="#dc2626"/></svg>')
    };
    var dimEvM = null, dimFuelM = null, planM = null, planLb = null;
    var dimLabelEv = null, dimLabelFuel = null;   // 站点近景文字层（体验修复 3）
    var NEAR_LABEL_Z = 10;   // 站名文字从此 zoom 开始出现：与 S0 的 near 档（z≥9）协同，不另起一套
    var dimDataEv = [], dimDataFuel = [], planData = [];

    function clearLayer(l) { if (l) l.setMap(null); return null; }

    /* 站点来源透出（S4）：信息窗标注数据来源 + 快照日期（STATION_DATA.sourceShort/builtAt） */
    function stationSourceNote() {
        if (typeof STATION_DATA === 'undefined' || !STATION_DATA || !STATION_DATA.builtAt) return '';
        var short = STATION_DATA.sourceShort ||
            ((STATION_DATA.source || '').split('（')[0] || 'POI 数据');
        return '<br><span style="color:#94a3b8;font-size:10.5px">' + short + ' · ' + STATION_DATA.builtAt + '</span>';
    }

    /* 当前地图 zoom（腾讯 GL JS 的 getZoom 在动画中是瞬时值，够用） */
    function getMapZoom() {
        try { if (typeof map.getZoom === 'function') return map.getZoom(); } catch (e) {}
        return 7.3;
    }

    function renderStations() {
        dimEvM = clearLayer(dimEvM);
        dimFuelM = clearLayer(dimFuelM);
        planM = clearLayer(planM);
        planLb = clearLayer(planLb);
        dimLabelEv = clearLayer(dimLabelEv);
        dimLabelFuel = clearLayer(dimLabelFuel);
        if (!STATION_DATA) return;
        // 图层开关由 layerOn 状态决定（开关不再持有 marker 引用，见 route-engine 开关段）
        var onEv = (typeof layerOn === 'undefined') || layerOn.ev;
        var onFuel = (typeof layerOn === 'undefined') || layerOn.fuel;

        var plan = planCharging();
        var planKeys = {};
        plan.forEach(function (p) { if (p.st) planKeys[p.st.t + '|' + p.st.km.toFixed(1)] = p; });

        /* 分级：按【当前 zoom】决定去重阈值和显示范围。
           这是 S0 的核心 —— 全览时点自动稀疏（少而准），
           拉近时点自动变密（近景要看到城区里的每个桩）。 */
        var z = getMapZoom();
        var tier = zoomTier(z);

        // 分级提示：加油站被自动隐藏时说明原因（否则用户以为图层开关坏了）
        var hintEl = document.getElementById('fuelTierHint');
        if (hintEl) {
            hintEl.textContent = tier.fuel ? '' : '（放大后显示）';
        }

        // 弱化层（非计划站点）。planKeys 传下去让"必充站"享受最高去重权重，
        // 否则远景下它可能被一个普通站挤出屏幕 —— 那是最不能丢的信息。
        dimDataEv = onEv
            ? activeStations('ev', z, planKeys).filter(function (s) { return !planKeys[s.t + '|' + s.km.toFixed(1)]; })
            : [];
        // 远景不显示加油站：全览时"哪里有加油站"信息量极低（高速几十公里一个），
        // 显出来只会跟充电站抢视觉权重，把"这段能不能充上电"这个核心信息淹掉。
        dimDataFuel = (tier.fuel && onFuel)
            ? activeStations('fuel', z, planKeys).filter(function (s) { return !planKeys[s.t + '|' + s.km.toFixed(1)]; })
            : [];
        dimEvM = createMarkerLayer({
            map: onEv ? map : null,
            styles: { d: ({ src: circleDim('#16a34a'), width: 24, height: 24, anchor: { x: 12, y: 12 } }) },
            geometries: dimDataEv.map(function (s, i) {
                return { id: 'd' + i, styleId: 'd', position: LL(s.lat, s.lng) };
            })
        });
        dimEvM.on('click', function (e) {
            var s = dimDataEv[parseInt(e.geometry.id.slice(1), 10)];
            if (s) openInfo(s.lat, s.lng, [['⚡ 充电站', 'e']], s.t, s.a + (s.tel ? '<br>☎ ' + s.tel : '') + stationSourceNote());
        });
        dimFuelM = createMarkerLayer({
            map: (tier.fuel && onFuel) ? map : null,
            styles: { d: ({ src: circleDim('#dc2626'), width: 24, height: 24, anchor: { x: 12, y: 12 } }) },
            geometries: dimDataFuel.map(function (s, i) {
                return { id: 'd' + i, styleId: 'd', position: LL(s.lat, s.lng) };
            })
        });
        dimFuelM.on('click', function (e) {
            var s = dimDataFuel[parseInt(e.geometry.id.slice(1), 10)];
            if (s) openInfo(s.lat, s.lng, [['⛽ 加油站', 'f']], s.t, s.a + (s.tel ? '<br>☎ ' + s.tel : '') + stationSourceNote());
        });

        // 计划层（必充/必加站）
        planData = plan.filter(function (p) { return p.st; });
        var isFuel = evState.mode === 'fuel';
        /* S17：手机全览（窄容器 + 远景 z<7，口径与景点胶囊一致）收起必充/必加标注——
           国家缩放级别只留极少量信息；近景或聚焦天（fly 后 z 必然 ≥7）自动恢复，
           规划结果仍有 #planPeek 概要行兜底，信息不丢。 */
        var mapW = 0;
        try { var mEl = document.getElementById('map'); mapW = (mEl && mEl.clientWidth) || 0; } catch (e) {}
        var hidePlanFar = mapW > 0 && mapW < 700 && z < 7;
        try { window.__planFarHidden = hidePlanFar; } catch (e) {}   // S17 测试钩子：规划标注远景收起状态
        planM = createMarkerLayer({
            map: hidePlanFar ? null : map,
            styles: { p: ({ src: IC_PLAN[isFuel ? 'fuel' : 'ev'], width: 38, height: 38, anchor: { x: 19, y: 19 } }) },
            geometries: planData.map(function (p, i) {
                return { id: 'p' + i, styleId: 'p', position: LL(p.st.lat, p.st.lng) };
            })
        });
        planM.on('click', function (e) {
            var i = parseInt(e.geometry.id.slice(1), 10);
            var p = planData[i];
            openInfo(p.st.lat, p.st.lng, [[isFuel ? '⛽ 必加站' : '⚡ 必充站', isFuel ? 'f' : 'e']], p.st.t,
                p.st.a + (p.st.tel ? '<br>☎ ' + p.st.tel : '') + stationSourceNote() +
                '<br><b style="color:#ea580c">D' + dayOf(p.st.km) + ' · 到达剩 ' + Math.round(p.arrive * 100) + '% · ' + (isFuel ? '建议加满' : '建议充至 ' + Math.round(p.target * 100) + '%') + '</b>');
        });
        planLb = createLabelLayer({
            map: hidePlanFar ? null : map,
            styles: { p: ({ color: '#c2410c', size: 11, offset: { x: 0, y: -26 } }) },
            geometries: planData.map(function (p, i) {
                var isF = evState.mode === 'fuel';
                return { id: 'pl' + i, position: LL(p.st.lat, p.st.lng), content: '▲ ' + (isF ? '加满' : '充至 ' + Math.round(p.target * 100) + '%') };
            })
        });

        /* 标签层级（体验修复 3）第三级：站点图标是主表达，站名文字只在近景出现。
           缩放变化会触发本函数重建（S0 的防抖重绘），不需要额外监听。
           站名截断到 10 字 + 省略号，白字描边压底图，跟随各自图层开关。 */
        if (z >= NEAR_LABEL_Z) {
            dimLabelEv = createLabelLayer({
                map: onEv ? map : null,
                zIndex: 110,
                styles: { default: ({ color: '#15803d', size: 10, halo: true, offset: { x: 0, y: 13 } }) },
                geometries: dimDataEv.map(function (s, i) {
                    return { id: 'el' + i, position: LL(s.lat, s.lng), content: s.t.length > 10 ? s.t.slice(0, 10) + '…' : s.t };
                })
            });
            dimLabelFuel = createLabelLayer({
                map: onFuel ? map : null,
                zIndex: 110,
                styles: { default: ({ color: '#b91c1c', size: 10, halo: true, offset: { x: 0, y: 13 } }) },
                geometries: dimDataFuel.map(function (s, i) {
                    return { id: 'fl' + i, position: LL(s.lat, s.lng), content: s.t.length > 10 ? s.t.slice(0, 10) + '…' : s.t };
                })
            });
        }

        renderPlanPanel(plan);
    }

    /* ============ S0：地图缩放 → 站点分级重绘 ============
       为什么需要这一段：站点去重阈值现在依赖 zoom，但地图 zoom 变了必须【主动重算】，
       否则拉近时点不增加（该密的还是稀的）、拉远时点不减少（该稀的还是密的）。

       但【不能每帧都重建图层】—— MultiMarker 是整层重建，拖动/滚轮一次会产生几十个 zoom 事件，
       每帧重建会卡。所以：
       ① 只在"跨过阈值分界"时才换档（far/mid/near），同档内不做语义变化
       ② 同档内 zoom 变了也要重算（点在屏幕上会散开），但用 120ms 防抖
       ③ 还要判"zoom 变化量是否够大" —— 抖动 0.01 级别不值得重建 */
    var _lastZoomForStations = null;
    var _zoomTimer = null;
    var Z_REDRAW_EPS = 0.25;   // zoom 变化小于这个值不重绘（避免滚轮微抖就整层重建）

    function onStationsZoomChange() {
        var z = getMapZoom();
        if (_lastZoomForStations != null &&
            Math.abs(z - _lastZoomForStations) < Z_REDRAW_EPS &&
            zoomTier(z).tier === zoomTier(_lastZoomForStations).tier) return;
        if (_zoomTimer) clearTimeout(_zoomTimer);
        _zoomTimer = setTimeout(function () {
            _zoomTimer = null;
            _lastZoomForStations = getMapZoom();
            renderStations();
            // 同一条防抖链顺带刷新景点胶囊分级（不另起监听，S0 复用）
            if (typeof renderSpotLabels === 'function') renderSpotLabels(_lastZoomForStations);
            if (typeof renderCityLabels === 'function') renderCityLabels(_lastZoomForStations);
            if (typeof renderCityMarkers === 'function') renderCityMarkers(_lastZoomForStations);
        }, 120);
    }
    if (typeof map.on === 'function') {
        try { map.on('zoomchange', onStationsZoomChange); } catch (e) {}
        // 拖动结束也要补一次（视野动画结束后 zoom 才稳定）
        try { map.on('moveend', onStationsZoomChange); } catch (e) {}
    }

    function renderPlanPanel(plan) {
        var box = document.getElementById('planBox');
        if (!box) return;
        var isFuel = evState.mode === 'fuel';
        var lb = isFuel ? '加油' : '充电';
        // 未接入站点数据：如实透出，不产出"满电即可跑完全程"这类无据结论
        if (!stationsConnected(isFuel ? 'fuel' : 'ev')) {
            box.innerHTML = '<div class="psum">该线路未接入' + lb + '站数据</div>' +
                '<div class="prow">续航规划不可用。站点数据接入后，这里会给出全程补能规划与最长无' + lb + '间隔。</div>';
            return;
        }
        // 最长连续缺口统计也走全量：去重后算出的缺口是假的
        var stops = stationsAll(isFuel ? 'fuel' : 'ev');
        var total = curTotal();
        var maxGap = 0, prev = 0;
        stops.forEach(function (s) { maxGap = Math.max(maxGap, s.km - prev); prev = s.km; });
        maxGap = Math.max(maxGap, total - prev);
        var n = plan.filter(function (p) { return p.st; }).length;
        /* 同一组现有数据同时喂两处：桌面 planBox（HTML，逐字不变）+ 移动端 peek 概要行（纯文本） */
        var peekEl = document.getElementById('planPeek');
        if (peekEl) peekEl.textContent = (evState.alt ? '高原折算后有效续航 ' + Math.round(evState.range * 0.85) + ' km · ' : '') +
            '全程需' + lb + ' ' + n + ' 次 · 最长无' + lb + '间隔 ' + Math.round(maxGap) + ' km';
        var html = '<div class="psum">' + (evState.alt ? '高原折算后有效续航 ' + Math.round(evState.range * 0.85) + ' km · ' : '') +
            '全程需' + lb + ' <b>' + n + '</b> 次 · 最长无' + lb + '间隔 ' + Math.round(maxGap) + ' km</div>';
        html += plan.map(function (p) {
            if (p.warn) return '<div class="warn">⚠️ ' + p.warn + '</div>';
            return '<div class="prow"><b>D' + dayOf(p.st.km) + '</b>' + p.st.t +
                '<span>到达剩 ' + Math.round(p.arrive * 100) + '% → ' + (isFuel ? '加满' : '充至 ' + Math.round(p.target * 100) + '%') + '</span></div>';
        }).join('');
        if (!plan.length) html += '<div class="prow">满电即可跑完全程，中途无需' + lb + '。</div>';
        box.innerHTML = html;
    }

    /* --- 设置卡事件 --- */
    function bindEvCard() {
        var rng = document.getElementById('rngRange');
        var val = document.getElementById('rngVal');
        rng.oninput = function () {
            evState.range = +rng.value;
            val.textContent = rng.value;
            renderStations();
        };
        document.getElementById('ckAlt').onchange = function (e) {
            evState.alt = e.target.checked;
            renderStations();
        };
        document.getElementById('btnEv').onclick = function () { setMode('ev'); };
        document.getElementById('btnFuel').onclick = function () { setMode('fuel'); };
        function setMode(m) {
            evState.mode = m;
            document.getElementById('btnEv').classList.toggle('on', m === 'ev');
            document.getElementById('btnFuel').classList.toggle('on', m === 'fuel');
            // 移动端标题条上的车型小开关跟随高亮（S16，节点可能不存在）
            ['mobEv', 'mobFuel'].forEach(function (id, i) {
                var b = document.getElementById(id);
                if (b && b.classList) b.classList.toggle('on', (i === 0 ? 'ev' : 'fuel') === m);
            });
            document.getElementById('rngLabel').textContent = m === 'fuel' ? '满油续航' : '满电续航';
            try { window.__evMode = m; } catch (e) {}   // S26：盲区标注按车型过滤
            renderStations();
            if (typeof renderWarnings === 'function') renderWarnings();
        }
    }
