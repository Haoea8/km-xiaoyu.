/**
 * 互动消息（点赞 / 评论 / 回复 / 收藏 / 想要 / 关注 / 校园墙）专项测试。
 *
 * 背景：用户要求「像抖音那样开个互动消息的框」，别人点赞/回复/收藏我的帖子、
 * 商品、评论时都收到提示，并且能点进去跳回对应位置。
 *
 * 这套断言覆盖 interactions.js 里那几条「设计要点」——
 * 它们每一条都是踩过坑才写下来的，任何一条被改坏都会在界面上变成
 * 「红点点了没用 / 消息刷屏 / 找不到人」这类没法自证的怪现象：
 *   1) 自己对自己不产生消息（否则自己给自己点赞也冒红点）
 *   2) 30 分钟合并窗口（否则「点赞→取消→再赞」刷出三条一样的）
 *   3) 只存事实、读取时装饰昵称头像（改完名历史消息要跟着变）
 *   4) 未读计数 / 标记已读要真落库（否则刷新一下红点又回来了）
 *   5) ★ 校园墙匿名：互动消息绝不能成为反查匿名账号的入口
 *
 * 跑法：node tools/test-interactions.js   （离线，不需要起服务、不需要联网）
 * 覆盖的是 cloudfunctions/campus 下的**真实代码**（wx-server-sdk 被打桩），
 * 所以云端与本地后端（server/src，镜像代码）的行为一致。
 */
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };
const eq = (got, want, m) => {
  if (got === want) ok(m + ' = ' + JSON.stringify(got));
  else no(m + '：期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got));
};
const sec = (m) => console.log('\n=== ' + m + ' ===');

/* ---------------- wx-server-sdk 打桩（内存库） ---------------- */
const store = {};
function col(n) { if (!store[n]) store[n] = {}; return store[n]; }
function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) { col(name)[String(id)] = Object.assign({ _id: String(id) }, data); return Promise.resolve({}); },
        get() {
          const d = col(name)[String(id)];
          return d ? Promise.resolve({ data: d }) : Promise.reject(new Error('document does not exist'));
        },
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

/* ---------------- 工具 ---------------- */
const ANON_RE = /^[\u4e00-\u9fa5]+#\d{4}$/;   // 匿名昵称形如「安静的胖头鱼#3421」

(async () => {
  const app = require(FN + '/index.js');
  const db = require(FN + '/db.js');
  const it = require(FN + '/interactions.js');

  const call = (path, method, data, token) => app.main({ path, method, data: data || {}, token: token || '' });

  for (let i = 0; i < 40; i++) {
    const r = await call('/api/_setup', 'POST', {});
    if (r.data && r.data.done) break;
  }

  // A = 内容生产者（被互动的人），B / C = 两个互动发起人
  const A = (await call('/api/login', 'POST', { testUserId: 2 })).data;
  const B = (await call('/api/login', 'POST', { testUserId: 3 })).data;
  const C = (await call('/api/login', 'POST', { testUserId: 4 })).data;
  if (!A || !B || !C) { console.error('种子账号登录失败，无法继续'); process.exit(1); }
  console.log('A = ' + A.user.nickname + '(id=' + A.user.id + ')  B = ' + B.user.nickname +
    '(id=' + B.user.id + ')  C = ' + C.user.nickname + '(id=' + C.user.id + ')');

  const listOf = async (t, q) => {
    const r = await call('/api/interactions', 'GET', null, t);
    if (r.code !== 0) return { list: [], unread: -1, total: -1, err: r.message };
    let l = r.data.list;
    if (q) l = l.filter((x) => x.type === q);
    return Object.assign({}, r.data, { list: l, all: r.data.list });
  };
  const unreadOf = async (t) => ((await call('/api/interactions/unread', 'GET', null, t)).data || {}).unread;
  const readAll = (t) => call('/api/interactions/read', 'POST', {}, t);
  const rawAll = (uid) => db.get('interactions').filter((r) => Number(r.toUserId) === uid);

  /* ================================================================= */
  sec('1. 基线：新登录账号的互动未读为 0');
  {
    const u = await unreadOf(A.token);
    eq(u, 0, 'A 的互动未读');
  }

  /* ================================================================= */
  sec('2. 自己赞自己的帖子 → 不产生任何互动消息');
  const postRes = await call('/api/posts', 'POST', { content: '互动消息测试帖：求点赞', images: ['/static/p1.jpg'] }, A.token);
  const postId = postRes.data.post.id;
  {
    await call('/api/posts/' + postId + '/like', 'POST', {}, A.token);
    eq(await unreadOf(A.token), 0, '自己赞自己后 A 的未读');
    eq(rawAll(A.user.id).length, 0, 'interactions 集合里属于 A 的记录数');
  }

  /* ================================================================= */
  sec('3. B 赞 A 的帖子 → A 收到 1 条 post_like，且 link 能跳回去');
  {
    await call('/api/posts/' + postId + '/like', 'POST', {}, B.token);
    const r = await listOf(A.token);
    eq(r.unread, 1, 'A 的未读');
    eq(r.list.length, 1, 'A 的互动条数');
    const row = r.list[0];
    eq(row.type, 'post_like', '类型');
    eq(row.typeText, '赞了你的帖子', '文案');
    eq(row.actor.nickname, B.user.nickname, '发起人昵称（读取时装饰，不是写入时快照）');
    eq(row.link, '/pages/post-detail/post-detail?id=' + postId, '跳转链接');
    eq(row.read, false, '未读标记');
    eq(typeof row.timeText, 'string', '相对时间文案');
  }

  /* ================================================================= */
  sec('4. 合并窗口：取消赞再赞 → 仍然只有 1 条（不刷屏）');
  {
    await call('/api/posts/' + postId + '/like', 'POST', {}, B.token);   // 取消
    await call('/api/posts/' + postId + '/like', 'POST', {}, B.token);   // 再赞
    const r = await listOf(A.token, 'post_like');
    eq(r.list.length, 1, '重复点赞后的 post_like 条数');
    eq(rawAll(A.user.id).filter((x) => x.type === 'post_like').length, 1, '库里的记录数');
  }

  /* ================================================================= */
  sec('5. 标记已读 → 落库；之后同一窗口内的新互动会重新置回未读');
  {
    const r1 = await readAll(A.token);
    eq(r1.data.changed, 1, '本次标记已读的条数');
    await db.flush();
    eq(await unreadOf(A.token), 0, '标记后 A 的未读');

    await call('/api/posts/' + postId + '/like', 'POST', {}, B.token);   // 取消
    await call('/api/posts/' + postId + '/like', 'POST', {}, B.token);   // 再赞 → 应置回未读
    eq(await unreadOf(A.token), 1, '同一窗口内再点赞后的未读（用户确实该看到「又有人赞了」）');
  }

  /* ================================================================= */
  sec('6. 评论 / 回复：帖子作者与「被回复的人」各收一条');
  {
    await readAll(A.token); await readAll(C.token); await db.flush();

    const cmt = await call('/api/posts/' + postId + '/comments', 'POST', { content: 'C 的一级评论' }, C.token);
    eq(await unreadOf(A.token), 1, 'A 收到「评论了你的帖子」后的未读');
    const aRow = (await listOf(A.token, 'post_comment')).list[0];
    eq(aRow.typeText, '评论了你的帖子', 'A 收到的文案');
    eq(aRow.content, 'C 的一级评论', '带上了评论正文摘要');
    eq(aRow.link, '/pages/post-detail/post-detail?id=' + postId, 'A 的跳转链接');

    // B 回复 C 的那条评论 → 应该是「C 收到 comment_reply」，而不是 C 又被算成一级评论
    const reply = await call('/api/posts/' + postId + '/comments',
      'POST', { content: 'B 回复 C', replyTo: cmt.data.comment.id }, B.token);
    eq(reply.code, 0, '回复接口');
    eq(await unreadOf(C.token), 1, 'C 的未读（被回复）');
    const cRow = (await listOf(C.token, 'comment_reply')).list[0];
    eq(cRow.typeText, '回复了你', 'C 收到的文案');
    eq(cRow.actor.nickname, B.user.nickname, 'C 看到的发起人');
    eq(cRow.commentId, reply.data.comment.id, '带上评论 id（便于前端定位）');
    // A 作为帖子作者，两条评论都该收到「评论了你的帖子」
    eq((await listOf(A.token, 'post_comment')).list.length, 2, 'A 收到的 post_comment 条数');
  }

  /* ================================================================= */
  sec('7. 收藏商品 / 想要商品 / 关注 → 各自的通知与链接');
  {
    await readAll(A.token); await db.flush();
    const ls = await call('/api/listings', 'POST',
      { title: '互动测试：二手台灯', zone: 'used', price: 30, images: ['/static/p1.jpg'] }, A.token);
    if (ls.code !== 0) { no('建商品失败：' + ls.message); }
    const listingId = ls.data && ls.data.listing && ls.data.listing.id;

    // toggle 语义：先确保「未收藏」→ 若本来是收藏态，第一次调用会取消掉，再点一次才是收藏
    let favRes = await call('/api/favorites/toggle', 'POST', { targetType: 'listing', targetId: listingId }, B.token);
    if (favRes.data.favorited === false) await call('/api/favorites/toggle', 'POST', { targetType: 'listing', targetId: listingId }, B.token);
    const fav = (await listOf(A.token, 'listing_fav')).list[0];
    eq(!!fav, true, 'A 收到「收藏了你的商品」');
    if (fav) {
      eq(fav.title, '互动测试：二手台灯', '带上了商品标题');
      eq(fav.link, '/pages/detail/detail?id=' + listingId, '跳转链接');
    }

    await call('/api/listings/' + listingId + '/want', 'POST', {}, C.token);
    const want = (await listOf(A.token, 'listing_want')).list[0];
    eq(!!want, true, 'A 收到「想要你的商品」');
    if (want) eq(want.link, '/pages/detail/detail?id=' + listingId, '想要的跳转链接');

    // 同上：先确保处于「未关注」状态，再关注一次才是真的产生通知
    let folRes = await call('/api/users/' + A.user.id + '/follow', 'POST', {}, B.token);
    if (folRes.data.followed === false) await call('/api/users/' + A.user.id + '/follow', 'POST', {}, B.token);
    const fol = (await listOf(A.token, 'follow')).list[0];
    eq(!!fol, true, 'A 收到「关注了你」');
    if (fol) {
      // ⚠️ follow 的 targetId 是**收件人自己**，用它跳转等于跳回自己主页 —— 必须跳发起人主页
      eq(fol.link, '/pages/user/user?id=' + B.user.id, '关注通知跳的是**对方**主页');
      eq(fol.actor.id, B.user.id, '发起人 id');
    }
  }

  /* ================================================================= */
  sec('8. ★ 校园墙：匿名评论不能把真实账号暴露到互动消息里');
  {
    await readAll(A.token); await db.flush();
    const wallRes = await call('/api/wall', 'POST', { content: '互动测试：匿名墙贴' }, A.token);
    const wallId = wallRes.data.wall.id;

    // 默认就是匿名
    const anonCmt = await call('/api/wall/' + wallId + '/comments', 'POST', { content: '匿名留言' }, C.token);
    eq(anonCmt.code, 0, '匿名评论成功');

    const row = (await listOf(A.token, 'wall_comment')).list[0];
    eq(!!row, true, '墙主收到「评论了你的校园墙」');
    if (row) {
      eq(row.actor.id, 0, '匿名发起人不带真实 id（否则点头像能跳到本尊主页）');
      eq(ANON_RE.test(String(row.actor.nickname)), true, '展示的是墙上同款匿名昵称：' + row.actor.nickname);
      eq(String(row.actor.nickname).indexOf(C.user.nickname) === -1, true, '不含真实昵称「' + C.user.nickname + '」');
      eq(row.link, '/pages/wall-detail/wall-detail?id=' + wallId, '跳转链接');
    }
    // 库里仍然保留 actorId（合并窗口/去重要用），但不外泄
    const rawAnon = rawAll(A.user.id).filter((x) => x.type === 'wall_comment')[0];
    if (rawAnon) eq(!!rawAnon.actorName, true, '库里存了 actorName 备用：' + rawAnon.actorName);
    else no('库里没有 wall_comment 记录');

    // 反向对照：同一个人改成**非匿名**评论，就必须显示真实昵称
    const pubCmt = await call('/api/wall/' + wallId + '/comments', 'POST', { content: '实名留言', anonymous: false }, B.token);
    eq(pubCmt.code, 0, '实名评论成功');
    const pub = (await listOf(A.token, 'wall_comment')).list.find((x) => x.actor.id === B.user.id);
    eq(!!pub, true, '实名评论也产生了通知');
    if (pub) eq(pub.actor.nickname, B.user.nickname, '实名发起人显示真实昵称');

    // 墙评论被点赞 → 评论作者收到「赞了你的评论」
    await call('/api/wall/comments/' + anonCmt.data.comment.id + '/like', 'POST', {}, B.token);
    const likeRow = (await listOf(C.token, 'wall_comment_like')).list[0];
    eq(!!likeRow, true, '匿名评论的作者也能收到点赞通知');
    if (likeRow) {
      eq(likeRow.actor.nickname, B.user.nickname, '点赞者不匿名，显示真实昵称');
      eq(likeRow.link, '/pages/wall-detail/wall-detail?id=' + wallId, '跳转回墙贴');
    }
  }

  /* ================================================================= */
  sec('9. 资料点赞 → 上传者收到通知（按库校验，不依赖种子账号能登录）');
  {
    const res = db.one('resources', (r) => r.status === 'on' && Number(r.uploaderId) !== B.user.id);
    if (!res) { console.log('  – 没有可用的种子资料，跳过'); }
    else {
      const before = rawAll(res.uploaderId).filter((x) => x.type === 'resource_like' && Number(x.targetId) === Number(res.id)).length;
      await call('/api/resources/' + res.id + '/like', 'POST', {}, B.token);
      const after = rawAll(res.uploaderId).filter((x) => x.type === 'resource_like' && Number(x.targetId) === Number(res.id)).length;
      eq(after - before, 1, '资源上传者新增的 resource_like 条数');
      const row = db.get('interactions').filter((x) => x.type === 'resource_like' && Number(x.targetId) === Number(res.id))[0];
      if (row) eq(it.linkOf(row), '/pages/resource-detail/resource-detail?id=' + res.id, '资料链接');
    }
  }

  /* ================================================================= */
  sec('10. 会话列表接口顺带下发 interactionUnread（前端角标一次拿全）');
  {
    const need = await unreadOf(A.token);
    const r = await call('/api/conversations', 'GET', null, A.token);
    eq(typeof r.data.interactionUnread, 'number', '/api/conversations 带上了 interactionUnread');
    eq(r.data.interactionUnread, need, '与 /api/interactions/unread 一致');
  }

  /* ================================================================= */
  sec('11. 列表：按时间倒序 + 分页 + 未读标记逐条');
  {
    const r = await listOf(A.token);
    const times = r.list.map((x) => x.createdAt);
    const sorted = times.slice().sort((a, b) => b - a);
    eq(JSON.stringify(times) === JSON.stringify(sorted), true, '按 createdAt 倒序');
    eq(r.total, rawAll(A.user.id).length, 'total 与库中条数一致');
    eq(r.list.length <= 20, true, '默认一页不超过 20 条（实际 ' + r.list.length + '）');

    const p2 = await call('/api/interactions', 'GET', null, A.token);
    eq(p2.data.page, 1, '默认第 1 页');
    eq(p2.data.hasMore, r.list.length < r.total, 'hasMore 与是否还有下一页一致');

    const firstId = r.list[0].id;
    await call('/api/interactions/read', 'POST', { id: firstId }, A.token);
    await db.flush();
    const r2 = await listOf(A.token);
    const marked = r2.all.find((x) => x.id === firstId);
    eq(marked.read, true, '单条已读生效');
    eq(r2.unread, r.unread - 1, '未读总数 -1');
  }

  Module._load = origLoad;
  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 互动消息全部符合预期'));
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  Module._load = origLoad;
  console.error('测试崩溃:', e);
  process.exit(1);
});
