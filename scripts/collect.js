#!/usr/bin/env node
'use strict';

/**
 * 涨停情绪指数采集器
 *
 * 指标定义：
 *   值 = 昨日封板率/100 × 883900(昨日涨停表现)当日涨跌幅(%) + 1 + 上证指数当日涨跌幅(%)/20
 *
 * 三个输入：
 *   1) 昨日封板率 = 同花顺涨停池家数 ÷ (涨停池家数 + 炸板池家数)，取「最近一个交易日」的收盘值
 *   2) 883900 昨日涨停表现 → 实时涨跌幅(%)
 *   3) 上证指数(hs_1A0001) → 实时涨跌幅(%)
 *
 * 用法：
 *   node scripts/collect.js --session=am      # 上午 9:30-11:30 每分钟采集
 *   node scripts/collect.js --session=pm      # 下午 13:00-15:00 每分钟采集
 *   node scripts/collect.js --once            # 只采一次（本地测试）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const STEP_MS = 60000;

const args = process.argv.slice(2);
// --session 可传 am / pm / auto（默认 auto：按当前北京时间自动判断，供 workflow_dispatch 手动触发用）
const SESSION_ARG = (args.find(function (a) { return a.indexOf('--session=') === 0; }) || '--session=auto').split('=')[1];
const ONCE = args.indexOf('--once') >= 0;
const PROBE = args.indexOf('--probe') >= 0;   // 只读探测：验证三个接口是否可达，不写任何文件
const minutesArg = args.find(function (a) { return a.indexOf('--minutes=') === 0; });
const MINUTES = minutesArg ? parseInt(minutesArg.split('=')[1], 10) : 0;   // >0 时跑满 N 分钟即退出（供 CI 分批提交）

/* ---------------- 时间（统一按北京时间 UTC+8） ---------------- */
function pad(n) { return (n < 10 ? '0' : '') + n; }
function bjNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function ymdNum(d) { return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); }
function ymdDate(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
function hmNum(d) { return d.getUTCHours() * 100 + d.getUTCMinutes(); }
function hmStr(d) { return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function shiftYmd(n, delta) {
  const y = Math.floor(n / 10000);
  const m = Math.floor(n / 100) % 100;
  const d = n % 100;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return ymdNum(dt);
}

/* ---------------- HTTP ---------------- */
async function fetchText(url, referer) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Referer': referer || 'https://stockpage.10jqka.com.cn/',
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function retry(fn, times) {
  let last = null;
  for (let i = 0; i <= times; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (i < times) await sleep(800);
    }
  }
  throw last;
}

// 同花顺实时快照（JSONP）→ 涨跌幅(%)
async function getChangePct(prefix, code) {
  const text = await fetchText('https://d.10jqka.com.cn/v2/realhead/' + prefix + '_' + code + '/last.js');
  const m = text.match(/\(([\s\S]*)\)\s*;?\s*$/);
  if (!m) throw new Error('bad jsonp');
  const d = JSON.parse(m[1]);
  const items = (d && d.items) || {};
  let pct = parseFloat(items['199112']);
  if (!isFinite(pct)) {
    // 盘前 199112 可能为空，用 (最新价 / 昨收 - 1) 兜底
    const last = parseFloat(items['10']);
    const pre = parseFloat(items['6']);
    if (isFinite(last) && isFinite(pre) && pre > 0) pct = (last / pre - 1) * 100;
  }
  if (!isFinite(pct)) throw new Error('no pct for ' + code);
  return pct;
}

// 同花顺涨停池 / 炸板池（普通 JSON）→ 家数
async function getPoolTotal(kind, dateNum) {
  const api = kind === 'zt' ? 'limit_up_pool' : 'open_limit_pool';
  const url = 'https://data.10jqka.com.cn/dataapi/limit_up/' + api +
    '?page=1&limit=1&field=199112&filter=HS,GEM2STAR&order_field=330324&order_type=0&date=' + dateNum;
  const text = await fetchText(url, 'https://data.10jqka.com.cn/');
  const d = JSON.parse(text);
  const total = d && d.data && d.data.page ? d.data.page.total : null;
  return typeof total === 'number' ? total : null;
}

/* ---------------- 业务 ---------------- */
// 找「最近一个有数据的交易日」的封板率
async function resolveLimitRate(baseYmd) {
  for (let back = 1; back <= 12; back++) {
    const prev = shiftYmd(baseYmd, -back);
    try {
      const zt = await retry(function () { return getPoolTotal('zt', prev); }, 1);
      if (zt && zt > 0) {
        const zb = await retry(function () { return getPoolTotal('zb', prev); }, 1) || 0;
        const denom = zt + zb;
        return { date: String(prev), zt: zt, zb: zb, rate: denom > 0 ? (zt / denom) * 100 : null };
      }
    } catch (e) { /* 继续往前找 */ }
    await sleep(250);
  }
  return null;
}

// 指标值（见 README「公式口径」，三列单位并不统一）
//   值 = 封板率/100 × (883900涨跌幅% ÷ 100) + 1 + 上证涨跌幅% ÷ 20
//   即 883900 按小数代入、上证按百分点代入；上证项权重最大（±1% ≈ ∓0.05）
function computeValue(ratePct, pct883900, pctSH) {
  // 对应 Excel 式 =C3/100*D3+1+E3/20
  return (ratePct / 100) * (pct883900 / 100) + 1 + pctSH / 20;
}

function writeStore(dateStr, store) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, dateStr + '.json'), JSON.stringify(store, null, 1));
  const dates = fs.readdirSync(DATA_DIR)
    .filter(function (f) { return /^\d{4}-\d{2}-\d{2}\.json$/.test(f); })
    .map(function (f) { return f.replace('.json', ''); })
    .sort();
  fs.writeFileSync(path.join(DATA_DIR, 'index.json'), JSON.stringify({ dates: dates }, null, 1));
}

function readStore(dateStr) {
  const f = path.join(DATA_DIR, dateStr + '.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}

async function sampleOnce(rateInfo) {
  const a = await retry(function () { return getChangePct('48', '883900'); }, 2);
  const b = await retry(function () { return getChangePct('hs', '1A0001'); }, 2);
  const v = computeValue(rateInfo.rate, a, b);
  return { v: +v.toFixed(4), a: +a.toFixed(3), b: +b.toFixed(3) };
}

async function main() {
  const now = bjNow();
  const todayNum = ymdNum(now);
  const dateStr = ymdDate(now);
  // auto：手动触发时按当前北京时间落到 am / pm，避免下午触发却按早盘跑而直接空转退出
  const SESSION = (SESSION_ARG === 'am' || SESSION_ARG === 'pm')
    ? SESSION_ARG
    : (hmNum(now) < 1200 ? 'am' : 'pm');

  console.log('[collect] 北京时间 ' + dateStr + ' ' + hmStr(now) + '，session=' + SESSION +
    (SESSION_ARG === 'auto' ? '(auto)' : '') + (ONCE ? '，单次模式' : ''));

  // 只读探测：确认当前出口 IP 能否访问同花顺三组接口（GitHub Actions 跑在海外，需实测）
  if (PROBE) {
    const prev = shiftYmd(todayNum, -1);
    console.log('[probe] 出口 IP 连通性探测（不写任何数据）');
    try {
      const r = await fetch('https://api.ipify.org');
      console.log('[probe] 出口 IP = ' + (await r.text()).trim());
    } catch (e) { console.log('[probe] 出口 IP 查询失败: ' + e.message); }

    const checks = [
      ['883900 实时涨跌幅', function () { return getChangePct('48', '883900'); }],
      ['上证指数 实时涨跌幅', function () { return getChangePct('hs', '1A0001'); }],
      ['涨停池家数 (' + prev + ')', function () { return getPoolTotal('zt', prev); }],
      ['炸板池家数 (' + prev + ')', function () { return getPoolTotal('zb', prev); }]
    ];
    let ok = 0;
    for (let i = 0; i < checks.length; i++) {
      try {
        const r = await retry(checks[i][1], 1);
        ok++;
        console.log('[probe] OK   ' + checks[i][0] + ' = ' + r);
      } catch (e) {
        console.log('[probe] FAIL ' + checks[i][0] + ' → ' + e.message);
      }
      await sleep(300);
    }
    console.log('[probe] 结束：' + ok + '/' + checks.length + ' 项可用');
    process.exit(ok === checks.length ? 0 : 1);
  }

  const rateInfo = await resolveLimitRate(todayNum);
  if (!rateInfo) {
    console.error('[collect] 未能取得昨日封板率，退出');
    process.exit(1);
  }
  console.log('[collect] 昨日封板率基准 = ' + rateInfo.date + '  涨停 ' + rateInfo.zt +
    ' / 炸板 ' + rateInfo.zb + ' → ' + rateInfo.rate.toFixed(2) + '%');

  // 供前端读取「昨日封板率」（前端不直连 data.10jqka.com.cn，其 CORS 依赖 Referer）
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'latest.json'), JSON.stringify({
    date: dateStr,
    rate: rateInfo,
    updated: new Date().toISOString()
  }, null, 1));

  let store = readStore(dateStr) || { date: dateStr, rate: rateInfo, points: [] };
  store.rate = rateInfo;
  if (!Array.isArray(store.points)) store.points = [];

  if (ONCE) {
    const s = await sampleOnce(rateInfo);
    const key = hmStr(bjNow());
    store.points.push({ t: key, v: s.v, a: s.a, b: s.b });
    writeStore(dateStr, store);
    console.log('[collect] 单次采集完成 ' + key + ' → 值=' + s.v + '（883900=' + s.a + '%，上证=' + s.b + '%）');
    return;
  }

  const endHm = SESSION === 'am' ? 1130 : 1500;
  const startedAt = Date.now();

  while (true) {
    const t = bjNow();
    const cur = hmNum(t);
    if (cur > endHm) break;
    if (MINUTES > 0 && (Date.now() - startedAt) > MINUTES * 60000) break;

    const inAM = cur >= 930 && cur <= 1130;
    const inPM = cur >= 1300 && cur <= 1500;
    if (inAM || inPM) {
      const key = hmStr(t);
      const exists = store.points.some(function (p) { return p.t === key; });
      if (!exists) {
        try {
          const s = await sampleOnce(rateInfo);
          store.points.push({ t: key, v: s.v, a: s.a, b: s.b });
          store.points.sort(function (x, y) { return x.t < y.t ? -1 : 1; });
          writeStore(dateStr, store);
          console.log('  ' + key + '  值=' + s.v + '  (883900=' + s.a + '%  上证=' + s.b + '%)');
        } catch (e) {
          console.error('  ' + key + '  采集失败: ' + e.message);
        }
      }
    }
    await sleep(STEP_MS);
  }

  writeStore(dateStr, store);
  console.log('[collect] 完成，共 ' + store.points.length + ' 个点');
}

main().catch(function (e) {
  console.error('[collect] 致命错误', e);
  process.exit(1);
});
