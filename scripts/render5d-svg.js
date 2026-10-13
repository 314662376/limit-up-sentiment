/* 用 ECharts 的 SSR 把「真实的 draw5d / draw5d2」渲染成 SVG，并做几何校验：
 *   - 每天那条折线的 x 坐标必须落在自己的横向区段里（这是「横轴跨 5 天」最硬的证据）
 *   - 日期标签必须出现且只有 5 个（每天开场一个）
 * 顺带把 SVG 存下来，方便直接打开看版式。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8').split('\n');

let from = -1;
src.forEach((l, i) => { if (from < 0 && /^\s*var BASE = /.test(l)) from = i; });
const s52 = src.findIndex(l => /^\s*function draw5d2\(/.test(l));
let to = -1;
for (let i = s52 + 1; i < src.length; i++) { if (src[i] === '  }') { to = i; break; } }
const slice = src.slice(from, to + 1).join('\n');

const W = 1160, H = 300;

global.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, setTimeout: setTimeout, clearTimeout: clearTimeout };
global.navigator = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' };
global.document = {
  createElement() { return { style: {}, getContext() { return null; } }; },
  documentElement: { style: {} },
  getElementById(id) { return (this._els = this._els || {}, this._els[id] = this._els[id] || { id, innerHTML: '', textContent: '', className: '' }); },
  addEventListener() {}, removeEventListener() {}
};
const realEcharts = require(path.join(root, 'lib/echarts.min.js'));
let made = [];
global.echarts = {
  init: function () {
    const c = realEcharts.init(null, null, { renderer: 'svg', ssr: true, width: W, height: H });
    made.push(c);
    return c;
  }
};

const sb = new Function('var charts = {}; var left = 60; var busy = false;\n' + slice +
  '\nreturn { draw5d, draw5d2, build5dTicks, mmddOf, DAY_TICKS };')();

// ---- 真实存档 + 一个模拟的「当天直连」 ----
const idx = JSON.parse(fs.readFileSync(path.join(root, 'data/index.json'), 'utf8'));
const days = idx.dates.slice(-5).map(d => {
  const j = JSON.parse(fs.readFileSync(path.join(root, 'data', d + '.json'), 'utf8'));
  return { date: j.date, rate: j.rate, points: j.points };
});
days.push({
  date: '2026-10-13', live: true,
  rate: { date: '20261012', zt: 46, zb: 25, rate: 64.7887, oneWord: 5, base: 41, fbl: 62.1212, zbl: 37.8788 },
  points: sb.DAY_TICKS.slice(0, 46).map((t, i) => ({ t, a: 1.6 + i * 0.012, b: -0.19, c: -3.2 - i * 0.012 }))
});
const N = days.length;

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) fail++; };

// 从 SVG 里抽出「折线 path 的 x 坐标范围」和文字
function analyze(svg) {
  const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => m[1]).filter(s => s.trim());
  // 折线：ECharts SVG 里每个 series 一条 <path d="M x y L x y ..."> 且 stroke 为该系列颜色
  const paths = [...svg.matchAll(/<path[^>]*d="([^"]+)"[^>]*/g)].map(m => m[1]);
  const xs = [];
  paths.forEach(d => {
    const nums = [...d.matchAll(/(?:^|[ML])\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map(m => parseFloat(m[1]));
    if (nums.length >= 4) xs.push({ n: nums.length, min: Math.min(...nums), max: Math.max(...nums) });
  });
  return { texts, xs };
}

function run(tag, fn, yMin, yMax, blockCols) {
  console.log('\n[' + tag + ']');
  made = [];
  const notices = [];
  fn(days, notices);
  const c = made[made.length - 1];
  const svg = c.renderToSVGString();

  const { texts, xs } = analyze(svg);
  // 日期标签
  const wantDates = days.map(d => sb.mmddOf(d.date).replace(/(\d{2})(\d{2})/, '$1-$2'));
  const hitDates = wantDates.filter(w => texts.some(t => t.indexOf(w) >= 0));
  ok(hitDates.length === N, 'SVG 里出现 ' + hitDates.length + '/' + N + ' 个日期标签：' + hitDates.join(' '));
  const times = ['10:30', '13:30', '15:00'];
  ok(times.every(t => texts.some(s => s.trim() === t)), '时刻标签齐全（' + times.join(' / ') + '）');
  ok(texts.some(s => s.trim() === '1.000' || s.trim() === '0'), '中性基准虚线标签仍在');
  ok(texts.some(s => s.trim() === yMin.toFixed(3)) || texts.some(s => s.trim() === String(yMin)),
    '下阈值标签 ' + yMin + ' 仍在');

  // 每条折线占哪一段横轴 —— 核心证据
  const blockW = (W - 64 - 22) / N;
  const wide = xs.filter(o => o.n > 20);
  const cols = wide.map(o => Math.floor(((o.min + o.max) / 2) / blockW));
  const uniq = [...new Set(cols)].sort((a, b) => a - b);
  ok(wide.length > 0, '识别到 ' + wide.length + ' 条折线（点较多的）');
  ok(uniq.length === wide.length,
    '每条折线各占一个横向区段，无重叠：' + wide.map((o, i) => '线' + (i + 1) + ' x∈[' + o.min.toFixed(0) + ',' + o.max.toFixed(0) + ']→第' + (cols[i] + 1) + '段').join('  '));
  ok(uniq.length > 1, '区段数 ' + uniq.length + ' 个（>1 才说明是「跨多天」而不是全叠在一段）');

  const out = path.join(root, '..', 'preview-' + blockCols + '.svg');
  fs.writeFileSync(out, svg);
  console.log('  · SVG 已存：' + out + '（' + svg.length + ' 字节）');
  return out;
}

const f1 = run('① 涨停情绪指数 · 5 日图（SSR 实渲染）', sb.draw5d, 0.95, 1.075, '5d-main');
const f2 = run('② 打板收益 · 5 日图（SSR 实渲染）', sb.draw5d2, -100, 200, '5d-second');

console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 全部通过（渲染层面）'));
process.exit(fail ? 1 : 0);
