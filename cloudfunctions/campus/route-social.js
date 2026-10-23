'use strict';
/** 社区 API：圈子 / 帖子 / 评论 / 点赞 / 话题 + 会话消息 */
const db = require('./db');
const util = require('./util');
const deco = require('./deco');
const ws = require('./events');
/** 互动消息（点赞/评论/回复…）—— 独立的「互动消息」页，不走 AI 会话 */
const it = require('./interactions');

function needUser(ctx) {
  if (!ctx.user) { const e = new Error('请先登录'); e.status = 401; throw e; }
  return ctx.user;
}
function fail(message, status) { const e = new Error(message); e.status = status || 400; throw e; }

  /**
   * 把一个会话抹平成列表要用的字段。
   *
   * ⚠️ 预览文案**以「最后一条消息」为准**，不直接信任 conversations.lastMessage。
   *
   * 原因（真实事故）：曾经 saveSoon() 是空实现，`conv.lastMessage / lastTime`
   * 长期不落库，库里的值可能停在「会话创建那一刻」—— 表现就是消息列表里
   * 一直显示旧内容、时间也停住（用户看到「不显示最新的话题」）。
   * 从 messages 推出来既能**自愈这些历史数据**，以后也不会再出现这种偏差。
   * 存储字段仍会照常更新（见 events.js 的 createMessage），只是不再作为唯一依据。
   */
  /**
   * 会话展示信息（对方、最后一条预览、未读数）。
   *
   * ⚠️ `msgs` 参数：调用方若已直查过该会话的消息，请**传进来**。
   * 不传时退回内存读取 —— 而内存是冷启动快照、永不刷新，
   * 会导致「未读数不对」「预览停在旧消息」（别的实例发的消息算不进来）。
   */
  function decoConv(c, me, msgs) {
    const peerId = c.members.find((x) => x !== me.id);
    const peer = deco.sellerBrief(peerId);
    const list = msgs || db.find('messages', (m) => m.convId === c.id);
    const unread = list.filter((m) => m.senderId !== me.id && (m.readBy || []).indexOf(me.id) === -1).length;
    // 最后一条消息：按 **createdAt** 取最大。
    // 不能用 id —— 多实例下 id = seq*65536+随机槽位，不代表时间先后，
    // 取 max(id) 会拿到一条更早的消息，会话列表的预览就成了旧的。
    let last = null;
    const tOf = (m) => (typeof m.createdAt === 'number' ? m.createdAt : 0);
    for (const m of list) {
      if (!last || tOf(m) > tOf(last) || (tOf(m) === tOf(last) && m.id > last.id)) last = m;
    }
    const lastTime = last ? last.createdAt : (c.lastTime || c.createdAt);
    return {
      id: c.id, peer,
      lastMessage: last ? ws.lastPreview(last) : (c.lastMessage || ''),
      lastTime,
      timeText: util.relTime(lastTime),
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
  /**
   * 圈子帖子列表。
   *
   * ⚠️ 直查数据库 —— 内存镜像是**冷启动快照、永不刷新**，
   * 读它会看不到其他实例刚发的帖子。前端现象就是
   * 「别人发布的帖子我当时看不到，过一会（那台实例落库后）又出现了」，
   * 以及「同一个人在不同人手机上看到的列表不一样」。
   */
  route('GET', '/api/posts', async (ctx) => {
    const me = ctx.user;
    const q = ctx.query;
    const circleId = util.num(q.get('circleId'));
    const topic = q.get('topic') || '';
    const kw = (q.get('keyword') || '').trim();
    const sort = q.get('sort') || 'new';
    /** 按作者过滤（「我的动态」用）：只拿这个人发的帖子 */
    const authorId = util.num(q.get('authorId'));
    let list = null;
    try { list = await db.readAllFromDb('posts'); } catch (e) { /* 忽略，退回内存 */ }
    if (!list || !list.length) list = db.get('posts').slice();
    // 作者可能由别的实例创建 → 补进内存，否则作者渲染成空白
    await db.warmUsers(list.map((p) => p.authorId));
    if (circleId) list = list.filter((p) => p.circleId === circleId);
    if (authorId) list = list.filter((p) => p.authorId === authorId);
    if (topic) list = list.filter((p) => (p.topics || []).includes(topic));
    if (kw) list = list.filter((p) => util.match(p.content, kw) || (p.topics || []).some((t) => util.match(t, kw)));
    if (sort === 'hot') {
      list.sort((a, b) => ((b.likeBase || 0) + (b.likes || []).length + (b.commentCount || 0) * 2) -
        ((a.likeBase || 0) + (a.likes || []).length + (a.commentCount || 0) * 2));
    } else list.sort((a, b) => b.createdAt - a.createdAt);
    const page = util.paginate(list, q.get('page'), q.get('pageSize') || 10);
    // 先把帖子装饰成**副本**，再用真实评论数覆盖副本上的 commentCount ——
    // 这样列表上的数字与详情页实际列出的条数**必然一致**
    //（存储字段可能留着历史脏值，见 deco.realCommentCounts 的说明）
    const out = page.list.map((p) => deco.decoratePost(p, me));
    await deco.realCommentCounts(out);
    return Object.assign({}, page, { list: out });
  });

  /**
   * 发帖（**幂等**，同 POST /api/listings）。
   *
   * 同一个 reqId 只建一条；重复提交返回第一次那条。
   * 用户反馈过「点一次发帖出来两条一模一样的」，根因是连点/重试穿过了前端锁。
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
   * 与 DELETE 同理，查找要带数据库兜底 —— 帖子可能落在别的实例里。
   */
  route('PATCH', '/api/posts/:id', async (ctx) => {
    const me = needUser(ctx);
    const f = await db.findByIdWithFallback('posts', ctx.params.id);
    const p = f.doc;
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

  /**
   * 帖子详情 + 评论列表。
   *
   * ⚠️ 这里**必须直查数据库**，不能只读内存镜像。
   * 云函数是**多实例**的：每个实例的 `db.get()` 是它冷启动那一刻的快照，
   * 之后**永不刷新**（这是本项目反复踩到的坑）。于是：
   *   - A 实例写入的评论，B 实例的内存里没有 → 读不到
   *     ⇒ 前端现象「不同测试人员看到的评论不一致、不完整，有时完全看不到」
   *   - 评论条数写 4、列表只渲染 2 条
   *     ⇒ 因为**数字来自 post.commentCount 字段，列表来自本实例内存**，两个数据源
   *   - 刚发布的帖子落在别的实例 → 这里直接「帖子不存在」
   */
  route('GET', '/api/posts/:id', async (ctx) => {
    // 帖子本身也兜底：新帖可能落在别的实例的内存里
    const f = await db.findByIdWithFallback('posts', ctx.params.id);
    const p = f.doc;
    if (!p) fail('帖子不存在', 404);
    const me = ctx.user;

    /**
     * 读评论：**三级兜底**，任何一级成功都能拿到完整列表。
     *
     * ① `where({postId})` 直查数据库（最快）
     * ② 全量拉 comments 集合、在 JS 里按 `Number(postId)` 比对
     *    —— 专治「按字段查不到」这类静默失败：
     *      postId 历史数据里可能存成字符串（`"3"` vs `3`），
     *      `where` 匹配不上会**返回空数组、不报错** →
     *      前端就是「从外面看明明显示有两条评论，进去后却一条都没有」。
     * ③ 退回内存镜像（至少不会整片空白；多实例下可能不全）
     */
    let src = null;
    try {
      src = await db.fetchByField('comments', 'postId', p.id);
    } catch (e) { /* 忽略，继续兜底 */ }
    if (!src || !src.length) {
      try {
        const all = await db.readAllFromDb('comments', true);
        const mine = (all || []).filter((c) => Number(c.postId) === Number(p.id));
        if (mine.length) src = mine;
      } catch (e) { /* 忽略，继续兜底 */ }
    }
    // 内存兜底也用 Number 比对：避免内存里存的是字符串 id 时又漏掉
    if (!src || !src.length) src = db.find('comments', (c) => Number(c.postId) === Number(p.id));

    /**
     * 把作者资料**以数据库为准**刷新进内存。
     *
     * 这里就是「头像/昵称有时候加载不出来、有时候加载出来了刷新又没了」的正解：
     * `deco.sellerBrief` 是同步的、只能读本实例内存，而本实例内存是冷启动快照，
     * 会同时错在两个方向：
     *   ① 这个人是别的实例刚注册/刚改名的 → 本实例内存里**根本没有他**
     *      → 头像和昵称**同时空白**（原来 sellerBrief 直接返回 null）
     *   ② 他改过头像昵称 → 本实例内存里还是**旧值**
     * 「一会儿有一会儿没有」= 请求在启动更晚（已含新资料）和启动更早（旧资料）的
     * 实例之间来回落。
     * 帖子作者也要一起刷：他改头像后，别人看他的帖子同样是旧头像。
     */
    await db.refreshUsers([p.authorId].concat(src.map((c) => c.authorId)), { force: true });
    // 收藏状态也直查一次（deco.isFavorite 同步读内存），否则图标不变色也点不回来
    if (me) await db.warmFavorites(me.id);

    /* ---------- 评论组织成两级：顶层评论 + 它的 replies ---------- */
    const byId = {};
    for (const c of src) byId[c.id] = c;

    /**
     * 找一条评论所属的**顶层**评论 id（小红书那种"所有回复都缩在第一层楼下"）。
     * 顺着 replyTo 往上走；父评论已被删除时把它自己当顶层 ——
     * 宁可让它以顶层出现，也**绝不能丢弃**（丢弃就是用户反馈的"评论被吞"）。
     * 最多走 20 层，防脏数据成环死循环。
     */
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
      /**
       * 「回复 @某某」只在**回复子评论**时显示。
       *
       * 回复**顶层大评论**时不显示 —— 因为那条回复本来就缩在这条大评论底下，
       * 再写一遍「回复 楼主」是冗余的（小红书也是这样）。
       * 只有当被回复的是**大评论下面的某条子评论**时，才需要标出在回谁。
       *
       * 判据：被回复者自己是不是顶层楼（`rootOf(t) === t.id` 即为顶层）。
       */
      const tIsRoot = !!t && rootOf(t) === Number(t.id);
      return Object.assign({}, c, {
        author: deco.sellerBrief(c.authorId),
        timeText: util.relTime(c.createdAt),
        isMine: me ? c.authorId === me.id : false,
        // 被回复者的昵称/内容摘要：前端只拿到 id 没法显示「回复 @某某」
        replyToName: (t && !tIsRoot) ? deco.sellerBrief(t.authorId).nickname : '',
        replyToText: (t && !tIsRoot) ? String(t.content || '').slice(0, 40) : '',
        // 归属的顶层评论 id —— 前端要据此把新回复插到正确的"楼"下面
        rootId: rootOf(c)
      });
    };

    const flat = src.slice()
      .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
      .map(shape);

    const roots = [];
    const rootIndex = {};
    for (const c of flat) {
      // 是"回复某人"、且那个父评论还在、且它自己不是顶层 → 挂到所属顶层楼的 replies 里
      const pid = Number(c.replyTo);
      if (pid && byId[pid] && c.rootId !== c.id && rootIndex[c.rootId]) {
        rootIndex[c.rootId].replies.push(c);
        continue;
      }
      c.replies = [];
      rootIndex[c.id] = c;
      roots.push(c);
    }

    const total = flat.length;
    /**
     * 只把这个真实条数**下发**（post.commentCount 与 commentTotal），
     * **不在读接口里回写数据库**。
     *
     * 原实现会在 `commentCount !== total` 时 update 回库，本意是自愈历史脏值；
     * 但它有个反作用：只要**这一次读**不完整（查库失败、脏数据导致 where 匹配不到、
     * 内存兜底也不全），就会把一条正确的计数**覆盖成 0**，而且立刻落库 ——
     * 一次偶发读失败 = 永久写坏。用户的观感正是
     * 「外面显示 2 条评论，进去一条都没有」。
     *
     * 现在计数由两处保证正确：
     *   ① 写入路径自增/自减（POST /comments、DELETE /comments/:id）
     *   ② 列表/详情**从 comments 集合重新推导**（见 deco.realCommentCounts）
     * 都不依赖「在读的时候回写」。
     */
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

  route('POST', '/api/posts/:id/comments', async (ctx) => {
    const me = needUser(ctx);
    // 帖子兜底：新帖可能在别的实例（否则评论会「帖了不存在」）
    const f = await db.findByIdWithFallback('posts', ctx.params.id);
    const p = f.doc;
    if (!p) fail('帖子不存在', 404);
    const content = util.clampText((ctx.body || {}).content, 300);
    if (!content) fail('评论内容不能为空');

    /**
     * 回复目标必须**真实存在且属于本帖**，所以要走直查兜底。
     *
     * 只用 db.findById（内存）时，如果这条被回复的评论是别的实例写入的、
     * 本实例内存里没有 → 校验不通过 → `replyTo` 被静默置空 →
     * 用户点的「回复某某」变成了**直接评论帖子**（用户反馈的原话）。
     */
    let replyTo = Number((ctx.body || {}).replyTo) || null;
    let target = null;
    if (replyTo) {
      const tf = await db.findByIdWithFallback('comments', replyTo);
      target = tf.doc;
      if (!target || target.postId !== p.id) { replyTo = null; target = null; }
    }

    const c = db.insert('comments', {
      postId: p.id, authorId: me.id, content, replyTo, createdAt: Date.now()
    });
    /**
     * ⚠️ 这里**不能**再写 `db.find('comments', ...).length`。
     *
     * 那是「**本实例内存里的**评论条数」——多实例下必然偏小
     * （看不到别的实例写入的评论），而且会把这个偏小的值**覆盖写回数据库**，
     * 于是评论数越写越小、与详情页实际列出的条数长期对不上。
     * （前端现象：「评论数显示与实际内容不一致」。）
     *
     * 改为自增；详情页读取时会用真实条数校正（见 GET /api/posts/:id）。
     */
    p.commentCount = (p.commentCount || 0) + 1;
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

    // ⚠️ 被回复者的昵称必须**在这里也下发**。
    //    上一次只给 GET 补了 replyToName、POST 漏了 ——
    //    结果「刚发出去的那条回复」看不到「回复 @某某」，
    //    看起来就像"回复了但没生效"，刷新一下才出现。
    let targetAuthor = null;
    // 只有「回复子评论」才回传 replyToName（回复顶层大评论时不显示「回复某人」）
    const targetIsRoot = !!target && !Number(target.replyTo || 0);
    if (target && !targetIsRoot) {
      // force：被回复者的昵称要立刻是新的（他可能刚改过名）
      await db.refreshUsers([target.authorId], { force: true });
      targetAuthor = deco.sellerBrief(target.authorId);
    }
    return {
      comment: Object.assign({}, c, {
        // me 来自 auth.userByToken —— 那是**直查数据库**拿到的，是最新的资料。
        // 不能用 sellerBrief(me.id)：它读本实例可能过期的内存镜像，
        // 会出现「我自己刚改完昵称，我发的评论却还是旧昵称」。
        author: deco.briefOf(me),
        timeText: '刚刚',
        isMine: true,
        replyToName: targetAuthor ? targetAuthor.nickname : '',
        replyToText: target ? String(target.content || '').slice(0, 40) : '',
        replies: []
      }),
      commentCount: p.commentCount
    };
  });

  route('DELETE', '/api/comments/:id', async (ctx) => {
    const me = needUser(ctx);
    const c = db.findById('comments', ctx.params.id);
    if (!c || (c.authorId !== me.id && !me.isAdmin)) fail('无权操作', 403);
    db.removeById('comments', c.id);
    const f = await db.findByIdWithFallback('posts', c.postId);
    const p = f.doc;
    if (p) {
      // 同 POST：不用「本实例内存条数」重算（会偏小且覆盖写库），改自减
      p.commentCount = Math.max(0, (p.commentCount || 1) - 1);
      db.saveSoon();
    }
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
    // 直查数据库：会话可能由别的实例刚创建/刚有新消息，
    // 只读内存会出现「消息 tab 里少了一个会话」或预览停在旧内容。
    let all = null;
    try { all = await db.readAllFromDb('conversations'); } catch (e) { /* 忽略 */ }
    if (!all || !all.length) all = db.find('conversations', () => true);
    const mine = all.filter((c) => c.members.indexOf(me.id) !== -1);
    // 消息也直查一次（未读数 / 预览都依赖它），按会话分组
    const convMsgs = {};
    try {
      const msgs = await db.readAllFromDb('messages');
      for (const m of msgs) (convMsgs[m.convId] = convMsgs[m.convId] || []).push(m);
    } catch (e) { /* 忽略，decoConv 会退回内存 */ }
    const list = mine
      .sort((a, b) => (b.lastTime || b.createdAt) - (a.lastTime || a.createdAt))
      .map((c) => decoConv(c, me, convMsgs[c.id]));
    // 对方可能是别的实例创建的用户 → 补进内存，否则会话列表人名/头像空白
    await db.warmUsers(list.map((c) => c.peer && c.peer.id));
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
      // 商品可能是别的实例刚发布/刚改价的 → 兜底
      listing = (await db.findByIdWithFallback('listings', b.listingId)).doc;
      if (listing) peerId = listing.sellerId;
    }
    const aiUser = db.one('users', (u) => u.isAI);
    if (!peerId && aiUser) peerId = aiUser.id;
    // ⚠️ 不能只查内存：对方（尤其买家）可能是别的实例写入的用户，
    // 本实例镜像里没有 → 误报「对方不存在」（订单列表点「联系买家」就是这个现象，
    // 而订单详情能进，因为详情接口先 warmUsers 把对方补进了内存）。
    let peer = (await db.findByIdWithFallback('users', peerId)).doc;
    if (!peer) {
      try { await db.warmUsers([peerId]); } catch (e) { /* 忽略 */ }
      peer = db.findById('users', peerId);
    }
    if (!peer) fail('对方不存在');
    if (peer.id === me.id) fail('不能和自己发起会话');
    /**
     * ⚠️ 查「是否已有双人会话」也直查数据库。
     * 只读内存时，若会话是别的实例建的，这里查不到 → **又建一个新会话** →
     * 用户看到「同一个人的两个会话、消息各在一半」。
     */
    let allConv = null;
    try { allConv = await db.readAllFromDb('conversations'); } catch (e) { /* 忽略 */ }
    if (!allConv) allConv = db.find('conversations', () => true);
    let conv = allConv.find((c) =>
      c.members.length === 2 && c.members.indexOf(me.id) !== -1 && c.members.indexOf(peer.id) !== -1) || null;
    if (conv) {
      // 补进内存，让后续同步逻辑（sendChatMessage）能命中
      if (!db.findById('conversations', conv.id)) db.insert('conversations', conv);
    }
    if (!conv) conv = db.insert('conversations', { members: [me.id, peer.id], lastMessage: '', lastTime: Date.now() });
    if (b.sendCard && listing) {
      const card = { listingId: listing.id, title: listing.title, image: listing.images[0], price: listing.price, priceUnit: listing.priceUnit };
      ws.sendChatMessage(me.id, conv.id, '', 'listing', card);
    }
    const fresh = await db.fetchByField('messages', 'convId', conv.id, 1000);
    return { conversation: decoConv(conv, me, fresh) };
  });

  route('GET', '/api/conversations/:id/messages', async (ctx) => {
    const me = needUser(ctx);
    // ⚠️ 必须回库兜底一次：会话可能刚刚由**另一个实例**创建并落库
    //（点「聊一聊」→ open 写库 → 紧接的读请求落到另一个更早启动的实例）。
    // 只查内存会误判「会话不存在」→ 前端自愈 → 把用户丢进 AI 会话。
    const { doc: conv } = await db.findByIdWithFallback('conversations', ctx.params.id);
    if (!conv || conv.members.indexOf(me.id) === -1) fail('会话不存在', 404);
    const limit = Math.min(100, util.num(ctx.query.get('limit'), 50));
    const before = util.num(ctx.query.get('beforeId'));
    const after = util.num(ctx.query.get('afterId'));
    /**
     * 时间游标（毫秒）。**这才是聊天的正确排序/翻页依据。**
     *
     * id 在多实例下不随时间单调：id = seq * 65536 + 本实例随机槽位（见 db.js nextId），
     * 同一个 seq 里谁大谁小取决于随机槽位。按 id 排/翻页的结果就是
     * 「19:52 的消息排在 19:50 上面」「同一分钟的两条上下乱跳」，
     * 增量拉取还会**漏消息**（别的实例写入的 id 比游标小 → 永远拉不到）。
     */
    const beforeAt = util.num(ctx.query.get('beforeAt'));
    const afterAt = util.num(ctx.query.get('afterAt'));
    /**
     * ⚠️ **总是**直查数据库，不能再"按需"查。
     *
     * 原来的写法是：
     *     const needFresh = fromDb || !!after;      // 只有这两种情况才回库
     *     let list = needFresh ? 查库 : db.find('messages', ...);
     * 于是**正常重进聊天页时**（会话已在内存里、又没有 afterId）走的是**内存读取** ——
     * 用户发的消息写在实例 A，重进时请求路由到实例 B，B 的内存里没有这条消息：
     * **「明明发了的消息，退出去再进来就看不到了，反复进也一样」**。
     *
     * 消息是整个应用最动态的数据，而内存镜像永不刷新，所以这里必须每次回库
     * （成本只是会话内的一次查询，列表本来就限 100 条）。
     */
    let all = await db.fetchByField('messages', 'convId', conv.id, 1000);
    if (!all || !all.length) {
      // 查库失败/为空时退回内存（例如集合刚建还没数据），至少不清空界面
      all = db.find('messages', (m) => m.convId === conv.id);
    }
    // 未读数/预览要用**全部**消息算，所以在过滤分页之前留一份
    const allMsgs = all;
    const tOf = (m) => (typeof m.createdAt === 'number' ? m.createdAt : 0);
    // 时间游标优先；没有时才退回 id 游标（兼容没升级的前端）
    let list = all;
    if (beforeAt) list = list.filter((m) => tOf(m) < beforeAt);
    else if (before) list = list.filter((m) => m.id < before);
    if (afterAt) list = list.filter((m) => tOf(m) > afterAt - 2000);  // 留 2 秒重叠，重复按 id 去重
    else if (after) list = list.filter((m) => m.id > after);
    // 一律升序（按时间，同毫秒再按 id 稳定）
    list.sort((a, b) => (tOf(a) - tOf(b)) || (a.id - b.id));
    // 增量（after*）取最早的一批，翻页/首屏取最靠近现在的一批
    list = (after || afterAt) ? list.slice(0, limit) : list.slice(-limit);
    return { list, conversation: decoConv(conv, me, allMsgs) };
  });

  route('POST', '/api/conversations/:id/messages', async (ctx) => {
    const me = needUser(ctx);
    const b = ctx.body || {};
    // deferAI=1：只存消息立刻返回（AI 回复由前端另发 /ai-reply）
    // 默认：本次请求内一并生成 AI 回复并随响应返回（云函数超时已调至 20 秒）
    const defer = ctx.query.get('deferAI') === '1' || b.deferAI === true;

    // 会话若不在本实例内存里（可能是另一实例刚建的），先回库补进内存，
    // 这样下面 ws.sendChatMessage 里的同步 db.findById 才能命中。
    await db.findByIdWithFallback('conversations', ctx.params.id);

    let msg = null;
    if (b.type === 'listing' || b.type === 'order') {
      msg = ws.sendChatMessage(me.id, ctx.params.id, '', b.type, b.card, { deferAI: defer });
    } else if (b.type === 'image') {
      msg = ws.sendChatMessage(me.id, ctx.params.id, util.clampText(b.content, 300), 'image', null, { deferAI: defer });
    } else {
      msg = ws.sendChatMessage(me.id, ctx.params.id, util.clampText(b.content, 1000), 'text', null, { deferAI: defer });
    }
    if (!msg) fail('发送失败，请确认会话归属');

    let aiMessage = null;
    let aiMessages = [];
    if (!defer) {
      // 等 AI 回复生成完（内部已排入 pending 队列）
      await ws.drainPending();
      const conv = db.findById('conversations', msg.convId);
      if (conv) {
        const aiId = conv.members.find((x) => x !== me.id);
        // 一次回复可能产生多条 AI 消息：文字 + 商品卡片（listings）。
        // 这里要全部返回，否则前端只拿到最后一条（卡片），文字得等轮询才出现。
        const after = db.find('messages', (m) => m.convId === conv.id && m.senderId === aiId && m.id > msg.id)
          .sort((a, b) => a.id - b.id);
        if (after.length) {
          aiMessages = after;
          aiMessage = after[after.length - 1];   // 兼容旧字段
        }
      }
    }

    return { message: msg, aiMessage, aiMessages };
  });

  /**
   * 为最新一条用户消息生成 AI 客服回复（异步通道，备选）。
   * 幂等：已回复过则跳过。
   */
  route('POST', '/api/conversations/:id/ai-reply', async (ctx) => {
    const me = needUser(ctx);
    // 同上：先把会话补进内存，否则 replyLatestAsAI 会误报「会话不存在」
    await db.findByIdWithFallback('conversations', ctx.params.id);
    return ws.replyLatestAsAI(ctx.params.id, me.id);
  });

  route('POST', '/api/conversations/:id/read', async (ctx) => {
    const me = needUser(ctx);
    const { doc: conv } = await db.findByIdWithFallback('conversations', ctx.params.id);
    if (!conv || conv.members.indexOf(me.id) === -1) fail('会话不存在', 404);
    /**
     * ⚠️ **每次都**先把该会话的消息从库里拉回内存，不能只在「会话是刚补进来的」时候拉。
     *
     * 原来写的是 `if (fromDb) fetchByField(...)`，漏掉最常见的一种情况：
     * 会话在内存里（冷启动快照就有），但**消息是别的实例写的** → 内存里没有那几条
     * → 下面 `ws.markRead` 只标得到内存里那几条 → 库里仍是未读 →
     * 退出聊天后红点还在，用户以为「已读了但红点不消失」。
     */
    await db.fetchByField('messages', 'convId', conv.id, 1000);
    ws.markRead(me.id, conv.id);
    return { ok: true };
  });
};
