(function () {
  'use strict';

  /* ============================================================
   * 两个指数
   *  ① 涨停情绪指数（无量纲，1.000 = 中性）
   *     值 = 昨日封板率/100 × (883900涨跌幅% ÷ 100) + 1 + 上证涨跌幅% ÷ 20
   *     Excel 式 =C3/100*D3+1+E3/20          → y 轴固定 0.925 ~ 1.075
   *                                             （跌破 0.95 的线段标红、涨破 1.05 的标绿）
   *
   *  ② 打板收益（元 / 万元本金，0 = 不赚不亏）
   *     值 = 10000*(1+883918%)*昨日炸板率 + 10000*(1+883900%)*昨日非一字板封板率 − 10000
   *     Excel 式 =10000*(1+F2)*E2+10000*(1+D2)*C2-10000
   *     条件：昨日非一字板封板率(C) + 昨日炸板率(E) = 100%，故等价于
   *     值 = 100 × ( 883918% × 炸板率 + 883900% × 非一字板封板率 )
   *     → y 轴固定 −200 ~ 300
   *       （跌破 −100 的线段标红、涨破 200 的标绿）
   * ============================================================ */
  var BASE = 'https://d.10jqka.com.cn';
  var REFRESH_SEC = 60;
  var DAYS_5D = 5;
  // 5 日图「每天一色」的调色板：刻意避开纯红 / 纯绿，
  // 因为红=跌破下阈、绿=涨破上阈，日期色不该和警示色抢同一套语义。
  var COLORS = ['#2f6bd8', '#7b61c9', '#0d8ba6', '#c08a2e', '#6b7a8f'];

  // 指数①：y 轴固定区间（0.925 ~ 1.075，7 条刻度，0.95 / 1.05 刚好落在刻度上）
  var Y_MIN = 0.925, Y_MAX = 1.075, Y_STEP = 0.025, Y_BASE = 1;
  // 指数②：y 轴固定区间（-200 ~ 300，6 条刻度，-100 / 200 刚好落在刻度上）
  var Y2_MIN = -200, Y2_MAX = 300, Y2_STEP = 100, Y2_BASE = 0;

  /* 超阈区间警示色：跌破下阈 = 红，涨破上阈 = 绿（沿用 A 股「红跌绿涨」之外的
   * 「危险 = 红 / 安全 = 绿」语义，两处阈值由用户指定）
   *   ① 区间 0.95 ~ 1.05（中性基准 1.000）
   *   ② 区间 -100 ~ 200（中性基准 0）        */
  var TH1_LO = 0.95, TH1_HI = 1.05;
  var TH2_LO = -100, TH2_HI = 200;
  var C_RED = '#d93025', C_GREEN = '#0f9d58';
  var C_BASE = '#8b929c';            // 中性基准线（灰）

  var charts = {};
  var left = REFRESH_SEC;
  var busy = false;

  /* ==================== 通用工具 ==================== */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function setText(id, t) { var e = document.getElementById(id); if (e) e.textContent = t; }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
  function cls1(v) { return v > 1.0000001 ? 'up' : (v < 0.9999999 ? 'down' : 'flat'); }
  function cls2(v) { return v > 0.004 ? 'up' : (v < -0.004 ? 'down' : 'flat'); }
  function fmtT(s) { s = String(s); return s.length === 4 ? s.slice(0, 2) + ':' + s.slice(2) : s; }
  function fmtPct(v) { var n = num(v); return n === null ? '--' : (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 完整交易日的分钟刻度（09:30-11:30、13:00-15:00，午休不占位）。
  // 两张图的当日分时都用这一整套横轴，盘中不随实时数据向右延长。
  var DAY_TICKS = (function () {
    var a = [];
    function run(h0, m0, h1, m1) {
      for (var c = h0 * 60 + m0, e = h1 * 60 + m1; c <= e; c++) {
        a.push(pad(Math.floor(c / 60)) + ':' + pad(c % 60));
      }
    }
    run(9, 30, 11, 30);
    run(13, 0, 15, 0);
    return a;
  })();
  var DAY_TICK_SET = {};
  DAY_TICKS.forEach(function (t) { DAY_TICK_SET[t] = 1; });

  // 当日图 x 轴只标这几个时刻，避免 242 个标签挤在一起
  var DAY_LABELS = {
    '09:30': 1, '10:00': 1, '10:30': 1, '11:00': 1,
    '13:00': 1, '13:30': 1, '14:00': 1, '14:30': 1, '15:00': 1
  };

  /* ============================================================
   * 5 日图横轴：5 个交易日「按顺序连续铺开」
   *   每天占 DAY_TICKS.length 个刻度（共 5×242），而不是把 5 天
   *   折回同一个 09:30–15:00 的日内轴上叠着画。
   *
   * 为什么刻度名必须带日期前缀：category 轴是按「名字」匹配数据的。
   * 若 5 天都用 '09:30' 这种名字，ECharts 会把相同名字归并成同一个
   * x 位置 → 5 天的曲线全部叠在一起，正是要改掉的那个效果。
   * 所以刻度名统一为 '1008|09:30' 这种「MMDD|HH:MM」，全局唯一。
   * ============================================================ */
  var DAY_LABELS_5D = { '10:30': 1, '13:30': 1, '15:00': 1 };

  // '2026-10-08' / '20261008' → '1008'
  function mmddOf(d) {
    var s = String(d == null ? '' : d).replace(/-/g, '');
    if (s.length >= 8) return s.slice(4, 8);
    return s.length === 4 ? s : '';
  }
  function dashMMDD(m) { return m.length === 4 ? m.slice(0, 2) + '-' + m.slice(2) : m; }
  // '20260930' → '09-30'（图例里标注「基准日」用）
  function fmtBaseDay(n) {
    var s = String(n == null ? '' : n);
    return s.length === 8 ? s.slice(4, 6) + '-' + s.slice(6, 8) : s;
  }

  // 构造 5 日连续刻度；start[i] = 第 i 天在刻度数组里的起始下标
  function build5dTicks(days) {
    var a = [], start = [];
    days.forEach(function (day) {
      start.push(a.length);
      var p = mmddOf(day.date);
      for (var i = 0; i < DAY_TICKS.length; i++) a.push(p + '|' + DAY_TICKS[i]);
    });
    return { ticks: a, start: start };
  }

  // 5 日横轴标签：每天开盘处标「日期」，其余只标少数时刻（5×242 个标签会糊成一片）
  function label5dOf(v) {
    var s = String(v), i = s.indexOf('|');
    if (i < 0) return null;
    var m = s.slice(0, i), t = s.slice(i + 1);
    if (t === '09:30') return { text: dashMMDD(m), date: true };
    if (DAY_LABELS_5D[t]) return { text: t, date: false };
    return null;
  }

  // '1008|09:30' → '10-08 09:30'（tooltip 用）
  function fmtKey5d(v) {
    var s = String(v), i = s.indexOf('|');
    if (i < 0) return s;
    return dashMMDD(s.slice(0, i)) + ' ' + s.slice(i + 1);
  }

  // 交易日之间的竖向分隔虚线（挂到 series[0] 的 markLine 上，与阈值虚线一起渲染）
  function daySepLines5d(ticks, start) {
    var out = [];
    for (var i = 1; i < start.length; i++) {
      out.push({
        xAxis: ticks[start[i]],
        lineStyle: { color: '#c9ced6', type: 'dotted', width: 1, opacity: .9 },
        label: { show: false }
      });
    }
    return out;
  }

  // 超出固定 y 轴区间的点数（区间是硬约束，超出的点会被裁掉，用提示兜底）
  function countOut(values, min, max) {
    var n = 0;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (typeof v === 'number' && isFinite(v) && (v < min || v > max)) n++;
    }
    return n;
  }

  // 指数①：涨跌幅以「小数」代入
  function metric(ratePct, aPct, bPct) {
    // 对应 Excel 式 =C3/100*D3+1+E3/20
    //   C 昨日封板率 → 百分数（47.92）
    //   D 昨日涨停表现 → 小数（0.0248 即 2.48%）
    //   E 上证%      → 百分数（0.48 即 +0.48%），不再除以 100
    return (ratePct / 100) * (aPct / 100) + 1 + bPct / 20;
  }

  // 指数②：C 非一字板封板率(%)、E 炸板率(%) 互补
  //   = 100 × ( 883918% × 炸板率 + 883900% × 非一字板封板率 )
  function metric2(cPct, aPct, fblPct) {
    if (fblPct == null || !isFinite(fblPct)) return null;
    if (cPct == null || aPct == null) return null;
    var fbl = fblPct / 100, zbl = 1 - fbl;
    return 100 * (cPct * zbl + aPct * fbl);
  }

  function shiftYmd(n, delta) {
    var y = Math.floor(n / 10000), m = Math.floor(n / 100) % 100, d = n % 100;
    var dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + delta);
    return dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
  }

  function bjNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
  function hmOf(d) { return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
  function phaseText(d) {
    var day = d.getUTCDay();
    if (day === 0 || day === 6) return '周末休市';
    var m = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (m < 570) return '盘前';
    if (m <= 690) return '盘中 · 早盘';
    if (m < 780) return '午间休市';
    if (m <= 900) return '盘中 · 午盘';
    return '盘后';
  }

  /* ==================== JSONP ==================== */
  function jsonp(url, cbName, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      var done = false, t = null;
      function cleanup() {
        if (t) { clearTimeout(t); t = null; }
        try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      window[cbName] = function (data) {
        if (done) return;
        done = true; cleanup(); resolve(data);
      };
      script.onerror = function () {
        if (done) return;
        done = true; cleanup(); reject(new Error('网络错误'));
      };
      t = setTimeout(function () {
        if (done) return;
        done = true; cleanup(); reject(new Error('超时'));
      }, timeoutMs || 12000);
      script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
      document.head.appendChild(script);
    });
  }

  /* 分时接口是 JSONP（外面包了一层 callback）。以前用 <script> 标签加载，
   * 但该接口带 `Cache-Control: max-age=60`，浏览器会拿本地缓存，
   * 于是出现过「曲线停在某一分钟不再前进」的现象。
   * 现在改成 fetch + `cache:'no-store'`，让浏览器每次都真去取；
   * 万一 fetch 被跨域策略挡住（老浏览器 / 兼容模式），再退回 <script> 方式。
   *
   * 注意：不能给 fetch 加 `Cache-Control` / `Pragma` 请求头——
   * 它们不在 CORS 安全名单里，会触发预检，而对方
   * `Access-Control-Allow-Headers` 里没有这两个，反而会把请求搞挂。
   */
  async function fetchJsonp(url, cbName) {
    var fresh = url + (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
    try {
      var r = await fetch(fresh, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var txt = await r.text();
      var i = txt.indexOf('('), j = txt.lastIndexOf(')');
      if (i < 0 || j <= i) throw new Error('JSONP 格式异常');
      return JSON.parse(txt.slice(i + 1, j));
    } catch (e) {
      return await jsonp(url, cbName);      // 兜底
    }
  }

  /* ==================== 取数 ==================== */
  async function getTimeSeries(cbKey, prefix, code, dateNum) {
    var suffix = dateNum ? ('/' + dateNum) : '/last';
    var cb = 'quotebridge_v6_time_' + prefix + '_' + code + (dateNum ? ('_' + dateNum) : '_last');
    var url = BASE + '/v6/time/' + prefix + '_' + code + suffix + '.js';
    var d = await fetchJsonp(url, cb);
    var pack = d[prefix + '_' + code];
    if (!pack || !pack.data) throw new Error('无分时数据 ' + code);
    var pre = parseFloat(pack.pre);
    var rows = [];
    pack.data.split(';').forEach(function (r) {
      var p = r.split(',');
      if (p.length < 2 || !p[1]) return;
      var price = parseFloat(p[1]);
      if (!isFinite(price)) return;
      rows.push({
        t: fmtT(p[0]),
        pct: pre > 0 ? (price / pre - 1) * 100 : null
      });
    });
    return { date: pack.date, pre: pre, rows: rows };
  }

  function fmtDateNum(n) { var s = String(n); return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); }

  /* ---- 「昨日封板率」基准 ----
   * 首选：直连同花顺涨停池 / 炸板池自己算（实测该接口会把请求的 Origin 原样回显
   *       到 Access-Control-Allow-Origin，所以浏览器可跨域直连，不依赖任何服务端任务）。
   * 兜底：读仓库内的 data/*.json 存档（GitHub Actions 采集写入）。
   * 基准是「日频」常量，按数据日期缓存，60 秒刷新不会重复请求。
   */
  var POOL_FIELDS = '199112,9001,330323,330324,330325,9002,330329,133971,133970,' +
    '1968584,3475914,9003,9004,3475915,3475916,330326,330327,330328';
  var rateCache = {};

  // 带超时的 fetch：某些网络环境下该域名会「挂住」而不是立刻报错，必须主动掐断，
  // 否则会把整轮刷新拖死。取不到就走存档兜底。
  async function fetchWithTimeout(url, ms) {
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = null;
    if (ctl) timer = setTimeout(function () { ctl.abort(); }, ms || 8000);
    try {
      return await fetch(url, ctl ? { signal: ctl.signal, cache: 'no-store' } : { cache: 'no-store' });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fetchPool(api, dateNum) {
    var url = 'https://data.10jqka.com.cn/dataapi/limit_up/' + api +
      '?page=1&limit=200&field=' + POOL_FIELDS +
      '&filter=HS,GEM2STAR&order_field=330324&order_type=0&date=' + dateNum;
    var r = await fetchWithTimeout(url, 8000);
    if (!r.ok) throw new Error('涨停池 HTTP ' + r.status);
    var j = await r.json();
    return (j && j.data) ? j.data : null;
  }

  // 用同花顺池子的家数算出两种口径的封板率
  function buildRate(dateNum, zt, zb) {
    var A = (zt && zt.page) ? zt.page.total : 0;
    if (!A) return null;
    var Z = (zb && zb.page) ? zb.page.total : 0;
    var oneWord = 0;
    ((zt.info) || []).forEach(function (x) { if (x.limit_up_type === '一字板') oneWord++; });
    var base = A - oneWord;                       // 非一字板涨停家数
    var d0 = A + Z, d1 = base + Z;
    return {
      date: String(dateNum), zt: A, zb: Z, oneWord: oneWord, base: base,
      rate: d0 > 0 ? +(A / d0 * 100).toFixed(4) : null,       // 总封板率（指数①）
      fbl: d1 > 0 ? +(base / d1 * 100).toFixed(4) : null,     // 非一字板封板率（指数②）
      zbl: d1 > 0 ? +(Z / d1 * 100).toFixed(4) : null,
      src: 'live'
    };
  }

  // dataDate = 当前这批分时所属的交易日；基准取它前面「最近一个有数据的交易日」
  var liveRateFailUntil = 0;      // 直连不可用时退避，避免每轮刷新都白等超时
  async function resolveRateLive(dataDate) {
    if (Date.now() < liveRateFailUntil) return null;
    var n = parseInt(dataDate, 10);
    if (!isFinite(n)) return null;
    try {
      for (var back = 1; back <= 12; back++) {
        var prev = shiftYmd(n, -back);
        var zt = await fetchPool('limit_up_pool', prev);
        if (!zt || !zt.page || !zt.page.total) continue;
        var zb = null;
        try { zb = await fetchPool('open_limit_pool', prev); } catch (e) { zb = null; }
        var rr = buildRate(prev, zt, zb);
        if (rr && rr.rate != null && rr.fbl != null) return rr;
      }
      return null;                                  // 接口通但无数据，不算故障
    } catch (e) {
      liveRateFailUntil = Date.now() + 10 * 60 * 1000;
      return null;
    }
  }

  async function resolveRateArchive(dateNum) {
    var ds = fmtDateNum(String(dateNum || ''));
    try {
      var r = await fetch('data/' + ds + '.json?_=' + Date.now());
      if (r.ok) {
        var d = await r.json();
        if (d && d.rate && d.rate.rate) return d.rate;
      }
    } catch (e) { /* 忽略，走兜底 */ }
    try {
      var r2 = await fetch('data/latest.json?_=' + Date.now());
      if (r2.ok) {
        var d2 = await r2.json();
        if (d2 && d2.rate && d2.rate.rate) return d2.rate;
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  async function resolveRate(dateNum) {
    var key = String(dateNum || '');
    if (key && rateCache[key]) return rateCache[key];
    var live = await resolveRateLive(key);
    if (live) { if (key) rateCache[key] = live; return live; }
    var arch = await resolveRateArchive(key);
    if (arch) { if (key) rateCache[key] = arch; return arch; }
    return null;
  }

  /* ---- 当日封板率（贴在 ①② 数值后面，不参与那两个公式）----
   * 与「封板率基准」唯一的不同：这里请求的 date 就是「当天」。
   * 同花顺的池子在盘中会实时累加当日的涨停 / 炸板家数，收盘后定格为当日终值。
   *
   * 关键行为：当天还没有数据时（过零点 / 盘前 / 非交易日），
   * 往前回退到「最近一个有数据的交易日」，把上一次收盘的封板率一直留到次日开盘。
   * 否则每天一过零点就会变成「--」，既没意义又把版面弄花。
   */
  var todayRateCache = { at: 0, val: null, fallback: false };

  function ymdOfBJ(d) {
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  }
  // Unix 秒 → 北京时间归属日（服务器时间戳统一按北京时间归日）
  function tsToYmd(sec) {
    var n = parseInt(sec, 10);
    if (!isFinite(n)) return null;
    return ymdOfBJ(new Date((n + 8 * 3600) * 1000));
  }

  // 取「某一天」的封板率；该日无数据（total = 0）时返回 null
  async function fetchRateOn(dateNum) {
    var zt = await fetchPool('limit_up_pool', dateNum);
    await sleep(140);
    var zb = null;
    try { zb = await fetchPool('open_limit_pool', dateNum); } catch (e) { zb = null; }

    var A = (zt && zt.page) ? zt.page.total : 0;
    if (!A) return null;

    // 防「张冠李戴」：池子里最新的首封时间必须落在该日，否则不认。
    // （同花顺在盘前会把上一交易日的数据挂到今天的日期上，和分时接口是同一类行为）
    var info = zt.info || [], newest = 0;
    for (var i = 0; i < info.length; i++) {
      var t0 = parseInt(info[i].first_limit_up_time, 10);
      if (isFinite(t0) && t0 > newest) newest = t0;
    }
    if (newest && tsToYmd(newest) !== dateNum) return null;

    var Z = (zb && zb.page) ? zb.page.total : 0;
    var oneWord = 0;
    for (var j = 0; j < info.length; j++) { if (info[j].limit_up_type === '一字板') oneWord++; }
    var base = A - oneWord, d0 = A + Z, d1 = base + Z;
    return {
      date: dateNum, zt: A, zb: Z, oneWord: oneWord, base: base,
      rate: d0 > 0 ? +(A / d0 * 100).toFixed(4) : null,          // 总封板率（①口径）
      fbl: d1 > 0 ? +(base / d1 * 100).toFixed(4) : null         // 非一字板封板率（②口径）
    };
  }

  async function fetchTodayRate() {
    var today = ymdOfBJ(bjNow());
    // 当日实时数据 55 秒过期（刷新间隔 60 秒）；
    // 回退数据 5 分钟过期——盘前 / 非交易日它本来就不会变，没必要每分钟重问一遍。
    var ttl = todayRateCache.fallback ? 5 * 60 * 1000 : 55000;
    if (todayRateCache.val && Date.now() - todayRateCache.at < ttl) return todayRateCache.val;

    var r = await fetchRateOn(today);
    var fb = false;
    if (!r) {
      // 当天还没有数据 → 往前找最近一个有数据的交易日（跨周末最多 3 步，10 步是保险上限）
      for (var back = 1; back <= 10; back++) {
        var rr = await fetchRateOn(shiftYmd(today, -back));
        if (rr) { r = rr; fb = true; break; }
      }
    }
    todayRateCache = { at: Date.now(), val: r, fallback: fb };
    return r;
  }

  // 封板率高 = 情绪强（红）／低 = 情绪弱（绿）。三档：≥60 / 40~60 / ≤40
  function clsRate(p) { return p == null ? 'flat' : (p >= 60 ? 'up' : (p <= 40 ? 'down' : 'flat')); }
  function pctOf(v) { return (v == null || !isFinite(v)) ? '--' : v.toFixed(2) + '%'; }

  // 把「今日实时封板率」贴在 ①② 两个数值后面：①用总封板率、②用非一字板封板率
  function renderTodayRate(t) {
    var items = [['curRate', t ? t.rate : null], ['curRate2', t ? t.fbl : null]];
    for (var i = 0; i < items.length; i++) {
      var e = document.getElementById(items[i][0]);
      if (!e) continue;
      var v = items[i][1];
      e.textContent = (v == null) ? '--' : ('封板率 ' + v.toFixed(2) + '%');
      e.className = 'r ' + clsRate(v);
    }
  }

  async function loadHistory() {
    var res = await fetch('data/index.json?_=' + Date.now());
    if (!res.ok) throw new Error('index.json 读取失败');
    var idx = await res.json();
    var dates = (idx.dates || []).slice(-DAYS_5D);
    var out = [];
    for (var i = 0; i < dates.length; i++) {
      try {
        var r = await fetch('data/' + dates[i] + '.json?_=' + Date.now());
        if (r.ok) {
          var dd = await r.json();
          // 过滤掉尚无分钟点的空文件（例如刚开盘、当天还没采到数据）
          if (dd && dd.points && dd.points.length) out.push(dd);
        }
      } catch (e) { /* 忽略单日失败 */ }
    }
    return out;
  }

  /* ==================== 图表公共部件 ==================== */
  function getChart(id) {
    if (!charts[id]) {
      var dom = document.getElementById(id);
      if (!dom) return null;
      charts[id] = echarts.init(dom);
      window.addEventListener('resize', function () { charts[id].resize(); });
    }
    return charts[id];
  }

  function baseYAxis(min, max, step, digits) {
    return {
      type: 'value',
      min: min,
      max: max,
      interval: step,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: '#9aa1ab', fontSize: 11,
        formatter: function (v) { return digits ? Number(v).toFixed(digits) : String(Number(v)); }
      },
      splitLine: { lineStyle: { color: '#f1f2f4' } }
    };
  }

  // 1 日图横轴：固定为完整交易日的 242 个分钟刻度
  function baseXAxisDay() {
    return {
      type: 'category',
      data: DAY_TICKS,
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#dfe2e7' } },
      axisTick: { show: false },
      axisLabel: {
        color: '#9aa1ab', fontSize: 10,
        // 固定刻度下只保留整/半小时，避免 242 个标签互相压叠
        interval: function (i, v) { return !!DAY_LABELS[v]; }
      }
    };
  }

  // 5 日图专用横轴：刻度 = 5 天连续铺开的 'MMDD|HH:MM'
  function baseXAxis5d(ticks) {
    return {
      type: 'category',
      data: ticks,
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#dfe2e7' } },
      axisTick: { show: false },
      axisLabel: {
        color: '#9aa1ab', fontSize: 10,
        // 用 interval 过滤：5×242 个刻度里只留每天 4 个（开盘日 + 10:30/13:30/15:00）
        interval: function (i, v) { return !!label5dOf(v); },
        formatter: function (v) {
          var o = label5dOf(v);
          if (!o) return '';
          // 日期加粗突出，便于一眼分辨「这一段是哪个交易日」
          return o.date ? '{d|' + o.text + '}' : o.text;
        },
        rich: { d: { color: '#4b5563', fontSize: 10, fontWeight: 'bold' } }
      }
    };
  }

  // 多条横线：中性基准（灰）+ 下阈（红）+ 上阈（绿）
  function badgeLines(items) {
    return {
      silent: true, symbol: 'none',
      data: items.map(function (it) {
        return {
          yAxis: it.y,
          lineStyle: {
            color: it.color, type: 'dashed',
            width: it.width || 1, opacity: it.opacity == null ? .6 : it.opacity
          },
          label: {
            // 靠右放置：左端会被 y 轴刻度标签压住
            show: true, position: 'insideEndTop',
            formatter: it.label, color: it.color, fontSize: 10
          }
        };
      })
    };
  }

  // 背景警示带：下阈以下淡红、上阈以上淡绿（silent，不挡 tooltip）
  function dangerZones(yMin, yMax, lo, hi) {
    var d = [];
    if (lo > yMin) {
      d.push([
        { yAxis: yMin, itemStyle: { color: 'rgba(217,48,37,.075)' } },
        { yAxis: lo }
      ]);
    }
    if (hi < yMax) {
      d.push([
        { yAxis: hi, itemStyle: { color: 'rgba(15,157,88,.075)' } },
        { yAxis: yMax }
      ]);
    }
    return { silent: true, data: d };
  }

  // 按 y 值分段着色（< 下阈 红 / 区间内 本色 / > 上阈 绿）
  function zoneVisualMap(dim, lo, hi, midColor, seriesIndex) {
    return {
      type: 'piecewise',
      show: false,
      dimension: dim,
      seriesIndex: seriesIndex == null ? 0 : seriesIndex,
      pieces: [
        { lt: lo, color: C_RED },
        { gte: lo, lte: hi, color: midColor },
        { gt: hi, color: C_GREEN }
      ]
    };
  }

  function areaFill(rgb) {
    return {
      color: {
        type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: 'rgba(' + rgb + ',.20)' },
          { offset: 1, color: 'rgba(' + rgb + ',.01)' }
        ]
      }
    };
  }

  /* ==================== 指数① 涨停情绪指数 ==================== */
  function drawToday(rows, ratePct, notices) {
    var c = getChart('chartMain');
    if (!c) return;
    var lg = document.getElementById('legendMain');
    if (lg) lg.innerHTML = '';

    if (ratePct == null) {
      // 基准（昨日封板率）还没取到就不画，避免画出一条无意义的线
      c.clear();
      notices.push('昨日封板率基准尚未取到，曲线暂不可用。');
      return;
    }

    var pts = [];
    rows.forEach(function (p) {
      if (p.pct == null || !DAY_TICK_SET[p.t]) return;
      pts.push({ t: p.t, v: metric(ratePct, p.pct, p.bPct), pct: p.pct, bPct: p.bPct });
    });
    // 用 [时刻, 值] 配对：横轴固定为完整一天，数据只铺到当前时刻，右半段自然留白
    var data = pts.map(function (x) { return [x.t, +x.v.toFixed(5)]; });
    c.setOption({
      animation: false,
      grid: { left: 64, right: 22, top: 24, bottom: 30 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255,255,255,.97)',
        borderColor: '#e8eaed',
        textStyle: { color: '#1f2329', fontSize: 12 },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var it = ps[0];
          var p = pts[it.dataIndex];
          if (!p) return '';
          return it.axisValue +
            '<br/>指标 <b>' + p.v.toFixed(4) + '</b>' +
            '<br/>883900 ' + fmtPct(p.pct) +
            '<br/>上证 ' + fmtPct(p.bPct);
        }
      },
      xAxis: baseXAxisDay(),
      yAxis: baseYAxis(Y_MIN, Y_MAX, Y_STEP, 3),
      visualMap: zoneVisualMap(1, TH1_LO, TH1_HI, '#2f6bd8'),
      series: [{
        type: 'line', data: data, symbol: 'none', smooth: false,
        // 注意：这里不能写死 lineStyle.color，否则会盖掉 visualMap 的分段染色
        lineStyle: { width: 1.7 },
        areaStyle: areaFill('47,107,216'),
        markArea: dangerZones(Y_MIN, Y_MAX, TH1_LO, TH1_HI),
        markLine: badgeLines([
          { y: Y_BASE, label: '1.000', color: C_BASE },
          { y: TH1_LO, label: TH1_LO.toFixed(3), color: C_RED },
          { y: TH1_HI, label: TH1_HI.toFixed(3), color: C_GREEN }
        ])
      }]
    }, true);

    if (!pts.length) notices.push('当日暂无分时数据（未开盘或数据源暂不可用）。');
    var over = countOut(pts.map(function (x) { return x.v; }), Y_MIN, Y_MAX);
    if (over) {
      notices.push('⚠ 有 ' + over + ' 个点超出 ' + Y_MIN.toFixed(3) + '~' + Y_MAX.toFixed(3) +
        ' 固定显示区间，已裁掉不可见（区间不随数据缩放）。');
    }
  }

  /* 5 日视图：横轴 = 最近 5 个交易日「按顺序连续铺开」。
   *   每天占 DAY_TICKS.length 个刻度，整条曲线自左向右依次是 D-4 → D。
   *   每天仍是独立颜色的一段线（各自取所属交易日的基准），相邻两天之间用竖向虚线分隔。 */
  function draw5d(days, notices) {
    var c = getChart('chartMain');
    if (!c) return;
    var lg = document.getElementById('legendMain');
    if (lg) lg.innerHTML = '';

    var ax = build5dTicks(days);
    var series = [], allV = [], used = [];

    days.forEach(function (day, i) {
      var color = COLORS[i % COLORS.length];
      var mmdd = mmddOf(day.date);
      var base = (day.rate && day.rate.rate != null) ? day.rate.rate : null;
      var baseDate = (day.rate && day.rate.date) ? String(day.rate.date) : '';
      var pts = [];
      (day.points || []).forEach(function (p) {
        if (base == null || p.a == null || !DAY_TICK_SET[p.t]) return;
        var v = metric(base, p.a, p.b);
        if (!isFinite(v)) return;
        allV.push(v);
        pts.push([mmdd + '|' + p.t, +v.toFixed(5)]);
      });
      used.push({ date: day.date, mmdd: mmdd, base: base, baseDate: baseDate, color: color });
      if (!pts.length) return;                 // 该日无可用点就不建系列
      // 初期某天可能只有 1-2 个点：此时连线画不出来，至少把点标出来，避免「图例有、图上没有」
      var few = pts.length < 2;
      var s = {
        name: dashMMDD(mmdd),
        type: 'line',
        data: pts,
        symbol: few ? 'circle' : 'none',
        symbolSize: few ? 6 : 0,
        showSymbol: few,
        smooth: false,
        lineStyle: { width: 1.5, color: color },
        itemStyle: { color: color }
      };
      // 5 日图靠颜色区分「哪一天」，所以不按阈值改线色，
      // 只用背景警示带 + 阈值虚线表达「跌破 / 涨破」；
      // 竖向的「日分隔线」并进同一条 markLine，避免在多条线上重复渲染。
      if (!series.length) {
        s.markArea = dangerZones(Y_MIN, Y_MAX, TH1_LO, TH1_HI);
        var ml = badgeLines([
          { y: Y_BASE, label: '1.000', color: C_BASE },
          { y: TH1_LO, label: TH1_LO.toFixed(3), color: C_RED },
          { y: TH1_HI, label: TH1_HI.toFixed(3), color: C_GREEN }
        ]);
        ml.data = ml.data.concat(daySepLines5d(ax.ticks, ax.start));
        s.markLine = ml;
      }
      series.push(s);
    });

    if (!series.length) {
      c.clear();
      notices.push('历史数据积累中：暂无任何交易日存档，5 日图将在采集任务跑过之后出现。');
      return;
    }

    c.setOption({
      animation: false,
      grid: { left: 64, right: 22, top: 24, bottom: 30 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255,255,255,.97)',
        borderColor: '#e8eaed',
        textStyle: { color: '#1f2329', fontSize: 12 },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var out = ['<b>' + fmtKey5d(ps[0].axisValue) + '</b>'];
          ps.forEach(function (it) {
            if (it.data == null) return;
            var v = Number(it.data[1]);
            if (!isFinite(v)) return;
            out.push(it.marker + it.seriesName + ' <b>' + v.toFixed(4) + '</b>');
          });
          return out.length > 1 ? out.join('<br/>') : '';
        }
      },
      xAxis: baseXAxis5d(ax.ticks),
      yAxis: baseYAxis(Y_MIN, Y_MAX, Y_STEP, 3),
      series: series
    }, true);

    if (lg) {
      lg.innerHTML = used.map(function (u) {
        return '<span><i style="background:' + u.color + '"></i>' + u.date +
          '　封板率 ' + (u.base == null ? '--' : u.base.toFixed(2) + '%') +
          '（基准 ' + fmtBaseDay(u.baseDate) + '）</span>';
      }).join('');
    }

    if (used.length < 2) {
      notices.push('历史数据积累中：目前仅 ' + used.length + ' 个交易日。同花顺接口不提供按日期的历史分时，' +
        '5 日图由采集任务每个交易日自动追加一段。');
    }

    var over5 = countOut(allV, Y_MIN, Y_MAX);
    if (over5) {
      notices.push('⚠ 有 ' + over5 + ' 个点超出 ' + Y_MIN.toFixed(3) + '~' + Y_MAX.toFixed(3) +
        ' 固定显示区间，已裁掉不可见（区间不随数据缩放）。');
    }
  }

  /* ==================== 指数② 打板收益 ==================== */
  function drawToday2(rows, fblPct, notices) {
    var c = getChart('chart2');
    if (!c) return;
    var lg = document.getElementById('legend2');
    if (lg) lg.innerHTML = '';

    if (fblPct == null) {
      c.clear();
      notices.push('昨日非一字板封板率尚未取到，打板收益曲线暂不可用。');
      return;
    }

    var pts = [];
    rows.forEach(function (p) {
      if (p.pct == null || p.cPct == null || !DAY_TICK_SET[p.t]) return;
      var v = metric2(p.cPct, p.pct, fblPct);
      if (v == null) return;
      pts.push({ t: p.t, v: v, pct: p.pct, cPct: p.cPct });
    });
    var data = pts.map(function (x) { return [x.t, +x.v.toFixed(2)]; });

    c.setOption({
      animation: false,
      grid: { left: 64, right: 22, top: 24, bottom: 30 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255,255,255,.97)',
        borderColor: '#e8eaed',
        textStyle: { color: '#1f2329', fontSize: 12 },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var it = ps[0];
          var p = pts[it.dataIndex];
          if (!p) return '';
          return it.axisValue +
            '<br/>打板收益 <b>' + p.v.toFixed(2) + '</b> 元/万' +
            '<br/>883900 ' + fmtPct(p.pct) +
            '<br/>883918 ' + fmtPct(p.cPct);
        }
      },
      xAxis: baseXAxisDay(),
      yAxis: baseYAxis(Y2_MIN, Y2_MAX, Y2_STEP, 0),
      visualMap: zoneVisualMap(1, TH2_LO, TH2_HI, '#e08a1e'),
      series: [{
        type: 'line', data: data, symbol: 'none', smooth: false,
        // 同上：颜色交给 visualMap 分段决定
        lineStyle: { width: 1.7 },
        areaStyle: areaFill('224,138,30'),
        markArea: dangerZones(Y2_MIN, Y2_MAX, TH2_LO, TH2_HI),
        markLine: badgeLines([
          { y: Y2_BASE, label: '0', color: C_BASE },
          { y: TH2_LO, label: String(TH2_LO), color: C_RED },
          { y: TH2_HI, label: String(TH2_HI), color: C_GREEN }
        ])
      }]
    }, true);

    if (!pts.length) notices.push('当日暂无分时数据（未开盘或数据源暂不可用）。');
    var over = countOut(pts.map(function (x) { return x.v; }), Y2_MIN, Y2_MAX);
    if (over) {
      notices.push('⚠ 有 ' + over + ' 个点超出 ' + Y2_MIN + '~' + Y2_MAX +
        ' 固定显示区间，已裁掉不可见（区间不随数据缩放）。');
    }
  }

  /* 指数②的 5 日视图：横轴口径与 draw5d 完全一致（5 天按顺序连续铺开、日间竖虚线分隔） */
  function draw5d2(days, notices) {
    var c = getChart('chart2');
    if (!c) return;
    var lg = document.getElementById('legend2');
    if (lg) lg.innerHTML = '';

    var ax = build5dTicks(days);
    var series = [], allV = [], used = [];

    days.forEach(function (day, i) {
      var fbl = day.rate && day.rate.fbl;
      if (fbl == null || !isFinite(fbl)) return;             // 该日缺「非一字板封板率」基准
      var color = COLORS[i % COLORS.length];
      var mmdd = mmddOf(day.date);
      var pts = [];
      (day.points || []).forEach(function (p) {
        if (p.c == null || !DAY_TICK_SET[p.t]) return;        // 缺 883918 的点跳过
        var v = metric2(p.c, p.a, fbl);
        if (v == null) return;
        allV.push(v);
        pts.push([mmdd + '|' + p.t, +v.toFixed(2)]);
      });
      if (!pts.length) return;                                // 完全没有可用点就不画（避免空图例）
      used.push({ date: day.date, fbl: fbl, color: color });
      var few = pts.length < 2;
      var s2 = {
        name: dashMMDD(mmdd), type: 'line', data: pts,
        symbol: few ? 'circle' : 'none', symbolSize: few ? 6 : 0, showSymbol: few,
        smooth: false, lineStyle: { width: 1.5, color: color }, itemStyle: { color: color }
      };
      if (!series.length) {
        s2.markArea = dangerZones(Y2_MIN, Y2_MAX, TH2_LO, TH2_HI);
        var ml2 = badgeLines([
          { y: Y2_BASE, label: '0', color: C_BASE },
          { y: TH2_LO, label: String(TH2_LO), color: C_RED },
          { y: TH2_HI, label: String(TH2_HI), color: C_GREEN }
        ]);
        ml2.data = ml2.data.concat(daySepLines5d(ax.ticks, ax.start));
        s2.markLine = ml2;
      }
      series.push(s2);
    });

    if (!series.length) {
      c.clear();
      notices.push('打板收益的 5 日图需要同时具备「非一字板封板率」和 883918 分时，' +
        '而 883918 历史分时不可获取，只能从本指标上线当天起逐日累积。');
      return;
    }

    c.setOption({
      animation: false,
      grid: { left: 64, right: 22, top: 24, bottom: 30 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255,255,255,.97)',
        borderColor: '#e8eaed',
        textStyle: { color: '#1f2329', fontSize: 12 },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var out = ['<b>' + fmtKey5d(ps[0].axisValue) + '</b>'];
          ps.forEach(function (it) {
            if (it.data == null) return;
            var v = Number(it.data[1]);
            if (!isFinite(v)) return;
            out.push(it.marker + it.seriesName + ' <b>' + v.toFixed(2) + '</b>');
          });
          return out.length > 1 ? out.join('<br/>') : '';
        }
      },
      xAxis: baseXAxis5d(ax.ticks),
      yAxis: baseYAxis(Y2_MIN, Y2_MAX, Y2_STEP, 0),
      series: series
    }, true);

    if (lg) {
      lg.innerHTML = used.map(function (u) {
        return '<span><i style="background:' + u.color + '"></i>' + u.date +
          '　非一字板封板率 ' + u.fbl.toFixed(2) + '%</span>';
      }).join('');
    }

    if (used.length < 2) {
      notices.push('打板收益的历史曲线积累中：目前仅 ' + used.length + ' 个交易日。' +
        '同花顺不提供 883918 的历史分时，只能逐交易日累积。');
    }
    var over = countOut(allV, Y2_MIN, Y2_MAX);
    if (over) {
      notices.push('⚠ 有 ' + over + ' 个点超出 ' + Y2_MIN + '~' + Y2_MAX +
        ' 固定显示区间，已裁掉不可见（区间不随数据缩放）。');
    }
  }

  /* ==================== 视图切换（1日 / 5日，两张图共用） ==================== */
  var VIEW = (function () {
    // 支持 ?view=5d 深链接直达
    try {
      var m = String(location.search).match(/[?&]view=(1d|5d)\b/);
      return m ? m[1] : '1d';
    } catch (e) { return '1d'; }
  })();
  var state = { rows: [], rate: null, days: [] };

  var HINT_1D = '实时计算，每分钟刷新；横轴固定为完整交易日 09:30–15:00';
  var HINT_5D = '最近 5 个交易日按顺序连续铺开：横轴跨 5 天，日内仍是分钟粒度；'
    + '每天取「所属交易日的前一交易日」封板率作基准，日与日之间以竖虚线分隔';

  function renderAll() {
    var n1 = [], n2 = [];
    var isDay = (VIEW === '1d');
    if (isDay) {
      drawToday(state.rows, state.rate ? state.rate.rate : null, n1);
      drawToday2(state.rows, state.rate ? state.rate.fbl : null, n2);
    } else {
      // chartDays = 仓库存档 + 当天直连（见 refresh）；缺失时退回存档
      var ds = (state.chartDays && state.chartDays.length) ? state.chartDays : state.days;
      draw5d(ds, n1);
      draw5d2(ds, n2);
    }
    var e1 = document.getElementById('hintMain');
    if (e1) e1.innerHTML = n1.filter(Boolean).join('<br/>');
    var e2 = document.getElementById('hint2');
    if (e2) e2.innerHTML = n2.filter(Boolean).join('<br/>');
  }

  function bindTabs() {
    var box = document.getElementById('viewTabs');
    if (!box) return;
    // 初始态与 VIEW 对齐（含 ?view=5d 直达）
    Array.prototype.forEach.call(box.querySelectorAll('button'), function (x) {
      x.className = (x.getAttribute('data-v') === VIEW) ? 'on' : '';
    });
    var hint0 = document.getElementById('viewHint');
    if (hint0 && VIEW === '5d') {
      hint0.textContent = HINT_5D;
    }
    box.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-v]') : null;
      if (!b) return;
      var v = b.getAttribute('data-v');
      if (v === VIEW) return;
      VIEW = v;
      Array.prototype.forEach.call(box.querySelectorAll('button'), function (x) {
        x.className = (x === b) ? 'on' : '';
      });
      var hint = document.getElementById('viewHint');
      if (hint) {
        hint.textContent = (v === '1d') ? HINT_1D : HINT_5D;
      }
      renderAll();
    });
  }

  /* ==================== 主流程 ==================== */
  function inSession(now) {
    var day = now.getUTCDay();
    if (day === 0 || day === 6) return false;
    var m = now.getUTCHours() * 60 + now.getUTCMinutes();
    return m >= 570 && m <= 900;   // 北京时间 09:30 - 15:00
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    var dot = document.getElementById('liveDot');
    if (dot) dot.className = 'dot';
    setText('liveText', '正在请求数据…');
    var errBox = document.getElementById('errBox');
    if (errBox) errBox.textContent = '';

    try {
      var now = bjNow();

      // 0) 历史（5 日图 & 非交易时段的当日图都依赖它）
      var days = [];
      try { days = await loadHistory(); } catch (e) { days = []; }
      state.days = days;

      var rows = [], rate = null, dataDate = null, archived = false;

      // ---- 直连同花顺分时（盘中 / 盘后都用它）----
      // 关键点：盘后该接口返回的是当日「完整」分时，末点即收盘值，所以收盘后也能直接算出收盘结果，
      // 不再依赖仓库里的当日存档（存档可能因 GitHub 定时任务未触发而缺半天，之前就是这样显示错的）。
      try {
        var aPack = await getTimeSeries('a', '48', '883900');
        await sleep(160);
        var bPack = await getTimeSeries('b', 'hs', '1A0001');
        await sleep(160);
        var cPack = null;
        try { cPack = await getTimeSeries('c', '48', '883918'); } catch (e) { cPack = null; }

        var bMap = {};
        bPack.rows.forEach(function (x) { bMap[x.t] = x.pct; });
        var cMap = {};
        if (cPack) cPack.rows.forEach(function (x) { cMap[x.t] = x.pct; });

        aPack.rows.forEach(function (x) {
          var b = bMap[x.t];
          if (x.pct == null || b == null) return;
          // 883918 取不到时只置空 cPct（指数②跳过该点），不影响指数①
          rows.push({ t: x.t, pct: x.pct, bPct: b, cPct: (cMap[x.t] == null ? null : cMap[x.t]) });
        });
        dataDate = aPack.date ? String(aPack.date) : null;

        // 同花顺的已知行为：开盘前调用分时接口，会把「上一交易日的完整分时」
        // 原样返回、却把 date 标成今天。若不识别，页面会在盘前把昨天的曲线
        // 当成今天画出（顶部日期还显示今天），属于张冠李戴。
        // 判据：分时末点的时刻晚于「现在」→ 不可能是当日数据 → 丢弃，改走存档兜底。
        //   盘前 09:26 末点 15:00 → 丢弃 ✔ ；盘中 10:00 末点 10:00 → 保留 ✔ ；
        //   午休 11:35 末点 11:30 → 保留 ✔ ；盘后 15:30 末点 15:00 → 保留 ✔
        var endTick = rows.length ? rows[rows.length - 1].t : null;
        if (endTick) {
          var em = parseInt(endTick.slice(0, 2), 10) * 60 + parseInt(endTick.slice(3, 5), 10);
          var nm = now.getUTCHours() * 60 + now.getUTCMinutes();
          if (isFinite(em) && em > nm + 2) { rows = []; }
        }
      } catch (e) {
        rows = [];
      }

      if (rows.length) rate = await resolveRate(dataDate);

      // ---- 兜底：直连失败时退回仓库里最近一个交易日的存档 ----
      if (!rows.length) {
        var lastDay = days.length ? days[days.length - 1] : null;
        if (lastDay) {
          rate = lastDay.rate;
          dataDate = String(lastDay.date || '').replace(/-/g, '');
          rows = (lastDay.points || []).map(function (p) {
            return { t: p.t, pct: p.a, bPct: p.b, cPct: (p.c == null ? null : p.c) };
          });
          archived = true;
        }
      }
      if (!rate && days.length) rate = days[days.length - 1].rate;

      // ---- 渲染 ----
      state.rows = rows;
      state.rate = rate;

      // 5 日图的数据源 = 仓库存档 + 「当天直连」。
      // 当天的存档要等收盘后 Actions 才写回仓库，页面不必等它：
      // 直连已经拿到当天完整分时（收盘后末点即收盘值），直接并进 5 日图，
      // 当天那根线立刻就有，定时任务跑不跑都不影响阅读。
      var chartDays = days.slice();
      if (!archived && rows.length && dataDate && rate) {
        var dStr = fmtDateNum(dataDate);
        var dup = false;
        for (var ci = 0; ci < chartDays.length; ci++) {
          if (chartDays[ci].date === dStr) { dup = true; break; }
        }
        if (!dup) {
          chartDays.push({
            date: dStr, rate: rate, live: true,
            points: rows.map(function (r) {
              return { t: r.t, a: r.pct, b: r.bPct, c: r.cPct };
            })
          });
        }
      }
      if (chartDays.length > DAYS_5D) chartDays = chartDays.slice(-DAYS_5D);
      state.chartDays = chartDays;

      if (rate) {
        var tag = rate.src === 'live' ? '' : '［存档］';
        setText('rateText', rate.rate.toFixed(2) + '%（' + rate.zt + '/' + (rate.zt + rate.zb) +
          '，基准日 ' + rate.date + '）' + tag);
        setText('fblText', rate.fbl == null ? '--' :
          rate.fbl.toFixed(2) + '%（' + rate.base + '/' + (rate.base + rate.zb) +
          '，剔除一字板 ' + rate.oneWord + ' 家，炸板率 ' + rate.zbl.toFixed(2) + '%）' + tag);
      } else {
        setText('rateText', '未取到');
        setText('fblText', '未取到');
      }

      // 顶部数值统一取「三个输入量都齐」的最后一个点，避免 883918 比分时慢一拍时出现空值。
      // 若 883918 整段缺失，则退回到只要求 883900 + 上证（此时指数②显示 --）。
      var lastAll = null, lastAB = null;
      for (var ri = rows.length - 1; ri >= 0; ri--) {
        var r0 = rows[ri];
        if (lastAB === null && r0.pct != null && r0.bPct != null) lastAB = r0;
        if (r0.pct != null && r0.bPct != null && r0.cPct != null) { lastAll = r0; break; }
      }
      var last = lastAll || lastAB;

      // 指数①
      var vEl = document.getElementById('curValue');
      var dEl = document.getElementById('curDelta');
      if (last && rate && rate.rate != null) {
        var cur = metric(rate.rate, last.pct, last.bPct);
        if (vEl) { vEl.textContent = cur.toFixed(4); vEl.className = 'v ' + cls1(cur); }
        if (dEl) {
          var dev = (cur - 1) * 100;
          dEl.textContent = (dev >= 0 ? '+' : '') + dev.toFixed(3) + ' 相对基准';
          dEl.className = 'd ' + cls1(cur);
        }
      } else {
        if (vEl) { vEl.textContent = '--'; vEl.className = 'v flat'; }
        if (dEl) { dEl.textContent = '--'; dEl.className = 'd flat'; }
      }

      // 指数②
      var v2El = document.getElementById('curValue2');
      var d2El = document.getElementById('curDelta2');
      var cur2 = (lastAll && rate && rate.fbl != null) ? metric2(lastAll.cPct, lastAll.pct, rate.fbl) : null;
      if (cur2 == null) {
        if (v2El) { v2El.textContent = '--'; v2El.className = 'v flat'; }
        if (d2El) { d2El.textContent = '--'; d2El.className = 'd flat'; }
      } else {
        if (v2El) { v2El.textContent = cur2.toFixed(2); v2El.className = 'v ' + cls2(cur2); }
        if (d2El) {
          d2El.textContent = (cur2 >= 0 ? '+' : '') + cur2.toFixed(2) + ' 元/万（0 = 不赚不亏）';
          d2El.className = 'd ' + cls2(cur2);
        }
      }

      if (last) {
        setText('aText', fmtPct(last.pct));
        setText('shText', fmtPct(last.bPct));
        setText('cText', lastAll ? fmtPct(lastAll.cPct) : '--');
        setText('lastPoint', last.t + (lastAll && lastAll.t !== last.t ? '（883918 到 ' + lastAll.t + '）' : ''));
      }

      // 今日实时封板率：贴在 ①② 数值后面（独立于公式，取不到就显示 --）
      var todayLive = null;
      try { todayLive = await fetchTodayRate(); } catch (e) { todayLive = null; }
      renderTodayRate(todayLive);

      // 按当前选中的视图（1日 / 5日）绘制两张图
      renderAll();

      if (dataDate) {
        setText('quoteTime', dataDate.slice(0, 4) + '-' + dataDate.slice(4, 6) + '-' + dataDate.slice(6, 8));
      }

      if (dot) dot.className = 'dot on';
      // 三种状态分开说：盘中（当天数据在跑）/ 盘前（当天还没有数据，显示上一交易日）/ 盘后（当天已收盘，分时是完整的）
      var dW = now.getUTCDay();
      var minsNow = now.getUTCHours() * 60 + now.getUTCMinutes();
      var isPre = (dW >= 1 && dW <= 5) && minsNow < 570;

      // 数据末点比当前时间落后 3 分钟以上 → 直接写明「数据停在几点」，
      // 免得页面看着在刷新、其实曲线没动（浏览器缓存 / 网络中间层都会造成）。
      var staleTxt = '';
      if (last && inSession(now)) {
        var lm = parseInt(last.t.slice(0, 2), 10) * 60 + parseInt(last.t.slice(3, 5), 10);
        if (isFinite(lm) && minsNow - lm >= 3) staleTxt = '　⚠ 数据停在 ' + last.t;
      }

      setText('liveText', (inSession(now) ? '已连接 · 盘中实时刷新'
        : (isPre ? '已连接 · 盘前，显示上一交易日' : '已连接 · 已收盘（当日完整分时）')) +
        (archived ? '　[暂用最近交易日存档]' : '') + staleTxt);

    } catch (e) {
      if (dot) dot.className = 'dot err';
      setText('liveText', '连接异常 · 重试中');
      if (errBox) errBox.textContent = '数据获取失败（' + e.message + '），将在下一轮自动重试。';
    } finally {
      busy = false;
      left = REFRESH_SEC;
    }
  }

  function tick() {
    var now = bjNow();
    setText('localTime', hmOf(now) + ':' + pad(now.getUTCSeconds()) + ' · ' + phaseText(now));
    left -= 1;
    if (left <= 0) {
      setText('countdown', '—');
      refresh();
    } else {
      setText('countdown', left);
    }
  }

  /* ==================== 启动 ==================== */
  bindTabs();
  refresh();
  setInterval(tick, 1000);

  // 标签页切到后台时浏览器会节流甚至冻结 setInterval，
  // 切回来就会看到「本地时间在走、数据却停在几分钟前」。重新可见时立刻补一次刷新，
  // 不必再干等满一个 60 秒周期。
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    left = 0;
    setText('countdown', '—');
    refresh();
  });
  window.addEventListener('online', function () { left = 0; refresh(); });
})();
