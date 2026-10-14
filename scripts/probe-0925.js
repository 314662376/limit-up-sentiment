/* 探测「09:25 集合竞价刚结束」这个时点，各接口到底能给出什么。
 * 这决定了「9点25分更新页面」到底能更新出什么内容，不能靠猜。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' });
  return { status: r.status, text: await r.text() };
}
function parseJsonp(t) {
  const i = t.indexOf('('), j = t.lastIndexOf(')');
  if (i < 0) return null;
  return JSON.parse(t.slice(i + 1, j));
}
function nowBJ() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => (n < 10 ? '0' : '') + n;
  return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

(async () => {
  console.log('本地北京时间：' + nowBJ() + '\n');

  console.log('======== 一、分时接口（last = 最近一个交易日）========');
  for (const [lbl, u] of [
    ['883900 昨日涨停表现', 'https://d.10jqka.com.cn/v6/time/48_883900/last.js'],
    ['1A0001 上证指数', 'https://d.10jqka.com.cn/v6/time/hs_1A0001/last.js'],
    ['883918 昨日炸板股', 'https://d.10jqka.com.cn/v6/time/48_883918/last.js']
  ]) {
    try {
      const { status, text } = await get(u);
      const d = parseJsonp(text);
      const k = Object.keys(d)[0], p = d[k];
      const rows = p.data.split(';');
      console.log(`${lbl}`);
      console.log(`  HTTP ${status}  date=${p.date}  pre=${p.pre}  点数=${rows.length}`);
      console.log(`  前 4 点: ${rows.slice(0, 4).join('  ')}`);
      console.log(`  末 2 点: ${rows.slice(-2).join('  ')}`);
      const first = (rows[0] || '').split(',')[0];
      console.log(`  → 首个时刻 ${first}${first === '0925' ? '  ★ 有集合竞价点！' : ''}`);
      console.log('');
    } catch (e) { console.log(`${lbl}\n  请求失败：${e.message}\n`); }
  }

  console.log('======== 二、涨停池 / 炸板池（今天 vs 昨天）========');
  const F = '199112,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004,3475915,3475916,330326,330327,330328';
  for (const d of [20261014, 20261013]) {
    for (const api of ['limit_up_pool', 'open_limit_pool']) {
      const u = `https://data.10jqka.com.cn/dataapi/limit_up/${api}?page=1&limit=200&field=${F}&filter=HS,GEM2STAR&order_field=330324&order_type=0&date=${d}`;
      try {
        const { status, text } = await get(u);
        const j = JSON.parse(text);
        const dd = j.data || {};
        const total = dd.page ? dd.page.total : undefined;
        const info = dd.info || [];
        const times = info.map(x => String(x.first_limit_up_time)).filter(Boolean).slice(0, 5);
        const yz = info.filter(x => x.limit_up_type === '一字板').length;
        console.log(`${d} ${api}`);
        console.log(`  HTTP ${status} status_code=${j.status_code} total=${total} 返回条数=${info.length} 一字板=${yz}`);
        if (times.length) console.log(`  首封时间样本 ${times.join(' ')}`);
        console.log('');
      } catch (e) { console.log(`${d} ${api}\n  请求失败：${e.message}\n`); }
    }
  }
})();
