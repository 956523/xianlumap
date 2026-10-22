/* ============================================================================
 * engine/enroute.js — 行中模式（S30：轻量行中 + 离线可用；S36 屏二重构）
 *
 * 定位（设计稿〇）：不是导航，是「行进中的进度伴侣」——我在哪一段链上、
 * 离今晚住哪还有多远、顺路有什么打卡点。不做路况/语音/重算。
 * 边界：浏览器定位只在本机投影到链（_dayKmTable 最近点），不上传任何服务器；
 * 打卡进度存 Edit.overlay.progress（S32 草稿/保存/云同步体系）；三键上报（可用/
 * 需注意/不可用）仅落本机，云端服务立项后接。
 *
 * 卡面态（S36 屏二/演示稿 5-7 幕）：待出发（当前程无 startTs，巨号剩余 km +
 * 「出发 · 开始第 N 程」大药钮）/ 进行中（计时从 legs.startTs 起算）/ 到达打卡
 * （不改卡——弹浮动 #enrToast，单键「打卡 ✓」= 事实确认；支线打卡点三键流程不动）/
 * 今日完成（对账 + 分享；打卡后卡自然推进下一程待出发）。支线打卡点 200m 路过自动点亮。
 * 复用：S33 链（currentDisp/origOf/镜像自动随行）、S29 归属表、S0 dayLines 三态描边。
 *
 * 加载：edit.js 之后（读 Edit overlay 草稿）；ui.js 之前无所谓（不参与首屏渲染）。
 * vm 安全：无 navigator/geolocation 时全部守卫，probe 走 Enroute.setPosition 接缝。
 * ========================================================================== */

(function () {
    var Enroute = {
        on: false,
        curKm: null,          // 投影后的链上 km（显示层口径）
        rawPos: null,         // {lat, lng} 原始定位（偏离判定用）
        anchorMode: false,
        _watchId: null,
        _segEnterAt: null,    // 进入当前段的最早定位时刻（用时估算）
        _lastProjectKm: null,
        _devOff: false,
        isOn: function () { return this.on; },

        /* ---------- 打卡数据（overlay.progress，草稿语义） ---------- */
        progress: function () {
            var ov = (typeof Edit !== 'undefined' && Edit.overlay) || {};
            ov.progress = ov.progress || {};
            ov.progress.checks = ov.progress.checks || {};
            ov.progress.daysDone = ov.progress.daysDone || {};
            ov.progress.legs = ov.progress.legs || {};   // S36 屏二：每程出发时刻 {dayId:{startTs}}
            return ov.progress;
        },
        checked: function (key) { return !!this.progress().checks[key]; },
        dayDone: function (dayId) { return !!this.progress().daysDone[dayId]; },
        legStarted: function (dayId) {
            var leg = (this.progress().legs || {})[dayId];
            return !!(leg && leg.startTs);
        },
        /* 出发：当前程写入 startTs（计时 + 到达提醒待命），卡切进行中态 */
        legStart: function () {
            var segIdx = this._segIdx();
            var dd = this._disp()[segIdx];
            if (!dd) return false;
            var oday = origOf(dd);
            var p = this.progress();
            p.legs[oday.id] = { startTs: Date.now() };
            this._segEnterAt = Date.now();
            try { editSave(); } catch (e) {}
            try { this._persistProgress(); } catch (e) {}
            renderCard();
            return true;
        },

        /* ---------- 模式进出 ---------- */
        enter: function () {
            if (this.on) return;
            this.on = true;
            if (document.body && document.body.classList) document.body.classList.add('enroute');
            buildCard();
            this._applySegStyles();
            this._renderMarks();
            this._bindGeo();
            renderCard();
        },
        exit: function () {
            this.on = false;
            if (document.body && document.body.classList) document.body.classList.remove('enroute');
            this._hideToast();
            this._stopClock();
            if (this._watchId != null && typeof navigator !== 'undefined' && navigator.geolocation) {
                try { navigator.geolocation.clearWatch(this._watchId); } catch (e) {}
            }
            this._watchId = null;
            this.anchorMode = false;
            if (this._nativeGeo) {
                try {
                    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.xlm) {
                        window.webkit.messageHandlers.xlm.postMessage({ action: 'geo', on: false });
                    }
                } catch (e) {}
                this._nativeGeo = false;
            }
            var c = document.getElementById('enrCard');
            if (c && c.remove) c.remove();
            this._restoreSegStyles();
            this._clearMarks();
            var m = document.getElementById('enrMarks');
            if (m && m.remove) m.remove();
            /* S30.5：退出即整卡重建——行中打卡的完成态（天卡 ✓/节点/段绿）立即返场规划视图 */
            try { if (typeof renderAll === 'function') renderAll(); } catch (e) {}
        },

        /* ---------- 定位投影 ---------- */
        _bindGeo: function () {
            var self = this;
            /* S36 iOS 壳定位桥：原生 CLLocationManager → window.__xlmGeo。
               dev 站是 http://局域网IP（非安全上下文），navigator.geolocation 被 WKWebView
               拒绝——这是行中定位不可用的根因；壳注入 window.__xlmNative 标记后走原生桥。 */
            try {
                if (typeof window !== 'undefined' && window.__xlmNative === true &&
                    window.webkit && window.webkit.messageHandlers &&
                    window.webkit.messageHandlers.xlm &&
                    typeof window.webkit.messageHandlers.xlm.postMessage === 'function') {
                    window.__xlmGeo = function (lat, lng) {
                        try { self.setPosition(lat, lng); } catch (e) {}
                    };
                    window.webkit.messageHandlers.xlm.postMessage({ action: 'geo', on: true });
                    this._nativeGeo = true;
                    return;
                }
            } catch (e) {}
            if (typeof navigator === 'undefined' || !navigator.geolocation || !navigator.geolocation.watchPosition) return;
            try {
                /* 省电口径（设计稿二）：显著位移才唤醒——大 maximumAge + 不追高精度 */
                this._watchId = navigator.geolocation.watchPosition(function (pos) {
                    try { self.setPosition(pos.coords.latitude, pos.coords.longitude); } catch (e) {}
                }, function () { /* 拒定位：留手动锚点 */ }, {
                    enableHighAccuracy: false, maximumAge: 120000, timeout: 20000
                });
            } catch (e) {}
        },
        /* 定位 → 链上最近点（S29 _dayKmTable）→ curKm；偏离 = 原始点距投影点 >5km */
        setPosition: function (lat, lng) {
            if (!this.on) this.enter();
            this.rawPos = { lat: lat, lng: lng };
            var km = kmOfPoint(lat, lng);
            this.curKm = km;
            /* 显著位移才重绘（省电同源口径） */
            if (this._lastProjectKm == null || Math.abs(km - this._lastProjectKm) > 0.1) {
                this._lastProjectKm = km;
                this._afterMove();
            }
            return km;
        },
        /* 手动锚点「我现在在 X」：无定位时的进度口径（点地图取投影 / 直接给 km） */
        setAnchorKm: function (km) {
            if (!this.on) this.enter();
            this.curKm = +km;
            this.rawPos = null;   // 锚点不做偏离判定
            this._lastProjectKm = this.curKm;
            this._afterMove();
            return this.curKm;
        },
        anchorFromMap: function () {
            this.anchorMode = true;
            try { etToast('锚点模式：点一下地图，进度定到那里'); } catch (e) {}
        },

        /* ---------- 链上推导 ---------- */
        _disp: function () { return (typeof currentDisp === 'function') ? currentDisp() : []; },
        _segIdx: function () {
            var disp = this._disp();
            for (var i = 0; i < disp.length; i++) {
                var a = disp[i].altKm;
                if (a && this.curKm >= a[0] - 0.5 && this.curKm <= a[1] + 0.5) return i;
            }
            return this.curKm == null ? -1 : (this.curKm <= 0 ? 0 : disp.length - 1);
        },
        /* 当前段内未打卡的打卡点（显示层归属） */
        _segSpots: function (segIdx) {
            var disp = this._disp();
            var dd = disp[segIdx];
            if (!dd) return [];
            var oday = origOf(dd);
            var out = [];
            if (typeof SPOTS !== 'undefined' && SPOTS) {
                SPOTS.forEach(function (s, si) {
                    var k = kmOfPoint(s.p[0], s.p[1]);          // 沿线 km
                    var di = dayIdxOfKm(k);                      // 归属天（索引）
                    var hit = null;
                    disp.forEach(function (d2) { var o2 = origOf(d2); if (o2.altKm && k >= o2.altKm[0] - 0.5 && k <= o2.altKm[1] + 0.5) hit = o2; });
                    if (hit && hit.id === oday.id) out.push({ s: s, si: si, km: k });
                });
            }
            /* 途经点（打卡类）也进支线 */
            if (typeof Wp !== 'undefined' && Wp.list) {
                Wp.list.forEach(function (w, wi) {
                    if (w.kind === 'rest') return;
                    var k = routeKmOf(w.p[0], w.p[1]);
                    var hit = null;
                    disp.forEach(function (d2) { var o2 = origOf(d2); if (o2.altKm && k >= o2.altKm[0] - 0.5 && k <= o2.altKm[1] + 0.5) hit = o2; });
                    if (hit && hit.id === oday.id) out.push({ wp: w, wi: wi, km: k });
                });
            }
            return out.sort(function (a, b) { return a.km - b.km; });
        },

        /* ---------- 移动后的状态推进 ---------- */
        _afterMove: function () {
            if (this.curKm == null) { renderCard(); return; }
            var disp = this._disp();
            var segIdx = this._segIdx();
            var dd = disp[segIdx];
            if (!dd) { renderCard(); return; }
            var oday = origOf(dd);
            var a = dd.altKm;
            /* 段内打卡：200m 路过自动点亮（不强求） */
            var self = this;
            this._segSpots(segIdx).forEach(function (it) {
                var key = it.si != null ? 's' + it.si : 'w' + it.wi;
                if (self.checked(key)) return;
                var p = it.s ? it.s.p : it.wp.p;
                var d = distKm(p[0], p[1], self.rawPos ? self.rawPos.lat : null, self.rawPos ? self.rawPos.lng : null);
                if (self.rawPos && d <= 0.2) self._doCheck(key, it, 1);
            });
            /* 主任务：到段终点 500m 内 → 到达打卡（S36：卡不改态，弹浮动 toast） */
            var remain = a ? (a[1] - this.curKm) : 0;
            if (!this.dayDone(oday.id) && remain <= 0.5) {
                if (this._state !== 'arrive') this._showArriveToast(dd, segIdx);
                this._state = 'arrive';
            } else if (this.dayDone(oday.id)) {
                if (this._state === 'arrive') this._hideToast();
                this._state = 'done';
            } else {
                if (this._state === 'arrive') this._hideToast();
                this._state = 'move';
                /* 支线提醒：前方 15km 内最近的未打卡点 */
                this._nextSpot = null;
                this._segSpots(segIdx).forEach(function (it) {
                    if (self.checked(it.si != null ? 's' + it.si : 'w' + it.wi)) return;
                    var ahead = it.km - self.curKm;
                    if (ahead > 0 && ahead <= 15 && (!self._nextSpot || ahead < self._nextSpot.ahead)) self._nextSpot = { it: it, ahead: ahead };
                });
                if (this._nextSpot) this._state = 'side';
            }
            /* 偏离提醒（可选关）：原始定位距链 >5km */
            if (this.rawPos && !this._devOff) {
                var proj = this._chainLatLng(this.curKm);
                if (proj && distKm(proj[0], proj[1], this.rawPos.lat, this.rawPos.lng) > 5) {
                    this._devOff = true;
                    try { etToast('已偏离主路线 ' + Math.round(distKm(proj[0], proj[1], this.rawPos.lat, this.rawPos.lng)) + 'km——不改路，仅告知'); } catch (e) {}
                }
            }
            /* 进入新段：记时 */
            if (this._state !== 'done' && this._segEnterAt == null) this._segEnterAt = Date.now();
            this._applySegStyles(segIdx);
            this._renderMarks(segIdx);
            renderCard();
        },
        _chainLatLng: function (km) {
            /* 由 _dayKmTable 反查近似坐标 */
            var best = null, bd = 1e18;
            try {
                _dayKmTable.forEach(function (t) { var d = Math.abs(t[0] - km); if (d < bd) { bd = d; best = [t[1], t[2]]; } });
            } catch (e) {}
            return best;
        },

        /* ---------- 打卡动作 ---------- */
        _doCheck: function (key, it, auto) {
            var p = this.progress();
            p.checks[key] = { t: new Date().toISOString(), auto: !!auto, ok: 1 };
            try { editSave(); } catch (e) {}
            try { this._persistProgress(); } catch (e) {}
            this._renderMarks();
            renderCard();
        },
        /* 到达打卡：确认后节点点亮 + 当天完成（S36 toast 单键 = 事实确认 report=1；
           支线打卡点的三键 _doCheck 流程不动） */
        checkIn: function (report) {
            var segIdx = this._segIdx();
            var dd = this._disp()[segIdx];
            if (!dd) return false;
            var oday = origOf(dd);
            var p = this.progress();
            /* 用时：优先 legs.startTs（S36 出发计时），退回段进入时刻（旧数据兼容） */
            var leg = (p.legs || {})[oday.id] || {};
            var durMin = null;
            if (leg.startTs) durMin = Math.max(1, Math.round((Date.now() - leg.startTs) / 60000));
            else if (this._segEnterAt) durMin = Math.max(1, Math.round((Date.now() - this._segEnterAt) / 60000));
            p.daysDone[oday.id] = {
                t: new Date().toISOString(),
                durMin: durMin,
                report: report || null   // 三键上报：1 可用 / 0 需注意 / -1 不可用（云端服务后接）
            };
            try { editSave(); } catch (e) {}
            try { this._persistProgress(); } catch (e) {}   // 行中打卡即时落盘（旅程数据丢不起；其余编辑仍纯草稿）
            this._segEnterAt = null;
            this._hideToast();
            this._state = 'done';
            this._justChecked = true;   // S36：本次渲染推进下一程（一次性；回看已完成程仍出完成态对账）
            this._applySegStyles(segIdx);
            this._renderMarks(segIdx);
            renderCard();
            return true;
        },
        /* ---------- 到达打卡 toast（S36 屏二：浮动卡，不替进度卡；30s 未操作自动隐藏） ---------- */
        _showArriveToast: function (dd, segIdx) {
            var t = toastEl();
            if (!t) return;
            var oday = origOf(dd);
            var nm = (oday.stay || (String(dd.title).split('→').pop() || '').trim() || ('第' + (segIdx + 1) + '程休整点'));
            var leg = (this.progress().legs || {})[oday.id] || {};
            var durTxt = '—';
            if (leg.startTs) {
                var min = Math.max(1, Math.round((Date.now() - leg.startTs) / 60000));
                durTxt = Math.floor(min / 60) + 'h' + (min % 60) + 'm';
            }
            t.innerHTML = '<span class="tk"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5 10 18 19.5 7"/></svg></span>' +
                '<div class="ttx"><div class="tt">到达『' + escapeHtml2e(nm) + '』休整点</div>' +
                '<div class="tm">第' + (segIdx + 1) + '程完成 · ' + (dd.km || 0) + 'km · 用时 ' + durTxt + '</div></div>' +
                '<span class="go" id="enrGo">打卡 ✓</span>';
            var g = document.getElementById('enrGo');
            if (g) g.onclick = function () { Enroute.checkIn(1); };
            if (t.classList) t.classList.add('show');
            var self = this;
            if (this._toastTimer != null && typeof clearTimeout === 'function') { try { clearTimeout(this._toastTimer); } catch (e) {} }
            /* 真机 30s 自动隐藏；vm/mock 的同步 setTimeout 会立即执行，仅影响 class，断言走内容 */
            this._toastTimer = setTimeout(function () { self._hideToast(); }, 30000);
        },
        _hideToast: function () {
            if (this._toastTimer != null && typeof clearTimeout === 'function') { try { clearTimeout(this._toastTimer); } catch (e) {} }
            this._toastTimer = null;
            var t = _toastEl;
            if (!t && typeof document !== 'undefined') t = document.getElementById('enrToast');
            if (t && t.classList) t.classList.remove('show');
        },
        /* 打卡即时持久化：progress 合并进已存储 overlay + saved 快照（云同步随即覆盖到）；
           不动 overlay 里其他草稿字段——「保存修改」的职责不越界。 */
        _persistProgress: function () {
            var s = null;
            try { s = editStore ? editStore() : null; } catch (e) {}
            if (!s) return;
            var stored = {};
            try { stored = JSON.parse(s.getItem(EDIT_KEY) || '{}') || {}; } catch (e) {}
            stored.progress = JSON.parse(JSON.stringify(this.progress()));
            s.setItem(EDIT_KEY, JSON.stringify(stored));
            if (typeof Edit !== 'undefined') {
                Edit.saved = Edit.saved || {};
                Edit.saved.progress = JSON.parse(JSON.stringify(this.progress()));
            }
        },
        toggleDev: function () {
            this._devOff = !this._devOff;
            renderCard();
            return !this._devOff;
        },

        /* ---------- 链段三态描边（S0 dayLines 整层 setStyles） ---------- */
        _applySegStyles: function (curIdx) {
            if (typeof dayLines === 'undefined') return;
            var disp = this._disp();
            var self = this;
            dayLines.forEach(function (pl, i) {
                if (!pl) return;
                var od = DAYS[i];   // renderAll 按 DAYS 顺序 push，下标平行
                if (!od) return;
                var done = self.dayDone(od.id);
                var isCur = (curIdx != null && disp[curIdx] && origOf(disp[curIdx]).id === od.id);
                var st = done ? { color: '#0d9488', width: 5, borderWidth: 1, borderColor: '#ffffff', lineCap: 'round', arrowOptions: { width: 8 } }
                    : isCur ? { color: '#14b8a6', width: 2.5, borderWidth: 1, borderColor: '#ffffff', lineCap: 'round', arrowOptions: { width: 8 } }
                        : { color: '#99f6e4', width: 2, borderWidth: 0, lineCap: 'round' };
                try { pl.setStyles({ default: st }); } catch (e) {}
            });
        },
        _restoreSegStyles: function () {
            if (typeof dayLines === 'undefined') return;
            var prog = (typeof Edit !== 'undefined' && Edit.overlay && Edit.overlay.progress) || null;
            dayLines.forEach(function (pl, i) {
                if (!pl) return;
                try { pl.setStyles({ default: NORMAL }); } catch (e) {}
                /* S30.5：规划视图的完成态绿描边返场（行中退出不带走进度视觉） */
                if (prog && prog.daysDone && DAYS[i] && prog.daysDone[DAYS[i].id]) {
                    try { pl.setStyles({ default: { color: '#0d9488', width: 5, borderWidth: 1, borderColor: '#ffffff', lineCap: 'round', arrowOptions: { width: 8 } } }); } catch (e) {}
                }
            });
        },

        /* ---------- 节点/旗标标记（空心 → 实心 + ✓） ---------- */
        _marks: null, _markData: [],
        _renderMarks: function (curIdx) {
            this._clearMarks();
            if (!this.on || typeof createMarkerLayer !== 'function') return;
            var disp = this._disp();
            var self = this;
            this._markData = [];
            /* 节点：⛺ 帐篷（该段终点）。已打卡=绿实心+✓，当前段终点=琥珀实心，其余=空心 */
            disp.forEach(function (dd, i) {
                var od = origOf(dd);
                if (!dd.altKm || !dd.path || !dd.path.length) return;
                var p = dd.path[dd.path.length - 1];
                var done = self.dayDone(od.id);
                var isNext = (curIdx != null && i === curIdx + 1) || (curIdx != null && i === curIdx);
                self._markData.push({
                    lat: p[0], lng: p[1], kind: done ? 'tentDone' : (isNext ? 'tentNear' : 'tent'),
                    t: (od.stay || '').slice(0, 20) || ('D' + (i + 1))
                });
            });
            /* 旗标：当前段与下一段的打卡点（空心/绿✓） */
            var segI = curIdx == null ? this._segIdx() : curIdx;
            [segI, segI + 1].forEach(function (i) {
                if (i < 0) return;
                self._segSpots(i).forEach(function (it) {
                    var key = it.si != null ? 's' + it.si : 'w' + it.wi;
                    var p = it.s ? it.s.p : it.wp.p;
                    self._markData.push({
                        lat: p[0], lng: p[1],
                        kind: self.checked(key) ? 'flagDone' : 'flag',
                        t: it.s ? it.s.n : it.wp.n
                    });
                });
            });
            this._marks = createMarkerLayer({
                map: (typeof map !== 'undefined') ? map : null,
                styles: {
                    t: { src: icTent(false), width: 26, height: 26, anchor: { x: 13, y: 13 } },
                    tn: { src: icTent(true), width: 26, height: 26, anchor: { x: 13, y: 13 } },
                    td: { src: icTentDone(), width: 26, height: 26, anchor: { x: 13, y: 13 } },
                    f: { src: icFlag(false), width: 22, height: 22, anchor: { x: 11, y: 11 } },
                    fd: { src: icFlag(true), width: 22, height: 22, anchor: { x: 11, y: 11 } }
                },
                geometries: this._markData.map(function (m, i) {
                    var sid = m.kind === 'tent' ? 't' : m.kind === 'tentNear' ? 'tn' : m.kind === 'tentDone' ? 'td' : m.kind === 'flagDone' ? 'fd' : 'f';
                    return { id: 'm' + i, styleId: sid, position: LL(m.lat, m.lng) };
                })
            });
            if (this._marks && this._marks.on) {
                this._marks.on('click', function (e) {
                    var m = self._markData[parseInt(e.geometry.id.slice(1), 10)];
                    if (m) try {
                        map.setZoomAndCenter(12, [m.lng, m.lat]);
                        openInfo(m.lat, m.lng, [[m.kind.indexOf('tent') === 0 || m.kind.indexOf('flag') === 0 ? (m.kind.indexOf('tent') === 0 ? '⛺ 休整点' : '⚑ 打卡点') : '点', 's']], m.t, '行中标记');
                    } catch (er) {}
                });
            }
        },
        _clearMarks: function () {
            if (this._marks) { try { this._marks.setMap(null); } catch (e) {} }
            this._marks = null;
            this._markData = [];
        }
    };

    /* ---------- 标记图标（帐篷/旗标：空心 → 实心+✓，线性 SVG 与 BRAND 同源） ---------- */
    function svgURI(inner) {
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">' + inner + '</svg>');
    }
    function icTent(filled) {
        return svgURI(filled
            ? '<circle cx="13" cy="13" r="12" fill="#fffbeb" stroke="#b45309" stroke-width="1.6"/><path d="M13 5 L5 20 h16 z" fill="#b45309"/><path d="M13 12 L9.5 20 h7 z" fill="#fffbeb"/>'
            : '<circle cx="13" cy="13" r="12" fill="#fff" stroke="#b45309" stroke-width="1.6" stroke-dasharray="3 2"/><path d="M13 5 L5 20 h16 z" fill="none" stroke="#b45309" stroke-width="1.6"/>');
    }
    function icTentDone() {
        return svgURI('<circle cx="13" cy="13" r="12" fill="#0d9488" stroke="#fff" stroke-width="1.6"/><path d="M13 5 L5 20 h16 z" fill="#fff"/><path d="M13 12 L9.5 20 h7 z" fill="#0d9488"/><path d="M17.5 3.5 l1.6 1.6 2.6-2.8" stroke="#16a34a" stroke-width="2" fill="none" stroke-linecap="round"/>');
    }
    function icFlag(done) {
        return svgURI(done
            ? '<circle cx="13" cy="13" r="11" fill="#16a34a" stroke="#fff" stroke-width="1.6"/><path d="M10 20 V7" stroke="#fff" stroke-width="2" stroke-linecap="round"/><path d="M10 7 h9 l-2.4 3.5 L19 14 h-9" fill="#fff"/><path d="M6.5 4.5 l1.4 1.4 2.4-2.6" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/>'
            : '<circle cx="13" cy="13" r="11" fill="#fff" stroke="#8b98a9" stroke-width="1.6" stroke-dasharray="3 2"/><path d="M10 20 V7" stroke="#8b98a9" stroke-width="2" stroke-linecap="round"/><path d="M10 7 h9 l-2.4 3.5 L19 14 h-9" fill="none" stroke="#8b98a9" stroke-width="1.6"/>');
    }
    function distKm(lat1, lng1, lat2, lng2) {
        if (lat2 == null) return 1e9;
        var R = 6371, rad = Math.PI / 180;
        var dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
        var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R * Math.asin(Math.sqrt(s));
    }

    /* ---------- 底部进度卡 + 卡面态渲染（S36 屏二：待出发/进行中/toast/完成） ---------- */
    var _toastEl = null;
    function toastEl() {
        if (!_toastEl) {
            _toastEl = document.createElement('div');
            _toastEl.id = 'enrToast';
            _toastEl.className = 'enr-toast';
            if (document.body && document.body.appendChild) document.body.appendChild(_toastEl);
        }
        return _toastEl;
    }
    function buildCard() {
        var old = document.getElementById('enrCard');
        if (old && old.remove) old.remove();
        var c = document.createElement('div');
        c.id = 'enrCard';
        c.className = 'enr-card';
        if (document.body && document.body.appendChild) document.body.appendChild(c);
        /* 锚点模式：点地图投影 */
        if (typeof map !== 'undefined' && map && map.on) {
            try {
                map.on('click', function (e) {
                    if (!Enroute.on || !Enroute.anchorMode) return;
                    Enroute.anchorMode = false;
                    var ll = e.lnglat;
                    Enroute.setPosition(ll.getLat(), ll.getLng());
                    try { etToast('锚点已设：km' + Enroute.curKm.toFixed(1)); } catch (er) {}
                });
            } catch (e) {}
        }
    }
    /* 计时 mm:ss（>99 分钟自然进位，如 127:30） */
    function fmtClock(ms) {
        var s = Math.max(0, Math.floor(ms / 1000));
        var mm = Math.floor(s / 60), ss = s % 60;
        return (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
    }
    /* 预计到达：只有出发计时 + 已走出平均速度才给（无数据不编造） */
    function etaTxt(elapsedMs, walked, remain) {
        if (!elapsedMs || walked < 3) return '';
        var h = elapsedMs / 3600000;
        if (h < 0.05) return '';
        var sp = walked / h;
        if (sp < 5) return '';
        var min = Math.max(1, Math.round(remain / sp * 60));
        return '预计 ' + Math.floor(min / 60) + 'h' + (min % 60) + 'm';
    }
    function supCount() {
        try {
            if (typeof window !== 'undefined' && window.__sup && typeof window.__sup.count === 'function') {
                return window.__sup.count();
            }
        } catch (e) {}
        return 0;
    }
    /* erfoot：指定补给站（前方最近）优先于支线打卡提示，二者取前 */
    function footLine(st) {
        var des = null;
        try {
            if (typeof window !== 'undefined' && window.__sup &&
                typeof window.__sup.list === 'function' && window.__sup.count() > 0 &&
                typeof STATION_DATA !== 'undefined' && STATION_DATA && Enroute.curKm != null) {
                var off = 0;
                try { off = (typeof curStart === 'function' && curStart().stationKm0) || 0; } catch (e) {}
                window.__sup.list().forEach(function (d) {
                    if (!d || !STATION_DATA[d.c] || !STATION_DATA[d.c][d.i]) return;
                    var s = STATION_DATA[d.c][d.i];
                    if (s.t !== d.t) return;
                    var ahead = (s.km - off) - Enroute.curKm;
                    if (ahead > 0 && (!des || ahead < des.ahead)) des = { ahead: ahead, t: s.t };
                });
            }
        } catch (e) {}
        if (des && !(st === 'side' && Enroute._nextSpot && Enroute._nextSpot.ahead < des.ahead)) {
            return '⛽ 前方 ' + Math.round(des.ahead) + 'km · ' + des.t + '（已指定）';
        }
        if (st === 'side' && Enroute._nextSpot) {
            var it = Enroute._nextSpot.it;
            return '⚑ 前方 ' + Math.round(Enroute._nextSpot.ahead) + 'km · ' + (it.s ? it.s.n : it.wp.n) + '（顺路打卡）';
        }
        return '';
    }
    /* 补给细行（S36 第 6 幕：辅助信息降级——细分隔线、无卡片） */
    function supLineHtml() {
        var n = supCount();
        return '<div class="sup-line" id="enrSupLine">' + (n > 0
            ? '⛽ 我的补给点 ' + n + ' 站　<span class="mgt">管理 ›</span>'
            : '⛽ 未指定补给点 · 跟随行程中') + '</div>';
    }
    /* 工具行（S36 屏二 ctab2：图层 / 全览 / 补给 N / 退出行中——行中常驻入口） */
    function toolsHtml() {
        return '<div class="ctab2">' +
            '<span id="enrLayers2">图层</span>' +
            '<span id="enrFit">全览</span>' +
            '<span id="enrSup">补给 ' + supCount() + '</span>' +
            '<span id="enrExit">退出行中</span></div>';
    }
    function playIcon() {
        return (typeof BRAND !== 'undefined' && BRAND.play) ? BRAND.play : '▶';
    }
    function renderCard() {
        var c = document.getElementById('enrCard');
        if (!c) return;
        var disp = Enroute._disp();
        var segIdx = Enroute._segIdx();
        var dd = disp[segIdx];
        var st = Enroute._state || 'move';
        /* S36：打卡完成 → 卡自然推进下一程（_justChecked 一次性；回看已完成程仍出完成态） */
        if (st === 'done' && dd) {
            var nx = disp[segIdx + 1];
            if (Enroute._justChecked && nx && !Enroute.dayDone(origOf(nx).id)) {
                dd = nx;
                segIdx += 1;
                st = 'move';
            }
        }
        Enroute._justChecked = false;
        var html = '';
        var clockOn = false;
        if (Enroute.curKm == null) {
            html = '<div class="enr-t">⛺ 行中 · 未定位</div>' +
                '<div class="enr-sub">开启定位自动投影到链；或 <button class="enr-mini" id="enrAnchor">📍 我现在在…</button>（点地图锚点）</div>';
        } else if (st === 'done' && dd) {
            /* 今日完成：当日对账 + 明天预告 + 分享（结构不动，S36 仅随卡重皮） */
            var od = origOf(dd);
            var pd = Enroute.progress().daysDone[od.id] || {};
            var dur = pd.durMin ? Math.floor(pd.durMin / 60) + 'h' + (pd.durMin % 60) + 'm' : '—';
            var spots = Enroute._segSpots(segIdx);
            var checkedN = spots.filter(function (it) { return Enroute.checked(it.si != null ? 's' + it.si : 'w' + it.wi); }).length;
            var next = disp[segIdx + 1];
            html = '<div class="enr-t">✅ 本程完成 · 第' + (segIdx + 1) + '程 ' + dd.title + '</div>' +
                '<div class="enr-sub">' + (dd.km || 0) + 'km · 打卡 ' + checkedN + '/' + spots.length + ' · 用时 ' + dur + '</div>' +
                '<div class="enr-chks">' + spots.map(function (it) {
                    var key = it.si != null ? 's' + it.si : 'w' + it.wi;
                    var nm = it.s ? it.s.n : it.wp.n;
                    return '<span class="enr-chk' + (Enroute.checked(key) ? ' on' : '') + '">' + (Enroute.checked(key) ? '✓ ' : '⚑ ') + escapeHtml2e(nm) + '</span>';
                }).join('') + '</div>' +
                (next ? '<div class="enr-sub">下一程 · ' + next.title + ' · ' + (next.km || 0) + 'km</div>' : '<div class="enr-sub">全程完成 🎉</div>') +
                '<div class="enr-row"><button class="enr-mini ok" id="enrShare">分享今日成绩 ↗</button>' +
                '<button class="enr-mini" id="enrSleep">晚安，下一程见</button></div>';
        } else if (dd) {
            /* S36 屏二：待出发 / 进行中（到达打卡不再改卡——toast 浮在卡上） */
            var oday = origOf(dd);
            var a = dd.altKm;
            var remain = a ? Math.max(0, a[1] - Enroute.curKm) : 0;
            var nodeNm = oday.stay || (String(dd.title).split('→').pop() || '').trim();
            var walked = a ? Math.max(0, Enroute.curKm - a[0]) : 0;
            var segLen = a ? Math.max(1, a[1] - a[0]) : 1;
            var started = Enroute.legStarted(oday.id);
            var legRec = (Enroute.progress().legs || {})[oday.id] || {};
            var foot = footLine(st);
            if (!started) {
                /* 待出发：巨号剩余 + 出发大药钮（进度条 3% 占位，演示稿口径） */
                html = '<div class="enr-lab">距下一休整点' + (nodeNm ? ' · ' + escapeHtml2e(nodeNm) : '') + '</div>' +
                    '<div class="enr-big">' + Math.round(remain) + '<small> km</small></div>' +
                    '<div class="enr-dst">第' + (segIdx + 1) + '程 ' + escapeHtml2e(dd.title) + ' · 待出发</div>' +
                    '<div class="enr-bar"><i style="width:3%"></i></div>' +
                    (foot ? '<div class="erfoot"><span>' + escapeHtml2e(foot) + '</span></div>' : '') +
                    supLineHtml() +
                    '<button class="ctab" id="enrGoBtn">' + playIcon() + '出发 · 开始第' + (segIdx + 1) + '程</button>' +
                    toolsHtml();
            } else {
                var barW = Math.round((segIdx + walked / segLen) / Math.max(1, disp.length) * 100);
                var clock = legRec.startTs
                    ? ' · 计时 <span id="enrClock">' + fmtClock(Date.now() - legRec.startTs) + '</span>'
                    : '';   /* 无 startTs 的旧数据：直接显示已走，不编造计时 */
                var eta = legRec.startTs ? etaTxt(Date.now() - legRec.startTs, walked, remain) : '';
                html = '<div class="enr-lab">第' + (segIdx + 1) + '程进行中 · ' + escapeHtml2e(dd.title) + '</div>' +
                    '<div class="enr-big">' + Math.round(remain) + '<small> km</small></div>' +
                    '<div class="enr-dst">距' + escapeHtml2e(nodeNm) + ' · 已走 ' + Math.round(walked) + ' / ' + Math.round(segLen) + ' km' + clock + '</div>' +
                    '<div class="enr-bar"><i style="width:' + barW + '%"></i></div>' +
                    ((foot || eta) ? '<div class="erfoot"><span>' + escapeHtml2e(foot) + '</span>' + (eta ? '<span>' + eta + '</span>' : '') + '</div>' : '') +
                    supLineHtml() +
                    '<button class="ctab share" id="enrShare2">分享今日成绩</button>' +
                    toolsHtml();
                clockOn = !!legRec.startTs;
            }
        }
        c.innerHTML = html;
        /* 计时器：仅进行中且有 startTs 时走秒（mock 无 setInterval，守卫跳过） */
        if (clockOn) Enroute._startClock();
        else Enroute._stopClock();
        /* 接线 */
        var b;
        b = document.getElementById('enrGoBtn');
        if (b) b.onclick = function () { Enroute.legStart(); };
        b = document.getElementById('enrAnchor');
        if (b) b.onclick = function () { Enroute.anchorFromMap(); };
        b = document.getElementById('enrDev');
        if (b) b.onclick = function () { Enroute.toggleDev(); };
        b = document.getElementById('enrLayers2');
        if (b) b.onclick = function () { try { document.body.classList.toggle('mob-layers'); } catch (e) {} };
        b = document.getElementById('enrFit');
        if (b) b.onclick = function () { try { if (typeof goFit === 'function') goFit(); } catch (e) {} };
        b = document.getElementById('enrSup');
        if (b) b.onclick = function () { try { if (window.__sup && window.__sup.open) window.__sup.open(); } catch (e) {} };
        b = document.getElementById('enrSupLine');
        if (b) b.onclick = function () { try { if (window.__sup && window.__sup.open) window.__sup.open(); } catch (e) {} };
        b = document.getElementById('enrExit');
        if (b) b.onclick = function () { Enroute.exit(); };
        b = document.getElementById('enrSleep');
        if (b) b.onclick = function () { Enroute.exit(); };
        b = document.getElementById('enrShare');
        if (b) b.onclick = shareTodayPng;
        b = document.getElementById('enrShare2');
        if (b) b.onclick = shareTodayPng;
    }
    /* 计时走秒：只刷 #enrClock 文本，不动卡 */
    Enroute._startClock = function () {
        this._stopClock();
        if (typeof setInterval !== 'function') return;
        var self = this;
        try {
            this._clockTimer = setInterval(function () {
                var el = document.getElementById('enrClock');
                if (!el) { self._stopClock(); return; }
                var segIdx = self._segIdx();
                var dd = self._disp()[segIdx];
                if (!dd) { self._stopClock(); return; }
                var leg = (self.progress().legs || {})[origOf(dd).id] || {};
                if (!leg.startTs) { self._stopClock(); return; }
                el.textContent = fmtClock(Date.now() - leg.startTs);
            }, 1000);
        } catch (e) {}
    };
    Enroute._stopClock = function () {
        if (this._clockTimer != null && typeof clearInterval === 'function') {
            try { clearInterval(this._clockTimer); } catch (e) {}
        }
        this._clockTimer = null;
    };
    function escapeHtml2e(t) {
        return String(t == null ? '' : t).replace(/[&<>"]/g, function (c2) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c2]; });
    }

    /* ---------- 今日成绩分享图（S33 生成器同源，只换数据段；只展示去过的点） ---------- */
    function shareTodayPng() {
        try {
            var cv = document.createElement('canvas');
            if (!cv.getContext) { try { etToast('当前环境不支持 canvas'); } catch (e) {} return; }
            var disp = Enroute._disp();
            var segIdx = Enroute._segIdx();
            var dd = disp[segIdx];
            if (!dd) return;
            var od = origOf(dd);
            var pd = Enroute.progress().daysDone[od.id] || {};
            var W = 750, pad = 48;
            var rowH = 56, H = 320 + rowH + 150;
            cv.width = W; cv.height = H;
            var ctx = cv.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
            var y = 0;
            ctx.fillStyle = '#0b1220'; ctx.font = '600 30px "PingFang SC", system-ui, sans-serif';
            ctx.fillText('去旷野，见山海', pad, y += 50);
            ctx.font = '600 38px "PingFang SC", system-ui, sans-serif';
            ctx.fillText((typeof BRAND !== 'undefined' && BRAND.stripEmoji ? BRAND.stripEmoji(ROUTE_META.name) : ROUTE_META.name) +
                ' · 第 ' + (segIdx + 1) + ' 程完成 ✓', pad, y += 56);
            ctx.fillStyle = '#3d4a5c'; ctx.font = '25px "PingFang SC", system-ui, sans-serif';
            var dur = pd.durMin ? Math.floor(pd.durMin / 60) + 'h' + (pd.durMin % 60) + 'm' : '';
            ctx.fillText(dd.title + ' · ' + (dd.km || 0) + 'km' + (dur ? ' · 用时 ' + dur : ''), pad, y += 40);
            /* 当天链：出发 → 去过的打卡（✓）→ 到达节点。没去的不画（诚实靠「不写」） */
            y += 36;
            ctx.fillStyle = '#0d9488';
            ctx.beginPath(); ctx.arc(pad + 7, y - 7, 7, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#0b1220'; ctx.font = '600 25px "PingFang SC", system-ui, sans-serif';
            ctx.fillText((dd.title.split('→')[0] || '').trim() + ' 出发' + (pd.t ? ' ' + pd.t.slice(11, 16) : ''), pad + 26, y);
            var spots = Enroute._segSpots(segIdx);
            spots.forEach(function (it) {
                var key = it.si != null ? 's' + it.si : 'w' + it.wi;
                if (!Enroute.checked(key)) return;   // 只展示去过的
                y += rowH;
                ctx.strokeStyle = '#edf0f4'; ctx.lineWidth = 3;
                ctx.beginPath(); ctx.moveTo(pad + 7, y - rowH + 6); ctx.lineTo(pad + 7, y + 6); ctx.stroke();
                ctx.fillStyle = '#16a34a'; ctx.font = '24px "PingFang SC", system-ui, sans-serif';
                ctx.fillText('⚑ ' + (it.s ? it.s.n : it.wp.n) + ' ✓', pad + 26, y - 14);
            });
            y += rowH;
            ctx.fillStyle = '#b45309'; ctx.font = '600 26px "PingFang SC", system-ui, sans-serif';
            ctx.fillText('⛺ ' + (od.stay || (dd.title.split('→').pop() || '').trim()).slice(0, 16) +
                (pd.t ? ' · ' + pd.t.slice(11, 16) + ' 到达' : ''), pad + 26, y - 14);
            /* 全程进度条 */
            y += 40;
            var doneN = disp.filter(function (d) { return Enroute.dayDone(origOf(d).id); }).length;
            ctx.fillStyle = '#edf0f4'; ctx.fillRect(pad, y, W - pad * 2, 14);
            ctx.fillStyle = '#0d9488'; ctx.fillRect(pad, y, (W - pad * 2) * Math.min(1, doneN / Math.max(1, disp.length)), 14);
            ctx.fillStyle = '#3d4a5c'; ctx.font = '23px "PingFang SC", system-ui, sans-serif';
            ctx.fillText('全程 ' + doneN + '/' + disp.length + ' 程', pad, y + 40);
            var peak = (typeof peakAlt === 'function') ? peakAlt() : { alt: '-' };
            ctx.fillText('xianlumap.ok.kimi.link · 最高 ' + peak.alt + 'm', pad, H - 34);
            var a = document.createElement('a');
            a.href = cv.toDataURL('image/png');
            a.download = 'day' + (segIdx + 1) + '-' + ROUTE_META.key + '.png';
            if (document.body && document.body.appendChild) { document.body.appendChild(a); a.click(); a.remove(); }
            try { etToast('今日成绩图已生成'); } catch (e) {}
        } catch (e) {
            try { etToast('成绩图生成失败：' + (e && e.message ? e.message.slice(0, 40) : '')); } catch (e2) {}
        }
    }

    /* ---------- 入口按钮 ----------
       S34：移动端入口统一为标题条「规划/行中」模式开关（mobile.js mobMode），
       不再往 mobBar 塞独立按钮；桌面入口仍是侧栏标题（#panel h1）上的本钮。 */
    (function bindEntry() {
        function mkBtn() {
            var b = document.createElement('button');
            b.id = 'enrToggle';
            b.className = 'enr-toggle';
            b.textContent = '⛺ 行中';
            b.onclick = function () { Enroute.on ? Enroute.exit() : Enroute.enter(); b.classList.toggle('on', Enroute.on); };
            return b;
        }
        var h1 = document.querySelector ? document.querySelector('#panel h1') : null;
        if (h1 && h1.appendChild) h1.appendChild(mkBtn());
    })();

    /* 调试钩子（截图/联调，与 mobile.js ?mobsheet= 同族）：
       ?enr=1 启动即入行中（验证 iOS 壳原生定位桥）；&enrkm=400 同时打手动锚点 */
    try {
        if (typeof location !== 'undefined' && location.search && /[?&]enr=1/.test(location.search)) {
            var enrKmM = location.search.match(/[?&]enrkm=([\d.]+)/);
            setTimeout(function () {
                try {
                    Enroute.enter();
                    if (enrKmM) Enroute.setAnchorKm(+enrKmM[1]);
                } catch (e) {}
            }, 600);
        }
    } catch (e) {}

    try { window.Enroute = Enroute; } catch (e) {}
})();
