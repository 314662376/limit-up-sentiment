/* 用 Chrome DevTools Protocol 截「真实等待后」的截图，并顺手抓控制台报错。
 *
 * 为什么不用 `chrome --headless --screenshot`：
 *   1) 那个方式页面一 load 就截，异步取数还没回来 —— 截到的是「正在请求数据…」；
 *   2) 加了 `--virtual-time-budget` 又会把虚拟时钟快进，导致页面里
 *      `fetchWithTimeout(url, 8000)` 的 8 秒 AbortController 提前触发，
 *      涨停池请求被自己的超时掐断（分时接口没有超时保护所以没事），
 *      于是截出来封板率是 `--`、基准退回［存档］ —— 全是截图工具的假象。
 * 所以走 CDP：真时钟等够时间，再截图。
 *
 * 用法：
 *   node scripts/shot.js <url> <out.png> [宽] [高] [等待毫秒] [--full]
 * 例：
 *   node scripts/shot.js http://127.0.0.1:8899/index.html mobile.png 375 812 9000
 *   node scripts/shot.js https://xxx/ page.png 1280 900 9000 --full
 *
 * --full：截整页（先量 document.scrollHeight 再按那个高度截），不加则只截首屏。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WS_PATH = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/ws';
const WebSocket = require(WS_PATH);

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
];

const argv = process.argv.slice(2);
const full = argv.indexOf('--full') >= 0;
const pos = argv.filter(a => a !== '--full');
const [url, out] = pos;
const W = parseInt(pos[2] || '375', 10);
const H = parseInt(pos[3] || '812', 10);
const WAIT = parseInt(pos[4] || '9000', 10);
if (!url || !out) {
  console.error('用法: node scripts/shot.js <url> <out.png> [宽] [高] [等待毫秒] [--full]');
  process.exit(1);
}

const chromePath = CHROME_CANDIDATES.find(p => fs.existsSync(p));
if (!chromePath) { console.error('没找到 Chrome / Edge'); process.exit(1); }

const PORT = 9333 + (process.pid % 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shotprof-'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 允许外部追加 Chrome 参数，例如：
//   SHOT_CHROME_ARGS="--proxy-server=http://127.0.0.1:7890" 让它走指定代理
const EXTRA_ARGS = (process.env.SHOT_CHROME_ARGS || '').split(' ').filter(Boolean);

const child = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  ...EXTRA_ARGS,
  'about:blank'
], { stdio: 'ignore' });

function cleanup(code) {
  try { child.kill(); } catch (e) {}
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }, 200);
  process.exit(code);
}

(async () => {
  // 等调试端口起来
  let ver = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      if (r.ok) { ver = await r.json(); break; }
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  if (!ver) { console.error('调试端口没起来'); cleanup(1); }
  console.log('浏览器:', ver.Browser);

  const tgt = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const page = tgt.find(t => t.type === 'page');
  if (!page) { console.error('没有可用的 page target'); cleanup(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();
  const logs = [];

  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const t = msg.params.type;
      const text = (msg.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
      if (t === 'error' || t === 'warning' || t === 'info' || t === 'log') logs.push('[' + t + '] ' + text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      logs.push('[页面异常] ' + (d.exception && d.exception.description || d.text));
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error' || e.level === 'warning') logs.push('[log/' + e.level + '] ' + e.text);
    }
  });

  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  // 真手机视口：mobile:true 才能让 <meta viewport> 生效
  await send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: W < 700
  });

  await send('Page.navigate', { url });

  // 真时钟等足时间，让异步取数跑完（不能用虚拟时间）
  await sleep(WAIT);

  // 截前先读几个关键文本，确认数据真的到位了
  const probe = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      title: document.title,
      cur: (document.getElementById('curValue')||{}).textContent,
      cur2: (document.getElementById('curValue2')||{}).textContent,
      rate: (document.getElementById('curRate')||{}).textContent,
      live: (document.getElementById('liveText')||{}).textContent,
      err: (document.getElementById('errBox')||{}).textContent,
      innerW: window.innerWidth,
      docW: document.documentElement.scrollWidth,
      docH: document.documentElement.scrollHeight,
      charts: document.querySelectorAll('canvas').length
    })`,
    returnByValue: true
  });
  const info = JSON.parse(probe.result.value);
  console.log('页面状态:', JSON.stringify(info, null, 0));

  let clipH = H;
  if (full) {
    const m = await send('Page.getLayoutMetrics');
    clipH = Math.ceil(m.cssContentSize ? m.cssContentSize.height : info.docH);
    await send('Emulation.setDeviceMetricsOverride', {
      width: W, height: clipH, deviceScaleFactor: 2, mobile: W < 700
    });
    await sleep(1200);   // 视口变高后 ECharts 会 resize，等一下
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('已写出:', out, fs.statSync(out).size + ' 字节');

  // 横向溢出检查：手机上最常见的版式事故
  const overflow = info.docW - info.innerW;
  console.log(overflow > 2
    ? '⚠ 横向溢出 ' + overflow + 'px（视口 ' + info.innerW + '，文档 ' + info.docW + '）'
    : '✔ 无横向溢出（视口 ' + info.innerW + '，文档 ' + info.docW + '）');

  if (logs.length) {
    console.log('\n控制台输出（' + logs.length + ' 条，最多显示 20 条）:');
    logs.slice(0, 20).forEach(l => console.log("  " + l.slice(0, 1200)));
  } else {
    console.log('✔ 控制台无 error / warning');
  }

  ws.close();
  cleanup(0);
})().catch(e => { console.error('失败:', e.message); cleanup(1); });
