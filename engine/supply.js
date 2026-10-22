/* ============================================================================
 * engine/supply.js — S36 屏四：沿线补给（跟随行程 / 我的指定）
 *
 * 数据：designated = [{c:'ev'|'fuel', i:STATION_DATA 下标, t:站名}]，
 * 持久化 localStorage「xlm.stations.<ROUTE_META.key>」（v:1）。
 * 加载校验：STATION_DATA[c][i].t !== t 视为数据重建残留，丢弃。
 * 状态变化即写盘 + 触发 renderStations()（地图只画指定站，0 条=跟随行程现状逻辑）。
 *
 * UI：#supSheet 底部毛玻璃抽屉（body.mob-sup 驱动，仅移动断点有意义；桌面 CSS 不显示）。
 * 头行「沿线补给」+ seg2（跟随行程 | 我的指定，N≥1 带琥珀角标并自动切过去）；
 * 筛选「全部 | ⚡充电(内嵌 仅快充) | ⛽加油」；列表 15km 走廊、km 升序=行程前方顺序，
 * 按程分组；行尾「设为补给 / ✓ 已指定」即点即生效；点站名飞地图。
 * 指定 ≥1 时抽屉顶部横幅「已指定 N 站 · 其他补给点已隐藏」+「恢复跟随」一键清空。
 *
 * 对外：window.__sup {open, close, isOpen, list, count, designate, clear}
 *      window.__supOpen（mobile.js #mobSup 的既有接线）。
 * 互斥：open() 关 mob-layers/mob-menu/mob-plan；那三个打开时关本抽屉（mobile.js 侧）。
 * 依赖：planner.js（stationsAll/curTotal）、route-engine.js（curStart/dayIdxOfKm/dayTagOf/map），
 * 全部运行期调用，加载期无交叉；mock 环境（无 localStorage/假 DOM）全程不抛错。
 * ========================================================================== */

(function () {
    var ROUTE_KEY = (typeof ROUTE_META !== 'undefined' && ROUTE_META && ROUTE_META.key) || 'default';
    var STORE_KEY = 'xlm.stations.' + ROUTE_KEY;
    var CORRIDOR_KM = 15;   // 列表走廊口径（独立于天卡归属的 35km）

    /* ==================== 数据与持久化 ==================== */
    var designated = [];

    function validDes(d) {
        try {
            return typeof STATION_DATA !== 'undefined' && STATION_DATA && STATION_DATA[d.c] &&
                STATION_DATA[d.c][d.i] && STATION_DATA[d.c][d.i].t === d.t;
        } catch (e) { return false; }
    }
    function load() {
        designated = [];
        try {
            var raw = (typeof localStorage !== 'undefined' && localStorage) ? localStorage.getItem(STORE_KEY) : null;
            var obj = raw ? JSON.parse(raw) : null;
            if (obj && obj.v === 1 && Array.isArray(obj.designated)) {
                obj.designated.forEach(function (d) {
                    if (d && (d.c === 'ev' || d.c === 'fuel') && typeof d.i === 'number' && validDes(d)) {
                        designated.push({ c: d.c, i: d.i, t: d.t });
                    }
                });
            }
        } catch (e) {}
    }
    function save() {
        try {
            if (typeof localStorage !== 'undefined' && localStorage) {
                localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, designated: designated }));
            }
        } catch (e) {}
    }
    load();

    function isDes(c, i) {
        for (var k = 0; k < designated.length; k++) {
            if (designated[k].c === c && designated[k].i === i) return k;
        }
        return -1;
    }
    /* 解析指定 → 实时站对象（含平移后 km），地图与「我的指定」页签共用 */
    function desLive() {
        var out = [];
        var off = 0;
        try { off = (typeof curStart === 'function' && curStart().stationKm0) || 0; } catch (e) {}
        designated.forEach(function (d) {
            if (!validDes(d)) return;
            var s = STATION_DATA[d.c][d.i];
            out.push({
                c: d.c, i: d.i, t: s.t, a: s.a, tel: s.tel,
                lat: s.lat, lng: s.lng,
                km: +(s.km - off).toFixed(1), d: s.d, slow: s.slow
            });
        });
        out.sort(function (a, b) { return a.km - b.km; });
        return out;
    }
    /* 走廊列表（15km 口径，保留原始下标 i） */
    function corridor() {
        var out = [];
        try {
            if (typeof STATION_DATA === 'undefined' || !STATION_DATA) return out;
            var lo = 0, total = 0;
            try { lo = (typeof curStart === 'function' && curStart().stationKm0) || 0; } catch (e) {}
            try { total = (typeof curTotal === 'function') ? curTotal() : 0; } catch (e) {}
            ['ev', 'fuel'].forEach(function (c) {
                (STATION_DATA[c] || []).forEach(function (s, i) {
                    if (s.km < lo || s.km > lo + total) return;
                    if ((s.d == null ? 99 : s.d) > CORRIDOR_KM) return;
                    out.push({
                        c: c, i: i, t: s.t, a: s.a, tel: s.tel,
                        lat: s.lat, lng: s.lng,
                        km: +(s.km - lo).toFixed(1), d: s.d, slow: s.slow
                    });
                });
            });
            out.sort(function (a, b) { return a.km - b.km; });
        } catch (e) {}
        return out;
    }

    /* ==================== 状态操作（写盘 + 刷地图 + 刷抽屉） ==================== */
    function refreshMap() {
        try { if (typeof renderStations === 'function') renderStations(); } catch (e) {}
    }
    function designate(c, i) {
        try {
            var k = isDes(c, i);
            if (k >= 0) designated.splice(k, 1);
            else if (STATION_DATA && STATION_DATA[c] && STATION_DATA[c][i]) {
                designated.push({ c: c, i: i, t: STATION_DATA[c][i].t });
            }
        } catch (e) {}
        save();
        refreshMap();
        render(true);
    }
    function clearAll() {
        if (!designated.length) return;
        designated = [];
        save();
        refreshMap();
        render(true);
    }

    /* ==================== 抽屉 DOM ==================== */
    var built = false;
    var sheet = null;
    var tab = 'follow';        // 'follow' | 'mine'（手动切；自动切换只发生在 open/指定动作）
    var filterMode = 'all';    // 'all' | 'ev' | 'fuel'
    var fastOnly = false;      // 仅快充（只对充电类有意义）

    function el(tag, id, cls, html) {
        var e = document.createElement(tag);
        if (id) e.id = id;
        if (cls) e.className = cls;
        if (html != null) e.innerHTML = html;
        return e;
    }
    function esc(t) {
        return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }
    function bodyCls(on) {
        var b = document.body;
        if (b && b.classList) {
            b.classList.toggle('mob-sup', on);
            if (on) {   // 互斥：开一个关其余
                b.classList.remove('mob-layers');
                b.classList.remove('mob-menu');
                b.classList.remove('mob-plan');
            }
        }
    }

    function build() {
        if (built) return;
        built = true;
        var bk = el('div', 'supBk');
        bk.onclick = function () { close(); };
        sheet = el('div', 'supSheet');
        sheet.innerHTML =
            '<div class="sup-grip" id="supGrip"></div>' +
            '<div class="sup-head"><b>沿线补给</b>' +
            '<span class="sup-seg2">' +
            '<span id="supSegFollow" class="on">跟随行程</span>' +
            '<span id="supSegMine">我的指定<em id="supBadge" style="display:none">0</em></span>' +
            '</span>' +
            '<button id="supClose" type="button">✕</button></div>' +
            '<div class="sup-ban" id="supBan" style="display:none">' +
            '<div><div class="t" id="supBanT"></div>' +
            '<div class="m">规划与行中的地图都只画这几站</div></div>' +
            '<span class="u" id="supReset">恢复跟随</span></div>' +
            '<div class="sup-flt" id="supFlt"></div>' +
            '<div class="sup-note" id="supNote"></div>' +
            '<div class="sup-list" id="supList"></div>';
        if (document.body && typeof document.body.appendChild === 'function') {
            document.body.appendChild(bk);
            document.body.appendChild(sheet);
        }
        /* 事件接线（getElementById：mock 下挂到假元素，真机挂真节点） */
        var g = function (id) { return document.getElementById(id); };
        var grip = g('supGrip'); if (grip) grip.onclick = function () { close(); };
        var x = g('supClose'); if (x) x.onclick = function () { close(); };
        var segF = g('supSegFollow'); if (segF) segF.onclick = function () { tab = 'follow'; render(false); };
        var segM = g('supSegMine'); if (segM) segM.onclick = function () { tab = 'mine'; render(false); };
        var rst = g('supReset'); if (rst) rst.onclick = function () { clearAll(); };
        var flt = g('supFlt');
        if (flt) flt.onclick = function (e) {
            var t = e.target;
            if (!t || !t.getAttribute) return;
            var f = t.getAttribute('data-f');
            if (!f) return;
            if (f === 'fast') {                       // 充电钮内侧小字：充电 + 仅快充
                fastOnly = !fastOnly;
                if (fastOnly) filterMode = 'ev';
            } else if (f === 'ev') {
                if (filterMode === 'ev' && !fastOnly) filterMode = 'all';
                else { filterMode = 'ev'; fastOnly = false; }
            } else if (f === 'fuel') {
                filterMode = (filterMode === 'fuel') ? 'all' : 'fuel';
                if (filterMode !== 'ev') fastOnly = false;
            } else { filterMode = 'all'; fastOnly = false; }
            render(false);
        };
        var list = g('supList');
        if (list) list.onclick = function (e) {
            var t = e.target;
            if (!t || !t.getAttribute) return;
            var c = t.getAttribute('data-c'), i = t.getAttribute('data-i');
            if (c == null || i == null) return;
            try { i = parseInt(i, 10); } catch (er) { return; }
            if (t.className && t.className.indexOf('act') >= 0) { designate(c, i); return; }
            if (t.className && t.className.indexOf('nm') >= 0) {   // 点站名 → 飞到该站
                try {
                    var arr = desLive().concat(corridor());
                    for (var k = 0; k < arr.length; k++) {
                        if (arr[k].c === c && arr[k].i === i) { flyTo(arr[k]); break; }
                    }
                } catch (er) {}
            }
        };
    }

    function flyTo(s) {
        try {
            var z = 12;
            try { if (typeof map !== 'undefined' && map && typeof map.getZoom === 'function') z = Math.max(map.getZoom() | 0, 12); } catch (e) {}
            if (typeof map !== 'undefined' && map && typeof map.setZoomAndCenter === 'function') {
                map.setZoomAndCenter(z, [s.lng, s.lat]);
            }
        } catch (e) {}
    }

    function metaOf(s) {
        var dist = '距线 ' + (s.d == null ? '—' : s.d) + 'km';
        var kmTxt = '累计 ' + Math.round(s.km) + 'km';
        if (s.c === 'ev') return (s.slow ? '慢充' : '快充') + ' · ' + dist + ' · ' + kmTxt;
        return dist + ' · ' + kmTxt;
    }
    function rowHtml(s) {
        var on = isDes(s.c, s.i) >= 0;
        return '<div class="stn"><span class="ic ' + (s.c === 'ev' ? 'c' : 'g') + '">' +
            (s.c === 'ev' ? '⚡' : '⛽') + '</span>' +
            '<div class="tx"><div class="nm" data-c="' + s.c + '" data-i="' + s.i + '">' + esc(s.t) + '</div>' +
            '<div class="mt">' + esc(metaOf(s)) + '</div></div>' +
            '<span class="act' + (on ? ' done' : '') + '" data-c="' + s.c + '" data-i="' + s.i + '">' +
            (on ? '✓ 已指定' : '设为补给') + '</span></div>';
    }
    function groupInfo(s) {
        try {
            var di = (typeof dayIdxOfKm === 'function') ? dayIdxOfKm(s.km) : -1;
            var day = (typeof DAYS !== 'undefined' && DAYS) ? DAYS[di] : null;
            if (day && day.altKm) {
                var tag = (typeof dayTagOf === 'function') ? dayTagOf(s.km) : '第' + (di + 1) + '程';
                return { key: tag, off: Math.max(0, Math.round(s.km - day.altKm[0])) };
            }
        } catch (e) {}
        return null;
    }
    function listHtml(rows, grouped) {
        var html = '', lastKey = null;
        rows.forEach(function (s) {
            if (grouped) {   // 跟随行程：按程归组（组标题 = 组内首站的里程偏移近似）
                var gi = groupInfo(s);
                var key = gi ? gi.key : '';
                if (key !== lastKey) {
                    if (key) html += '<div class="grp">' + esc(gi.key + ' · 约 ' + gi.off + 'km 处') + '</div>';
                    lastKey = key;
                }
            }
            html += rowHtml(s);
        });
        return html || '<div class="sup-empty">走廊内暂无补给点</div>';
    }

    /* auto=true：open()/指定动作后的渲染——按 N 自动切页签；手动切页签用 auto=false */
    function render(auto) {
        if (!built) return;
        var n = designated.length;
        if (auto) tab = n > 0 ? 'mine' : 'follow';
        var g = function (id) { return document.getElementById(id); };
        var segF = g('supSegFollow'), segM = g('supSegMine'), badge = g('supBadge');
        if (segF && segF.classList) segF.classList.toggle('on', tab === 'follow');
        if (segM && segM.classList) segM.classList.toggle('on', tab === 'mine');
        if (badge) {
            badge.textContent = n;
            badge.style.display = n > 0 ? 'inline-block' : 'none';
        }
        var ban = g('supBan');
        if (ban) {
            ban.style.display = (n > 0) ? 'flex' : 'none';
            var banT = g('supBanT');
            if (banT) banT.textContent = '已指定 ' + n + ' 站 · 其他补给点已隐藏';
        }
        var flt = g('supFlt'), note = g('supNote'), listEl = g('supList');
        if (tab === 'mine') {
            if (flt) flt.style.display = 'none';
            if (note) note.style.display = 'none';
            if (listEl) listEl.innerHTML = n ? listHtml(desLive(), false) : '<div class="sup-empty">还没有指定补给点 · 去「跟随行程」挑几站</div>';
        } else {
            if (flt) flt.style.display = '';
            if (note) note.style.display = '';
            var data = corridor();
            var nEv = 0, nFuel = 0;
            data.forEach(function (s) { if (s.c === 'ev') nEv++; else nFuel++; });
            if (flt) {
                flt.innerHTML =
                    '<span class="f' + (filterMode === 'all' ? ' on' : '') + '" data-f="all">全部 ' + data.length + '</span>' +
                    '<span class="f' + (filterMode === 'ev' ? ' on' : '') + '" data-f="ev">⚡ 充电 ' + nEv +
                    '<i class="qf' + (fastOnly ? ' on' : '') + '" data-f="fast">仅快充</i></span>' +
                    '<span class="f' + (filterMode === 'fuel' ? ' on' : '') + '" data-f="fuel">⛽ 加油 ' + nFuel + '</span>';
            }
            if (note) note.textContent = '线路 ' + CORRIDOR_KM + 'km 走廊内 · 按行程前方顺序排列';
            var rows = data.filter(function (s) {
                if (filterMode === 'ev') return s.c === 'ev' && (!fastOnly || !s.slow);
                if (filterMode === 'fuel') return s.c === 'fuel';
                return true;
            });
            if (listEl) listEl.innerHTML = listHtml(rows, true);
        }
    }

    /* ==================== 对外接口 ==================== */
    function open() {
        build();
        bodyCls(true);
        render(true);
    }
    function close() {
        bodyCls(false);
    }
    function isOpen() {
        var b = document.body;
        return !!(b && b.classList && b.classList.contains('mob-sup'));
    }

    try {
        window.__sup = {
            open: open,
            close: close,
            isOpen: isOpen,
            list: function () { return designated.slice(); },
            count: function () { return designated.length; },
            designate: designate,     // 测试接缝 + 后续阶段（行中迷你卡）复用
            clear: clearAll
        };
        window.__supOpen = open;      // mobile.js #mobSup 的既有接线（S36-AB 空壳替换）
    } catch (e) {}

    /* 调试钩子（截图/联调，与 mobile.js ?mobsheet= 同族）：?sup=1 启动即打开补给抽屉 */
    try {
        if (typeof location !== 'undefined' && location.search && /[?&]sup=1/.test(location.search)) {
            setTimeout(function () { try { open(); } catch (e) {} }, 600);
        }
    } catch (e) {}
})();
