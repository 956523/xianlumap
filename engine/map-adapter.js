/* ============================================================================
 * engine/map-adapter.js — 高德地图 JS API v2 适配层（S9：TMap → AMap）
 *
 * 引擎对图层的用法是「整层重建 + 开关显隐 + 点击回查处」，与厂商无关。
 * 这里把高德原语（Marker/Text/Polyline/InfoWindow）封装成引擎惯用的 layer 接口
 * （setMap / on），引擎逻辑层不做厂商分支；测试 mock 只需对齐本文件用到的 AMap 形状。
 *
 * 厂商差异适配（注释留痕）：
 * - 坐标序：数据全仓 [lat,lng]，高德是 LngLat(lng,lat) → ll() 统一转换
 * - 折线描边：高德 v2 用 borderWeight/borderColor（原 TMap borderWidth/borderColor）
 * - 方向箭头：高德 showDir 布尔（原 arrowOptions{width}，宽度不可调）
 * - 虚线：高德 v2 strokeDasharray 数组（原 dashArray，同形）
 * - 文字标注：高德 AMap.Text 默认有白底边框，需显式置透明（style background/border）
 * - 视野飞行：高德 setZoomAndCenter(zoom, [lng,lat])（原 easeTo({center,zoom,duration})，
 *   动画时长由地图全局动画设置接管，语义一致）
 * 两家坐标系同为 GCJ-02，所有线路数据零改动。
 * ========================================================================== */

    /* 数据点 [lat,lng] → 高德 LngLat */
    function ll(p) { return new AMap.LngLat(p[1], p[0]); }
    /* 引擎侧几何 position 简写：LL(lat, lng) → [lat,lng] 数组（ll() 消费） */
    function LL(lat, lng) { return [lat, lng]; }

    /* --- 标记层 ---
       opts: { map, styles: {styleId: {src, width, height, anchor:{x,y}}}, geometries: [{id, styleId, position:[lat,lng]}] }
       点击回调收到 {geometry:{id}}（与引擎既有 handler 兼容） */
    function createMarkerLayer(opts) {
        var markers = (opts.geometries || []).map(function (g) {
            var st = opts.styles[g.styleId] || {};
            var m = new AMap.Marker({
                position: ll(g.position),
                icon: st.src,
                offset: new AMap.Pixel(-(st.anchor ? st.anchor.x : st.width / 2), -(st.anchor ? st.anchor.y : st.height)),
                zIndex: 110
            });
            m.__lid = g.id;
            return m;
        });
        var layer = {
            setMap: function (map) {
                markers.forEach(function (m) { m.setMap(map || null); });
            },
            on: function (ev, fn) {
                markers.forEach(function (m) {
                    m.on(ev, function () { fn({ geometry: { id: m.__lid } }); });
                });
            }
        };
        if (opts.map) layer.setMap(opts.map);
        return layer;
    }

    /* --- 文字标注层（AMap.Text，默认白底需显式剥掉；支持层级样式） ---
       opts: { map, zIndex, styles: {default: {color, size, offset, bold, halo, badge}},
               geometries: [{id, position, content}] }
       层级样式（体验修复 3）：
       - bold/halo：粗字 + 白色描边（站点近景标签，压得住底图）
       - badge：白底圆角小胶囊（景点最高层级） */
    function createLabelLayer(opts) {
        var texts = (opts.geometries || []).map(function (g) {
            var st = opts.styles[(g.styleId || opts.defaultStyleId || 'default')] || {};
            var off = st.offset || { x: 0, y: 0 };
            var style = {
                color: st.color || '#1f2937',
                'font-size': (st.size || 12) + 'px',
                'background-color': 'transparent',
                'border-width': '0',
                padding: '0',
                'white-space': 'nowrap'
            };
            if (st.bold) style['font-weight'] = '600';
            if (st.halo) style['text-shadow'] = '0 0 3px #fff, 0 0 4px #fff, 0 0 5px #fff';
            if (st.badge) {
                style['background-color'] = 'rgba(255,255,255,.88)';
                style['border'] = '1px solid ' + (st.badgeBorder || '#ddd6fe');
                style['border-radius'] = '7px';
                style['padding'] = '1px 6px';
                style['box-shadow'] = '0 1px 4px rgba(15,23,42,.15)';
            }
            var t = new AMap.Text({
                text: g.content,
                position: ll(g.position),
                offset: new AMap.Pixel(off.x, off.y),
                style: style,
                zIndex: opts.zIndex || 120
            });
            t.__lid = g.id;
            return t;
        });
        var layer = {
            setMap: function (map) {
                texts.forEach(function (t) { t.setMap(map || null); });
            },
            on: function (ev, fn) {
                texts.forEach(function (t) {
                    t.on(ev, function () { fn({ geometry: { id: t.__lid } }); });
                });
            }
        };
        if (opts.map) layer.setMap(opts.map);
        return layer;
    }

    /* --- 折线层 ---
       opts: { map, styles: {default: {color,width,borderWidth,borderColor,lineCap,dash,arrow}},
               geometries: [{id, styleId, paths: [[lat,lng],...]}] } */
    function amapLineStyle(st) {
        return {
            strokeColor: st.color,
            strokeWeight: st.width,
            strokeOpacity: 1,
            strokeStyle: (st.dash || st.dashArray) ? 'dashed' : 'solid',
            strokeDasharray: st.dash || st.dashArray || null,
            borderWeight: st.borderWidth || 0,
            borderColor: st.borderColor || '#ffffff',
            showDir: !!(st.arrow || st.arrowOptions),
            lineJoin: 'round',
            lineCap: st.lineCap || 'round'
        };
    }
    function createPolylineLayer(opts) {
        var lines = (opts.geometries || []).map(function (g) {
            var st = opts.styles[g.styleId || 'default'] || {};
            var pl = new AMap.Polyline(Object.assign({
                path: g.paths.map(ll),
                zIndex: 100
            }, amapLineStyle(st)));
            pl.__lid = g.id;
            return pl;
        });
        var layer = {
            setMap: function (map) {
                lines.forEach(function (pl) { pl.setMap(map || null); });
            },
            setStyles: function (styles) {
                var st = styles.default;
                if (!st) return;
                var o = amapLineStyle(st);
                lines.forEach(function (pl) { pl.setOptions(o); });
            },
            on: function (ev, fn) {
                lines.forEach(function (pl) {
                    pl.on(ev, function () { fn({ geometry: { id: pl.__lid } }); });
                });
            }
        };
        if (opts.map) layer.setMap(opts.map);
        return layer;
    }

    /* --- 信息窗 ---
       AMap.InfoWindow：构造时给 content/offset，用 open(map, position) 弹出 */
    var __iw = null;
    function openInfoWindow(map, lat, lng, html, offsetY) {
        if (__iw) __iw.close();
        __iw = new AMap.InfoWindow({
            content: html,
            offset: new AMap.Pixel(0, offsetY == null ? -30 : offsetY)
        });
        __iw.open(map, ll([lat, lng]));
        return __iw;
    }
