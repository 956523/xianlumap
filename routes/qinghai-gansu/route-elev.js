// 组装真实路线轨迹（浏览器分块导出）→ Node 侧补真实高程 → 输出 route-real-data.js
const fs = require('fs');
const path = require('path');
const dir = __dirname;

/* ---------- 1. 组装分块 ---------- */
let raw = '';
for (let i = 0; i < 30; i++) {
    const f = path.join(dir, `.traj_${i}.txt`);
    if (!fs.existsSync(f)) break;
    const txt = fs.readFileSync(f, 'utf8').trim();
    if (!txt) continue;
    const line = txt.split('\n').map(l => l.trim()).find(l => l.startsWith('"'));
    if (!line) { console.error(`chunk ${i} 无 JSON 行`); process.exit(1); }
    let s = JSON.parse(line);
    if (typeof s === 'string' && s.startsWith('"') && s.endsWith('"')) s = JSON.parse(s);
    if (s === '__END__') break;
    raw += s;
}
const DATA = JSON.parse(raw);
console.log(`组装完成: ${DATA.legs.length} 段`);
DATA.legs.forEach(l => console.log(`  D${l.id} ${l.name}: ${l.polyline.length}点 ${l.elev.length}采样 ${l.km}km`));

/* ---------- 2. Node 侧调 open-meteo 补高程 ---------- */
const https = require('https');
function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('JSON解析失败: ' + d.slice(0, 150))); } });
        }).on('error', reject);
    });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fillElevation() {
    let totalPts = DATA.legs.reduce((a, l) => a + l.elev.length, 0);
    let done = 0;
    for (const leg of DATA.legs) {
        // 100 点/次
        for (let i = 0; i < leg.elev.length; i += 100) {
            const batch = leg.elev.slice(i, i + 100);
            const lat = batch.map(p => p[2].toFixed(5)).join(',');
            const lng = batch.map(p => p[3].toFixed(5)).join(',');
            const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`;
            let j = null;
            for (let retry = 0; retry < 3 && !j; retry++) {
                try { j = await fetchJSON(url); } catch (e) {
                    if (retry === 2) { console.error('  高程失败 D' + leg.id + ' @' + i + ': ' + e.message); }
                    await sleep(700);
                }
            }
            if (!j || !j.elevation) { console.error(`  ⚠️ D${leg.id} @${i} 高程缺失，用插值兜底`); continue; }
            j.elevation.forEach((e, n) => { batch[n][1] = Math.round(e); });
            done += batch.length;
            process.stdout.write(`\r  高程采样 ${done}/${totalPts}`);
            await sleep(280); // 限速
        }
    }
    console.log('');
    // 极少数缺失的用邻点插值补
    DATA.legs.forEach(leg => {
        for (let i = 0; i < leg.elev.length; i++) {
            if (!leg.elev[i][1]) {
                const prev = leg.elev.slice(0, i).reverse().find(p => p[1]);
                const next = leg.elev.slice(i + 1).find(p => p[1]);
                leg.elev[i][1] = prev && next ? Math.round((prev[1] + next[1]) / 2) : (prev || next || [0, 2000])[1];
            }
        }
    });
}

(async () => {
    await fillElevation();

    /* ---------- 3. 轨迹抽稀（每段保留 ~60 个点，够平滑又不过大） ---------- */
    DATA.legs.forEach(leg => {
        const src = leg.polyline, n = src.length;
        const keep = Math.min(n, Math.max(40, Math.round(leg.km / 6)));
        if (n <= keep) { leg.simplified = src; return; }
        const out = [];
        for (let i = 0; i < keep; i++) out.push(src[Math.round(i * (n - 1) / (keep - 1))]);
        leg.simplified = out;
        leg.polyline = undefined; // 原始密集点不再需要
    });

    /* ---------- 4. 统计 & 输出 ---------- */
    const js = '// 青甘大环线真实公路路线 + 真实高程（构建于 ' + DATA.builtAt + '）\n' +
        '// 数据源：腾讯地图 Driving API（真实国道/高速轨迹与道路名）+ open-meteo Elevation API（真实高程）\n' +
        'var ROUTE_REAL = ' + JSON.stringify(DATA) + ';\n';
    fs.writeFileSync(path.join(dir, 'route-real-data.js'), js);
    console.log('route-real-data.js 已写出: ' + js.length + ' bytes');

    // 打印每段摘要
    DATA.legs.forEach(l => {
        const alts = l.elev.map(p => p[1]);
        let up = 0, down = 0;
        for (let i = 1; i < alts.length; i++) { const d = alts[i] - alts[i - 1]; if (d > 0) up += d; else down -= d; }
        console.log(`D${l.id} ${l.name}: ${l.km}km 简化${l.simplified.length}点 高程${alts.length}点 海拔${Math.min(...alts)}-${Math.max(...alts)}m ↑${Math.round(up)}↓${Math.round(down)} 路:${l.roads.slice(0, 4).join('+')}`);
    });
})();
