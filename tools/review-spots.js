/* ============================================================================
 * review-spots.js — 景点审核台逻辑（S12 半自动流水线第 2 环：人工审核）
 * 候选来自 capture-spots.js（autoCaptured:true, reviewed:false）；
 * 手打 81 条（autoCaptured 缺省 false）是历史审核成果，灰显只读。
 * 审核状态存 localStorage，「导出审核结果」生成最终 spots.json 下载——
 * 浏览器写不了仓库，导出的文件交给维护者提交（诚实边界）。
 * ?autotest=1：程序化完成前 3 条操作并把统计写进 #autotest-result（冒烟用）。
 * ========================================================================== */
(function () {
    var LS_KEY = 'xlm-spots-review-v1';
    var KIND_LABEL = { spot: '风景', viewpoint: '观景台', pass: '垭口', memorial: '纪念馆', temple: '寺观' };
    var spots = [];
    var byId = {};
    var state = {};
    var curTab = '全部';
    var map = null;
    var markers = [];

    try { state = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { state = {}; }
    function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {} }

    function routeIds() {
        var set = {};
        spots.forEach(function (s) { (s.routes || []).forEach(function (r) { set[r] = 1; }); });
        return Object.keys(set);
    }
    function actionable(s) { return s.autoCaptured && !reviewedOf(s); }
    function reviewedOf(s) {
        if (state[s.id]) return state[s.id];
        if (s.reviewed) return { approved: s.approved !== false, name: s.name };
        return null;
    }

    /* ---------- 地图 ---------- */
    function initMap() {
        if (typeof AMap === 'undefined') return;
        map = new AMap.Map('map', { zoom: 5, center: [104, 34], viewMode: '2D' });
    }
    function pinColor(s) {
        var r = reviewedOf(s);
        if (!s.autoCaptured) return '#1e3a5f';
        if (!r) return '#94a3b8';
        return r.approved ? '#16a34a' : '#dc2626';
    }
    function renderMap() {
        if (!map) return;
        markers.forEach(function (m) { m.setMap(null); });
        markers = [];
        var list = filtered();
        list.forEach(function (s) {
            var m = new AMap.Marker({
                position: [s.srcCoord ? s.srcCoord.lng : s.lng, s.srcCoord ? s.srcCoord.lat : s.lat],
                icon: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
                    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7" fill="' + pinColor(s) + '" stroke="#fff" stroke-width="2"/></svg>'),
                offset: new AMap.Pixel(-9, -9), zIndex: 100
            });
            m.__sid = s.id;
            m.setMap(map);
            markers.push(m);
        });
    }
    function flyTo(s) {
        if (!map) return;
        var p = s.srcCoord || s;
        map.setZoomAndCenter(12, [p.lng, p.lat]);
    }

    /* ---------- 列表 ---------- */
    function filtered() {
        return spots.filter(function (s) {
            if (curTab !== '全部' && (s.routes || []).indexOf(curTab) < 0) return false;
            return true;
        });
    }
    function render() {
        var list = filtered();
        var el = document.getElementById('list');
        el.innerHTML = '';
        list.forEach(function (s) {
            var r = reviewedOf(s);
            var div = document.createElement('div');
            div.className = 'item' + (s.autoCaptured ? '' : ' manual');
            var name = (r && r.name) || s.name;
            var meta = (KIND_LABEL[s.kind] || s.kind || '景点') +
                (s.d != null ? ' · 距主线 ' + s.d + 'km' : '') +
                (s.desc ? ' · ' + String(s.desc).slice(0, 26) : '');
            var statusTag = !s.autoCaptured ? '<span class="tag st-his">历史</span>'
                : r ? (r.approved ? '<span class="tag st-ok">已通过</span>' : '<span class="tag st-no">已拒绝</span>') : '';
            div.innerHTML = '<div class="grow"><div class="nm">' + escapeHtml(name) + ' ' + statusTag + '</div>' +
                '<div class="meta">' + escapeHtml(meta) + '</div></div>';
            if (s.autoCaptured) {
                var acts = document.createElement('div');
                acts.className = 'acts';
                acts.innerHTML = '<button class="ok" title="通过：入正式库">✓</button>' +
                    '<button class="no" title="拒绝：不收录（可填原因）">✗</button>' +
                    '<button class="ren" title="改名">✎</button>';
                acts.children[0].onclick = function (e) { e.stopPropagation(); decide(s, true); };
                acts.children[1].onclick = function (e) { e.stopPropagation(); decide(s, false); };
                acts.children[2].onclick = function (e) { e.stopPropagation(); rename(s); };
                div.appendChild(acts);
            }
            div.onclick = function () {
                Array.prototype.forEach.call(el.children, function (c) { c.classList.remove('sel'); });
                div.classList.add('sel');
                flyTo(s);
            };
            el.appendChild(div);
        });
        renderProgress();
        renderMap();
    }
    function decide(s, approved) {
        var rec = { approved: approved, name: (state[s.id] && state[s.id].name) || s.name };
        if (!approved) {
            var reason = prompt('拒绝原因（可留空，默认「不值得收录」）', (state[s.id] && state[s.id].reason) || '');
            rec.reason = reason || '不值得收录';
        }
        state[s.id] = rec;
        save();
        render();
    }
    function rename(s) {
        var name = prompt('新名称', (state[s.id] && state[s.id].name) || s.name);
        if (name === null) return;
        var rec = state[s.id] || { approved: null, name: s.name };
        rec.name = name.trim() || s.name;
        state[s.id] = rec;
        save();
        render();
    }
    function renderProgress() {
        var cands = spots.filter(actionable);
        var decided = cands.filter(function (s) { return !!state[s.id]; }).length;
        var pct = cands.length ? Math.round(decided / cands.length * 100) : 100;
        document.getElementById('progress').innerHTML =
            '候选 ' + decided + '/' + cands.length + ' 已审（' + pct + '%）' +
            '<div class="bar"><i style="width:' + pct + '%"></i></div>';
        var ok = Object.keys(state).filter(function (id) { return state[id].approved; }).length;
        var no = Object.keys(state).filter(function (id) { return state[id] && state[id].approved === false; }).length;
        document.getElementById('footStat').textContent = '通过 ' + ok + ' · 拒绝 ' + no + '（未导出前都存在本机）';
    }
    function escapeHtml(t) {
        return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    /* ---------- 导出：审核状态合入 spots.json 并下载 ---------- */
    function exportJson() {
        var out = spots.map(function (s) {
            var o = {};
            Object.keys(s).forEach(function (k) { o[k] = s[k]; });
            var st = state[s.id];
            if (s.autoCaptured) {
                if (st) {
                    o.reviewed = true;
                    o.approved = st.approved === false ? false : true;
                    o.name = st.name || o.name;
                    if (st.reason) o.rejectReason = st.reason;
                    o.reviewedAt = new Date().toISOString().slice(0, 10);
                }
            }
            return o;
        });
        return { version: 1, updatedAt: new Date().toISOString().slice(0, 10), spots: out };
    }
    function doExport() {
        var json = exportJson();
        var blob = new Blob([JSON.stringify(json, null, 1)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'spots.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        var ok = json.spots.filter(function (s) { return s.autoCaptured && s.reviewed && s.approved; }).length;
        alert('已导出 spots.json：候选通过 ' + ok + ' 条。\n把文件交给维护者覆盖 data/db/spots.json 并跑 tools/apply-spots.js 回灌线路包。');
    }

    /* ---------- 启动 ---------- */
    function boot() {
        fetch('../data/db/spots.json').then(function (r) { return r.json(); }).then(function (db) {
            spots = db.spots || [];
            spots.forEach(function (s) { byId[s.id] = s; });
            initMap();
            var tabs = ['全部'].concat(routeIds());
            var tabsEl = document.getElementById('tabs');
            tabs.forEach(function (t) {
                var b = document.createElement('button');
                b.textContent = t;
                if (t === curTab) b.className = 'on';
                b.onclick = function () {
                    curTab = t;
                    Array.prototype.forEach.call(tabsEl.children, function (c) { c.className = ''; });
                    b.className = 'on';
                    render();
                };
                tabsEl.appendChild(b);
            });
            document.getElementById('btnExport').onclick = doExport;
            render();
            autotest();
        }).catch(function (e) {
            document.getElementById('progress').textContent = '加载 spots.json 失败：' + e.message + '（需从仓库根起 http 服务打开）';
        });
    }

    /* ?autotest=1：程序化完成 3 种操作 + 生成导出统计，写入 #autotest-result 供 headless 验证 */
    function autotest() {
        if (!/[?&]autotest=1/.test(location.search)) return;
        var cands = spots.filter(actionable).slice(0, 3);
        if (cands[0]) state[cands[0].id] = { approved: true, name: cands[0].name };
        if (cands[1]) state[cands[1].id] = { approved: null, name: '冒烟改名测试' };
        if (cands[2]) state[cands[2].id] = { approved: false, reason: '冒烟拒绝测试' };
        save(); render();
        var json = exportJson();
        var stats = {
            total: json.spots.length,
            actionable: spots.filter(actionable).length,
            approved: json.spots.filter(function (s) { return s.autoCaptured && s.reviewed && s.approved; }).length,
            renamed: json.spots.filter(function (s) { return s.autoCaptured && s.reviewed && s.name === '冒烟改名测试'; }).length
        };
        document.getElementById('autotest-result').textContent = 'AUTOTEST ' + JSON.stringify(stats);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
