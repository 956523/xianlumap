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

    var Edit = {
        on: false,
        overlay: editLoad(),
        isOn: function () { return this.on; },

        /* —— 进入/退出编辑模式 —— */
        enter: function () {
            if (this.on) return;
            /* 体验修复 1：不再静默切回主出发地视角（用户感知为「坏了」）。
               文字类编辑（标题/备注/住宿/地名/副标题）在任意出发地视角都可用；
               分段编辑受接入段拼接天的 km 基准限制，仅在主出发地视角开放——
               其他视角下界面给明确提示、API 显式拒绝（见 refreshDayControls/setSeg）。 */
            this.on = true;
            document.body.classList.add('editing');
            if (editBar) editBar.style.display = '';
            this.refreshDayControls();
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
            Array.prototype.forEach.call(listEl.children, function (li, i) {
                var day = DAYS[i];
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
            EDIT_MARKS.forEach(function (mk) {
                var o = document.createElement('option');
                o.value = String(mk.km);
                o.textContent = mk.n;
                if (Math.abs(mk.km - day.altKm[which]) < 0.5) o.selected = true;
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
            var i = -1;
            DAYS.forEach(function (d, j) { if (d.id === id) i = j; });
            var listEl = document.getElementById('dayList');
            if (i < 0 || !listEl || !listEl.children[i]) return;
            var li = listEl.children[i];
            var day = DAYS[i];
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

    /* ---------- 入口按钮 + 编辑工具条（默认隐藏编辑痕迹，只有入口可见） ---------- */
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
        editBar.id = 'editBar';            // S15：sync.js 按 id 挂「云同步」区
        editBar.style.display = 'none';
        var hint = document.createElement('span');
        hint.className = 'edit-hint';
        hint.textContent = '编辑中：点标题/备注/副标题/通知条改文字，下拉框改分段（起点→终点），点剖面里的地名改显示名。改动只存本机浏览器，原始线路包不受影响。';
        var exp = document.createElement('button');
        exp.className = 'edit-mini';
        exp.textContent = '导出编辑层';
        exp.onclick = function () { Edit.exportOverlay(); };
        // 导入编辑层（S8）：file input 读文件 → 剥注释 → JSON → Edit.importOverlay 校验并应用
        var imp = document.createElement('button');
        imp.className = 'edit-mini';
        imp.textContent = '导入编辑层';
        var fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,application/json';
        fileInput.style.display = 'none';
        imp.onclick = function () { fileInput.click(); };
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
        var rst = document.createElement('button');
        rst.className = 'edit-mini';
        rst.textContent = '恢复原始数据';
        rst.onclick = function () { if (editAsk('清空本机全部改动，恢复线路原始数据？', '确定') !== null) Edit.reset(); };
        editBar.appendChild(hint);
        editBar.appendChild(exp);
        editBar.appendChild(imp);
        editBar.appendChild(fileInput);
        editBar.appendChild(rst);
        if (btn.parentNode && btn.parentNode.insertBefore) {
            btn.parentNode.insertBefore(editBar, btn.nextSibling);
        } else if (panel && panel.appendChild) {
            panel.appendChild(editBar);
        }
        btn.onclick = function () { Edit.on ? Edit.exit() : Edit.enter(); };

        /* 天列表点击（捕获阶段拦截，避免触发 focusDay） */
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
        bindEditPrompt('routeSub', function () { return ROUTE_META.sub; },
            function (v) { Edit.setMeta('sub', v); });
        bindEditPromptOnSpan('evNotice', function () { return ROUTE_META.evNotice; },
            function (v) { Edit.setMeta('evNotice', v); });

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
    function bindEditPrompt(id, getter, setter) {
        var el = document.getElementById(id);
        if (el && el.addEventListener) {
            el.addEventListener('click', function (e) {
                if (!Edit.on) return;
                var v = editAsk('线路副标题', getter());
                if (v !== null) setter(v);
            }, true);
        }
    }
    function bindEditPromptOnSpan(id, getter, setter) {
        var el = document.getElementById(id);
        if (el && el.addEventListener) {
            el.addEventListener('click', function (e) {
                if (!Edit.on) return;
                var v = editAsk('纯电提示（纯文本，页面会自动加标题与图标）', getter());
                if (v !== null) setter(v);
            }, true);
        }
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
        if (!b) return;
        var n = Wp.dirty() ? Wp.list.length : 0;
        b.textContent = n ? '✏️ 编辑模式 · ' + n + ' 途经点待构建' : '✏️ 编辑模式';
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
        (document.head || document.documentElement).appendChild(css);

        var sec = document.createElement('div');
        sec.className = 'wp-sec';
        sec.innerHTML =
            '<div class="wp-head">➕ 途经点<span class="wp-badge" id="wpBadge">待构建</span></div>' +
            '<div class="wp-note">搜索或地图点选添加，↑↓ 排序 ✕ 删除。改动只存本机（overlay），' +
            '<b>不参与当前渲染</b>——点「生成新版线路」后云端构建生效。</div>' +
            '<div id="wpList"></div>' +
            '<input class="wp-search" id="wpSearch" placeholder="搜索地名（高德输入提示）…" autocomplete="off">' +
            '<div class="wp-row">' +
            '<button class="edit-mini" id="wpPick">📍 地图点选</button>' +
            '<button class="edit-mini" id="wpGen">生成新版线路</button>' +
            '</div>';
        // 出发日期行（排期 S13）：融进编辑条顶部
        var depSec = document.createElement('div');
        depSec.className = 'wp-sec dep-sec';
        depSec.innerHTML =
            '<div class="wp-head">📅 出发日期</div>' +
            '<div class="wp-note">选了之后每天卡自动带真实日期+星期（休整日顺延），' +
            '存在本机随导出分享，构建不需要重跑。</div>' +
            '<div class="wp-row" style="align-items:center;">' +
            '<input type="date" id="depDate" class="wp-search" style="flex:1;margin-top:0;">' +
            '<button class="edit-mini" id="depClear">清除</button></div>';
        editBar.appendChild(sec);   // 先挂 wp 段，再插日期行（insertBefore 要求参照节点已是子节点）
        if (editBar.insertBefore) editBar.insertBefore(depSec, sec);
        else editBar.appendChild(depSec);
        refreshWpBadge();
        var depInput = document.getElementById('depDate');
        if (depInput) {
            depInput.value = (typeof ROUTE_META !== 'undefined' && ROUTE_META.departureDate) || '';
            depInput.onchange = function () { Edit.setDeparture(depInput.value || null); };
        }
        var depClearBtn = document.getElementById('depClear');
        if (depClearBtn) depClearBtn.onclick = function () { Edit.setDeparture(null); };

        function renderList() {
            var el = document.getElementById('wpList');
            if (!el) return;
            el.innerHTML = '';
            Wp.list.forEach(function (w, i) {
                var row = document.createElement('div');
                row.className = 'wp-item';
                row.innerHTML = '<span class="t">' + (i + 1) + '. ' + escapeHtml(w.n) + '</span>' +
                    '<button title="上移">↑</button><button title="下移">↓</button><button title="删除">✕</button>';
                var bs = row.querySelectorAll('button');
                if (!bs.length) { el.appendChild(row); return; }   // mock DOM 无 querySelectorAll 结果
                bs[0].onclick = function () { Wp.move(i, -1); renderList(); };
                bs[1].onclick = function () { Wp.move(i, 1); renderList(); };
                bs[2].onclick = function () {
                    if (editAsk('删除途经点「' + w.n + '」？', '确定') !== null) { Wp.remove(i); renderList(); }
                };
                el.appendChild(row);
            });
            var badge = document.getElementById('wpBadge');
            if (badge) badge.style.display = Wp.dirty() ? '' : 'none';
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
