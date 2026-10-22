'use strict';
/** 基础 API：登录 / 用户 / 钱包 / 地址 / 收藏 / 浏览记录 / 公告 / 举报 / 上传 */


const db = require('./db');
const util = require('./util');
const auth = require('./auth');
const deco = require('./deco');
const ws = require('./events');
/** 互动消息（收藏/关注…） */
const it = require('./interactions');

let cloudSdk = null;
try { cloudSdk = require('wx-server-sdk'); } catch (e) { /* 本地/测试环境可能没有 */ }

/**
 * 取当前调用者的微信 openid。
 *
 * 必须用 openid 做账号唯一标识，否则「微信一键登录」每次都会新建一个空账号，
 * 用户重新登录后会发现聊天/收藏/订单全都不见了。
 * 云端测试、本地 mock 等场景拿不到 openid 时返回空串，由调用方退化处理。
 */
function currentOpenid() {
  try {
    const c = cloudSdk && cloudSdk.getWXContext && cloudSdk.getWXContext();
    return (c && c.OPENID) || '';
  } catch (e) { return ''; }
}

function needUser(ctx) {
  if (!ctx.user) { const e = new Error('请先登录'); e.status = 401; throw e; }
  return ctx.user;
}
function fail(message, status) { const e = new Error(message); e.status = status || 400; throw e; }

module.exports = function register(route) {
  /* ---------- 登录 / 会话 ---------- */
  route('POST', '/api/login', async (ctx) => {
    const { nickname, avatar, testUserId } = ctx.body || {};
    let user = null;
    let isNew = false;
    if (testUserId) {
      user = db.findById('users', testUserId);
      if (!user) fail('测试账号不存在');
      // 直查数据库兜底：多实例下内存镜像可能落后于库
      if (!user) {
        try {
          const r = await db.db().collection('users').doc(String(testUserId)).get();
          user = r && r.data ? Object.assign({}, r.data) : null;
        } catch (e) { /* 忽略 */ }
      }
    } else {
      const pool = ['a01', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07', 'a08'];
      const suffix = Math.random().toString(36).slice(2, 6);
      const nick = util.clampText(nickname, 20) || ('微信用户' + suffix);

      /**
       * 按 openid 复用已有账号。
       *
       * 此前每次「微信一键登录」都无条件 insert 一个新用户（openid 也是随机生成的），
       * 导致同一部手机每次登录都变成空账号 —— 聊天记录、收藏、订单全部「消失」，
       * 而且新账号的会话 id 与旧账号不同，容易出现「会话不存在」。
       * 这里改为：有 openid 就先找，找不到才创建。
       */
      const openid = currentOpenid();
      if (openid) {
        user = db.one('users', (u) => u.openid === openid && !u.isAI);
        if (!user) {
          // 多实例下内存可能落后于库，直查一次兜底
          try {
            const r = await db.db().collection('users').where({ openid }).limit(1).get();
            const hit = r && r.data && r.data[0];
            if (hit) {
              const doc = Object.assign({}, hit);
              delete doc._id;
              user = doc;
              // 补进内存，后续请求可直接命中
              try { db.insert('users', user); } catch (e) { /* 忽略 */ }
            }
          } catch (e) { /* 忽略 */ }
        }
      }

      if (user) {
        // 老用户：昵称/头像有新值就顺手更新，其余资料保持不动
        const patch = {};
        if (nickname && util.clampText(nickname, 20) && util.clampText(nickname, 20) !== user.nickname) {
          patch.nickname = util.clampText(nickname, 20);
        }
        if (avatar && avatar !== user.avatar) patch.avatar = avatar;
        if (Object.keys(patch).length) db.update('users', user.id, patch);
        isNew = false;
      } else {
        user = db.insert('users', {
          nickname: nick,
          avatar: avatar || ('/static/avatars/' + pool[Math.floor(Math.random() * pool.length)] + '.jpg'),
          // 拿不到 openid（云端测试/本地 mock）时退化，保持原有行为
          openid: openid || ('dev_' + util.randomToken(8)),
          gender: 0, bio: '', college: '', grade: '',
          campus: '广东科贸职业学院（清远校区）', credit: 80, cert: 'none',
          balance: 0, status: 'normal', noticeRead: [], joinedAt: Date.now()
        });
        isNew = true;
        // 新用户直接落库：紧随其后的 /api/me 走直查，不能等内存 flush
        try {
          await db.db().collection('users').doc(String(user.id)).set({ data: user });
        } catch (e) {
          try {
            await db.ensureCollection('users');
            await db.db().collection('users').doc(String(user.id)).set({ data: user });
          } catch (e2) { /* 忽略 */ }
        }
        try {
          // preRead：欢迎语只作打招呼，不该在新账号上挂一个未读红点
          ws.notifyUser(user.id, ws.WELCOME_TEXT, null, { preRead: true });
        } catch (e) { /* 通知失败不影响登录 */ }
      }
    }
    // 自愈：清理历史遗留的「未读欢迎语」（老版本没设 preRead）
    try { ws.healGreetingUnread(user.id); } catch (e) { /* 忽略 */ }
    const token = await auth.createSession(user.id);
    return { token, user: util.publicUser(user), isNew };
  });

  route('POST', '/api/logout', async (ctx) => {
    await auth.destroySession(ctx.token);
    return { ok: true };
  });

  /**
   * 演示账号列表（登录页「演示账号 · 一键体验」用）。
   *
   * ⚠️ 只返回**没有微信身份**的种子账号 —— 这是「多人测试时账号会不会串」的关键。
   *
   * 原本只按 `cert === 'student'` 过滤，而**真人填了学院，cert 就会变成 student**
   * （见 PATCH /api/me）→ 于是真人账号也进了这个列表，
   * 任何人点一下就能登成他，看到对方的聊天、订单、余额。
   * 云端实测确认过：真实 openid 账号（oPZI…28 位）确实出现在列表里。
   *
   * 种子里那 9 个演示账号 openid 为空；真人（微信一键登录）一定有 openid，
   * 登录异常路径产生的 dev_ 账号也有 —— 用「没有 openid」一条就能把两者都挡住。
   */
  route('GET', '/api/test-accounts', () => {
    const users = db.get('users').filter((u) => !u.isAI && u.cert === 'student' && !u.openid).slice(0, 10);
    return { accounts: users.map((u) => ({ id: u.id, nickname: u.nickname, avatar: u.avatar, college: u.college })), aiId: (db.one('users', (u) => u.isAI) || {}).id };
  });

  /* ---------- 我的资料 ---------- */
  route('GET', '/api/me', async (ctx) => {
    const me = needUser(ctx);
    /**
     * 以库为准刷一次（force：用户正盯着看，不能被 TTL 挡在旧头像上）。
     *
     * 为什么必须刷：这个接口会被用来「改完头像/昵称后重新拉一次」，
     * 而 PATCH 可能落在实例 A、这次 GET 落在实例 B —— B 的内存快照还停在
     * 旧头像，返回旧值会把前端刚更新的头像**覆盖回去**，
     * 表现就是「头像要上传两次才生效」。单文档读，成本可以接受。
     */
    await db.refreshUsers([me.id], { force: true });
    const fresh = db.findById('users', me.id) || me;
    const out = util.publicUser(Object.assign({}, fresh));
    out.stats = await deco.userStatsFresh(fresh.id);
    return { user: out };
  });

  /**
   * 修改我的资料（昵称/头像/学院…）。
   *
   * ⚠️ 必须 async + findByIdWithFallback，不能直接 db.update('users', me.id, patch)：
   *    `db.update` 内部走 `findById`，**只查内存镜像**；内存里找不到这条用户
   *    （多实例下「我」是别的实例注册的、或本实例快照早于我注册）时
   *    `update` 直接返回 null —— **改动被静默丢弃**，接口还回 200。
   *    现象就是用户反馈的「改了头像/昵称，过一会儿又变回旧的」。
   *    兜底查库把这条用户补进内存后再打补丁。
   */
  route('PATCH', '/api/me', async (ctx) => {
    const me = needUser(ctx);
    const b = ctx.body || {};
    const patch = {};
    for (const k of ['nickname', 'avatar', 'bio', 'college', 'grade', 'campus', 'gender', 'contact']) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    if (patch.nickname !== undefined) patch.nickname = util.clampText(patch.nickname, 20) || me.nickname;
    if (patch.bio !== undefined) patch.bio = util.clampText(patch.bio, 60);
    if (patch.college !== undefined && patch.college && me.cert === 'none') patch.cert = 'student';
    await db.findByIdWithFallback('users', me.id);
    const user = db.update('users', me.id, patch)
      // 极端情况（库里也查不到）——至少别让前端拿到 null 覆盖掉页面上的资料
      || Object.assign({}, me, patch);
    return { user: util.publicUser(user) };
  });

  /* ---------- 他人主页 ---------- */
  route('GET', '/api/users/:id', async (ctx) => {
    // 直查兜底：被点开主页的人可能是别的实例注册的，
    // 内存镜像里没有 → 原来会直接 404「用户不存在」（头像点进去打不开）。
    const f = await db.findByIdWithFallback('users', ctx.params.id);
    const u = f.doc;
    if (!u) fail('用户不存在', 404);
    const me = ctx.user;
    // 他可能刚改过头像昵称 —— 以库为准刷一次，主页显示的就是最新的。
    // force：主页是「被人盯着看」的页面，不能被 TTL 挡在旧头像上。
    await db.refreshUsers([u.id], { force: true });
    const fresh = db.findById('users', u.id) || u;
    const listings = db.find('listings', (l) => l.sellerId === fresh.id && l.status === 'on')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((l) => deco.decorateListing(l, me));
    const isFollowed = me ? !!db.one('follows', (x) => x.userId === me.id && x.targetUserId === fresh.id) : false;
    const out = util.publicUser(fresh);
    out.stats = deco.userStats(fresh.id);
    return { user: out, listings, isFollowed };
  });

  route('POST', '/api/users/:id/follow', (ctx) => {
    const me = needUser(ctx);
    const target = db.findById('users', ctx.params.id);
    if (!target || target.id === me.id) fail('无效操作');
    const existed = db.one('follows', (f) => f.userId === me.id && f.targetUserId === target.id);
    if (existed) { db.removeById('follows', existed.id); return { followed: false }; }
    db.insert('follows', { userId: me.id, targetUserId: target.id, createdAt: Date.now() });
    // 互动消息：只提示他「有人关注你」，被他关注的人自己不用看到
    it.add({ toUserId: target.id, actorId: me.id, type: 'follow', targetId: target.id });
    return { followed: true };
  });

  /* ---------- 钱包 ---------- */
  route('GET', '/api/wallet', async (ctx) => {
    const me = needUser(ctx);
    // ⚠️ 余额是「直查库」拿到的（auth 里对用户资料直查），但流水若只读内存镜像，
    //    在多实例并发下会返回**过期列表** —— 表现就是「刚充值了，余额变了、
    //    明细里却没有这笔」，用户看到的就是「充值不同步」。
    //    所以这里绕开镜像，按 userId 直查云库，再与内存并集去重。
    let list = db.find('transactions', (t) => t.userId === me.id);
    try {
      const fresh = await db.fetchByField('transactions', 'userId', me.id);
      if (fresh && fresh.length) {
        const map = new Map();
        for (const t of list) map.set(String(t.id), t);
        // 库里的覆盖内存里的（库才是真相），但保留内存里尚未落库的新记录
        for (const t of fresh) {
          const old = map.get(String(t.id));
          map.set(String(t.id), old ? Object.assign({}, old, t) : t);
        }
        list = Array.from(map.values());
      }
    } catch (e) { /* 直查失败就退回内存，不影响主流程 */ }
    list = list.slice().sort((a, b) => b.createdAt - a.createdAt);
    return {
      balance: me.balance || 0,
      transactions: list.map((t) => Object.assign({}, t, { timeText: util.fmtTime(t.createdAt) }))
    };
  });

  route('POST', '/api/wallet/recharge', (ctx) => {
    const me = needUser(ctx);
    const amount = Math.round(util.num((ctx.body || {}).amount));
    if (amount <= 0 || amount > 500000) fail('充值金额需在 0.01 ~ 5000 元之间');
    const balance = (me.balance || 0) + amount;
    db.update('users', me.id, { balance });
    db.insert('transactions', { userId: me.id, type: 'recharge', amount, note: '充值', balanceAfter: balance });
    return { balance };
  });

  /* ---------- 收货地址 ---------- */
  route('GET', '/api/addresses', (ctx) => {
    const me = needUser(ctx);
    const list = db.find('addresses', (a) => a.userId === me.id).sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
    return { list };
  });

  route('POST', '/api/addresses', (ctx) => {
    const me = needUser(ctx);
    const b = ctx.body || {};
    if (!b.detail) fail('请填写详细地址');
    if (b.isDefault) db.find('addresses', (a) => a.userId === me.id).forEach((a) => db.update('addresses', a.id, { isDefault: false }));
    const item = db.insert('addresses', {
      userId: me.id, name: util.clampText(b.name, 20) || me.nickname,
      phone: util.clampText(b.phone, 20), area: util.clampText(b.area, 40),
      detail: util.clampText(b.detail, 60), isDefault: !!b.isDefault
    });
    return { item };
  });

  route('PATCH', '/api/addresses/:id', (ctx) => {
    const me = needUser(ctx);
    const item = db.findById('addresses', ctx.params.id);
    if (!item || item.userId !== me.id) fail('地址不存在', 404);
    const b = ctx.body || {};
    if (b.isDefault) db.find('addresses', (a) => a.userId === me.id).forEach((a) => db.update('addresses', a.id, { isDefault: false }));
    const patch = {};
    for (const k of ['name', 'phone', 'area', 'detail', 'isDefault']) if (b[k] !== undefined) patch[k] = b[k];
    return { item: db.update('addresses', item.id, patch) };
  });

  route('DELETE', '/api/addresses/:id', (ctx) => {
    const me = needUser(ctx);
    const item = db.findById('addresses', ctx.params.id);
    if (!item || item.userId !== me.id) fail('地址不存在', 404);
    db.removeById('addresses', item.id);
    return { ok: true };
  });

  /* ---------- 收藏 ---------- */
  route('GET', '/api/favorites', async (ctx) => {
    const me = needUser(ctx);
    const type = ctx.query.get('type') || 'listing';
    // 直查数据库：刚收藏的那条可能只在别的实例的内存里，
    // 只读内存会出现「收藏了但收藏列表里没有」。
    let all = null;
    try { all = await db.readAllFromDb('favorites'); } catch (e) { /* 忽略 */ }
    if (!all || !all.length) all = db.find('favorites', () => true);
    const favs = all.filter((f) => f.userId === me.id && f.targetType === type)
      .sort((a, b) => b.createdAt - a.createdAt);
    // 被收藏的商品/帖子也可能只在别的实例的内存里 → 并发兜底拉一次；
    // 再把卖家/作者补进内存，否则卡片上人名头像空白。
    const coll = type === 'listing' ? 'listings' : 'posts';
    await Promise.all(favs.map((f) =>
      db.findByIdWithFallback(coll, f.targetId).catch(() => null)));
    const targets = favs.map((f) => db.findById(coll, f.targetId)).filter(Boolean);
    await db.warmUsers(targets.map((t) => (type === 'listing' ? t.sellerId : t.authorId)));
    const items = favs.map((f) => {
      if (type === 'listing') {
        const l = db.findById('listings', f.targetId);
        return l ? Object.assign(deco.decorateListing(l, me), { favId: f.id }) : null;
      }
      const p = db.findById('posts', f.targetId);
      return p ? Object.assign(deco.decoratePost(p, me), { favId: f.id }) : null;
    }).filter(Boolean);
    return { items };
  });

  route('POST', '/api/favorites/toggle', async (ctx) => {
    const me = needUser(ctx);
    const { targetType, targetId } = ctx.body || {};
    if (!['listing', 'post'].includes(targetType) || !targetId) fail('参数错误');
    /**
     * ⚠️ 必须**直查数据库**判断「是否已收藏」，不能用 db.one 读内存镜像。
     *
     * 这是「收藏后取消不掉」的根因：多实例下本实例内存里没有那条收藏记录，
     * 于是 toggle 误判成「还没收藏」→ **又插入一条** → 用户怎么点都是「已收藏」，
     * 永远取消不了（而且 favorites 集合里会越积越多条重复记录）。
     */
    const existed = (await db.findFavorites(me.id, targetType, targetId))[0] || null;
    if (existed) {
      db.removeById('favorites', existed.id);
      if (targetType === 'listing') {
        const l = db.findById('listings', targetId);
        if (l) db.update('listings', l.id, { favoriteCount: Math.max(0, (l.favoriteCount || 1) - 1) });
      }
      return { favorited: false };
    }
    db.insert('favorites', { userId: me.id, targetType, targetId: Number(targetId), createdAt: Date.now() });
    if (targetType === 'listing') {
      const l = db.findById('listings', targetId);
      if (l) db.update('listings', l.id, { favoriteCount: (l.favoriteCount || 0) + 1 });
      // 互动消息：只在「刚收藏」时提醒，取消收藏不提醒
      if (l) {
        it.add({
          toUserId: l.sellerId, actorId: me.id, type: 'listing_fav',
          targetId: l.id, title: l.title, image: (l.images || [])[0] || ''
        });
      }
    } else if (targetType === 'post') {
      const p = db.findById('posts', targetId);
      if (p) {
        it.add({
          toUserId: p.authorId, actorId: me.id, type: 'post_fav',
          targetId: p.id, title: p.content, image: (p.images || [])[0] || ''
        });
      }
    }
    return { favorited: true };
  });

  /* ---------- 互动消息（点赞/评论/回复/收藏/关注 的聚合页） ---------- */
  /**
   * 列表。返回 { list, unread, total, page, hasMore }。
   * 每行已经带好 link（点进去要跳的页面），前端不用再拼路径。
   */
  route('GET', '/api/interactions', async (ctx) => {
    const me = needUser(ctx);
    return await it.list(me.id, {
      page: ctx.query.get('page'),
      pageSize: ctx.query.get('pageSize')
    });
  });

  /** 只取未读数（给入口红点用；比拉整个列表便宜） */
  route('GET', '/api/interactions/unread', async (ctx) => {
    const me = needUser(ctx);
    return { unread: await it.unreadCount(me.id) };
  });

  /** 标记已读：body.id 为空 = 全部已读（进互动消息页时用） */
  route('POST', '/api/interactions/read', async (ctx) => {
    const me = needUser(ctx);
    return await it.markRead(me.id, (ctx.body || {}).id);
  });

  /* ---------- 浏览记录 ---------- */
  route('GET', '/api/history', (ctx) => {
    const me = needUser(ctx);
    const rows = db.find('histories', (h) => h.userId === me.id).sort((a, b) => b.viewedAt - a.viewedAt);
    const seen = new Set();
    const items = [];
    for (const h of rows) {
      if (seen.has(h.listingId)) continue;
      seen.add(h.listingId);
      const l = db.findById('listings', h.listingId);
      if (l) items.push(Object.assign(deco.decorateListing(l, me), { viewedText: util.relTime(h.viewedAt) }));
      if (items.length >= 50) break;
    }
    return { items };
  });

  route('DELETE', '/api/history', (ctx) => {
    const me = needUser(ctx);
    db.remove('histories', (h) => h.userId === me.id);
    return { ok: true };
  });

  /* ---------- 公告 ---------- */
  route('GET', '/api/notices', async (ctx) => {
    const me = ctx.user;
    const read = me ? (me.noticeRead || []) : [];
    // 直查数据库：公告是管理端在后台发的，可能在别的实例，读内存会漏（与其它列表一致）
    let src = null;
    try { src = await db.readAllFromDb('notices'); } catch (e) { /* 退回内存 */ }
    if (!src || !src.length) src = db.get('notices').slice();
    const list = src.sort((a, b) => b.createdAt - a.createdAt)
      .map((n) => Object.assign({}, n, { read: read.indexOf(n.id) !== -1, timeText: util.relTime(n.createdAt) }));
    return { list, unread: list.filter((n) => !n.read).length };
  });

  /**
   * 单条公告详情。
   *
   * 首页那条公告原来点下去是 `wx.switchTab` 到校园圈子 —— 那是**错的**：
   * 公告和圈子毫无关系，用户点「公告」期待看到公告内容。
   * 现在改为进入本接口驱动的公告详情页。
   */
  route('GET', '/api/notices/:id', async (ctx) => {
    const f = await db.findByIdWithFallback('notices', ctx.params.id);
    const n = f.doc;
    if (!n) fail('公告不存在或已删除', 404);
    const me = ctx.user;
    const read = me ? (me.noticeRead || []) : [];
    return {
      notice: Object.assign({}, n, {
        read: read.indexOf(n.id) !== -1,
        timeText: util.relTime(n.createdAt),
        dateText: util.fmtTime(n.createdAt)
      })
    };
  });

  route('POST', '/api/notices/:id/read', (ctx) => {
    const me = needUser(ctx);
    const set = new Set(me.noticeRead || []);
    set.add(Number(ctx.params.id));
    db.update('users', me.id, { noticeRead: [...set] });
    return { ok: true };
  });

  /* ---------- 举报 ---------- */
  route('POST', '/api/reports', (ctx) => {
    const me = needUser(ctx);
    const { targetType, targetId, reason, detail } = ctx.body || {};
    if (!['listing', 'post', 'user', 'order', 'wall', 'resource', 'comment'].includes(targetType) || !targetId || !reason) fail('参数错误');
    db.insert('reports', {
      reporterId: me.id, targetType, targetId: Number(targetId),
      reason: util.clampText(reason, 50), detail: util.clampText(detail, 200),
      status: 'pending', createdAt: Date.now()
    });
    return { ok: true };
  });

  /* ---------- 上传（multipart） ---------- */
  route('POST', '/api/upload', () => {
    fail('云开发环境请使用 wx.cloud.uploadFile 上传文件', 400);
  });
};
