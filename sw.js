/* ============================================================================
 * sw.js — 离线 PWA Service Worker（S30）
 *
 * 缓存策略（行中模式断网保障：链计算全本机，不依赖任何网络）：
 * - HTML（index.html）：network-first——发版后先拿新版，拿不到再落缓存；
 * - 应用静态资源（engine/ route-defs/ key.local.js favicon manifest）：
 *   cache-first——离线命中的就是这套代码+数据，行中模式照常算链；
 * - 底图瓦片/高德 SDK/POI 服务：一律不缓存、走网络——断网时地图是灰底，
 *   但链/进度/打卡全部可用（诚实口径：地图降级，数据不降级）；
 * - 同名缓存整包替换（activate 清旧版），避免半新半旧。
 * ========================================================================== */
var CACHE = 'xianlumap-s30-v1';
var APP_SHELL = [
    './index.html',
    './manifest.json',
    './favicon.svg',
    './key.local.js',
    './engine/boot-route.js',
    './engine/logo.js',
    './engine/map-adapter.js',
    './engine/route-engine.js',
    './engine/planner.js',
    './engine/profile.js',
    './engine/mobile.js',
    './engine/edit.js',
    './engine/enroute.js',
    './engine/sync.js',
    './engine/ui.js',
    './route-defs/manifest.js',
    './route-defs/hero-curves.js',
    './route-defs/qinghai-gansu.js',
    './route-defs/chuanxi.js',
    './route-defs/chengdu-lhasa-318.js'
];

self.addEventListener('install', function (e) {
    e.waitUntil(
        caches.open(CACHE).then(function (c) { return c.addAll(APP_SHELL); }).then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener('activate', function (e) {
    e.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
        }).then(function () { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function (e) {
    var url = new URL(e.request.url);
    if (e.request.method !== 'GET') return;
    /* 底图瓦片/高德服务/其他源：一律网络，不缓存（断网灰底，数据仍可用） */
    if (url.origin !== location.origin) return;

    if (e.request.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/')) {
        /* HTML：network-first */
        e.respondWith(
            fetch(e.request).then(function (res) {
                var copy = res.clone();
                caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
                return res;
            }).catch(function () {
                return caches.match('./index.html');
            })
        );
        return;
    }
    /* 应用静态资源：cache-first（缺了补缓存） */
    e.respondWith(
        caches.match(e.request).then(function (hit) {
            if (hit) return hit;
            return fetch(e.request).then(function (res) {
                if (res && res.status === 200 && (url.pathname.indexOf('/engine/') === 0 || url.pathname.indexOf('/route-defs/') === 0 || url.pathname.endsWith('key.local.js'))) {
                    var copy = res.clone();
                    caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
                }
                return res;
            });
        })
    );
});
