(function () {
  'use strict';

  /* ==================== 配置 ==================== */
  var BASE = 'https://d.10jqka.com.cn';
  var REFRESH_SEC = 60;
  var AXIS_STEP = 0.025;          // y 轴刻度：0.95 / 0.975 / 1.00 / 1.025 / 1.05 …
  var DAYS_5D = 5;
  var COLORS = ['#2f6bd8', '#d93025', '#0f9d58', '#e08a1e', '#7b61c9'];

  var charts = {};
  var left = REFRESH_SEC;
  var busy = false;

  /* ==================== 通用工具 ==================== */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function setText(id, t) { var e = document.getElementById(id); if (e) e.textContent = t; }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
  function cls1(v) { return v > 1.0000001 ? 'up' : (v < 0.9999999 ? 'down' : 'flat'); }
  function fmtT(s) { s = String(s); return s.length === 4 ? s.slice(0, 2) + ':' + s.slice(2) : s; }
  function fmtPct(v) { var n = num(v); return n === null ? '--' : (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 指标值：涨跌幅以「小数」代入
  function metric(ratePct, aPct, bPct) {
    return (ratePct / 100) * (aPct / 100) + 1 + (bPct / 100) / 20;
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

  // y 轴范围：上下至少各留一个 0.025 档，并对齐到 0.025 的整数倍
  function axisOf(values) {
    var lo = 1 - AXIS_STEP, hi = 1 + AXIS_STEP;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (typeof v === 'number' && isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    var min = Math.floor(lo / AXIS_STEP) * AXIS_STEP;
    var max = Math.ceil(hi / AXIS_STEP) * AXIS_STEP;
    return { min: +min.toFixed(6), max: +max.toFixed(6), interval: AXIS_STEP };
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

  /* ==================== 取数 ==================== */
  async function getTimeSeries(cbKey, prefix, code, dateNum) {
    var suffix = dateNum ? ('/' + dateNum) : '/last';
    var cb = 'quotebridge_v6_time_' + prefix + '_' + code + (dateNum ? ('_' + dateNum) : '_last');
    var url = BASE + '/v6/time/' + prefix + '_' + code + suffix + '.js';
    var d = await jsonp(url, cb);
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

  // 「昨日封板率」来源：仓库内的 data/*.json（由 GitHub Actions 采集时写入）。
  // 注：data.10jqka.com.cn 的 CORS 响应头依赖 Referer，浏览器跨站 fetch 会被拒，
  //     所以前端不直连该接口，只读同域名下的静态 JSON。
  async function resolveRate(dateNum) {
    var ds = fmtDateNum(String(dateNum));
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

  /* ==================== 图表 ==================== */
  function getChart(id) {
    if (!charts[id]) {
      var dom = document.getElementById(id);
      if (!dom) return null;
      charts[id] = echarts.init(dom);
      window.addEventListener('resize', function () { charts[id].resize(); });
    }
    return charts[id];
  }

  function baseYAxis(ax) {
    return {
      type: 'value',
      min: ax.min,
      max: ax.max,
      interval: ax.interval,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#9aa1ab', fontSize: 11, formatter: function (v) { return Number(v).toFixed(3); } },
      splitLine: { lineStyle: { color: '#f1f2f4' } }
    };
  }

  function baseXAxis(xs) {
    return {
      type: 'category',
      data: xs,
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#dfe2e7' } },
      axisTick: { show: false },
      axisLabel: {
        color: '#9aa1ab', fontSize: 10,
        interval: xs.length ? Math.max(0, Math.ceil(xs.length / 8) - 1) : 0
      }
    };
  }

  function benchmarkLine() {
    return {
      silent: true, symbol: 'none',
      lineStyle: { color: '#d93025', type: 'dashed', width: 1, opacity: .55 },
      label: {
        show: true, position: 'insideEndTop',
        formatter: '1.000', color: '#d93025', fontSize: 10
      },
      data: [{ yAxis: 1 }]
    };
  }

  function drawToday(rows, ratePct) {
    var c = getChart('chartToday');
    if (!c) return;
    var xs = [], ys = [];
    rows.forEach(function (p) {
      if (p.pct == null) return;
      xs.push(p.t);
      ys.push(metric(ratePct, p.pct, p.bPct));
    });
    var ax = axisOf(ys);
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
          var p = rows[it.dataIndex] || {};
          return it.axisValue +
            '<br/>指标 <b>' + Number(it.data).toFixed(4) + '</b>' +
            '<br/>883900 ' + fmtPct(p.pct) +
            '<br/>上证 ' + fmtPct(p.bPct);
        }
      },
      xAxis: baseXAxis(xs),
      yAxis: baseYAxis(ax),
      series: [{
        type: 'line', data: ys, symbol: 'none', smooth: false,
        lineStyle: { width: 1.7, color: '#2f6bd8' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(47,107,216,.20)' },
              { offset: 1, color: 'rgba(47,107,216,.01)' }
            ]
          }
        },
        markLine: benchmarkLine()
      }]
    }, true);
  }

  function draw5d(days) {
    var c = getChart('chart5d');
    if (!c) return;
    var set = {}, allX = [];
    var series = [];
    var allV = [];

    days.forEach(function (day, i) {
      var color = COLORS[i % COLORS.length];
      var pts = (day.points || []).map(function (p) {
        var v = metric(day.rate.rate, p.a, p.b);
        allV.push(v);
        if (!set[p.t]) { set[p.t] = 1; allX.push(p.t); }
        return [p.t, +v.toFixed(5)];
      });
      series.push({
        name: day.date,
        type: 'line',
        data: pts,
        symbol: 'none',
        smooth: false,
        lineStyle: { width: 1.5, color: color },
        itemStyle: { color: color }
      });
    });

    allX.sort();
    var ax = axisOf(allV);

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
          var out = [ps[0].axisValue];
          ps.forEach(function (it) {
            if (it.data == null) return;
            out.push(it.marker + it.seriesName + ' <b>' + Number(it.data[1]).toFixed(4) + '</b>');
          });
          return out.join('<br/>');
        }
      },
      xAxis: baseXAxis(allX),
      yAxis: baseYAxis(ax),
      series: series
    }, true);

    // 图例
    var lg = document.getElementById('legend5d');
    if (lg) {
      lg.innerHTML = days.map(function (d, i) {
        var color = COLORS[i % COLORS.length];
        return '<span><i style="background:' + color + '"></i>' + d.date +
          '　封板率 ' + d.rate.rate.toFixed(2) + '%</span>';
      }).join('');
    }
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
      if (days.length) draw5d(days);

      var rows = [], rate = null, dataDate = null;

      if (inSession(now)) {
        // ---- 盘中：直连同花顺实时分时，逐分钟现算 ----
        var aPack = await getTimeSeries('a', '48', '883900');
        await sleep(200);
        var bPack = await getTimeSeries('b', 'hs', '1A0001');

        var bMap = {};
        bPack.rows.forEach(function (x) { bMap[x.t] = x.pct; });
        aPack.rows.forEach(function (x) {
          var b = bMap[x.t];
          if (x.pct == null || b == null) return;
          rows.push({ t: x.t, pct: x.pct, bPct: b });
        });
        dataDate = aPack.date ? String(aPack.date) : null;
        rate = await resolveRate(dataDate);
        if (!rate && days.length) rate = days[days.length - 1].rate;

      } else {
        // ---- 非交易时段：同花顺会把 date 标成今天但给的是上一交易日数据，
        //      直接改用仓库里最近一个交易日的存档，保证 曲线 / 封板率 同日 ----
        var lastDay = days.length ? days[days.length - 1] : null;
        if (lastDay) {
          rate = lastDay.rate;
          dataDate = String(lastDay.date || '').replace(/-/g, '');
          rows = (lastDay.points || []).map(function (p) {
            return { t: p.t, pct: p.a, bPct: p.b };
          });
        }
      }

      // ---- 渲染 ----
      if (rate) {
        setText('rateText', rate.rate.toFixed(2) + '%（' + rate.zt + '/' + (rate.zt + rate.zb) + '，基准日 ' + rate.date + '）');
      } else {
        setText('rateText', '未取到');
      }

      var last = rows.length ? rows[rows.length - 1] : null;
      if (last && rate) {
        var cur = metric(rate.rate, last.pct, last.bPct);
        var vEl = document.getElementById('curValue');
        if (vEl) { vEl.textContent = cur.toFixed(4); vEl.className = 'v ' + cls1(cur); }
        var dEl = document.getElementById('curDelta');
        if (dEl) {
          var dev = (cur - 1) * 100;
          dEl.textContent = (dev >= 0 ? '+' : '') + dev.toFixed(3) + ' 相对基准';
          dEl.className = 'd ' + cls1(cur);
        }
        setText('aText', fmtPct(last.pct));
        setText('shText', fmtPct(last.bPct));
        setText('lastPoint', last.t);
        drawToday(rows, rate.rate);
      }

      if (dataDate) {
        setText('quoteTime', dataDate.slice(0, 4) + '-' + dataDate.slice(4, 6) + '-' + dataDate.slice(6, 8));
      }

      if (dot) dot.className = 'dot on';
      setText('liveText', inSession(now) ? '已连接 · 盘中实时刷新' : '已连接 · 显示最近交易日');

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
  refresh();
  setInterval(tick, 1000);
})();
