/* ============================================================================
 * engine/picker.js — 选线器（S8，多线路入口）
 *
 * 只在「无 ?route= 参数」的选线器页运行（线路页由 index.html 的 loader 保证
 * 不加载本文件；测试 vm 里 ROUTE_KEY 未定义时也安全退出）。
 * 本页只依赖 ROUTE_MANIFEST（manifest.js），不加载任何线路包 / 引擎 / 底图。
 * ========================================================================== */

(function () {
    if (typeof ROUTE_KEY !== 'undefined' && ROUTE_KEY) return;   // 线路页：不做事
    if (typeof CORE !== 'undefined') return;                     // 数据已加载：不做事（双保险）
    if (typeof ROUTE_MANIFEST === 'undefined' || !ROUTE_MANIFEST || !ROUTE_MANIFEST.length) return;

    var css = document.createElement('style');
    css.textContent =
        '#pickerRoot{position:fixed;inset:0;z-index:2000;overflow:auto;' +
        'background:linear-gradient(160deg,#f0fdfa,#e2e8f0 60%,#fef3c7);' +
        'font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#1f2937;' +
        'display:flex;flex-direction:column;align-items:center;padding:48px 20px;box-sizing:border-box;}' +
        '#pickerRoot h1{font-size:24px;margin:0;letter-spacing:1px;}' +
        '#pickerRoot .sub{color:#64748b;font-size:13px;margin:8px 0 30px;}' +
        '#pickerCards{display:grid;gap:16px;width:100%;max-width:860px;' +
        'grid-template-columns:repeat(auto-fit,minmax(240px,1fr));}' +
        '.pick-card{display:block;background:#fff;border-radius:16px;padding:20px 22px;text-decoration:none;' +
        'color:inherit;border:1px solid #e2e8f0;box-shadow:0 6px 24px rgba(15,23,42,.08);' +
        'transition:transform .15s,box-shadow .15s;}' +
        '.pick-card:hover{transform:translateY(-3px);box-shadow:0 12px 32px rgba(15,23,42,.14);border-color:#0d9488;}' +
        '.pick-card b{font-size:17px;color:#0f172a;display:flex;justify-content:space-between;align-items:center;gap:8px;}' +
        '.pick-tag{font-size:10px;font-weight:400;color:#b45309;background:#fffbeb;border:1px solid #fcd34d;' +
        'border-radius:8px;padding:1px 7px;flex:none;}' +
        '.pick-region{font-size:12px;color:#0d9488;margin-top:4px;font-weight:600;}' +
        '.pick-meta{font-size:12px;color:#64748b;margin-top:12px;line-height:1.8;}' +
        '.pick-meta b{color:#0f766e;font-size:15px;}' +
        '.pick-foot{margin-top:34px;color:#94a3b8;font-size:11.5px;line-height:1.8;text-align:center;max-width:560px;}';
    (document.head || document.documentElement).appendChild(css);

    var root = document.createElement('div');
    root.id = 'pickerRoot';
    var cards = ROUTE_MANIFEST.map(function (r) {
        return '<a class="pick-card" href="?route=' + encodeURIComponent(r.id) + '">' +
            '<b>' + r.name + (r.probe ? '<span class="pick-tag">探针包</span>' : '') + '</b>' +
            '<div class="pick-region">' + r.region + '</div>' +
            '<div class="pick-meta">全程约 <b>' + r.totalKm + '</b> km · 建议 <b>' + r.days + '</b> 天' +
            (r.updatedAt ? '<br>站点数据更新于 ' + r.updatedAt : '') + '</div>' +
            '</a>';
    }).join('');
    root.innerHTML =
        '<h1>自驾线路图</h1>' +
        '<div class="sub">路线 · 海拔 · 补能 · 续航，一屏看全 —— 选一条线开始</div>' +
        '<div id="pickerCards">' + cards + '</div>' +
        '<div class="pick-foot">页面数据全部内联（真实轨迹/高程/站点），打开即全量，无需登录。<br>' +
        '侧栏「✏️ 编辑模式」可改文案/分段并导出分享；站点为整理时点快照，出行前请用地图 App 复核。</div>';
    document.body.appendChild(root);
})();
