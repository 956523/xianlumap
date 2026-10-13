/* ============================================================================
 * engine/enroute.js — 行中模式（S30：轻量行中 + 离线可用）
 *
 * 定位（设计稿〇）：不是导航，是「行进中的进度伴侣」——我在哪一段链上、
 * 离今晚住哪还有多远、顺路有什么打卡点。不做路况/语音/重算。
 * 边界：浏览器定位只在本机投影到链（_dayKmTable 最近点），不上传任何服务器；
 * 打卡进度存 Edit.overlay.progress（S32 草稿/保存/云同步体系）；三键上报（可用/
 * 需注意/不可用）仅落本机，云端服务立项后接。
 *
 * 四态：行进中 / 支线提醒 / 到达打卡（节点 500m 内弹「打卡 ✓」）/ 今日完成
 * （当日对账 + 明天预告 + 成绩分享图）。支线打卡点 200m 路过自动点亮。
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
            return ov.progress;
        },
        checked: function (key) { return !!this.progress().checks[key]; },
        dayDone: function (dayId) { return !!this.progress().daysDone[dayId]; },

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
            if (this._watchId != null && typeof navigator !== 'undefined' && navigator.geolocation) {
                try { navigator.geolocation.clearWatch(this._watchId); } catch (e) {}
            }
            this._watchId = null;
            this.anchorMode = false;
            var c = document.getElementById('enrCard');
            if (c && c.remove) c.remove();
            this._restoreSegStyles();
            this._clearMarks();
            var m = document.getElementById('enrMarks');
            if (m && m.remove) m.remove();
        },

        /* ---------- 定位投影 ---------- */
        _bindGeo: function () {
            var self = this;
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
            /* 主任务：到段终点 500m 内 → 到达打卡态 */
            var remain = a ? (a[1] - this.curKm) : 0;
            if (!this.dayDone(oday.id) && remain <= 0.5) {
                this._state = 'arrive';
            } else if (this.dayDone(oday.id)) {
                this._state = 'done';
            } else {
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
        /* 到达打卡：确认后节点点亮 + 当天完成 */
        checkIn: function (report) {
            var segIdx = this._segIdx();
            var dd = this._disp()[segIdx];
            if (!dd) return false;
            var oday = origOf(dd);
            var p = this.progress();
            p.daysDone[oday.id] = {
                t: new Date().toISOString(),
                durMin: this._segEnterAt ? Math.max(1, Math.round((Date.now() - this._segEnterAt) / 60000)) : null,
                report: report || null   // 三键上报：1 可用 / 0 需注意 / -1 不可用（云端服务后接）
            };
            try { editSave(); } catch (e) {}
            try { this._persistProgress(); } catch (e) {}   // 行中打卡即时落盘（旅程数据丢不起；其余编辑仍纯草稿）
            this._segEnterAt = null;
            this._state = 'done';
            this._applySegStyles(segIdx);
            this._renderMarks(segIdx);
            renderCard();
            return true;
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
                var st = done ? { color: '#0f766e', width: 5, borderWidth: 1, borderColor: '#ffffff', lineCap: 'round', arrowOptions: { width: 8 } }
                    : isCur ? { color: '#14b8a6', width: 2.5, borderWidth: 1, borderColor: '#ffffff', lineCap: 'round', arrowOptions: { width: 8 } }
                        : { color: '#99f6e4', width: 2, borderWidth: 0, lineCap: 'round' };
                try { pl.setStyles({ default: st }); } catch (e) {}
            });
        },
        _restoreSegStyles: function () {
            if (typeof dayLines === 'undefined') return;
            dayLines.forEach(function (pl) {
                if (!pl) return;
                try { pl.setStyles({ default: NORMAL }); } catch (e) {}
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
        return svgURI('<circle cx="13" cy="13" r="12" fill="#0f766e" stroke="#fff" stroke-width="1.6"/><path d="M13 5 L5 20 h16 z" fill="#fff"/><path d="M13 12 L9.5 20 h7 z" fill="#0f766e"/><path d="M17.5 3.5 l1.6 1.6 2.6-2.8" stroke="#16a34a" stroke-width="2" fill="none" stroke-linecap="round"/>');
    }
    function icFlag(done) {
        return svgURI(done
            ? '<circle cx="13" cy="13" r="11" fill="#16a34a" stroke="#fff" stroke-width="1.6"/><path d="M10 20 V7" stroke="#fff" stroke-width="2" stroke-linecap="round"/><path d="M10 7 h9 l-2.4 3.5 L19 14 h-9" fill="#fff"/><path d="M6.5 4.5 l1.4 1.4 2.4-2.6" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/>'
            : '<circle cx="13" cy="13" r="11" fill="#fff" stroke="#94a3b8" stroke-width="1.6" stroke-dasharray="3 2"/><path d="M10 20 V7" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"/><path d="M10 7 h9 l-2.4 3.5 L19 14 h-9" fill="none" stroke="#94a3b8" stroke-width="1.6"/>');
    }
    function distKm(lat1, lng1, lat2, lng2) {
        if (lat2 == null) return 1e9;
        var R = 6371, rad = Math.PI / 180;
        var dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
        var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R * Math.asin(Math.sqrt(s));
    }

    /* ---------- 底部进度卡 + 四态渲染 ---------- */
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
    function renderCard() {
        var c = document.getElementById('enrCard');
        if (!c) return;
        var disp = Enroute._disp();
        var segIdx = Enroute._segIdx();
        var dd = disp[segIdx];
        var st = Enroute._state || (Enroute.curKm == null ? 'move' : 'move');
        var html = '';
        if (Enroute.curKm == null) {
            html = '<div class="enr-t">⛺ 行中 · 未定位</div>' +
                '<div class="enr-sub">开启定位自动投影到链；或 <button class="enr-mini" id="enrAnchor">📍 我现在在…</button>（点地图锚点）</div>';
        } else if (st === 'done' && dd) {
            /* 今日完成：当日对账 + 明天预告 + 分享 */
            var od = origOf(dd);
            var pd = Enroute.progress().daysDone[od.id] || {};
            var dur = pd.durMin ? Math.floor(pd.durMin / 60) + 'h' + (pd.durMin % 60) + 'm' : '—';
            var spots = Enroute._segSpots(segIdx);
            var checkedN = spots.filter(function (it) { return Enroute.checked(it.si != null ? 's' + it.si : 'w' + it.wi); }).length;
            var next = disp[segIdx + 1];
            html = '<div class="enr-t">✅ 今日完成 · D' + (segIdx + 1) + ' ' + dd.title + '</div>' +
                '<div class="enr-sub">' + (dd.km || 0) + 'km · 打卡 ' + checkedN + '/' + spots.length + ' · 用时 ' + dur + '</div>' +
                '<div class="enr-chks">' + spots.map(function (it) {
                    var key = it.si != null ? 's' + it.si : 'w' + it.wi;
                    var nm = it.s ? it.s.n : it.wp.n;
                    return '<span class="enr-chk' + (Enroute.checked(key) ? ' on' : '') + '">' + (Enroute.checked(key) ? '✓ ' : '⚑ ') + escapeHtml2e(nm) + '</span>';
                }).join('') + '</div>' +
                (next ? '<div class="enr-sub">明天 D' + (segIdx + 2) + ' · ' + next.title + ' · ' + (next.km || 0) + 'km</div>' : '<div class="enr-sub">全程完成 🎉</div>') +
                '<div class="enr-row"><button class="enr-mini" id="enrShare">分享今日成绩 ↗</button>' +
                '<button class="enr-mini" id="enrSleep">睡觉，明天见</button></div>';
        } else if (st === 'arrive' && dd) {
            html = '<div class="enr-t">🎉 到达「' + escapeHtml2e(origOf(dd).stay || (dd.title.split('→').pop() || '').trim() || ('D' + (segIdx + 1))) + '」</div>' +
                '<div class="enr-sub">今天任务完成——打卡后点亮节点：</div>' +
                '<div class="enr-row">' +
                '<button class="enr-mini ok" id="enrOk1">✓ 打卡（这站可用）</button>' +
                '<button class="enr-mini" id="enrOk0">⚠ 需注意</button>' +
                '<button class="enr-mini" id="enrOk_1">✕ 不可用</button></div>';
        } else {
            var remain = dd && dd.altKm ? Math.max(0, dd.altKm[1] - Enroute.curKm) : 0;
            var nodeNm = dd ? (origOf(dd).stay || (dd.title.split('→').pop() || '').trim()) : '';
            html = '<div class="enr-t">🚗 距今晚休整点「' + escapeHtml2e(nodeNm) + '」还有 ' + Math.round(remain) + ' km</div>';
            if (dd && dd.altKm) {
                var walked = Math.max(0, Enroute.curKm - dd.altKm[0]);
                html += '<div class="enr-sub">当前段 D' + (segIdx + 1) + ' · ' + dd.title + ' · 已走 ' + Math.round(walked) + '/' + Math.round(dd.altKm[1] - dd.altKm[0]) + ' km</div>';
            }
            /* 全程进度条 */
            var doneN = disp.filter(function (d) { return Enroute.dayDone(origOf(d).id); }).length;
            html += '<div class="enr-bar"><i style="width:' + Math.round((segIdx + (dd && dd.altKm ? (Enroute.curKm - dd.altKm[0]) / Math.max(1, dd.altKm[1] - dd.altKm[0]) : 0)) / Math.max(1, disp.length) * 100) + '%"></i></div>' +
                '<div class="enr-sub">全程 ' + doneN + '/' + disp.length + ' 天' + (st === 'side' && Enroute._nextSpot ? '' : ' · <button class="enr-mini" id="enrAnchor">📍 锚点</button> <button class="enr-mini" id="enrDev">' + (Enroute._devOff ? '开启偏离提醒' : '关闭偏离提醒') + '</button>') + '</div>';
            if (st === 'side' && Enroute._nextSpot) {
                var it = Enroute._nextSpot.it;
                html += '<div class="enr-side">⚑ 支线 · 前方 ' + Math.round(Enroute._nextSpot.ahead) + ' km 有打卡点：' +
                    escapeHtml2e(it.s ? it.s.n : it.wp.n) + '（顺路停靠，200m 内自动点亮）</div>';
            }
        }
        c.innerHTML = html;
        /* 接线 */
        var b;
        b = document.getElementById('enrAnchor');
        if (b) b.onclick = function () { Enroute.anchorFromMap(); };
        b = document.getElementById('enrDev');
        if (b) b.onclick = function () { Enroute.toggleDev(); };
        [1, 0, -1].forEach(function (rv) {
            b = document.getElementById('enrOk' + (rv === -1 ? '_1' : rv));
            if (b) b.onclick = function () {
                Enroute.checkIn(rv);
                try { etToast('已打卡' + (rv === 1 ? '（这站可用）' : rv === 0 ? '（需注意）' : '（不可用）')); } catch (e) {}
            };
        });
        b = document.getElementById('enrSleep');
        if (b) b.onclick = function () { Enroute.exit(); };
        b = document.getElementById('enrShare');
        if (b) b.onclick = shareTodayPng;
    }
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
            ctx.fillStyle = '#0f172a'; ctx.font = '600 30px "PingFang SC", system-ui, sans-serif';
            ctx.fillText('去旷野，见山海', pad, y += 50);
            ctx.font = '600 38px "PingFang SC", system-ui, sans-serif';
            ctx.fillText((typeof BRAND !== 'undefined' && BRAND.stripEmoji ? BRAND.stripEmoji(ROUTE_META.name) : ROUTE_META.name) +
                ' · 第 ' + (segIdx + 1) + ' 天完成 ✓', pad, y += 56);
            ctx.fillStyle = '#64748b'; ctx.font = '25px "PingFang SC", system-ui, sans-serif';
            var dur = pd.durMin ? Math.floor(pd.durMin / 60) + 'h' + (pd.durMin % 60) + 'm' : '';
            ctx.fillText(dd.title + ' · ' + (dd.km || 0) + 'km' + (dur ? ' · 用时 ' + dur : ''), pad, y += 40);
            /* 当天链：出发 → 去过的打卡（✓）→ 到达节点。没去的不画（诚实靠「不写」） */
            y += 36;
            ctx.fillStyle = '#0f766e';
            ctx.beginPath(); ctx.arc(pad + 7, y - 7, 7, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#0f172a'; ctx.font = '600 25px "PingFang SC", system-ui, sans-serif';
            ctx.fillText((dd.title.split('→')[0] || '').trim() + ' 出发' + (pd.t ? ' ' + pd.t.slice(11, 16) : ''), pad + 26, y);
            var spots = Enroute._segSpots(segIdx);
            spots.forEach(function (it) {
                var key = it.si != null ? 's' + it.si : 'w' + it.wi;
                if (!Enroute.checked(key)) return;   // 只展示去过的
                y += rowH;
                ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 3;
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
            ctx.fillStyle = '#e2e8f0'; ctx.fillRect(pad, y, W - pad * 2, 14);
            ctx.fillStyle = '#0f766e'; ctx.fillRect(pad, y, (W - pad * 2) * Math.min(1, doneN / Math.max(1, disp.length)), 14);
            ctx.fillStyle = '#64748b'; ctx.font = '23px "PingFang SC", system-ui, sans-serif';
            ctx.fillText('全程 ' + doneN + '/' + disp.length + ' 天', pad, y + 40);
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

    /* ---------- 入口按钮（标题条右侧，与顺/逆切换并列；移动端同款随 mobBar） ---------- */
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
        var mobBar = document.getElementById('mobBar');
        if (mobBar && mobBar.appendChild) mobBar.appendChild(mkBtn());
    })();

    try { window.Enroute = Enroute; } catch (e) {}
})();
