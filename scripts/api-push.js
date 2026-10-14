/* 备用的「不走 github.com」推送方式。
 *
 * 背景：本机网络对 github.com 时常不可达（`CONNECT tunnel failed, response 502` /
 * schannel 握手失败），而 `git push` 正是走 github.com。此时 api.github.com 往往还通，
 * 于是改用 Git Data API 手工建 commit：
 *   ref → commit → tree(base_tree=远端当前树) → blobs → commit → 更新 ref
 *
 * 关键点：**必须带 base_tree**。远端可能已被采集任务推了新提交（data/*.json），
 * 若不带 base_tree 就是拿新树整体替换，会把这些提交的文件内容抹掉。
 * 带上 base_tree 后，只有本次列出的文件被改，其余原样保留。
 *
 * 用法：
 *   GITHUB_TOKEN=xxx node scripts/api-push.js            # 推送 origin/main...HEAD 的改动
 *   GITHUB_TOKEN=xxx node scripts/api-push.js a.js b.js  # 只推指定文件
 *   GITHUB_TOKEN=xxx node scripts/api-push.js --dry      # 只打印将要做的事
 *
 * 注意：成功后本地 main 仍停在原提交（本地没有远端那个采集提交的对象），
 *       等 github.com 恢复后跑一次 `git fetch origin && git reset --hard origin/main` 对齐。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OWNER = '314662376';
const REPO = 'limit-up-sentiment';
const BRANCH = 'main';
const API = 'https://api.github.com';

const token = process.env.GITHUB_TOKEN;
if (!token) { console.error('缺少 GITHUB_TOKEN 环境变量'); process.exit(1); }

const argv = process.argv.slice(2);
const dry = argv.indexOf('--dry') >= 0;
const explicit = argv.filter(a => a !== '--dry');

function sh(cmd) { return execSync(cmd, { encoding: 'utf8' }).trim(); }

async function api(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'limit-up-sentiment-api-push',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await res.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch (e) { /* 非 JSON */ }
  if (!res.ok) {
    throw new Error(method + ' ' + url + ' → HTTP ' + res.status + '：' + (j && j.message ? j.message : txt.slice(0, 200)));
  }
  return j;
}

function changedFiles() {
  if (explicit.length) return explicit;
  // origin/main 是上次 fetch 到的远端位置；三点表示「从共同祖先到 HEAD」的差异
  return sh('git diff --name-only origin/main...HEAD').split('\n').filter(Boolean);
}

(async () => {
  const files = changedFiles();
  if (!files.length) { console.log('没有需要推送的文件'); return; }

  const missing = files.filter(f => !fs.existsSync(f));
  if (missing.length) { console.error('本地缺文件：' + missing.join(', ')); process.exit(1); }

  console.log('待推文件 ' + files.length + ' 个：');
  files.forEach(f => console.log('  ' + f + '  (' + fs.statSync(f).size + ' 字节)'));

  const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const remoteSha = ref.object.sha;
  const remoteCommit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${remoteSha}`);
  console.log('\n远端 ' + BRANCH + ' = ' + remoteSha.slice(0, 7) +
    '  ' + remoteCommit.message.split('\n')[0] +
    '\n远端树 = ' + remoteCommit.tree.sha.slice(0, 7) +
    '\n父提交数 = ' + (remoteCommit.parents || []).length);

  const message = sh('git log -1 --format=%B');
  const an = sh('git log -1 --format=%an'), ae = sh('git log -1 --format=%ae'), ad = sh('git log -1 --format=%aI');
  console.log('提交信息首行 = ' + message.split('\n')[0]);

  if (dry) { console.log('\n(--dry) 到此为止'); return; }

  const tree = [];
  for (const f of files) {
    const content = fs.readFileSync(f).toString('base64');
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, { content, encoding: 'base64' });
    tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
    console.log('  blob ' + f + ' → ' + blob.sha.slice(0, 7));
  }

  const newTree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`,
    { base_tree: remoteCommit.tree.sha, tree });
  console.log('\n新树 = ' + newTree.sha.slice(0, 7));

  const newCommit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [remoteSha],
    author: { name: an, email: ae, date: ad },
    committer: { name: an, email: ae, date: ad }
  });
  console.log('新提交 = ' + newCommit.sha.slice(0, 7));

  await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`,
    { sha: newCommit.sha, force: false });
  console.log('\n✅ 已推送：https://github.com/' + OWNER + '/' + REPO + '/commit/' + newCommit.sha);
  console.log('   本地 main 仍停在 ' + sh('git rev-parse --short HEAD') +
    '，github.com 恢复后跑 `git fetch origin && git reset --hard origin/main` 对齐即可。');
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
