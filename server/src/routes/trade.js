'use strict';
/** 交易 API：首页聚合 / 商品列表与详情 / 发布 / 想要 / 订单全流程（下单-支付-发货-收货-退款） */
const db = require('../db');
const util = require('../util');
const deco = require('../deco');
const ws = require('../ws');
const it = require('../interactions');
const { ZONES } = require('../const');

function needUser(ctx) {
  if (!ctx.user) { const e = new Error('请先登录'); e.status = 401; throw e; }
  return ctx.user;
}
function fail(message, status) { const e = new Error(message); e.status = status || 400; throw e; }

module.exports = function register(route) {
  /* ---------- 首页聚合 ---------- */
  route('GET', '/api/home', async (ctx) => {
    const me = ctx.user;
    const on = db.find('listings', (l) => l.status === 'on');
    const score = (l) => (l.views || 0) + (l.favoriteCount || 0) * 20 + (l.wantCount || 0) * 10 +
      (Date.now() - l.createdAt < 86400e3 ? 500 : 0);
    const feed = on.slice().sort((a, b) => score(b) - score(a)).slice(0, 14).map((l) => deco.decorateListing(l, me));
    const hotPosts = db.get('posts').slice()
      .sort((a, b) => ((b.likeBase || 0) + (b.likes || []).length) - ((a.likeBase || 0) + (a.likes || []).length))
      .slice(0, 6).map((p) => deco.decoratePost(p, me));
    // 评论数从 comments 重新推导，与详情页一致（见 deco.realCommentCounts）
    await deco.realCommentCounts(hotPosts);
    // 最新公告（首页横幅用，整条下发含 content —— 前端点公告是在弹窗里直接显示）
    const notice = db.get('notices').slice().sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    return { zones: ZONES, feed, hotPosts, notice };
  });

  route('GET', '/api/search/hot', () => ({
    words: ['考研教材', '山地自行车', '显示器', '学士服', '拼团零食', '游戏账号', '拍立得', '小冰箱']
  }));

  /* ---------- 商品列表 / 搜索 ---------- */
  route('GET', '/api/listings', (ctx) => {
    const me = ctx.user;
    const q = ctx.query;
    const zone = q.get('zone') || '';
    const kw = (q.get('keyword') || '').trim();
    const sort = q.get('sort') || 'recommend';
    const sellerId = util.num(q.get('sellerId'));
    const status = q.get('status') || 'on';
    let list = db.get('listings').slice();
    if (sellerId) list = list.filter((l) => l.sellerId === sellerId);
    if (status !== 'all') list = list.filter((l) => l.status === status);
    if (zone) list = list.filter((l) => l.zone === zone);
    if (kw) {
      list = list.filter((l) => util.match(l.title, kw) || util.match(l.desc, kw) ||
        (l.tags || []).some((t) => util.match(t, kw)));
    }
    // 已被别人拍下的单件商品不在列表/搜索里露出（拼团、服务除外；卖家看自己的不隐藏）
    if (!sellerId) {
      const ACTIVE = ['pending', 'paid', 'shipped', 'refunding'];
      const locked = new Set();
      for (const o of db.find('orders', (x) => ACTIVE.indexOf(x.status) > -1)) {
        // 拍下即下架：谁拍的都隐藏
        locked.add(o.listingId);
      }
      if (locked.size) {
        list = list.filter((l) => (l.tradeMode === 'group' || l.tradeMode === 'service') ? true : !locked.has(l.id));
      }
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
    // 被拍下（含未付款）的商品打上 picked，供「卖家主页 / 我的发布」显示「已卖出」
    const ACTIVE_P = ['pending', 'paid', 'shipped', 'refunding'];
    const pickedIds = new Set(db.find('orders', (o) => ACTIVE_P.indexOf(o.status) > -1).map((o) => o.listingId));
    return Object.assign({}, page, {
      list: page.list.map((l) => Object.assign(deco.decorateListing(l, me), {
        picked: pickedIds.has(l.id) && l.status !== 'sold'
      }))
    });
  });

  /* ---------- 商品详情 ---------- */
  route('GET', '/api/listings/:id', (ctx) => {
    const l = db.findById('listings', ctx.params.id);
    if (!l) fail('商品不存在', 404);
    const me = ctx.user;
    if (me && l.sellerId !== me.id) {
      db.update('listings', l.id, { views: (l.views || 0) + 1 });
      db.insert('histories', { userId: me.id, listingId: l.id, viewedAt: Date.now() });
    }
    const related = db.find('listings', (x) => x.status === 'on' && x.zone === l.zone && x.id !== l.id)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 4)
      .map((x) => deco.decorateListing(x, me));
    const isWanted = me ? !!db.one('wants', (w) => w.userId === me.id && w.listingId === l.id) : false;

    // 拍下即锁：单件商品若已被占用，详情页要把「立即购买」换成「已被拍下」
    let lock = null;
    if (UNIQUE_TRADE_MODES.indexOf(l.tradeMode) > -1) {
      const occupied = findActiveOrder(l.id);
      if (occupied) {
        lock = {
          orderId: occupied.id,
          status: occupied.status,
          /** 是不是我自己拍下的（那我应该去支付，而不是被挡） */
          mine: !!(me && occupied.buyerId === me.id)
        };
      }
    }
    // 展示层自愈：sold 但没有进行中订单 → 视为在售（退款/取消后未回滚）
    if (l.status === 'sold' && !lock) { try { l.status = 'on'; db.update('listings', l.id, { status: 'on' }); db.saveSoon(); } catch (e) {} }
    return { listing: Object.assign(deco.decorateListing(l, me), { isWanted, lock }), related };
  });

  /* ---------- 发布 / 管理 ---------- */
  /**
   * 发布商品（**幂等**）：同一 reqId 只建一条，重复提交返回第一次那条。
   * 详见云端 route-trade.js 的注释 —— 两侧必须同构。
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
      // 与云端一致：12 字（「数量+单位」拼接后可能更长，别静默截断）
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

  route('GET', '/api/my-listings', (ctx) => {
    const me = needUser(ctx);
    const status = ctx.query.get('status') || 'all';
    let list = db.find('listings', (l) => l.sellerId === me.id);
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
   * 拼团可多人参团、服务可多次提供 —— 这两类不锁。
   */
  const UNIQUE_TRADE_MODES = ['sell', 'rent', 'free', 'barter'];

  /**
   * 查某件商品是否已被「未完成订单」占用。
   * 本机服务是单进程（内存即真相），所以不需要像云函数那样直查云库。
   *
   * @param {number} listingId
   * @param {number} [exceptOrderId] 排除这笔订单
   * @returns {object|null}
   */
  function findActiveOrder(listingId, exceptOrderId) {
    const skip = Number(exceptOrderId) || 0;
    return db.find('orders', (o) =>
      o.listingId === listingId &&
      ACTIVE_ORDER_STATES.indexOf(o.status) > -1 &&
      o.id !== skip)[0] || null;
  }

  /**
   * 创建订单。两条规则：
   *
   * **① 幂等**：同一买家对同一商品的「待付款」订单只会有一笔。
   * 原因（真实事故）：下单与支付是两次请求，若「建单成功但支付失败」，
   * 客户端会允许重试，而重试时并不知道上一笔单已建好 → 又建一笔，
   * 结果同一商品出现两笔订单（一笔已付、一笔永远待付款）。
   *
   * **② 拍下即锁**（与闲鱼一致）：单件商品一旦有人拍下，
   * 在**那笔订单被取消/完成之前**，其他人不能再拍。
   * 依据订单状态而非 listing 字段 —— 历史数据自动生效，取消时自动释放。
   */
  route('POST', '/api/orders', (ctx) => {
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

    // ① 我自己已有待付款单 → 复用。必须排在锁定检查之前，
    //    否则我自己的待付款单会把我自己挡住。
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
      const occupied = findActiveOrder(l.id);
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

  route('GET', '/api/orders', (ctx) => {
    const me = needUser(ctx);
    const role = ctx.query.get('role') || 'buyer';
    const status = ctx.query.get('status') || 'all';
    let list = db.find('orders', (o) => (role === 'seller' ? o.sellerId === me.id : o.buyerId === me.id));
    if (status === 'ongoing') list = list.filter((o) => ['pending', 'paid', 'shipped', 'refunding'].includes(o.status));
    else if (status !== 'all') list = list.filter((o) => o.status === status);
    list.sort((a, b) => b.createdAt - a.createdAt);
    return { items: list.map((o) => deco.decorateOrder(o, me)) };
  });

  route('GET', '/api/orders/:id', async (ctx) => {
    const me = needUser(ctx);
    // 详情必须读最新状态：镜像命中也可能是旧值（已发货显示待发货、还能再发货）
    const o = (await db.findByIdFresh('orders', ctx.params.id))
      || (await db.findByIdWithFallback('orders', ctx.params.id)).doc;
    if (!o || (o.buyerId !== me.id && o.sellerId !== me.id)) fail('订单不存在', 404);
    return { order: deco.decorateOrder(o, me) };
  });

  /**
   * 支付订单。
   *
   * ⚠️ 两道防护，防止「同一商品被重复付款」（真正的吞钱场景）：
   *   1) 商品已被买走（status=sold）→ 拒绝
   *   2) 同一商品已存在另一笔「已付款及之后状态」的订单 → 拒绝
   * 历史数据里可能存在重复单（「建单成功、支付失败后重试」产生的孤儿单），
   * 用户若对那笔孤儿单再点「立即支付」，就会为同一件商品付第二次钱。
   *
   * 注：本机服务是**单进程**，内存即真相，所以不像云函数那样需要直查库；
   *     云函数版（cloudfunctions/campus/route-trade.js）同处还有 fetchByField 兜底。
   */
  route('POST', '/api/orders/:id/pay', async (ctx) => {
    const me = needUser(ctx);
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
    const l0 = await db.findByIdFresh('listings', o.listingId);
    if (l0 && l0.status === 'sold') {
      fail('该商品已被购买，这笔订单不能再次支付（请直接取消订单）');
    }
    // 商品记录缺失时按「单件类」从严处理（保持原有防护，不因数据缺失而放松）。
    const isUnique = !l0 || UNIQUE_TRADE_MODES.indexOf(l0.tradeMode) > -1;
    if (isUnique) {
      const paidPeer = db.find('orders', (x) =>
        x.listingId === o.listingId && x.id !== o.id && PAID_STATES.indexOf(x.status) > -1)[0];
      if (paidPeer) {
        fail('这件商品已经付过款了（订单 ' + paidPeer.orderNo + '），这笔订单请直接取消');
      }
    }

    const method = (ctx.body || {}).method || 'balance';
    if (!['balance', 'wxpay'].includes(method)) fail('不支持的支付方式');
    if (method === 'balance' && (me.balance || 0) < o.payAmount) {
      fail('余额不足，请先到「我的钱包」充值');
    }

    // 防「付两次」：把「商品 on → sold」当成原子占位，只有改成功的那次能继续扣款
    if (isUnique && l0) {
      const claim = await db.updateFresh('listings', l0.id, { status: 'sold' });
      if (!claim) fail('下单失败，请重试');
    }
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
      try { require('../group').onOrderPaid(o, me); } catch (e) { /* 不影响主流程 */ }
    }
    // 单件类商品已在「抢占」中置为 sold，这里不再重复写
    const __opatch = { status: o.status, timeline: o.timeline };
    if (o.payType !== undefined) __opatch.payType = o.payType;
    if (o.refundReason !== undefined) __opatch.refundReason = o.refundReason;
    await db.updateFresh('orders', o.id, __opatch);
    ws.notifyUser(o.sellerId, '买家已付款：「' + o.snapshot.title + '」等待你发货 / 面交', { orderId: o.id, title: o.snapshot.title, amount: o.payAmount });
    ws.notifyUser(me.id, '支付成功：「' + o.snapshot.title + '」，等待卖家发货。', { orderId: o.id, title: o.snapshot.title, amount: o.payAmount });
    return { order: deco.decorateOrder(o, me) };
  });

  route('POST', '/api/orders/:id/ship', async (ctx) => {
    const me = needUser(ctx);
    const o = await db.findByIdFresh('orders', ctx.params.id);
    if (!o || o.sellerId !== me.id) fail('订单不存在', 404);
    if (o.status !== 'paid') fail('订单状态不允许发货');
    o.status = 'shipped';
    o.timeline.push({ status: 'shipped', time: Date.now(), note: util.clampText((ctx.body || {}).note, 60) || '卖家已发货 / 完成交付' });
    const __opatch = { status: o.status, timeline: o.timeline };
    if (o.payType !== undefined) __opatch.payType = o.payType;
    if (o.refundReason !== undefined) __opatch.refundReason = o.refundReason;
    await db.updateFresh('orders', o.id, __opatch);
    ws.notifyUser(o.buyerId, '卖家已发货：「' + o.snapshot.title + '」，请及时确认收货', { orderId: o.id, title: o.snapshot.title, amount: o.payAmount });
    return { order: deco.decorateOrder(o, me) };
  });

  route('POST', '/api/orders/:id/confirm', async (ctx) => {
    const me = needUser(ctx);
    const o = await db.findByIdFresh('orders', ctx.params.id);
    if (!o || o.buyerId !== me.id) fail('订单不存在', 404);
    if (o.status !== 'shipped') fail('订单状态不允许确认');
    o.status = 'done';
    o.timeline.push({ status: 'done', time: Date.now(), note: '买家已确认收货' });
    const seller = db.findById('users', o.sellerId);
    if (seller) {
      const balance = (seller.balance || 0) + o.payAmount;
      db.update('users', seller.id, { balance });
      db.insert('transactions', { userId: seller.id, type: 'income', amount: o.payAmount, note: '卖出「' + o.snapshot.title + '」', balanceAfter: balance, orderId: o.id });
      // 平台担保：放款给卖家
      db.insert('escrows', { orderId: o.id, type: 'release', userId: o.sellerId, amount: o.payAmount, status: 'released', createdAt: Date.now() });
    }
    const __opatch = { status: o.status, timeline: o.timeline };
    if (o.payType !== undefined) __opatch.payType = o.payType;
    if (o.refundReason !== undefined) __opatch.refundReason = o.refundReason;
    await db.updateFresh('orders', o.id, __opatch);
    ws.notifyUser(o.sellerId, '买家已确认收货，订单完成：「' + o.snapshot.title + '」，货款已入账', { orderId: o.id, title: o.snapshot.title, amount: o.payAmount });
    return { order: deco.decorateOrder(o, me) };
  });

  route('POST', '/api/orders/:id/cancel', async (ctx) => {
    const me = needUser(ctx);
    const o = await db.findByIdFresh('orders', ctx.params.id);
    if (!o || (o.buyerId !== me.id && o.sellerId !== me.id)) fail('订单不存在', 404);
    if (o.status !== 'pending') fail('已付款订单请走退款流程');
    o.status = 'canceled';
    o.timeline.push({ status: 'canceled', time: Date.now(), note: (o.buyerId === me.id ? '买家' : '卖家') + '取消订单' });
    const __opatch = { status: o.status, timeline: o.timeline };
    if (o.payType !== undefined) __opatch.payType = o.payType;
    if (o.refundReason !== undefined) __opatch.refundReason = o.refundReason;
    await db.updateFresh('orders', o.id, __opatch);
    const other = o.buyerId === me.id ? o.sellerId : o.buyerId;
    ws.notifyUser(other, '订单已取消：「' + o.snapshot.title + '」', { orderId: o.id, title: o.snapshot.title, amount: o.payAmount });
    return { order: deco.decorateOrder(o, me) };
  });

  route('POST', '/api/orders/:id/refund', async (ctx) => {
    const me = needUser(ctx);
    const o = await db.findByIdFresh('orders', ctx.params.id);
    if (!o || o.buyerId !== me.id) fail('订单不存在', 404);
    if (!['paid', 'shipped'].includes(o.status)) fail('当前状态不支持退款');
    o.status = 'refunding';
    o.refundReason = util.clampText((ctx.body || {}).reason, 100) || '买家申请退款';
    o.timeline.push({ status: 'refunding', time: Date.now(), note: '买家申请退款：' + o.refundReason });
    const __opatch = { status: o.status, timeline: o.timeline };
    if (o.payType !== undefined) __opatch.payType = o.payType;
    if (o.refundReason !== undefined) __opatch.refundReason = o.refundReason;
    await db.updateFresh('orders', o.id, __opatch);
    ws.notifyUser(o.sellerId, '买家申请退款：「' + o.snapshot.title + '」，请尽快处理', { orderId: o.id, title: o.snapshot.title, amount: o.payAmount });
    return { order: deco.decorateOrder(o, me) };
  });

  route('POST', '/api/orders/:id/refund/decide', async (ctx) => {
    const me = needUser(ctx);
    const o = await db.findByIdFresh('orders', ctx.params.id);
    if (!o || o.sellerId !== me.id) fail('订单不存在', 404);
    if (o.status !== 'refunding') fail('订单不在退款流程中');
    const approve = !!(ctx.body || {}).approve;
    if (approve) {
      o.status = 'refunded';
      o.timeline.push({ status: 'refunded', time: Date.now(), note: '卖家同意退款' });
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
    } else {
      o.status = 'paid';
      o.timeline.push({ status: 'paid', time: Date.now(), note: '卖家拒绝退款：' + (util.clampText((ctx.body || {}).note, 60) || '商品无问题') });
    }
    const __opatch = { status: o.status, timeline: o.timeline };
    if (o.payType !== undefined) __opatch.payType = o.payType;
    if (o.refundReason !== undefined) __opatch.refundReason = o.refundReason;
    await db.updateFresh('orders', o.id, __opatch);
    ws.notifyUser(o.buyerId, approve ? ('退款成功：「' + o.snapshot.title + '」款项已原路退回') : ('卖家拒绝了退款申请：「' + o.snapshot.title + '」，如有争议可联系客服'), { orderId: o.id, title: o.snapshot.title, amount: o.payAmount });
    return { order: deco.decorateOrder(o, me) };
  });
};
