/* 校验「后台心跳」相关的新代码：切 app.js 里的真实函数执行，不重写实现。
 * 重点覆盖两处最容易悄悄写错的地方：
 *   1) Worker 建不起来时（file:// / 严格 CSP）必须能回退到主线程 setInterval
 *   2) tick 用「真实经过秒数」递减：标签被冻结 10 分钟后回来，倒计时要一次补齐
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8').split('\n');

// A 段：从常量到取数/封板率这一整块（含 ymdOfBJ / fetchTodayRate / loadHistory）
const aStart = src.findIndex(l => /^\s*var BASE = /.test(l));
const aEnd = src.findIndex(l => /==================== 图表公共部件/.test(l)) - 1;
// B 段：主流程（isWeekday / minsOf / inSession / todayStarted）+ 标题 + 心跳 + tick
const bStart = src.findIndex(l => /==================== 主流程/.test(l));
const tickAt = src.findIndex(l => /^\s*function tick\(\)/.test(l));
let bEnd = -1;
for (let i = tickAt + 1; i < src.length; i++) { if (src[i] === '  }') { bEnd = i; break; } }

const partA = src.slice(aStart, aEnd + 1).join('\n');
const partB = src.slice(bStart, bEnd + 1).join('\n');
console.log('切片 A:', aStart + 1, '~', aEnd + 1, '| 切片 B:', bStart + 1, '~', bEnd + 1);

const els = {};
global.document = {
  title: '打板情绪看板 · 涨停情绪指数 & 打板收益',
  hidden: false,
  getElementById: id => (els[id] = els[id] || { id, textContent: '', className: '', innerHTML: '' }),
  addEventListener() {}
};
global.window = { addEventListener() {} };
global.Blob = class { constructor(p) { this.parts = p; } };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) fail++; };

// 用一个沙箱工厂：每次新建，方便分别测「Worker 可用」和「Worker 不可用」两条路
function makeSandbox(workerFactory) {
  const prelude =
    'var left = 60; var busy = false; var refreshCalls = 0;' +
    'var refresh = function () { refreshCalls++; };' +
    'var WORKER_LOG = [];';
  const body = partA + '\n' + partB +
    '\nreturn { tick, startHeartbeat, setTitleValue, TITLE_ORIG,' +
    ' getLeft: function () { return left; }, setLeft: function (v) { left = v; },' +
    ' refreshCalls: function () { return refreshCalls; }, WORKER_LOG: WORKER_LOG,' +
    ' getEls: function () { return els; } };';
  const f = new Function('els', 'URL', 'Worker', 'setInterval', 'clearInterval', 'setTimeout',
    prelude + '\n' + body);
  return f(els, workerFactory.URL, workerFactory.Worker,
    workerFactory.setInterval, workerFactory.clearInterval, workerFactory.setTimeout);
}

// ---- 假 Worker：能记录 postMessage / terminate ----
function fakeWorkerEnv(failMode) {
  const log = [];
  const timers = [];
  return {
    log,
    timers,
    URL: { createObjectURL: () => 'blob:fake' },
    Worker: function (url) {
      if (failMode === 'throw') throw new Error('SecurityError: blob worker blocked');
      log.push('new Worker ' + url);
      return {
        onmessage: null, onerror: null,
        postMessage: m => log.push('postMessage ' + m),
        terminate: () => log.push('terminate')
      };
    },
    setInterval: (fn, ms) => { const t = { fn, ms }; timers.push(t); return timers.length; },
    clearInterval: id => log.push('clearInterval ' + id),
    setTimeout: (fn, ms) => { log.push('setTimeout ' + ms); return 0; }
  };
}

console.log('\n[1] Worker 可用 → 心跳走 Worker，不占用主线程 setInterval');
{
  const env = fakeWorkerEnv('ok');
  const sb = makeSandbox(env);
  let beats = 0;
  const stop = sb.startHeartbeat(() => { beats++; });
  ok(env.log.some(s => s.indexOf('new Worker blob:fake') === 0), 'Worker 已创建：' + env.log[0]);
  ok(env.timers.length === 0, '主线程 setInterval 未被使用（timers=' + env.timers.length + '）');
  sb.getEls();
  ok(sb.TITLE_ORIG === '打板情绪看板 · 涨停情绪指数 & 打板收益', '原标题已留存：' + sb.TITLE_ORIG);
  stop();
  ok(env.log.includes('postMessage stop') && env.log.includes('terminate'), '停止时发 stop 并 terminate');
}

console.log('\n[2] Worker 创建抛错 → 回退主线程 setInterval（file:// / CSP 场景）');
{
  const env = fakeWorkerEnv('throw');
  const sb = makeSandbox(env);
  let beats = 0;
  const stop = sb.startHeartbeat(() => { beats++; });
  ok(env.timers.length === 1, '已回退：建了 1 个 setInterval（间隔 ' + (env.timers[0] || {}).ms + 'ms）');
  ok((env.timers[0] || {}).ms === 1000, '间隔 = 1000ms');
  env.timers[0].fn(); env.timers[0].fn();
  ok(beats === 2, '心跳回调被触发 ' + beats + ' 次');
  stop();
  ok(env.log.some(s => s.indexOf('clearInterval') === 0), '停止时 clearInterval');
}

console.log('\n[3] 心跳驱动 tick：正常每 1 秒扣 1 秒倒数');
{
  const env = fakeWorkerEnv('ok');
  const sb = makeSandbox(env);
  const realNow = Date.now;
  let fake = +new Date('2026-10-13T03:00:00Z');
  Date.now = () => fake;                    // 全程用假时钟，否则第二次递减排不准

  sb.setLeft(60);
  sb.tick();
  ok(sb.getLeft() === 59, '第一次心跳：60 → ' + sb.getLeft());
  fake += 1000; sb.tick();
  ok(sb.getLeft() === 58, '隔 1 秒再跳：59 → ' + sb.getLeft());
  fake += 1000; sb.tick();
  ok(sb.getLeft() === 57, '再隔 1 秒：58 → ' + sb.getLeft());
  fake -= 5000; sb.tick();                  // 系统时间被往回调
  ok(sb.getLeft() === 57, '时钟倒退时不乱跳（dt 夹到 0）：' + sb.getLeft());
  Date.now = realNow;
}

console.log('\n[4] 标签被冻结 / 电脑睡眠 → 用真实经过秒数补齐，而不是只减 1');
{
  const env = fakeWorkerEnv('ok');
  const sb = makeSandbox(env);
  const realNow = Date.now;
  let fake = +new Date('2026-10-13T03:00:00Z');
  Date.now = () => fake;

  sb.setLeft(60);
  sb.tick();                       // 基准点
  ok(sb.getLeft() === 59, '基准：60 → ' + sb.getLeft());
  fake += 600 * 1000;              // 模拟被冻结 10 分钟
  sb.tick();
  ok(sb.getLeft() <= 0, '冻结 10 分钟后回来：left 一次补齐到 ' + sb.getLeft() + '（≤0，触发立即刷新）');
  ok(sb.refreshCalls() === 1, '并触发了 1 次刷新');
  Date.now = realNow;
}

console.log('\n[5] 标签栏标题随指标值更新');
{
  const env = fakeWorkerEnv('ok');
  const sb = makeSandbox(env);
  sb.setTitleValue(1.0034);
  ok(global.document.title === '1.0034 ▲ · 打板情绪看板', '高于基准：' + global.document.title);
  sb.setTitleValue(0.9927);
  ok(global.document.title === '0.9927 ▼ · 打板情绪看板', '低于基准：' + global.document.title);
  sb.setTitleValue(1.0);
  ok(global.document.title === '1.0000 ＝ · 打板情绪看板', '正好中性：' + global.document.title);
  sb.setTitleValue(null);
  ok(global.document.title === sb.TITLE_ORIG, '取不到数时还原原标题：' + global.document.title);
  sb.setTitleValue(NaN);
  ok(global.document.title === sb.TITLE_ORIG, 'NaN 也还原原标题');
}

console.log('\n[6] 静态检查：启动段不再用裸 setInterval 跑心跳');
{
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  ok(!/^\s*setInterval\(tick, 1000\);/m.test(app), '旧的 setInterval(tick, 1000) 已移除');
  ok(/startHeartbeat\(tick\)/.test(app), '启动改为 startHeartbeat(tick)');
  ok(/beforeunload/.test(app), '有 beforeunload 收尾，避免残留 Worker');
  ok(/new Worker\(url\)/.test(app) && /catch \(e\) \{\s*\n\s*toFallback\(/.test(app),
    'Worker 创建包在 try/catch 里且有 toFallback');
  ok(/worker\.onerror = function \(\) \{ toFallback\(/.test(app),
    'worker.onerror 也挂到 toFallback（异步失败也要能回退）');
  ok(/console\.info\('\[心跳\]/.test(app), '两条路径都有控制台诊断信息');
}

console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 全部通过'));
process.exit(fail ? 1 : 0);
