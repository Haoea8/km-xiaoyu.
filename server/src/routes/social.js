'use strict';
/** 社区 API：圈子 / 帖子 / 评论 / 点赞 / 话题 + 会话消息 */
const db = require('../db');
const util = require('../util');
const deco = require('../deco');
const ws = require('../ws');
const it = require('../interactions');

function needUser(ctx) {
  if (!ctx.user) { const e = new Error('请先登录'); e.status = 401; throw e; }
  return ctx.user;
}
function fail(message, status) { const e = new Error(message); e.status = status || 400; throw e; }

function decoConv(c, me) {
  const peerId = c.members.find((x) => x !== me.id);
  const peer = deco.sellerBrief(peerId);
  const unread = db.find('messages', (m) => m.convId === c.id && m.senderId !== me.id && (m.readBy || []).indexOf(me.id) === -1).length;
  return {
    id: c.id, peer,
    lastMessage: c.lastMessage || '',
    lastTime: c.lastTime || c.createdAt,
    timeText: util.relTime(c.lastTime || c.createdAt),
    unread
  };
}

module.exports = function register(route) {
  /* ---------- 圈子 ---------- */
  route('GET', '/api/circles', () => {
    const list = db.get('circles').slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)).map((c) => {
      const posts = db.find('posts', (p) => p.circleId === c.id);
      const last = posts.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
      return Object.assign({}, c, {
        postCount: posts.length,
        memberCount: (c.memberBase || 0) + posts.length * 3,
        lastActiveText: last ? util.relTime(last.createdAt) : '刚刚创建'
      });
    });
    return { list };
  });

  route('GET', '/api/circles/:id', (ctx) => {
    const c = db.findById('circles', ctx.params.id);
    if (!c) fail('圈子不存在', 404);
    return { circle: c };
  });

  /* ---------- 帖子 ---------- */
  route('GET', '/api/posts', async (ctx) => {
    const me = ctx.user;
    const q = ctx.query;
    const circleId = util.num(q.get('circleId'));
    const topic = q.get('topic') || '';
    const kw = (q.get('keyword') || '').trim();
    const sort = q.get('sort') || 'new';
    /** 按作者过滤（「我的动态」用） */
    const authorId = util.num(q.get('authorId'));
    let list = db.get('posts').slice();
    if (circleId) list = list.filter((p) => p.circleId === circleId);
    if (authorId) list = list.filter((p) => p.authorId === authorId);
    if (topic) list = list.filter((p) => (p.topics || []).includes(topic));
    if (kw) list = list.filter((p) => util.match(p.content, kw) || (p.topics || []).some((t) => util.match(t, kw)));
    if (sort === 'hot') {
      list.sort((a, b) => ((b.likeBase || 0) + (b.likes || []).length + (b.commentCount || 0) * 2) -
        ((a.likeBase || 0) + (a.likes || []).length + (a.commentCount || 0) * 2));
    } else list.sort((a, b) => b.createdAt - a.createdAt);
    const page = util.paginate(list, q.get('page'), q.get('pageSize') || 10);
    // 评论数从 comments 重新推导，与详情页保持一致（见 deco.realCommentCounts）
    const out = page.list.map((p) => deco.decoratePost(p, me));
    await deco.realCommentCounts(out);
    return Object.assign({}, page, { list: out });
  });

  /**
   * 发帖（**幂等**，与云端同构）：同一 reqId 只建一条，重复提交返回第一次那条。
   */
  route('POST', '/api/posts', async (ctx) => {
    const me = needUser(ctx);
    const b = ctx.body || {};
    if (!util.clampText(b.content, 1000)) fail('写点什么再发布吧');
    const reqId = String(b.reqId || '').trim();
    if (reqId) {
      const dup = await db.fetchByField('posts', 'reqId', reqId, 10);
      const mine = (dup || []).find((x) => x.authorId === me.id);
      if (mine) return { post: deco.decoratePost(mine, me), deduped: true };
    }
    const circle = db.findById('circles', b.circleId) || db.get('circles')[0];
    if (!circle) fail('圈子不存在');
    const post = db.insert('posts', Object.assign({
      circleId: circle.id, authorId: me.id,
      content: util.clampText(b.content, 1000),
      images: (b.images || []).slice(0, 9),
      topics: (b.topics || []).slice(0, 4),
      likes: [], likeBase: 0, commentCount: 0, createdAt: Date.now()
    }, reqId ? { reqId } : {}));
    return { post: deco.decoratePost(post, me) };
  });

  /**
   * 修改帖子（作者本人或管理员）：内容 / 配图 / 话题。
   * 前端暂未接入，主要给内容维护用（例如批量修正历史帖的配图）。
   * 本地单实例，不需要 findByIdWithFallback；云函数版有（多实例快照问题）。
   */
  route('PATCH', '/api/posts/:id', (ctx) => {
    const me = needUser(ctx);
    const p = db.findById('posts', ctx.params.id);
    if (!p || (p.authorId !== me.id && !me.isAdmin)) fail('无权操作', 403);
    const b = ctx.body || {};
    const patch = {};
    if (b.content !== undefined) {
      const c = util.clampText(b.content, 1000);
      if (!c) fail('内容不能为空');
      patch.content = c;
    }
    if (b.images !== undefined) patch.images = (b.images || []).slice(0, 9);
    if (b.topics !== undefined) patch.topics = (b.topics || []).slice(0, 4);
    return { post: deco.decoratePost(db.update('posts', p.id, patch), me) };
  });

  route('GET', '/api/posts/:id', (ctx) => {
    const p = db.findById('posts', ctx.params.id);
    if (!p) fail('帖子不存在', 404);
    const me = ctx.user;
    // 本地单实例：内存即真相，直接取全部评论。
    // 用 Number 比对 postId —— 历史数据里可能存成字符串，严格比较会漏掉。
    const src = db.find('comments', (c) => Number(c.postId) === Number(p.id));

    /* ---------- 评论组织成两级：顶层评论 + 它的 replies（小红书式，与云函数版一致） ---------- */
    const byId = {};
    for (const c of src) byId[c.id] = c;

    // 顺着 replyTo 往上找顶层评论；父评论已删则把自己当顶层（绝不丢弃评论）
    const rootOf = (c) => {
      let cur = c;
      for (let i = 0; i < 20; i++) {
        const pid = Number(cur.replyTo);
        if (!pid) return cur.id;
        const parent = byId[pid];
        if (!parent || parent.id === cur.id) return cur.id;
        cur = parent;
      }
      return cur.id;
    };

    const shape = (c) => {
      const t = c.replyTo ? byId[Number(c.replyTo)] : null;
      // 「回复 @某某」只在回复**子评论**时显示；回复顶层大评论不显示（与云函数版一致）
      const tIsRoot = !!t && rootOf(t) === Number(t.id);
      return Object.assign({}, c, {
        author: deco.sellerBrief(c.authorId),
        timeText: util.relTime(c.createdAt),
        isMine: me ? c.authorId === me.id : false,
        replyToName: (t && !tIsRoot) ? deco.sellerBrief(t.authorId).nickname : '',
        replyToText: (t && !tIsRoot) ? String(t.content || '').slice(0, 40) : '',
        rootId: rootOf(c)
      });
    };

    const flat = src.slice()
      .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
      .map(shape);

    const roots = [];
    const rootIndex = {};
    for (const c of flat) {
      const pid = Number(c.replyTo);
      if (pid && byId[pid] && c.rootId !== c.id && rootIndex[c.rootId]) {
        rootIndex[c.rootId].replies.push(c);
        continue;
      }
      c.replies = [];
      rootIndex[c.id] = c;
      roots.push(c);
    }

    // 只**下发**真实条数，不在读接口里回写 commentCount
    // （读不完整时回写会把正确计数覆盖成 0 → 「外面 2 条、进去 0 条」；
    //   与云函数版一致，计数由写入路径自增/自减 + 列表处重新推导保证）
    const total = flat.length;
    const post = Object.assign(deco.decoratePost(p, me), { commentCount: total });
    return { post, comments: roots, commentTotal: total };
  });

  route('DELETE', '/api/posts/:id', async (ctx) => {
    const me = needUser(ctx);
    // 同商品删除：多实例下必须直查兜底，否则「删自己的帖子」会偶发 403 无权操作
    const f = await db.findByIdWithFallback('posts', ctx.params.id);
    const p = f.doc;
    if (!p || (p.authorId !== me.id && !me.isAdmin)) fail('无权操作', 403);
    await db.removeFresh('posts', p.id);
    db.remove('comments', (c) => c.postId === p.id);
    db.remove('favorites', (x) => x.targetType === 'post' && x.targetId === p.id);
    return { ok: true };
  });

  route('POST', '/api/posts/:id/like', (ctx) => {
    const me = needUser(ctx);
    const p = db.findById('posts', ctx.params.id);
    if (!p) fail('帖子不存在', 404);
    const idx = (p.likes || []).indexOf(me.id);
    if (idx === -1) p.likes.push(me.id); else p.likes.splice(idx, 1);
    db.saveSoon();
    // 只在「刚点上赞」时提醒作者（取消赞不提醒）；自己赞自己由 it.add 内部丢弃
    if (idx === -1) {
      it.add({
        toUserId: p.authorId, actorId: me.id, type: 'post_like',
        targetId: p.id, title: p.content, image: (p.images || [])[0] || ''
      });
    }
    return { liked: idx === -1, likeCount: (p.likeBase || 0) + p.likes.length };
  });

  route('POST', '/api/posts/:id/comments', (ctx) => {
    const me = needUser(ctx);
    const p = db.findById('posts', ctx.params.id);
    if (!p) fail('帖子不存在', 404);
    const content = util.clampText((ctx.body || {}).content, 300);
    if (!content) fail('评论内容不能为空');
    // 校验 replyTo：必须存在、且属于同一个帖子。
    // 不校验就静默置空 → 前端「回复某人」会变成「直接回复帖子」（与云函数版一致）
    let replyTo = Number((ctx.body || {}).replyTo) || null;
    let target = null;
    if (replyTo) {
      target = db.findById('comments', replyTo);
      if (!target || target.postId !== p.id) { replyTo = null; target = null; }
    }
    const c = db.insert('comments', {
      postId: p.id, authorId: me.id, content, replyTo, createdAt: Date.now()
    });
    p.commentCount = db.find('comments', (x) => x.postId === p.id).length;
    db.saveSoon();
    if (p.authorId !== me.id) ws.notifyUser(p.authorId, '「' + me.nickname + '」评论了你的帖子：' + content.slice(0, 30));

    /**
     * 互动消息（独立于上面的 AI 会话通知）。
     *
     * ⚠️ 要发**两条**：帖子作者 + 被回复的那个人。
     *    例：A 发帖、B 评论、C 回复 B ——
     *      · A 收到「评论了你的帖子」（C 在 A 的帖子下留了言）
     *      · B 收到「回复了你」（C 回的是 B 那条评论）
     *    两者可能都不是「我」，所以各自判断；`it.add` 内部会丢弃「自己对自己」。
     */
    it.add({
      toUserId: p.authorId, actorId: me.id, type: 'post_comment',
      targetId: p.id, commentId: c.id, text: content,
      title: p.content, image: (p.images || [])[0] || ''
    });
    if (replyTo && target) {
      it.add({
        toUserId: target.authorId, actorId: me.id, type: 'comment_reply',
        targetId: p.id, commentId: c.id, text: content,
        title: p.content, image: (p.images || [])[0] || ''
      });
    }
    const tAuthor = (target && Number(target.replyTo || 0)) ? deco.sellerBrief(target.authorId) : null;
    return {
      comment: Object.assign({}, c, {
        author: deco.briefOf(me),
        timeText: '刚刚',
        isMine: true,
        replyToName: tAuthor ? tAuthor.nickname : '',
        replyToText: target ? String(target.content || '').slice(0, 40) : '',
        replies: []
      }),
      commentCount: p.commentCount
    };
  });

  route('DELETE', '/api/comments/:id', (ctx) => {
    const me = needUser(ctx);
    const c = db.findById('comments', ctx.params.id);
    if (!c || (c.authorId !== me.id && !me.isAdmin)) fail('无权操作', 403);
    db.removeById('comments', c.id);
    const p = db.findById('posts', c.postId);
    if (p) { p.commentCount = db.find('comments', (x) => x.postId === p.id).length; db.saveSoon(); }
    return { ok: true };
  });

  route('GET', '/api/topics', () => {
    const counts = {};
    for (const p of db.get('posts')) for (const t of (p.topics || [])) counts[t] = (counts[t] || 0) + 1;
    const list = Object.keys(counts).map((name) => ({ name, count: counts[name] + 3 }))
      .sort((a, b) => b.count - a.count).slice(0, 12);
    return { list };
  });

  /* ---------- 会话与消息 ---------- */
  route('GET', '/api/conversations', async (ctx) => {
    const me = needUser(ctx);
    const list = db.find('conversations', (c) => c.members.indexOf(me.id) !== -1)
      .sort((a, b) => (b.lastTime || b.createdAt) - (a.lastTime || a.createdAt))
      .map((c) => decoConv(c, me));
    /**
     * 互动消息未读数一并下发。
     *
     * 消息页本来就要调这个接口，顺手带上 —— 前端「私信未读 + 互动未读」
     * 一次请求拿全，底部 tab 角标就不会出现「两个数字对不上」的错乱。
     */
    const interactionUnread = await it.unreadCount(me.id);
    return { list, unreadTotal: list.reduce((s, c) => s + c.unread, 0), interactionUnread };
  });

  route('POST', '/api/conversations/open', async (ctx) => {
    const me = needUser(ctx);
    const b = ctx.body || {};
    let peerId = util.num(b.peerId);
    let listing = null;
    if (b.listingId) {
      listing = db.findById('listings', b.listingId);
      if (listing) peerId = listing.sellerId;
    }
    const aiUser = db.one('users', (u) => u.isAI);
    if (!peerId && aiUser) peerId = aiUser.id;
    let peer = (await db.findByIdWithFallback('users', peerId)).doc;
    if (!peer) peer = db.findById('users', peerId);
    if (!peer) fail('对方不存在');
    if (peer.id === me.id) fail('不能和自己发起会话');
    let conv = db.one('conversations', (c) => c.members.length === 2 && c.members.indexOf(me.id) !== -1 && c.members.indexOf(peer.id) !== -1);
    if (!conv) conv = db.insert('conversations', { members: [me.id, peer.id], lastMessage: '', lastTime: Date.now() });
    if (b.sendCard && listing) {
      const card = { listingId: listing.id, title: listing.title, image: listing.images[0], price: listing.price, priceUnit: listing.priceUnit };
      ws.sendChatMessage(me.id, conv.id, '', 'listing', card);
    }
    return { conversation: decoConv(conv, me) };
  });

  route('GET', '/api/conversations/:id/messages', (ctx) => {
    const me = needUser(ctx);
    const conv = db.findById('conversations', ctx.params.id);
    if (!conv || conv.members.indexOf(me.id) === -1) fail('会话不存在', 404);
    const limit = Math.min(100, util.num(ctx.query.get('limit'), 50));
    const before = util.num(ctx.query.get('beforeId'));
    const after = util.num(ctx.query.get('afterId'));
    // 时间游标（云端同款）：排序与翻页都认 createdAt，不认 id —— 见云端注释
    const beforeAt = util.num(ctx.query.get('beforeAt'));
    const afterAt = util.num(ctx.query.get('afterAt'));
    const tOf = (m) => (typeof m.createdAt === 'number' ? m.createdAt : 0);
    let list = db.find('messages', (m) => m.convId === conv.id);
    if (beforeAt) list = list.filter((m) => tOf(m) < beforeAt);
    else if (before) list = list.filter((m) => m.id < before);
    if (afterAt) list = list.filter((m) => tOf(m) > afterAt - 2000);
    else if (after) list = list.filter((m) => m.id > after);
    list.sort((a, b) => (tOf(a) - tOf(b)) || (a.id - b.id));
    list = (after || afterAt) ? list.slice(0, limit) : list.slice(-limit);
    return { list, conversation: decoConv(conv, me) };
  });

  route('POST', '/api/conversations/:id/messages', (ctx) => {
    const me = needUser(ctx);
    const b = ctx.body || {};
    let msg = null;
    if (b.type === 'listing' || b.type === 'order') msg = ws.sendChatMessage(me.id, ctx.params.id, '', b.type, b.card);
    else if (b.type === 'image') msg = ws.sendChatMessage(me.id, ctx.params.id, util.clampText(b.content, 300), 'image');
    else msg = ws.sendChatMessage(me.id, ctx.params.id, util.clampText(b.content, 1000), 'text');
    if (!msg) fail('发送失败，请确认会话归属');
    return { message: msg };
  });

  route('POST', '/api/conversations/:id/read', (ctx) => {
    const me = needUser(ctx);
    const conv = db.findById('conversations', ctx.params.id);
    if (!conv || conv.members.indexOf(me.id) === -1) fail('会话不存在', 404);
    ws.markRead(me.id, conv.id);
    return { ok: true };
  });
};
