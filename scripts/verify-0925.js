/* 专测「交易日 09:25 翻到新交易日」。
 *
 * 场景（时间冻结在 2026-10-14 09:26，周三，集合竞价刚撮合完）：
 *   - 分时接口返回的是「上一交易日 10-13 的完整分时 + date 却标成今天」——张冠李戴
 *   - 涨停池里今天已有 10 家（全部一字板，首封 09:25:00），炸板池 0 家
 *   - realhead 快照给出今日开盘价
 * 期望：页面切到今天、用开盘读数算出①、曲线上出现 09:25 那一个点，
 *       并且**绝不能**把昨天的曲线当成今天画出来。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) fail++; };

// ============ 冻结时钟：2026-10-14 09:26 北京时间 ============
const FROZEN = Date.parse('2026-10-14T01:26:00Z');
const RealDate = Date;
let clock = FROZEN;
global.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(clock); else super(...a); }
  static now() { return clock; }
};
const p2 = n => (n < 10 ? '0' : '') + n;

// ---- 分时 JSONP：上一交易日 10-13 的完整序列，date 字段却写成今天（要能识别并丢弃）----
function mislabeledSeries(cb, pre, drift) {
  const rows = [];
  let m = 9 * 60 + 30;
  for (let i = 0; i < 241; i++) {
    rows.push(p2(Math.floor(m / 60)) + p2(m % 60) + ',' + (pre * (1 + drift + i * 0.00005)).toFixed(3) + ',1000');
    m++; if (m === 11 * 60 + 31) m = 13 * 60;
  }
  return 'quotebridge_v6_time_' + cb + '({"' + cb + '":{"date":"20261014","pre":"' + (pre * 0.98).toFixed(3) +
    '","data":"' + rows.join(';') + '"}})';
}
// ---- realhead JSONP：字段 6=昨收、7=今开、8=高、9=低、10=现价 ----
function realhead(cb, pre, open) {
  return 'quotebridge_v6_realhead_' + cb + '_defer_last({"items":{' +
    '"6":"' + pre.toFixed(3) + '","7":"' + open.toFixed(3) + '","8":"' + (open * 1.003).toFixed(3) +
    '","9":"' + (open * 0.997).toFixed(3) + '","10":"' + open.toFixed(3) + '","199112":"' +
    ((open / pre - 1) * 100).toFixed(2) + '"}})';
}

const OPEN = { '48_883900': { pre: 3785.093, open: 3856.333 }, 'hs_1A0001': { pre: 3800.86, open: 3790.63 },
               '48_883918': { pre: 437.714, open: 431.280 } };
const POOL_F = '199112,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004,3475915,3475916,330326,330327,330328';

const fetched = [];
function resp(text, json) { return { ok: true, status: 200, text: async () => text, json: async () => json }; }
global.fetch = async function (url) {
  const u = String(url); fetched.push(u);
  for (const cb of Object.keys(OPEN)) {
    if (u.indexOf('/v6/time/' + cb + '/last.js') >= 0) {
      const o = OPEN[cb];
      return resp(mislabeledSeries(cb, o.open, 0.0), null);   // 收盘价故意给成开盘价附近
    }
    if (u.indexOf('/v6/realhead/' + cb + '/defer/last.js') >= 0) {
      const o = OPEN[cb];
      return resp(realhead(cb, o.pre, o.open), null);
    }
  }
  if (u.indexOf('data/index.json') >= 0) return resp(null, { dates: ['2026-10-13'] });
  if (u.indexOf('data/2026-10-13.json') >= 0) return resp(null, {
    date: '2026-10-13', rate: { date: '20261012', zt: 46, zb: 25, oneWord: 5, base: 41, rate: 64.7887, fbl: 62.1212 },
    points: [{ t: '09:30', a: 2.677, b: -0.179, c: -3.247 }, { t: '15:00', a: 1.712, b: -0.434, c: -4.147 }]
  });
  const dm = u.match(/date=(\d{8})/);
  const dateNum = dm ? dm[1] : '';
  if (u.indexOf('open_limit_pool') >= 0) {
    // 今天(10-14)炸板 0 家；昨天(10-13)炸板 19 家
    return resp(null, { data: { page: { total: dateNum === '20261014' ? 0 : 19 }, info: [] } });
  }
  if (u.indexOf('limit_up_pool') >= 0) {
    if (dateNum === '20261014') {
      // 今天：10 家，全部一字板，首封时间 = 2026-10-14 09:25:00（北京时间）
      const ts = Math.floor(Date.parse('2026-10-14T01:25:00Z') / 1000);
      return resp(null, { data: { page: { total: 10 }, info: Array.from({ length: 10 }, () => ({ first_limit_up_time: ts, limit_up_type: '一字板' })) } });
    }
    // 昨天：67 家涨停 / 3 家一字板
    const ts0 = Math.floor(Date.parse('2026-10-13T01:40:00Z') / 1000);
    return resp(null, { data: { page: { total: 67 }, info: [
      { first_limit_up_time: ts0, limit_up_type: '一字板' }, { first_limit_up_time: ts0, limit_up_type: '一字板' },
      { first_limit_up_time: ts0, limit_up_type: '一字板' }, { first_limit_up_time: ts0, limit_up_type: '换手板' }
    ] } });
  }
  throw new Error('未预料的请求：' + u);
};

// ---- DOM / ECharts / Worker 桩 ----
function mkEl(id) {
  return { id, textContent: '', className: '', innerHTML: '', _attrs: {}, _handlers: {}, _children: [],
    getAttribute(k) { return this._attrs[k]; }, addEventListener(t, f) { this._handlers[t] = f; },
    querySelectorAll() { return this._children; }, closest() { return null; } };
}
const els = {};
global.document = {
  title: '打板情绪看板 · 涨停情绪指数 & 打板收益',
  hidden: false,
  getElementById: id => (els[id] = els[id] || mkEl(id)),
  createElement: () => ({ style: {}, setAttribute() {}, remove() {}, parentNode: null }),
  addEventListener() {}, removeEventListener() {}
};
global.window = { addEventListener() {} };
let chartN = 0; const drawn = {};
global.echarts = { init() { chartN++; const k = 'chart' + chartN; return { clear() {}, resize() {}, setOption(o) { drawn[k] = o; } }; } };
global.Blob = class { constructor(p) { this.parts = p; } };
global.URL = { createObjectURL: () => 'blob:stub' };
let wk = null;
global.Worker = function () { wk = { onmessage: null, onerror: null, postMessage() {}, terminate() {} }; return wk; };
global.setInterval = () => 1;
global.clearInterval = () => {};

// ============ 先单测时段边界（09:24 / 09:25 / 09:30 的分界最容易写错）============
{
  const lines = src.split('\n');
  const r1s = lines.findIndex(l => /^\s*var BASE = /.test(l));
  const r1e = lines.findIndex(l => /==================== JSONP/.test(l)) - 1;
  const r2s = lines.findIndex(l => /==================== 主流程/.test(l));
  const r2e = lines.findIndex(l => /^\s*async function refresh\(\)/.test(l)) - 1;
  const code = lines.slice(r1s, r1e + 1).join('\n') + '\n' + lines.slice(r2s, r2e + 1).join('\n');
  const S = new Function(code + '\nreturn { phaseText, inSession, todayStarted, DAY_TICKS, AUCTION_END, OPEN_MIN };')();
  // bjNow() 返回 Date.now()+8h，所以「北京时间 h:m」= new Date(Date.UTC(2026,9,14,h,m))
  const at = (h, m) => new Date(Date.UTC(2026, 9, 14, h, m));
  const sat = new Date(Date.UTC(2026, 9, 17, 9, 26));   // 2026-10-17 是周六

  console.log('[0] 时段边界（2026-10-14 周三）');
  ok(S.DAY_TICKS.length === 243 && S.DAY_TICKS[0] === '09:25' && S.DAY_TICKS[1] === '09:30',
    '分钟刻度 = ' + S.DAY_TICKS.length + ' 个：' + S.DAY_TICKS[0] + ' → ' + S.DAY_TICKS[1] + ' → … → ' + S.DAY_TICKS[242]);
  ok(S.phaseText(at(9, 14)) === '盘前', '09:14 → ' + S.phaseText(at(9, 14)));
  ok(S.phaseText(at(9, 15)) === '集合竞价中', '09:15 → ' + S.phaseText(at(9, 15)));
  ok(S.phaseText(at(9, 24)) === '集合竞价中', '09:24 → ' + S.phaseText(at(9, 24)));
  ok(S.phaseText(at(9, 25)) === '集合竞价已结束', '09:25 → ' + S.phaseText(at(9, 25)) + '  ★ 用户要的这个点');
  ok(S.phaseText(at(9, 29)) === '集合竞价已结束', '09:29 → ' + S.phaseText(at(9, 29)));
  ok(S.phaseText(at(9, 30)) === '盘中 · 早盘', '09:30 → ' + S.phaseText(at(9, 30)));
  ok(S.phaseText(at(15, 0)) === '盘中 · 午盘' && S.phaseText(at(15, 1)) === '盘后',
    '15:00 → ' + S.phaseText(at(15, 0)) + '，15:01 → ' + S.phaseText(at(15, 1)));
  ok(S.todayStarted(at(9, 24)) === false && S.todayStarted(at(9, 25)) === true,
    '今天是否已开盘：09:24 = ' + S.todayStarted(at(9, 24)) + '，09:25 = ' + S.todayStarted(at(9, 25)));
  ok(S.todayStarted(sat) === false, '周六 09:26 → ' + S.todayStarted(sat) + '（不给休市日造开盘点）');
  ok(S.inSession(at(9, 25)) === false && S.inSession(at(9, 30)) === true,
    '连续竞价时段：09:25 = ' + S.inSession(at(9, 25)) + '，09:30 = ' + S.inSession(at(9, 30)));
  console.log('');
}

console.log('在沙箱里执行整个 app.js（冻结在 2026-10-14 09:26 BJT）…\n');
try { new Function(src)(); }
catch (e) { console.log('  ✘ 启动抛异常：' + e.message); process.exit(1); }
ok(true, '启动无异常');

function until(cond, ms) {
  const t0 = RealDate.now();
  return new Promise(resolve => {
    (function loop() {
      if (cond() || RealDate.now() - t0 > (ms || 8000)) return resolve(cond());
      setTimeout(loop, 50);
    })();
  });
}

(async () => {
  const done = await until(() => chartN >= 2, 8000);
  console.log('  图表实例数 =', chartN, done ? '（已画完）' : '（超时）');
  if ((els['errBox'] && els['errBox'].textContent)) console.log('!! refresh 内部报错：' + els['errBox'].textContent);

  console.log('\n[1] 「今日」判定没有被昨天的数据带偏');
  ok(fetched.some(u => u.indexOf('/v6/realhead/48_883900') >= 0), '取过 realhead 快照');
  ok(fetched.some(u => /limit_up_pool.*date=20261014/.test(u)), '查过今天的涨停池');
  ok(fetched.some(u => /limit_up_pool.*date=20261013/.test(u)), '也查过昨天的涨停池（用作①的基准）');

  console.log('\n[2] 顶部数值用的是今天的开盘读数，不是昨天的曲线');
  ok(els['aText'].textContent === '+1.88%',
    '883900 今日涨跌幅 = ' + els['aText'].textContent + '（昨收 3785.093 → 开盘 3856.333）');
  ok(els['shText'].textContent === '-0.27%', '上证今日涨跌幅 = ' + els['shText'].textContent);
  ok(/^-?\d+\.\d{4}$/.test(els['curValue'].textContent), '① 涨停情绪指数 = ' + els['curValue'].textContent);
  ok(els['curValue'].textContent !== '--' && els['curValue'].textContent !== '0.0000', '① 有值（没被清成 --）');
  ok(els['lastPoint'].textContent === '09:25', '最新记录点 = ' + els['lastPoint'].textContent + '（集合竞价撮合点）');
  ok(/2026-10-14/.test(els['quoteTime'].textContent), '行情日期已翻成今天 = ' + els['quoteTime'].textContent);

  console.log('\n[3] 状态栏说清了「已到 09:25、分时还没开始」');
  ok(/集合竞价已结束/.test(els['liveText'].textContent), '状态 = ' + els['liveText'].textContent);
  ok(!/存档/.test(els['liveText'].textContent), '没有退化成［暂用最近交易日存档］');
  ok(!/⏱|已收盘/.test(els['liveText'].textContent), '没有误判成已收盘');

  console.log('\n[4] 曲线上只有 09:25 一个点 —— 昨天的曲线没被冒充成今天');
  const opt = drawn[Object.keys(drawn)[0]];
  const ser = opt.series[0];
  ok(ser.data.length === 1, '系列点数 = ' + ser.data.length + '（不是 241 个，说明昨天的数据已被丢弃）');
  ok(ser.data[0][0] === '09:25', '唯一那个点的时刻 = ' + ser.data[0][0]);
  ok(ser.symbol === 'circle' && ser.showSymbol === true, '单点也可见（symbol=' + ser.symbol + '）');
  ok(opt.xAxis.data[0] === '09:25' && opt.xAxis.data.length === 243,
    '横轴 = ' + opt.xAxis.data.length + ' 个刻度，首个是 ' + opt.xAxis.data[0]);

  console.log('\n[5] 今日封板率（09:25 全靠涨停池家数）');
  ok(/封板率 100\.00%/.test(els['curRate'].textContent),
    '总封板率 = ' + els['curRate'].textContent + '（10 家全是一字板）');
  ok(els['curRate2'].textContent === '--',
    '② 的非一字板封板率 = ' + els['curRate2'].textContent + '（非一字板涨停 0 家，分母为 0，本就该是 --）');

  console.log('\n[6] 悬停提示里写明了算式，并区分「今日」与「昨日」');
  const t1 = els['curRate'].title || '';
  ok(/今日实时/.test(t1) && /涨停 10 家/.test(t1),
    '① 后的提示含算式：' + (t1.split('\n')[1] || ''));
  ok(/昨日/.test(t1), '并点明 ① 公式用的是「昨日」基准：' + (t1.split('\n').find(l => /昨日/.test(l)) || '').slice(0, 60));
  ok(/同花顺/.test(t1), '标注了数据源');
  const t2 = els['curRate2'].title || '';
  ok(/非一字板/.test(t2), '② 后的提示讲的是非一字板口径：' + (t2.split('\n')[0]));
  ok(/0 家/.test(t2) || /无法计算/.test(t2),
    '并解释了为什么这里是 --　→「' + (t2.split('\n')[1] || '') + '」');

  console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 全部通过'));
  process.exit(fail ? 1 : 0);
})();
