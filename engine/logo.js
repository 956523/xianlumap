/* ============================================================================
 * engine/logo.js — 品牌记号与线性图标（S24，方案 A「山海一线」定稿）
 *
 * 记号：三笔——山（折线）、海（两道波）、一条路（山的走势即路）。currentColor 着色，
 * 默认墨 #0f172a，功能场景用品牌绿（CSS 控色）。
 * bolt/pump：电车/油车切换的极简线性图标（替换 ⚡⛽ emoji）。
 * 加载：线路页 boot 链首 + 选线器分支（picker.js / mobile.js 依赖 BRAND 全局）。
 * ========================================================================== */

var BRAND = {
    /* 山海一线（48 盒，三笔） */
    mark: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M5 27 L15 12 L22 21 L29 8 L37 19 L43 27"/>' +
        '<path d="M9 33 q4.5 -3.5 9 0 t9 0 t9 0 t9 0"/>' +
        '<path d="M13 39 q4.5 -3.5 9 0 t9 0"/>' +
        '</svg>',
    /* 闪电（电车） */
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M13 2 L6 13 h5 l-2 9 8-11 h-5 z"/>' +
        '</svg>',
    /* 油枪（油车） */
    pump: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M6 21 V10 a2 2 0 0 1 2-2 h4 a2 2 0 0 1 2 2 v11"/>' +
        '<path d="M4 21 h12"/>' +
        '<path d="M14 13 h2 a3 3 0 0 1 3 3 v2.5 a2 2 0 0 1-4 0 V16"/>' +
        '<path d="M8 8.5 h4"/>' +
        '</svg>',
    /* 渲染层 emoji 剥离（不动数据：manifest/包一致性断言不受影响） */
    stripEmoji: function (s) {
        return String(s == null ? '' : s).replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?|\u{1F000}-\u{1F0FF}/gu, '').trim();
    }
};
