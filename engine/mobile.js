/* ============================================================================
 * engine/mobile.js — 移动端底部抽屉（S14，≤768px）
 *
 * 断点 768 与 index.html 的媒体块、route-engine 的 narrow 判定三处同值。
 * 三态：peek（默认，露手柄+标题+chips 概要）/ full（全展）/ hidden（收起），
 * 由 body class（mob-full / mob-hidden）驱动 CSS transform；
 * 剖面抽屉 #elev 打开时 profile.js 给 body 加 mob-elev，把行程单压出屏外（第二张表，互斥）。
 *
 * 桌面零影响：>768 时 setSheet 不改任何 class（本文件逻辑全 no-op），
 * 渲染输出与未加载本文件时逐字节一致。
 * 依赖：route-engine.js（map/setPanelOpen）与 profile.js（openDrawer 系列）先加载，
 * edit.js / ui.js 后加载；窄屏点日卡由 route-engine focusDay 调 setSheet('peek')。
 * ========================================================================== */

var MOBILE_PEEK = 112;       // peek 露出高度（手柄28 + 规划概要行 + 首张日卡一截），与 CSS --sheet-peek 同值
var MOBILE_BREAK = 768;
var sheetState = 'peek';     // 'peek' | 'full' | 'hidden'
var mobActive = false;       // 当前是否处于移动断点

function isMobile() { return window.innerWidth <= MOBILE_BREAK; }

/* 切换抽屉态。桌面（未激活）下只记账，不动任何 class。 */
function setSheet(st) {
    sheetState = st;
    if (!mobActive) return;
    var b = document.body;
    if (b && b.classList) {
        b.classList.remove('mob-drag');
        b.classList.toggle('mob-full', st === 'full');
        b.classList.toggle('mob-hidden', st === 'hidden');
    }
    // 行程单露出高度 → CSS 变量：地图容器缩短、剖面把手贴其下沿（两张表叠放）
    var root = document.documentElement;
    if (root && root.style && typeof root.style.setProperty === 'function') {
        root.style.setProperty('--sheet-visible', (st === 'peek' ? MOBILE_PEEK : 0) + 'px');
    }
    var p = document.getElementById('panel');
    if (p && p.classList) {
        p.classList.toggle('collapsed', st === 'hidden');
        if (p.style) p.style.transform = '';   // 交还给 body class 驱动
        var hd = document.getElementById('panelHandle');
        if (hd && hd.classList) hd.classList.toggle('show', st === 'hidden');
    }
}

/* --- 手柄注入：#panel 第一个子元素，纯视觉条，手势逻辑在下面 --- */
var sheetPanel = document.getElementById('panel');
var sheetGrip = document.createElement('div');
sheetGrip.id = 'sheetGrip';
sheetGrip.className = 'sheet-grip';
if (typeof sheetGrip.setAttribute === 'function') sheetGrip.setAttribute('aria-label', '上滑展开行程单');
if (sheetPanel) {
    if (typeof sheetPanel.insertBefore === 'function' && sheetPanel.firstChild) {
        sheetPanel.insertBefore(sheetGrip, sheetPanel.firstChild);
    } else if (typeof sheetPanel.appendChild === 'function') {
        sheetPanel.appendChild(sheetGrip);
    }
}

/* --- 拖拽手势：跟手位移 + 松手按档位/速度 snap ---
   挂手柄和面板标题行；日卡列表区内部滚动不在这两个区上，不抢手势。 */
var drag = null;

function sheetBase(panelH, st) {
    // 各档位的 translateY：full=0，peek=露出 MOBILE_PEEK，hidden=完全出屏
    if (st === 'full') return 0;
    if (st === 'hidden') return panelH;
    return Math.max(0, panelH - MOBILE_PEEK);
}

function sheetNow() { return Date.now(); }

function onSheetStart(e) {
    if (!mobActive) return;
    var t = e.touches && e.touches[0];
    if (!t || !sheetPanel || typeof sheetPanel.getBoundingClientRect !== 'function') return;
    var h = sheetPanel.offsetHeight || sheetPanel.getBoundingClientRect().height || 0;
    if (!h) return;
    drag = { y0: t.clientY, h: h, lastY: t.clientY, lastT: sheetNow(), vy: 0, moved: false, st0: sheetState };
    if (document.body && document.body.classList) document.body.classList.add('mob-drag');  // 跟手：关过渡
}

function onSheetMove(e) {
    if (!drag) return;
    var t = e.touches && e.touches[0];
    if (!t) return;
    var nowT = sheetNow();
    var dt = Math.max(1, nowT - drag.lastT);
    drag.vy = (drag.lastY - t.clientY) / dt;   // 上滑为正，px/ms
    drag.lastY = t.clientY; drag.lastT = nowT;
    var dy = drag.y0 - t.clientY;
    if (!drag.moved && Math.abs(dy) < 6) return;   // 6px 死区：先不判滑动，保住标题行里的按钮点击
    drag.moved = true;
    if (e.cancelable && typeof e.preventDefault === 'function') e.preventDefault();
    var ty = Math.max(0, Math.min(drag.h, sheetBase(drag.h, drag.st0) - dy));
    drag.ty = ty;
    if (sheetPanel && sheetPanel.style) sheetPanel.style.transform = 'translateY(' + ty + 'px)';
}

function onSheetEnd() {
    if (!drag) return;
    var d = drag; drag = null;
    if (document.body && document.body.classList) document.body.classList.remove('mob-drag');
    if (sheetPanel && sheetPanel.style) sheetPanel.style.transform = '';
    if (!d.moved) {
        // 轻点手柄：peek ↔ full（hidden 点手柄 = 展开）
        setSheet(d.st0 === 'full' ? 'peek' : 'full');
        return;
    }
    var h = d.h || 1;
    var ty = (typeof d.ty === 'number') ? d.ty : sheetBase(h, d.st0);
    var target;
    if (d.vy > 0.45) target = 'full';                                  // 快速上滑：直接全展
    else if (d.vy < -0.45) target = (ty > h - MOBILE_PEEK * 0.5) ? 'hidden' : 'peek';
    else {
        // 按最近档位 snap
        var dF = Math.abs(ty - 0), dP = Math.abs(ty - Math.max(0, h - MOBILE_PEEK)), dH = Math.abs(ty - h);
        target = (dP <= dF && dP <= dH) ? 'peek' : (dF <= dH ? 'full' : 'hidden');
    }
    setSheet(target);
}

function bindSheetTouch(el) {
    if (!el || typeof el.addEventListener !== 'function') return;
    el.addEventListener('touchstart', onSheetStart, { passive: true });
    el.addEventListener('touchmove', onSheetMove, { passive: false });
    el.addEventListener('touchend', onSheetEnd);
    el.addEventListener('touchcancel', onSheetEnd);
}
bindSheetTouch(sheetGrip);
bindSheetTouch(sheetPanel && typeof sheetPanel.querySelector === 'function' ? sheetPanel.querySelector('h1') : null);

/* 点地图（非抽屉）时 full → peek，把地图让出来 */
if (typeof map !== 'undefined' && map && typeof map.on === 'function') {
    map.on('click', function () {
        if (mobActive && sheetState === 'full') setSheet('peek');
    });
}

/* 侧栏折叠语义接管：窄屏时「折叠」= 抽屉收到 hidden，「展开」= 回到 peek */
var _desktopSetPanelOpen = (typeof setPanelOpen === 'function') ? setPanelOpen : null;
setPanelOpen = function (open) {
    if (isMobile()) { setSheet(open ? 'peek' : 'hidden'); return; }
    if (_desktopSetPanelOpen) _desktopSetPanelOpen(open);
};

/* ============================================================================
 * S16 移动端信息架构（≤768px）：标题条 + ⋯菜单 + 图层弹层 + 浮动按钮组
 *
 * 结构（首次进入移动断点时构建 #mobRoot，回桌面整体隐藏并把节点归位）：
 *   #mobBar   常驻标题条：线路名 + 出发地切换（startSeg 迁入）+ 车型开关 + ⋯菜单
 *   #mobMenu  ⋯菜单：编辑模式 / 云同步 / 数据来源说明
 *   #mobLayersBk + #mobLayers  图层弹层：图例开关 + 续航卡整体迁入，点遮罩关闭
 *   #mobBtns  地图右下浮动组：图层按钮 + 「全览」条件按钮（偏离全览视野才出现，
 *             判定挂 zoomchange/moveend 防抖链，基准取 fitAll 写入的 __fitDebug）
 * 桌面（>768）：#mobRoot 隐藏、迁移节点全部归位，侧栏与浮动结构维持现状。
 * ========================================================================== */
var iaRoot = null;           // #mobRoot（含标题条/菜单/弹层/浮动按钮）
var iaMoved = [];            // 迁移节点登记表 [{node, parent, next}]（回桌面用）
var iaBuilt = false;
var iaPeek = null;           // #planPeek（peek 概要行）
var editCloseAttached = false;

function mobEl(tag, id, cls, html) {
    var el = document.createElement(tag);
    if (id) el.id = id;
    if (cls) el.className = cls;
    if (html != null) el.innerHTML = html;
    return el;
}

/* 把 node 迁入 container（mock DOM 缺 parentNode/insertBefore 时安全跳过） */
function mobMove(node, container) {
    if (!node || !container) return;
    if (typeof node.parentNode === 'undefined' || !node.parentNode) return;   // mock：不动
    iaMoved.push({ node: node, parent: node.parentNode, next: node.nextSibling });
    container.appendChild(node);
}
function mobRestoreMoved() {
    for (var i = iaMoved.length - 1; i >= 0; i--) {
        var rec = iaMoved[i];
        try {
            if (rec.parent && typeof rec.parent.insertBefore === 'function') {
                rec.parent.insertBefore(rec.node, rec.next || null);
            }
        } catch (e) {}
    }
    iaMoved = [];
}

function buildIA() {
    if (iaBuilt) return;
    iaBuilt = true;
    iaRoot = mobEl('div', 'mobRoot');
    iaRoot.style.display = 'none';

    /* 标题条 */
    var bar = mobEl('div', 'mobBar');
    bar.appendChild(mobEl('b', 'mobRouteName', null,
        (typeof ROUTE_META !== 'undefined' && ROUTE_META && ROUTE_META.name) || '线路'));
    bar.appendChild(mobEl('span', 'mobStartSlot'));
    var evsw = mobEl('span', null, 'mob-evsw');
    evsw.appendChild(mobEl('button', 'mobEv', null, '⚡ 电车'));
    evsw.appendChild(mobEl('button', 'mobFuel', null, '⛽ 油车'));
    bar.appendChild(evsw);
    bar.appendChild(mobEl('button', 'mobMenuBtn', null, '⋯'));
    iaRoot.appendChild(bar);

    /* ⋯菜单 */
    var menu = mobEl('div', 'mobMenu');
    menu.appendChild(mobEl('button', 'mobMenuEdit', null, '✏️ 编辑模式'));
    menu.appendChild(mobEl('button', 'mobMenuSync', null, '☁️ 云同步'));
    menu.appendChild(mobEl('button', 'mobMenuData', null, 'ℹ️ 数据来源说明'));
    iaRoot.appendChild(menu);

    /* 图层弹层 + 遮罩 */
    var bk = mobEl('div', 'mobLayersBk');
    var layers = mobEl('div', 'mobLayers');
    var head = mobEl('div', null, 'ml-head');
    head.appendChild(mobEl('span', null, null, '🗺 图层与续航'));
    head.appendChild(mobEl('button', 'mobLayersClose', null, '✕'));
    layers.appendChild(head);
    layers.appendChild(mobEl('div', 'mobLayersBody'));
    iaRoot.appendChild(bk);
    iaRoot.appendChild(layers);

    /* 浮动按钮组 */
    var btns = mobEl('div', 'mobBtns');
    btns.appendChild(mobEl('button', 'mobLayersBtn', null, '🗺<br>图层'));
    btns.appendChild(mobEl('button', 'mobFit', null, '⛶<br>全览'));
    iaRoot.appendChild(btns);

    if (document.body && typeof document.body.appendChild === 'function') document.body.appendChild(iaRoot);

    /* peek 概要行：插到手柄之后（planner.renderPlanPanel 会喂它数据） */
    iaPeek = mobEl('div', 'planPeek');
    if (sheetPanel && typeof sheetPanel.insertBefore === 'function' && sheetGrip) {
        try { sheetPanel.insertBefore(iaPeek, sheetGrip.nextSibling); } catch (e) {}
    }

    /* 迁移：出发地切换 → 标题条；图例 + 续航卡 → 图层弹层（原事件随节点走） */
    mobMove(document.getElementById('startSeg'), bar.querySelector ? bar.querySelector('#mobStartSlot') || bar.children[1] : bar.children[1]);
    var lb = document.getElementById('mobLayersBody');
    mobMove(document.getElementById('legendBox'), lb);
    mobMove(document.querySelector ? document.querySelector('.evcard') : null, lb);

    attachEditClose();

    /* 车型开关：代理点击隐藏的真实按钮（planner 的 handler 原样复用） */
    var mobEv = document.getElementById('mobEv');
    var mobFuel = document.getElementById('mobFuel');
    if (mobEv) mobEv.onclick = function () { var b = document.getElementById('btnEv'); if (b && typeof b.click === 'function') b.click(); };
    if (mobFuel) mobFuel.onclick = function () { var b = document.getElementById('btnFuel'); if (b && typeof b.click === 'function') b.click(); };

    /* 菜单 */
    var menuBtn = document.getElementById('mobMenuBtn');
    if (menuBtn) menuBtn.onclick = function () { toggleClass('mob-menu'); };
    var mEdit = document.getElementById('mobMenuEdit');
    if (mEdit) mEdit.onclick = function () {
        toggleClass('mob-menu', false);
        try { if (typeof Edit !== 'undefined' && Edit.enter) Edit.enter(); } catch (e) {}
    };
    var mSync = document.getElementById('mobMenuSync');
    if (mSync) mSync.onclick = function () {
        toggleClass('mob-menu', false);
        try {
            if (typeof Edit !== 'undefined' && Edit.enter) Edit.enter();
            var up = document.getElementById('syncUp');
            if (up && typeof up.scrollIntoView === 'function') up.scrollIntoView({ block: 'center' });
        } catch (e) {}
    };
    var mData = document.getElementById('mobMenuData');
    if (mData) mData.onclick = function () {
        toggleClass('mob-menu', false);
        var caveat = document.getElementById('dataCaveat');
        var msg = '数据说明：' + ((caveat && caveat.textContent) || '站点为公开资料整理，出发前请复核营业状态。');
        try { if (typeof window !== 'undefined' && window.alert) window.alert(msg); } catch (e) {}
    };

    /* 图层弹层开合 */
    var openBk = function () { toggleClass('mob-layers', true); };
    if (bk) bk.onclick = function () { toggleClass('mob-layers', false); };
    var layersBtn = document.getElementById('mobLayersBtn');
    if (layersBtn) layersBtn.onclick = openBk;
    var layersClose = document.getElementById('mobLayersClose');
    if (layersClose) layersClose.onclick = function () { toggleClass('mob-layers', false); };

    /* 全览条件按钮 */
    var fitBtn = document.getElementById('mobFit');
    if (fitBtn) fitBtn.onclick = function () {
        try { if (typeof fitAll === 'function') fitAll(); } catch (e) {}
        setTimeout(checkFit, 450);   // 动画收尾后再判一次（mock setTimeout 同步执行也无害）
    };
}

/* 编辑面板全屏化的关闭条：editBar 由 edit.js 创建（晚于本文件），
   所以既在 buildIA 里尝试，也留给 sync.js（edit.js 之后加载）再调一次 */
function attachEditClose() {
    if (editCloseAttached) return;
    var bar = document.getElementById('editBar');
    if (!bar || typeof bar.appendChild !== 'function') return;
    var btn = mobEl('button', 'editClose', null, '‹ 完成编辑');
    btn.onclick = function () { try { if (typeof Edit !== 'undefined' && Edit.exit) Edit.exit(); } catch (e) {} };
    if (typeof bar.insertBefore === 'function') {
        try { bar.insertBefore(btn, bar.firstChild || null); }   // 第一个子元素：sticky 关闭条才挂在可视顶部
        catch (e) { bar.appendChild(btn); }
    } else {
        bar.appendChild(btn);
    }
    editCloseAttached = true;
}

function toggleClass(cls, force) {
    var b = document.body;
    if (!b || !b.classList) return;
    var on = (typeof force === 'boolean') ? force : !b.classList.contains(cls);
    if (on) b.classList.add(cls); else b.classList.remove(cls);
}

/* --- 「全览」条件出现：视野偏离 LOOP_BBOX 全览位（fitAll 的落点）才亮 ---
   复用防抖链：zoomchange/moveend 后比对 __fitDebug（fitAll 写入 zoom+中心） */
var fitDevTimer = null;
var fitDeviated = false;
function checkFit() {
    if (!mobActive) return;
    var btn = document.getElementById('mobFit');
    if (!btn || !btn.classList) return;
    var fit = null, c = null, z = null;
    try { fit = (typeof window !== 'undefined' && window.__fitDebug) || null; } catch (e) {}
    try { if (typeof map !== 'undefined' && map && typeof map.getCenter === 'function') c = map.getCenter(); } catch (e) {}
    try { if (typeof map !== 'undefined' && map && typeof map.getZoom === 'function') z = map.getZoom(); } catch (e) {}
    var dev = false;
    if (fit && fit.c && c && typeof c.lng === 'number' && typeof c.lat === 'number') {
        var dz = (z == null) ? 0 : Math.abs(z - fit.z);
        var dKm = Math.sqrt(Math.pow(Math.abs(c.lat - fit.c[0]) * 111, 2) +
                            Math.pow(Math.abs(c.lng - fit.c[1]) * 95, 2));
        dev = dz > 0.5 || dKm > 12;
    }
    if (dev !== fitDeviated) {
        fitDeviated = dev;
        btn.classList.toggle('show', dev);
    }
}
function onFitMaybeChanged() {
    if (fitDevTimer) clearTimeout(fitDevTimer);
    fitDevTimer = setTimeout(function () { fitDevTimer = null; checkFit(); }, 150);
}
if (typeof map !== 'undefined' && map && typeof map.on === 'function') {
    try { map.on('zoomchange', onFitMaybeChanged); } catch (e) {}
    try { map.on('moveend', onFitMaybeChanged); } catch (e) {}
}

/* --- 断点跨越：进入移动端应用抽屉态；回到桌面清掉全部移动态 class --- */
function refreshMob() {
    var now = isMobile();
    if (now === mobActive && iaBuilt) return;
    mobActive = now;
    if (!now) {
        var b = document.body;
        if (b && b.classList) {
            b.classList.remove('mob-full'); b.classList.remove('mob-hidden');
            b.classList.remove('mob-elev'); b.classList.remove('mob-drag');
            b.classList.remove('mob-menu'); b.classList.remove('mob-layers');
        }
        if (sheetPanel && sheetPanel.classList) {
            sheetPanel.classList.remove('collapsed');
            if (sheetPanel.style) sheetPanel.style.transform = '';
        }
        var hd = document.getElementById('panelHandle');
        if (hd && hd.classList) hd.classList.remove('show');
        mobRestoreMoved();
        if (iaRoot && iaRoot.style) iaRoot.style.display = 'none';
    } else {
        buildIA();
        if (iaRoot && iaRoot.style) iaRoot.style.display = 'block';
        setSheet(sheetState);
        checkFit();
    }
}

/* 调试钩子（截图/联调）：?mobsheet=full|peek|hidden 强制初始档位 */
var _mobQ = (typeof location !== 'undefined' && location.search) ? location.search : '';
var _mobM = _mobQ.match(/[?&]mobsheet=(full|peek|hidden)/);
if (_mobM) sheetState = _mobM[1];

window.__mobile = {
    isMobile: function () { return mobActive; },
    state: function () { return sheetState; },
    setSheet: setSheet,
    ia: function () { return iaBuilt; },              // S16：信息架构（标题条/菜单/图层弹层/浮动钮）已构建
    checkFit: checkFit,                               // 手动触发「全览」偏离判定（测试用）
    fitDeviated: function () { return fitDeviated; },
    attachEditClose: attachEditClose                  // sync.js 在 editBar 就绪后回补关闭条
};

refreshMob();
if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', refreshMob);
    window.addEventListener('orientationchange', refreshMob);
}
