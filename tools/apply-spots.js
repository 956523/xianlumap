/* ============================================================
   apply-spots.js — 景点库回灌线路包（S12 半自动流水线第 3 环）
   用法：node tools/apply-spots.js [--route <routeId>]（缺省 = manifest 全部）

   规则（铁律：值不值得去是人的判断）：
   - 只有 reviewed && approved 的候选（autoCaptured:true）会被物化；
     手打 81 条（autoCaptured 缺省 false）是历史审核成果，始终在库
   - 物化条件：条目在某线路走廊内（距路径 ≤35km，复用投影工具）
   - 形状对齐现有 SPOTS：{ n, p:[lat,lng]（GCJ-02）, d }；
     手打老条目字段原样保留，新数据只是变多（按名字去重，不覆盖）
   ============================================================ */
const fs = require('fs');
const {
    wgs2gcj, loadRoutePackage, buildProjection, replaceVarBlock
} = require('./lib/build-lib');
const { readDb } = require('./lib/db-lib');

const ARG_ROUTE = (process.argv.filter(a => a.indexOf('--route=') === 0)[0] || '').split('=')[1]
    || (process.argv.indexOf('--route') >= 0 ? process.argv[process.argv.indexOf('--route') + 1] : null);

const KIND_LABEL = { spot: '风景', viewpoint: '观景台', pass: '垭口', memorial: '纪念馆', temple: '寺观' };
const MAX_DIST = 35;

const spotDb = readDb('spots.json', { version: 1, spots: [] });
// 可物化条目：人工审核通过的候选 + 全部手打历史条目
const approved = spotDb.spots.filter(s =>
    (!s.autoCaptured) || (s.reviewed && s.approved !== false && s.approved != null));
console.log('库内可物化：' + approved.length + ' 条（手打 ' +
    approved.filter(s => !s.autoCaptured).length + ' + 候选通过 ' +
    approved.filter(s => s.autoCaptured).length + '）');

const manifest = fs.readFileSync(require('path').join(__dirname, '..', 'route-defs', 'manifest.js'), 'utf8');
const routeIds = ARG_ROUTE ? [ARG_ROUTE]
    : (manifest.match(/id:\s*'([^']+)'/g) || []).map(s => s.match(/'([^']+)'/)[1]);

routeIds.forEach(id => {
    const { file, src, pkg } = loadRoutePackage(id);
    const PROJ = buildProjection(pkg);
    const existing = {};
    (pkg.SPOTS || []).forEach(s => { existing[s.n] = 1; });
    const added = [];
    approved.forEach(s => {
        const g = wgs2gcj(s.lat, s.lng);
        const pr = PROJ.project(g[0], g[1]);
        if (pr.dist > MAX_DIST) return;
        if (existing[s.name]) return;                       // 手打同名已覆盖，不重复
        existing[s.name] = 1;
        const kind = KIND_LABEL[s.kind] || '风景';
        added.push({
            n: s.name,
            p: [+g[0].toFixed(5), +g[1].toFixed(5)],
            d: (s.autoCaptured ? (s.desc ? s.desc : kind + '（候选库收录）') : s.d)
        });
    });
    if (!added.length) { console.log(id + '：无新增'); return; }
    const spots = (pkg.SPOTS || []).concat(added);
    fs.writeFileSync(file, replaceVarBlock(src, 'SPOTS', 'var SPOTS = ' + JSON.stringify(spots) + ';'));
    console.log(id + '：SPOTS ' + (spots.length - added.length) + ' → ' + spots.length + '（新增 ' + added.length + '）');
});
