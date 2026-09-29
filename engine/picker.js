/* ============================================================================
 * engine/picker.js — 选线器（S8 多线路入口；S21 视觉重设计）
 *
 * 只在「无 ?route= 参数」的选线器页运行（线路页由 index.html 的 loader 保证
 * 不加载本文件；测试 vm 里 ROUTE_KEY 未定义时也安全退出）。
 * 本页只依赖 ROUTE_MANIFEST（manifest.js）+ HERO_CURVES（hero-curves.js，
 * tools 物化的小数据），不加载任何线路包 / 引擎 / 底图。
 *
 * S21 设计口径（产品负责人批示：克制、编辑级美感，参照 Linear/Arc）：
 *   去 emoji（名称渲染时剥离，不动数据——manifest 与包一致性断言保持）；
 *   一卡一线稿（真实高程抽稀的抽象剖面，单色细线 + 品牌绿 7% 填充）；
 *   灰阶为主，品牌绿只出现在悬停/选中/线稿填充；零渐变、零彩色阴影、圆角 12；
 *   数字是正文不是主角；动效仅 hover 抬 2px + 描边微亮，300ms ease。
 * ========================================================================== */

(function () {
    if (typeof ROUTE_KEY !== 'undefined' && ROUTE_KEY) return;   // 线路页：不做事
    if (typeof CORE !== 'undefined') return;                     // 数据已加载：不做事（双保险）
    if (typeof ROUTE_MANIFEST === 'undefined' || !ROUTE_MANIFEST || !ROUTE_MANIFEST.length) return;

    var INK = '#0f172a', SUB = '#475569', MUTED = '#94a3b8', LINE = '#cbd5e1';
    var BRAND = '#0f766e';
    var stripEmoji = function (s) { return String(s == null ? '' : s).replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?|\u{1F000}-\u{1F0FF}/gu, '').trim(); };

    /* 归一化采样点 → Catmull-Rom 平滑线稿（过点插值，纯视觉） */
    function curvePath(pts) {
        if (!pts || pts.length < 2) return '';
        var W = 100, H = 30, PAD = 2;   // viewBox 0 0 100 34 的内区
        function xy(p) { return [+(p[0] * W).toFixed(2), +(PAD + (1 - p[1]) * H).toFixed(2)]; }
        if (pts.length < 3) return 'M' + xy(pts[0]).join(',') + ' L' + xy(pts[1]).join(',');
        var d = 'M' + xy(pts[0]).join(',');
        for (var i = 0; i < pts.length - 1; i++) {
            var p0 = xy(pts[i - 1] || pts[i]), p1 = xy(pts[i]), p2 = xy(pts[i + 1]), p3 = xy(pts[i + 2] || pts[i + 1]);
            d += ' C' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(2) + ',' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(2) +
                 ' ' + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(2) + ',' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(2) +
                 ' ' + p2[0] + ',' + p2[1];
        }
        return d;
    }
    function heroSVG(key) {
        var c = (typeof HERO_CURVES !== 'undefined' && HERO_CURVES) ? HERO_CURVES[key] : null;
        if (!c || !c.pts || c.pts.length < 2) return '';
        var d = curvePath(c.pts);
        return '<svg class="pick-hero" viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">' +
            '<path d="' + d + ' L100,34 L0,34 Z" fill="rgba(15,118,110,.07)" stroke="none"/>' +
            '<path d="' + d + '" fill="none" stroke="' + LINE + '" stroke-width="1.4" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>';
    }

    var css = document.createElement('style');
    css.textContent =
        '#pickerRoot{position:fixed;inset:0;z-index:2000;overflow:auto;background:#f8fafc;' +
        'font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:' + INK + ';' +
        'display:flex;flex-direction:column;align-items:center;padding:72px 24px 40px;box-sizing:border-box;}' +
        '#pickerRoot .pk-head{display:flex;flex-direction:column;align-items:center;margin-bottom:44px;}' +
        '#pickerRoot h1{font-size:26px;font-weight:700;margin:0;letter-spacing:.32em;text-indent:.32em;color:' + INK + ';}' +
        '#pickerRoot .pk-rule{width:28px;height:2px;background:' + BRAND + ';margin-top:16px;border-radius:1px;}' +
        '#pickerCards{display:grid;gap:20px;width:100%;max-width:960px;' +
        'grid-template-columns:repeat(auto-fit,minmax(260px,1fr));}' +
        '.pick-card{display:block;background:#fff;border-radius:12px;padding:18px 20px 20px;text-decoration:none;' +
        'color:inherit;border:1px solid #e2e8f0;' +
        'transition:transform .3s ease,border-color .3s ease,box-shadow .3s ease;}' +
        '.pick-card:hover{transform:translateY(-2px);border-color:' + BRAND + ';box-shadow:0 6px 16px rgba(15,23,42,.06);}' +
        '.pick-hero{display:block;width:100%;height:88px;margin-bottom:14px;}' +
        '.pick-hero path[stroke]{transition:stroke .3s ease;}' +
        '.pick-card:hover .pick-hero path[stroke]{stroke:' + BRAND + ';}' +
        '.pick-name{font-size:17px;font-weight:600;color:' + INK + ';letter-spacing:.02em;}' +
        '.pick-region{font-size:12px;color:' + MUTED + ';margin-top:3px;letter-spacing:.06em;}' +
        '.pick-meta{font-size:12px;color:' + SUB + ';margin-top:14px;padding-top:12px;border-top:1px solid #f1f5f9;}' +
        '.pick-meta i{font-style:normal;color:#cbd5e1;margin:0 6px;}' +
        '.pick-foot{margin-top:48px;color:' + MUTED + ';font-size:11.5px;letter-spacing:.04em;text-align:center;}' +
        '@media (max-width:640px){' +
        '#pickerRoot{padding:52px 16px 32px;}' +
        '#pickerRoot h1{font-size:21px;}' +
        '#pickerRoot .pk-head{margin-bottom:32px;}' +
        '.pick-hero{height:72px;}' +
        '}';
    (document.head || document.documentElement).appendChild(css);

    var root = document.createElement('div');
    root.id = 'pickerRoot';
    var cards = ROUTE_MANIFEST.map(function (r) {
        return '<a class="pick-card" href="?route=' + encodeURIComponent(r.id) + '">' +
            heroSVG(r.id) +
            '<div class="pick-name">' + stripEmoji(r.name) + '</div>' +
            '<div class="pick-region">' + r.region + '</div>' +
            '<div class="pick-meta">' + r.totalKm + ' km<i>·</i>建议 ' + r.days + ' 天' +
            (r.updatedAt ? '<i>·</i>更新 ' + r.updatedAt.slice(5) : '') + '</div>' +
            '</a>';
    }).join('');
    root.innerHTML =
        '<div class="pk-head"><h1>自驾线路图</h1><div class="pk-rule"></div></div>' +
        '<div id="pickerCards">' + cards + '</div>' +
        '<div class="pick-foot">页面数据全部内联 · 打开即全量</div>';
    document.body.appendChild(root);
})();
