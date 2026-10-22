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

var MOBILE_PEEK = 216;       // S36：peek 露出高度（手柄28 + peek hero 大卡），与 CSS --sheet-peek 同值
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
        b.classList.remove('mob-peek');   // S34：peek 态由 mob-peek 驱动（其余档先清）
        b.classList.toggle('mob-full', st === 'full');
        b.classList.toggle('mob-half', st === 'half');   // S29：半屏编辑态
        b.classList.toggle('mob-hidden', st === 'hidden');
        if (st === 'peek') b.classList.add('mob-peek');   // S34：peek 瘦身（只露概要盒+手柄）
    }
    // 行程单露出高度 → CSS 变量：地图容器缩短、剖面把手贴其下沿（两张表叠放）
    var root = document.documentElement;
    if (root && root.style && typeof root.style.setProperty === 'function') {
        root.style.setProperty('--sheet-visible', (st === 'peek' ? MOBILE_PEEK : (st === 'half' ? Math.round(window.innerHeight * 0.52) : 0)) + 'px');
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
var sheetDrag = null;

function sheetBase(panelH, st) {
    // 各档位的 translateY：full=0，half=露上半屏地图（S29 编辑半屏化），peek=露出 MOBILE_PEEK，hidden=完全出屏
    if (st === 'full') return 0;
    if (st === 'half') return Math.max(0, panelH - Math.round(window.innerHeight * 0.52));
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
    sheetDrag = { y0: t.clientY, h: h, lastY: t.clientY, lastT: sheetNow(), vy: 0, moved: false, st0: sheetState };
    if (document.body && document.body.classList) document.body.classList.add('mob-drag');  // 跟手：关过渡
}

function onSheetMove(e) {
    if (!sheetDrag) return;
    var t = e.touches && e.touches[0];
    if (!t) return;
    var nowT = sheetNow();
    var dt = Math.max(1, nowT - sheetDrag.lastT);
    sheetDrag.vy = (sheetDrag.lastY - t.clientY) / dt;   // 上滑为正，px/ms
    sheetDrag.lastY = t.clientY; sheetDrag.lastT = nowT;
    var dy = sheetDrag.y0 - t.clientY;
    if (!sheetDrag.moved && Math.abs(dy) < 6) return;   // 6px 死区：先不判滑动，保住标题行里的按钮点击
    sheetDrag.moved = true;
    if (e.cancelable && typeof e.preventDefault === 'function') e.preventDefault();
    var hN = (isFinite(sheetDrag.h) && sheetDrag.h > 0) ? sheetDrag.h : 1;   // S20：NaN/0 护栏，防 ty 越界
    var ty = Math.max(0, Math.min(hN, sheetBase(hN, sheetDrag.st0) - dy));
    if (!isFinite(ty)) return;
    sheetDrag.ty = ty;
    if (sheetPanel && sheetPanel.style) sheetPanel.style.transform = 'translateY(' + ty + 'px)';
}

function onSheetEnd() {
    if (!sheetDrag) return;
    var d = sheetDrag; sheetDrag = null;
    sheetSettle();   // S20 白屏护栏：inline transform 清零 + mob-drag 移除（状态机只认三态）
    if (!d.moved) {
        // 轻点手柄：peek ↔ full（hidden 点手柄 = 展开）
        setSheet(d.st0 === 'full' ? 'peek' : 'full');
        return;
    }
    var h = (isFinite(d.h) && d.h > 0) ? d.h : 1;
    var ty = (typeof d.ty === 'number' && isFinite(d.ty)) ? d.ty : sheetBase(h, d.st0);
    var target;
    if (d.vy > 0.45) target = 'full';                                  // 快速上滑：直接全展
    else if (d.vy < -0.45) target = (ty > h - MOBILE_PEEK * 0.5) ? 'hidden' : 'peek';
    else {
        // 按最近档位 snap（途经点 Tab 半屏态把 half 加进候选，S29）
        var cands = ['full', 'peek', 'hidden', 'half'];   // S32：半屏常候选（统一视图，不再限途经点 Tab）
        var best = cands[0], bd2 = Infinity;
        cands.forEach(function (c) { var dd = Math.abs(ty - sheetBase(h, c)); if (dd < bd2) { bd2 = dd; best = c; } });
        target = best;
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

/* --- S18：抽屉内容滚动与 snap 手势的边界 ---
   full 态下手柄/标题行照旧驱动 snap（上面的绑定）；日卡列表区原生滚动优先，
   唯一接管场景：内容已滚到顶、继续下拉 → 接管为抽屉下拉（商业地图惯例），
   松手按既有阈值 snap。把手区域的 touchstart 先冒泡到子元素并把 sheetDrag 置位，
   这里以 sheetDrag 非空识别并跳过，两边不抢。 */
var scrollTake = null;
function onPanelScrollStart(e) {
    if (!mobActive || sheetState !== 'full' || sheetDrag) return;
    var t = e.touches && e.touches[0];
    if (!t || !sheetPanel) return;
    scrollTake = { y0: t.clientY, active: false, top0: sheetPanel.scrollTop || 0 };
}
function onPanelScrollMove(e) {
    if (!scrollTake) return;
    var t = e.touches && e.touches[0];
    if (!t) return;
    if (!scrollTake.active) {
        if (!(scrollTake.top0 <= 0 && scrollTake.y0 - t.clientY < -8)) return;   // 未到顶部或不是下拉：原生滚动继续
        scrollTake.active = true;
        try { sheetPanel.scrollTop = 0; } catch (e) {}   // S20：清掉原生滚动/橡皮筋状态，避免与 transform 叠加把面板拽出视口
        sheetDrag = { y0: t.clientY, h: sheetPanel.offsetHeight || 1, lastY: t.clientY, lastT: sheetNow(), vy: 0, moved: true, st0: 'full' };
        if (document.body && document.body.classList) document.body.classList.add('mob-drag');
    }
    onSheetMove(e);   // 复用既有跟手 + preventDefault（passive:false 才能拦下原生滚动）
}
function onPanelScrollEnd() {
    if (!scrollTake) return;
    var was = scrollTake.active;
    scrollTake = null;
    if (was) onSheetEnd();
    sheetSettle();
}
/* S20 Bug1②白屏护栏：复现路径=抽屉全展→内容滚到顶→下拉（接管为抽屉手势）→松手。
   真机上原生橡皮筋与 transform 叠加可能把面板拽出视口且状态机落出三态——
   松手后 inline transform 一律清零交还 body class，mob-drag 强制移除，
   状态机只承认 peek/full/hidden。任何越界都在此处归位。 */
function sheetSettle() {
    if (sheetPanel && sheetPanel.style) sheetPanel.style.transform = '';
    if (document.body && document.body.classList) document.body.classList.remove('mob-drag');
}
if (sheetPanel && typeof sheetPanel.addEventListener === 'function') {
    sheetPanel.addEventListener('touchstart', onPanelScrollStart, { passive: true });
    sheetPanel.addEventListener('touchmove', onPanelScrollMove, { passive: false });
    sheetPanel.addEventListener('touchend', onPanelScrollEnd);
    sheetPanel.addEventListener('touchcancel', onPanelScrollEnd);
}

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
 *   #mobBar   常驻标题条：Logo + 线路名 + 规划/行中模式开关 + ⋯菜单（S34 一行化）
 *   #mobCtl   抽屉头部控制行：出发地切换 + 顺/逆 + 车型（full 态才见；peek 被 CSS 边界隐藏）
 *   #mobMenu  ⋯菜单：添加途经点 / 云同步 / 数据来源说明
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
    /* S24：标题条左端品牌记号（与侧栏/首页一家人） */
    var bm = mobEl('span', 'mobBrandMark');
    if (typeof BRAND !== 'undefined') bm.innerHTML = BRAND.mark;
    bar.appendChild(bm);
    var _rn = (typeof ROUTE_META !== 'undefined' && ROUTE_META && ROUTE_META.name) || '线路';
    bar.appendChild(mobEl('b', 'mobRouteName', null,
        (typeof BRAND !== 'undefined' && BRAND.stripEmoji) ? BRAND.stripEmoji(_rn) : _rn));   // S24 去 emoji
    /* S34 标题条一行化：只剩 Logo + 线路名 + 规划/行中模式开关 + ⋯；
       出发地/车型/顺逆全部收进抽屉头部控制行 #mobCtl（full 态才见） */
    var mode = mobEl('span', 'mobMode');
    mode.appendChild(mobEl('button', 'mobModePlan', 'on', '规划'));
    mode.appendChild(mobEl('button', 'mobModeEnr', null, '行中'));
    bar.appendChild(mode);
    bar.appendChild(mobEl('button', 'mobMenuBtn', null, '⋯'));
    iaRoot.appendChild(bar);

    /* ⋯菜单 + 遮罩（S18：点外部关闭，对齐图层弹层） */
    var menu = mobEl('div', 'mobMenu');
    menu.appendChild(mobEl('button', 'mobMenuEdit', null, '➕ 添加途经点'));
    menu.appendChild(mobEl('button', 'mobMenuSync', null, '☁️ 云同步'));
    menu.appendChild(mobEl('button', 'mobMenuData', null, 'ℹ️ 数据来源说明'));
    iaRoot.appendChild(menu);
    var menuBk = mobEl('div', 'mobMenuBk');
    iaRoot.appendChild(menuBk);

    /* S26 移动端规划详情面板（摘要行点开，内容镜像 planBox） */
    var planBk = mobEl('div', 'mobPlanBk');
    var planPanel = mobEl('div', 'mobPlan');
    var planHead = mobEl('div', null, 'ml-head');
    planHead.appendChild(mobEl('span', null, null, '🔋 续航规划'));
    planHead.appendChild(mobEl('button', 'mobPlanClose', null, '✕'));
    planPanel.appendChild(planHead);
    planPanel.appendChild(mobEl('div', 'mobPlanBody'));
    iaRoot.appendChild(planBk);
    iaRoot.appendChild(planPanel);

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
    /* S36 补给悬浮钮（唯一补给入口）：BRAND.supply 图标 + 「补给」，排在 图层/全览 之后 */
    var supIc = (typeof BRAND !== 'undefined' && BRAND.supply) ? BRAND.supply : '';
    btns.appendChild(mobEl('button', 'mobSup', null, '<span class="msup-ic">' + supIc + '</span>补给'));
    iaRoot.appendChild(btns);

    if (document.body && typeof document.body.appendChild === 'function') document.body.appendChild(iaRoot);

    /* peek 概要行：插到手柄之后（planner.renderPlanPanel 会喂它数据） */
    iaPeek = mobEl('div', 'planPeek');
    if (sheetPanel && typeof sheetPanel.insertBefore === 'function' && sheetGrip) {
        try { sheetPanel.insertBefore(iaPeek, sheetGrip.nextSibling); } catch (e) {}
    }

    /* 迁移：出发地切换 → 标题条；图例 + 续航卡 → 图层弹层（原事件随节点走） */
    /* S34 控制行：出发地 + 顺/逆 + 车型（抽屉头部第二行；peek 态被 CSS 边界隐藏） */
    /* S35 删号：车型切换整体下线（补给点分类覆盖）——evsw 不再创建 */
    var _panel = document.getElementById('panel');
    if (_panel && _panel.insertBefore) {
        var _ctl = mobEl('div', 'mobCtl');
        _panel.insertBefore(_ctl, _panel.firstChild ? _panel.firstChild.nextSibling : null);
        mobMove(document.getElementById('startSeg'), _ctl);
        mobMove(document.getElementById('dirSeg'), _ctl);   // S33 逆行切换
        /* S35：mobCtl 只收出发地/顺逆（车型已下线） */
    }
    /* 车型开关：代理点击隐藏的真实按钮（planner 的 handler 原样复用） */
    /* S35：车型代理按钮随删号下线 */
    var lb = document.getElementById('mobLayersBody');
    mobMove(document.getElementById('legendBox'), lb);
    mobMove(document.querySelector ? document.querySelector('.evcard') : null, lb);

    attachEditClose();

    /* 菜单 */
    var menuBtn = document.getElementById('mobMenuBtn');
    if (menuBtn) menuBtn.onclick = function () {
        toggleClass('mob-menu');
        if (document.body.classList.contains('mob-menu')) {
            toggleClass('mob-layers', false);   // S22：两弹层互斥
            try { if (window.__sup && window.__sup.close) window.__sup.close(); } catch (e) {}   // S36：补给抽屉同互斥
        }
    };
    /* S34 模式开关：规划 ↔ 行中（Enroute 挂在 window 上，enroute.js 导出方式） */
    var mPlan = document.getElementById('mobModePlan');
    var mEnr = document.getElementById('mobModeEnr');
    function enrApi() { return (typeof window !== 'undefined' && window.Enroute) ? window.Enroute : (typeof Enroute !== 'undefined' ? Enroute : null); }
    function syncModeSeg() {
        var E = enrApi();
        var on = false;
        try { on = !!(E && E.isOn && E.isOn()); } catch (e) {}
        if (mPlan && mPlan.classList) mPlan.classList.toggle('on', !on);
        if (mEnr && mEnr.classList) mEnr.classList.toggle('on', on);
    }
    if (mEnr) mEnr.onclick = function () {
        try { var E = enrApi(); if (E && E.enter) E.enter(); } catch (e) {}
        syncModeSeg();
    };
    if (mPlan) mPlan.onclick = function () {
        try { var E2 = enrApi(); if (E2 && E2.exit) E2.exit(); } catch (e) {}
        syncModeSeg();
    };
    syncModeSeg();
    var menuBkEl = document.getElementById('mobMenuBk');   // 遮罩经 getElementById 接线（mock 可断言）
    if (menuBkEl) menuBkEl.onclick = function () { toggleClass('mob-menu', false); };
    var mEdit = document.getElementById('mobMenuEdit');
    if (mEdit) mEdit.onclick = function () {
        toggleClass('mob-menu', false);
        /* S34：wpSec 管理区退役——「添加途经点」直接打开「添加停靠点」对话框
           （搜索/类型选择都在对话框里；__wpStop 桥在 edit.js 模块级） */
        try { if (window.__wpStop && typeof window.__wpStop.open === 'function') window.__wpStop.open(null, null, ''); } catch (e) {}
        try { if (typeof Edit !== 'undefined' && Edit.showTab) Edit.showTab('wp'); } catch (e) {}
    };
    var mSync = document.getElementById('mobMenuSync');
    if (mSync) mSync.onclick = function () {
        toggleClass('mob-menu', false);
        try { if (typeof Edit !== 'undefined' && Edit.showTab) Edit.showTab('more'); } catch (e) {}   // S28：云同步在 ⋯ 更多设置页
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
    if (layersBtn) layersBtn.onclick = function () {
        openBk();
        if (document.body.classList.contains('mob-layers')) {
            toggleClass('mob-menu', false);   // S22：两弹层互斥
            try { if (window.__sup && window.__sup.close) window.__sup.close(); } catch (e) {}   // S36：补给抽屉同互斥
        }
    };
    var layersClose = document.getElementById('mobLayersClose');
    if (layersClose) layersClose.onclick = function () { toggleClass('mob-layers', false); };

    /* 全览条件按钮 → 统一入口 goFit（S25） */
    /* S26：peek 摘要行点开规划面板 */
    function openPlanPanel() {
        var body = document.getElementById('mobPlanBody');
        var src = document.getElementById('planBox');
        if (body && src) {
            body.innerHTML = src.innerHTML +
                '<div class="note">口径与侧栏一致：按当前车型/续航/高原折算实时计算；' +
                '路线轨迹与站点分级以已保存版本的数据为准，出行前请复核营业状态。</div>';
        }
        try { if (window.__sup && window.__sup.close) window.__sup.close(); } catch (e) {}   // S36：补给抽屉同互斥
        toggleClass('mob-plan', true);
    }
    var planPeekEl = document.getElementById('planPeek');
    if (planPeekEl && typeof planPeekEl.onclick !== 'undefined') planPeekEl.onclick = openPlanPanel;
    var planBkEl = document.getElementById('mobPlanBk');
    if (planBkEl) planBkEl.onclick = function () { toggleClass('mob-plan', false); };
    var planClose = document.getElementById('mobPlanClose');
    if (planClose) planClose.onclick = function () { toggleClass('mob-plan', false); };

    var fitBtn = document.getElementById('mobFit');
    if (fitBtn) fitBtn.onclick = function () {
        if (fitBtn.classList) fitBtn.classList.add('hit');   // S23：按下即时反馈（感知响应）
        setTimeout(function () { if (fitBtn.classList) fitFitRemove(); }, 220);
        goFit();
    };
    function fitFitRemove() { if (fitBtn && fitBtn.classList) fitBtn.classList.remove('hit'); }

    /* S36 补给钮（屏四）：开/关沿线补给抽屉（window.__sup，engine/supply.js）。
       __sup 不在（极端环境）退回 AB 阶段空壳语义：toggle mob-sup + 尝试 __supOpen */
    var supBtn = document.getElementById('mobSup');
    if (supBtn) supBtn.onclick = function () {
        var S = null;
        try { S = (typeof window !== 'undefined' && window.__sup) || null; } catch (e) {}
        try {
            if (S && typeof S.isOpen === 'function') {
                if (S.isOpen()) S.close();
                else S.open();
                return;
            }
        } catch (e) {}
        toggleClass('mob-sup');
        try {
            if (typeof window !== 'undefined' && window.__supOpen && typeof window.__supOpen === 'function') window.__supOpen();
        } catch (e) {}
    };
}

/* S19 退役：编辑面板自带「‹ 完成编辑」顶栏（etDone），不再需要外挂关闭条。
   保留 no-op 以兼容 sync.js 的既有调用。 */
function attachEditClose() { editCloseAttached = true; }

function toggleClass(cls, force) {
    var b = document.body;
    if (!b || !b.classList) return;
    var on = (typeof force === 'boolean') ? force : !b.classList.contains(cls);
    if (on) b.classList.add(cls); else b.classList.remove(cls);
}

/* S23：包住全局 fitAll——任何来源（resize 链/出发地切换/全览钮）全览完成后，
   在动画中段与收尾各复检一次按钮显示态，杜绝「视图已回全览但钮还亮着」的存量竞态。 */
var _origFitAll2 = (typeof fitAll === 'function') ? fitAll : null;
if (_origFitAll2) {
    fitAll = function (redraw) {
        _origFitAll2(redraw);
        setTimeout(checkFit, 420);
        setTimeout(checkFit, 950);
    };
}

/* --- 「全览」条件出现：视野矩形 vs 环线包围盒的真实几何包含（S18 升级版） ---
   判定口径：LOOP_BBOX 任一侧超出当前视野的比例 outFrac（0=完全包含）。
   滞回防抖动：亮钮阈值 1%、灭钮阈值 0.3%（进出不同，卡在中间的抖动不会翻转状态）。
   map.getBounds 不可用时（老适配/mock）退回 S16 的 Δz/中心距近似。 */
var fitDevTimer = null;
var fitDeviated = false;
var FIT_ENTER_FRAC = 0.01, FIT_EXIT_FRAC = 0.003;   // 滞回：亮钮 1% / 灭钮 0.3%（占包围盒跨度比例）
function viewBounds() {
    try {
        if (typeof map !== 'undefined' && map && typeof map.getBounds === 'function') {
            var b = map.getBounds();
            if (b && b.southWest && b.northEast &&
                typeof b.southWest.lng === 'number' && typeof b.northEast.lng === 'number') {
                return { lngMin: b.southWest.lng, latMin: b.southWest.lat, lngMax: b.northEast.lng, latMax: b.northEast.lat };
            }
        }
    } catch (e) {}
    return null;
}
function loopBBox() {
    try {
        if (typeof LOOP_BBOX !== 'undefined' && LOOP_BBOX && typeof STARTS !== 'undefined' && STARTS && STARTS.length) {
            var k = (typeof start !== 'undefined' && LOOP_BBOX[start]) ? start : STARTS[0].id;
            var b = LOOP_BBOX[k] || LOOP_BBOX[STARTS[0].id];
            if (b && typeof b.lngMin === 'number') return b;
        }
    } catch (e) {}
    return null;
}
function checkFit() {
    if (!mobActive) return;
    var btn = document.getElementById('mobFit');
    if (!btn || !btn.classList) return;
    var vb = viewBounds(), lb = loopBBox();
    var dev;
    if (vb && lb) {
        // 视野必须【盖住】包围盒：盒伸出视野的量（占盒跨度比例），全可见 = 0
        var overLng = Math.max(0, vb.lngMin - lb.lngMin, lb.lngMax - vb.lngMax) / ((lb.lngMax - lb.lngMin) || 1);
        var overLat = Math.max(0, vb.latMin - lb.latMin, lb.latMax - vb.latMax) / ((lb.latMax - lb.latMin) || 1);
        var outFrac = Math.max(overLng, overLat);
        try { window.__fitOut = outFrac; } catch (e) {}
        /* S22 修正：AMap 的 getBounds 按整数 zoom 给视野，fitAll 的落点是分数 zoom——
           窄屏上「刚全览完」整数视野可能比真实视野小一圈，几何判定误报偏离、
           全览钮卡亮。加 nearFit 快路径：zoom/中心都在 fitAll 目标附近时直接判回位。 */
        var nearFit = false;
        var fitDbg = null, cz = null, cc = null;
        try { fitDbg = window.__fitDebug || null; } catch (e) {}
        try { if (typeof map.getZoom === 'function') cz = map.getZoom(); } catch (e) {}
        try { if (typeof map.getCenter === 'function') cc = map.getCenter(); } catch (e) {}
        if (fitDbg && fitDbg.c && cc && typeof cc.lng === 'number' && cz != null) {
            nearFit = Math.abs(cz - fitDbg.z) <= 0.8 &&
                Math.abs(cc.lat - fitDbg.c[0]) * 111 < 8 &&
                Math.abs(cc.lng - fitDbg.c[1]) * 95 < 8;
        }
        dev = nearFit ? false
            : (fitDeviated ? (outFrac > FIT_EXIT_FRAC) : (outFrac > FIT_ENTER_FRAC));   // 滞回
    } else {
        // —— 近似回退（无 getBounds）：Δz/中心距阈值 ——
        var fit = null, c = null, z = null;
        try { fit = (typeof window !== 'undefined' && window.__fitDebug) || null; } catch (e) {}
        try { if (typeof map !== 'undefined' && map && typeof map.getCenter === 'function') c = map.getCenter(); } catch (e) {}
        try { if (typeof map !== 'undefined' && map && typeof map.getZoom === 'function') z = map.getZoom(); } catch (e) {}
        dev = false;
        if (fit && fit.c && c && typeof c.lng === 'number' && typeof c.lat === 'number') {
            var dz = (z == null) ? 0 : Math.abs(z - fit.z);
            var dKm = Math.sqrt(Math.pow(Math.abs(c.lat - fit.c[0]) * 111, 2) +
                                Math.pow(Math.abs(c.lng - fit.c[1]) * 95, 2));
            dev = dz > 0.5 || dKm > 12;
        }
    }
    fitDeviated = dev;
    btn.classList.toggle('show', dev);   // S23：无条件对账，show class 与判定永不发散
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
            b.classList.remove('mob-full'); b.classList.remove('mob-half'); b.classList.remove('mob-hidden');
            b.classList.remove('mob-elev'); b.classList.remove('mob-drag'); b.classList.remove('mob-peek');
            b.classList.remove('mob-menu'); b.classList.remove('mob-layers'); b.classList.remove('mob-sup');
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

/* S25 全览唯一入口：无条件飞到全线 + 移动端收起抽屉（让飞行可见）。
   「已全览则忽略」类守卫一律不要——重复动画也比死点击好。
   抽屉内「回到全览」(#btnFit) 与浮动「全览」(#mobFit) 同走此入口。 */
function goFit() {
    try { if (typeof fitAll === 'function') fitAll(); } catch (e) {}
    if (mobActive && typeof setSheet === 'function') setSheet('peek');
}
var _btnFitEl = document.getElementById('btnFit');
if (_btnFitEl && typeof _btnFitEl.onclick !== 'undefined') _btnFitEl.onclick = goFit;

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
    attachEditClose: attachEditClose,                // S19 起为 no-op（编辑面板顶栏自带完成按钮）
    sheetSettle: sheetSettle                          // S20 白屏护栏：transform 越界强制归位（测试用）
};

refreshMob();
if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', refreshMob);
    window.addEventListener('orientationchange', refreshMob);
}
