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
            this.overlay = {};
            editClearStore();
            renderAll();
            this.refreshDayControls();
            drawProfile();
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
    }
    function applyMetaDom() {
        var subEl = document.getElementById('routeSub');
        if (subEl && ROUTE_META.sub) subEl.textContent = ROUTE_META.sub;
        var nt = document.getElementById('evNotice');
        var sp = nt && nt.querySelector('span');
        if (sp && ROUTE_META.evNotice) sp.innerHTML = '⚡ <b>纯电提示：</b>' + ROUTE_META.evNotice;
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
