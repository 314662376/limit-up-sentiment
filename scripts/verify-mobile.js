/* 手机窄屏版式校验。
 *
 * 有两层必须分别验：
 *   ① 图表内部（app.js）：grid 留白、y 轴字号、5 日图标签密度、tooltip 是否 confine
 *      —— 这些是 ECharts 按像素算的，光改 CSS 没用
 *   ② 页面样式（index.html）：@media 断点里到底改了什么
 * 关键断言：innerWidth 改变后**必须重新生效**（不能被缓存住），否则横竖屏切换会错版。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) fail++; };

// 切片：var BASE → draw5d2 结束（含窄屏判定、公式、四张图的绘制）
const lines = src.split('\n');
const a = lines.findIndex(l => /^\s*var BASE = /.test(l));
const s52 = lines.findIndex(l => /^\s*function draw5d2\(/.test(l));
let b = -1;
for (let i = s52 + 1; i < lines.length; i++) { if (lines[i] === '  }') { b = i; break; } }
const slice = lines.slice(a, b + 1).join('\n');
console.log('切片:', a + 1, '~', b + 1, '\n');

// 假 DOM / ECharts：能接住 setOption 的 option 对象
const els = {};
const drawn = {};
global.echarts = {
  init: () => ({ clear() {}, resize() {}, setOption(o) { drawn.opt = o; } })
};
global.document = {
  getElementById: id => (els[id] = els[id] || { id, innerHTML: '', textContent: '', className: '' }),
  addEventListener() {}
};
global.window = { innerWidth: 375, addEventListener() {} };   // ← 先当手机

const S = new Function('var charts = {}; var left = 60; var busy = false;\n' + slice +
  '\nreturn { isNarrow, chartGrid, day5dLabels, DAY_LABELS_5D, DAY_LABELS_5D_NARROW, DAY_TICKS,' +
  ' label5dOf, build5dTicks, draw5d, draw5d2, mmddOf };')();

// 真实存档 + 模拟的「当天」
const idx = JSON.parse(fs.readFileSync(path.join(root, 'data/index.json'), 'utf8'));
const days = idx.dates.slice(-5).map(d => {
  const j = JSON.parse(fs.readFileSync(path.join(root, 'data', d + '.json'), 'utf8'));
  return { date: j.date, rate: j.rate, points: j.points };
});
days.push({
  date: '2026-10-14', live: true,
  rate: { date: '20261013', zt: 67, zb: 19, rate: 77.9070, oneWord: 3, base: 64, fbl: 77.1084, zbl: 22.8916 },
  points: S.DAY_TICKS.slice(0, 46).map((t, i) => ({ t, a: 1.6 + i * 0.012, b: -0.19, c: -3.2 - i * 0.012 }))
});

function perDayLabels() {
  const ax = S.build5dTicks(days);
  const cnt = {};
  ax.ticks.forEach(v => {
    const o = S.label5dOf(v);
    if (!o) return;
    const d = v.slice(0, 4);
    cnt[d] = (cnt[d] || 0) + 1;
  });
  return cnt;
}

console.log('[1] 手机（375px）');
ok(S.isNarrow() === true, 'isNarrow() = true');
{
  const g = S.chartGrid();
  ok(g.left === 44 && g.right === 10, '绘图区留白收紧：left=' + g.left + ' right=' + g.right + '（桌面是 64/22）');
}
{
  const cnt = perDayLabels();
  const vals = Object.values(cnt);
  ok(vals.every(v => v === 2), '5 日图每天 ' + vals[0] + ' 个标签（日期 + 15:00），共 ' + vals.length + ' 天 → ' +
    (vals[0] * vals.length) + ' 个，不会互相压住');
  ok(!S.label5dOf('1014|10:30'), '10:30 这个标签在窄屏被省掉了');
  ok(!!S.label5dOf('1014|09:25') && !!S.label5dOf('1014|15:00'), '仍保留日期（09:25 处）与 15:00');
}
{
  drawn.opt = null;
  S.draw5d(days, []);
  const o = drawn.opt;
  ok(o.grid.left === 44, '① 图实际下发的 grid.left = ' + o.grid.left);
  ok(o.tooltip.confine === true, 'tooltip.confine = ' + o.tooltip.confine + '（手机上提示框不会溢出屏幕）');
  ok(o.yAxis.axisLabel.fontSize === 10, 'y 轴字号 = ' + o.yAxis.axisLabel.fontSize + '（桌面 11）');
  ok(o.xAxis.data.length === days.length * 243, '横轴刻度数不变 = ' + o.xAxis.data.length);
  drawn.opt = null;
  S.draw5d2(days, []);
  ok(drawn.opt.grid.left === 44 && drawn.opt.tooltip.confine === true, '② 图同样收紧了');
}

console.log('\n[2] 桌面（1280px）—— 必须能切回去，不能被缓存');
global.window.innerWidth = 1280;
ok(S.isNarrow() === false, 'isNarrow() = false');
{
  const g = S.chartGrid();
  ok(g.left === 64 && g.right === 22, '留白恢复桌面值：left=' + g.left + ' right=' + g.right);
  const cnt = perDayLabels();
  const vals = Object.values(cnt);
  ok(vals.every(v => v === 4), '5 日图每天恢复 4 个标签');
}
{
  drawn.opt = null;
  S.draw5d(days, []);
  ok(drawn.opt.grid.left === 64 && drawn.opt.yAxis.axisLabel.fontSize === 11,
    '① 图恢复：grid.left=' + drawn.opt.grid.left + '，y 轴字号=' + drawn.opt.yAxis.axisLabel.fontSize);
}

console.log('\n[3] 页面样式（index.html 的 @media 断点）');
{
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const m = html.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n  \}/);
  ok(!!m, '存在 @media (max-width:640px) 断点');
  const css = (m ? m[1] : '').replace(/\s+/g, ' ');
  const must = [
    ['.hero .big .v{font-size:33px', '主数值缩小到 33px（桌面 42px）'],
    ['.hero .formula{', '公式说明块单独重排'],
    ['border-left:0', '公式块的左边框去掉（否则横向溢出）'],
    ['max-width:none', '公式块的 430px 定宽放开'],
    ['.chart{height:250px', '图表高度降到 250px'],
    ['-webkit-text-size-adjust:100%', '防 iOS 横屏字号被放大'],
    ['.hero .big .row{flex-wrap:wrap', '主数值那一行允许折行']
  ];
  must.forEach(([k, desc]) => ok(css.indexOf(k) >= 0, desc));
  ok(/viewport/.test(html) && /width=device-width/.test(html), 'viewport meta 存在');
  ok(!/user-scalable\s*=\s*no/.test(html) && !/maximum-scale/.test(html), '没有禁止用户缩放（可访问性）');
}

console.log('\n[4] 横竖屏切换会触发重新排版');
{
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  ok(/addEventListener\('resize'/.test(app), '注册了 resize 监听');
  ok(/relayoutTimer/.test(app) && /clearTimeout\(relayoutTimer\)/.test(app), '有防抖，避免拖动窗口时疯狂重绘');
  ok(/renderAll\(\)/.test(app.split("addEventListener('resize'")[1] || ''), 'resize 后调用了 renderAll() 重新排版');
}

console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 全部通过'));
process.exit(fail ? 1 : 0);
