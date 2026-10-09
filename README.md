# 涨停情绪指数

把 A 股短线情绪浓缩成 **一个围绕 1.000 波动的数值**，每分钟更新一次，配 1 日 / 5 日分时图。

```
值 = 昨日封板率/100 × 883900(昨日涨停表现)涨跌幅 + 1 + 上证指数涨跌幅/20
```

涨跌幅以**小数**代入（涨 0.13% → 0.0013），因此数值天然落在 1.000 附近：
**高于 1.000 表示打板赚钱效应偏强，低于 1.000 偏弱**。

> 实测最近 5 个交易日值域为 **0.9957 ~ 1.0199**，与 y 轴 0.025 一档的刻度（0.95 / 0.975 / 1.00 / 1.025 / 1.05）匹配。

---

## 三个输入量的来源

| 输入 | 含义 | 来源 |
|---|---|---|
| 昨日封板率 | 上一交易日：涨停家数 ÷ (涨停家数 + 炸板家数) | 同花顺涨停池 / 炸板池接口 |
| 883900 | 同花顺「昨日涨停表现」当日实时涨跌幅 | `d.10jqka.com.cn` 公开行情 |
| 上证指数 | 上证指数当日实时涨跌幅 | `d.10jqka.com.cn` 公开行情（`hs_1A0001`） |

全部为同花顺**公开**行情接口，无需密钥。

---

## 数据是怎么记录下来的

静态页面不能写文件，所以历史数据由 **GitHub Actions** 采集：

```
.github/workflows/collect.yml
  ├─ 交易日 09:25 (UTC 01:25) 触发 → 早盘 09:30-11:30 每分钟采一点
  └─ 交易日 12:55 (UTC 04:55) 触发 → 午盘 13:00-15:00 每分钟采一点
        ↓  每 14 分钟提交一次，避免长任务中断丢数据
data/YYYY-MM-DD.json   ← 当日全部分钟点（含封板率基准）
data/latest.json       ← 当前生效的「昨日封板率」，供前端直接读取
data/index.json        ← 已收录的交易日列表
```

页面读取逻辑：

- **盘中**：浏览器直连同花顺分时接口，逐分钟现算（比仓库存档更及时）
- **非交易时段**：直接读 `data/` 里最近一个交易日的存档
  （原因：同花顺 `last.js` 在盘前会把 `date` 标成今天、却返回上一交易日的数据，容易张冠李戴）

---

## 目录结构

```
index.html                     页面
app.js                         JSONP 取数 / 指标计算 / 图表 / 每分钟刷新
lib/echarts.min.js             ECharts 5.4.3（本地内置，不依赖 CDN）
scripts/collect.js             采集器（CI 用；--once 可手动跑一次）
scripts/backfill.js            历史回填（重建最近 N 个交易日）
data/*.json                    历史数据
.github/workflows/collect.yml  定时采集工作流
```

---

## 本地运行

```bash
python -m http.server 8898       # 然后打开 http://127.0.0.1:8898/
```

回填历史（会覆盖 `data/` 中同日期文件）：

```bash
node scripts/backfill.js --days=5
```

手动采一次（验证接口连通性）：

```bash
node scripts/collect.js --once
```

---

## 部署到 GitHub Pages

```bash
git init && git add . && git commit -m "feat: 涨停情绪指数"
git branch -M main
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

然后到 **Settings → Pages** 把 Source 设为 `main` 分支根目录。

同时确认 **Settings → Actions → General → Workflow permissions** 选中 **Read and write permissions**，
否则 Actions 无法把数据提交回仓库。

首次可到 **Actions → collect-sentiment → Run workflow** 手动触发一次验证。

---

## 已知限制

- GitHub Actions 的定时触发在高峰期可能**延迟数分钟**，开盘头几个点可能缺失。
- 同花顺接口如变更路径或加反爬，采集会失败，页面会退回显示最近存档（不会白屏）。
- 页面与采集脚本都依赖同花顺公开接口，属第三方数据，**不保证长期稳定**。

---

## 免责声明

本页仅为公开数据的展示与整理，不构成任何投资建议。市场有风险，投资需谨慎。
