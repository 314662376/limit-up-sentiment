/* 端到端校验：把 app.js 里「真正的 draw5d / draw5d2」切出来执行，
 * 用假的 echarts / document 接住 setOption 的 option 对象，再对 option 断言。
 * 好处：验的是最终交给 ECharts 的那份配置，而不是另写的等价逻辑。 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n').split('\n');

let from = -1, to = -1;
// 从顶部常量块（var BASE）开始切，把 COLORS / Y_MIN / 阈值色一并带上
src.forEach((l, i) => { if (from < 0 && /^\s*var BASE = /.test(l)) from = i; });
const start5d2 = src.findIndex(l => /^\s*function draw5d2\(/.test(l));
for (let i = start5d2 + 1; i < src.length; i++) { if (src[i] === '  }') { to = i; break; } }
const slice = src.slice(from, to + 1).join('\n');
console.log('切片:', from + 1, '~', to + 1, '(' + (to - from + 1) + ' 行)');

// ---- 假 DOM：只要 getChart 能拿到东西就行 ----
const captured = {};
global.echarts = {
  init: function () {
    return {
      _id: 'fake',
      clear: function () { captured.cleared = true; },
      setOption: function (opt) { captured.opt = opt; },
      resize: function () {}
    };
  }
};
const els = {};
global.document = {
  getElementById: function (id) { return (els[id] = els[id] || { id: id, innerHTML: '', textContent: '', className: '' }); },
  addEventListener: function () {}
};
global.window = { addEventListener: function () {} };

// charts / left / busy 原本定义在切片之外，这里补上
const sandbox = new Function('var charts = {}; var left = 60; var busy = false;\n' + slice +
  '\nreturn { draw5d, draw5d2, drawToday, build5dTicks, mmddOf, DAY_TICKS };')();
const T = sandbox.DAY_TICKS.length;   // 243 = 09:25 + 09:30-11:30 + 13:00-15:00

let fail = 0;
function ok(c, m) { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) fail++; }

// ---- 用真实存档 + 一个模拟的「当天直连」 ----
const idx = JSON.parse(fs.readFileSync(path.join(root, 'data/index.json'), 'utf8'));
const days = idx.dates.slice(-5).map(d => {
  const j = JSON.parse(fs.readFileSync(path.join(root, 'data', d + '.json'), 'utf8'));
  return { date: j.date, rate: j.rate, points: j.points };
});
// 存档里现在已经有 2026-10-13（采集任务写的），模拟的「当天」要用更晚的日期
days.push({
  date: '2026-10-14', live: true,
  rate: { date: '20261013', zt: 67, zb: 19, rate: 77.9070, oneWord: 3, base: 64, fbl: 77.1084, zbl: 22.8916 },
  points: sandbox.DAY_TICKS.slice(0, 45).map((t, i) => ({ t: t, a: 1 + i * 0.02, b: -0.2, c: -3 - i * 0.02 }))
});
const N = days.length;

function checkOne(name, opt, yMin, yMax, expSeries) {
  console.log('\n[' + name + ']');
  ok(!!opt, 'setOption 被调用');
  ok(opt.xAxis.type === 'category', "xAxis.type = 'category'");
  ok(opt.xAxis.data.length === N * T, '横轴刻度 = ' + opt.xAxis.data.length + '（' + N + ' 天 × ' + T + '）');
  ok(opt.xAxis.data[0] === '1008|09:25' && opt.xAxis.data[N * T - 1] === '1014|15:00',
    '横轴首=' + opt.xAxis.data[0] + ' 末=' + opt.xAxis.data[N * T - 1]);
  ok(new Set(opt.xAxis.data).size === opt.xAxis.data.length, '刻度名不重复（不重复才不会被折回同一位置）');

  // 每天只画在自己那一段里 —— 这是「横轴跨 5 天」的核心证据
  const posOf = {}; opt.xAxis.data.forEach((k, i) => { posOf[k] = i; });
  let outside = 0, spans = [];
  opt.series.forEach(s => {
    const idxs = s.data.map(d => posOf[d[0]]);
    if (!idxs.length) return;
    const lo = Math.min.apply(null, idxs), hi = Math.max.apply(null, idxs);
    spans.push(s.name + ':' + lo + '-' + hi);
    const di = days.findIndex(d => sandbox.mmddOf(d.date) === s.name.replace('-', ''));
    if (lo < di * T || hi > di * T + T - 1) outside++;
  });
  ok(outside === 0, '每条曲线都落在自己那一天的 ' + T + ' 格区间内：' + spans.join('  '));
  ok(opt.series.length === expSeries,
    '系列数 = ' + opt.series.length + '（期望 ' + expSeries + '：有可用点的交易日各一条）');

  // 竖向日分隔线（不管有没有数据，5 天之间的分隔都要画）
  const ml = opt.series[0].markLine;
  // 注意用 in 判断：指数②的中性基准线 yAxis = 0，写成 d.yAxis 会被当成 false 漏掉
  const vlines = ml.data.filter(d => 'xAxis' in d);
  const hlines = ml.data.filter(d => 'yAxis' in d);
  ok(vlines.length === N - 1, '日分隔竖线 ' + vlines.length + ' 条（' + N + ' 天之间 ' + (N - 1) + ' 条）');
  ok(hlines.length === 3, '水平阈值虚线仍为 3 条（基准/下阈/上阈）');
  ok(vlines.every(v => posOf[v.xAxis] != null), '竖线锚点都是真实刻度：' + vlines.map(v => v.xAxis).join(' '));

  // 固定 y 轴 / 背景警示带没被改动
  ok(opt.yAxis.min === yMin && opt.yAxis.max === yMax, 'y 轴仍固定 ' + yMin + '~' + yMax);
  ok(!!opt.series[0].markArea, '背景警示带保留');

  // tooltip 能区分「哪一天 + 几点」
  const t = opt.tooltip.formatter([
    { axisValue: '1012|14:03', marker: '●', seriesName: '10-12', data: ['1012|14:03', 74.81] }
  ]);
  ok(/10-12 14:03/.test(t) && /74\.81/.test(t), 'tooltip = ' + t.replace(/<[^>]+>/g, '').replace(/\n/g, ' | '));
}

sandbox.draw5d(days, []);
checkOne('① 涨停情绪指数 · 5 日图', captured.opt, 0.925, 1.075, N);

captured.opt = null;
// 10-08 那份存档的 883918（c）全是 null，②天然只能画 3 天
const exp2 = days.filter(d => d.points.some(p => p.c != null)).length;
sandbox.draw5d2(days, []);
checkOne('② 打板收益 · 5 日图', captured.opt, -200, 300, exp2);

// 先快照图例：下面画 1 日图时会把 legend 清掉
const lgMainSnap = els['legendMain'].innerHTML;
const lg2Snap = els['legend2'].innerHTML;

console.log('\n[③ 1 日图回归（baseXAxis → baseXAxisDay 之后不应有任何变化）]');
const rows = days[1].points.map(p => ({ t: p.t, pct: p.a, bPct: p.b, cPct: p.c }));
captured.opt = null;
sandbox.drawToday(rows, days[1].rate.rate, []);
ok(captured.opt.xAxis.data.length === T, '横轴 = ' + captured.opt.xAxis.data.length + ' 个刻度');
ok(captured.opt.xAxis.data[0] === '09:25' && captured.opt.xAxis.data[T - 1] === '15:00',
  '横轴首末 = ' + captured.opt.xAxis.data[0] + ' … ' + captured.opt.xAxis.data[T - 1] + '（仍是单日轴，没有日期前缀）');
ok(!!captured.opt.visualMap && captured.opt.visualMap.type === 'piecewise',
  '1 日图仍用 visualMap 分段染色（低于 0.95 标红 / 高于 1.05 标绿）');
ok(captured.opt.series[0].data.length === rows.length, '数据点 ' + captured.opt.series[0].data.length + ' 个');
ok(!captured.opt.series[0].markLine.data.some(d => 'xAxis' in d), '1 日图没有多余的日分隔线');

console.log('\n[④ 图例]');
ok((lgMainSnap.match(/<span>/g) || []).length === N, '① 图例 ' + (lgMainSnap.match(/<span>/g) || []).length + ' 项（5 日图自己的图例）');
ok(/非一字板封板率 62\.12%/.test(lgMainSnap), '① 图例带「非一字板封板率」与基准日：' + lgMainSnap.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160));
ok((lg2Snap.match(/<span>/g) || []).length === exp2, '② 图例 ' + (lg2Snap.match(/<span>/g) || []).length + ' 项（缺 c 的那天不出图例）');
ok(/非一字板封板率/.test(lg2Snap), '② 图例也是非一字板口径');
ok(!/2026-10-08/.test(lg2Snap), '② 图例确实没有 10-08：' + lg2Snap.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 全部通过'));
process.exit(fail ? 1 : 0);
