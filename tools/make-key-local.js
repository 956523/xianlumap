/* ============================================================
   make-key-local.js — 从 .env.local 生成 key.local.js（浏览器端高德 Key）
   用法：node tools/make-key-local.js
   产出：仓库根 key.local.js（已被 .gitignore 排除，绝不入库）
   形状：window.__KEY_LOCAL__ = { amapKey, amapSecurity }
   保密：本脚本与日志只显示前 4 位（复用 build-lib 的 maskKey）。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { maskKey, ROOT } = require('./lib/build-lib');

function readEnvLocal() {
    const file = path.join(ROOT, '.env.local');
    if (!fs.existsSync(file)) {
        throw new Error('缺少 .env.local：请写入 AMAP_JS_KEY 与 AMAP_SECURITY_CODE（高德控制台「Web 端(JS API)」Key）');
    }
    const env = {};
    fs.readFileSync(file, 'utf8').split('\n').forEach(l => {
        const m = l.match(/^\s*([A-Z_]+)\s*=\s*(\S+)\s*$/);
        if (m) env[m[1]] = m[2];
    });
    return env;
}

const env = readEnvLocal();
const amapKey = env.AMAP_JS_KEY || '';
const amapSecurity = env.AMAP_JS_SECURITY_CODE || '';
if (!amapKey || !amapSecurity) {
    console.error('✗ .env.local 缺少 AMAP_JS_KEY 或 AMAP_JS_SECURITY_CODE');
    process.exit(1);
}

const out = '/* 本文件由 tools/make-key-local.js 生成（数据源 .env.local）。\n' +
    '   浏览器端 Key 运行时必然出现在页面源码里——这是高德的设计；\n' +
    '   但它【绝不能进 git】（本文件已被 .gitignore 排除，别手动提交）。\n' +
    '   丢了/换 Key 后重跑：node tools/make-key-local.js */\n' +
    'window.__KEY_LOCAL__ = ' + JSON.stringify({ amapKey, amapSecurity }, null, 2) + ';\n';
fs.writeFileSync(path.join(ROOT, 'key.local.js'), out);
console.log('✓ 已生成 key.local.js（AMAP_JS_KEY ' + maskKey(amapKey) + '，安全密钥 ' + maskKey(amapSecurity) + '）');
