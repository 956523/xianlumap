/* ============================================================================
 * engine/edit.js — 页面内编辑模式（S5，PLATFORM.md §3.3）
 *
 * overlay 架构：编辑不改线路包本体。改动作为 overlay 存 localStorage
 * （键 xianlumap.overlay.<routeId>，按线路隔离），启动时「包 + overlay」
 * 合并生效。下次跑 build 不会被覆盖；一键恢复原始数据 = 清 overlay。
 *
 * 可改（即时，localStorage）：天标题/备注/住宿点、分段（选地名重切区间）、
 *                             地名标注显示名、副标题/纯电提示。
 * 不可改：途经点增删（改几何需重跑构建）——界面给出 build-route.js 引导。
 * 绝不写 ROUTE_BUILD（那是构建输入，只存在于包内，编辑层不碰）。
 *
 * 加载顺序：route-engine → planner → profile → edit → ui
 * （本文件须在 ui.js 之前：合并要在启动渲染前完成）。
 * ========================================================================== */

    /* ---------- overlay 存储（localStorage 不可用时降级为「本次会话有效」） ---------- */
    var EDIT_KEY = 'xianlumap.overlay.' + ((typeof ROUTE_META !== 'undefined' && ROUTE_META && ROUTE_META.key) || 'default');
    function editStore() {
        try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (e) {}
        return null;
    }
    function editLoad() {
        var s = editStore();
        if (!s) return {};
        try { return JSON.parse(s.getItem(EDIT_KEY) || '{}') || {}; } catch (e) { return {}; }
    }
    function editSave() {
        var s = editStore();
        if (s) s.setItem(EDIT_KEY, JSON.stringify(Edit.overlay));
        try { if (typeof Sync !== 'undefined' && Sync.bumpLocal) Sync.bumpLocal(); } catch (e) {}
    }
    function editClearStore() {
        var s = editStore();
        if (s) s.removeItem(EDIT_KEY);
    }
    function editAsk(msg, val) {
        try {
            if (typeof window !== 'undefined' && window.prompt) return window.prompt(msg, val);
            if (typeof prompt === 'function') return prompt(msg, val);
        } catch (e) {}
        return null;
    }
    function editNotice(msg) {
        try {
            if (typeof window !== 'undefined' && window.alert) return window.alert(msg);
            if (typeof alert === 'function') return alert(msg);
        } catch (e) {}
    }

    /* ---------- 原始数据快照（恢复用）+ 环线 km→经纬度基准表（分段重切用） ---------- */
    /* S19：基准表同时服务「途经点归属天」推导——waypoint 经纬度 → 沿线 km → 落在
       哪个 D[i].altKm 区间。环线/双出发地口径：只用【当前视角的 DAYS】（buildDays
       已按出发地拼好 altKm），waypoint km 与区间同一坐标系，天然一致。 */
    function routeKmOf(lat, lng) {
        var best = 0, bd = 1e9;
        EDIT_BASE.forEach(function (t) {
            var dd = (t[1] - lat) * (t[1] - lat) + (t[2] - lng) * (t[2] - lng);
            if (dd < bd) { bd = dd; best = t[0]; }
        });
        return best;
    }
    function wpDayIdx(w) {
        if (!w || !w.p || !DAYS.length) return -1;
        var km = routeKmOf(w.p[0], w.p[1]);
        var merged = (typeof Edit !== 'undefined' && Edit._mergedIds) ? Edit._mergedIds() : [];
        for (var i = 0; i < DAYS.length; i++) {
            var d = DAYS[i];
            if (merged.indexOf(d.id) >= 0) continue;   // S25：已并入的天不参与归属
            if (d.altKm && km >= d.altKm[0] - 0.5 && km <= d.altKm[1] + 0.5) return i;
        }
        var nearest = 0, nd = 1e18;   // 区间外（如跨段点上/接入段）：归最近一天，不丢
        for (var j = 0; j < DAYS.length; j++) {
            var dj = DAYS[j];
            if (!dj.altKm) continue;
            var dist = km < dj.altKm[0] ? dj.altKm[0] - km : km - dj.altKm[1];
            if (dist < nd) { nd = dist; nearest = j; }
        }
        return nearest;
    }
    function wpDayBadge(w) {
        var i = wpDayIdx(w);
        return i >= 0 && DAYS[i] ? 'D' + DAYS[i].id : '·';
    }

    var EDIT_PRISTINE = {
        core: JSON.parse(JSON.stringify(CORE)),
        tail: JSON.parse(JSON.stringify(TAIL)),
        marks: ALT_MARKS.map(function (m) { return m.n; }),
        meta: { sub: ROUTE_META.sub, evNotice: ROUTE_META.evNotice }
    };
    var EDIT_BASE = [];
    (function buildBaseTable() {
        EDIT_PRISTINE.core.concat([EDIT_PRISTINE.tail]).forEach(function (d) {
            if (!d.path || !d.altKm) return;   // 休整日无轨迹
            var n = d.path.length;
            d.path.forEach(function (p, i) {
                EDIT_BASE.push([d.altKm[0] + (d.altKm[1] - d.altKm[0]) * i / (n - 1), p[0], p[1]]);
            });
        });
        EDIT_BASE.sort(function (a, b) { return a[0] - b[0]; });
    })();

    /* ---------- overlay → 数据合并（启动时执行一次） ---------- */
    function editDayById(id) {
        return (CORE.concat([TAIL])).filter(function (d) { return d.id === id; })[0];
    }
    function applyDayFields(id, f) {
        var day = editDayById(id);
        if (!day) return;
        if (f.title != null) day.title = String(f.title).slice(0, 60);
        if (f.note != null) day.note = String(f.note).slice(0, 80);
        if (f.stay != null) day.stay = String(f.stay).slice(0, 20);
    }
    function applySeg(id, a, b) {
        var day = editDayById(id);
        if (!day || day.rest || !(b > a)) return false;
        a = +a.toFixed(1); b = +b.toFixed(1);
        day.altKm = [a, b];
        day.km = Math.round(b - a);
        var seg = EDIT_BASE.filter(function (t) { return t[0] >= a - 0.001 && t[0] <= b + 0.001; });
        if (seg.length >= 2) day.path = seg.map(function (t) { return [t[1], t[2]]; });
        // 爬升/极值按高程序列重算（能耗文案不重写——文案归人，数值归脚本）
        var sl = altSlice(altSeries(), a, b);
        day.up = sl.up; day.down = sl.down;
        if (sl.pts.length) {
            var alts = sl.pts.map(function (p) { return p.alt; });
            day.minAlt = Math.min.apply(null, alts);
            day.maxAlt = Math.max.apply(null, alts);
        }
        return true;
    }
    function applyMarks(rename) {
        ALT_MARKS.forEach(function (m) {
            if (rename[m.n] != null) m.n = String(rename[m.n]).slice(0, 20);
        });
    }

    /* S20 归天：天数选择弹层（当前天禁用）+ 轻反馈 toast */
    function openDayPick(wpIdx) {
        var list = document.getElementById('etDayPickList');
        if (!list || typeof list.appendChild !== 'function') return;
        list.innerHTML = '';
        var cur = (typeof Wp !== 'undefined' && Wp.list[wpIdx]) ? wpDayIdx(Wp.list[wpIdx]) : -1;
        DAYS.forEach(function (d, di) {
            var b = document.createElement('button');
            b.textContent = 'D' + d.id + ' ' + d.title + ((d.altKm && !d.rest) ? '' : '（休整日）');
            if (di === cur) { b.disabled = true; b.className = 'cur'; }
            else {
                b.onclick = function () {
                    closeDayPick();
                    if (Edit.assignWpDay(wpIdx, di) !== false) {
                        etToast('已归到 D' + d.id);
                    }
                    if (Wp.renderList) Wp.renderList();
                };
            }
            list.appendChild(b);
        });
        if (document.body && document.body.classList) document.body.classList.add('et-daypick');
    }
    function closeDayPick() {
        if (document.body && document.body.classList) document.body.classList.remove('et-daypick');
    }
    var etToastTimer = null;
    function etToast(msg) {
        var t = document.getElementById('etToast');
        if (!t) return;
        t.textContent = msg;
        if (t.classList) t.classList.add('show');
        if (etToastTimer) clearTimeout(etToastTimer);
        etToastTimer = setTimeout(function () { if (t.classList) t.classList.remove('show'); }, 1600);
    }
    (function () {
        var bk = document.getElementById('etDayPickBk');
        if (bk) bk.onclick = closeDayPick;
    })();


    /* S23 行操作核心 API（手势与桌面共用，vm 断言直接调）——落点语义与原 ↑↓ 完全一致 */
    function wpRowMove(from, to) {
        if (from === to || from < 0 || to < 0 || from >= Wp.list.length || to >= Wp.list.length) return false;
        var item = Wp.list.splice(from, 1)[0];
        Wp.list.splice(to, 0, item);
        wpSave(Wp.list);
        if (Wp.renderList) Wp.renderList();
        return true;
    }
    function wpRowDelete(i) {
        if (i < 0 || i >= Wp.list.length) return false;
        Wp.list.splice(i, 1);
        wpSave(Wp.list);
        if (Wp.renderList) Wp.renderList();
        return true;
    }
    function wpNarrow() {
        try { return typeof window !== 'undefined' && window.innerWidth <= 768; } catch (e) { return false; }
    }


    var Edit = {
        on: false,
        overlay: editLoad(),
        isOn: function () { return this.on; },
        tab: 'trip',
        showTab: function (name) {   // S19：Tab 切换（vm 断言与 ⋯菜单云同步入口用）
            Edit.tab = (name === 'wp' || name === 'more') ? name : 'trip';
            try { refreshEditTabs(); } catch (e) {}
            /* S23：首次进途经点 Tab（移动断点）给一行手势引导，做过一次不再打扰 */
            if (Edit.tab === 'wp' && typeof localStorage !== 'undefined' && localStorage) {
                var narrow = false;
                try { narrow = window.innerWidth <= 768; } catch (e) {}
                if (narrow && !localStorage.getItem('xlm.wp-gestures-hint')) {
                    try { localStorage.setItem('xlm.wp-gestures-hint', '1'); } catch (e) {}
                    try { etToast('左滑删除 · 长按 ☰ 拖动排序 · 点 [Dn] 改归属', 3200); } catch (e) {}
                }
            }
        },
        wpDayBadge: function (w) { return wpDayBadge(w); },          // S19：途经点归属天徽标
        wpRowMove: function (from, to) { return wpRowMove(from, to); },   // S23：行操作核心（手势/桌面/测试共用）
        /* S25：并入前一天——overlay 层把该天区间并入显示序列中前一个可见天，
           该天标 merged（显示层消失，编号仍连续）；恢复原始数据即还原。 */
        _mergedIds: function () {
            return (this.overlay.meta && Array.isArray(this.overlay.meta.merged)) ? this.overlay.meta.merged : [];
        },
        mergeDay: function (id) {
            var merged = this._mergedIds();
            if (merged.indexOf(id) >= 0) return false;
            var idx = -1;
            DAYS.forEach(function (d, i) { if (d.id === id) idx = i; });
            if (idx <= 0) return false;
            var day = DAYS[idx];
            if (!day.altKm) return false;
            var prev = null;
            for (var j = idx - 1; j >= 0; j--) {
                if (merged.indexOf(DAYS[j].id) < 0 && DAYS[j].altKm) { prev = DAYS[j]; break; }
            }
            if (!prev) return false;
            var okSeg = Edit.setSeg(prev.id, prev.altKm[0], day.altKm[1]);
            if (okSeg === false) return false;
            merged.push(id);
            this.overlay.meta = this.overlay.meta || {};
            this.overlay.meta.merged = merged;
            editSave();
            renderAll();
            this.refreshDayControls();
            try { refreshEditTabs(); } catch (e) {}
            return true;
        },
        wpRowDelete: function (i) { return wpRowDelete(i); },
        wpChipsHTML: function (day) { return wpChips(day); },        // S19：行程卡途经 chips（HTML）,
        /* S20 归天直改：把途经点 wpIdx 归到第 dayIdx 天。
           口径与 S19 徽标一致（当前视角 DAYS altKm 区间 + 边界就近 EPS）：
           ① 目标天区间向外扩到包含该点（km±EPS）；② 任何包含该点的其他天把点让出
           （收终点或推起点，天不塌缩）；③ 走既有 setSeg（主视角守卫复用）。
           预览层语义——徽标/chips 即时联动，geometry 仍待云端构建。 */
        assignWpDay: function (wpIdx, dayIdx) {
            var w = (typeof Wp !== 'undefined' && Wp && Wp.list) ? Wp.list[wpIdx] : null;
            var T = (typeof DAYS !== 'undefined' ? DAYS : [])[dayIdx];
            if (!w || !T) return false;
            var km = routeKmOf(w.p[0], w.p[1]);
            var EPS = 0.5;
            if (wpDayIdx(w) === dayIdx) return true;
            if (!T.altKm || (T.altKm[1] - T.altKm[0]) < 1) {
                /* S25：目标天是休整/无区间——归点即复活：区间设为 km±0.5（1km 行程） */
                var okRevive = Edit.setSeg(T.id, +(km - EPS).toFixed(1), +(km + EPS).toFixed(1));
                try { refreshEditTabs(); } catch (e) {}
                return okRevive !== false;
            }
            var ta = T.altKm[0], tb = T.altKm[1];
            if (km < ta) ta = Math.max(0, km - EPS);
            if (km > tb) tb = km + EPS;
            if (tb - ta < 1) { editNotice('移动后该天里程不足 1km，已取消。'); return false; }
            for (var i = 0; i < DAYS.length; i++) {
                var d = DAYS[i];
                if (!d.altKm || d === T) continue;
                /* 让出口径必须与 wpDayIdx 一致（边界 ±0.5 归属）：按容差判定包含，
                   再把边界推到容差外（±0.6），保证徽标一定落到目标天 */
                if (km >= d.altKm[0] - EPS && km <= d.altKm[1] + EPS) {
                    if (km - 0.6 - d.altKm[0] >= 1) Edit.setSeg(d.id, d.altKm[0], +(km - 0.6).toFixed(1));
                    else if (d.altKm[1] - (km + 0.6) >= 1) Edit.setSeg(d.id, +(km + 0.6).toFixed(1), d.altKm[1]);
                }
            }
            var okSeg = Edit.setSeg(T.id, +ta.toFixed(1), +tb.toFixed(1));
            try { refreshEditTabs(); } catch (e) {}
            return okSeg !== false;
        },
        refreshTabs: function () { try { refreshEditTabs(); } catch (e) {} },

        /* —— 进入/退出编辑模式 —— */
        enter: function () {
            if (this.on) return;
            /* 体验修复 1：不再静默切回主出发地视角（用户感知为「坏了」）。
               文字类编辑（标题/备注/住宿/地名/副标题）在任意出发地视角都可用；
               分段编辑受接入段拼接天的 km 基准限制，仅在主出发地视角开放——
               其他视角下界面给明确提示、API 显式拒绝（见 refreshDayControls/setSeg）。 */
            this.on = true;
            this.tab = 'trip';   // S22：每次进入复位到默认任务区，不带上次的 Tab 残留
            document.body.classList.add('editing');
            if (editBar) editBar.style.display = '';
            this.refreshDayControls();
            try { refreshEditTabs(); } catch (e) {}   // S19：进入编辑即渲染三个 Tab
        },
        exit: function () {
            this.on = false;
            document.body.classList.remove('editing');
            if (editBar) editBar.style.display = 'none';
            this.refreshDayControls();
        },

        /* —— 编辑操作（API 与 UI 共用；每个操作立即存 overlay） —— */
        setDayField: function (id, field, value) {
            if (['title', 'note', 'stay'].indexOf(field) < 0 || value == null) return;
            var f = {}; f[field] = value;
            applyDayFields(id, f);
            // 当前视角的 DAYS 可能是 buildDays 的拼接副本（接入段出发地）——同步改活副本，立即生效
            var live = (typeof DAYS !== 'undefined' ? DAYS : []).filter(function (d) { return d.id === id; })[0];
            if (live) Object.keys(f).forEach(function (k) { live[k] = f[k]; });
            this.overlay.days = this.overlay.days || {};
            this.overlay.days[id] = this.overlay.days[id] || {};
            this.overlay.days[id][field] = String(value);
            editSave();
            this.updateDayRow(id);
            try { refreshEditTabs(); } catch (e) {}   // S19：标题/备注/住宿 → 行程卡联动
        },
        setSeg: function (id, fromKm, toKm) {
            // 分段编辑仅在主出发地视角开放（环线里程 0 点基准）；其他视角显式拒绝
            if (STARTS.length > 1 && start !== STARTS[0].id) {
                editNotice(Edit.segViewHint());
                return false;
            }
            if (!applySeg(id, fromKm, toKm)) return false;
            this.overlay.seg = this.overlay.seg || {};
            this.overlay.seg[id] = { fromKm: +fromKm.toFixed(1), toKm: +toKm.toFixed(1) };
            editSave();
            renderAll();              // 分段影响剖面/站点/盲区，整图重建
            this.refreshDayControls();
            try { refreshEditTabs(); } catch (e) {}   // S19：分段改动 → 途经点 [Dn] 徽标/行程 chips 即时重算
            return true;
        },
        /* 视角受限提示（界面与 API 共用一份文案，数据驱动，不写死出发地名） */
        segViewHint: function () {
            var cur = (typeof curStart === 'function') ? curStart() : { name: '' };
            var base = STARTS[0] || { name: '' };
            return cur.name + '视角下不可调整分段，请切回' + base.name + '视角';
        },

        /* —— 途经点增删引导（体验修复 2：改几何=重建，但操作路径一步不错） —— */
        waypointsExportText: function () {
            // 当前途经点清单（ROUTE_BUILD.waypoints 原样导出，可直接粘回包内）
            return (typeof ROUTE_BUILD !== 'undefined' && ROUTE_BUILD && ROUTE_BUILD.waypoints)
                ? JSON.stringify(ROUTE_BUILD.waypoints, null, 2) : '';
        },
        waypointGuideText: function () {
            var key = ROUTE_META.key;
            return '途经点清单在 route-defs/' + key + '.js 的 ROUTE_BUILD.waypoints 里（名字/坐标/海拔/简介）。\n' +
                '改动流程：\n' +
                '1) 点下方「复制当前途经点清单」，粘到包里的 waypoints（增删点、或改 legs 的 from/to/via）\n' +
                '2) 运行：node tools/build-route.js ' + key + '   （轨迹/高程重抓）\n' +
                '3) 若途经点变了，站点也要重抓：node tools/build-stations.js ' + key + ' && node tools/validate.js ' + key + ' --fix\n' +
                '（改几何必须重新构建是产品铁律：页面里的轨迹是构建产物，不是实时算的）';
        },
        showWaypointGuide: function () {
            var old = document.getElementById('wpGuide');
            if (old) { old.remove(); return; }   // 再点一次 = 关闭
            var box = document.createElement('div');
            box.id = 'wpGuide';
            var title = document.createElement('b');
            title.className = 'wp-title';
            title.textContent = '新增/删除途经点需要重新构建';
            var body = document.createElement('pre');
            body.className = 'wp-body';
            body.textContent = Edit.waypointGuideText();
            var row = document.createElement('div');
            row.className = 'wp-row';
            var copy = document.createElement('button');
            copy.className = 'edit-mini';
            copy.textContent = '① 复制当前途经点清单';
            copy.onclick = function () {
                var text = Edit.waypointsExportText();
                var okFlag = false;
                try {
                    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(text); okFlag = true;
                    }
                } catch (e) {}
                if (!okFlag) {
                    try {
                        var ta = document.createElement('textarea');
                        ta.value = text;
                        document.body.appendChild(ta);
                        ta.select();
                        okFlag = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
                        ta.remove();
                    } catch (e) {}
                }
                editNotice(okFlag ? '途经点清单已复制，粘进 ROUTE_BUILD.waypoints 后改。' : '复制失败：请手动打开包内 ROUTE_BUILD 复制 waypoints。');
            };
            var close = document.createElement('button');
            close.className = 'edit-mini';
            close.textContent = '关闭';
            close.onclick = function () { box.remove(); };
            row.appendChild(copy);
            row.appendChild(close);
            box.appendChild(title);
            box.appendChild(body);
            box.appendChild(row);
            document.body.appendChild(box);
        },
        setMarkName: function (origName, name) {
            if (!name) return;
            var hit = ALT_MARKS.filter(function (m) { return m.n === origName; })[0];
            if (!hit) return;
            hit.n = String(name).slice(0, 20);
            this.overlay.marks = this.overlay.marks || {};
            this.overlay.marks[origName] = hit.n;
            editSave();
            drawProfile();
            try { refreshEditTabs(); } catch (e) {}   // S19：更多 Tab 地名列表联动
        },
        setMeta: function (field, value) {
            if (['sub', 'evNotice'].indexOf(field) < 0 || value == null) return;
            ROUTE_META[field] = String(value);
            this.overlay.meta = this.overlay.meta || {};
            this.overlay.meta[field] = ROUTE_META[field];
            editSave();
            var el = document.getElementById(field === 'sub' ? 'routeSub' : null);
            if (field === 'sub' && el) el.textContent = ROUTE_META.sub;
            if (field === 'evNotice') {
                var nt = document.getElementById('evNotice');
                var sp = nt && nt.querySelector('span');
                if (sp) sp.innerHTML = '⚡ <b>纯电提示：</b>' + ROUTE_META.evNotice;
            }
        },
        reset: function () {
            // 恢复原始数据：pristine 字段写回基础对象，清 overlay
            EDIT_PRISTINE.core.concat([EDIT_PRISTINE.tail]).forEach(function (pd) {
                var day = editDayById(pd.id);
                if (!day) return;
                ['title', 'note', 'altKm', 'km', 'up', 'down', 'minAlt', 'maxAlt', 'path'].forEach(function (k) {
                    if (pd[k] !== undefined) day[k] = JSON.parse(JSON.stringify(pd[k]));
                    else delete day[k];
                });
                delete day.stay;
            });
            ALT_MARKS.forEach(function (m, i) { m.n = EDIT_PRISTINE.marks[i]; });
            ROUTE_META.sub = EDIT_PRISTINE.meta.sub;
            ROUTE_META.evNotice = EDIT_PRISTINE.meta.evNotice;
            delete ROUTE_META.departureDate;
            this.overlay = {};
            editClearStore();
            renderAll();
            this.refreshDayControls();
            drawProfile();
            try { refreshEditTabs(); } catch (e) {}   // S19：恢复后三 Tab 复位
        },

        /* —— 出发日期（S13 排期）：overlay.meta.departureDate，存本机、随恢复清空 —— */
        setDeparture: function (iso) {
            if (iso) { ROUTE_META.departureDate = String(iso).slice(0, 10); }
            else { delete ROUTE_META.departureDate; }
            this.overlay.meta = this.overlay.meta || {};
            if (iso) this.overlay.meta.departureDate = ROUTE_META.departureDate;
            else delete this.overlay.meta.departureDate;
            editSave();
            renderAll();          // 重渲染每日卡（含/不含日期）
            try { refreshEditTabs(); } catch (e) {}   // S19：行程卡日期行联动
            var dd = document.getElementById('depDate');
            if (dd) dd.value = ROUTE_META.departureDate || '';
        },

        /* —— 导入编辑层（S8）：别人导出的 route-<id>.custom.json → 本机 overlay —— */
        importOverlay: function (obj) {
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
                editNotice('导入失败：文件不是有效的编辑层 JSON。');
                return false;
            }
            if (obj.route == null) {
                editNotice('这份文件缺少 route 标记（旧版导出格式），请在编辑模式下重新导出后再导入。');
                return false;
            }
            if (obj.route !== ROUTE_META.key) {
                editNotice('线路不匹配：这份编辑层属于「' + obj.route + '」，当前打开的是「' + ROUTE_META.key + '」，未导入。');
                return false;
            }
            var ov = {};
            ['days', 'seg', 'marks', 'meta'].forEach(function (k) { if (obj[k]) ov[k] = obj[k]; });
            Edit.overlay = ov;
            applyOverlay(ov);
            editSave();
            renderAll();
            Edit.refreshDayControls();
            drawProfile();
            applyMetaDom();
            try { refreshEditTabs(); } catch (e) {}   // S19：导入后三 Tab 全部联动
            return true;
        },

        /* —— 导出 overlay（下载 route-<id>.custom.json） —— */
        exportText: function () {
            return '// route-' + ROUTE_META.key + '.custom.json —— 页面编辑层（overlay），由 xianlumap 编辑模式导出\n' +
                '// 这不是线路包本体：原始数据在 route-defs/' + ROUTE_META.key + '.js（由 tools/build-route.js 构建）。\n' +
                '// 导入：编辑模式里点「导入编辑层」选择本文件（会校验 route 标记与当前线路匹配）。\n' +
                '// 固化：把改动誊入 ROUTE_BUILD 后重跑构建，让改动进线路包。\n' +
                JSON.stringify(Object.assign({ route: ROUTE_META.key }, this.overlay), null, 2) + '\n';
        },
        exportOverlay: function () {
            var text = this.exportText();
            try {
                var blob = new Blob([text], { type: 'application/json' });
                var a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'route-' + ROUTE_META.key + '.custom.json';
                document.body.appendChild(a);
                a.click();
                a.remove();
            } catch (e) {
                editNotice('导出失败：当前环境不支持下载（可手动复制 localStorage 里 ' + EDIT_KEY + ' 的值）');
            }
            return text;
        },

        /* —— 编辑态 UI 注入（进入/重渲染后刷新；退出时移除） —— */
        refreshDayControls: function () {
            var listEl = document.getElementById('dayList');
            if (!listEl) return;
            var segLocked = STARTS.length > 1 && start !== STARTS[0].id;   // 非主出发地视角：分段只读
            var merged = this._mergedIds();
            var visible = DAYS.filter(function (d) { return merged.indexOf(d.id) < 0; });   // S25：与 renderAll 同口径
            Array.prototype.forEach.call(listEl.children, function (li, i) {
                var day = visible[i];
                if (!day) return;
                // 移除旧控件
                Array.prototype.forEach.call(li.querySelectorAll('.day-stay, .day-seg, .day-seg-hint'), function (n) { n.remove(); });
                if (!Edit.on) return;
                // 住宿点编辑入口
                var meta = li.querySelector('.day-meta') || li;
                var stay = document.createElement('span');
                stay.className = 'day-stay';
                stay.textContent = day.stay ? '住：' + day.stay + ' ✎' : '＋住宿 ✎';
                meta.appendChild(stay);
                // 分段控件：休整日无区间；非主出发地视角给明确提示（不静默、不假装可改）
                if (day.path && day.altKm) {
                    if (segLocked) {
                        var hint = document.createElement('span');
                        hint.className = 'day-seg-hint';
                        hint.textContent = Edit.segViewHint();
                        meta.appendChild(hint);
                    } else {
                        var seg = document.createElement('span');
                        seg.className = 'day-seg';
                        seg.appendChild(Edit.makeBoundarySelect(day, 0));
                        seg.appendChild(document.createTextNode(' → '));
                        seg.appendChild(Edit.makeBoundarySelect(day, 1));
                        meta.appendChild(seg);
                    }
                }
            });
        },
        makeBoundarySelect: function (day, which) {
            var sel = document.createElement('select');
            sel.className = 'day-seg-sel';
            /* S19 修复：选中项按【最近里程】定，不用 0.5km 硬容差——天端点与地名标注
               相差 >0.5km 时（如丹巴 327.22 vs D2 终点 327.97）旧逻辑无选中项，
               浏览器回退显示第一项（都江堰），用户看到的终点是错的。 */
            var nearest = null, nd = 1e9;
            EDIT_MARKS.forEach(function (mk) {
                var dd = Math.abs(mk.km - day.altKm[which]);
                if (dd < nd) { nd = dd; nearest = mk; }
            });
            EDIT_MARKS.forEach(function (mk) {
                var o = document.createElement('option');
                o.value = String(mk.km);
                o.textContent = mk.n;
                if (mk === nearest) o.selected = true;
                sel.appendChild(o);
            });
            var more = document.createElement('option');
            more.value = '__more__';
            more.textContent = '＋新增途经点…';
            sel.appendChild(more);
            sel.onchange = function () {
                if (sel.value === '__more__') {
                    Edit.showWaypointGuide();   // 体验修复 2：三步引导（说明/复制清单/确切命令）
                    Edit.refreshDayControls();   // 还原选择
                    return;
                }
                var other = which === 0 ? day.altKm[1] : day.altKm[0];
                var v = +sel.value;
                if (which === 0) Edit.setSeg(day.id, v, Math.max(v + 1, other));
                else Edit.setSeg(day.id, Math.min(other, v - 1), v);
            };
            return sel;
        },
        updateDayRow: function (id) {
            var merged = this._mergedIds();
            var visible = DAYS.filter(function (d) { return merged.indexOf(d.id) < 0; });   // S25：显示序列口径
            var i = -1;
            visible.forEach(function (d, j) { if (d.id === id) i = j; });
            var listEl = document.getElementById('dayList');
            if (i < 0 || !listEl || !listEl.children[i]) return;
            var li = listEl.children[i];
            var day = visible[i];
            var t = li.querySelector('.day-title'); if (t) t.textContent = day.title;
            var n = li.querySelector('.day-note'); if (n) n.textContent = day.note + (day.stay ? ' · 住' + day.stay : '');
            var st = li.querySelector('.day-stay'); if (st) st.textContent = day.stay ? '住：' + day.stay + ' ✎' : '＋住宿 ✎';
        }
    };

    /* 分段候选：环线里程表（km 升序）。起点基准 = 主出发地（enter 时已切回）。 */
    var EDIT_MARKS = ALT_MARKS.map(function (m) { return { n: m.n, km: m.km }; })
        .sort(function (a, b) { return a.km - b.km; });

    /* ---------- overlay → 数据合并（启动时一次；导入编辑层时复用同一函数） ---------- */
    function applyOverlay(ov) {
        if (!ov) return;
        if (ov.days) Object.keys(ov.days).forEach(function (id) { applyDayFields(+id, ov.days[id]); });
        if (ov.seg) Object.keys(ov.seg).forEach(function (id) { applySeg(+id, ov.seg[id].fromKm, ov.seg[id].toKm); });
        if (ov.marks) applyMarks(ov.marks);
        if (ov.meta && ov.meta.sub != null) ROUTE_META.sub = String(ov.meta.sub);
        if (ov.meta && ov.meta.evNotice != null) ROUTE_META.evNotice = String(ov.meta.evNotice);
        if (ov.meta && ov.meta.departureDate) ROUTE_META.departureDate = String(ov.meta.departureDate);
        if (ov.meta && Array.isArray(ov.meta.merged)) Edit.overlay.meta = Edit.overlay.meta || {}, Edit.overlay.meta.merged = ov.meta.merged.slice();   // S25
    }
    function applyMetaDom() {
        var subEl = document.getElementById('routeSub');
        if (subEl && ROUTE_META.sub) subEl.textContent = ROUTE_META.sub;
        var nt = document.getElementById('evNotice');
        var sp = nt && nt.querySelector('span');
        if (sp && ROUTE_META.evNotice) sp.innerHTML = '⚡ <b>纯电提示：</b>' + ROUTE_META.evNotice;
        var dd = document.getElementById('depDate');
        if (dd) dd.value = ROUTE_META.departureDate || '';
    }
    /* 启动合并：包 + overlay（在 ui.js 启动渲染之前执行） */
    (function bootMerge() { applyOverlay(Edit.overlay); })();

    /* ---------- 入口按钮 + 编辑面板（S19：任务分区 Tab 化） ----------
       结构：顶部 ‹ 完成编辑 + ⋯菜单（恢复原始/导出/导入/帮助）；
       三个 Tab：行程（默认）| 途经点 | 更多。桌面侧栏与移动全屏同构（S16 全屏化沿用）。 */
    var editBar = null;
    (function buildEditUI() {
        var btn = document.createElement('button');
        btn.className = 'btn-fit edit-toggle';
        btn.id = 'btnEdit';
        btn.textContent = '✏️ 编辑模式';
        var btnFit = document.getElementById('btnFit');
        if (btnFit && btnFit.parentNode && btnFit.parentNode.insertBefore) {
            btnFit.parentNode.insertBefore(btn, btnFit.nextSibling);
        } else {
            var panel = document.getElementById('panel');
            if (panel && panel.appendChild) panel.appendChild(btn);
        }
        editBar = document.createElement('div');
        editBar.className = 'edit-bar';
        editBar.id = 'editBar';            // sync.js 按 id 挂「云同步」区（S19 迁入更多 Tab）
        editBar.style.display = 'none';
        editBar.innerHTML =
            /* 顶栏 */
            '<div class="et-top">' +
            '<button id="etDone" class="et-done">‹ 完成编辑</button>' +
            '<span class="et-title">编辑模式</span>' +
            '<button id="etMoreBtn" class="et-more">⋯</button>' +
            '<div id="etMenu">' +
            '<button id="etReset">↩️ 恢复原始数据</button>' +
            '<button id="etExport">📤 导出编辑层</button>' +
            '<button id="etImportBtn">📥 导入编辑层</button>' +
            '<button id="etHelpBtn">❓ 帮助</button>' +
            '</div>' +
            '<div id="etMenuBk"></div>' +
            '</div>' +
            /* Tab 头 */
            '<div class="et-tabs">' +
            '<button data-et="trip" class="et-tab on">行程</button>' +
            '<button data-et="wp" class="et-tab">途经点</button>' +
            '<button data-et="more" class="et-tab">更多</button>' +
            '</div>' +
            /* 行程：出发日期 + 天卡（标题/日期/途经 chips/分段下拉） */
            '<div class="et-pane" id="etPaneTrip">' +
            '<div class="et-dep">' +
            '<span class="et-lbl">📅 出发日期</span>' +
            '<input type="date" id="depDate">' +
            '<button id="depClear" class="edit-mini">清除</button>' +
            '</div>' +
            '<div class="et-note">改标题/备注/住宿点点文字即可；终点下拉改分段（新途经点走「＋新增途经点…」）。带 ⚠待构建 的途经点来自途经点 Tab，改动 geometry 需云端构建后生效。</div>' +
            '<div id="editDayList"></div>' +
            '</div>' +
            /* 途经点：列表/搜索/点选/生成（S12 能力原样收编；wpList 等 id 保持不变，原接线照用） */
            '<div class="et-pane" id="etPaneWp" style="display:none">' +
            '<div class="wp-head">➕ 途经点<span class="wp-badge" id="wpBadge">待构建</span></div>' +
            '<div class="wp-note">搜索或地图点选添加。每行 [Dn] 是它属于的第几天（随分段联动）；' +
            '改动只存本机（overlay），<b>不参与当前渲染</b>——生成新版线路后云端构建生效。</div>' +
            '<div id="wpList"></div>' +
            '<input class="wp-search" id="wpSearch" placeholder="搜索地名（高德输入提示）…" autocomplete="off">' +
            '<div class="wp-row">' +
            '<button class="edit-mini" id="wpPick">📍 地图点选</button>' +
            '</div>' +
            '<button id="wpGen" class="et-gen">⚙️ 生成新版线路（导出 + 云端构建）</button>' +
            '</div>' +
            /* 更多：地名/文案/云同步(sync.js 挂载点)/帮助 */
            '<div class="et-pane" id="etPaneMore" style="display:none">' +
            '<div class="et-sec_t">📛 地名显示名</div>' +
            '<div id="etMarks"></div>' +
            '<div class="et-sec_t">📝 线路文案</div>' +
            '<div class="wp-row">' +
            '<button class="edit-mini" id="etSub">改线路副标题</button>' +
            '<button class="edit-mini" id="etNotice">改纯电提示</button>' +
            '</div>' +
            '<div class="et-sec_t">☁️ 云同步（S15）</div>' +
            '<div id="editPaneMore"></div>' +
            '<div class="et-sec_t">❓ 帮助</div>' +
            '<div class="et-help">改动只存本机浏览器（localStorage overlay），原始线路包不受影响。' +
            '改分段/标题/备注立即重排预览；改途经点后 geometry 仍需「生成新版线路」云端构建。' +
            '换设备用云同步备份恢复。</div>' +
            '</div>' +
            /* 归天天数选择弹层 + toast（S20） */
            '<div id="etDayPickBk"></div>' +
            '<div id="etDayPick"><div class="et-dp_t">把该途经点归到哪一天？</div><div id="etDayPickList"></div></div>' +
            '<div id="etToast"></div>';
        if (btn.parentNode && btn.parentNode.insertBefore) {
            btn.parentNode.insertBefore(editBar, btn.nextSibling);
        } else if (panel && panel.appendChild) {
            panel.appendChild(editBar);
        }
        /* Tab 样式（一处注入，桌面/移动同构） */
        var css = document.createElement('style');
        css.textContent =
            '.et-top{display:flex;align-items:center;gap:8px;padding:2px 0 8px;border-bottom:1px solid #e2e8f0;margin-bottom:8px;position:relative;}' +
            '.et-done{border:none;background:#f0fdfa;color:#0f766e;font-size:14px;font-weight:600;padding:10px 12px;border-radius:8px;cursor:pointer;font-family:inherit;}' +
            '.et-title{flex:1;text-align:center;font-size:14px;font-weight:600;color:#0f172a;}' +
            '.et-more{width:44px;height:40px;border:none;background:#f1f5f9;border-radius:8px;font-size:18px;color:#475569;cursor:pointer;font-family:inherit;}' +
            '#etMenu{position:absolute;top:46px;right:0;z-index:20;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 8px 24px rgba(15,23,42,.16);padding:5px;display:none;min-width:180px;}' +
            'body.et-menu #etMenu{display:block;}' +
            '#etMenu button{display:block;width:100%;text-align:left;border:none;background:none;min-height:40px;padding:0 10px;font-size:13px;color:#1f2937;border-radius:6px;cursor:pointer;font-family:inherit;}' +
            '#etMenuBk{position:fixed;inset:0;z-index:15;display:none;}' +
            'body.et-menu #etMenuBk{display:block;}' +
            '.et-tabs{display:flex;gap:4px;background:#f1f5f9;border-radius:9px;padding:3px;margin-bottom:10px;}' +
            '.et-tab{flex:1;border:none;background:none;min-height:40px;border-radius:7px;font-size:13.5px;font-weight:600;color:#64748b;cursor:pointer;font-family:inherit;}' +
            '.et-tab.on{background:#fff;color:#0f766e;box-shadow:0 1px 3px rgba(15,23,42,.12);}' +
            '.et-pane{padding:2px 0;}' +
            '.et-dep{display:flex;align-items:center;gap:8px;margin-bottom:8px;}' +
            '.et-lbl{font-size:12.5px;font-weight:600;color:#92400e;flex:none;}' +
            '.et-dep input[type=date]{flex:1;min-height:40px;font-size:13px;border:1px solid #e2e8f0;border-radius:8px;padding:0 8px;font-family:inherit;}' +
            '.et-note{font-size:11px;color:#94a3b8;line-height:1.6;margin-bottom:8px;}' +
            '.et-day{border:1px solid #f1f5f9;border-radius:10px;padding:8px 10px;margin-bottom:8px;}' +
            '.et-day-top{display:flex;align-items:center;gap:8px;margin-bottom:4px;}' +
            '.et-tag{flex:none;font-size:11px;font-weight:700;color:#0f766e;background:#f0fdfa;border-radius:6px;padding:2px 6px;}' +
            '.et-txt{flex:1;border:none;background:none;font-size:14px;font-weight:600;color:#0f172a;text-align:left;padding:8px 4px;cursor:pointer;font-family:inherit;min-height:40px;}' +
            '.et-sub{font-size:11.5px;color:#64748b;padding:0 2px;}' +
            '.et-chips{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0;}' +
            '.et-chip{font-size:10.5px;color:#6d28d9;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:6px;padding:1px 6px;}' +
            '.et-chip.more{color:#94a3b8;background:#f8fafc;border-color:#e2e8f0;}' +
            '.et-chips .et-none{font-size:10.5px;color:#cbd5e1;}' +
            '.et-seg{display:flex;align-items:center;gap:6px;margin-top:4px;}' +
            '.et-seg select{flex:1;min-height:40px;font-size:12.5px;border:1px solid #e2e8f0;border-radius:7px;padding:0 6px;font-family:inherit;background:#fff;}' +
            '.et-seg-hint{font-size:11px;color:#b45309;}' +
            '.et-wp{display:flex;align-items:center;gap:6px;padding:2px 0;font-size:13px;}' +
            '.et-wp .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:8px 0;}' +
            '.et-wp .grip{border:none;background:none;color:#94a3b8;font-size:15px;cursor:grab;padding:10px 6px;font-family:inherit;}' +
            '.et-dayno{flex:none;font-size:10.5px;font-weight:700;color:#0f766e;background:#f0fdfa;border:none;border-radius:6px;padding:3px 7px;font-family:inherit;cursor:pointer;}' +
            '.et-wp button.mv{width:44px;height:44px;border:1px solid #e2e8f0;background:#fff;border-radius:8px;cursor:pointer;font-size:14px;padding:0;font-family:inherit;}' +
            '.et-wp button.del{width:44px;height:44px;border:1px solid #fecaca;background:#fff;color:#dc2626;border-radius:8px;cursor:pointer;font-size:14px;padding:0;font-family:inherit;}' +
            '.et-gen{display:block;width:100%;margin-top:10px;min-height:52px;border:none;background:#0f766e;color:#fff;font-size:15px;font-weight:600;border-radius:12px;cursor:pointer;font-family:inherit;box-shadow:0 4px 12px rgba(15,118,110,.3);}' +
            '.et-sec_t{font-size:12.5px;font-weight:600;color:#92400e;margin:10px 0 4px;}' +
            '.et-mark{display:flex;align-items:center;gap:8px;font-size:12.5px;padding:2px 0;color:#334155;}' +
            '.et-mark .mn{flex:1;padding:8px 0;}' +
            '.et-mark button{min-height:40px;padding:0 10px;border:1px solid #e2e8f0;background:#fff;border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit;}' +
            '.et-help{font-size:11.5px;color:#64748b;line-height:1.7;}' +
            '#editPaneMore .sync-sec{border-top:none;margin-top:0;padding-top:0;}' +
            /* S20 归天天数选择弹层 + toast */
            '#etDayPickBk{position:fixed;inset:0;z-index:30;background:rgba(15,23,42,.4);display:none;}' +
            'body.et-daypick #etDayPickBk{display:block;}' +
            '#etDayPick{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:31;width:min(320px,calc(100vw - 48px));background:#fff;border-radius:14px;box-shadow:0 16px 48px rgba(15,23,42,.25);padding:12px;display:none;}' +
            'body.et-daypick #etDayPick{display:block;}' +
            '.et-dp_t{font-size:13.5px;font-weight:600;color:#0f172a;margin-bottom:8px;text-align:center;}' +
            '#etDayPickList button{display:block;width:100%;min-height:46px;border:none;background:none;font-size:14px;color:#1f2937;border-radius:8px;cursor:pointer;font-family:inherit;text-align:left;padding:0 12px;}' +
            '#etDayPickList button:active{background:#f0fdfa;}' +
            '#etDayPickList button.cur{color:#94a3b8;cursor:default;}' +
            '#etToast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(20px);z-index:40;background:#0f172a;color:#fff;font-size:13px;padding:10px 18px;border-radius:22px;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;}' +
            '#etToast.show{opacity:1;transform:translateX(-50%) translateY(0);}';
        (document.head || document.documentElement).appendChild(css);

        /* —— 顶栏与菜单 —— */
        var doneBtn = document.getElementById('etDone');
        if (doneBtn) doneBtn.onclick = function () { Edit.exit(); };
        var moreBtn = document.getElementById('etMoreBtn');
        if (moreBtn) moreBtn.onclick = function () { document.body.classList.toggle('et-menu'); };
        var menuBk = document.getElementById('etMenuBk');
        if (menuBk) menuBk.onclick = function () { document.body.classList.remove('et-menu'); };
        function closeMenu() { document.body.classList.remove('et-menu'); }
        var etReset = document.getElementById('etReset');
        if (etReset) etReset.onclick = function () {
            closeMenu();
            if (editAsk('清空本机全部改动，恢复线路原始数据？', '确定') !== null) Edit.reset();
        };
        var etExport = document.getElementById('etExport');
        if (etExport) etExport.onclick = function () { closeMenu(); Edit.exportOverlay(); };
        var etHelp = document.getElementById('etHelpBtn');
        if (etHelp) etHelp.onclick = function () { closeMenu(); Edit.showTab('more'); };
        // 导入编辑层（S8）：file input 读文件 → 剥注释 → JSON → Edit.importOverlay 校验并应用
        var imp = document.getElementById('etImportBtn');
        var fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,application/json';
        fileInput.style.display = 'none';
        if (imp) imp.onclick = function () { closeMenu(); fileInput.click(); };
        fileInput.onchange = function () {
            var f = fileInput.files && fileInput.files[0];
            if (!f) return;
            var reader = new FileReader();
            reader.onload = function () {
                try {
                    var text = String(reader.result || '');
                    var i = text.indexOf('{');   // 跳过 // 文件头注释
                    var obj = JSON.parse(text.slice(i));
                    if (Edit.importOverlay(obj)) editNotice('编辑层已导入并生效。');
                } catch (e) {
                    editNotice('导入失败：' + (e && e.message ? e.message : '文件解析出错'));
                }
                fileInput.value = '';
            };
            reader.readAsText(f);
        };
        if (editBar && editBar.appendChild) editBar.appendChild(fileInput);

        btn.onclick = function () { Edit.on ? Edit.exit() : Edit.enter(); };

        /* 天列表点击（捕获阶段拦截，避免触发 focusDay）——桌面侧栏的等价入口保留 */
        var listEl = document.getElementById('dayList');
        if (listEl && listEl.addEventListener) {
            listEl.addEventListener('click', function (e) {
                if (!Edit.on) return;
                var t = e.target;
                if (!t || !t.className) return;
                var li = t;
                while (li && String(li.tagName).toLowerCase() !== 'li') li = li.parentNode;
                if (!li) return;
                var idx = -1;
                Array.prototype.forEach.call(listEl.children, function (c, j) { if (c === li) idx = j; });
                var day = DAYS[idx];
                if (!day) return;
                if (t.className === 'day-title') {
                    e.stopPropagation();
                    var v = editAsk('第 ' + day.id + ' 天标题', day.title);
                    if (v !== null) Edit.setDayField(day.id, 'title', v);
                } else if (t.className === 'day-note') {
                    e.stopPropagation();
                    var v2 = editAsk('第 ' + day.id + ' 天备注', day.note);
                    if (v2 !== null) Edit.setDayField(day.id, 'note', v2);
                } else if (t.className === 'day-stay') {
                    e.stopPropagation();
                    var v3 = editAsk('第 ' + day.id + ' 天住宿点（留空清除）', day.stay || '');
                    if (v3 !== null) Edit.setDayField(day.id, 'stay', v3);
                }
            }, true);
        }

        /* 副标题 / 纯电通知条 */
        var etSub = document.getElementById('etSub');
        if (etSub) etSub.onclick = function () {
            var v = editAsk('线路副标题', ROUTE_META.sub);
            if (v !== null) Edit.setMeta('sub', v);
        };
        var etNotice = document.getElementById('etNotice');
        if (etNotice) etNotice.onclick = function () {
            var v = editAsk('纯电提示（纯文本，页面会自动加标题与图标）', ROUTE_META.evNotice);
            if (v !== null) Edit.setMeta('evNotice', v);
        };

        /* 剖面地名（点标注改显示名；聚焦模式可见全部，全程模式只见垭口） */
        var chart = document.getElementById('chartBox');
        if (chart && chart.addEventListener) {
            chart.addEventListener('click', function (e) {
                if (!Edit.on) return;
                var txt = e.target && e.target.textContent;
                if (!txt) return;
                var hit = ALT_MARKS.filter(function (m) {
                    return txt === m.n || txt.indexOf(m.n + ' ') === 0;
                })[0];
                if (!hit) return;
                var v = editAsk('地名显示名（原始名：' + hit.n + '）', hit.n);
                if (v !== null) Edit.setMarkName(hit.n, v);
            }, true);
        }
    })();

    /* ---------- S19：三 Tab 渲染与联动刷新 ---------- */
    function dayDateTag(d, i) {
        var tag = 'D' + d.id;
        if (typeof ROUTE_META !== 'undefined' && ROUTE_META.departureDate) {
            try {
                var dep = new Date(ROUTE_META.departureDate + 'T00:00:00');
                dep.setDate(dep.getDate() + i);
                tag += ' · ' + (dep.getMonth() + 1) + '月' + dep.getDate() + '日 周' +
                    '日一二三四五六'.charAt(dep.getDay());
            } catch (e) {}
        }
        return tag;
    }
    function wpChips(day) {
        if (typeof Wp === 'undefined' || !Wp || !Wp.list || !Wp.list.length || !day.altKm) return '';
        var names = [];
        Wp.list.forEach(function (w) {
            if (wpDayIdx(w) >= 0 && DAYS[wpDayIdx(w)] === day) names.push(w.n);
        });
        if (!names.length) return '<span class="et-none">途经点：无</span>';
        var shown = names.slice(0, 5);
        var html = shown.map(function (n) { return '<span class="et-chip">' + escapeHtml(n) + '</span>'; }).join('');
        if (names.length > 5) html += '<span class="et-chip more">+' + (names.length - 5) + '</span>';
        return html;
    }
    function renderEditDays() {
        var box = document.getElementById('editDayList');
        if (!box) return;
        box.innerHTML = '';
        var segLocked = (typeof STARTS !== 'undefined' && STARTS.length > 1 && typeof start !== 'undefined' && start !== STARTS[0].id);
        var merged = Edit._mergedIds();
        var vi = 0;
        DAYS.forEach(function (d, i) {
            if (merged.indexOf(d.id) >= 0) return;   // S25：已并入前一天，显示层隐藏
            vi++;
            var card = document.createElement('div');
            card.className = 'et-day';
            var rest = !d.altKm || (d.altKm[1] - d.altKm[0]) < 1;   // S25 休整占位
            var top = document.createElement('div');
            top.className = 'et-day-top';
            top.innerHTML = '<span class="et-tag">' + dayDateTag(d, vi - 1) + (rest ? ' · 休整' : '') + '</span>';
            var txt = document.createElement('button');
            txt.className = 'et-txt';
            txt.textContent = d.title;
            txt.onclick = function () {
                var v = editAsk('第 ' + d.id + ' 天标题', d.title);
                if (v !== null) Edit.setDayField(d.id, 'title', v);
            };
            top.appendChild(txt);
            card.appendChild(top);
            var sub = document.createElement('div');
            sub.className = 'et-sub';
            sub.textContent = (rest ? '休整占位 · 往里归点可复活，或并入前一天' : d.note + (d.stay ? ' · 住' + d.stay : '') + (d.km ? ' · ' + d.km + 'km' : ''));
            card.appendChild(sub);
            var chips = document.createElement('div');
            chips.className = 'et-chips';
            chips.innerHTML = wpChips(d);
            card.appendChild(chips);
            if (rest) {
                var mg = document.createElement('button');
                mg.className = 'edit-mini et-merge';
                mg.textContent = '并入前一天';
                mg.onclick = function () {
                    if (Edit.mergeDay(d.id)) etToast('已并入前一天，编号已重排');
                };
                card.appendChild(mg);
            } else if (d.path && d.altKm) {
                if (segLocked) {
                    var hint = document.createElement('div');
                    hint.className = 'et-seg-hint';
                    hint.textContent = Edit.segViewHint();
                    card.appendChild(hint);
                } else {
                    var seg = document.createElement('div');
                    seg.className = 'et-seg';
                    seg.appendChild(Edit.makeBoundarySelect(d, 0));
                    seg.appendChild(document.createTextNode(' → '));
                    seg.appendChild(Edit.makeBoundarySelect(d, 1));
                    card.appendChild(seg);
                }
            }
            box.appendChild(card);
        });
    }
    function renderEtMarks() {
        var box = document.getElementById('etMarks');
        if (!box) return;
        box.innerHTML = '';
        ALT_MARKS.forEach(function (m) {
            var row = document.createElement('div');
            row.className = 'et-mark';
            row.innerHTML = '<span class="mn">' + escapeHtml(m.n) + '</span>';
            var b = document.createElement('button');
            b.className = 'et-mk';
            b.textContent = '改名';
            b.onclick = function () {
                var v = editAsk('地名显示名（原始名：' + m.n + '）', m.n);
                if (v !== null) Edit.setMarkName(m.n, v);
            };
            row.appendChild(b);
            box.appendChild(row);
        });
    }
    /* 联动刷新总入口：任何编辑操作后重绘三个 Tab（函数提升，可在上文各处安全调用） */
    function refreshEditTabs() {
        var bar = editBar;
        if (!bar) return;
        var map = { trip: 'etPaneTrip', wp: 'etPaneWp', more: 'etPaneMore' };
        Object.keys(map).forEach(function (k) {
            var pane = document.getElementById(map[k]);
            if (pane && pane.style) pane.style.display = (Edit.tab === k) ? '' : 'none';
        });
        Array.prototype.forEach.call(document.querySelectorAll ? document.querySelectorAll('.et-tab') : [], function (t) {
            if (t && t.classList) t.classList.toggle('on', !!(t.getAttribute && t.getAttribute('data-et') === Edit.tab));
        });
        renderEditDays();
        if (typeof Wp !== 'undefined' && Wp && Wp.renderList) Wp.renderList();
        renderEtMarks();
    }
    /* Tab 头点击（bind 一次；mock 下 querySelectorAll 为空则逐个兜底） */
    (function bindEditTabs() {
        function bindOne(btn, name) {
            if (!btn || typeof btn.onclick === 'undefined') return;
            btn.onclick = function () { Edit.showTab(name); };
        }
        var tabs = document.querySelectorAll ? document.querySelectorAll('.et-tab') : [];
        var names = ['trip', 'wp', 'more'];
        Array.prototype.forEach.call(tabs, function (t, i) {
            if (t && t.getAttribute) bindOne(t, t.getAttribute('data-et') || names[i]);
        });
        bindOne(document.getElementById('etTabTrip'), 'trip');
    })();

    /* ============================================================================
     * 途经点增删向导（S13：自定义线路第一块，用户已拍板）
     * overlay 语义：改动写 localStorage（xianlumap.waypoints.<routeId>），不动
     * route-defs 包。新途经点不参与当前渲染（几何是构建产物）——面板与导出
     * 全程如实标注「待构建」，不假装已生效。
     * 两档云端构建触发：
     *   档一（自动尝试）：用户在本机配置了 GitHub PAT（localStorage，仅存本机）
     *     → 直接调 workflow_dispatch API 触发 build.yml 并轮询进度；
     *   档二（兜底）：无 token → 下载 route-<id>.waypoints.json + 复制 ROUTE_BUILD
     *     段 + 打开 Actions 页面（owner/repo 可填则生成直链），维护者代跑后刷新即见。
     * 全程通用：不出现任何具体线路名（线路身份只来自 ROUTE_META.key）。
     * ========================================================================== */

    /* GCJ-02 → WGS-84（标准公开算法，与 tools/lib/build-lib.js 同源；
       搜索/点选拿到的是 GCJ-02，导回包时按包 inputDatum 转换） */
    var _WZ = { A: 6378245.0, EE: 0.00669342162296594323 };
    function _outOfChina(lat, lng) {
        return (lng < 72.004 || lng > 137.8347) || (lat < 0.8293 || lat > 55.8271);
    }
    function _tfLat(x, y) {
        var r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
        r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
        r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
        r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
        return r;
    }
    function _tfLng(x, y) {
        var r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
        r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
        r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
        r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
        return r;
    }
    function gcj2wgsB(lat, lng) {
        if (_outOfChina(lat, lng)) return [lat, lng];
        var dLat = _tfLat(lng - 105, lat - 35), dLng = _tfLng(lng - 105, lat - 35);
        var rad = lat / 180 * Math.PI, magic = Math.sin(rad);
        magic = 1 - _WZ.EE * magic * magic;
        var sm = Math.sqrt(magic);
        dLat = (dLat * 180) / ((_WZ.A * (1 - _WZ.EE)) / (magic * sm) * Math.PI);
        dLng = (dLng * 180) / (_WZ.A / sm * Math.cos(rad) * Math.PI);
        return [lat - dLat, lng - dLng];
    }

    var WP_KEY = 'xianlumap.waypoints.' + ROUTE_META.key;
    var WP_INPUT_WGS = !!(typeof ROUTE_BUILD !== 'undefined' && ROUTE_BUILD && ROUTE_BUILD.inputDatum === 'wgs84');
    function wpLoad() {
        try {
            var raw = localStorage.getItem(WP_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) {}
        return null;
    }
    function wpSave(list) {
        try {
            if (list && list.length) localStorage.setItem(WP_KEY, JSON.stringify({ list: list }));
            else localStorage.removeItem(WP_KEY);
        } catch (e) {}
        try { if (typeof Sync !== 'undefined' && Sync.bumpLocal) Sync.bumpLocal(); } catch (e) {}
        refreshWpBadge();
    }
    /* 初始列表 = 包内现有途经点（键与顺序保留）；overlay 存在则以 overlay 为准 */
    function wpBaseList() {
        var out = [];
        if (typeof ROUTE_BUILD !== 'undefined' && ROUTE_BUILD && ROUTE_BUILD.waypoints) {
            Object.keys(ROUTE_BUILD.waypoints).forEach(function (k) {
                var w = ROUTE_BUILD.waypoints[k];
                out.push({ key: k, n: w.n, p: [w.p[0], w.p[1]], alt: w.alt, d: w.d || '' });
            });
        }
        return out;
    }
    var Wp = {
        list: (wpLoad() || {}).list || wpBaseList(),
        dirty: function () { return !!wpLoad(); },
        add: function (name, gcjLat, gcjLng) {
            var p = WP_INPUT_WGS ? gcj2wgsB(gcjLat, gcjLng) : [gcjLat, gcjLng];
            var key = 'wp' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
            this.list.push({ key: key, n: String(name).slice(0, 20), p: [+p[0].toFixed(6), +p[1].toFixed(6)], alt: 500, d: '' });
            wpSave(this.list);
            return key;
        },
        move: function (idx, dir) {   // dir: -1 上移 / +1 下移
            var j = idx + dir;
            if (idx < 0 || idx >= this.list.length || j < 0 || j >= this.list.length) return false;
            var t = this.list[idx];
            this.list[idx] = this.list[j];
            this.list[j] = t;
            wpSave(this.list);
            return true;
        },
        remove: function (idx) {
            if (idx < 0 || idx >= this.list.length) return false;
            this.list.splice(idx, 1);
            wpSave(this.list);
            return true;
        },
        clear: function () {
            this.list = wpBaseList();
            try { localStorage.removeItem(WP_KEY); } catch (e) {}
            refreshWpBadge();
        },
        /* 云同步恢复用：整体替换 overlay（null = 清除回包内基准；wpSave 顺带刷徽标） */
        replaceAll: function (list) {
            this.list = (list && list.length) ? list : wpBaseList();
            wpSave((list && list.length) ? this.list : null);
        },
        /* 生成 legs 初分：每段 from + ≤4 via + to（自动初分，标题/备注待人工润色） */
        buildLegs: function () {
            var legs = [];
            var L = this.list;
            for (var i = 0; i < L.length - 1; i += 5) {
                var seg = L.slice(i, Math.min(i + 6, L.length));
                if (seg.length < 2) break;
                legs.push({
                    id: legs.length + 1,
                    title: seg[0].n + ' → ' + seg[seg.length - 1].n,
                    note: '途经点向导自动初分，标题/备注请人工润色',
                    zoom: 8,
                    from: seg[0].key,
                    to: seg[seg.length - 1].key,
                    via: seg.slice(1, -1).map(function (w) { return w.key; })
                });
            }
            return legs;
        },
        buildWaypoints: function () {
            var out = {};
            this.list.forEach(function (w) {
                out[w.key] = { n: w.n, p: [w.p[0], w.p[1]], alt: w.alt || 500, d: w.d || '' };
            });
            return out;
        },
        exportJson: function () {
            return {
                route: ROUTE_META.key,
                generatedAt: new Date().toISOString().slice(0, 10),
                inputDatum: WP_INPUT_WGS ? 'wgs84' : 'gcj02',
                waypoints: this.buildWaypoints(),
                legs: this.buildLegs()
            };
        },
        exportJs: function () {
            var j = this.exportJson();
            return '/* ===== 途经点向导生成 ' + j.generatedAt + ' · legs 为自动初分，标题/备注请人工润色 ===== */\n' +
                'ROUTE_BUILD.waypoints = ' + JSON.stringify(j.waypoints, null, 2) + ';\n' +
                'ROUTE_BUILD.legs = ' + JSON.stringify(j.legs, null, 2) + ';\n';
        }
    };

    /* ---------- 面板 UI ---------- */
    function refreshWpBadge() {
        var b = document.getElementById('btnEdit');
        if (b) {
            var n = Wp.dirty() ? Wp.list.length : 0;
            b.textContent = n ? '✏️ 编辑模式 · ' + n + ' 途经点待构建' : '✏️ 编辑模式';
        }
        try { refreshEditTabs(); } catch (e) {}   // S19：途经点增删 → 行程 chips / [Dn] 徽标联动
    }
    (function buildWaypointPanel() {
        if (!editBar) return;
        var css = document.createElement('style');
        css.textContent =
            '.wp-sec{margin-top:8px;border-top:1px dashed #fcd34d;padding-top:8px;}' +
            '.wp-head{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;color:#92400e;}' +
            '.wp-badge{font-size:10px;background:#fff7ed;border:1px solid #fdba74;color:#c2410c;border-radius:8px;padding:0 6px;display:none;}' +
            '.wp-note{font-size:10px;color:#b45309;margin:4px 0;line-height:1.5;}' +
            '.wp-item{display:flex;align-items:center;gap:4px;font-size:11px;color:#334155;padding:2px 0;}' +
            '.wp-item .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
            '.wp-item button{width:20px;height:20px;border:1px solid #e2e8f0;background:#fff;border-radius:5px;cursor:pointer;font-size:10px;line-height:1;padding:0;}' +
            '.wp-item button:hover{background:#fef3c7;}' +
            '.wp-search{width:100%;box-sizing:border-box;font-size:11px;border:1px solid #e2e8f0;border-radius:6px;padding:4px 6px;margin-top:4px;font-family:inherit;}' +
            '.wp-row{display:flex;gap:6px;margin-top:5px;}' +
            '.wp-row .edit-mini{flex:1;margin-right:0;}' +
            '.wp-pick-on{background:#b45309 !important;}' +
            '#wpModal{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:var(--z-guide,1400);' +
            'width:min(620px,calc(100vw - 40px));background:#fff;border:1px solid #e2e8f0;border-radius:14px;' +
            'box-shadow:0 16px 48px rgba(15,23,42,.22);padding:16px 18px;font-family:inherit;}' +
            '#wpModal h3{margin:0 0 8px;font-size:14.5px;color:#0f172a;}' +
            '#wpModal textarea{width:100%;box-sizing:border-box;height:150px;font-size:10.5px;border:1px solid #e2e8f0;' +
            'border-radius:8px;padding:8px;font-family:ui-monospace,Menlo,monospace;}' +
            '#wpModal .mrow{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center;}' +
            '#wpModal input[type=text],#wpModal input[type=password]{font-size:11px;border:1px solid #e2e8f0;border-radius:6px;padding:4px 6px;width:120px;font-family:inherit;}' +
            '#wpModal .ghlog{font-size:10.5px;color:#64748b;margin-top:6px;line-height:1.6;white-space:pre-wrap;}';
        css.textContent +=
            /* S23 途经点行：移动手势（左滑删除 / 长按拖动），桌面列隐藏 */
            '.et-wp{position:relative;overflow:hidden;}' +
            '.et-wp-delunder{position:absolute;right:0;top:2px;bottom:2px;width:72px;border:none;border-radius:8px;background:#dc2626;' +   /* 内缩 2px：行有纵向 padding，防底部露红边 */
            'color:#fff;font-size:13px;font-weight:600;display:none;cursor:pointer;font-family:inherit;}' +
            '.et-wp-body{flex:1;min-width:0;display:flex;align-items:center;gap:6px;background:#fff;position:relative;}' +
            '.et-wp.lift{z-index:10;}' +
            '.et-wp.lift .et-wp-body{box-shadow:0 8px 24px rgba(15,23,42,.22);border-radius:10px;background:#fff;}' +
            '.et-wp.swiped .et-wp-body{transform:translateX(-72px);}' +
            '.et-wp-body{transition:transform .22s ease;}' +
            '.et-wp.swiping .et-wp-body{transition:none;}' +
            '.et-dayno::after{content:" ▾";font-size:8.5px;color:#94a3b8;}' +   /* S23：徽标可点发现性 */
            '@media (max-width:768px){' +
            '.et-wp-delunder{display:block;}' +
            '.et-wp .mv,.et-wp .del{display:none;}' +   /* 行上只剩 ☰ 名 [Dn] */
            '.et-wp-body{padding:2px 0;}' +
            '}';
        (document.head || document.documentElement).appendChild(css);
        /* S19：途经点/出发日期的 DOM 已并入编辑面板 Tab 模板（etPaneWp / etPaneTrip），
           这里只保留接线：renderList / 搜索 / 地图点选 / 生成弹层。 */

        // 出发日期行（排期 S13）：现在位于行程 Tab，接线不变
        refreshWpBadge();
        var depInput = document.getElementById('depDate');
        if (depInput) {
            depInput.value = (typeof ROUTE_META !== 'undefined' && ROUTE_META.departureDate) || '';
            depInput.onchange = function () { Edit.setDeparture(depInput.value || null); };
        }
        var depClearBtn = document.getElementById('depClear');
        if (depClearBtn) depClearBtn.onclick = function () { Edit.setDeparture(null); };


        /* S23 移动手势（≤768 触屏）：①整行左滑露出删除钮 ②长按 ☰ 350ms 跟手拖动排序。
           桌面（宽屏/鼠标）走 HTML5 DnD + ↑↓✕，不受影响。 */
        var wpSwipe = null, wpLift = null, wpAutoScroll = null;
        function bindWpGestures(row, i) {
            if (!row || typeof row.addEventListener !== 'function') return;
            var body = row.querySelector ? row.querySelector('.et-wp-body') : null;
            var grip = row.querySelector ? row.querySelector('.grip') : null;
            var delBtn = row.querySelector ? row.querySelector('.et-wp-delunder') : null;
            if (delBtn && typeof delBtn.onclick !== 'undefined') {
                delBtn.onclick = function () { wpRowDelete(i); };   // 左滑后点红钮即删（两步刻意操作，不再 confirm）
            }
            if (!body || typeof body.addEventListener !== 'function') return;
            body.addEventListener('touchstart', function (e) {
                if (!wpNarrow()) return;
                var t = e.touches && e.touches[0];
                if (!t) return;
                wpSwipe = { x0: t.clientX, y0: t.clientY, row: row, body: body, live: false };
            }, { passive: true });
            body.addEventListener('touchmove', function (e) {
                if (!wpSwipe || wpSwipe.row !== row) return;
                var t = e.touches && e.touches[0];
                if (!t) return;
                var dx = t.clientX - wpSwipe.x0, dy = t.clientY - wpSwipe.y0;
                if (!wpSwipe.live) {
                    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
                    if (Math.abs(dy) >= Math.abs(dx)) { wpSwipe = null; return; }   // 纵向滚动：让路
                    wpSwipe.live = true;
                }
                if (e.cancelable && typeof e.preventDefault === 'function') e.preventDefault();
                row.classList.add('swiping');
                body.style.transform = 'translateX(' + Math.max(-72, Math.min(0, dx)) + 'px)';
                wpSwipe.dx = dx;
            }, { passive: false });
            function endSwipe() {
                if (!wpSwipe || wpSwipe.row !== row) return;
                var dx = wpSwipe.dx || 0;
                wpSwipe = null;
                row.classList.remove('swiping');
                body.style.transform = '';
                if (dx <= -64) row.classList.add('swiped');   // 露出删除钮，点「删除」或右滑归位
                else row.classList.remove('swiped');
            }
            body.addEventListener('touchend', endSwipe);
            /* touchcancel 也按累计位移结算：浏览器抢占手势（滚动判定）时已滑够距离照样生效 */
            body.addEventListener('touchcancel', endSwipe);
            /* 长按 ☰ 拖动排序 */
            if (!grip || typeof grip.addEventListener !== 'function') return;
            var lpTimer = null;
            grip.addEventListener('touchstart', function (e) {
                if (!wpNarrow()) return;
                var t = e.touches && e.touches[0];
                if (!t) return;
                lpTimer = setTimeout(function () {
                    lpTimer = null;
                    var list = document.getElementById('wpList');
                    var rows = list ? list.querySelectorAll('.et-wp') : [];
                    if (!rows.length) return;
                    var from = i;
                    wpLift = { row: row, body: body, from: from, y0: t.clientY, dy: 0, rowH: rows[1] && rows[0] ? (rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top) : 48 };
                    row.classList.add('lift');
                    if (e.cancelable && typeof e.preventDefault === 'function') { try { e.preventDefault(); } catch (er) {} }
                    wpAutoScroll = setInterval(function () {   // 贴边自动滚动
                        try {
                            var lr = list.getBoundingClientRect();
                            if (wpLift && t.clientY < lr.top + 56) list.scrollTop -= 10;
                            else if (wpLift && t.clientY > lr.bottom - 56) list.scrollTop += 10;
                        } catch (er) {}
                    }, 90);
                }, 350);
            }, { passive: true });
            grip.addEventListener('touchmove', function (e) {
                if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }   // 移动则取消长按
                if (!wpLift || wpLift.row !== row) return;
                var t = e.touches && e.touches[0];
                if (!t) return;
                if (e.cancelable && typeof e.preventDefault === 'function') e.preventDefault();
                wpLift.dy = t.clientY - wpLift.y0;
                body.style.transform = 'translateY(' + wpLift.dy + 'px) scale(1.02)';
            }, { passive: false });
            function endLift() {
                if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
                if (wpAutoScroll) { clearInterval(wpAutoScroll); wpAutoScroll = null; }
                if (!wpLift || wpLift.row !== row) return;
                var from = wpLift.from, dy = wpLift.dy, rowH = wpLift.rowH || 48;
                wpLift = null;
                row.classList.remove('lift');
                body.style.transform = '';
                var target = Math.max(0, Math.min(Wp.list.length - 1, from + Math.round(dy / rowH)));
                if (target !== from) wpRowMove(from, target);   // 落点语义 = 原 ↑↓ 累加
            }
            grip.addEventListener('touchend', endLift);
            grip.addEventListener('touchcancel', endLift);
        }
        function renderList() {
            var el = document.getElementById('wpList');
            if (!el) return;
            el.innerHTML = '';
            Wp.list.forEach(function (w, i) {
                var row = document.createElement('div');
                row.className = 'et-wp';
                /* S23 行结构：左滑删除 underlay + body 包裹层（桌面视觉不变，移动手势挂 body） */
                row.innerHTML = '<button class="et-wp-delunder">删除</button>' +
                    '<div class="et-wp-body">' +
                    '<span class="grip" title="拖动排序（桌面 HTML5 拖，触屏长按 ☰ 拖动）">☰</span>' +
                    '<span class="t">' + escapeHtml(w.n) + '</span>' +
                    '<button class="et-dayno" title="点我改归属天">' + wpDayBadge(w) + '</button>' +
                    '<button class="mv" title="上移">↑</button><button class="mv" title="下移">↓</button>' +
                    '<button class="del" title="删除">✕</button></div>';
                var bs = row.querySelectorAll('button');
                if (!bs.length) { el.appendChild(row); return; }   // mock DOM 无 querySelectorAll 结果
                /* 接线顺序：徽标也是 <button>，先接 ↑↓✕（桌面的操作列），再接徽标（S20 归天） */
                bs[0].onclick = function () { Wp.move(i, -1); renderList(); };
                bs[1].onclick = function () { Wp.move(i, 1); renderList(); };
                bs[2].onclick = function () {
                    if (editAsk('删除途经点「' + w.n + '」？', '确定') !== null) { Wp.remove(i); renderList(); }
                };
                var badgeBtn = row.querySelector ? row.querySelector('.et-dayno') : null;
                if (badgeBtn && typeof badgeBtn.onclick !== 'undefined') {
                    badgeBtn.onclick = function (ev) {
                        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
                        openDayPick(i);
                    };
                }
                /* 桌面拖动排序（HTML5 DnD；触屏走长按☰，见下） */
                var body = row.querySelector ? row.querySelector('.et-wp-body') : null;
                if (body && body.setAttribute) body.setAttribute('draggable', 'true');
                if (body) {
                    body.ondragstart = function (ev) {
                        try { ev.dataTransfer.setData('text/plain', String(i)); } catch (e) {}
                    };
                    body.ondragover = function (ev) { try { ev.preventDefault(); } catch (e) {} };
                    body.ondrop = function (ev) {
                        try {
                            var from = parseInt(ev.dataTransfer.getData('text/plain'), 10);
                            if (isNaN(from) || from === i) return;
                            ev.preventDefault();
                            wpRowMove(from, i);
                        } catch (e) {}
                    };
                }
                bindWpGestures(row, i);
                el.appendChild(row);
            });
            var badge = document.getElementById('wpBadge');
            if (badge) badge.style.display = Wp.dirty() ? '' : 'none';
            try { if (typeof renderEditDays === 'function') renderEditDays(); } catch (e) {}   // S19：途经点变化 → 行程 chips 联动
        }
        renderList();
        Wp.renderList = renderList;

        /* 搜索：高德输入提示（AMap.AutoComplete 插件；key 来自 key.local.js 模式） */
        (function setupSearch() {
            var input = document.getElementById('wpSearch');
            if (!input || typeof AMap === 'undefined' || !AMap.plugin) return;
            try {
                AMap.plugin(['AMap.AutoComplete', 'AMap.Geocoder'], function () {
                    var ac = new AMap.AutoComplete({ input: input, citylimit: false });
                    ac.on('select', function (e) {
                        var poi = e.poi;
                        if (!poi || !poi.location) return;
                        Wp.add(poi.name, poi.location.getLat(), poi.location.getLng());
                        input.value = '';
                        renderList();
                    });
                });
            } catch (err) {}
        })();

        /* 地图点选：开 → 点击地图取坐标，逆地理出名字 */
        var picking = false;
        var pickHandler = null;
        var pickBtn = document.getElementById('wpPick');
        if (pickBtn) {
            pickBtn.onclick = function () {
                picking = !picking;
                pickBtn.classList.toggle('wp-pick-on', picking);
                pickBtn.textContent = picking ? '📍 点选模式：点地图…' : '📍 地图点选';
                if (typeof map === 'undefined' || !map || !map.on) return;
                if (picking) {
                    pickHandler = function (e) {
                        var lnglat = e.lnglat;
                        var lat = lnglat.getLat(), lng = lnglat.getLng();
                        var name = '点选点(' + lat.toFixed(3) + ',' + lng.toFixed(3) + ')';
                        Wp.add(name, lat, lng);
                        renderList();
                        try {
                            if (AMap && AMap.plugin) {
                                AMap.plugin('AMap.Geocoder', function () {
                                    new AMap.Geocoder().getAddress([lng, lat], function (st, res) {
                                        if (st === 'complete' && res.regeocode) {
                                            var cd = res.regeocode.addressComponent;
                                            var nm = (cd.township || cd.district || cd.street || '').toString();
                                            var item = Wp.list.filter(function (w) { return w.n === name; })[0];
                                            if (item && nm) { item.n = nm.slice(0, 20); wpSave(Wp.list); renderList(); }
                                        }
                                    });
                                });
                            }
                        } catch (err) {}
                    };
                    map.on('click', pickHandler);
                } else if (pickHandler) {
                    map.off('click', pickHandler);
                    pickHandler = null;
                }
            };
        }

        /* 生成新版线路：弹层 = ROUTE_BUILD 段 + 下载 + 两档云端构建触发 */
        var genBtn = document.getElementById('wpGen');
        if (genBtn) genBtn.onclick = openWpModal;

        function openWpModal() {
            var old = document.getElementById('wpModal');
            if (old) old.remove();
            var json = Wp.exportJson();
            var m = document.createElement('div');
            m.id = 'wpModal';
            m.innerHTML =
                '<h3>生成新版线路 · ' + ROUTE_META.name + '</h3>' +
                '<div class="wp-note">① 复制下方 ROUTE_BUILD 段（替换包内同名两段；legs 为自动初分，' +
                '标题/备注建议人工润色）或下载 JSON 备份；② 触发云端构建；③ 构建完成后刷新即见。</div>' +
                '<textarea id="wpJs" readonly></textarea>' +
                '<div class="mrow">' +
                '<button class="edit-mini" id="wpCopy">复制 ROUTE_BUILD 段</button>' +
                '<button class="edit-mini" id="wpDl">下载 waypoints.json</button>' +
                '<button class="edit-mini" id="wpClose">关闭</button>' +
                '</div>' +
                '<div class="mrow" style="margin-top:10px;border-top:1px solid #f1f5f9;padding-top:8px;">' +
                '<b style="font-size:11.5px;color:#0f766e;">云端构建（二选一）</b></div>' +
                '<div class="mrow">' +
                '<span style="font-size:10.5px;color:#64748b;">档一（自动）：</span>' +
                '<input type="text" id="ghOwner" placeholder="owner">' +
                '<input type="text" id="ghRepo" placeholder="repo">' +
                '<input type="password" id="ghToken" placeholder="GitHub PAT（仅存本机）">' +
                '<button class="edit-mini" id="ghGo">触发 workflow</button>' +
                '</div>' +
                '<div class="mrow"><span style="font-size:10.5px;color:#64748b;">档二（兜底）：</span>' +
                '<span style="font-size:10.5px;color:#475569;">下载文件 + 复制上面代码段，交给维护者代跑</span>' +
                '<button class="edit-mini" id="ghOpen">打开 Actions 页</button></div>' +
                '<div class="ghlog" id="ghLog"></div>';
            document.body.appendChild(m);
            document.getElementById('wpJs').value = Wp.exportJs();
            document.getElementById('wpClose').onclick = function () { m.remove(); };
            document.getElementById('wpCopy').onclick = function () {
                copyText(Wp.exportJs());
                editNotice('ROUTE_BUILD 段已复制，粘贴回 route-defs/' + ROUTE_META.key + '.js 对应位置。');
            };
            document.getElementById('wpDl').onclick = function () {
                var blob = new Blob([JSON.stringify(json, null, 1)], { type: 'application/json' });
                var a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'route-' + ROUTE_META.key + '.waypoints.json';
                document.body.appendChild(a); a.click(); a.remove();
            };
            /* GitHub 配置本机持久化（token 只进 localStorage，不上任何服务器除 GitHub API） */
            var GH_CFG_KEY = 'xlm-gh-config';
            var ghCfg = {};
            try { ghCfg = JSON.parse(localStorage.getItem(GH_CFG_KEY) || '{}') || {}; } catch (e) {}
            document.getElementById('ghOwner').value = ghCfg.owner || '';
            document.getElementById('ghRepo').value = ghCfg.repo || '';
            document.getElementById('ghToken').value = ghCfg.token || '';
            ['ghOwner', 'ghRepo', 'ghToken'].forEach(function (id) {
                document.getElementById(id).onchange = function () {
                    ghCfg = {
                        owner: document.getElementById('ghOwner').value.trim(),
                        repo: document.getElementById('ghRepo').value.trim(),
                        token: document.getElementById('ghToken').value.trim()
                    };
                    try { localStorage.setItem(GH_CFG_KEY, JSON.stringify(ghCfg)); } catch (e) {}
                };
            });
            document.getElementById('ghOpen').onclick = function () {
                var o = document.getElementById('ghOwner').value.trim();
                var r = document.getElementById('ghRepo').value.trim();
                var url = (o && r)
                    ? 'https://github.com/' + o + '/' + r + '/actions/workflows/build.yml'
                    : 'https://github.com/actions';
                window.open(url, '_blank');
            };
            document.getElementById('ghGo').onclick = function () {
                var log = document.getElementById('ghLog');
                var owner = document.getElementById('ghOwner').value.trim();
                var repo = document.getElementById('ghRepo').value.trim();
                var token = document.getElementById('ghToken').value.trim();
                if (!owner || !repo || !token) {
                    log.textContent = '档一需要填 owner / repo / PAT（仅存本机）。不想填就走档二。';
                    return;
                }
                var base = 'https://api.github.com/repos/' + owner + '/' + repo;
                log.textContent = '触发 workflow_dispatch…';
                fetch(base + '/actions/workflows/build.yml/dispatches', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + token,
                        'Accept': 'application/vnd.github+json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ ref: 'main', inputs: { routeId: ROUTE_META.key } })
                }).then(function (r) {
                    if (r.status === 204) {
                        log.textContent = '已触发 ✅ 轮询构建状态…';
                        var since = Date.now();
                        var tries = 0;
                        var timer = setInterval(function () {
                            tries++;
                            fetch(base + '/actions/workflows/build.yml/runs?per_page=3', {
                                headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' }
                            }).then(function (r2) { return r2.json(); }).then(function (d) {
                                var run = (d.workflow_runs || []).filter(function (x) {
                                    return new Date(x.created_at).getTime() >= since - 30000;
                                })[0];
                                if (!run) {
                                    log.textContent = '等待 run 出现…（' + tries + '）';
                                } else {
                                    log.textContent = 'run #' + run.run_number + '：' + run.status +
                                        (run.conclusion ? ' / ' + run.conclusion : '') +
                                        '\n' + (run.html_url || '');
                                    if (run.status === 'completed') {
                                        clearInterval(timer);
                                        log.textContent += run.conclusion === 'success'
                                            ? '\n✅ 构建成功，刷新页面即见新版。'
                                            : '\n❌ 构建失败：' + run.conclusion + '，详情见上方链接。';
                                    }
                                }
                            }).catch(function (e) { log.textContent = '轮询出错：' + e.message; });
                            if (tries > 40) { clearInterval(timer); log.textContent += '\n轮询超时，请打开 Actions 页查看。'; }
                        }, 5000);
                    } else {
                        r.text().then(function (t) { log.textContent = '触发失败 HTTP ' + r.status + '：' + t.slice(0, 200); });
                    }
                }).catch(function (e) { log.textContent = '请求失败：' + e.message; });
            };
        }
    })();

    /* 复制小工具（向导与引导共用） */
    function copyText(t) {
        try {
            if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(t);
                return true;
            }
        } catch (e) {}
        try {
            var ta = document.createElement('textarea');
            ta.value = t;
            document.body.appendChild(ta);
            ta.select();
            var ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
            ta.remove();
            return ok;
        } catch (e) { return false; }
    }
    function escapeHtml(t) {
        return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    /* 恢复原始数据：一并清途经点 overlay */
    var _origReset = Edit.reset.bind(Edit);
    Edit.reset = function () {
        Wp.clear();
        if (Wp.renderList) Wp.renderList();
        _origReset();
    };

    /* ?wpautotest=1：程序化走通 加点→排序→删点→导出（headless 冒烟用） */
    (function wpAutotest() {
        if (typeof location === 'undefined' || !/[?&]wpautotest=1/.test(location.search)) return;
        if (typeof document === 'undefined') return;
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(function () {
                try {
                    Edit.enter();
                    var before = Wp.list.length;
                    Wp.add('冒烟点A', 30.7, 104.1);
                    Wp.add('冒烟点B', 30.5, 103.9);
                    Wp.move(Wp.list.length - 1, -1);
                    Wp.remove(Wp.list.length - 1);
                    var js = Wp.exportJs();
                    var j = Wp.exportJson();
                    var marker = document.createElement('div');
                    marker.id = 'wp-autotest-result';
                    marker.textContent = 'WPAUTOTEST ' + JSON.stringify({
                        before: before,
                        after: Wp.list.length,
                        legs: j.legs.length,
                        wp: Object.keys(j.waypoints).length,
                        hasWaypointsAssign: js.indexOf('ROUTE_BUILD.waypoints =') >= 0,
                        hasLegsAssign: js.indexOf('ROUTE_BUILD.legs =') >= 0
                    });
                    document.body.appendChild(marker);
                    openWpModalSafe();
                } catch (e) {
                    var m2 = document.createElement('div');
                    m2.id = 'wp-autotest-result';
                    m2.textContent = 'WPAUTOTEST ERROR ' + e.message;
                    document.body.appendChild(m2);
                }
            }, 600);
        });
        function openWpModalSafe() {
            var btn = document.getElementById('wpGen');
            if (btn) btn.onclick();
        }
    })();

    /* ?depautotest=1：冒烟用——进入编辑模式并设出发日期（headless 截图断言） */
    (function depAutotest() {
        if (typeof location === 'undefined' || !/[?&]depautotest=1/.test(location.search)) return;
        if (typeof document === 'undefined') return;
        function go() {
            setTimeout(function () {
                try {
                    Edit.enter();
                    Edit.setDeparture('2026-10-03');
                } catch (e) {
                    var m = document.createElement('div');
                    m.id = 'dep-autotest-error';
                    m.textContent = 'DEPERROR ' + (e && e.message);
                    document.body.appendChild(m);
                }
            }, 500);
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
        else go();
    })();
