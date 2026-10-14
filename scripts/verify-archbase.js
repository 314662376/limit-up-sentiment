/* 归档回退的「基准日」正确性回归。
 *
 * 背景（这次真踩到的坑）：
 *   data/<D>.json 里的 rate 存的是 D-1 的家数（给 D 当天算公式用），并不含 D 自己的家数。
 *   于是「盘中 + 涨停池接口不可用」退回存档时，如果只看 latest.json，拿到的是
 *   「最后一个已归档交易日 B 的 rate」= B-1 的家数 —— 比正确的（B 的家数）早整整一天。
 *   现象很隐蔽：页面照常出数，只是「昨日非一字板封板率」悄悄错了，还标着错误的基准日。
 *
 * 三个场景各自在独立子进程里跑一遍整份 app.js（全局桩互不污染）：
 *   A 新格式：归档里有 self        → 基准应落在「上一交易日」，值 = 那个交易日的自家家数
 *   B 老格式：任何归档都没有 self  → 只能退回上两个交易日，且必须带［存档］标注（已知残留）
 *   C 当天已有归档（收盘后重开）    → 用它的 rate，基准同样落在「上一交易日」
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) fail++; };

/* ---------------- 各交易日的家数（数字都挑得不重复，便于一眼看出串没串天） ---------------- */
const cnt = (ymd, zt, zb, oneWord) => {
  const base = zt - oneWord, d0 = zt + zb, d1 = base + zb;
  return {
    date: ymd, zt, zb, oneWord, base,
    rate: +(zt / d0 * 100).toFixed(4),
    fbl: +(base / d1 * 100).toFixed(4),
    zbl: +(zb / d1 * 100).toFixed(4)
  };
};
const K_1009 = cnt('20261009', 69, 13, 3);   // 非一字板封板率 83.5443%
const K_1012 = cnt('20261012', 46, 25, 5);   // 62.1212%
const K_1013 = cnt('20261013', 55, 10, 4);   // 83.6066%

const POINTS = [
  { t: '09:30', a: 2.677, b: -0.179, c: -3.247 },
  { t: '10:30', a: 2.4, b: -0.2, c: -3.1 },
  { t: '15:00', a: 1.712, b: -0.434, c: -4.147 }
];

const SCENARIOS = {
  A: {
    desc: '新格式：归档里有 self（collect.js 落盘时写的当天自家家数）',
    index: ['2026-10-12', '2026-10-13'],
    archives: {
      '2026-10-12': { date: '2026-10-12', rate: K_1009, self: K_1012, points: POINTS },
      '2026-10-13': { date: '2026-10-13', rate: K_1012, self: K_1013, points: POINTS }
    },
    latest: { date: '2026-10-13', rate: K_1012, self: K_1013 },
    expectFbl: 83.61, expectBase: '20261013'
  },
  B: {
    desc: '老格式：所有归档都没有 self（10-13 前后采集的历史文件）',
    index: ['2026-10-12', '2026-10-13'],
    archives: {
      '2026-10-12': { date: '2026-10-12', rate: K_1009, points: POINTS },
      '2026-10-13': { date: '2026-10-13', rate: K_1012, points: POINTS }
    },
    latest: { date: '2026-10-13', rate: K_1012 },
    expectFbl: 62.12, expectBase: '20261012'      // 已知残留：只能退到上两个交易日
  },
  C: {
    desc: '当天自己已有归档（收盘后重开页面）',
    index: ['2026-10-12', '2026-10-13', '2026-10-14'],
    archives: {
      '2026-10-12': { date: '2026-10-12', rate: K_1009, self: K_1012, points: POINTS },
      '2026-10-13': { date: '2026-10-13', rate: K_1012, self: K_1013, points: POINTS },
      '2026-10-14': { date: '2026-10-14', rate: K_1013, self: cnt('20261014', 30, 12, 2), points: POINTS }
    },
    latest: { date: '2026-10-13', rate: K_1012, self: K_1013 },
    expectFbl: 83.61, expectBase: '20261013'
  }
};

/* ================================ 子进程：真跑一遍 app.js ================================ */
if (process.argv[2] === '--run') {
  const name = process.argv[3];
  const S = SCENARIOS[name];
  const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');

  // 冻结时钟：2026-10-14 15:30 北京时间（周三、已收盘）
  const RealDate = Date;
  const clock = RealDate.parse('2026-10-14T07:30:00Z');
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(clock); else super(...a); }
    static now() { return clock; }
  };

  const pad2 = n => (n < 10 ? '0' : '') + n;
  function series(cb, date, pre, drift) {
    const rows = [];
    let m = 9 * 60 + 30;
    for (let i = 0; i < 241; i++) {
      rows.push(pad2(Math.floor(m / 60)) + pad2(m % 60) + ',' + (pre * (1 + drift + i * 0.0002)).toFixed(3) + ',1000');
      m++;
      if (m === 11 * 60 + 31) m = 13 * 60;
    }
    return 'quotebridge_v6_time_' + cb + '({"' + cb + '":{"date":"' + date +
      '","pre":"' + pre + '","data":"' + rows.join(';') + '"}})';
  }
  const resp = (text, json) => ({ ok: true, status: 200, text: async () => text, json: async () => json });
  const notFound = () => ({ ok: false, status: 404, text: async () => '', json: async () => null });

  const urls = [];
  global.fetch = async function (url) {
    const u = String(url);
    urls.push(u);
    // 分时：照常返回「今天」
    if (u.indexOf('/v6/time/48_883900') >= 0) return resp(series('48_883900', '20261014', 100, 0.016), null);
    if (u.indexOf('/v6/time/hs_1A0001') >= 0) return resp(series('hs_1A0001', '20261014', 3000, -0.002), null);
    if (u.indexOf('/v6/time/48_883918') >= 0) return resp(series('48_883918', '20261014', 100, -0.032), null);
    // 涨停池 / 炸板池：模拟本机出口 IP 被封（HTTP 403）
    if (u.indexOf('10jqka.com.cn/dataapi/limit_up') >= 0) throw new Error('HTTP 403');
    if (u.indexOf('data/index.json') >= 0) return resp(null, { dates: S.index.slice() });
    if (u.indexOf('data/latest.json') >= 0) return resp(null, S.latest);
    const m = u.match(/data\/(\d{4}-\d{2}-\d{2})\.json/);
    if (m) return S.archives[m[1]] ? resp(null, S.archives[m[1]]) : notFound();
    throw new Error('未预料的请求：' + u);
  };

  const els = {};
  const mkEl = id => ({
    id, textContent: '', className: '', innerHTML: '',
    _attrs: {}, _handlers: {}, _children: [],
    getAttribute(k) { return this._attrs[k]; },
    addEventListener(t, f) { this._handlers[t] = f; },
    querySelectorAll() { return this._children; },
    closest() { return null; }
  });
  global.document = {
    title: '打板情绪看板', hidden: false,
    getElementById: id => (els[id] = els[id] || mkEl(id)),
    createElement: () => ({ style: {}, setAttribute() {}, remove() {}, parentNode: null }),
    addEventListener() {}, removeEventListener() {}
  };
  global.window = { addEventListener() {}, removeEventListener() {} };
  let chartN = 0;
  global.echarts = { init() { chartN++; return { clear() {}, resize() {}, setOption() {} }; } };
  global.Blob = class { constructor(p) { this.parts = p; } };
  global.URL = { createObjectURL: () => 'blob:stub' };
  global.Worker = function () { return { onmessage: null, onerror: null, postMessage() {}, terminate() {} }; };
  global.setInterval = () => 1;
  global.clearInterval = () => {};

  try { new Function(src)(); } catch (e) {
    console.log('RESULT ' + JSON.stringify({ bootError: String(e && e.message) }));
    process.exit(0);
  }

  const t0 = RealDate.now();
  (function wait() {
    const ft = els['fblText'] ? els['fblText'].textContent : '';
    if (/基准日/.test(ft) || RealDate.now() - t0 > 8000) {
      console.log('RESULT ' + JSON.stringify({
        fblText: ft,
        rateText: els['rateText'] ? els['rateText'].textContent : '',
        liveText: els['liveText'] ? els['liveText'].textContent : '',
        curRate: els['curRate'] ? els['curRate'].textContent : '',
        poolQueries: urls.filter(u => u.indexOf('limit_up') >= 0).length,
        bootError: null
      }));
      process.exit(0);
    }
    setTimeout(wait, 50);
  })();
  return;
}

/* ================================ 主进程：逐场景断言 ================================ */
function run(name) {
  const out = execFileSync(process.execPath, [__filename, '--run', name], { encoding: 'utf8' });
  const line = out.split('\n').find(l => l.indexOf('RESULT ') === 0);
  if (!line) throw new Error('子进程没有输出结果：\n' + out);
  return JSON.parse(line.slice('RESULT '.length));
}

for (const name of Object.keys(SCENARIOS)) {
  const S = SCENARIOS[name];
  console.log('\n[场景 ' + name + '] ' + S.desc);
  const r = run(name);
  ok(!r.bootError, 'app.js 启动无异常' + (r.bootError ? '（' + r.bootError + '）' : ''));
  if (r.bootError) continue;

  const fbl = parseFloat(r.fblText);
  ok(Math.abs(fbl - S.expectFbl) < 0.005,
    '昨日非一字板封板率 = ' + fbl + '%（期望 ' + S.expectFbl + '%）');
  ok(r.fblText.indexOf('基准日 ' + S.expectBase) >= 0,
    '基准日标注 = ' + S.expectBase + ' —— ' + r.fblText.trim());
  ok(/［存档］/.test(r.fblText), '明确标注了这是存档回退值（不是直连）');
  ok(Math.abs(parseFloat(r.rateText) - 0) > 0 && /基准日/.test(r.rateText),
    '总封板率那一行也带基准日：' + r.rateText.trim());
  ok(r.poolQueries > 0, '确实尝试过直连涨停池（' + r.poolQueries + ' 次，全部 403）');
  ok(/直连失败|存档|已连接|请求数据/.test(r.liveText), '状态栏有可读提示：' + r.liveText);
}

console.log('\n' + (fail ? '❌ 有 ' + fail + ' 项未通过' : '✅ 全部通过'));
process.exit(fail ? 1 : 0);
