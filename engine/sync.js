/* ============================================================================
 * engine/sync.js — 方案云同步（S15：编辑 overlay + 途经点 overlay + 出发日期）
 *
 * 复用 S12 向导的 PAT（localStorage `xlm-gh-config`，仅存本机）。
 * 结构：一个用户一个**私有 Gist**（描述固定 SYNC_DESC 作标记），每条线路一个文件
 * route-<key>.json（多文件单 gist——比每线一 gist 稳：一次搜索定位，不 proliferate）。
 * 冲突语义：checkpoint（xianlumap.sync.<key>）记下上次同步时的快照/双方时间；
 * 本地有未同步改动且云端不是上次同步的版本 → confirm 二选一，绝不静默合并。
 * 所有人话提示集中在 errMsg()；不抛原始错误。vm mock 安全：localStorage/fetch/
 * confirm/window 全部 typeof 守卫。
 * 依赖：edit.js（Edit/Wp/editBar#id）先加载；ui.js 后加载。
 * ========================================================================== */

var Sync = (function () {
    var SYNC_DESC = '☁️ xianlumap 方案同步';
    var GH_CFG_KEY = 'xlm-gh-config';
    var ROUTE_KEY = (typeof ROUTE_META !== 'undefined' && ROUTE_META && ROUTE_META.key) || 'default';
    var META_KEY = 'xianlumap.sync.' + ROUTE_KEY;
    var WP_KEY = 'xianlumap.waypoints.' + ROUTE_KEY;

    function ls() { try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (e) {} return null; }
    function lsGet(k) { var s = ls(); if (!s) return null; try { return s.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { var s = ls(); if (!s) return; try { s.setItem(k, v); } catch (e) {} }
    function lsDel(k) { var s = ls(); if (!s) return; try { s.removeItem(k); } catch (e) {} }

    function fileName() { return 'route-' + ROUTE_KEY + '.json'; }

    /* —— PAT 配置（与 S12 向导共用同一 localStorage 键） —— */
    function config() {
        try { return JSON.parse(lsGet(GH_CFG_KEY) || '{}') || {}; } catch (e) { return {}; }
    }
    function hasToken() { return !!(config().token); }

    /* —— 本机方案状态 —— */
    function wpRaw() {
        try { return JSON.parse(lsGet(WP_KEY) || 'null'); } catch (e) { return null; }
    }
    function stateJSON() {
        return JSON.stringify({
            edit: JSON.parse(JSON.stringify((typeof Edit !== 'undefined' && Edit.overlay) || {})),
            waypoints: wpRaw()
        });
    }
    function checkpoint() {
        try { return JSON.parse(lsGet(META_KEY) || '{}') || {}; } catch (e) { return {}; }
    }
    function saveCheckpoint(cp) { lsSet(META_KEY, JSON.stringify(cp)); }
    function localDirty() {
        var cp = checkpoint();
        if (cp.snapshot == null) return stateJSON() !== JSON.stringify({ edit: {}, waypoints: null });
        return stateJSON() !== cp.snapshot;
    }
    function bumpLocal() {
        var cp = checkpoint();
        cp.localUpdatedAt = new Date().toISOString();
        saveCheckpoint(cp);
    }

    /* —— GitHub API（fetch 整体守卫；网络错误也走 resolve，错误码统一人话） —— */
    function ghApi(path, opts) {
        if (typeof fetch !== 'function') return Promise.resolve({ ok: false, status: 0, code: 'network' });
        var headers = {
            'Authorization': 'Bearer ' + config().token,
            'Accept': 'application/vnd.github+json'
        };
        if (opts && opts.body) headers['Content-Type'] = 'application/json';
        var p;
        try {
            p = fetch('https://api.github.com' + path, {
                method: (opts && opts.method) || 'GET',
                headers: headers,
                body: opts && opts.body
            });
        } catch (e) {
            return Promise.resolve({ ok: false, status: 0, code: 'network' });
        }
        return p.then(function (r) {
            var status = r.status || 0;
            return Promise.resolve().then(function () { return r.json ? r.json() : null; }).then(function (d) {
                return { ok: status >= 200 && status < 300, status: status, data: d };
            });
        }).catch(function () { return { ok: false, status: 0, code: 'network' }; });
    }

    /* 定位（或确认不存在）同步 gist：按描述标记搜索用户 gist 列表 */
    function findGist() {
        return ghApi('/gists?per_page=100').then(function (r) {
            if (!r.ok) return { ok: false, code: r.status === 401 ? 'auth' : r.status === 403 ? 'forbidden' : 'http', status: r.status };
            var list = Array.isArray(r.data) ? r.data : [];
            for (var i = 0; i < list.length; i++) {
                if (list[i] && list[i].description === SYNC_DESC) return { ok: true, id: list[i].id, files: list[i].files || {} };
            }
            return { ok: true, id: null, files: {} };
        });
    }

    function buildPayload() {
        return {
            app: 'xianlumap',
            kind: 'user-scheme',
            route: ROUTE_KEY,
            updatedAt: new Date().toISOString(),
            edit: JSON.parse(JSON.stringify((typeof Edit !== 'undefined' && Edit.overlay) || {})),
            waypoints: wpRaw() || { list: [] }
        };
    }

    /* —— 人话 —— */
    function fmtTime(iso) {
        if (!iso) return '未知时间';
        try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); }
        catch (e) { return String(iso).slice(0, 16); }
    }
    function errMsg(code, status) {
        if (code === 'auth') return 'PAT 校验失败：token 失效或权限不够（云同步只需要 Gists 读写权限）。请到 GitHub 重新生成 fine-grained token，Account permissions 只勾 Gists。';
        if (code === 'forbidden') return 'GitHub 拒绝了请求（403）：token 权限不够（需要 Gists 读写）或触发了限流，稍后再试。';
        if (code === 'http') return 'GitHub 返回异常（HTTP ' + status + '），稍后重试；持续失败就去 GitHub 看看这个 Gist 是否还在。';
        return '连不上 GitHub（网络问题），检查网络后重试。';
    }
    function log(msg) {
        var el = document.getElementById('syncLog');
        if (el) el.textContent = msg;
    }
    function failLog(code, status) {
        var m = errMsg(code, status);
        log(m);
        return { ok: false, error: code };
    }
    function syncConfirm(msg) {
        try { if (typeof window !== 'undefined' && window.confirm) return window.confirm(msg); } catch (e) {}
        try { if (typeof confirm === 'function') return confirm(msg); } catch (e) {}
        return true;   // vm/无 UI 环境默认继续（测试可注入 confirm 断言提示文案）
    }
    function noTokenMsg() {
        log('还没有配置 PAT：在下方粘贴 token 点「保存」（去 GitHub → Settings → Developer settings → Fine-grained tokens 申请，只勾 Gists 权限，30 秒）。');
        return { ok: false, error: 'notoken' };
    }

    /* —— 上传到云端（返回 Promise，便于测试 await） —— */
    function upload() {
        if (!hasToken()) return Promise.resolve(noTokenMsg());
        var payload = buildPayload();
        return findGist().then(function (g) {
            if (!g.ok) return failLog(g.code, g.status);
            var cloud = null;
            var f = g.files[fileName()];
            if (f && f.content) { try { cloud = JSON.parse(f.content); } catch (e) { cloud = null; } }
            var cp = checkpoint();
            if (cloud && cloud.updatedAt && localDirty() && cloud.updatedAt !== cp.cloudUpdatedAt) {
                var go = syncConfirm('检测到两边都有改动：\n• 本机方案最后改于 ' + fmtTime(cp.localUpdatedAt) + '\n• 云端版本改于 ' + fmtTime(cloud.updatedAt) + '\n\n「确定」= 保留本机、覆盖云端；\n「取消」= 不动，先「从云端恢复」看看云端版本再决定。');
                if (!go) { log('已取消：云端有较新版本，未覆盖。'); return { ok: false, error: 'cancelled' }; }
            }
            var sure = syncConfirm('将把「' + ((typeof ROUTE_META !== 'undefined' && ROUTE_META.name) || ROUTE_KEY) +
                '」的个人方案（编辑改动、途经点、出发日期）存入你的 GitHub 私有 Gist。\n\n仅你可见（登录 GitHub 后可随时删除该 Gist）。\n「确定」上传，「取消」算了。');
            if (!sure) { log('已取消上传。'); return { ok: false, error: 'cancelled' }; }
            var body = { description: SYNC_DESC, public: false, files: {} };
            body.files[fileName()] = { content: JSON.stringify(payload, null, 2) };
            var req = g.id
                ? ghApi('/gists/' + g.id, { method: 'PATCH', body: JSON.stringify(body) })
                : ghApi('/gists', { method: 'POST', body: JSON.stringify(body) });
            return req.then(function (r) {
                if (!r.ok) return failLog(r.status === 401 ? 'auth' : r.status === 403 ? 'forbidden' : 'http', r.status);
                var gid = g.id || (r.data && r.data.id) || null;
                saveCheckpoint({ gistId: gid, cloudUpdatedAt: payload.updatedAt, snapshot: stateJSON(), localUpdatedAt: payload.updatedAt });
                log('已上传 ✅ ' + fmtTime(payload.updatedAt) + '。换设备/清浏览器后：编辑模式 → 云同步 → 从云端恢复。');
                return { ok: true };
            });
        });
    }

    /* —— 从云端恢复（返回 Promise） —— */
    function restore() {
        if (!hasToken()) return Promise.resolve(noTokenMsg());
        return findGist().then(function (g) {
            if (!g.ok) return failLog(g.code, g.status);
            if (!g.id) { log('云端还没有任何备份。先在有方案的机器上：编辑模式 → 云同步 → 上传到云端。'); return { ok: false, error: 'nofile' }; }
            var f = g.files[fileName()];
            if (!f || !f.content) { log('云端的同步 Gist 里没有「' + fileName() + '」——这条线还没备份过。'); return { ok: false, error: 'nofile' }; }
            var data;
            try { data = JSON.parse(f.content); } catch (e) {
                log('云端文件不是有效 JSON（手动改过？）。到 GitHub Gist 里检查该文件，或删掉重新上传。');
                return { ok: false, error: 'badjson' };
            }
            if (!data || data.app !== 'xianlumap' || data.kind !== 'user-scheme' || data.route !== ROUTE_KEY) {
                log('云端文件不是本应用/本线路的方案备份（route 标记不匹配），未导入。');
                return { ok: false, error: 'badjson' };
            }
            var cp = checkpoint();
            if (localDirty()) {
                var go = syncConfirm('本机有未同步到云端的改动（最后改于 ' + fmtTime(cp.localUpdatedAt) + '），云端版本改于 ' + fmtTime(data.updatedAt) + '。\n\n「确定」= 用云端覆盖本机（本机改动被替换）；\n「取消」= 保留本机不动。');
                if (!go) { log('已取消：保留本机方案。'); return { ok: false, error: 'cancelled' }; }
            }
            if (data.edit) Edit.importOverlay(Object.assign({ route: ROUTE_KEY }, data.edit));   // 空 edit 也会清本机 overlay（镜像语义）
            if (typeof Wp !== 'undefined' && Wp.replaceAll) Wp.replaceAll(data.waypoints && Array.isArray(data.waypoints.list) ? data.waypoints.list : null);
            saveCheckpoint({ gistId: g.id, cloudUpdatedAt: data.updatedAt, snapshot: stateJSON(), localUpdatedAt: data.updatedAt });
            log('已从云端恢复 ✅（云端版本 ' + fmtTime(data.updatedAt) + '）。');
            return { ok: true };
        });
    }

    /* —— 编辑模式「云同步」区（挂在 editBar 里，非编辑态随 editBar 隐藏） —— */
    (function buildSyncUI() {
        var bar = document.getElementById('editBar');
        if (!bar || !bar.appendChild || !document.createElement) return;
        var sec = document.createElement('div');
        sec.className = 'wp-sec sync-sec';
        sec.innerHTML =
            '<div class="wp-head">☁️ 云同步 · 私有 Gist<span class="wp-badge" id="syncBadge"></span></div>' +
            '<div class="wp-note">把本机方案（编辑层 + 途经点 + 出发日期）备份到<b>你自己的 GitHub 私有 Gist</b>——仅你可见；换设备/清浏览器后一键恢复。PAT 只存本机浏览器，权限只需 Gists（最小化）。</div>' +
            '<div class="wp-row" style="align-items:center;">' +
            '<input type="password" id="syncToken" class="wp-search" style="flex:1;margin-top:0;" placeholder="GitHub PAT（fine-grained，只勾 Gists）" autocomplete="off">' +
            '<button class="edit-mini" id="syncSave">保存</button>' +
            '<button class="edit-mini" id="syncApply">去申请</button></div>' +
            '<div class="wp-note">没有 PAT？GitHub → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token：名字随意、Expiration 随意、Repository access 选 Public Repositories (read) 即可（Gist 不走仓库权限）、<b>Account permissions 只勾 Gists: Read and write</b>。30 秒搞定。</div>' +
            '<div class="wp-row">' +
            '<button class="edit-mini" id="syncUp">⬆️ 上传到云端</button>' +
            '<button class="edit-mini" id="syncDown">⬇️ 从云端恢复</button></div>' +
            '<div class="wp-note" id="syncLog" style="color:#0f766e;"></div>';
        if (bar.appendChild) bar.appendChild(sec);

        function refreshBadge() {
            var b = document.getElementById('syncBadge');
            if (!b) return;
            b.style.display = '';
            b.textContent = hasToken() ? 'PAT 已配置' : '未配置 PAT';
        }
        refreshBadge();
        var tk = document.getElementById('syncToken');
        if (tk) tk.value = config().token || '';
        var saveBtn = document.getElementById('syncSave');
        if (saveBtn) saveBtn.onclick = function () {
            var c = config();
            var v = tk ? String(tk.value || '').trim() : '';
            if (v) c.token = v; else delete c.token;
            lsSet(GH_CFG_KEY, JSON.stringify(c));
            refreshBadge();
            log(v ? 'PAT 已保存到本机（只进 localStorage，除 GitHub API 外不会发给任何人）。' : '已清除本机 PAT。');
        };
        var applyBtn = document.getElementById('syncApply');
        if (applyBtn) applyBtn.onclick = function () {
            try { if (typeof window !== 'undefined' && window.open) window.open('https://github.com/settings/personal-access-tokens/new', '_blank'); } catch (e) {}
        };
        var up = document.getElementById('syncUp');
        if (up) up.onclick = function () { upload(); };
        var down = document.getElementById('syncDown');
        if (down) down.onclick = function () { restore(); };
    })();

    return {
        SYNC_DESC: SYNC_DESC,
        fileName: fileName,
        hasToken: hasToken,
        config: config,
        checkpoint: checkpoint,
        stateJSON: stateJSON,
        localDirty: localDirty,
        bumpLocal: bumpLocal,
        buildPayload: buildPayload,
        upload: upload,
        restore: restore,
        _errMsg: errMsg,
        _fmtTime: fmtTime
    };
})();
