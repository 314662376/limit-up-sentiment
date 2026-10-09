#!/usr/bin/env node
'use strict';

/**
 * 历史回填：用同花顺历史分时接口，重建最近 N 个交易日的指标序列，
 * 这样页面一上线就有「5 日分时图」，不必等 Actions 逐日累积。
 *
 *   node scripts/backfill.js --days=5
 *
 * 指标：值(t) = 昨日封板率/100 × (883900涨跌幅%(t) ÷ 100) + 1 + 上证涨跌幅%(t) ÷ 20
 *
 * ⚠️⚠️ 实测（2026-10-09）：**同花顺 v6/time 接口无法按日期取历史分时**。
 *   路径里的日期会被忽略 —— 盘中访问返回当日实时数据，非交易时段返回最近一个完整交易日。
 *   因此本脚本对 883900 / 上证 这类标的**目前跑不出多日历史**（会被下面的日期校验挡下并跳过）。
 *   不要绕过这个校验，否则 data/ 里会塞进同一天的 N 份拷贝（曾真实发生过）。
 *   5 日图目前只能靠 GitHub Actions 逐交易日累积。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const daysArg = process.argv.find(function (a) { return a.indexOf('--days=') === 0; });
const N = daysArg ? parseInt(daysArg.split('=')[1], 10) : 5;

function pad(n) { return (n < 10 ? '0' : '') + n; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function fmtDate(n) { return String(n).slice(0, 4) + '-' + String(n).slice(4, 6) + '-' + String(n).slice(6, 8); }
function shiftYmdNum(n, delta) {
  const y = Math.floor(n / 10000), m = Math.floor(n / 100) % 100, d = n % 100;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
}

async function fetchText(url, referer) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Referer': referer || 'https://stockpage.10jqka.com.cn/',
      'Accept': '*/*'
    }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return res.text();
}

async function fetchJsonp(url, referer) {
  const text = await fetchText(url, referer);
  const m = text.match(/\(([\s\S]*)\)\s*;?\s*$/);
  if (!m) throw new Error('bad jsonp: ' + url);
  return JSON.parse(m[1]);
}

async function retry(fn, times) {
  let last = null;
  for (let i = 0; i <= times; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < times) await sleep(900); }
  }
  throw last;
}

// 已收盘的最近 n 个交易日（取自上证指数日K）
async function getRecentTradingDays(n) {
  const d = await retry(function () {
    return fetchJsonp('https://d.10jqka.com.cn/v6/line/hs_1A0001/01/last.js');
  }, 2);
  const rows = d.data.split(';').filter(Boolean);
  const days = rows.map(function (r) { return r.split(',')[0]; });
  return days.slice(-n);
}

// 某个交易日的分时序列
async function getTimeSeries(prefix, code, dateNum) {
  const d = await retry(function () {
    return fetchJsonp('https://d.10jqka.com.cn/v6/time/' + prefix + '_' + code + '/' + dateNum + '.js');
  }, 2);
  const pack = d[prefix + '_' + code];
  if (!pack || !pack.data) throw new Error('no time data ' + code + ' ' + dateNum);
  // ⚠️ 同花顺 v6/time 对板块指数**不支持按日期取历史分时**：
  //    盘中被访问时返回「当日实时」，非交易时段返回「最近一个完整交易日」，
  //    路径里的日期实际被忽略。不校验的话，会把同一天的数据当成 N 天写进 data/。
  if (String(pack.date) !== String(dateNum)) {
    throw new Error('返回日期不符：请求 ' + dateNum + '，实际 ' + pack.date +
      '（同花顺 v6/time 不支持按日期取板块历史分时）');
  }
  const pre = parseFloat(pack.pre);
  const out = [];
  pack.data.split(';').forEach(function (r) {
    const p = r.split(',');
    if (p.length < 2 || !p[1]) return;
    const price = parseFloat(p[1]);
    if (!isFinite(price)) return;
    out.push({
      t: String(p[0]).slice(0, 2) + ':' + String(p[0]).slice(2),
      pct: pre > 0 ? (price / pre - 1) * 100 : null
    });
  });
  return out;
}

// 涨停池 / 炸板池家数
async function getPoolTotal(kind, dateNum) {
  const api = kind === 'zt' ? 'limit_up_pool' : 'open_limit_pool';
  const url = 'https://data.10jqka.com.cn/dataapi/limit_up/' + api +
    '?page=1&limit=1&field=199112&filter=HS,GEM2STAR&order_field=330324&order_type=0&date=' + dateNum;
  const text = await fetchText(url, 'https://data.10jqka.com.cn/');
  const d = JSON.parse(text);
  const total = d && d.data && d.data.page ? d.data.page.total : null;
  return typeof total === 'number' ? total : null;
}

async function getRate(dateNum) {
  const zt = await retry(function () { return getPoolTotal('zt', dateNum); }, 1);
  const zb = (await retry(function () { return getPoolTotal('zb', dateNum); }, 1)) || 0;
  if (!zt || zt <= 0) return null;
  const denom = zt + zb;
  return { date: String(dateNum), zt: zt, zb: zb, rate: denom > 0 ? (zt / denom) * 100 : null };
}

// 指标值（涨跌幅按「小数口径」参与计算）
//   v = 封板率/100 × (883900涨跌幅% ÷ 100) + 1 + (上证涨跌幅% ÷ 100) ÷ 20
function computeValue(ratePct, a, b) {
  // 对应 Excel 式 =C3/100*D3+1+E3/20：883900 按小数代入，上证按百分点代入（不除 100）
  return (ratePct / 100) * (a / 100) + 1 + b / 20;
}

async function main() {
  console.log('[backfill] 目标 ' + N + ' 个交易日');

  const days = await retry(function () { return getRecentTradingDays(N + 1); }, 2);
  if (days.length < 2) throw new Error('交易日不足');
  console.log('[backfill] 交易日：' + days.join(', '));

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // 逐日：第 i 天的「昨日封板率」取第 i-1 天的池子
  const targets = days.slice(-N);
  for (let i = 0; i < targets.length; i++) {
    const dateNum = targets[i];
    const idx = days.indexOf(dateNum);
    const prevNum = days[idx - 1];

    let rate = null;
    try { rate = await getRate(prevNum); } catch (e) { console.error('  取封板率失败', prevNum, e.message); }
    if (!rate) { console.error('  跳过 ' + dateNum + '（无封板率基准）'); continue; }

    let aSeries = null, bSeries = null;
    try {
      aSeries = await getTimeSeries('48', '883900', dateNum);
      await sleep(400);
      bSeries = await getTimeSeries('hs', '1A0001', dateNum);
    } catch (e) {
      console.error('  跳过 ' + dateNum + '（分时取数失败：' + e.message + '）');
      continue;
    }

    const bMap = {};
    bSeries.forEach(function (x) { bMap[x.t] = x.pct; });

    const points = [];
    aSeries.forEach(function (x) {
      const b = bMap[x.t];
      if (x.pct == null || b == null) return;
      points.push({
        t: x.t,
        v: +computeValue(rate.rate, x.pct, b).toFixed(4),
        a: +x.pct.toFixed(3),
        b: +b.toFixed(3)
      });
    });

    const store = { date: fmtDate(dateNum), rate: rate, points: points, source: 'backfill' };
    fs.writeFileSync(path.join(DATA_DIR, store.date + '.json'), JSON.stringify(store, null, 1));
    console.log('  ' + store.date + '  ' + points.length + ' 点  封板率 ' + rate.rate.toFixed(2) +
      '%（' + rate.zt + '/' + (rate.zt + rate.zb) + '，基准日 ' + rate.date + '）');
    await sleep(500);
  }

  // index.json
  const dates = fs.readdirSync(DATA_DIR)
    .filter(function (f) { return /^\d{4}-\d{2}-\d{2}\.json$/.test(f); })
    .map(function (f) { return f.replace('.json', ''); })
    .sort();
  fs.writeFileSync(path.join(DATA_DIR, 'index.json'), JSON.stringify({ dates: dates }, null, 1));
  console.log('[backfill] 完成，data/ 共 ' + dates.length + ' 天');

  // latest.json：给最后一个回填日的「下一交易日」准备封板率基准
  const lastDay = targets[targets.length - 1];
  try {
    const nr = await getRate(lastDay);
    if (nr) {
      fs.writeFileSync(path.join(DATA_DIR, 'latest.json'), JSON.stringify({
        date: fmtDate(shiftYmdNum(parseInt(lastDay, 10), 1)),
        rate: nr,
        updated: new Date().toISOString()
      }, null, 1));
      console.log('[backfill] latest.json → 下一交易日封板率 ' + nr.rate.toFixed(2) +
        '%（' + nr.zt + '/' + (nr.zt + nr.zb) + '，基准日 ' + nr.date + '）');
    }
  } catch (e) {
    console.error('[backfill] latest.json 生成失败：' + e.message);
  }
}

main().catch(function (e) {
  console.error('[backfill] 失败', e);
  process.exit(1);
});
