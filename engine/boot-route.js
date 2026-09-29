/* ============================================================================
 * engine/boot-route.js — 线路页加载序（S9）
 *
 * 由 index.html 的 loader 在 key.local.js 之后 document.write 加载。
 * 职责：读 window.__KEY_LOCAL__ → 注入高德安全密钥 → 按需写底图 SDK →
 *       写线路包 + 引擎。没有可用 Key 时什么都不写（页面只显示 Key 引导遮罩，
 *       不产生半加载状态）。
 * 测试 vm 里没有 document.write，本文件整体安全跳过。
 * ========================================================================== */

(function () {
    if (typeof document === 'undefined' || typeof document.write !== 'function') return;
    if (typeof ROUTE_KEY === 'undefined' || !ROUTE_KEY) return;
    var K = (typeof window !== 'undefined' && window.__KEY_LOCAL__) || {};
    if (K.amapSecurity) {
        // 高德 JS API v2 安全密钥：必须在 SDK 加载前注入
        window._AMapSecurityConfig = { securityJsCode: K.amapSecurity };
    }
    if (K.amapKey) {
        document.write('<script src="https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(K.amapKey) + '"><\/script>');
    }
    document.write('<script src="route-defs/' + ROUTE_KEY + '.js"><\/script>');
    document.write('<script src="engine/map-adapter.js"><\/script>');
    document.write('<script src="engine/route-engine.js"><\/script>');
    document.write('<script src="engine/planner.js"><\/script>');
    document.write('<script src="engine/profile.js"><\/script>');
    document.write('<script src="engine/mobile.js"><\/script>');
    document.write('<script src="engine/edit.js"><\/script>');
    document.write('<script src="engine/sync.js"><\/script>');
    document.write('<script src="engine/ui.js"><\/script>');
})();
