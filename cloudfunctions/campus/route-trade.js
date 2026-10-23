'use strict';
/** 交易 API：首页聚合 / 商品列表与详情 / 发布 / 想要 / 订单全流程（下单-支付-发货-收货-退款） */
const db = require('./db');
const util = require('./util');
const deco = require('./deco');
const ws = require('./events');
const it = require('./interactions');
const { ZONES } = require('./const');

function needUser(ctx) {
  if (!ctx.user) { const e = new Error('请先登录'); e.status = 401; throw e; }
  return ctx.user;
}
function fail(message, status) { const e = new Error(message); e.status = status || 400; throw e; }

module.exports = function register(route) {
  /* ---------- 首页聚合 ---------- */
  route('GET', '/api/home', async (ctx) => {
    const me = ctx.user;
    // 直查数据库：首页是「刚发布的商品看不看得到」最容易被感知的地方
    let allListings = null;
    let allPosts = null;
    try {
      const [a, b] = await Promise.all([db.readAllFromDb('listings'), db.readAllFromDb('posts')]);
      allListings = a; allPosts = b;
    } catch (e) { /* 忽略，退回内存 */ }
    if (!allListings || !allListings.length) allListings = db.get('listings');
    if (!allPosts || !allPosts.length) allPosts = db.get('posts');
    // 作者/卖家资料都要以库为准刷一遍：他们可能刚改过头像昵称，
    // 也可能根本不在本实例的内存快照里 —— 不刷的话首页/卡片上就是空白或旧头像。
    await db.warmUsers(allListings.map((l) => l.sellerId).concat(allPosts.map((p) => p.authorId)));
    const on = allListings.filter((l) => l.status === 'on');
    const score = (l) => (l.views || 0) + (l.favoriteCount || 0) * 20 + (l.wantCount || 0) * 10 +
      (Date.now() - l.createdAt < 86400e3 ? 500 : 0);
    const feed = on.slice().sort((a, b) => score(b) - score(a)).slice(0, 14).map((l) => deco.decorateListing(l, me));
    const hotPosts = allPosts.slice()
      .sort((a, b) => ((b.likeBase || 0) + (b.likes || []).length) - ((a.likeBase || 0) + (a.likes || []).length))
      .slice(0, 6).map((p) => deco.decoratePost(p, me));
    // 评论数从 comments 集合重新推导，与详情页保持一致（见 deco.realCommentCounts）
    await deco.realCommentCounts(hotPosts);
    /**
     * 最新公告（首页横幅用，**整条下发含 content** ——
     * 前端点公告是在弹窗里直接显示的，不再为它单独发一次请求）。
     *
     * 直查数据库：公告是管理端在后台发的，可能在别的实例，
     * 只读内存镜像会漏掉新发的公告（用户反馈过「后台发了公告、首页看不到」）。
     */
    let noticeSrc = null;
    try { noticeSrc = await db.readAllFromDb('notices'); } catch (e) { /* 退回内存 */ }
    if (!noticeSrc || !noticeSrc.length) noticeSrc = db.get('notices').slice();
    const notice = noticeSrc.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    return { zones: ZONES, feed, hotPosts, notice };
  });

  route('GET', '/api/search/hot', () => ({
    words: ['考研教材', '山地自行车', '显示器', '学士服', '拼团零食', '游戏账号', '拍立得', '小冰箱']
  }));

  /**
   * 商品列表 / 搜索。
   *
   * ⚠️ 直查数据库 —— 内存镜像是冷启动快照、永不刷新，
   * 读它会看不到其他实例刚发布的商品。前端现象：
   * 「别人刚发布的商品我看不到，过一会又出现了」。
   */
  route('GET', '/api/listings', async (ctx) => {
    const me = ctx.user;
    const q = ctx.query;
    const zone = q.get('zone') || '';
    const kw = (q.get('keyword') || '').trim();
    const sort = q.get('sort') || 'recommend';
    const sellerId = util.num(q.get('sellerId'));
    const status = q.get('status') || 'on';
    let list = null;
    try { list = await db.readAllFromDb('listings'); } catch (e) { /* 忽略，退回内存 */ }
    if (!list || !list.length) list = db.get('listings').slice();
    // 卖家可能是别的实例创建的用户 → 补进内存，否则卖家显示空白
    await db.warmUsers(list.map((l) => l.sellerId));
    if (sellerId) list = list.filter((l) => l.sellerId === sellerId);
    if (status !== 'all') list = list.filter((l) => l.status === status);
    if (zone) list = list.filter((l) => l.zone === zone);
    if (kw) {
      list = list.filter((l) => util.match(l.title, kw) || util.match(l.desc, kw) ||
        (l.tags || []).some((t) => util.match(t, kw)));
    }
    /**
     * 已被「别人」拍下的单件商品不出现在列表/搜索结果里。
     *
     * 之前只在商品详情页做「拍下即锁」，列表照旧展示 —— 用户搜到的商品点进去
     * 才发现「已被拍下」，体验上等于「买不到的东西还一直被别人看到」。
     * 自己拍下的那件保留（否则付不了款）。
     */
    const ACTIVE_ORDER_STATES = ['pending', 'paid', 'shipped', 'refunding'];
    if (!sellerId) {                     // 卖家看「我的发布」时不隐藏，否则自己的商品凭空消失
      try {
        const allOrders = await db.readAllFromDb('orders');
        const lockedByOthers = new Set();
        for (const o of allOrders) {
          if (ACTIVE_ORDER_STATES.indexOf(o.status) === -1) continue;
          // 拍下即下架：谁拍的都隐藏（买家从「我的订单 · 待付款」里付款，不需要再从首页找到商品）
          lockedByOthers.add(o.listingId);
        }
        if (lockedByOthers.size) {
          list = list.filter((l) => {
            // 拼团 / 服务是「一件多人各付各的」，被拍下仍应可下单
            if (l.tradeMode === 'group' || l.tradeMode === 'service') return true;
            return !lockedByOthers.has(l.id);
          });
        }
      } catch (e) { /* 读订单失败就不隐藏，不影响主流程 */ }
    }
    if (sort === 'new') list.sort((a, b) => b.createdAt - a.createdAt);
    else if (sort === 'price_asc') list.sort((a, b) => a.price - b.price);
    else if (sort === 'price_desc') list.sort((a, b) => b.price - a.price);
    else if (sort === 'hot') list.sort((a, b) => (b.views || 0) - (a.views || 0));
    else {
      const score = (l) => (l.views || 0) + (l.favoriteCount || 0) * 20 + (l.wantCount || 0) * 10 +
        (Date.now() - l.createdAt < 86400e3 ? 500 : 0);
      list.sort((a, b) => score(b) - score(a));
    }
    const page = util.paginate(list, q.get('page'), q.get('pageSize'));
    return Object.assign({}, page, { list: page.list.map((l) => deco.decorateListing(l, me)) });
  });

  /* ---------- 商品详情 ---------- */
  route('GET', '/api/listings/:id', async (ctx) => {
    /**
     * ⚠️ 内存 → 数据库兜底，**不能**直接用 db.findById。
     *
     * 商品可能是**别的实例**刚发布的（发布写入实例 A，这次请求路由到实例 B），
     * B 的内存快照里没有 → 直接判「商品不存在」。
     * 前端现象就是：刚发布完立刻点进详情 → 「商品不存在」；
     * 过一会儿（实例间数据都落库了）再看又正常了。
     */
    const found = await db.findByIdWithFallback('listings', ctx.params.id);
    const l = found.doc;
    if (!l) fail('商品不存在', 404);
    const me = ctx.user;
    // 卖家可能由别的实例创建 → 补进内存，否则卖家头像昵称空白
    await db.warmUsers([l.sellerId]);
    // 收藏状态直查一次（deco.isFavorite 同步读内存），否则图标不变色、也点不回来
    if (me) await db.warmFavorites(me.id);
    if (me && l.sellerId !== me.id) {
      db.update('listings', l.id, { views: (l.views || 0) + 1 });
      db.insert('histories', { userId: me.id, listingId: l.id, viewedAt: Date.now() });
    }
    // 相关推荐：先取出原始文档、把卖家补进内存，**再** deco
    // （顺序不能反：deco 里的 sellerBrief 是同步读内存的，补晚了就是 null）
    let relatedRaw = db.find('listings', (x) => x.status === 'on' && x.zone === l.zone && x.id !== l.id)
      .sort((a, b) => b.createdAt - a.createdAt);
    // 相关推荐同样排除「已被拍下」的，避免点进去全是买不到的东西
    try {
      const ACTIVE_R = ['pending', 'paid', 'shipped', 'refunding'];
      const os = await db.readAllFromDb('orders');
      const lockedR = new Set(os.filter((o) => ACTIVE_R.indexOf(o.status) > -1).map((o) => o.listingId));
      if (lockedR.size) relatedRaw = relatedRaw.filter((x) => !lockedR.has(x.id));
    } catch (e) { /* 忽略 */ }
    relatedRaw = relatedRaw.slice(0, 4);
    await db.warmUsers(relatedRaw.map((x) => x.sellerId));
    const related = relatedRaw.map((x) => deco.decorateListing(x, me));
    const isWanted = me ? !!db.one('wants', (w) => w.userId === me.id && w.listingId === l.id) : false;

    // 拍下即锁：单件商品若已被占用，详情页要把「立即购买」换成「已被拍下」，
    // 不能等用户点了才报错（否则体验像"按钮坏了"）。
    let lock = null;
    if (UNIQUE_TRADE_MODES.indexOf(l.tradeMode) > -1) {
      const occupied = await findActiveOrder(l.id);
      if (occupied) {
        lock = {
          orderId: occupied.id,
          status: occupied.status,
          /** 是不是我自己拍下的（那我应该去支付，而不是被挡） */
          mine: !!(me && occupied.buyerId === me.id)
        };
      }
    }
    return { listing: Object.assign(deco.decorateListing(l, me), { isWanted, lock }), related };
  });

  /* ---------- 发布 / 管理 ---------- */
  /**
   * 发布商品（**幂等**）。
   *
   * ⚠️ 必须按 `reqId` 去重，否则「点一次发布出来好几件一模一样的商品」。
   *   前端在进发布页时生成一个 reqId（每次进入一个新值），随请求一起发；
   *   同一个 reqId 再来一次 → 直接返回第一次那条，不再新建。
   *
   *   为什么光靠前端按钮锁不够：
   *     ① 校验/AI 审核有 1–3 秒空窗，连点会同时穿过「还没置 submitting」的检查；
   *     ② 请求已发出但界面还在转圈，用户手动再点一次 —— 前端锁挡不住；
   *     ③ 网络超时后续传/重试，本地看起来「没发成功」，其实云端已经建好了。
   *   所以去重必须落在服务端，而且要看**库**（多实例下内存不可信）。
   */
  route('POST', '/api/listings', async (ctx) => {
    const me = needUser(ctx);
    const b = ctx.body || {};
    if (!util.clampText(b.title, 40)) fail('请填写标题');
    if (!b.zone || !ZONES.some((z) => z.code === b.zone)) fail('请选择正确的交易分区');
    const reqId = String(b.reqId || '').trim();
    if (reqId) {
      const dup = await db.fetchByField('listings', 'reqId', reqId, 10);
      const mine = (dup || []).find((x) => x.sellerId === me.id);
      // deduped 只是给日志/排查用，前端照常按 listing 跳详情
      if (mine) return { listing: deco.decorateListing(mine, me), deduped: true };
    }
    const autoApprove = ((db.load().meta.config || {}).autoApprove !== false);
    const item = db.insert('listings', Object.assign({
      sellerId: me.id, zone: b.zone,
      title: util.clampText(b.title, 40),
      desc: util.clampText(b.desc, 500),
      images: (b.images || []).slice(0, 9),
      price: Math.max(0, Math.round(util.num(b.price))),
      originalPrice: Math.round(util.num(b.originalPrice)) || 0,
      // priceUnit 实际是「数量 + 单位」拼出来的（如「2件」「999天」），
      // 所以不能按「单位文字」去限 4 个字 —— 那样用户填个三位数数量就会被静默截断。
      // 放宽到 12：足够常规使用，又能在展示端兜住异常长的值。
      priceUnit: util.clampText(b.priceUnit, 12) || '件',
      tradeMode: ['sell', 'rent', 'barter', 'group', 'service', 'free'].includes(b.tradeMode) ? b.tradeMode : 'sell',
      status: autoApprove ? 'on' : 'reviewing',
      location: util.clampText(b.location, 30) || '校内',
      tradeMethods: (b.tradeMethods || ['校内面交']).slice(0, 4),
      tags: (b.tags || []).slice(0, 5),
      attrs: b.attrs || {},
      views: 0, favoriteCount: 0, wantCount: 0, createdAt: Date.now()
    }, reqId ? { reqId } : {}));
    return { listing: deco.decorateListing(item, me) };
  });

  route('PATCH', '/api/listings/:id', async (ctx) => {
    const me = needUser(ctx);
    // 与 DELETE 同理：多实例下内存镜像可能没有这条记录，
    // 只用 findById 会把它误判成「不存在 / 无权操作」（改价改图偶发 403）。
    const f = await db.findByIdWithFallback('listings', ctx.params.id);
    const l = f.doc;
    if (!l || (l.sellerId !== me.id && !me.isAdmin)) fail('无权操作', 403);
    const b = ctx.body || {};
    const patch = {};
    for (const k of ['title', 'desc', 'price', 'originalPrice', 'priceUnit', 'tradeMode', 'status', 'location', 'tradeMethods', 'tags', 'attrs', 'images']) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    return { listing: deco.decorateListing(db.update('listings', l.id, patch), me) };
  });

  route('DELETE', '/api/listings/:id', async (ctx) => {
    const me = needUser(ctx);
    /**
     * 必须带数据库兜底：云函数是多实例的，`db.findById` 只查**本实例冷启动时的快照**。
     * 用户刚发布的商品可能落在别的实例里 —— 本实例查不到就判 403「无权操作」，
     * 表现为「删自己的闲置偶尔删不掉，重进一次又能删」。
     * 用 findByIdWithFallback：内存没有就去库里捞（并补进内存）。
     */
    const f = await db.findByIdWithFallback('listings', ctx.params.id);
    const l = f.doc;
    if (!l || (l.sellerId !== me.id && !me.isAdmin)) fail('无权操作', 403);
    // 当场删库：删除不能等请求末尾的 flush（它有 deadline 保护，可能被推迟）
    await db.removeFresh('listings', l.id);
    db.remove('favorites', (x) => x.targetType === 'listing' && x.targetId === l.id);
    return { ok: true };
  });

  route('GET', '/api/my-listings', async (ctx) => {
    const me = needUser(ctx);
    const status = ctx.query.get('status') || 'all';
    // 直查数据库：自己刚发布的商品可能还在别的实例的内存里，
    // 只读内存会出现「我的在售里看不到刚发的那个 / 数量对不上」。
    let all = null;
    try { all = await db.readAllFromDb('listings'); } catch (e) { /* 忽略 */ }
    if (!all || !all.length) all = db.find('listings', () => true);
    let list = all.filter((l) => l.sellerId === me.id);
    if (status !== 'all') list = list.filter((l) => l.status === status);
    list.sort((a, b) => b.createdAt - a.createdAt);
    return { items: list.map((l) => deco.decorateListing(l, me)) };
  });

  /* ---------- 想要 ---------- */
  route('POST', '/api/listings/:id/want', (ctx) => {
    const me = needUser(ctx);
    const l = db.findById('listings', ctx.params.id);
    if (!l) fail('商品不存在', 404);
    const existed = db.one('wants', (w) => w.userId === me.id && w.listingId === l.id);
    if (existed) {
      db.removeById('wants', existed.id);
      db.update('listings', l.id, { wantCount: Math.max(0, (l.wantCount || 1) - 1) });
      return { wanted: false, wantCount: Math.max(0, (l.wantCount || 1) - 1) };
    }
    db.insert('wants', { userId: me.id, listingId: l.id, createdAt: Date.now() });
    const wantCount = (l.wantCount || 0) + 1;
    db.update('listings', l.id, { wantCount });
    if (l.sellerId !== me.id) ws.notifyUser(l.sellerId, '「' + me.nickname + '」对「' + l.title + '」点了想要，去看看？');
    // 互动消息：只在「刚点想要」时提醒卖家（取消想要不提醒）
    it.add({
      toUserId: l.sellerId, actorId: me.id, type: 'listing_want',
      targetId: l.id, title: l.title, image: (l.images || [])[0] || ''
    });
    return { wanted: true, wantCount };
  });

  /* ---------- 订单 ---------- */

  /** 「占用中」的订单状态：存在这些状态的订单 → 该件商品已被拍下 */
  const ACTIVE_ORDER_STATES = ['pending', 'paid', 'shipped', 'refunding'];
  /**
   * 单件类商品：**拍下即锁定**（有人下单后其他人就买不到了）。
   *
   * 拼团（group）可多人参团、服务（service）可多次提供 —— 这两类不锁。
   * 这也与「支付后标记 sold」的既有语义保持一致（那里同样只处理 sell/rent）。
   */
  const UNIQUE_TRADE_MODES = ['sell', 'rent', 'free', 'barter'];

  /**
   * 查某件商品是否已被「未完成订单」占用。
   *
   * 为什么要直查云库：占用它的那笔订单可能是**别的实例**建的，
   * 本实例的内存镜像里未必有 —— 只看内存会漏判，导致「已经被拍下却还能再拍」。
   *
   * @param {number} listingId
   * @param {number} [exceptOrderId] 排除这笔订单（查「除它之外」是否还占用）
   * @returns {Promise<object|null>} 占用中的订单，没有则 null
   */
  async function findActiveOrder(listingId, exceptOrderId) {
    const hit = (o) => ACTIVE_ORDER_STATES.indexOf(o.status) > -1;
    let list = db.find('orders', (o) => o.listingId === listingId && hit(o));
    try {
      const fresh = await db.fetchByField('orders', 'listingId', listingId);
      if (fresh && fresh.length) {
        const map = new Map();
        for (const o of list) map.set(String(o.id), o);
        for (const o of fresh) map.set(String(o.id), o);
        list = Array.from(map.values());
      }
    } catch (e) { /* 直查失败就用内存里的，不阻断主流程 */ }
    const skip = Number(exceptOrderId) || 0;
    return list.filter((o) => hit(o) && o.id !== skip)[0] || null;
  }

  /**
   * 创建订单。两条规则：
   *
   * **① 幂等**：同一买家对同一商品的「待付款」订单只会有一笔。
   * 原因（真实事故）：下单与支付是两次请求（POST /orders → POST /orders/:id/pay），
   * 若「建单成功但支付失败」（超时/网络抖动/余额判断），客户端会允许重试，
   * 而重试时它并不知道上一笔单已经建好了 —— 于是**又建一笔**，
   * 结果就是「同一个商品出现两笔订单，一笔已付、一笔永远卡在待付款」。
   * 客户端已改为建单后记住 orderId，这里是服务端兜底。
   *
   * **② 拍下即锁**（与闲鱼一致）：单件类商品一旦有人拍下，
   * 在**那笔订单被取消/完成之前**，其他人不能再拍。
   * 依据是 order 的状态而不是 listing 的字段 —— 好处是：
   *   · 历史数据自动生效（不需要回填 listing）
   *   · 取消订单/退款后自动释放，不需要额外维护
   */
  route('POST', '/api/orders', async (ctx) => {
    const me = needUser(ctx);
    const b = ctx.body || {};
    const l = db.findById('listings', b.listingId);
    if (!l) fail('商品不存在');
    if (l.sellerId === me.id) fail('不能购买自己的商品');
    if (l.status !== 'on') fail('商品已下架或已售出');
    const qty = Math.max(1, Math.min(99, util.num(b.qty, 1)));
    const amount = l.price * qty;
    const tradeMethod = util.clampText(b.tradeMethod, 20) || (l.tradeMethods || ['校内面交'])[0];
    const remark = util.clampText(b.remark, 100);

    // ① 我自己已有待付款单 → 复用（数量/方式/留言变了就更新，不新建）。
    //    这一步必须排在锁定检查**之前**：否则我自己的待付款单会把我自己挡住。
    const existing = db.find('orders', (o) =>
      o.buyerId === me.id && o.listingId === l.id && o.status === 'pending')[0];
    if (existing) {
      const patch = { tradeMethod, remark };
      if (existing.qty !== qty) {
        patch.qty = qty;
        patch.amount = amount;
        patch.payAmount = amount;
      }
      db.update('orders', existing.id, patch);
      db.saveSoon();
      return { order: deco.decorateOrder(existing, me), reused: true };
    }

    // ② 拍下即锁：单件商品若已被**别人**占用 → 拒绝。
    //    我自己若已有「已付款及之后」的订单，同样不能重复购买，但要给出
    //    **能指引下一步**的提示：原来两种情况共用一句
    //    「该宝贝已被你拍下，暂时无法购买」—— 自己拍下的却被告知"无法购买"，
    //    语义自相矛盾，用户看不懂自己到底买没买（前端据此改成了「已购买」并禁用按钮）。
    if (UNIQUE_TRADE_MODES.indexOf(l.tradeMode) > -1) {
      const occupied = await findActiveOrder(l.id);
      if (occupied) {
        if (occupied.buyerId === me.id) {
          // 走到这里不可能是 pending —— pending 已在上面被幂等复用返回
          fail('你已经拍下过这件商品了，请到「我的订单」里继续付款或查看进度', 409);
        }
        fail('该宝贝已被其他同学拍下' +
          (occupied.status === 'pending' ? '（待付款）' : '') + '，暂时无法购买');
      }
    }

    const o = db.insert('orders', {
      orderNo: util.orderNo(),
      buyerId: me.id, sellerId: l.sellerId, listingId: l.id,
      snapshot: { title: l.title, image: l.images[0], price: l.price, priceUnit: l.priceUnit, zone: l.zone, tradeMode: l.tradeMode },
      qty, amount, payAmount: amount,
      status: 'pending', payType: null,
      tradeMethod, location: l.location, remark,
      timeline: [{ status: 'created', time: Date.now(), note: '订单已创建' }]
    });
    ws.notifyUser(l.sellerId, '你有一笔新订单待处理：「' + l.title + '」', { orderId: o.id, title: l.title, amount });
    return { order: deco.decorateOrder(o, me) };
  });

  route('GET', '/api/orders', async (ctx) => {
    const me = needUser(ctx);
    const role = ctx.query.get('role') || 'buyer';
    const status = ctx.query.get('status') || 'all';
    // 直查数据库：别人刚在你商品下订单（或你在别人那儿刚下单）时，
    // 那笔单可能只在别的实例的内存里 → 只读内存会「订单列表少了一笔」。
    let all = null;
    try { all = await db.readAllFromDb('orders'); } catch (e) { /* 忽略 */ }
    if (!all || !all.length) all = db.find('orders', () => true);
    let list = all.filter((o) => (role === 'seller' ? o.sellerId === me.id : o.buyerId === me.id));
    if (status === 'ongoing') list = list.filter((o) => ['pending', 'paid', 'shipped', 'refunding'].includes(o.status));
    else if (status !== 'all') list = list.filter((o) => o.status === status);
    list.sort((a, b) => b.createdAt - a.createdAt);
    // 对手方可能是别的实例创建的用户 → 补进内存，否则订单卡片上显示空白
    await db.warmUsers(list.flatMap((o) => [o.buyerId, o.sellerId]));
    return { items: list.map((o) => deco.decorateOrder(o, me)) };
  });

  route('GET', '/api/orders/:id', async (ctx) => {
    const me = needUser(ctx);
    /**
     * ⚠️ 内存 → 数据库兜底。
     *
     * 这是「下单后跳转异常」的关键一环：下单写入实例 A，
     * 前端随即跳转订单详情、请求却路由到实例 B —— B 的内存里没有这笔单，
     * 于是返回 404「订单不存在」，前端就跳去别处（看起来像"跳到了别人的页面"）。
     * 与「会话不存在被丢进 AI 会话」是同一个模式，必须走兜底。
     */
    // 详情必须读到「最新状态」：镜像命中也不够。
    // 曾出现「已发货却显示待发货、还能再点发货」——因为本实例镜像停在 paid，
    // 而库里已经是 shipped；把它写回去就把状态冲回去了。
    let o = await db.findByIdFresh('orders', ctx.params.id);
    if (!o) o = (await db.findByIdWithFallback('orders', ctx.params.id)).doc;
    if (!o || (o.buyerId !== me.id && o.sellerId !== me.id)) fail('订单不存在', 404);
    await db.warmUsers([o.buyerId, o.sellerId]);
    return { order: deco.decorateOrder(o, me) };
  });

  /**
   * 支付订单。
   *
   * ⚠️ 两道防护，防止「同一个商品被重复付款」（这才是真正的吞钱场景）：
   *   1) 商品已被买走（status=sold）→ 拒绝
   *   2) 同一商品已存在另一笔「已付款及之后状态」的订单 → 拒绝
   * 因为历史数据里可能存在重复单（例如「建单成功、支付失败后重试」产生的孤儿单），
   * 用户若对那笔孤儿单再点「立即支付」，就会为同一件商品付第二次钱。
   * 这里直查云库（不只是内存镜像）—— 另一笔单可能是**别的实例**建的，
   * 本实例内存里未必有。
   */
  route('POST', '/api/orders/:id/pay', async (ctx) => {
    const me = needUser(ctx);
    // 写操作必须拿最新版本：镜像可能停在 pending，而库里已经被别的实例改成 paid/shipped
    const o = await db.findByIdFresh('orders', ctx.params.id);
    if (!o || o.buyerId !== me.id) fail('订单不存在', 404);
    if (o.status !== 'pending') fail('订单状态不允许支付');

    // --- 重复支付防护 ---
    //
    // ⚠️ 只对**单件类**商品生效（sell / rent / free / barter）。
    //
    // 拼团、服务是「一件商品、多人各付各的」：每个参与者都有自己的订单，
    // 「别人已经付过款」是**正常状态**，不是重复支付。
    // 曾经不分模式一律拦，结果把拼团锁死：B、C 参团各一笔单，C 先付成功后
    // B 再付就被拒 → 团永远停在「还差 1 人成团」（smoke2 的「满员自动成团」抓到的就是这个）。
    const PAID_STATES = ['paid', 'shipped', 'done', 'refunding'];
    // 商品状态也直查最新：镜像里可能还写着 on，而库里已经 sold（别人刚付完）
    const l0 = await db.findByIdFresh('listings', o.listingId);
    if (l0 && l0.status === 'sold') {
      fail('该商品已被购买，这笔订单不能再次支付（请直接取消订单）');
    }
    // 商品记录缺失时按「单件类」从严处理（保持原有防护，不因数据缺失而放松）。
    const isUnique = !l0 || UNIQUE_TRADE_MODES.indexOf(l0.tradeMode) > -1;
    if (isUnique) {
      let peers = db.find('orders', (x) => x.listingId === o.listingId && x.id !== o.id);
      try {
        const fresh = await db.fetchByField('orders', 'listingId', o.listingId);
        if (fresh && fresh.length) {
          const map = new Map();
          for (const x of peers) map.set(String(x.id), x);
          for (const x of fresh) if (x.id !== o.id) map.set(String(x.id), x);
          peers = Array.from(map.values());
        }
      } catch (e) { /* 直查失败就用内存里的，不阻断支付 */ }
      const paidPeer = peers.find((x) => PAID_STATES.indexOf(x.status) > -1);
      if (paidPeer) {
        fail('这件商品你已经付过款了（订单 ' + paidPeer.orderNo + '），这笔订单请直接取消');
      }
    }

    const method = (ctx.body || {}).method || 'balance';
    if (!['balance', 'wxpay'].includes(method)) fail('不支持的支付方式');
    if (method === 'balance' && (me.balance || 0) < o.payAmount) {
      fail('余额不足，请先到「我的钱包」充值');
    }

    /**
     * ⚠️ 防「付两次」的最后一道闸：抢占商品。
     *
     * 上面的状态检查都是「先读后写」，两个请求（双击 / 弱网重试）可能同时读到 pending，
     * 于是都往下走、各扣一次钱。用户的反馈正是「有时会付两次」。
     * 这里把「商品 on → sold」当成一次原子占位：只有改成功的那次能继续付款，
     * 第二次请求必然看到 sold 而提前退出。
     */
    if (isUnique && l0) {
      const claim = await db.updateFresh('listings', l0.id, { status: 'sold' });
      if (!claim) fail('下单失败，请重试');
    }
    // 再确认订单仍是 pending：并发时先到的那次已经把它改成 paid
    const recheck = await db.findByIdFresh('orders', o.id);
    if (!recheck || recheck.status !== 'pending') {
      if (isUnique && l0) { try { await db.updateFresh('listings', l0.id, { status: 'on' }); } catch (e) { /* 忽略 */ } }
      fail('这笔订单已经付过款了，请刷新查看');
    }

    if (method === 'balance') {
      const balance = me.balance - o.payAmount;
      db.update('users', me.id, { balance });
      db.insert('transactions', { userId: me.id, type: 'pay', amount: -o.payAmount, note: '购买「' + o.snapshot.title + '」', balanceAfter: balance, orderId: o.id });
    } else {
      db.insert('transactions', { userId: me.id, type: 'pay_wx', amount: -o.payAmount, note: '微信支付（演示）「' + o.snapshot.title + '」', balanceAfter: me.balance || 0, orderId: o.id });
    }
    o.payType = method;
    o.status = 'paid';
    o.timeline.push({ status: 'paid', time: Date.now(), note: (method === 'balance' ? '余额支付' : '微信支付（演示）') + ' ¥' + util.yuan(o.payAmount) });
    // 平台担保：登记资金托管流水
    db.insert('escrows', {
      orderId: o.id, type: 'hold', userId: me.id,
      amount: o.payAmount, method,
      status: 'holding', createdAt: Date.now()
    });

    const l = db.findById('listings', o.listingId);
    if (l && l.tradeMode === 'group') {
      // 拼团：标记参团已付款，并尝试自动成团（满员即成功）
      try { require('./group').onOrderPaid(o, me); } catch (e) { /* 不影响主流程 */ }
    }
    // 单件类商品在上面的「抢占」里已经置为 sold，这里不再重复写
    // 只落「订单状态相关字段」，避免把整份过期镜像写回去把别人的改动冲掉
    await db.updateFresh('orders', o.id, {
      status: o.status, payType: o.payType, timeline: o.timeline
    });
    ws.notifyUser(o.sellerId, '买家已付款：「' + o.snapshot.title + '」等待你发货 / 面交', { orderId: o.id, title: o.snapshot.title, amount: o.payAmount });
    ws.notifyUser(me.id, '支付成功：「' + o.snapshot.title + '」，等待卖家发货。', { orderId: o.id, title: o.snapshot.title, amount: o.payAmount });
    return { order: deco.decorateOrder(o, me) };
  });

  /**
   * 发货。⚠️ 幂等：只允许 paid → shipped 一次。
   * 之前用镜像读状态，别的实例已发货时本地仍是 paid → 可以无限次发货，
   * 且每次把 shipped 覆盖回 shipped（时间线越堆越长）。必须直查最新状态。
   */
  route('POST', '/api/orders/:id/ship', async (ctx) => {
    const me = needUser(ctx);
    const o = await db.findByIdFresh('orders', ctx.params.id);
    if (!o || o.sellerId !== me.id) fail('订单不存在', 404);
    if (o.status !== 'paid') fail(o.status === 'shipped' ? '这笔订单已经发过货了' : '订单状态不允许发货');
    const timeline = (o.timeline || []).concat([{
      status: 'shipped', time: Date.now(),
      note: util.clampText((ctx.body || {}).note, 60) || '卖家已发货 / 完成交付'
    }]);
    const saved = await db.updateFresh('orders', o.id, { status: 'shipped', timeline });
    if (!saved) fail('发货失败，请重试');
    ws.notifyUser(o.buyerId, '卖家已发货：「' + o.snapshot.title + '」，请及时确认收货', { orderId: o.id, title: o.snapshot.title, amount: o.payAmount });
    return { order: deco.decorateOrder(saved, me) };
  });

  route('POST', '/api/orders/:id/confirm', async (ctx) => {
    const me = needUser(ctx);
    const o = await db.findByIdFresh('orders', ctx.params.id);
    if (!o || o.buyerId !== me.id) fail('订单不存在', 404);
    if (o.status !== 'shipped') fail('订单状态不允许确认');
    const timeline = (o.timeline || []).concat([{ status: 'done', time: Date.now(), note: '买家已确认收货' }]);
    const seller = db.findById('users', o.sellerId);
    if (seller) {
      const balance = (seller.balance || 0) + o.payAmount;
      db.update('users', seller.id, { balance });
      db.insert('transactions', { userId: seller.id, type: 'income', amount: o.payAmount, note: '卖出「' + o.snapshot.title + '」', balanceAfter: balance, orderId: o.id });
      // 平台担保：放款给卖家
      db.insert('escrows', { orderId: o.id, type: 'release', userId: o.sellerId, amount: o.payAmount, status: 'released', createdAt: Date.now() });
    }
    const saved = await db.updateFresh('orders', o.id, { status: 'done', timeline });
    if (!saved) fail('确认收货失败，请重试');
    ws.notifyUser(o.sellerId, '买家已确认收货，订单完成：「' + o.snapshot.title + '」，货款已入账', { orderId: o.id, title: o.snapshot.title, amount: o.payAmount });
    return { order: deco.decorateOrder(saved, me) };
  });

  route('POST', '/api/orders/:id/cancel', async (ctx) => {
    const me = needUser(ctx);
    const o = await db.findByIdFresh('orders', ctx.params.id);
    if (!o || (o.buyerId !== me.id && o.sellerId !== me.id)) fail('订单不存在', 404);
    if (o.status !== 'pending') fail('已付款订单请走退款流程');
    const timeline = (o.timeline || []).concat([{ status: 'canceled', time: Date.now(), note: (o.buyerId === me.id ? '买家' : '卖家') + '取消订单' }]);
    const saved = await db.updateFresh('orders', o.id, { status: 'canceled', timeline });
    if (!saved) fail('取消失败，请重试');
    const other = o.buyerId === me.id ? o.sellerId : o.buyerId;
    ws.notifyUser(other, '订单已取消：「' + o.snapshot.title + '」', { orderId: o.id, title: o.snapshot.title, amount: o.payAmount });
    return { order: deco.decorateOrder(saved, me) };
  });

  route('POST', '/api/orders/:id/refund', async (ctx) => {
    const me = needUser(ctx);
    const o = await db.findByIdFresh('orders', ctx.params.id);
    if (!o || o.buyerId !== me.id) fail('订单不存在', 404);
    if (!['paid', 'shipped'].includes(o.status)) fail('当前状态不支持退款');
    const refundReason = util.clampText((ctx.body || {}).reason, 100) || '买家申请退款';
    const timeline = (o.timeline || []).concat([{ status: 'refunding', time: Date.now(), note: '买家申请退款：' + refundReason }]);
    const saved = await db.updateFresh('orders', o.id, { status: 'refunding', refundReason, timeline });
    if (!saved) fail('提交失败，请重试');
    ws.notifyUser(o.sellerId, '买家申请退款：「' + o.snapshot.title + '」，请尽快处理', { orderId: o.id, title: o.snapshot.title, amount: o.payAmount });
    return { order: deco.decorateOrder(saved, me) };
  });

  route('POST', '/api/orders/:id/refund/decide', async (ctx) => {
    const me = needUser(ctx);
    const o = await db.findByIdFresh('orders', ctx.params.id);
    if (!o || o.sellerId !== me.id) fail('订单不存在', 404);
    if (o.status !== 'refunding') fail('订单不在退款流程中');
    const approve = !!(ctx.body || {}).approve;
    const nextStatus = approve ? 'refunded' : 'paid';
    const timeline = (o.timeline || []).concat([{
      status: nextStatus, time: Date.now(),
      note: approve ? '卖家同意退款' : ('卖家拒绝退款：' + (util.clampText((ctx.body || {}).note, 60) || '商品无问题'))
    }]);
    if (approve) {
      if (o.payType === 'balance') {
        const buyer = db.findById('users', o.buyerId);
        if (buyer) {
          const balance = (buyer.balance || 0) + o.payAmount;
          db.update('users', buyer.id, { balance });
          db.insert('transactions', { userId: buyer.id, type: 'refund', amount: o.payAmount, note: '退款「' + o.snapshot.title + '」', balanceAfter: balance, orderId: o.id });
        }
      } else {
        db.insert('transactions', { userId: o.buyerId, type: 'refund_wx', amount: o.payAmount, note: '微信退款（演示）「' + o.snapshot.title + '」', balanceAfter: 0, orderId: o.id });
      }
      const l = db.findById('listings', o.listingId);
      if (l && l.status === 'sold') db.update('listings', l.id, { status: 'on' });
      // 平台担保：退款流水
      db.insert('escrows', { orderId: o.id, type: 'refund', userId: o.buyerId, amount: o.payAmount, status: 'refunded', createdAt: Date.now() });
    }
    const saved = await db.updateFresh('orders', o.id, { status: nextStatus, timeline });
    if (!saved) fail('处理失败，请重试');
    ws.notifyUser(o.buyerId, approve ? ('退款成功：「' + o.snapshot.title + '」款项已原路退回') : ('卖家拒绝了退款申请：「' + o.snapshot.title + '」，如有争议可联系客服'), { orderId: o.id, title: o.snapshot.title, amount: o.payAmount });
    return { order: deco.decorateOrder(saved, me) };
  });
};
