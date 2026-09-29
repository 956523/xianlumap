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

var MOBILE_PEEK = 92;        // peek 露出高度，与 CSS :root{--sheet-peek} 同值；visibleBox 也读它
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
    // 各档位的 translateY：full=0，peek=露出 92，hidden=完全出屏
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

/* --- 断点跨越：进入移动端应用抽屉态；回到桌面清掉全部移动态 class --- */
function refreshMob() {
    var now = isMobile();
    if (now === mobActive) return;
    mobActive = now;
    if (!now) {
        var b = document.body;
        if (b && b.classList) {
            b.classList.remove('mob-full'); b.classList.remove('mob-hidden');
            b.classList.remove('mob-elev'); b.classList.remove('mob-drag');
        }
        if (sheetPanel && sheetPanel.classList) {
            sheetPanel.classList.remove('collapsed');
            if (sheetPanel.style) sheetPanel.style.transform = '';
        }
        var hd = document.getElementById('panelHandle');
        if (hd && hd.classList) hd.classList.remove('show');
    } else {
        setSheet(sheetState);
    }
}

/* 调试钩子（截图/联调）：?mobsheet=full|peek|hidden 强制初始档位 */
var _mobQ = (typeof location !== 'undefined' && location.search) ? location.search : '';
var _mobM = _mobQ.match(/[?&]mobsheet=(full|peek|hidden)/);
if (_mobM) sheetState = _mobM[1];

window.__mobile = {
    isMobile: function () { return mobActive; },
    state: function () { return sheetState; },
    setSheet: setSheet
};

refreshMob();
if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', refreshMob);
    window.addEventListener('orientationchange', refreshMob);
}
