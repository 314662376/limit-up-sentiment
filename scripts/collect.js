#!/usr/bin/env node
'use strict';

/**
 * 双指数采集器
 *
 * ① 涨停情绪指数（单位：无量纲，1.000 为中性基准）
 *      = 昨日封板率/100 × 883900(昨日涨停表现)当日涨跌幅(%) + 1 + 上证指数当日涨跌幅(%)/20
 *    对应 Excel 式 =C3/100*D3+1+E3/20
 *
 * ② 打板收益（单位：元 / 万元本金）
 *      = 10000*(1+883918涨跌幅%)*昨日炸板率 + 10000*(1+883900涨跌幅%)*昨日非一字板封板率 - 10000
 *    对应 Excel 式 =10000*(1+F2)*E2+10000*(1+D2)*C2-10000
 *    其中 昨日非一字板封板率 + 昨日炸板率 = 100%（两者互补，可直接化简为下面的等价式）
 *      = 100 × ( 883918涨跌幅% × 炸板率 + 883900涨跌幅% × 非一字板封板率 )
 *
 * 取数：
 *   1) 涨停池 / 炸板池（同花顺 dataapi）→ 家数、一字板家数，取「最近一个交易日」的收盘值
 *        总封板率          = 涨停家数 ÷ (涨停家数 + 炸板家数)                       → ①用
 *        非一字板封板率    = 非一字板涨停家数 ÷ (非一字板涨停家数 + 炸板家数)        → ②用
 *        非一字板涨停家数  = 涨停家数 − 一字板家数
 *   2) 883900 昨日涨停表现 → 实时涨跌幅(%)                                     → ①②
 *   3) 883918 昨日炸板股   → 实时涨跌幅(%)                                     → ②
 *   4) 上证指数(hs_1A0001) → 实时涨跌幅(%)                                     → ①
 *
 * 用法：
 *   node scripts/collect.js --full        # 【推荐】抓当日完整分时，一次写入全天 241 个点（盘后跑）
 *   node scripts/collect.js --session=am  # 上午 9:30-11:30 逐分钟采集（旧模式）
 *   node scripts/collect.js --session=pm  # 下午 13:00-15:00 逐分钟采集（旧模式）
 *   node scripts/collect.js --once        # 只采一次（本地测试）
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
const FULL = args.indexOf('--full') >= 0;     // 抓当日完整分时，一次写满全天（推荐，盘后跑）
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

// 同花顺涨停池 / 炸板池（普通 JSON）→ 家数 + 一字板家数
// 注意：limit_up_type 字段只有在 field 列表里带上对应参数时才会返回（实测 330324 等组合），
//       所以这里固定用一整串完整 field，否则拿不到「换手板 / 一字板 / T字板」的分类。
const POOL_FIELDS = '199112,10,9001,330323,330324,330325,9002,330329,133971,133970,' +
  '1968584,3475914,9003,9004,3475915,3475916,330326,330327,330328';

async function getPoolStats(kind, dateNum) {
  const api = kind === 'zt' ? 'limit_up_pool' : 'open_limit_pool';
  // limit 上限为 200，涨停家数极值约 150，够用
  const url = 'https://data.10jqka.com.cn/dataapi/limit_up/' + api +
    '?page=1&limit=200&field=' + POOL_FIELDS +
    '&filter=HS,GEM2STAR&order_field=330324&order_type=0&date=' + dateNum;
  const text = await fetchText(url, 'https://data.10jqka.com.cn/');
  const d = JSON.parse(text);
  const data = d && d.data;
  if (!data || !data.page || typeof data.page.total !== 'number') throw new Error('bad pool response');
  let oneWord = 0;
  (data.info || []).forEach(function (x) { if (x.limit_up_type === '一字板') oneWord++; });
  const total = data.page.total;
  // limit=200 时若 total>200 则会漏记，这里给出提示（实际未出现过）
  if (total > 200) console.warn('[warn] ' + kind + ' ' + dateNum + ' 家数 ' + total + ' 超过单页上限，一字板统计可能偏少');
  return { total: total, oneWord: oneWord };
}

/* ---------------- 业务 ---------------- */
// 同花顺当日完整分时（JSONP）→ { date, pre, map:{ 'HH:MM': 涨跌幅% } }
// 收盘后调用即可一次拿到全天 241 个点，比逐分钟轮询可靠得多。
async function getTimeSeries(prefix, code) {
  const text = await fetchText('https://d.10jqka.com.cn/v6/time/' + prefix + '_' + code + '/last.js');
  const m = text.match(/\(([\s\S]*)\)\s*;?\s*$/);
  if (!m) throw new Error('bad jsonp');
  const d = JSON.parse(m[1]);
  const p = d[prefix + '_' + code];
  if (!p || !p.data) throw new Error('no time data ' + code);
  const pre = parseFloat(p.pre);
  const map = {};
  p.data.split(';').forEach(function (r) {
    const x = r.split(',');
    if (x.length < 2 || !x[1]) return;
    const price = parseFloat(x[1]);
    if (!isFinite(price)) return;
    const t = String(x[0]);
    map[t.slice(0, 2) + ':' + t.slice(2)] = pre > 0 ? (price / pre - 1) * 100 : null;
  });
  return { date: String(p.date || ''), pre: pre, map: map, n: Object.keys(map).length };
}

// 取「某一天自己的家数统计」（该日无数据 → null）。
// 顺带给出两种封板率口径：
//   rate = 总封板率        = 涨停 / (涨停 + 炸板)
//   fbl  = 非一字板封板率  = (涨停 − 一字板) / (涨停 − 一字板 + 炸板)   ← ①② 两个公式统一用这个
//   zbl  = 炸板率          = 100 − fbl
async function poolsOn(ymd) {
  const ztS = await retry(function () { return getPoolStats('zt', ymd); }, 1);
  if (!ztS || !(ztS.total > 0)) return null;
  const zbS = (await retry(function () { return getPoolStats('zb', ymd); }, 1)) || { total: 0 };
  const zt = ztS.total, zb = zbS.total, ow = ztS.oneWord || 0;
  const base = zt - ow;                 // 非一字板涨停家数
  const denom0 = zt + zb;               // 总口径
  const denom1 = base + zb;             // 非一字板口径
  return {
    date: String(ymd),
    zt: zt, zb: zb, oneWord: ow, base: base,
    rate: denom0 > 0 ? (zt / denom0) * 100 : null,   // 总封板率
    fbl: denom1 > 0 ? (base / denom1) * 100 : null,  // 非一字板封板率
    zbl: denom1 > 0 ? (zb / denom1) * 100 : null     // 炸板率（= 100 − 非一字板封板率）
  };
}

// 找「最近一个有数据的交易日」的封板率 / 非一字板封板率
// —— 注意语义：传入 baseYmd（今天），返回的是**它前面**那个交易日的家数。
//    这个对象就是归档里的 rate 字段，也是页面上 ①② 两个公式的输入基准。
async function resolveRate(baseYmd) {
  for (let back = 1; back <= 12; back++) {
    const prev = shiftYmd(baseYmd, -back);
    try {
      const r = await poolsOn(prev);
      if (r) return r;
    } catch (e) { /* 继续往前找 */ }
    await sleep(250);
  }
  return null;
}

// 取「某一天自己的家数」——归档里的 self 字段。
//
// 为什么要存 self：归档 data/<D>.json 的 rate 存的是 D-1 的家数（给 D 当天算公式用），
// 所以只靠它推理不出 D 自己的家数。而「D+1 这天的正确基准」恰恰就是 D 自己的家数。
// 盘中如果池子接口挂了，前端就只能退回存档；没有 self 时会退成 D-1 的家数（早一天），
// 页面上的「昨日非一字板封板率」会静悄悄地错一格。见 app.js 的 resolveRateArchive。
async function resolveSelf(ymd) {
  const r = await poolsOn(ymd);
  return r ? { date: r.date, zt: r.zt, zb: r.zb, oneWord: r.oneWord, base: r.base, rate: r.rate, fbl: r.fbl, zbl: r.zbl } : null;
}

// self 能否当「当日终值」用的守卫：
//   盘中跑 --full 时当天池子还在累加，家数是「半截」的，写进去会污染次日的基准；
//   唯一例外是在回补历史日（那天已经彻底走完了），任何时候取都是终值。
function selfUsable(ymdNumDay) {
  return ymdNumDay !== ymdNum(bjNow()) || hmNum(bjNow()) >= 1500;
}
function fmtYmd(n) {
  const s = String(n);
  return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
}

// 顺手回填：resolveRate 拿到的 rateInfo 就是「前一个交易日 P 自己的家数」，
// 而 P 自己的家数正好是 data/<P>.json 该有的 self。零额外请求，纯补历史欠账。
function backfillSelf(rateInfo) {
  try {
    const pStr = fmtYmd(rateInfo.date);
    const f = path.join(DATA_DIR, pStr + '.json');
    if (!fs.existsSync(f)) return false;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || j.date !== pStr) return false;           // 文件名与内容不符，不碰
    if (j.self && j.self.rate != null) return false;    // 已有，幂等
    j.self = rateInfo;
    fs.writeFileSync(f, JSON.stringify(j, null, 1));
    console.log('[collect] 回填 self → ' + pStr + '.json（' + rateInfo.date +
      ' 自家家数：涨停 ' + rateInfo.zt + ' / 炸板 ' + rateInfo.zb + '）');
    return true;
  } catch (e) {
    return false;   // 回填是锦上添花，失败不影响主流程
  }
}

// 指数① 涨停情绪指数（见 README「公式口径」，三列单位并不统一）
//   值 = 封板率/100 × (883900涨跌幅% ÷ 100) + 1 + 上证涨跌幅% ÷ 20
//   即 883900 按小数代入、上证按百分点代入；上证项权重最大（±1% ≈ ∓0.05）
function computeValue(ratePct, pct883900, pctSH) {
  // 对应 Excel 式 =C3/100*D3+1+E3/20
  return (ratePct / 100) * (pct883900 / 100) + 1 + pctSH / 20;
}

// 指数② 打板收益（元 / 万元本金）
//   对应 Excel 式 =10000*(1+F2)*E2 + 10000*(1+D2)*C2 - 10000
//     C 昨日非一字板封板率、E 昨日炸板率（C + E = 100%，可直接化简）
//   化简：= 10000 × [ 炸板率×(1+883918涨跌幅/100) + 非一字板封板率×(1+883900涨跌幅/100) − 1 ]
//        = 100 × ( 883918涨跌幅% × 炸板率 + 883900涨跌幅% × 非一字板封板率 )
function computeBoardReturn(pct883918, pct883900, fblPct) {
  if (fblPct == null || !isFinite(fblPct)) return null;
  const fbl = fblPct / 100;        // 非一字板封板率
  const zbl = 1 - fbl;             // 炸板率（互补）
  return 100 * (pct883918 * zbl + pct883900 * fbl);
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
  await sleep(200);
  const c = await retry(function () { return getChangePct('48', '883918'); }, 2);
  await sleep(200);
  const b = await retry(function () { return getChangePct('hs', '1A0001'); }, 2);
  const v = computeValue(rateInfo.rate, a, b);
  const v2 = computeBoardReturn(c, a, rateInfo.fbl);
  return {
    v: +v.toFixed(4),
    v2: v2 == null ? null : +v2.toFixed(2),
    a: +a.toFixed(3), b: +b.toFixed(3), c: +c.toFixed(3)
  };
}

// 【推荐路径】一次抓取「当日完整分时」并落盘。
// 与逐分钟轮询相比：只需一个成功的时间点（例如收盘后 15:10），就能把全天 241 个点补齐，
// 因此即使 GitHub 的 cron 一次都没触发，只要手动/定时跑过一次 --full 数据就是完整的。
async function collectFullDay() {
  const aP = await retry(function () { return getTimeSeries('48', '883900'); }, 2);
  await sleep(300);
  const bP = await retry(function () { return getTimeSeries('hs', '1A0001'); }, 2);
  await sleep(300);
  let cP = null;
  try { cP = await retry(function () { return getTimeSeries('48', '883918'); }, 2); } catch (e) { cP = null; }

  if (!aP.date || !aP.n) throw new Error('883900 分时为空');
  const dataStr = aP.date.slice(0, 4) + '-' + aP.date.slice(4, 6) + '-' + aP.date.slice(6, 8);
  const dataNum = parseInt(aP.date, 10);
  const rateInfo = await resolveRate(dataNum);
  if (!rateInfo) throw new Error('未能取得基准日封板率');

  // 顺手把历史欠账补上（rateInfo 就是前一交易日自己的家数）
  backfillSelf(rateInfo);

  // 今天自己的家数，存成 self —— 这就是「明天」的正确基准。
  // 若接口是从别的出口（例如 GitHub Actions）跑，这里能拿到；盘中跑则被守卫挡住。
  let selfInfo = null;
  if (selfUsable(dataNum)) {
    try { selfInfo = await resolveSelf(dataNum); } catch (e) { selfInfo = null; }
  }

  const pts = [];
  Object.keys(aP.map).sort().forEach(function (t) {
    const a = aP.map[t], b = bP.map[t];
    if (a == null || b == null) return;
    const c = cP ? cP.map[t] : null;
    const v = computeValue(rateInfo.rate, a, b);
    const v2 = (c == null || rateInfo.fbl == null) ? null : computeBoardReturn(c, a, rateInfo.fbl);
    pts.push({
      t: t, v: +v.toFixed(4), v2: v2 == null ? null : +v2.toFixed(2),
      a: +a.toFixed(3), b: +b.toFixed(3), c: c == null ? null : +c.toFixed(3)
    });
  });
  if (!pts.length) throw new Error('无可写入的点');

  const store = { date: dataStr, rate: rateInfo, self: selfInfo, points: pts, source: 'full' };
  writeStore(dataStr, store);
  fs.writeFileSync(path.join(DATA_DIR, 'latest.json'), JSON.stringify({
    date: dataStr, rate: rateInfo, self: selfInfo, updated: new Date().toISOString()
  }, null, 1));
  return store;
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
      ['883900 昨日涨停表现 实时涨跌幅', function () { return getChangePct('48', '883900'); }],
      ['883918 昨日炸板股 实时涨跌幅', function () { return getChangePct('48', '883918'); }],
      ['上证指数 实时涨跌幅', function () { return getChangePct('hs', '1A0001'); }],
      ['涨停池家数+一字板 (' + prev + ')', async function () {
        const s = await getPoolStats('zt', prev); return s.total + ' 家，其中一字板 ' + s.oneWord + ' 家';
      }],
      ['炸板池家数 (' + prev + ')', async function () {
        const s = await getPoolStats('zb', prev); return s.total + ' 家';
      }]
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

  // 【推荐】一次写满全天：只需在收盘后跑一次，就能补齐当日 241 个点
  if (FULL) {
    const store = await collectFullDay();
    console.log('[collect] 全量落盘 ' + store.date + '：' + store.points.length + ' 个点，' +
      '基准日 ' + store.rate.date + '（非一字板封板率 ' + store.rate.fbl.toFixed(2) + '%）');
    console.log('[collect] 当日 self：' + (store.self
      ? '涨停 ' + store.self.zt + ' / 炸板 ' + store.self.zb + ' / 一字板 ' + store.self.oneWord +
        ' → 非一字板封板率 ' + (store.self.fbl == null ? '--' : store.self.fbl.toFixed(2) + '%')
      : '未写（接口不可用，或盘中跑被守卫挡住）'));
    console.log('[collect] 末点 ' + JSON.stringify(store.points[store.points.length - 1]));
    return;
  }

  const rateInfo = await resolveRate(todayNum);
  if (!rateInfo) {
    console.error('[collect] 未能取得昨日封板率，退出');
    process.exit(1);
  }
  console.log('[collect] 基准日 ' + rateInfo.date +
    '：涨停 ' + rateInfo.zt + '（其中一字板 ' + rateInfo.oneWord + '）/ 炸板 ' + rateInfo.zb +
    '\n           总封板率 ' + rateInfo.rate.toFixed(2) + '%  |  非一字板封板率 ' +
    rateInfo.fbl.toFixed(2) + '%  炸板率 ' + rateInfo.zbl.toFixed(2) + '%');

  // 顺手把历史欠账补上（rateInfo 就是前一交易日自己的家数）
  backfillSelf(rateInfo);

  // 今天自己的家数 = 次日公式要用的基准（收盘后才写，盘中会被 selfUsable 挡住）
  let selfInfo = null;
  if (selfUsable(todayNum)) {
    try { selfInfo = await resolveSelf(todayNum); } catch (e) { selfInfo = null; }
    if (selfInfo) console.log('[collect] 当日家数 self：涨停 ' + selfInfo.zt + ' / 炸板 ' + selfInfo.zb +
      ' / 一字板 ' + selfInfo.oneWord +
      ' → 非一字板封板率 ' + (selfInfo.fbl == null ? '--' : selfInfo.fbl.toFixed(2) + '%'));
  }

  // 供前端读取「昨日封板率」（前端不直连 data.10jqka.com.cn，其 CORS 依赖 Referer）
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'latest.json'), JSON.stringify({
    date: dateStr,
    rate: rateInfo,
    self: selfInfo,
    updated: new Date().toISOString()
  }, null, 1));

  let store = readStore(dateStr) || { date: dateStr, rate: rateInfo, points: [] };
  store.rate = rateInfo;
  if (selfInfo) store.self = selfInfo;
  if (!Array.isArray(store.points)) store.points = [];

  if (ONCE) {
    const s = await sampleOnce(rateInfo);
    const key = hmStr(bjNow());
    store.points.push({ t: key, v: s.v, v2: s.v2, a: s.a, b: s.b, c: s.c });
    writeStore(dateStr, store);
    console.log('[collect] 单次采集完成 ' + key + ' → ①=' + s.v + '  ②=' + s.v2 +
      '（883900=' + s.a + '%  883918=' + s.c + '%  上证=' + s.b + '%）');
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
          store.points.push({ t: key, v: s.v, v2: s.v2, a: s.a, b: s.b, c: s.c });
          store.points.sort(function (x, y) { return x.t < y.t ? -1 : 1; });
          writeStore(dateStr, store);
          console.log('  ' + key + '  ①=' + s.v + '  ②=' + s.v2 +
            '  (883900=' + s.a + '%  883918=' + s.c + '%  上证=' + s.b + '%)');
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
