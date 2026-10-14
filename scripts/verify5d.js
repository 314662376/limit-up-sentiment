/* 5 日横轴改造的校验脚本。
 * 关键点：直接切 app.js 的前 140 行（工具 + 横轴辅助函数）来 eval，
 * 校验的是「真实代码」，不是另写一份等价实现——否则测了等于没测。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n').split('\n');

// 从 'function pad(' 到 daySepLines5d 结束（第 140 行，1-based）
let from = -1, to = -1;
src.forEach((l, i) => {
  if (from < 0 && /^\s*function pad\(/.test(l)) from = i;
  if (/^\s*function daySepLines5d\(/.test(l)) { from = from < 0 ? i : from; }
});
to = src.findIndex(l => /^\s*function daySepLines5d\(/.test(l));
// 找到 daySepLines5d 函数体结束的 '}'（第一个顶格两空格的 '}'）
for (let i = to + 1; i < src.length; i++) {
  if (src[i] === '  }') { to = i; break; }
}

const slice = src.slice(from, to + 1).join('\n');
const sandbox = {};
const fn = new Function(slice + '\nreturn { DAY_TICKS, DAY_LABELS, build5dTicks, label5dOf, fmtKey5d, mmddOf, dashMMDD, daySepLines5d, DAY_TICK_SET };');
Object.assign(sandbox, fn());

let fail = 0;
function ok(cond, msg) { console.log((cond ? '  ✔ ' : '  ✘ ') + msg); if (!cond) fail++; }

console.log('切片行号:', from + 1, '~', to + 1);
const T = sandbox.DAY_TICKS.length;
console.log('DAY_TICKS =', T, '首', sandbox.DAY_TICKS[0], '次', sandbox.DAY_TICKS[1], '末', sandbox.DAY_TICKS[T - 1]);

// 用仓库里真实的存档来构造 days
const idx = JSON.parse(fs.readFileSync(path.join(root, 'data/index.json'), 'utf8'));
const days = idx.dates.slice(-5).map(d => {
  const j = JSON.parse(fs.readFileSync(path.join(root, 'data', d + '.json'), 'utf8'));
  return { date: j.date, rate: j.rate, points: j.points };
});
// 再模拟一个「当天直连」的 day（refresh() 里 push 的那种）
// 存档里现在已经有 2026-10-13 了（采集任务写的），模拟的「当天」必须用更晚的日期，
// 否则会出现两段同名刻度，把「每天各占一段」的断言带偏
days.push({
  date: '2026-10-14', rate: { date: '20261013', rate: 77.9070, fbl: 77.1084 },
  live: true,
  points: sandbox.DAY_TICKS.slice(0, 30).map((t, i) => ({ t, a: 1 + i * 0.01, b: -0.2, c: -3 - i * 0.01 }))
});

console.log('\n[1] 横轴刻度');
const ax = sandbox.build5dTicks(days);
ok(ax.ticks.length === days.length * T, '刻度总数 = ' + ax.ticks.length + '（= ' + days.length + ' 天 × ' + T + '）');
ok(new Set(ax.ticks).size === ax.ticks.length, '刻度名全局唯一（否则 5 天会叠回同一个 x 位置）');
ok(ax.start.join(',') === days.map((_, i) => i * T).join(','), '每天起始下标 = ' + ax.start.join(','));
ok(ax.ticks[0] === '1008|09:25' && ax.ticks[T - 1] === '1008|15:00', '第 1 天首末刻度 = ' + ax.ticks[0] + ' … ' + ax.ticks[T - 1]);
ok(ax.ticks[T] === '1009|09:25', '第 2 天首刻度 = ' + ax.ticks[T] + '（紧接第 1 天收盘，无隔夜空隙）');
ok(ax.ticks[ax.ticks.length - 1] === '1014|15:00', '末刻度 = ' + ax.ticks[ax.ticks.length - 1]);

console.log('\n[2] 横轴标签');
const perDay = {};
ax.ticks.forEach(v => { const o = sandbox.label5dOf(v); if (!o) return; const d = v.slice(0, 4); (perDay[d] = perDay[d] || []).push(o.text + (o.date ? '(日期)' : '')); });
const dayKeys = Object.keys(perDay);
ok(dayKeys.length === days.length, '每天都产生了标签，共 ' + dayKeys.length + ' 天');
ok(dayKeys.every(k => perDay[k].length === 4), '每天 4 个标签（日期 + 10:30/13:30/15:00），实测 ' + dayKeys.map(k => perDay[k].length).join('/'));
ok(perDay[dayKeys[0]].join(' ') === '10-08(日期) 10:30 13:30 15:00', '第 1 天标签 = ' + perDay[dayKeys[0]].join(' '));
ok(sandbox.label5dOf('1008|09:30') === null && sandbox.label5dOf('1008|14:59') === null, '非标注刻度返回 null（不渲染标签）');

console.log('\n[3] tooltip 文本');
ok(sandbox.fmtKey5d('1008|09:30') === '10-08 09:30', "fmtKey5d('1008|09:30') = " + sandbox.fmtKey5d('1008|09:30'));
ok(sandbox.fmtKey5d('1014|14:03') === '10-14 14:03', "fmtKey5d('1014|14:03') = " + sandbox.fmtKey5d('1014|14:03'));

console.log('\n[4] 日分隔线');
const sep = sandbox.daySepLines5d(ax.ticks, ax.start);
ok(sep.length === days.length - 1, '分隔线 ' + sep.length + ' 条（5 天之间 4 条）');
ok(sep.every(s => ax.ticks.indexOf(s.xAxis) >= 0), '每条分隔线都落在真实存在的刻度上（markLine 按类别名匹配，名字错就画不出来）');
ok(sep.map(s => s.xAxis).join(' ') === days.slice(1).map(d => sandbox.mmddOf(d.date) + '|09:25').join(' '),
  '分隔线位置 = ' + sep.map(s => s.xAxis).join(' '));

console.log('\n[5] 数据点能否落到横轴上（落不上会被 ECharts 静默丢弃）');
let miss = 0, tot = 0;
days.forEach(d => {
  const mmdd = sandbox.mmddOf(d.date);
  d.points.forEach(p => { tot++; if (ax.ticks.indexOf(mmdd + '|' + p.t) < 0) miss++; });
});
ok(miss === 0, tot + ' 个数据点，落在横轴之外的有 ' + miss + ' 个');
let badTick = 0;
days.forEach(d => d.points.forEach(p => { if (!sandbox.DAY_TICK_SET[p.t]) badTick++; }));
ok(badTick === 0, '不在 09:30–15:00 分钟刻度里的点：' + badTick + ' 个');

console.log('\n[6] 与 1 日图不串味');
ok(sandbox.build5dTicks([days[0]]).ticks.length === T && sandbox.build5dTicks([days[0]]).ticks[0] === '1008|09:25',
  '只剩 1 天时横轴退化为该日 ' + T + ' 个刻度，不报错');

console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 全部通过'));
process.exit(fail ? 1 : 0);
