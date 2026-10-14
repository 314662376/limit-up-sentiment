/* 给老归档补 self —— 纯本地推导，不联网。
 *
 * data/<B>.json 的 rate 是 B-1 的家数、self 才是 B 自己的家数。
 * 而 data/<B+1>.json 的 rate 恰好就是 B 的家数 —— 于是只要「下一份归档」在，
 * 就能把 B 缺的 self 精确推出来：
 *
 *   self(B) := rate(B+1)          （并要求 rate(B+1).date === B，否则说明中间有缺口，不推）
 *
 * 这个脚本只处理「已经有下一份归档」的那些日子；最新那一天的 self 只能等
 * collect.js 收盘后落盘时自己写。幂等，重复跑没有副作用。
 *
 * 用法：node scripts/backfill-self.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const dry = process.argv.indexOf('--dry') >= 0;

const idxPath = path.join(DATA_DIR, 'index.json');
const dates = JSON.parse(fs.readFileSync(idxPath, 'utf8')).dates || [];
if (dates.length < 2) { console.log('归档不足 2 天，无需处理'); process.exit(0); }

const read = d => JSON.parse(fs.readFileSync(path.join(DATA_DIR, d + '.json'), 'utf8'));

let done = 0, skipHas = 0, skipGap = 0;
for (let i = 0; i < dates.length - 1; i++) {
  const B = dates[i], NXT = dates[i + 1];
  const cur = read(B);
  if (cur.self && cur.self.rate != null) { skipHas++; continue; }

  let nxt;
  try { nxt = read(NXT); } catch (e) { console.log('  跳过 ' + B + '：读不到 ' + NXT); skipGap++; continue; }

  const r = nxt.rate;
  // 硬校验：下一份归档的 rate 必须正好指向 B，否则中间缺了交易日，推出来的不是 B 的家数
  const want = B.replace(/-/g, '');
  if (!r || String(r.date) !== want) {
    console.log('  跳过 ' + B + '：' + NXT + ' 的 rate.date = ' + (r && r.date) + '，不等于 ' + want + '（中间有缺口）');
    skipGap++;
    continue;
  }

  cur.self = {
    date: r.date, zt: r.zt, zb: r.zb, oneWord: r.oneWord, base: r.base,
    rate: r.rate, fbl: r.fbl, zbl: r.zbl
  };
  if (!dry) fs.writeFileSync(path.join(DATA_DIR, B + '.json'), JSON.stringify(cur, null, 1));
  console.log('  ' + B + '.json ← self（' + r.zt + ' 涨停 / ' + r.zb + ' 炸板 / ' + r.oneWord +
    ' 一字板 → 非一字板封板率 ' + r.fbl.toFixed(4) + '%）');
  done++;
}

console.log('\n回填 ' + done + ' 个，已有 self ' + skipHas + ' 个，无法推导 ' + skipGap + ' 个' +
  (dry ? '（--dry，未写盘）' : ''));
