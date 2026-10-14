/* 整文件端到端冒烟：把 app.js 原文在沙箱里跑一遍（桩掉 DOM / ECharts / fetch / Worker / 计时器），
 * 走完真实的 refresh() 全流程，确认：
 *   - 启动不抛异常（能抓到拼错的变量名、漏掉的函数）
 *   - 新加的「Worker 心跳 + 标签栏标题」和 refresh() 真的接上了
 *   - 两条指数都算出了值，状态栏、图例、图表都被正确写过
 * 这不是单元测试，是「整个页面能不能活」的检查。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) fail++; };

// ---------- 冻结时钟：2026-10-13 10:30 北京时间（周二、盘中）----------
const FROZEN = Date.parse('2026-10-13T02:30:00Z');
const RealDate = Date;
let clock = FROZEN;
global.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(clock); else super(...a); }
  static now() { return clock; }
};

const pad2 = n => (n < 10 ? '0' : '') + n;

// 造一段分时 JSONP：09:30 起每分钟一个点，跳过午休
function series(cb, date, pre, n, drift) {
  const rows = [];
  let m = 9 * 60 + 30;
  for (let i = 0; i < n; i++) {
    const t = pad2(Math.floor(m / 60)) + pad2(m % 60);
    rows.push(t + ',' + (pre * (1 + drift + i * 0.0002)).toFixed(3) + ',1000');
    m++;
    if (m === 11 * 60 + 31) m = 13 * 60;
  }
  return 'quotebridge_v6_time_' + cb + '({"' + cb + '":{"date":"' + date +
    '","pre":"' + pre + '","data":"' + rows.join(';') + '"}})';
}

// 注意：fetchPool 里是 `return (j && j.data) ? j.data : null`，真实的载荷包在 data 里
const POOL_ZT = {
  status_code: 0,
  data: {
    page: { total: 46 },
    info: [
      { first_limit_up_time: 0, limit_up_type: '换手板' },
      { first_limit_up_time: 0, limit_up_type: '一字板' },
      { first_limit_up_time: 0, limit_up_type: '一字板' },
      { first_limit_up_time: 0, limit_up_type: '一字板' },
      { first_limit_up_time: 0, limit_up_type: '一字板' },
      { first_limit_up_time: 0, limit_up_type: '一字板' }
    ]
  }
};
const POOL_ZB = { status_code: 0, data: { page: { total: 25 }, info: [] } };
const ARCHIVE = {
  date: '2026-10-12',
  rate: { date: '20261009', zt: 69, zb: 13, oneWord: 3, base: 66, rate: 84.1463, fbl: 83.5443, zbl: 16.4557 },
  points: [
    { t: '09:30', a: 2.677, b: -0.179, c: -3.247 },
    { t: '09:31', a: 2.5, b: -0.2, c: -3.3 },
    { t: '15:00', a: 1.712, b: -0.434, c: -4.147 }
  ]
};

const fetchedUrls = [];
function mkResp(text, json) {
  return {
    ok: true, status: 200,
    text: async () => text,
    json: async () => json
  };
}
global.fetch = async function (url) {
  const u = String(url);
  fetchedUrls.push(u);
  if (u.indexOf('d.10jqka.com.cn/v6/time/48_883900') >= 0) return mkResp(series('48_883900', '20261013', 100, 51, 0.016));
  if (u.indexOf('d.10jqka.com.cn/v6/time/hs_1A0001') >= 0) return mkResp(series('hs_1A0001', '20261013', 3000, 51, -0.002));
  if (u.indexOf('d.10jqka.com.cn/v6/time/48_883918') >= 0) return mkResp(series('48_883918', '20261013', 100, 51, -0.032));
  if (u.indexOf('data/index.json') >= 0) return mkResp(null, { dates: ['2026-10-12'] });
  if (u.indexOf('data/2026-10-12.json') >= 0) return mkResp(null, ARCHIVE);
  if (u.indexOf('open_limit_pool') >= 0) return mkResp(null, POOL_ZB);
  if (u.indexOf('limit_up_pool') >= 0) return mkResp(null, POOL_ZT);
  throw new Error('未预料的请求：' + u);
};

// ---------- DOM ----------
function mkEl(id) {
  return {
    id, textContent: '', className: '', innerHTML: '',
    _attrs: {}, _handlers: {}, _children: [],
    getAttribute(k) { return this._attrs[k]; },
    addEventListener(t, f) { this._handlers[t] = f; },
    querySelectorAll() { return this._children; },
    // bindTabs 用 e.target.closest('button[data-v]') 找被点的按钮
    closest(sel) {
      return (sel === 'button[data-v]' && this._attrs['data-v']) ? this : null;
    }
  };
}
const els = {};
const docListeners = {}, winListeners = {};
// 预置视图切换按钮，让 bindTabs 能真的绑上
const btn1d = mkEl('btn1d'); btn1d._attrs = { 'data-v': '1d' };
const btn5d = mkEl('btn5d'); btn5d._attrs = { 'data-v': '5d' };
els['viewTabs'] = mkEl('viewTabs'); els['viewTabs']._children = [btn1d, btn5d];

global.document = {
  title: '打板情绪看板 · 涨停情绪指数 & 打板收益',
  hidden: false,
  getElementById: id => (els[id] = els[id] || mkEl(id)),
  createElement: () => ({ style: {}, setAttribute() {}, remove() {}, parentNode: null }),
  addEventListener: (t, f) => { docListeners[t] = f; },
  removeEventListener() {}
};
global.window = {
  addEventListener: (t, f) => { winListeners[t] = f; },
  removeEventListener() {}
};

// ---------- ECharts ----------
let chartCount = 0;
const drawn = {};
global.echarts = {
  init: function () {
    chartCount++;
    const id = 'chart' + chartCount;
    return {
      clear() {}, resize() {},
      setOption(o) { drawn[id] = o; }
    };
  }
};

// ---------- Worker ----------
const workerLog = [];
global.Blob = class { constructor(p) { this.parts = p; } };
global.URL = { createObjectURL: () => 'blob:stub' };
let stubWorker = null;
global.Worker = function () {
  workerLog.push('created');
  stubWorker = { onmessage: null, onerror: null, postMessage: m => workerLog.push('post:' + m), terminate: () => workerLog.push('terminate') };
  return stubWorker;
};

// ---------- 计时器：setInterval 桩掉（免得进程挂着），setTimeout 保留真实行为 ----------
const intervals = [];
global.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
global.clearInterval = id => { workerLog.push('clearInterval:' + id); };

// ---------- 跑起来 ----------
console.log('在沙箱里执行整个 app.js（' + src.length + ' 字节）…\n');
try {
  new Function(src)();
} catch (e) {
  console.log('  ✘ 启动抛异常：' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
  process.exit(1);
}
ok(true, '启动无异常（bindTabs / refresh / startHeartbeat 全部执行）');
ok(workerLog.indexOf('created') >= 0, '心跳已创建 Web Worker（成功路径）');
ok(intervals.length === 0, '没有退回主线程 setInterval（intervals=' + intervals.length + '）');
ok(typeof stubWorker.onmessage === 'function', 'Worker 的 onmessage 已挂上');

console.log('\n等待真实的 refresh() 异步流程跑完…');
// refresh 内部有几处 sleep(140/160)，固定等待容易卡在半路 —— 改成轮询到画完为止
function until(cond, ms) {
  const t0 = RealDate.now();          // 注意：不能用被冻结的 Date.now()，否则「已超时」一上来就成立
  return new Promise(resolve => {
    (function loop() {
      if (cond() || RealDate.now() - t0 > (ms || 8000)) return resolve(cond());
      setTimeout(loop, 50);
    })();
  });
}
(async () => {
  const done = await until(() => chartCount >= 2, 8000);
  console.log('  图表实例数 =', chartCount, done ? '（已画完）' : '（超时）');

  // 先把 refresh 内部被 catch 吞掉的错误挖出来（否则现象会离奇地偏移到后面几步）
  if ((els['errBox'] && els['errBox'].textContent) || /异常/.test(els['liveText'].textContent)) {
    console.log('!! refresh() 内部抛错了 —— 状态栏：' + els['liveText'].textContent);
    console.log('!! 错误框：' + (els['errBox'] ? els['errBox'].textContent : '(无)'));
  }

  console.log('\n[1] 启动链路');
  ok(fetchedUrls.some(u => u.indexOf('/v6/time/48_883900') >= 0), '取过 883900 分时');
  ok(fetchedUrls.some(u => u.indexOf('/v6/time/hs_1A0001') >= 0), '取过上证分时');
  ok(fetchedUrls.some(u => u.indexOf('/v6/time/48_883918') >= 0), '取过 883918 分时');
  ok(fetchedUrls.some(u => u.indexOf('limit_up_pool') >= 0), '取过涨停池（算基准封板率）');
  ok(fetchedUrls.some(u => u.indexOf('data/index.json') >= 0), '取过历史索引（5 日图数据源）');
  ok(chartCount === 2, '创建了 ' + chartCount + ' 个图表实例');

  console.log('\n[2] 新代码与 refresh() 的衔接');
  ok(/^[\d.]+ [▲▼＝] · 打板情绪看板$/.test(document.title),
    '标签栏标题已写成实时值：' + document.title);
  // 手动触发一次心跳，确认 tick 会把 left 递减（说明 Worker → tick 这条线是通的）
  const before = els['countdown'] && els['countdown'].textContent;
  clock += 1000;                       // 让假时钟前进 1 秒
  stubWorker.onmessage({ data: 1 });
  ok(els['countdown'].textContent !== before,
    '心跳回调驱动了倒计时刷新：' + before + ' → ' + els['countdown'].textContent);
  ok(els['localTime'].textContent.indexOf('10:30') === 0,
    '本地时间已渲染：' + els['localTime'].textContent);

  console.log('\n[3] 页面数值');
  const cur = els['curValue'].textContent;
  ok(/^-?\d+\.\d{4}$/.test(cur), '① 当前值 = ' + cur + '（class=' + els['curValue'].className + '）');
  ok(/相对基准$/.test(els['curDelta'].textContent), '① 相对基准 = ' + els['curDelta'].textContent);
  ok(/^-?\d+\.\d{2}$/.test(els['curValue2'].textContent),
    '② 打板收益 = ' + els['curValue2'].textContent + ' 元/万');
  ok(/^封板率 \d+\.\d{2}%$/.test(els['curRate'].textContent),
    '① 后挂的封板率 = ' + els['curRate'].textContent);
  ok(/^封板率 \d+\.\d{2}%$/.test(els['curRate2'].textContent),
    '② 后挂的封板率 = ' + els['curRate2'].textContent);
  ok(els['lastPoint'].textContent.indexOf(':') > 0, '最新记录点 = ' + els['lastPoint'].textContent);
  ok(/已连接/.test(els['liveText'].textContent), '状态栏 = ' + els['liveText'].textContent);
  ok(/2026-10-13/.test(els['quoteTime'].textContent), '行情日期 = ' + els['quoteTime'].textContent);
  ok(/64\.79%/.test(els['rateText'].textContent) && !/存档/.test(els['rateText'].textContent),
    '总封板率走的是直连（不是存档）：' + els['rateText'].textContent);

  console.log('\n[4] 图表内容非空');
  const keys = Object.keys(drawn);
  ok(keys.length === 2, '两份 option 都写进去了');
  keys.forEach(k => {
    const o = drawn[k];
    const n = o.series && o.series[0] && o.series[0].data ? o.series[0].data.length : 0;
    ok(n > 0, k + ' 系列点数 = ' + n + '，y 轴 ' + o.yAxis.min + '~' + o.yAxis.max);
  });

  console.log('\n[5] 点「5日」按钮 → 走真实 UI 路径切视图');
  ok(btn1d.className === 'on' && btn5d.className === '', '初始选中 1日（1d="' + btn1d.className + '", 5d="' + btn5d.className + '"）');
  els['viewTabs']._handlers.click({ target: btn5d });
  ok(btn5d.className === 'on' && btn1d.className === '', '点击后选中 5日');
  ok(/横轴跨 5 天/.test(els['viewHint'].textContent), '视图说明已更新：' + els['viewHint'].textContent.slice(0, 46) + '…');
  const opt5 = drawn[Object.keys(drawn)[0]];
  ok(opt5.xAxis.data.length % 2 === 0 && opt5.xAxis.data.length === 2 * (opt5.xAxis.data.length / 2),
    '5 日图横轴 = ' + opt5.xAxis.data.length + '（2 个交易日，存档 10-12 + 当日直连 10-13）');
  const half = opt5.xAxis.data.length / 2;
  ok(opt5.xAxis.data[0] === '1012|09:25' && opt5.xAxis.data[half] === '1013|09:25',
    '横轴刻度带日期前缀：' + opt5.xAxis.data[0] + ' … ' + opt5.xAxis.data[half]);
  ok(opt5.series.length === 2 && opt5.series[0].name === '10-12',
    '两条日线：' + opt5.series.map(s => s.name).join(' / '));
  els['viewTabs']._handlers.click({ target: btn1d });   // 切回去，确认往返正常
  const opt1 = drawn[Object.keys(drawn)[0]];
  ok(opt1.xAxis.data[0] === '09:25' && opt1.xAxis.data.indexOf('15:00') === opt1.xAxis.data.length - 1,
    '切回 1 日图：横轴 = ' + opt1.xAxis.data.length + ' 个纯时刻刻度，' + opt1.xAxis.data[0] + ' → ' + opt1.xAxis.data[opt1.xAxis.data.length - 1]);

  console.log('\n[6] 切回前台 / 断网恢复 的兜底仍在');
  ok(typeof docListeners['visibilitychange'] === 'function', '注册了 visibilitychange');
  ok(typeof winListeners['online'] === 'function', '注册了 online');
  ok(typeof winListeners['beforeunload'] === 'function', '注册了 beforeunload');

  console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 全部通过'));
  process.exit(fail ? 1 : 0);
})();
