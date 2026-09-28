/* ============================================================
   青甘大环线 · 沿线站点数据构建（Node 版）
   替代原来的浏览器版 build-stations.html —— 理由：
   1) 实测 TMap.service.Search 的 JSONP 封装在本代理下恒返回 count=0，
      而直接 fetch 代理 HTTP 路径正常 → 不需要浏览器
   2) 浏览器版跑 7 分钟会掉会话，Node 版稳定
   用法：node build-stations.js [--dry]
   ============================================================ */
const fs = require('fs');
const http = require('http');

const SECRET = process.env.TMAP_SECRET || '29cfb9478e7448f532a26ad156a4b40c';
const PORT = process.env.TMAP_PORT || '49234';
const BASE = `http://127.0.0.1:${PORT}/_TMapService/_wbt/${SECRET}/service/place/v1/search`;

const MAX_DIST = 35;   // 站点离路线超过这个距离就丢弃（km）

/* 县级行政区穷举：地级市覆盖不到"行政委员会"这类县级单位。
   实测 region(大柴旦行政委员会,0) → 27 条，而 region(海西州,0) 抓不到。 */
const REGIONS = [
  '兰州市', '城关区', '七里河区', '安宁区', '西固区', '红古区', '永登县', '榆中县', '皋兰县',
  '武威市', '天祝藏族自治县',
  '张掖市', '甘州区', '民乐县', '临泽县', '高台县', '山丹县', '肃南裕固族自治县',
  '酒泉市', '肃州区', '玉门市', '敦煌市', '瓜州县', '金塔县', '阿克塞哈萨克族自治县', '肃北蒙古族自治县',
  '嘉峪关市',
  '西宁市', '城东区', '城中区', '城西区', '城北区', '湟中区', '湟源县', '大通回族土族自治县',
  '海东市', '乐都区', '平安区', '民和回族土族自治县', '互助土族自治县', '化隆回族自治县', '循化撒拉族自治县',
  '海北藏族自治州', '门源回族自治县', '祁连县', '海晏县', '刚察县',
  '海南藏族自治州', '共和县', '同德县', '贵德县', '兴海县', '贵南县',
  '海西蒙古族藏族自治州', '德令哈市', '格尔木市', '茫崖市', '乌兰县', '都兰县', '天峻县',
  '大柴旦行政委员会', '冷湖行政委员会', '茫崖行政委员会'
];

/* ---------- 1. 加载真实轨迹（与页面同源） ---------- */
const rsrc = fs.readFileSync('route-real-data.js', 'utf8');
const ROUTE_REAL = eval('(' + rsrc.replace(/^\s*\/\/[^\n]*\n/gm, '')
  .replace(/^\s*var\s+ROUTE_REAL\s*=/, '').replace(/;\s*$/, '') + ')');
const LEGS = ROUTE_REAL.legs;
const legById = id => LEGS.filter(l => l.id === id)[0];

const ORDER = [11, 1, 2, 3, 4, 5, 7, 8, 9, 10];  // 兰州→西宁 + D1-D5 + D7-D10
const COSLAT = Math.cos(38 * Math.PI / 180);
const ROUTE_ALL = [], SEG_KM = [];
let acc = 0;
ORDER.forEach(id => {
  const l = legById(id);
  if (!l) { console.log('⚠ 缺 leg' + id); return; }
  const pts = l.simplified || l.path;
  const lens = [0]; let arc = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = (pts[i][1] - pts[i - 1][1]) * COSLAT, dy = pts[i][0] - pts[i - 1][0];
    arc += Math.sqrt(dx * dx + dy * dy); lens.push(arc);
  }
  const scale = arc ? (l.apiKm / arc) : 0;
  for (let j = 0; j < pts.length; j++) {
    if (j === 0 && ROUTE_ALL.length) continue;
    ROUTE_ALL.push(pts[j]);
    SEG_KM.push(acc + lens[j] * scale);
  }
  acc += l.apiKm;
});
const TOTAL_KM = SEG_KM[SEG_KM.length - 1];
const LZ_XN_KM = legById(11).apiKm;
console.log(`路线：${LEGS.length} 段 / 投影点 ${ROUTE_ALL.length} / 总里程 ${TOTAL_KM.toFixed(1)}km`);

function projectRoute(p) {
  const px = p[1] * COSLAT, py = p[0];
  let best = { d: 1e18, i: 1, t: 0 };
  for (let i = 1; i < ROUTE_ALL.length; i++) {
    const A = ROUTE_ALL[i - 1], B = ROUTE_ALL[i];
    const ax = A[1] * COSLAT, ay = A[0], bx = B[1] * COSLAT, by = B[0];
    const abx = bx - ax, aby = by - ay, ab2 = abx * abx + aby * aby || 1e-12;
    let t = ((px - ax) * abx + (py - ay) * aby) / ab2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * abx, cy = ay + t * aby, dx = px - cx, dy = py - cy, d = dx * dx + dy * dy;
    if (d < best.d) best = { d, i, t };
  }
  const k0 = SEG_KM[best.i - 1], k1 = SEG_KM[best.i];
  return { dist: Math.sqrt(best.d) * 111.32, routeKm: k0 + (k1 - k0) * best.t };
}

/* ---------- 2. HTTP 查询 ---------- */
function getJSON(url, timeoutMs = 12000) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: timeoutMs }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { resolve({ status: -1, message: 'parse fail: ' + d.slice(0, 80) }); }
      });
    });
    req.on('error', e => resolve({ status: -1, message: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: -1, message: 'timeout' }); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function search(keyword, boundary, pageIndex) {
  const us = new URLSearchParams({
    keyword, boundary, output: 'json',
    page_size: '20', page_index: String(pageIndex)
  });
  return getJSON(BASE + '?' + us.toString());
}

/* ---------- 3. 抓取 ---------- */
async function main() {
  const raw = { ev: [], fuel: [] };
  const seen = new Set();
  const stats = { req: 0, fail: 0, empty: [] };

  function push(bucket, item) {
    if (!item.location) return;
    const pr = projectRoute([item.location.lat, item.location.lng]);
    if (pr.dist > MAX_DIST) return;
    const key = (item.title || '') + '|' + item.location.lat.toFixed(2) + ',' + item.location.lng.toFixed(2);
    if (seen.has(key)) return;
    seen.add(key);
    // 运营商：category 只到"汽车:充电站:充电站"，拿不到品牌；
    // 品牌实际在标题里（特来电/星星充电/特斯拉/驴充充/云快充/国家电网…）→ 从标题提取
    const title = item.title || '';
    const BRANDS = ['特来电', '星星充电', '特斯拉', '驴充充', '云快充', '国家电网', '小桔充电',
      '快电', '昆仑网电', '中国铁塔', '比亚迪', '蔚景云', '乐来电', '万桩', '闪开',
      '车电网', '智充', '观途速电', '鼎瑞', '兴达', '蔚享天成', '塔能', '海尔'];
    const op = BRANDS.filter(b => title.indexOf(b) >= 0)[0] || '';
    // 快/慢充线索（标题里带"慢充"的明确标注）
    const slow = title.indexOf('慢充') >= 0;
    raw[bucket].push({
      t: title || '未命名站点',
      a: item.address || '',
      tel: item.tel || '',
      lat: +item.location.lat.toFixed(5),
      lng: +item.location.lng.toFixed(5),
      km: +pr.routeKm.toFixed(1),
      d: +pr.dist.toFixed(1),
      op: op,
      slow: slow ? 1 : 0,
      cat: item.category || ''
    });
  }

  for (const job of [{ kw: '充电站', bucket: 'ev' }, { kw: '加油站', bucket: 'fuel' }]) {
    for (let r = 0; r < REGIONS.length; r++) {
      const rg = REGIONS[r];
      let got = 0;
      for (let pg = 1; pg <= 6; pg++) {
        const res = await search(job.kw, `region(${rg},0)`, pg);
        stats.req++;
        if (res.status !== 0) {
          stats.fail++;
          if (stats.fail <= 6) console.log(`  ⚠ ${rg} ${job.kw} status=${res.status} ${res.message || ''}`);
          break;
        }
        const n = (res.data || []).length;
        got += n;
        (res.data || []).forEach(it => push(job.bucket, it));
        if (n < 20) break;
        await sleep(70);
      }
      if (got === 0) stats.empty.push(job.kw + '@' + rg);
      if (r % 15 === 0) console.log(`  ${job.kw} ${r}/${REGIONS.length}（累计 ${raw[job.bucket].length}）`);
    }
    console.log(`${job.kw} 完成：${raw[job.bucket].length} 条`);
  }
  console.log(`请求 ${stats.req} / 失败 ${stats.fail} / 零结果区县 ${stats.empty.length}`);

  /* ---------- 4. 配额筛选 ---------- */
  function quota(list, { bucketKm, perBucket, criticalGap }) {
    const buckets = {};
    list.forEach(s => {
      const b = Math.floor(s.km / bucketKm);
      (buckets[b] = buckets[b] || []).push(s);
    });
    let kept = [];
    Object.keys(buckets).forEach(b => {
      kept = kept.concat(buckets[b].slice().sort((x, y) => x.d - y.d).slice(0, perBucket));
    });
    kept.sort((a, b) => a.km - b.km);
    const all = list.slice().sort((a, b) => a.km - b.km);
    let result = kept.slice();
    for (let i = 0; i < result.length; i++) {
      const cur = result[i], next = result[i + 1];
      const limit = next ? next.km : TOTAL_KM;
      if (limit - cur.km > criticalGap) {
        const cands = all.filter(s => s.km > cur.km && s.km < limit && result.indexOf(s) < 0);
        if (cands.length) {
          cands.sort((a, b) =>
            Math.abs(a.km - (cur.km + limit) / 2) - Math.abs(b.km - (cur.km + limit) / 2));
          result.push(cands[0]);
          result.sort((a, b) => a.km - b.km);
          i = -1;
        }
      }
    }
    return result.sort((a, b) => a.km - b.km);
  }

  const before = { ev: raw.ev.length, fuel: raw.fuel.length };
  raw.ev = quota(raw.ev, { bucketKm: 25, perBucket: 5, criticalGap: 120 });
  raw.fuel = quota(raw.fuel, { bucketKm: 25, perBucket: 3, criticalGap: 100 });
  console.log(`配额：充电站 ${before.ev}→${raw.ev.length} / 加油站 ${before.fuel}→${raw.fuel.length}`);

  /* ---------- 5. 覆盖体检 ---------- */
  function maxGap(list) {
    let g = 0, prev = 0, at = 0;
    list.forEach(s => { if (s.km - prev > g) { g = s.km - prev; at = s.km; } prev = s.km; });
    if (TOTAL_KM - prev > g) { g = TOTAL_KM - prev; at = TOTAL_KM; }
    return { gap: g, at };
  }
  function coverage(list, label) {
    const blind = [];
    for (let k = 0; k < TOTAL_KM; k += 25) {
      if (!list.some(s => Math.abs(s.km - k) <= 12.5)) blind.push(k);
    }
    if (!blind.length) { console.log(`  ${label}：25km 网格全覆盖 ✅`); return; }
    const runs = []; let st = blind[0], pv = blind[0];
    blind.slice(1).forEach(k => { if (k - pv > 25) { runs.push([st, pv]); st = k; } pv = k; });
    runs.push([st, pv]);
    const bad = runs.filter(r => r[1] - r[0] >= 25);
    console.log(`  ${label}：盲区 ${blind.length}/${Math.ceil(TOTAL_KM / 25)} 格，长盲区 ${bad.length} 段`);
    bad.forEach(r => console.log(`    ⚠ km${r[0]}–${r[1] + 25}（约 ${r[1] + 25 - r[0]}km）`));
  }
  console.log('覆盖体检：');
  console.log(`  最大无桩间隔 ${maxGap(raw.ev).gap.toFixed(1)}km`);
  console.log(`  最大无油间隔 ${maxGap(raw.fuel).gap.toFixed(1)}km`);
  coverage(raw.ev, '充电站');
  coverage(raw.fuel, '加油站');

  /* ---------- 6. 输出 ---------- */
  raw.ev.sort((a, b) => a.km - b.km);
  raw.fuel.sort((a, b) => a.km - b.km);
  const d = new Date();
  const builtAt = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
    '-' + String(d.getDate()).padStart(2, '0');
  const out = {
    builtAt, source: '腾讯地图真实驾车轨迹重投影',
    totalKm: +TOTAL_KM.toFixed(1),
    xnStart: +LZ_XN_KM.toFixed(1),
    xnEnd: +(TOTAL_KM - LZ_XN_KM).toFixed(1),
    ev: raw.ev, fuel: raw.fuel
  };
  fs.writeFileSync('stations-new.json', JSON.stringify(out));
  console.log(`已写 stations-new.json（${raw.ev.length} 充电 + ${raw.fuel.length} 加油，${(JSON.stringify(out).length / 1024).toFixed(0)}KB）`);
}
main();
