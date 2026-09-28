/* ============================================================================
 * engine/ui.js — 侧栏元信息注入 / 展示文案 / 启动序列
 *
 * 平台化 S2 从 index.html 主脚本拆分而来：
 *   - 所有展示层文案（标题/副标题/方向注记/纯电提示/能耗教育）由数据包
 *     ROUTE_META 驱动；数据包未给能耗文案时用不写地名的通用版
 *   - 启动序列放最后一个文件，保证 route-engine/planner/profile 的全局定义就绪
 * 依赖：数据包 + engine/route-engine.js + engine/planner.js + engine/profile.js 均已加载。
 * ========================================================================== */

    /* ============ 线路元信息（由数据包 ROUTE_META 驱动，引擎不写死线路名） ============
       数据包必须定义 ROUTE_META（见 route-defs/<route>.js 头部说明）；
       缺省时保持页面静态文案，不抛错。 */
    if (typeof ROUTE_META !== 'undefined') {
        document.title = ROUTE_META.title || document.title;
        var rnEl = document.getElementById('routeName');
        if (rnEl && ROUTE_META.name) rnEl.textContent = ROUTE_META.name;
        var rsEl = document.getElementById('routeSub');
        if (rsEl && ROUTE_META.sub) rsEl.textContent = ROUTE_META.sub;
        var ntEl = document.getElementById('evNotice');
        if (ntEl) {
            if (ROUTE_META.evNotice) {
                var ntSp = ntEl.querySelector('span');
                if (ntSp) ntSp.innerHTML = '⚡ <b>纯电提示：</b>' + ROUTE_META.evNotice;
            } else {
                ntEl.remove(); // 数据包未给提示时不展示旧线路的提示
            }
        }
        // 主路线方向注记（图例右侧小字）：随数据包，缺省用通用措辞
        var dirEl = document.getElementById('dirNote');
        if (dirEl) dirEl.textContent = ROUTE_META.direction || '沿线方向';
    }

    /* ============ 能耗教育文案（S2：随数据包 ROUTE_META.rulesClimb/rulesEnv） ============
       数据包未给时回落到【不写地名】的通用版 —— 通用高原/能耗知识对所有线路成立，
       但举例不许出现任何具体线路的地名叙述。 */
    var RULES_GENERIC = {
        climb: '① 爬升：每爬 <b>1000m</b> 约多耗 <b>4–5 度电</b>（1.5–2 吨级电车）；<br>' +
               '② 下坡：动能回收拿回 <b>30–50%</b>，长下坡接近"发电"；<br>' +
               '③ 参考：本线单日最大爬升见剖面标题。',
        env:   '① 高原低温：早晚电池活性下降，续航按 <b>8 折</b>估；<br>' +
               '② 风：开阔地带顶风 <b>+10~20%</b>，横风需握稳方向；<br>' +
               '③ 油车：自吸高反动力 <b>−15%</b>（涡轮车基本无感）；<br>' +
               '④ 长下坡：挂低挡用发动机制动，防刹车热衰减。'
    };
    (function applyRulesCopy() {
        var meta = (typeof ROUTE_META !== 'undefined') ? ROUTE_META : {};
        var rc = document.getElementById('rulesClimb');
        var re = document.getElementById('rulesEnv');
        if (rc) rc.querySelector('.rbody').innerHTML = meta.rulesClimb || RULES_GENERIC.climb;
        if (re) re.querySelector('.rbody').innerHTML = meta.rulesEnv || RULES_GENERIC.env;
    })();

    /* ============ 数据可信度声明（S4）：站点快照日期 + 截断透出 ============
       全部来自 STATION_DATA：builtAt（快照日期）、truncated（分页截断清单）。
       「截断」指城区 POI 数量超单区抓取上限被截断的部分——如实提示，不假装抓全。 */
    (function applyDataCaveat() {
        var el = document.getElementById('dataCaveat');
        if (!el || typeof STATION_DATA === 'undefined' || !STATION_DATA) return;
        var txt = '';
        if (STATION_DATA.builtAt) {
            txt = '站点为 ' + STATION_DATA.builtAt + ' 时点快照，出行前请用地图 App 复核营业状态。';
        }
        if (STATION_DATA.truncated && STATION_DATA.truncated.length) {
            txt += '其中 ' + STATION_DATA.truncated.length + ' 个城区数据量大被截断，城郊可能不全。';
        }
        if (txt) el.textContent = txt;
    })();

    /* ============ 启动 ============ */
    /* 顺序很重要：
       1) 先把抽屉占用高度写进 CSS 变量，让 #map 拿到最终高度；
       2) 再通知地图按最终尺寸定尺（此时 100vh 才是稳定的）；
       3) 最后 fitAll 算视角。
       以前是 renderAll()(内含 fitAll) 先跑、syncMapOccupy() 后跑，
       导致地图按"尚未扣掉抽屉"的高度初始化 → 画布比实际小，
       窄视口下表现为【地图只画了上半屏，下半屏一片空白】。 */
    setDrawerH(drawerH);   // 初始化抽屉高度变量（收起态不动画）
    syncMapOccupy();       // 收起态也让出 peek 高度，地图不被手柄压住
    renderAll();           // 内部会调 fitAll()，此时尺寸已稳定
    bindEvCard();

    /* 兜底：字体/滚动条/移动端地址栏收起等会让 100vh 在首帧之后再变一次，
       此时 #map 尺寸也变，ResizeObserver 会触发；但个别环境（无头浏览器、
       页面在后台标签打开）不派发 ResizeObserver，故再显式定尺一次。 */
    function forceMapResize() {
        if (typeof map.resize === 'function') { try { map.resize(); } catch (e) {} }
        if (activeIdx < 0) fitAll(false);
    }
    setTimeout(forceMapResize, 260);
    window.addEventListener('load', function () { setTimeout(forceMapResize, 120); });
