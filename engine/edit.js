/* ============================================================================
 * engine/edit.js — 页面内编辑（S5 overlay 架构 + S28 编辑内联化）
 *
 * overlay 架构：编辑不改线路包本体。改动作为 overlay 存 localStorage
 * （键 xianlumap.overlay.<routeId>，按线路隔离），启动时「包 + overlay」
 * 合并生效。下次跑 build 不会被覆盖；一键恢复原始数据 = 清 overlay。
 *
 * S28 起「编辑模式」退役（产品拍板：行程表上的改动零门槛）：
 * - 行程卡默认就地可编辑（点标题/备注/住宿 → 原位输入框，无需进入任何模式）
 * - 剖面拖天边界把手默认可用（profile.js 不再看 Edit.on）
 * - 面板双 Tab：行程 | 途经点（结构操作：加点/删点/排序/归天）；移动端选途经点即全展抽屉
 * - ⋯ 菜单 = 更多设置页（云同步/恢复原始/导入导出/地名/文案/帮助）
 * - Edit.enter/exit/isOn 仅为兼容桩（恒 false），旧调用点不崩
 *
 * 加载顺序：route-engine → planner → profile → mobile → edit → sync → ui
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
    /* ---------- S32 草稿-保存语义 ----------
       所有编辑先落内存草稿（Edit.overlay / Wp.list 即草稿），editSave() 只标脏不写盘；
       「保存修改」（Edit.commit）才把草稿 → localStorage（即原 overlay 存储）。
       「保存我的版本」（重新生成线路）与「保存修改」（存浏览器）是两个动作，文案分离。
       applyOverlay/import/云同步 从「已保存态」读写：importOverlay 直接落盘置 saved；
       Sync.stateJSON 读 Edit.saved（不是草稿），草稿脏状态不污染同步。 */
    var _draftDirty = false;
    function updateSaveBtn() {
        var b = document.getElementById('btnDraftSave');
        if (b) b.style.display = _draftDirty ? '' : 'none';
    }
    function editSave() {   // 名称沿用工整：全部编辑操作仍调 editSave()，语义 = 标脏
        _draftDirty = true;
        updateSaveBtn();
    }
    function flushStorage() {   // 草稿 → localStorage（commit / import 用）
        var s = editStore();
        if (s) s.setItem(EDIT_KEY, JSON.stringify(Edit.overlay));
        Edit.saved = JSON.parse(JSON.stringify(Edit.overlay));
        wpFlush();
        _draftDirty = false;
        updateSaveBtn();
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
        /* S28：「编辑模式」退役。行程卡默认就地可编辑、剖面把手默认可用、结构操作融入
           统一行程视图（S32）、设置走 ⋯ 菜单——不再有进入/退出的门槛。
           enter/exit/isOn 保留为兼容桩（旧调用点/测试不崩），isOn 恒 false。
           S32：overlay 即内存草稿；saved = 已保存态快照（boot/import 时更新）。 */
        on: false,
        overlay: editLoad(),
        saved: null,
        isDirty: function () { return _draftDirty; },
        /* 保存修改：草稿 → localStorage（与「保存我的版本=重新生成线路」是两个动作） */
        commit: function () { flushStorage(); return true; },
        isOn: function () { return false; },
        enter: function () {},
        exit: function () {},
        tab: 'trip',
        panelTab: 'trip',
        showTab: function (name) {   // S28：语义改为面板 Tab（'trip'|'wp'）与 ⋯ 设置页（'more'）
            if (name === 'more') { openMoreSheet(); return; }
            switchPanelTab(name);
            /* S23：首次进途经点 Tab（移动断点）给一行手势引导，做过一次不再打扰 */
            if (name === 'wp' && typeof localStorage !== 'undefined' && localStorage) {
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
        /* S33 链式：多住一晚 = 在 [a,b] 的 atKm 处拆出前半段（新克隆天，带夜宿名）。
           overlay.split 持久；连续编号由显示层保证。起点/终点节点不可删（mergeDay 侧同理守卫）。 */
        splitDay: function (id, name, atKm) {
            if (STARTS.length > 1 && start !== STARTS[0].id) { editNotice(this.segViewHint()); return false; }
            var day = editDayById(id);
            if (!day || !day.altKm) return false;
            var a = day.altKm[0], b = day.altKm[1];
            if (atKm == null) {
                /* 默认插到该天【最近的途经点】；无途经点取中点 */
                var best = null, bd = 1e9;
                if (typeof Wp !== 'undefined' && Wp.list) {
                    Wp.list.forEach(function (w) {
                        var k = routeKmOf(w.p[0], w.p[1]);
                        if (k > a + 0.5 && k < b - 0.5 && Math.abs(k - (a + b) / 2) < bd) { bd = Math.abs(k - (a + b) / 2); best = k; }
                    });
                }
                atKm = best != null ? best : +((a + b) / 2).toFixed(1);
            }
            atKm = Math.min(b - 1, Math.max(a + 1, +(+atKm).toFixed(1)));
            if (b - atKm < 1 || atKm - a < 1) { editNotice('拆分后行程不足 1km，已取消。'); return false; }
            var cloneId = 1;
            (CORE || []).concat([TAIL]).forEach(function (d) { if (d.id >= cloneId) cloneId = d.id + 1; });
            this.overlay.split = this.overlay.split || [];
            this.overlay.split.push({ srcId: id, atKm: atKm, name: String(name || '中途休整').slice(0, 20), cloneId: cloneId });
            applySplit({ srcId: id, atKm: atKm, name: name, cloneId: cloneId });
            editSave();
            renderAll();
            this.refreshDayControls();
            try { refreshEditTabs(); } catch (e) {}
            return cloneId;
        },
        /* S33 天数均分：目标 n 段。先调链段数（多了并、少了拆），再均分边界（applySeg 直写 + 单轮渲染）。
           预览走 Edit.previewEvenSplit(n)（弹层用）。 */
        previewEvenSplit: function (n) {
            var T = STARTS[0].totalKm;
            n = Math.max(1, Math.round(n));
            if (T / n < 2) return null;   // 每天至少 2km 才有意义
            var out = [];
            for (var i = 0; i < n; i++) {
                var a = +(T * i / n).toFixed(1), b = +(T * (i + 1) / n).toFixed(1);
                var nmA = nearestMarkName(a), nmB = nearestMarkName(b);
                out.push({ a: a, b: b, km: Math.round(b - a), from: nmA, to: nmB });
            }
            return out;
        },
        evenSplit: function (n) {
            if (STARTS.length > 1 && start !== STARTS[0].id) { editNotice(this.segViewHint()); return false; }
            n = Math.max(1, Math.round(n));
            var T = STARTS[0].totalKm;
            if (T / n < 2) { editNotice('总里程 ' + T + 'km 分不出 ' + n + ' 天（每天至少 2km）。'); return false; }
            var merged = this._mergedIds().slice();
            var visNow = function () { return DAYS.filter(function (d) { return merged.indexOf(d.id) < 0; }); };
            var guard = 0;
            while (visNow().length > n && guard++ < 60) {   // 多了：并最后一段入前段
                var v = visNow();
                var last = v[v.length - 1];
                if (!last.altKm) { merged.push(last.id); continue; }   // 休整占位直接隐藏
                var prev = null;
                for (var j = v.length - 2; j >= 0; j--) { if (v[j].altKm) { prev = v[j]; break; } }
                if (!prev) break;
                if (this.setSeg(prev.id, prev.altKm[0], last.altKm[1]) === false) break;
                merged.push(last.id);
            }
            while (visNow().length < n && guard++ < 120) {   // 少了：拆最长段
                var v2 = visNow(), longest = null;
                v2.forEach(function (d) { if (d.altKm && (!longest || (d.altKm[1] - d.altKm[0]) > (longest.altKm[1] - longest.altKm[0]))) longest = d; });
                if (!longest || (longest.altKm[1] - longest.altKm[0]) < 4) break;   // 拆不出 ≥1km 两半
                if (this.splitDay(longest.id, '中途休整', +((longest.altKm[0] + longest.altKm[1]) / 2).toFixed(1)) === false) break;
            }
            this.overlay.meta = this.overlay.meta || {};
            this.overlay.meta.merged = merged;
            var bounds = [];
            for (var k = 0; k <= visNow().length - 1; k++) bounds.push(+(T * k / visNow().length).toFixed(1));
            var v3 = visNow();
            for (var m = 0; m < v3.length; m++) {
                var bb = (m === v3.length - 1) ? T : bounds[m + 1];
                this.overlay.seg = this.overlay.seg || {};
                this.overlay.seg[v3[m].id] = { fromKm: +(T * m / v3.length).toFixed(1), toKm: +bb.toFixed(1) };
                applySeg(v3[m].id, +(T * m / v3.length).toFixed(1), +bb.toFixed(1));
            }
            editSave();
            renderAll();
            this.refreshDayControls();
            try { refreshEditTabs(); } catch (e) {}
            return true;
        },
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

        /* —— 编辑操作（API 与 UI 共用；每个操作立即存 overlay；S28 起无需任何模式） —— */
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
            return '途经点清单在线路数据文件 route-defs/' + key + '.js 里（文件中标注「途经点清单」的那段：名字/坐标/海拔/简介）。\n' +
                '改动流程：\n' +
                '1) 点下方「复制当前途经点清单」，粘贴到该文件里对应位置（增删点、或改行程分段的起点/途经/终点）\n' +
                '2) 运行：node tools/build-route.js ' + key + '   （重新抓取轨迹/高程）\n' +
                '3) 若途经点变了，站点也要重抓：node tools/build-stations.js ' + key + ' && node tools/validate.js ' + key + ' --fix\n' +
                '（改轨迹必须重新生成是产品铁律：页面里的路线是生成产物，不是实时算的）';
        },
        showWaypointGuide: function () {
            var old = document.getElementById('wpGuide');
            if (old) { old.remove(); return; }   // 再点一次 = 关闭
            var box = document.createElement('div');
            box.id = 'wpGuide';
            var title = document.createElement('b');
            title.className = 'wp-title';
            title.textContent = '新增/删除途经点需要重新生成线路';
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
                editNotice(okFlag ? '途经点清单已复制，粘贴回线路数据文件里的途经点清单后修改。' : '复制失败：请手动打开线路数据文件（route-defs/' + ROUTE_META.key + '.js）复制其中的途经点清单。');
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
            /* S32 语义变更：恢复原始数据 = 放弃未保存的草稿修改，恢复到【已保存态】
               （不是线路包出厂态——已保存的改动保留；localStorage 不动，确认弹窗写清楚） */
            if (editAsk('放弃未保存的修改，恢复到上次保存的状态？\n（上次保存之后的改动会丢失；线路出厂数据不再是此按钮的职责）', '确定') === null) return false;
            var savedOv = JSON.parse(JSON.stringify(this.saved || {}));
            /* S33：拆分可能往 CORE 插过克隆天——整表恢复出厂（数组长度与字段都还原） */
            if (typeof CORE !== 'undefined' && Array.isArray(CORE)) {
                CORE.length = 0;
                EDIT_PRISTINE.core.forEach(function (pd) { CORE.push(JSON.parse(JSON.stringify(pd))); });
            }
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
            this.overlay = savedOv;
            applyOverlay(savedOv);
            _draftDirty = false;
            updateSaveBtn();
            /* 途经点同样回到已保存态 */
            var savedWp = wpLoad();
            Wp.list = (savedWp && savedWp.list && savedWp.list.length) ? savedWp.list : wpBaseList();
            if (Wp.renderList) Wp.renderList();
            renderAll();
            this.refreshDayControls();
            drawProfile();
            applyMetaDom();
            try { refreshEditTabs(); } catch (e) {}
            return true;
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
            flushStorage();   // S32：导入/云同步恢复 = 已保存态读写，直接落盘、不弄脏
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

        /* —— 行程卡默认态控件（S28：无编辑模式，常驻） —— */
        refreshDayControls: function () {
            var listEl = document.getElementById('dayList');
            if (!listEl) return;
            var visible = (typeof currentDisp === 'function') ? currentDisp() : DAYS.filter(function (d) { return Edit._mergedIds().indexOf(d.id) < 0; });   // S33：显示层序（与 renderAll 同口径）
            Array.prototype.forEach.call(listEl.children, function (li, i) {
                var day = visible[i];
                if (!day) return;
                Array.prototype.forEach.call(li.querySelectorAll('.day-stay'), function (n) { n.remove(); });
                // 住宿点就地编辑入口（标题/备注的点击捕获在 buildPanelChrome 里，常驻）
                var col = (li.querySelector && li.querySelector('.day-col')) || li;
                var stay = document.createElement('span');
                stay.className = 'day-stay';
                stay.textContent = day.stay ? '住：' + day.stay + ' ✎' : '＋住宿 ✎';
                col.appendChild(stay);
            });
        },
        updateDayRow: function (id) {
            var visible = (typeof currentDisp === 'function') ? currentDisp() : DAYS.filter(function (d) { return Edit._mergedIds().indexOf(d.id) < 0; });   // S33：显示层序
            var i = -1;
            visible.forEach(function (d, j) { if ((d.orig ? d.orig.id : d.id) === id) i = j; });
            var listEl = document.getElementById('dayList');
            if (i < 0 || !listEl || !listEl.children[i]) return;
            var li = listEl.children[i];
            var day = visible[i];
            var t = li.querySelector('.day-title'); if (t && !t.__inline) t.textContent = day.title;
            var n = li.querySelector('.day-note'); if (n && !n.__inline) n.textContent = day.note + (day.stay ? ' · 住' + day.stay : '');
            var st = li.querySelector('.day-stay'); if (st) st.textContent = day.stay ? '住：' + day.stay + ' ✎' : '＋住宿 ✎';
        }
    };

    function nearestMarkName(km) {
        var best = '', bd = 1e9;
        EDIT_MARKS.forEach(function (mk) { var dd = Math.abs(mk.km - km); if (dd < bd) { bd = dd; best = mk.n; } });
        return best;
    }
    /* 分段候选：环线里程表（km 升序）。起点基准 = 主出发地（enter 时已切回）。 */
    var EDIT_MARKS = ALT_MARKS.map(function (m) { return { n: m.n, km: m.km }; })
        .sort(function (a, b) { return a.km - b.km; });

    /* ---------- overlay → 数据合并（启动时一次；导入编辑层时复用同一函数） ---------- */
    /* S33 拆分重放：overlay.split = [{srcId, atKm, name, cloneId}]——克隆天插入 CORE（紧随原天）、
       原天收窄到 [atKm,b]；clone 带 stay=夜宿名。幂等（clone 已存在则跳过）。
       CORE 数组全局可变；reset 用 EDIT_PRISTINE 整表恢复（见 Edit.reset）。 */
    function applySplit(s) {
        if (!s || editDayById(s.cloneId)) return;
        var src = editDayById(s.srcId);
        if (!src || !src.altKm) return;
        var a = src.altKm[0], b = src.altKm[1];
        var atKm = Math.min(b - 1, Math.max(a + 1, +(+s.atKm).toFixed(1)));
        var clone = JSON.parse(JSON.stringify(src));
        clone.id = s.cloneId;
        clone.stay = String(s.name || '中途休整').slice(0, 20);
        var coreArr = (typeof CORE !== 'undefined') ? CORE : null;
        if (!coreArr) return;
        var idx = -1;
        coreArr.forEach(function (d, i) { if (d.id === s.srcId) idx = i; });
        if (idx < 0) return;
        coreArr.splice(idx + 1, 0, clone);
        applySeg(s.cloneId, a, atKm);
        applySeg(s.srcId, atKm, b);
        delete src.stay;   // 夜宿名归前半段（节点 = 前半段终点）
    }
    function applyOverlay(ov) {
        if (!ov) return;
        if (ov.split) ov.split.forEach(applySplit);
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
    /* 启动合并：包 + overlay（在 ui.js 启动渲染之前执行）；saved = 已保存态快照 */
    (function bootMerge() { applyOverlay(Edit.overlay); Edit.saved = JSON.parse(JSON.stringify(Edit.overlay)); })();

    /* ---------- S32：统一行程视图（S28 双 Tab 合并）+ 常驻出发日期 + ⋯ 更多设置 ----------
       产品拍板：抽屉不再分「行程/途经点」——一个统一视图：
       - 头部条 = 行程标题 + 「保存修改」（草稿脏时出现，S32 草稿语义）+ ⋯ 设置
       - 途经点管理区（wpSec）收进列表顶部（搜索/点选/长按添加 + 行内滑删/长按拖/归天）
       - 天卡保持 S28/S29 成果；点成员长按弹菜单（改名/飞到地图）
       showTab('wp') 语义 = 聚焦途经点区（滚动+移动半屏），不再有 Tab 显隐切换。 */
    function switchPanelTab(name) {
        Edit.panelTab = (name === 'wp') ? 'wp' : 'trip';
        Edit.tab = Edit.panelTab;
        if (Edit.panelTab === 'wp') focusWpSec();
    }
    function focusWpSec() {
        var sec = document.getElementById('wpSec');
        try { if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) {}
        /* 移动端落半屏：上半屏地图可见可取点（S29-C 能力沿续到统一视图） */
        try { if (window.innerWidth <= 768 && typeof setSheet === 'function') setSheet('half'); } catch (e) {}
        try { var s = document.getElementById('wpSearch'); if (s && s.focus) setTimeout(function () { s.focus(); }, 350); } catch (e) {}
    }
    function openMoreSheet() { if (document.body && document.body.classList) document.body.classList.add('more-open'); }
    function closeMoreSheet() { if (document.body && document.body.classList) document.body.classList.remove('more-open'); }

    /* 就地编辑：点行程卡上的标题/备注/住宿 → 原位变输入框（Enter/失手保存，Esc 取消）。
       mock DOM 无 parentNode/insertBefore，直接跳过（vm 断言走 Edit.setDayField 同一提交路径）。 */
    function visibleDayAt(idx) {   // 显示层（S33：逆行时 = 镜像序列；返回显示对象，编辑经 Edit API 落原对象）
        if (idx < 0) return null;
        var disp = (typeof currentDisp === 'function') ? currentDisp() : DAYS.filter(function (d) { return Edit._mergedIds().indexOf(d.id) < 0; });
        return disp[idx] || null;
    }
    function openInlineField(li, day, field) {
        var span = li.querySelector ? li.querySelector('.day-' + field) : null;
        if (!span || span.__inline) return false;
        if (!span.parentNode || typeof span.parentNode.insertBefore !== 'function') return false;
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'day-inline';
        input.maxLength = field === 'title' ? 60 : (field === 'note' ? 80 : 20);
        input.value = field === 'stay' ? (day.stay || '') : (day[field] || '');
        span.__inline = true;
        span.style.display = 'none';
        span.parentNode.insertBefore(input, span.nextSibling);
        var done = false;
        function finish(save) {
            if (done) return; done = true;
            var v = input.value;
            if (input.remove) input.remove();
            span.__inline = false;
            span.style.display = '';
            if (save) Edit.setDayField(day.id, field, v);
            else Edit.updateDayRow(day.id);
        }
        if (input.addEventListener) {
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') finish(true);
                else if (e.key === 'Escape') finish(false);
            });
            input.addEventListener('blur', function () { finish(true); });
        }
        try { if (input.focus) input.focus(); if (input.select) input.select(); } catch (e) {}
        return true;
    }

    /* 跨 IIFE 桥：buildPanelChrome（链 UI/头部按钮）→ buildWaypointPanel（添加对话框） */
    function openStopDlg(lng, lat, name) {
        try { if (window.__wpStop && typeof window.__wpStop.open === 'function') window.__wpStop.open(lng, lat, name); } catch (e) {}
    }

    (function buildPanelChrome() {
        var panel = document.getElementById('panel');
        if (!panel) return;
        /* 1) 常驻出发日期（插在副标题之后；头部条 pt-bar 为静态 HTML，含「保存修改」按钮） */
        var anchor = null;
        try {
            var sub = panel.querySelector ? panel.querySelector('.sub') : null;
            anchor = sub ? sub.nextSibling : null;
        } catch (e) {}
        var dep = document.createElement('div');
        dep.className = 'pt-dep';
        dep.innerHTML = '<span>📅 出发日期</span><input type="date" id="depDate"><button id="depClear" class="edit-mini">清除</button>';
        if (anchor && panel.insertBefore) panel.insertBefore(dep, anchor);
        else if (panel.appendChild) panel.appendChild(dep);
        /* 「保存修改」：草稿脏时出现，点击 → 草稿落 localStorage（与「保存我的版本」是两个动作） */
        var saveBtn = document.getElementById('btnDraftSave');
        if (saveBtn) saveBtn.onclick = function () {
            Edit.commit();
            try { etToast('已保存到这台设备的浏览器'); } catch (e) {}
        };
        var pm0 = document.getElementById('panelMore');
        if (pm0) pm0.onclick = openMoreSheet;
        /* 2) 途经点管理区（S32 统一行程视图：收进列表顶部，dayList 之前） */
        var wpSec = document.createElement('div');
        wpSec.id = 'wpSec';
        wpSec.className = 'wp-sec-box slim';
        /* S33：黄色盒霸屏整改——收进可折叠管理区；搜索/类型选择移进「添加停靠点」对话框 */
        wpSec.innerHTML =
            '<button class="wp-sec-t" id="wpSecT" type="button">途经点管理（<span id="wpCount">0</span>）<span class="wp-badge" id="wpBadge">待保存生效</span><span class="wp-sec-ar">▾</span></button>' +
            '<div class="wp-sec-body" id="wpSecBody" style="display:none">' +
            '<div class="wp-note">行内：☰ 拖动排序 · 右键/左滑删除 · [Dn] 归天（拖天卡芯片也能归天）；' +
            '地图：📍 点选 / 长按。添加走头部「＋ 添加」（选类型 ⚑打卡/⛺休整）。改动进草稿，「保存修改」存本机。</div>' +
            '<div id="wpList"></div>' +
            '<div class="wp-row">' +
            '<button class="edit-mini" id="wpPick">📍 地图点选</button>' +
            '<button class="edit-mini" id="wpGuideBtn">维护指南</button>' +
            '</div>' +
            '<button id="wpGen" class="et-gen">💾 保存我的版本（导出 + 重新生成线路）</button></div>';
        var dayListEl = document.getElementById('dayList');
        if (dayListEl && dayListEl.parentNode && typeof dayListEl.parentNode.insertBefore === 'function') {
            dayListEl.parentNode.insertBefore(wpSec, dayListEl);
        } else if (panel.appendChild) panel.appendChild(wpSec);
        var wpSecT = document.getElementById('wpSecT');
        if (wpSecT) wpSecT.onclick = function () {
            var b = document.getElementById('wpSecBody');
            var open = b && b.style.display === 'none';
            if (b) b.style.display = open ? '' : 'none';
            wpSecT.setAttribute && wpSecT.setAttribute('data-open', open ? '1' : '');
            var ar = wpSecT.querySelector ? wpSecT.querySelector('.wp-sec-ar') : null;
            if (ar) ar.textContent = open ? '▴' : '▾';
        };
        /* 头部「＋ 添加」「分享」按钮 */
        var addBtn = document.getElementById('btnAddWp');
        if (addBtn) addBtn.onclick = function () { openStopDlg(null, null, ''); };
        var shareBtn = document.getElementById('btnShare');
        if (shareBtn) shareBtn.onclick = buildSharePng;
        /* 「N 天」chip 可点：天数均分弹层 */
        var chipDaysEl = document.getElementById('chipDays');
        if (chipDaysEl && chipDaysEl.parentNode) {
            chipDaysEl.parentNode.style.cursor = 'pointer';
            chipDaysEl.parentNode.title = '点我调整天数（自动均分，链上/剖面可再微调）';
            chipDaysEl.parentNode.onclick = function () { openDaysDialog(); };
        }
        /* 3) ⋯ 更多设置页（S32 大扫除：只留云同步/恢复原始/导入编辑层/显示续航设置/帮助/关于；
               地名改名迁到 ⚑ 打卡行成员长按菜单；副标题/通知条编辑撤销） */
        var msBk = document.createElement('div');
        msBk.id = 'moreBk';
        var ms = document.createElement('div');
        ms.id = 'moreSheet';
        ms.innerHTML =
            '<div class="ms-head"><span>更多设置</span><button id="msClose" class="pt-more">✕</button></div>' +
            '<div class="ms-sec">☁️ 云同步</div><div id="moreSync"></div>' +
            '<div class="ms-sec">数据</div>' +
            '<div class="ms-row">' +
            '<button class="edit-mini ms-btn" id="msReset">↩️ 恢复原始数据</button>' +
            '<button class="edit-mini ms-btn" id="msImport">📥 导入编辑层</button></div>' +
            '<div class="ms-sec">显示</div>' +
            '<div class="ms-row ms-row-check"><label class="ms-check"><input type="checkbox" id="msEvset"> 显示续航设置（默认隐藏，规划计算不受影响）</label></div>' +
            '<div class="ms-sec">❓ 帮助</div>' +
            '<div class="ms-help">改动先进草稿（点头部「保存修改」存进这台浏览器）；「保存我的版本」是把改动重新生成进线路数据，两件事。' +
            '行程卡上的标题/备注/住宿直接点文字就能改；点成员长按可改名/飞到地图；拖点芯片到别天卡 = 归天。</div>' +
            '<div class="ms-sec">关于</div>' +
            '<div class="ms-help">xianlumap · 一张有观点的地图。线路轨迹/高程/站点为公开数据整理与实地口径校验，出发前请复核营业状态。</div>';
        if (document.body && document.body.appendChild) { document.body.appendChild(msBk); document.body.appendChild(ms); }
        var mc = document.getElementById('msClose');
        if (mc) mc.onclick = closeMoreSheet;
        if (msBk) msBk.onclick = closeMoreSheet;
        var msReset = document.getElementById('msReset');
        if (msReset) msReset.onclick = function () {
            closeMoreSheet();
            Edit.reset();   // S32：确认弹窗在 reset 内部（放弃未保存修改→已保存态）
        };
        /* S32-B：续航设置显隐开关（默认隐藏；开了沿用 S31 折叠态） */
        var EVSET_KEY = 'xlm.evset.show';
        function applyEvsetVis() {
            var show = false;
            try { show = localStorage.getItem(EVSET_KEY) === '1'; } catch (e) {}
            var t = document.getElementById('evsetToggle');
            var b = document.getElementById('evsetBody');
            if (t) t.style.display = show ? '' : 'none';
            if (!show && b) b.style.display = 'none';
            var sw = document.getElementById('msEvset');
            if (sw) sw.checked = show;
            return show;
        }
        applyEvsetVis();
        var msEvset = document.getElementById('msEvset');
        if (msEvset) msEvset.onchange = function () {
            try { localStorage.setItem(EVSET_KEY, msEvset.checked ? '1' : '0'); } catch (e) {}
            applyEvsetVis();
        };
        /* 导入编辑层（file input 读文件 → 剥注释 → JSON → Edit.importOverlay 校验并应用） */
        var fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,application/json';
        fileInput.style.display = 'none';
        var msImport = document.getElementById('msImport');
        if (msImport) msImport.onclick = function () { closeMoreSheet(); fileInput.click(); };
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
        if (document.body && document.body.appendChild) document.body.appendChild(fileInput);
        /* S32 点成员通用动作：飞到地图 / 改名（长按菜单与单击共用） */
        function flyPtMember(t) {
            var flyInfo = function (lat2, lng2, tags, title2, body2) {
                try { map.setZoomAndCenter(12, [lng2, lat2]); } catch (er) {}
                openInfo(lat2, lng2, tags, title2, body2);
            };
            if (t.getAttribute && t.getAttribute('data-spot') != null) {
                var si = +t.getAttribute('data-spot');
                var sp = (typeof SPOTS !== 'undefined' ? SPOTS : [])[si];
                if (sp) flyInfo(sp.p[0], sp.p[1], [['打卡点', 's']], sp.n, sp.d);
            } else if (t.getAttribute && t.getAttribute('data-wp') != null) {
                var wi = +t.getAttribute('data-wp');
                var wp = (typeof Wp !== 'undefined' && Wp.list) ? Wp.list[wi] : null;
                if (wp) flyInfo(wp.p[0], wp.p[1], [[wp.kind === 'rest' ? '休整点' : '打卡点', 's']], wp.n,
                    (wp.d || '') + '<br><span style="color:#94a3b8;font-size:10.5px">途经点（待保存生效）</span>');
            }
        }
        function renamePtMember(t) {
            if (t.getAttribute && t.getAttribute('data-spot') != null) {
                var sp = (typeof SPOTS !== 'undefined' ? SPOTS : [])[+t.getAttribute('data-spot')];
                if (!sp) return;
                var v = editAsk('打卡点名称（原始名：' + sp.n + '）', sp.n);
                if (v !== null) Edit.setMarkName(sp.n, v);
            } else if (t.getAttribute && t.getAttribute('data-wp') != null) {
                var wp = Wp.list[+t.getAttribute('data-wp')];
                if (!wp) return;
                var v2 = editAsk('途经点名称', wp.n);
                if (v2 !== null && String(v2).trim()) { wp.n = String(v2).trim().slice(0, 20); wpSave(Wp.list); if (Wp.renderList) Wp.renderList(); try { refreshChips(); } catch (e) {} }
            }
        }
        /* S32 长按弹出成员菜单（改名迁于此；桌面右键 = contextmenu，触屏 = 500ms 长按） */
        function closePtMenu() { var m = document.getElementById('ptMenu'); if (m && m.remove) m.remove(); }
        function openPtMenu(clientX, clientY, memberEl) {
            closePtMenu();
            /* S33 设计稿第二节：链段内点成员菜单补「改为打卡/休整」（当前类型置灰）。
               仅途经点（data-wp）可改类型；SPOTS 本质是打卡点，不显示类型项。 */
            var wpIdx = (memberEl.getAttribute && memberEl.getAttribute('data-wp') != null) ? +memberEl.getAttribute('data-wp') : -1;
            if (wpIdx < 0 && memberEl.getAttribute && memberEl.getAttribute('data-wk') != null) {
                /* chips 带的是 data-wk（key）——反查索引 */
                var wk = memberEl.getAttribute('data-wk');
                Wp.list.forEach(function (w, j) { if (w.key === wk) wpIdx = j; });
            }
            var curKind = (wpIdx >= 0 && Wp.list[wpIdx]) ? (Wp.list[wpIdx].kind === 'rest' ? 'rest' : 'spot') : null;
            var m = document.createElement('div');
            m.id = 'ptMenu';
            m.className = 'pt-menu';
            m.innerHTML = '<button data-a="fly">🧭 飞到地图</button><button data-a="rename">✎ 改名</button>' +
                (wpIdx >= 0 ?
                    '<button data-a="kind-spot"' + (curKind === 'spot' ? ' disabled class="cur"' : '') + '>⚑ 改为打卡点</button>' +
                    '<button data-a="kind-rest"' + (curKind === 'rest' ? ' disabled class="cur"' : '') + '>⛺ 改为休整点</button>' : '');
            if (document.body && document.body.appendChild) document.body.appendChild(m);
            try {
                m.style.left = Math.max(8, Math.min(clientX, window.innerWidth - 150)) + 'px';
                m.style.top = Math.max(60, clientY - 10) + 'px';
            } catch (e) {}
            Array.prototype.forEach.call(m.querySelectorAll ? m.querySelectorAll('button') : [], function (b) {
                if (!b.addEventListener || !b.getAttribute) return;
                b.addEventListener('click', function () {
                    var a = b.getAttribute('data-a');
                    closePtMenu();
                    if (a === 'fly') flyPtMember(memberEl);
                    else if (a === 'rename') renamePtMember(memberEl);
                    else if (a === 'kind-spot' || a === 'kind-rest') Edit.setWpKind(wpIdx, a === 'kind-rest' ? 'rest' : 'spot');
                });
            });
            setTimeout(function () {
                try {
                    document.addEventListener('click', function h() { closePtMenu(); document.removeEventListener('click', h); });
                } catch (e) {}
            }, 10);
        }
        /* 改途经点类型（点成员菜单「改为打卡/休整」共用 API）：kind 落草稿 + 全链刷新
           （途经点列表/行程卡三类行与 chips/徽标/地图休整层一并更新） */
        Edit.setWpKind = function (wpIdx, kind) {
            var w = (typeof Wp !== 'undefined' && Wp.list) ? Wp.list[wpIdx] : null;
            if (!w) return false;
            var nk = (kind === 'rest') ? 'rest' : 'spot';
            if ((w.kind === 'rest' ? 'rest' : 'spot') === nk) return true;
            w.kind = nk;
            wpSave(Wp.list);
            if (Wp.renderList) Wp.renderList();
            try { refreshEditTabs(); } catch (e) {}        // chips + 三类行 + 徽标
            try { if (typeof renderRestMarkers === 'function') renderRestMarkers(); } catch (e) {}   // 地图休整层
            try { etToast('已改为' + (nk === 'rest' ? '休整点' : '打卡点') + '：' + w.n); } catch (e) {}
            return true;
        };
        /* ============ S33 分享图 PNG（链式结构画布绘制） ============ */
        function buildSharePng() {
            try {
                var cv = document.createElement('canvas');
                if (!cv.getContext) { editNotice('当前环境不支持 canvas，无法生成分享图。'); return; }
                var disp = (typeof currentDisp === 'function') ? currentDisp() : [];
                var W = 750, pad = 48, y = 0;
                var rowH = 64;
                var H = 260 + disp.length * rowH + 120;
                cv.width = W; cv.height = H;
                var ctx = cv.getContext('2d');
                ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
                ctx.fillStyle = '#0f172a';
                ctx.font = '600 30px "PingFang SC", system-ui, sans-serif';
                ctx.fillText('去旷野，见山海', pad, y += 52);
                ctx.font = '600 40px "PingFang SC", system-ui, sans-serif';
                ctx.fillText((typeof BRAND !== 'undefined' && BRAND.stripEmoji ? BRAND.stripEmoji(ROUTE_META.name) : ROUTE_META.name), pad, y += 58);
                ctx.fillStyle = '#64748b';
                ctx.font = '26px "PingFang SC", system-ui, sans-serif';
                var info = (ROUTE_META.departureDate ? ROUTE_META.departureDate.slice(5).replace('-', '月') + '日出发 · ' : '') +
                    disp.length + ' 天 · ' + STARTS[0].totalKm + 'km';
                ctx.fillText(info, pad, y += 40);
                y += 30;
                ctx.fillStyle = '#0f766e';
                ctx.beginPath(); ctx.arc(pad + 8, y - 8, 8, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#0f172a'; ctx.font = '600 26px "PingFang SC", system-ui, sans-serif';
                ctx.fillText(((STARTS[0].head && STARTS[0].head.n) || STARTS[0].name), pad + 30, y);
                disp.forEach(function (dd, i) {
                    var d = dd.orig ? dd.orig : dd;
                    y += rowH;
                    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 3;
                    ctx.beginPath(); ctx.moveTo(pad + 8, y - rowH + 8); ctx.lineTo(pad + 8, y + 8); ctx.stroke();
                    ctx.fillStyle = '#334155'; ctx.font = '24px "PingFang SC", system-ui, sans-serif';
                    ctx.fillText('D' + (i + 1) + ' · ' + dd.km + 'km', pad + 30, y - 18);
                    ctx.fillStyle = '#94a3b8'; ctx.font = '22px "PingFang SC", system-ui, sans-serif';
                    ctx.fillText(String(dd.title).slice(0, 24), pad + 30, y + 10);
                    ctx.fillStyle = '#b45309'; ctx.font = '600 24px "PingFang SC", system-ui, sans-serif';
                    ctx.fillText('⛺ ' + String(dd.stay || (dd.title.split('→').pop() || '').trim()).slice(0, 16), pad + 30, y + 40);
                });
                y += rowH;
                ctx.fillStyle = '#0f766e';
                ctx.beginPath(); ctx.arc(pad + 8, y - 18, 8, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#0f172a'; ctx.font = '600 26px "PingFang SC", system-ui, sans-serif';
                var loopRt2 = !(ROUTE_META.loop === false);
                ctx.fillText(loopRt2 ? ((STARTS[0].head && STARTS[0].head.n) || STARTS[0].name) + '（环线闭合）' : '终点', pad + 30, y - 8);
                ctx.fillStyle = '#94a3b8'; ctx.font = '22px "PingFang SC", system-ui, sans-serif';
                var peak = (typeof peakAlt === 'function') ? peakAlt() : { alt: '-' };
                var maxGapTxt = '';
                try {
                    if (typeof STATION_DATA !== 'undefined' && STATION_DATA && STATION_DATA.ev && STATION_DATA.ev.length && typeof stationsAll === 'function') {
                        var stops = stationsAll('ev'), mg = 0, pv = 0;
                        stops.forEach(function (s) { mg = Math.max(mg, s.km - pv); pv = s.km; });
                        mg = Math.max(mg, (typeof curTotal === 'function' ? curTotal() : 0) - pv);
                        maxGapTxt = ' · 最长无充 ' + Math.round(mg) + 'km';
                    }
                } catch (e) {}
                ctx.fillText('xianlumap.ok.kimi.link · 最高 ' + peak.alt + 'm' + maxGapTxt, pad, H - 42);
                var a = document.createElement('a');
                a.href = cv.toDataURL('image/png');
                a.download = 'share-' + ROUTE_META.key + '.png';
                if (document.body && document.body.appendChild) { document.body.appendChild(a); a.click(); a.remove(); }
                editNotice('分享图已生成下载（链式行程结构）。');
            } catch (e) {
                editNotice('分享图生成失败：' + (e && e.message ? e.message.slice(0, 60) : '未知'));
            }
        }

        /* ============ S33 链对话框族 ============ */
        function dayByIdAny(id) {
            var hit = null;
            DAYS.forEach(function (d) { if (d.id === id) hit = d; });
            return hit;
        }
        function flyToNode(nodeEl) {
            var dayId = nodeEl.getAttribute && nodeEl.getAttribute('data-node-day');
            if (dayId == null) return;
            var d = dayByIdAny(+dayId);
            if (d && d.path && d.path.length) {
                var p = d.path[d.path.length - 1];
                try { map.setZoomAndCenter(11, [p[1], p[0]]); } catch (e) {}
            }
        }
        function closeChainDlg() {
            ['splitDlg', 'nodeMenu', 'daysDlg'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el && el.remove) el.remove();
            });
        }
        /* 中缝「＋」拆分弹层：命名（预填该天最近途经点）→ splitDay */
        function openSplitDialog(dayId) {
            closeChainDlg();
            var d = dayByIdAny(dayId);
            if (!d || !d.altKm) return;
            var a = d.altKm[0], b = d.altKm[1];
            var guess = '', gKm = null, bd = 1e9;
            Wp.list.forEach(function (w) {
                var k = routeKmOf(w.p[0], w.p[1]);
                if (k > a + 0.5 && k < b - 0.5 && Math.abs(k - (a + b) / 2) < bd) { bd = Math.abs(k - (a + b) / 2); guess = w.n; gKm = k; }
            });
            var m = document.createElement('div');
            m.id = 'splitDlg';
            m.className = 'chain-dlg';
            m.innerHTML = '<div class="cd-t">在此多住一晚（拆分）</div>' +
                '<div class="cd-sub">「' + escapeHtml(d.title) + '」将拆成两天' + (gKm != null ? '，拆分点最近途经点：' + escapeHtml(guess) : '，拆分点取中点 km' + ((a + b) / 2).toFixed(1)) + '</div>' +
                '<input type="text" id="cdName" maxlength="20" placeholder="夜宿名（如：茶卡镇）" value="' + escapeHtml(guess) + '">' +
                '<div class="cd-row"><button class="edit-mini" id="cdOk">拆分</button>' +
                '<button class="edit-mini" id="cdNo">取消</button></div>';
            if (document.body && document.body.appendChild) document.body.appendChild(m);
            var okB = document.getElementById('cdOk');
            if (okB) okB.onclick = function () {
                var nm = document.getElementById('cdName');
                var name = (nm && String(nm.value).trim()) ? String(nm.value).trim() : (guess || '中途休整');
                closeChainDlg();
                var nid = Edit.splitDay(dayId, name, gKm);
                if (nid !== false) { try { etToast('已拆分：' + name + '（多住一晚）'); } catch (e) {} }
            };
            var noB = document.getElementById('cdNo');
            if (noB) noB.onclick = closeChainDlg;
        }
        /* 节点长按菜单：飞到/改名/在此后多住一晚/删除休整点（合并后段） */
        function openNodeMenu(x, y, dayId) {
            closeChainDlg();
            var d = dayByIdAny(dayId);
            if (!d) return;
            var m = document.createElement('div');
            m.id = 'nodeMenu';
            m.className = 'pt-menu';
            m.innerHTML = '<button data-a="fly">🧭 飞到地图</button>' +
                '<button data-a="rename">✎ 改名</button>' +
                '<button data-a="split">＋ 在此后多住一晚（拆分）</button>' +
                '<button data-a="del">✕ 删除休整点（前后两段合并成一天）</button>';
            if (document.body && document.body.appendChild) document.body.appendChild(m);
            try {
                m.style.left = Math.max(8, Math.min(x, window.innerWidth - 260)) + 'px';
                m.style.top = Math.max(60, y - 10) + 'px';
            } catch (e) {}
            Array.prototype.forEach.call(m.querySelectorAll ? m.querySelectorAll('button') : [], function (b) {
                if (!b.addEventListener || !b.getAttribute) return;
                b.addEventListener('click', function () {
                    var a = b.getAttribute('data-a');
                    closeChainDlg();
                    if (a === 'fly') {
                        if (d.path && d.path.length) { var p = d.path[d.path.length - 1]; try { map.setZoomAndCenter(11, [p[1], p[0]]); } catch (e) {} }
                    } else if (a === 'rename') {
                        var v = editAsk('夜宿名（写在该天住宿上）', d.stay || '');
                        if (v !== null) Edit.setDayField(d.id, 'stay', String(v).trim());
                    } else if (a === 'split') {
                        openSplitDialog(d.id);
                    } else if (a === 'del') {
                        /* 删除节点 = 后一天并入该天（mergeDay 现成语义） */
                        var merged = Edit._mergedIds();
                        var vis = (typeof currentDisp === 'function') ? currentDisp() : DAYS;
                        var next = null;
                        for (var i = 0; i < vis.length; i++) {
                            var oi = vis[i].orig ? vis[i].orig : vis[i];
                            if (oi.id === dayId) { for (var j = i + 1; j < vis.length; j++) { var oj = vis[j].orig ? vis[j].orig : vis[j]; if (merged.indexOf(oj.id) < 0 && oj.altKm) { next = oj; break; } } break; }
                        }
                        if (!next) { editNotice('终点节点不可删除。'); return; }
                        if (Edit.mergeDay(next.id)) { try { etToast('已合并：' + next.title); } catch (e) {} }
                    }
                });
            });
            setTimeout(function () {
                try { document.addEventListener('click', function h() { closeChainDlg(); document.removeEventListener('click', h); }); } catch (e) {}
            }, 10);
        }
        /* 「10 天」chip 弹层：输入目标天数 → 均分预览 → 应用 */
        function openDaysDialog() {
            closeChainDlg();
            var disp = (typeof currentDisp === 'function') ? currentDisp() : [];
            var m = document.createElement('div');
            m.id = 'daysDlg';
            m.className = 'chain-dlg';
            m.innerHTML = '<div class="cd-t">调整天数</div>' +
                '<div class="cd-sub">当前 ' + disp.length + ' 段 · 总里程 ' + STARTS[0].totalKm + ' km</div>' +
                '<div class="cd-row"><span>天数</span><input type="number" id="cdDays" min="1" max="60" value="' + disp.length + '" style="width:70px">' +
                '<button class="edit-mini" id="cdPrev">预览</button></div>' +
                '<div class="cd-prev" id="cdPrevBox"></div>' +
                '<div class="cd-row"><button class="edit-mini" id="cdApply">应用（均分，链上/剖面可再微调）</button>' +
                '<button class="edit-mini" id="cdCancel">取消</button></div>';
            if (document.body && document.body.appendChild) document.body.appendChild(m);
            function doPreview() {
                var n = +((document.getElementById('cdDays') || {}).value || disp.length);
                var rows = Edit.previewEvenSplit(n);
                var box = document.getElementById('cdPrevBox');
                if (!box) return;
                if (!rows) { box.innerHTML = '<div class="cd-sub">总里程分不出 ' + n + ' 天（每天至少 2km）</div>'; return; }
                box.innerHTML = rows.map(function (r, i) {
                    return '<div class="cd-prevrow">D' + (i + 1) + ' ' + escapeHtml(r.from) + ' → ' + escapeHtml(r.to) + '（' + r.km + 'km）</div>';
                }).join('') + '<div class="cd-sub">共 ' + rows.length + ' 天 · 日均 ' + Math.round(STARTS[0].totalKm / rows.length) + 'km</div>';
            }
            var prevB = document.getElementById('cdPrev');
            if (prevB) prevB.onclick = doPreview;
            doPreview();
            var applyB = document.getElementById('cdApply');
            if (applyB) applyB.onclick = function () {
                var n = +((document.getElementById('cdDays') || {}).value || disp.length);
                closeChainDlg();
                if (Edit.evenSplit(n)) { try { etToast('已均分为 ' + n + ' 天（链上可再微调）'); } catch (e) {} }
            };
            var cancelB = document.getElementById('cdCancel');
            if (cancelB) cancelB.onclick = closeChainDlg;
        }

        /* 行程卡交互（捕获阶段拦截，避免触发 focusDay）：
           文字 → 就地输入框；点成员单击 → 飞行；长按/右键 → 菜单；拖芯片 → 归天 */
        var listEl = document.getElementById('dayList');
        if (listEl && listEl.addEventListener) {
            listEl.addEventListener('click', function (e) {
                var t = e.target;
                if (!t || !t.className) return;
                var li = t;
                while (li && String(li.tagName).toLowerCase() !== 'li') li = li.parentNode;
                if (!li) return;
                var idx = -1;
                Array.prototype.forEach.call(listEl.children, function (c, j) { if (c === li) idx = j; });
                var day = visibleDayAt(idx);
                if (!day) return;
                if (t.className === 'ch-seam-add') {
                    /* S33 中缝「＋」= 多住一晚：弹层命名（预填该天最近途经点）→ 拆分 */
                    e.stopPropagation();
                    openSplitDialog(+t.getAttribute('data-seam'));
                    return;
                }
                if (t.className === 'ch-node' || (t.className && t.className.indexOf('ch-node') === 0)) {
                    /* 节点点击 = 飞到该夜宿点（位置 = 前段终点） */
                    e.stopPropagation();
                    flyToNode(t);
                    return;
                }
                if (t.className === 'day-title') { e.stopPropagation(); openInlineField(li, day, 'title'); }
                else if (t.className === 'day-note') { e.stopPropagation(); openInlineField(li, day, 'note'); }
                else if (t.className === 'day-stay') { e.stopPropagation(); openInlineField(li, day, 'stay'); }
                else if (t.className === 'pt-m') { e.stopPropagation(); flyPtMember(t); }
                else if (t.className === 'et-chip add' || (t.className.indexOf('et-chip') === 0 && t.getAttribute && t.getAttribute('data-add'))) {
                    /* S33「＋添加」= 打开添加对话框（搜索/选类型） */
                    e.stopPropagation();
                    openStopDlg(null, null, '');
                }
            }, true);
            /* 右键菜单（桌面） */
            listEl.addEventListener('contextmenu', function (e) {
                var t = e.target;
                var node = t;
                while (node && !(node.className && String(node.className).indexOf('ch-node') === 0)) node = node.parentNode;
                if (node && node.getAttribute && node.getAttribute('data-node-day') != null) {
                    if (e.preventDefault) e.preventDefault();
                    e.stopPropagation();
                    openNodeMenu(e.clientX, e.clientY, +node.getAttribute('data-node-day'));
                    return;
                }
                /* S33 补：chips 也是点成员（含 data-wp 的归天芯片），右键同样出成员菜单 */
                var chip = t;
                while (chip && !(chip.className && String(chip.className).indexOf('et-chip') === 0 && chip.getAttribute && chip.getAttribute('data-wk') != null)) chip = chip.parentNode;
                if (e.preventDefault) e.preventDefault();
                e.stopPropagation();
                if (chip) { openPtMenu(e.clientX, e.clientY, chip); return; }
                if (!t || t.className !== 'pt-m') return;
                if (e.preventDefault) e.preventDefault();
                e.stopPropagation();
                openPtMenu(e.clientX, e.clientY, t);
            }, true);
            /* 触屏长按 500ms → 菜单（move/end 取消） */
            var lpMenuTimer = null, lpMenuEl = null, lpNodeDay = null;
            listEl.addEventListener('touchstart', function (e) {
                var t = e.target;
                var node = t;
                while (node && !(node.className && String(node.className).indexOf('ch-node') === 0)) node = node.parentNode;
                var tt = e.touches && e.touches[0];
                if (!tt) return;
                if (node && node.getAttribute && node.getAttribute('data-node-day') != null) {
                    lpNodeDay = +node.getAttribute('data-node-day');
                    lpMenuTimer = setTimeout(function () {
                        lpMenuTimer = null;
                        openNodeMenu(tt.clientX, tt.clientY, lpNodeDay);
                    }, 500);
                    return;
                }
                if (!t || t.className !== 'pt-m') return;
                lpMenuEl = t;
                lpMenuTimer = setTimeout(function () {
                    lpMenuTimer = null;
                    openPtMenu(tt.clientX, tt.clientY, lpMenuEl);
                }, 500);
            }, { passive: true });
            listEl.addEventListener('touchmove', function () { if (lpMenuTimer) { clearTimeout(lpMenuTimer); lpMenuTimer = null; } }, { passive: true });
            listEl.addEventListener('touchend', function () { if (lpMenuTimer) { clearTimeout(lpMenuTimer); lpMenuTimer = null; } });
            /* S32 拖芯片归天：dragstart 带 wp key → drop 到天卡 = assignWpDay（徽标点选保留为备选） */
            listEl.addEventListener('dragstart', function (e) {
                var t = e.target;
                if (!t || !t.getAttribute) return;
                var key = t.getAttribute('data-wk');
                if (key == null || !e.dataTransfer) return;
                try { e.dataTransfer.setData('text/plain', 'wp:' + key); e.dataTransfer.effectAllowed = 'move'; } catch (er) {}
            }, true);
            listEl.addEventListener('dragover', function (e) {
                if (!e.dataTransfer) return;
                try { if (e.preventDefault) e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } catch (er) {}
            });
            listEl.addEventListener('drop', function (e) {
                var key = null;
                try { var d = e.dataTransfer && e.dataTransfer.getData('text/plain'); if (d && d.indexOf('wp:') === 0) key = d.slice(3); } catch (er) {}
                if (key == null) return;
                if (e.preventDefault) e.preventDefault();
                e.stopPropagation();
                var li = e.target;
                while (li && String(li.tagName).toLowerCase() !== 'li') li = li.parentNode;
                if (!li) return;
                var idx = -1;
                Array.prototype.forEach.call(listEl.children, function (c, j) { if (c === li) idx = j; });
                var T = visibleDayAt(idx);
                if (!T) return;
                var wi = -1;
                Wp.list.forEach(function (w, j) { if (w.key === key) wi = j; });
                if (wi < 0) return;
                if (Edit.assignWpDay(wi, idx) !== false) {
                    try { etToast('已归到 D' + T.id); } catch (er) {}
                }
                if (Wp.renderList) Wp.renderList();
            }, true);
        }

        /* 剖面地名（点标注改显示名；聚焦模式可见全部，全程模式只见垭口） */
        var chart = document.getElementById('chartBox');
        if (chart && chart.addEventListener) {
            chart.addEventListener('click', function (e) {
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

    /* ---------- S19 联动渲染（S28 重构：编辑面板退役，刷新面 = 行程卡控件 + chips + 途经点列表 + 地名列表） ---------- */
    function wpChips(day, quiet) {
        if (typeof Wp === 'undefined' || !Wp || !Wp.list || !Wp.list.length || !day.altKm) return '';
        var names = [];
        Wp.list.forEach(function (w) {
            if (wpDayIdx(w) >= 0 && DAYS[wpDayIdx(w)] === day) names.push({ n: w.n, key: w.key });
        });
        if (!names.length) return quiet ? '' : '<span class="et-none">途经点：无</span>';
        var shown = names.slice(0, 5);
        var html = shown.map(function (m) {
            /* S32：芯片可拖到别天卡归天（HTML5 DnD；触屏用行内 [Dn] 徽标） */
            return '<span class="et-chip" draggable="true" data-wk="' + m.key + '" title="拖到别天卡 = 归天">' + escapeHtml(m.n) + '</span>';
        }).join('');
        if (names.length > 5) html += '<span class="et-chip more">+' + (names.length - 5) + '</span>';
        if (quiet) html += '<span class="et-chip add" data-add="1" title="添加途经点">＋ 添加</span>';   // S32 天卡行间入口
        return html;
    }
    function refreshChips() {
        /* S29：chips 与三类点分组行都按卡刷新；S33：按显示层序（currentDisp）对卡 */
        var listEl = document.getElementById('dayList');
        if (!listEl || !listEl.children) return;
        var vis = (typeof currentDisp === 'function') ? currentDisp() : DAYS.filter(function (d) { return Edit._mergedIds().indexOf(d.id) < 0; });
        var supEv = [], supFuel = [];
        if (typeof dayPtsHTML === 'function' && typeof stationsAll === 'function') {
            try {
                supEv = stationsAll('ev').filter(function (s) { return (s.d == null ? 99 : s.d) <= 35; });
                supFuel = stationsAll('fuel').filter(function (s) { return (s.d == null ? 99 : s.d) <= 35; });
            } catch (e) {}
        }
        Array.prototype.forEach.call(listEl.children, function (li, i) {
            var day = vis[i];
            if (!day) return;
            var oday = day.orig ? day.orig : day;   // 归属/wpChips 用原对象（wpDayIdx 是原口径）
            var box = li.querySelector ? li.querySelector('.et-chips') : null;
            if (box) box.innerHTML = wpChips(oday, true);
            var ptsBox = li.querySelector ? li.querySelector('.day-pts') : null;
            if (ptsBox && ptsBox.parentNode && typeof ptsBox.parentNode.replaceChild === 'function' && typeof dayPtsHTML === 'function') {
                var tmp = document.createElement('div');
                tmp.innerHTML = dayPtsHTML(day, DAYS.indexOf(oday), supEv, supFuel);
                var fresh = tmp.querySelector ? tmp.querySelector('.day-pts') : null;
                if (fresh) ptsBox.parentNode.replaceChild(fresh, ptsBox);
                else if (typeof ptsBox.remove === 'function') ptsBox.remove();
            }
        });
    }
    /* 联动刷新总入口：任何编辑操作后重绘（函数提升，可在上文各处安全调用） */
    function refreshEditTabs() {
        try { Edit.refreshDayControls(); } catch (e) {}
        try { refreshChips(); } catch (e) {}
        if (typeof Wp !== 'undefined' && Wp.renderList) Wp.renderList();
    }
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
    function wpSave(list) {   // S32：草稿语义（标脏），落盘走 Edit.commit → wpFlush
        editSave();
        refreshWpBadge();
    }
    function wpFlush() {   // 途经点草稿 → localStorage（commit/import 调用）
        try {
            if (Wp.list && Wp.list.length) localStorage.setItem(WP_KEY, JSON.stringify({ list: Wp.list }));
            else localStorage.removeItem(WP_KEY);
        } catch (e) {}
        try { if (typeof Sync !== 'undefined' && Sync.bumpLocal) Sync.bumpLocal(); } catch (e) {}
    }
    /* 初始列表 = 包内现有途经点（键与顺序保留）；overlay 存在则以 overlay 为准 */
    function wpBaseList() {
        var out = [];
        if (typeof ROUTE_BUILD !== 'undefined' && ROUTE_BUILD && ROUTE_BUILD.waypoints) {
            Object.keys(ROUTE_BUILD.waypoints).forEach(function (k) {
                var w = ROUTE_BUILD.waypoints[k];
                out.push({ key: k, n: w.n, p: [w.p[0], w.p[1]], alt: w.alt, d: w.d || '', kind: w.kind === 'rest' ? 'rest' : 'spot' });
            });
        }
        return out;
    }
    var Wp = {
        list: (wpLoad() || {}).list || wpBaseList(),
        dirty: function () {   // S32 草稿语义：任何未保存改动都算脏（wp localStorage 只在 commit 时写）
            return (typeof Edit !== 'undefined' && Edit.isDirty) ? Edit.isDirty() : !!wpLoad();
        },
        add: function (name, gcjLat, gcjLng, kind) {   // S29：kind='rest' 休整点，缺省 'spot' 打卡点
            var p = WP_INPUT_WGS ? gcj2wgsB(gcjLat, gcjLng) : [gcjLat, gcjLng];
            var key = 'wp' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
            this.list.push({ key: key, n: String(name).slice(0, 20), p: [+p[0].toFixed(6), +p[1].toFixed(6)], alt: 500, d: '', kind: (kind === 'rest' ? 'rest' : 'spot') });
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
        clear: function () {   // 草稿层清除（不再动 localStorage；落盘走 commit）
            this.list = wpBaseList();
            editSave();
            refreshWpBadge();
        },
        /* 云同步恢复用：整体替换 overlay（null = 清除回包内基准；wpSave 顺带刷徽标） */
        replaceAll: function (list) {   // 云同步恢复：已保存态读写 → 直接落盘
            this.list = (list && list.length) ? list : wpBaseList();
            wpFlush();
            refreshWpBadge();
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
                out[w.key] = { n: w.n, p: [w.p[0], w.p[1]], alt: w.alt || 500, d: w.d || '', kind: w.kind === 'rest' ? 'rest' : 'spot' };
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

    /* S29 加点类型状态：'spot'=打卡（缺省）/'rest'=休整。物化到 Wp/导出；改选后两处选择器同步亮。 */
    var wpAddKind = 'spot';
    function setAddKind(k) {
        wpAddKind = (k === 'rest') ? 'rest' : 'spot';
        [document.getElementById('wpKindSeg'), document.getElementById('wpStopKind')].forEach(function (seg) {
            if (!seg) return;
            Array.prototype.forEach.call(seg.querySelectorAll ? seg.querySelectorAll('button') : [], function (b) {
                if (b && b.classList && b.getAttribute) b.classList.toggle('on', b.getAttribute('data-wk') === wpAddKind);
            });
        });
    }

    /* ---------- 面板 UI ---------- */
    function refreshWpBadge() {
        var b = document.getElementById('btnEdit');
        var n = Wp.dirty() ? Wp.list.length : 0;
        var cnt = document.getElementById('wpCount');   // S33：折叠管理区计数
        if (cnt) cnt.textContent = String(Wp.list.length);
        try { refreshEditTabs(); } catch (e) {}   // S19：途经点增删 → 行程 chips / [Dn] 徽标联动
    }
    (function buildWaypointPanel() {
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
            /* S28 途经点行底座（原编辑面板样式随 S28 迁移）：名字保底宽度——任何情况下
               不允许被操作钮挤成单字（hover title 看全名）；桌面操作钮瘦身 36px */
            '.et-wp{display:flex;align-items:center;gap:6px;padding:2px 0;font-size:13px;}' +
            '.et-wp .t{flex:1;min-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:8px 0;}' +
            '.et-wp .grip{border:none;background:none;color:#94a3b8;font-size:15px;cursor:grab;padding:10px 6px;font-family:inherit;flex:none;}' +
            '.et-dayno{flex:none;font-size:10.5px;font-weight:700;color:#0f766e;background:#f0fdfa;border:none;border-radius:6px;padding:3px 7px;font-family:inherit;cursor:pointer;}' +
            '.et-wp button.mv{width:36px;height:36px;border:1px solid #e2e8f0;background:#fff;border-radius:8px;cursor:pointer;font-size:13px;padding:0;font-family:inherit;flex:none;}' +
            '.et-wp button.del{width:36px;height:36px;border:1px solid #fecaca;background:#fff;color:#dc2626;border-radius:8px;cursor:pointer;font-size:13px;padding:0;font-family:inherit;flex:none;}' +
            '.et-gen{display:block;width:100%;margin-top:10px;min-height:52px;border:none;background:#0f766e;color:#fff;font-size:15px;font-weight:600;border-radius:12px;cursor:pointer;font-family:inherit;box-shadow:0 4px 12px rgba(15,118,110,.3);}' +
            '.et-chip{font-size:10.5px;color:#6d28d9;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:6px;padding:1px 6px;}' +
            '.et-chip.more{color:#94a3b8;background:#f8fafc;border-color:#e2e8f0;}' +
            '.et-chips .et-none{font-size:10.5px;color:#cbd5e1;}' +
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
            /* S27「在此添加停靠」确认弹窗 */
            '#wpStop{position:fixed;left:50%;bottom:120px;transform:translateX(-50%);z-index:var(--z-guide,1400);' +
            'width:min(320px,calc(100vw - 48px));background:#fff;border:1px solid #e2e8f0;border-radius:14px;' +
            'box-shadow:0 16px 48px rgba(15,23,42,.25);padding:14px 16px;font-family:inherit;}' +
            '#wpStop .wps-t{font-size:14px;font-weight:600;color:#0f172a;margin-bottom:2px;}' +
            '#wpStop .wps-sub{font-size:10.5px;color:#94a3b8;margin-bottom:8px;}' +
            '#wpStop input{width:100%;box-sizing:border-box;min-height:42px;font-size:13.5px;border:1px solid #e2e8f0;border-radius:9px;padding:0 10px;margin-bottom:8px;font-family:inherit;}' +
            '#wpStop .wps-row{display:flex;gap:6px;}' +
            '#wpStop .wps-row .edit-mini{flex:1;min-height:42px;margin-right:0;}' +
            '@media (max-width:768px){' +
            '.et-wp-delunder{display:block;}' +
            '.et-wp .mv,.et-wp .del{display:none;}' +   /* 行上只剩 ☰ 名 [Dn] */
            '.et-wp-body{padding:2px 0;}' +
            '}';
        (document.head || document.documentElement).appendChild(css);
        /* S28：途经点 Pane 的 DOM 在 buildPanelChrome 里（#paneWp），这里只保留接线：
           renderList / 搜索 / 地图点选 / 生成弹层。 */

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
                /* S33 桌面手势统一：撤 ↑↓✕ 小钮（与移动端同构）——☰ DnD 排序 + 右键删除 + [Dn] 归天；
                   接线一律按 class 选择器（不再按 querySelectorAll 下标，display:none 的 delunder 曾把下标顶偏） */
                row.innerHTML = '<button class="et-wp-delunder">删除</button>' +
                    '<div class="et-wp-body">' +
                    '<span class="grip" title="拖动排序（桌面 HTML5 拖，触屏长按 ☰ 拖动）">☰</span>' +
                    (w.kind === 'rest' ? '<span class="et-wp-kind" title="休整点">☾</span>' : '') +
                    '<span class="t" title="' + escapeHtml(w.n) + '（悬停看全名）">' + escapeHtml(w.n) + '</span>' +
                    '<button class="et-dayno" title="点我改归属天">' + wpDayBadge(w) + '</button></div>';
                var badgeBtn = row.querySelector ? row.querySelector('.et-dayno') : null;
                if (badgeBtn && typeof badgeBtn.onclick !== 'undefined') {
                    badgeBtn.onclick = function (ev) {
                        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
                        openDayPick(i);
                    };
                }
                var bodyEl = row.querySelector ? row.querySelector('.et-wp-body') : null;
                if (bodyEl && bodyEl.addEventListener) {
                    bodyEl.addEventListener('contextmenu', function (ev) {
                        if (ev.preventDefault) ev.preventDefault();
                        if (editAsk('删除途经点「' + w.n + '」？', '确定') !== null) { Wp.remove(i); renderList(); }
                    });
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
            try { refreshChips(); } catch (e) {}   // S28：途经点变化 → 行程卡 chips 联动
        }
        renderList();
        Wp.renderList = renderList;

        /* S33：全局搜索移进「添加停靠点」对话框（bindDlgSearch 在对话框打开时接管） */

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
                        /* S33：点选 → 打开「添加停靠点」对话框（选类型/命名确认后才落点） */
                        var lnglat = e.lnglat;
                        openStopConfirm(lnglat.getLng(), lnglat.getLat(), '');
                    };
                    map.on('click', pickHandler);
                } else if (pickHandler) {
                    map.off('click', pickHandler);
                    pickHandler = null;
                }
            };
        }

        /* S27「在此添加停靠」：编辑模式长按地图任意位置（≥550ms 未移动）→ 逆地理取名 →
           轻量确认弹窗（名称可改）→ Wp.add。仍是 overlay + 待生效语义（不画进当前地图）。
           与「地图点选」互补不冲突：点选模式开着时长按不触发（单击已是点选入口）。
           长按取按压点坐标，不强制吸附路线——长按精度有限，硬吸附反而引入假数据。 */
        var lpTimer = null, lpStart = null, lpMarker = null;
        function lpCancel() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } lpStart = null; }
        function lpLngLatOf(clientX, clientY) {
            var el = document.getElementById('map');
            if (!el || typeof el.getBoundingClientRect !== 'function') return null;
            if (typeof AMap === 'undefined' || !AMap.Pixel || !map || typeof map.containerToLngLat !== 'function') return null;
            try {
                var r = el.getBoundingClientRect();
                return map.containerToLngLat(new AMap.Pixel(clientX - r.left, clientY - r.top));
            } catch (e) { return null; }
        }
        function lpDown(e) {
            /* S29：长按加停靠的「编辑上下文」= 途经点 Pane 开着（S28 起无编辑模式；
               移动端半屏态上半屏地图可见，此能力在半屏态解锁） */
            if (picking || (typeof Edit !== 'undefined' && Edit.panelTab !== 'wp')) return;
            var t = (e.touches && e.touches[0]) ? e.touches[0] : e;
            if (!t || t.clientX == null) return;
            lpStart = { x: t.clientX, y: t.clientY };
            lpTimer = setTimeout(function () {
                lpTimer = null;
                var s = lpStart; lpStart = null;
                if (!s) return;   // S29：编辑上下文=途经点 Pane（S28 起无 Edit.on 模式位；lpDown 已把门）
                var ll = lpLngLatOf(s.x, s.y);
                if (!ll) return;
                openStopConfirm(ll.getLng ? ll.getLng() : ll.lng, ll.getLat ? ll.getLat() : ll.lat);
            }, 550);
        }
        function lpMaybeCancel(e) {
            if (!lpStart) return;
            var t = (e.touches && e.touches[0]) ? e.touches[0] : e;
            if (!t || t.clientX == null) return;
            if (Math.abs(t.clientX - lpStart.x) > 10 || Math.abs(t.clientY - lpStart.y) > 10) lpCancel();
        }
        var lpMapEl = document.getElementById('map');
        if (lpMapEl && typeof lpMapEl.addEventListener === 'function') {
            lpMapEl.addEventListener('mousedown', lpDown);
            lpMapEl.addEventListener('mousemove', lpMaybeCancel);
            lpMapEl.addEventListener('mouseup', lpCancel);
            lpMapEl.addEventListener('touchstart', lpDown, { passive: true });
            lpMapEl.addEventListener('touchmove', lpMaybeCancel, { passive: true });
            lpMapEl.addEventListener('touchend', lpCancel);
            lpMapEl.addEventListener('touchcancel', lpCancel);
        }
        function closeStopConfirm() {
            var w = document.getElementById('wpStop');
            if (w && w.remove) w.remove();
            if (lpMarker && lpMarker.setMap) { try { lpMarker.setMap(null); } catch (e) {} }
            lpMarker = null;
        }
        /* S33 添加停靠点对话框：搜索（高德输入提示）+ 命名 + 类型（⚑打卡/⛺休整，默认打卡）——
           不再依赖前置开关。入口：头部「＋ 添加」、地图点选、长按地图、天卡「＋ 添加」chip。
           确认 = Wp.add + 地图落针动画 + toast「已添加：XX（打卡点/休整点）」。 */
        var dlgPick = { lat: null, lng: null };
        function bindDlgSearch(input) {
            if (!input || typeof AMap === 'undefined' || !AMap.plugin) return;
            try {
                AMap.plugin(['AMap.AutoComplete'], function () {
                    var ac = new AMap.AutoComplete({ input: input, citylimit: false });
                    ac.on('select', function (e) {
                        var poi = e.poi;
                        if (!poi || !poi.location) return;
                        dlgPick.lat = poi.location.getLat();
                        dlgPick.lng = poi.location.getLng();
                        input.value = poi.name;
                        var nm = document.getElementById('wpStopName');
                        if (nm) nm.value = String(poi.name).slice(0, 20);
                    });
                });
            } catch (e) {}
        }
        function pinDrop(lat, lng, kind) {
            try {
                if (typeof AMap === 'undefined' || !AMap.Marker || lat == null) return;
                var mk = new AMap.Marker({
                    position: new AMap.LngLat(lng, lat),
                    content: '<div class="pin-drop ' + (kind === 'rest' ? 'rest' : '') + '">' +
                        '<div class="pin-drop-ic">' + (kind === 'rest' ? '☾' : '⚑') + '</div></div>',
                    offset: new AMap.Pixel(-13, -34), zIndex: 160
                });
                if (mk.setMap) mk.setMap(map);
                try { if (map.setCenter) map.setCenter([lng, lat]); } catch (e) {}
                setTimeout(function () { try { if (mk.setMap) mk.setMap(null); } catch (e) {} }, 1600);
            } catch (e) {}
        }
        function openStopConfirm(lng, lat, presetName) {   // 高德口径 lnglat；均可空（纯搜索模式）
            closeStopConfirm();
            dlgPick = { lat: lat == null ? null : lat, lng: lng == null ? null : lng };
            var wrap = document.createElement('div');
            wrap.id = 'wpStop';
            wrap.innerHTML =
                '<div class="wps-t">添加停靠点</div>' +
                '<div class="wps-sub">' + (lng != null ? '经度 ' + lng.toFixed(4) + ' · 纬度 ' + lat.toFixed(4) : '搜索选择地点，或先关闭本框去地图点选/长按') + '</div>' +
                '<input class="wp-search" id="wpSearch" placeholder="搜索地名（高德输入提示）…" autocomplete="off">' +
                '<input type="text" id="wpStopName" maxlength="20" placeholder="名称（搜索可自动带出）">' +
                '<div class="wps-kind" id="wpStopKind">' +
                '<button data-wk="spot" class="' + (wpAddKind === 'spot' ? 'on' : '') + '">⚑ 打卡点</button>' +
                '<button data-wk="rest" class="' + (wpAddKind === 'rest' ? 'on' : '') + '">⛺ 休整点</button>' +
                '</div>' +
                '<div class="wps-row">' +
                '<button class="edit-mini" id="wpStopOk">添加</button>' +
                '<button class="edit-mini" id="wpStopNo">取消</button></div>';
            if (document.body && typeof document.body.appendChild === 'function') document.body.appendChild(wrap);
            var input = document.getElementById('wpStopName');
            var defName = lng != null ? '停靠点(' + lat.toFixed(3) + ',' + lng.toFixed(3) + ')' : '';
            if (input && (presetName || defName)) input.value = presetName || defName;
            bindDlgSearch(document.getElementById('wpSearch'));
            /* 逆地理取名（长按/点选入口；失败留默认名，可手改） */
            if (lng != null) {
                try {
                    if (typeof AMap !== 'undefined' && AMap.plugin) {
                        AMap.plugin('AMap.Geocoder', function () {
                            new AMap.Geocoder().getAddress([lng, lat], function (st, res) {
                                if (st === 'complete' && res.regeocode) {
                                    var cd = res.regeocode.addressComponent;
                                    var nm = (cd.township || cd.district || cd.street || '').toString();
                                    if (nm && input && !String(input.value || '').trim()) input.value = nm.slice(0, 20);
                                }
                            });
                        });
                    }
                } catch (err) {}
            }
            /* 按压位置的小记号（确认/取消时移除） */
            if (lng != null) {
                try {
                    if (typeof AMap !== 'undefined' && AMap.Marker && AMap.LngLat) {
                        lpMarker = new AMap.Marker({ position: new AMap.LngLat(lng, lat), content: '<div style="width:12px;height:12px;border-radius:50%;background:#0f766e;border:2px solid #fff;box-shadow:0 1px 4px rgba(15,23,42,.4)"></div>' });
                        if (lpMarker.setMap) lpMarker.setMap(map);
                    }
                } catch (e) {}
            }
            var stopKindSeg = document.getElementById('wpStopKind');
            if (stopKindSeg) {
                Array.prototype.forEach.call(stopKindSeg.querySelectorAll ? stopKindSeg.querySelectorAll('button') : [], function (b) {
                    if (!b.addEventListener || !b.getAttribute) return;
                    b.addEventListener('click', function () { setAddKind(b.getAttribute('data-wk')); });
                });
            }
            var okB = document.getElementById('wpStopOk');
            if (okB) okB.onclick = function () {
                var nm = (input && input.value && String(input.value).trim()) ? String(input.value).trim() : '';
                var alat = dlgPick.lat, alng = dlgPick.lng;
                if (alat == null || !nm) { editNotice('请先搜索选点（或地图点选/长按），并给个名称。'); return; }
                var kindTxt = wpAddKind === 'rest' ? '休整点' : '打卡点';
                Wp.add(nm, alat, alng, wpAddKind);
                if (Wp.renderList) Wp.renderList();
                closeStopConfirm();
                pinDrop(alat, alng, wpAddKind);
                try { etToast('已添加：' + nm + '（' + kindTxt + '）'); } catch (e) {}
            };
            var noB = document.getElementById('wpStopNo');
            if (noB) noB.onclick = closeStopConfirm;
        }
        try { window.__wpStop = { open: openStopConfirm, close: closeStopConfirm }; } catch (e) {}

        /* 保存我的版本：弹层 = 代码段 + 下载 + 两档重新生成触发 */
        var genBtn = document.getElementById('wpGen');
        if (genBtn) genBtn.onclick = openWpModal;
        var guideBtn = document.getElementById('wpGuideBtn');
        if (guideBtn) guideBtn.onclick = function () { Edit.showWaypointGuide(); };

        function openWpModal() {
            var old = document.getElementById('wpModal');
            if (old) old.remove();
            var json = Wp.exportJson();
            var m = document.createElement('div');
            m.id = 'wpModal';
            /* S28 去代码化：默认视图只有「自动 / 手动」两条路，按钮即全部；
               代码块与 waypoints.json 收进「高级：查看代码」折叠区（默认收起）。 */
            m.innerHTML =
                '<h3>保存我的版本 · ' + ROUTE_META.name + '</h3>' +
                '<div class="wp-note" style="color:#64748b;">把这条线的个人改动（途经点、分段、标题等）生成进线路数据。' +
                '两条路选一：<b>自动</b>最省事（填一次以后都是一键），<b>手动</b>交给维护者代跑。</div>' +
                '<div class="mrow" style="margin-top:10px;border-top:1px solid #f1f5f9;padding-top:8px;">' +
                '<b style="font-size:11.5px;color:#0f766e;">自动（推荐）</b></div>' +
                '<div class="mrow">' +
                '<input type="text" id="ghOwner" placeholder="GitHub 账号名">' +
                '<input type="text" id="ghRepo" placeholder="仓库名">' +
                '<input type="password" id="ghToken" placeholder="访问令牌 PAT">' +
                '<button class="edit-mini" id="ghGo">开始生成</button>' +
                '</div>' +
                '<div class="mrow"><span style="font-size:10.5px;color:#94a3b8;line-height:1.5;">PAT 是 GitHub 的「访问令牌」，相当于授权这个网页替你按一次重新生成按钮——只存在这台设备上，只发给 GitHub 官方。三个框填过一次后会记住。</span></div>' +
                '<div class="mrow"><b style="font-size:11.5px;color:#0f766e;">手动</b></div>' +
                '<div class="mrow"><span style="font-size:10.5px;color:#475569;">下载文件发给维护者，对方生成完成后你刷新页面即见新版。</span>' +
                '<button class="edit-mini" id="ghOpen">打开 GitHub Actions 页</button></div>' +
                '<div class="ghlog" id="ghLog"></div>' +
                '<div class="mrow" style="border-top:1px dashed #e2e8f0;padding-top:8px;">' +
                '<button class="edit-mini" id="wpAdvBtn" style="background:#f1f5f9;color:#475569;">高级：查看代码 ▾</button>' +
                '</div>' +
                '<div id="wpAdv" style="display:none;">' +
                '<div class="wp-note">给技术用户：复制下方代码段，粘贴回线路数据文件（route-defs/' + ROUTE_META.key + '.js）里同名的两段' +
                '（行程分段是自动初分，标题/备注建议人工润色），或下载 JSON 备份。</div>' +
                '<textarea id="wpJs" readonly></textarea>' +
                '<div class="mrow">' +
                '<button class="edit-mini" id="wpCopy">复制代码段</button>' +
                '<button class="edit-mini" id="wpDl">下载 waypoints.json</button>' +
                '</div>' +
                '</div>' +
                '<div class="mrow">' +
                '<button class="edit-mini" id="wpClose">关闭</button>' +
                '</div>';
            document.body.appendChild(m);
            document.getElementById('wpJs').value = Wp.exportJs();
            document.getElementById('wpClose').onclick = function () { m.remove(); };
            var advOpen = false;
            document.getElementById('wpAdvBtn').onclick = function () {
                advOpen = !advOpen;
                var adv = document.getElementById('wpAdv');
                if (adv) adv.style.display = advOpen ? '' : 'none';
                document.getElementById('wpAdvBtn').textContent = advOpen ? '高级：收起代码 ▴' : '高级：查看代码 ▾';
            };
            document.getElementById('wpCopy').onclick = function () {
                copyText(Wp.exportJs());
                editNotice('代码段已复制，粘贴回 route-defs/' + ROUTE_META.key + '.js 对应位置。');
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
                    log.textContent = '自动方式需要填 GitHub 账号名 / 仓库名 / 访问令牌（只存这台设备）。不想填就走手动方式。';
                    return;
                }
                var base = 'https://api.github.com/repos/' + owner + '/' + repo;
                log.textContent = '开始触发重新生成…';
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
                        log.textContent = '已触发 ✅ 等待生成结果…';
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
                                    log.textContent = '等待任务出现…（' + tries + '）';
                                } else {
                                    log.textContent = '任务 #' + run.run_number + '：' + run.status +
                                        (run.conclusion ? ' / ' + run.conclusion : '') +
                                        '\n' + (run.html_url || '');
                                    if (run.status === 'completed') {
                                        clearInterval(timer);
                                        log.textContent += run.conclusion === 'success'
                                            ? '\n✅ 生成成功，刷新页面即见新版。'
                                            : '\n❌ 生成失败：' + run.conclusion + '，详情见上方链接。';
                                    }
                                }
                            }).catch(function (e) { log.textContent = '查询出错：' + e.message; });
                            if (tries > 40) { clearInterval(timer); log.textContent += '\n等待超时，请打开 GitHub Actions 页查看。'; }
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

    /* S32：恢复原始数据的途经点处理已并入 Edit.reset（回到已保存 wp 态），旧包装退役 */

    /* S32：离开页面前有未保存草稿 → beforeunload 提示 */
    try {
        window.addEventListener('beforeunload', function (e) {
            if (!_draftDirty) return;
            try { e.preventDefault(); e.returnValue = '有未保存的修改，确定离开？'; } catch (er) {}
        });
    } catch (e) {}

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
