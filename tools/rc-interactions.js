/**
 * 互动消息测试的**反向对照**。
 *
 * 目的：证明 tools/test-interactions.js 里的断言是「有效」的 ——
 * 把几条关键保护退回 bug 写法后，它们必须变红。
 * 只验证「会变红」，不验证修好（那是 test-interactions.js 的活）。
 *
 * 做法：把 cloudfunctions/campus 整份复制到临时目录，在副本上注入 3 个 bug，
 * 然后跑同样的场景。**全程不碰真实代码**，结束时删掉临时目录。
 *
 * 注入的 3 个 bug：
 *   B1 `add()` 去掉 `toUserId === actorId` 自丢弃 → 自己给自己点赞也会冒红点
 *   B2 `decorate()` 忽略 actorName → 匿名评论者的真实昵称被暴露
 *   B3 route-extend 的墙评论不传 actorName → 同上
 *
 * 跑法：node tools/rc-interactions.js
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC = 'D:/wx/campus-xianyu/cloudfunctions/campus';
const TMP = path.join(os.tmpdir(), 'campus-rc-' + Date.now());

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };
const sec = (m) => console.log('\n=== ' + m + ' ===');

/* 注入 bug */
function inject(dir) {
  const edits = [
    ['interactions.js', '  // 1) 自己对自己：不提醒\n  if (toUserId === actorId) return null;\n', '  // B1: 自丢弃被移除\n'],
    ['interactions.js', "    actor: r.actorName\n      ? { id: 0, nickname: String(r.actorName), avatar: '' }\n      : deco.sellerBrief(r.actorId),", '    actor: deco.sellerBrief(r.actorId),'],
    ['route-extend.js', "      actorName: c.anonymous ? c.anonName : ''", "      actorName: ''"]
  ];
  for (const [f, from, to] of edits) {
    const p = path.join(dir, f);
    const s = fs.readFileSync(p, 'utf8');
    if (s.indexOf(from) === -1) { console.error('注入失败（锚点没找到）: ' + f); process.exit(1); }
    fs.writeFileSync(p, s.replace(from, to));
  }
}

/* wx-server-sdk 打桩 */
const store = {};
function col(n) { if (!store[n]) store[n] = {}; return store[n]; }
function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) { col(name)[String(id)] = Object.assign({ _id: String(id) }, data); return Promise.resolve({}); },
        get() { const d = col(name)[String(id)]; return d ? Promise.resolve({ data: d }) : Promise.reject(new Error('document does not exist')); },
        remove() { delete col(name)[String(id)]; return Promise.resolve({}); }
      };
    },
    where(cond) {
      const match = (d) => Object.keys(cond || {}).every((k) => Array.isArray(d[k]) ? d[k].indexOf(cond[k]) > -1 : d[k] === cond[k]);
      const q = { limit() { return q; }, get() { return Promise.resolve({ data: Object.values(col(name)).filter(match) }); } };
      return q;
    },
    limit() { return { get: () => Promise.resolve({ data: Object.values(col(name)) }) }; },
    skip() { return this; },
    get() { return Promise.resolve({ data: Object.values(col(name)) }); }
  };
}
const fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'mock', init() {}, getWXContext: () => ({}),
  database: () => ({ collection: makeCollection, createCollection(n) { col(n); return Promise.resolve({}); } })
};
const origLoad = Module._load;
Module._load = function (r) { if (r === 'wx-server-sdk') return fakeSdk; return origLoad.apply(this, arguments); };

(async () => {
  fs.cpSync(SRC, TMP, { recursive: true });
  console.log('真实代码已复制到 ' + TMP + '，并在副本上注入 3 个 bug');
  inject(TMP);

  // 清掉可能残留的 require 缓存（同一进程内不会，但保险）
  for (const k of Object.keys(require.cache)) if (k.indexOf(TMP.replace(/\\/g, '/')) > -1 || k.indexOf(TMP) > -1) delete require.cache[k];

  const app = require(TMP + '/index.js');
  const db = require(TMP + '/db.js');
  const call = (p, m, d, t) => app.main({ path: p, method: m, data: d || {}, token: t || '' });
  for (let i = 0; i < 40; i++) { const r = await call('/api/_setup', 'POST', {}); if (r.data && r.data.done) break; }

  const A = (await call('/api/login', 'POST', { testUserId: 2 })).data;
  const B = (await call('/api/login', 'POST', { testUserId: 3 })).data;
  const C = (await call('/api/login', 'POST', { testUserId: 4 })).data;
  const listOf = async (t, q) => {
    const r = await call('/api/interactions', 'GET', null, t);
    let l = r.data.list; if (q) l = l.filter((x) => x.type === q);
    return l;
  };
  const unreadOf = async (t) => ((await call('/api/interactions/unread', 'GET', null, t)).data || {}).unread;

  /* ---------------- B1 ---------------- */
  sec('B1 自丢弃被移除 → 「自己赞自己」也会产生互动消息（期望：测试里的断言会失败）');
  {
    const post = (await call('/api/posts', 'POST', { content: 'B1 自赞' }, A.token)).data.post;
    await call('/api/posts/' + post.id + '/like', 'POST', {}, A.token);
    const n = await unreadOf(A.token);
    if (n > 0) ok('确认 bug 成立：自己赞自己产生 ' + n + ' 条 → 所以「未读为 0」这条断言是有意义的');
    else no('bug 没能复现，说明那层保护并不是必需的（需重新审视断言）');
  }

  /* ---------------- B2 / B3 ---------------- */
  sec('B2/B3 actorName 被忽略 → 匿名评论者的真实昵称暴露（期望：测试里的断言会失败）');
  {
    await call('/api/interactions/read', 'POST', {}, A.token);
    const wall = (await call('/api/wall', 'POST', { content: 'B2 匿名墙' }, A.token)).data.wall;
    const cmt = await call('/api/wall/' + wall.id + '/comments', 'POST', { content: '匿名留言' }, C.token);
    if (cmt.code !== 0) { no('匿名评论失败：' + cmt.message); }
    else {
      const row = (await listOf(A.token, 'wall_comment'))[0];
      if (!row) no('没产生 wall_comment 通知');
      else if (row.actor.nickname === C.user.nickname && row.actor.id === C.user.id) {
        ok('确认 bug 成立：互动消息里出现真实账号「' + row.actor.nickname + '」(id=' + row.actor.id + ') → 匿名保护的那两条断言是有意义的');
      } else {
        no('bug 没能复现（actor=' + JSON.stringify(row.actor) + '），需重新审视断言');
      }
    }
  }

  /* ---------------- 清理 ---------------- */
  Module._load = origLoad;
  try { fs.rmSync(TMP, { recursive: true, force: true }); console.log('\n临时目录已清理: ' + TMP); } catch (e) { console.log('临时目录清理失败（可手动删）: ' + TMP); }

  console.log('\n' + (bad ? '❌ 有 ' + bad + ' 项反向对照没能复现' : '✅ 反向对照通过：3 个 bug 都能被测试抓到'));
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  Module._load = origLoad;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) { /* ignore */ }
  console.error('反向对照崩溃:', e);
  process.exit(1);
});
