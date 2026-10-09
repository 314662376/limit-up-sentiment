(function () {
  'use strict';

  /* ==================== 配置 ==================== */
  var BASE = 'https://d.10jqka.com.cn';
  var REFRESH_SEC = 60;
  var AXIS_STEP = 0.025;          // y 轴刻度：0.95 / 0.975 / 1.00 / 1.025 / 1.05
  var Y_MIN = 0.95, Y_MAX = 1.05; // y 轴固定区间：不随数据自动放大缩小
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

  // 完整交易日的分钟刻度（09:30-11:30、13:00-15:00，午休不占位）。
  // 当日分时图的横轴固定使用这一整套，盘中不随实时数据向右延长。
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

  // 超出固定 y 轴区间的点数（区间是硬约束，超出的点会被裁掉，用提示兜底）
  function countOut(values) {
    var n = 0;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (typeof v === 'number' && isFinite(v) && (v < Y_MIN || v > Y_MAX)) n++;
    }
    return n;
  }

  // 指标值：涨跌幅以「小数」代入
  function metric(ratePct, aPct, bPct) {
    // 对应 Excel 式 =C3/100*D3+1+E3/20
    //   C 昨日封板率 → 百分数（47.92）
    //   D 昨日涨停表现 → 小数（0.0248 即 2.48%）
    //   E 上证%      → 百分数（0.48 即 +0.48%），不再除以 100
    return (ratePct / 100) * (aPct / 100) + 1 + bPct / 20;
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

  // y 轴固定区间，不再按数据自适应（避免盘中线一波动就缩放）

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

  function baseYAxis() {
    return {
      type: 'value',
      min: Y_MIN,
      max: Y_MAX,
      interval: AXIS_STEP,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#9aa1ab', fontSize: 11, formatter: function (v) { return Number(v).toFixed(3); } },
      splitLine: { lineStyle: { color: '#f1f2f4' } }
    };
  }

  function baseXAxis(xs, isDay) {
    return {
      type: 'category',
      data: xs,
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#dfe2e7' } },
      axisTick: { show: false },
      axisLabel: isDay
        ? {
          color: '#9aa1ab', fontSize: 10,
          // 固定刻度下只保留整/半小时，避免 242 个标签互相压叠
          interval: function (i, v) { return !!DAY_LABELS[v]; }
        }
        : {
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
      xAxis: baseXAxis(DAY_TICKS, true),
      yAxis: baseYAxis(),
      series: [{
        type: 'line', data: data, symbol: 'none', smooth: false,
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

    if (!pts.length) notices.push('当日暂无分时数据（未开盘或数据源暂不可用）。');
    var over = countOut(pts.map(function (x) { return x.v; }));
    if (over) {
      notices.push('⚠ 有 ' + over + ' 个点超出 ' + Y_MIN.toFixed(3) + '~' + Y_MAX.toFixed(3) +
        ' 固定显示区间，已裁掉不可见（区间不随数据缩放）。');
    }
  }

  function draw5d(days, notices) {
    var c = getChart('chartMain');
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
      // 初期某天可能只有 1-2 个点：此时连线画不出来，至少把点标出来，避免「图例有、图上没有」
      var few = pts.length < 2;
      series.push({
        name: day.date,
        type: 'line',
        data: pts,
        symbol: few ? 'circle' : 'none',
        symbolSize: few ? 6 : 0,
        showSymbol: few,
        smooth: false,
        lineStyle: { width: 1.5, color: color },
        itemStyle: { color: color }
      });
    });

    allX.sort();

    if (!series.length) {
      c.clear();
      var lg0 = document.getElementById('legendMain');
      if (lg0) lg0.innerHTML = '';
      notices.push('历史数据积累中：暂无任何交易日存档，5 日图将在 GitHub Actions 采集后出现。');
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
          var out = [ps[0].axisValue];
          ps.forEach(function (it) {
            if (it.data == null) return;
            out.push(it.marker + it.seriesName + ' <b>' + Number(it.data[1]).toFixed(4) + '</b>');
          });
          return out.join('<br/>');
        }
      },
      xAxis: baseXAxis(allX),
      yAxis: baseYAxis(),
      series: series
    }, true);

    // 图例
    var lg = document.getElementById('legendMain');
    if (lg) {
      lg.innerHTML = days.map(function (d, i) {
        var color = COLORS[i % COLORS.length];
        var rd = d.rate && d.rate.date ? String(d.rate.date) : '';
        var rds = rd.length === 8 ? rd.slice(4, 6) + '-' + rd.slice(6, 8) : rd;
        return '<span><i style="background:' + color + '"></i>' + d.date +
          '　封板率 ' + d.rate.rate.toFixed(2) + '%（基准 ' + rds + '）</span>';
      }).join('');
    }

    // 历史不足时的说明（同花顺不提供按日期的历史分时，只能逐日累积）
    if (days.length < 2) {
      notices.push('历史数据积累中：目前仅 ' + days.length + ' 个交易日。同花顺接口不提供按日期的历史分时，' +
        '5 日图由 GitHub Actions 每个交易日自动追加一条曲线。');
    }

    var over5 = countOut(allV);
    if (over5) {
      notices.push('⚠ 有 ' + over5 + ' 个点超出 ' + Y_MIN.toFixed(3) + '~' + Y_MAX.toFixed(3) +
        ' 固定显示区间，已裁掉不可见（区间不随数据缩放）。');
    }
  }

  /* ==================== 视图切换（1日 / 5日） ==================== */
  var VIEW = '1d';
  var state = { rows: [], ratePct: null, days: [] };

  function renderMain() {
    var notices = [];
    if (VIEW === '1d') drawToday(state.rows, state.ratePct, notices);
    else draw5d(state.days, notices);
    var el = document.getElementById('hintMain');
    if (el) el.innerHTML = notices.filter(Boolean).join('<br/>');
  }

  function bindTabs() {
    var box = document.getElementById('viewTabs');
    if (!box) return;
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
        hint.textContent = (v === '1d')
          ? '实时计算，每分钟刷新；横轴固定为完整交易日 09:30–15:00'
          : '最近 5 个交易日叠加对比（每条线的封板率系数取各自的前一交易日）';
      }
      renderMain();
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
      state.rows = rows;
      state.ratePct = rate ? rate.rate : null;

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
      }

      // 按当前选中的视图（1日 / 5日）绘制
      renderMain();

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
  bindTabs();
  refresh();
  setInterval(tick, 1000);
})();
