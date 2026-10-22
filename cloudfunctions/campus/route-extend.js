'use strict';
/**
 * 扩展功能 API
 *  1) 拼团（自动匹配成团）
 *  2) 校园墙（匿名表白墙 / 万能墙）
 *  3) 学习资源共享（上传 / 下载 / 收藏）
 *  4) AI 智能推荐（个性化首页）
 *  5) 二手交易担保（资金托管明细 + 平台介入）
 */
const db = require('./db');
const util = require('./util');
const deco = require('./deco');
const ws = require('./events');
const group = require('./group');
const it = require('./interactions');

function needUser(ctx) {
  if (!ctx.user) { const e = new Error('请先登录'); e.status = 401; throw e; }
  return ctx.user;
}
function fail(message, status) { const e = new Error(message); e.status = status || 400; throw e; }

/* ---------------- 通用 ---------------- */
function leftText(ts) {
  if (!ts) return '';
  const d = ts - Date.now();
  if (d <= 0) return '已结束';
  const m = Math.floor(d / 60000);
  if (m < 60) return m + ' 分钟后结束';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时后结束';
  const day = Math.floor(h / 24);
  if (day <= 30) return day + ' 天后结束';
  const dt = new Date(ts);
  return (dt.getMonth() + 1) + '月' + dt.getDate() + '日结束';
}

/** 稳定匿名昵称（同一用户在同一目标下昵称固定，但无法反推真实身份） */
const ANON_ADJ = ['路过的', '安静的', '勇敢的', '爱笑的', '温柔的', '神秘的', '热心的', '低调的', '认真的', '爱吃的'];
const ANON_NOUN = ['小橘子', '胖头鱼', '银河系', '小行星', '蒲公英', '向日葵', '布丁', '气泡水', '猫咪', '柴犬'];
function anonName(userId, salt) {
  const seed = (Number(userId) * 7919 + Number(salt || 0) * 104729) % 100000;
  const a = ANON_ADJ[seed % ANON_ADJ.length];
  const n = ANON_NOUN[Math.floor(seed / 7) % ANON_NOUN.length];
  const no = (seed % 9000) + 1000;
  return a + n + '#' + no;
}

/** 只在服务端使用的字段，不返回给前端 */
function stripAnon(w) {
  const out = Object.assign({}, w);
  delete out.authorId;
  return out;
}

function decoWall(w, me) {
  const out = stripAnon(w);
  out.likeCount = (w.likeBase || 0) + (w.likes ? w.likes.length : 0);
  out.liked = me ? (w.likes || []).indexOf(me.id) !== -1 : false;
  out.isMine = me ? w.authorId === me.id : false;
  out.timeText = util.relTime(w.createdAt);
  out.images = w.images || [];
  return out;
}

function decoResource(r, me) {
  const u = db.findById('users', r.uploaderId);
  const out = Object.assign({}, r);
  out.uploader = u ? { id: u.id, nickname: u.nickname, avatar: u.avatar, college: u.college, cert: u.cert } : null;
  out.likeCount = (r.likeBase || 0) + (r.likes ? r.likes.length : 0);
  out.liked = me ? (r.likes || []).indexOf(me.id) !== -1 : false;
  out.isMine = me ? r.uploaderId === me.id : false;
  out.timeText = util.relTime(r.createdAt);
  out.sizeText = r.fileSize ? (r.fileSize > 1024 * 1024
    ? (r.fileSize / 1024 / 1024).toFixed(1) + ' MB'
    : Math.max(1, Math.round(r.fileSize / 1024)) + ' KB') : '';
  out.typeText = r.fileExt ? String(r.fileExt).replace('.', '').toUpperCase() : 'FILE';
  return out;
}

const RES_CATEGORIES = [
  { code: 'course', name: '课件讲义', color: '#2AA9E0' },
  { code: 'exam', name: '考试真题', color: '#EF5350' },
  { code: 'note', name: '学霸笔记', color: '#22B573' },
  { code: 'book', name: '电子书', color: '#7A5AF8' },
  { code: 'code', name: '代码项目', color: '#FFA726' },
  { code: 'other', name: '其他资料', color: '#8D9AA8' }
];

/* ---------------- AI 推荐引擎 ---------------- */
/**
 * 基于用户行为的轻量推荐：
 *   浏览(1) / 收藏(3) / 想要(4) / 成交(6) 累加分区与标签权重，再叠加价格偏好与热度
 */
function buildProfile(user) {
  const zoneScore = {};
  const tagScore = {};
  const prices = [];
  if (!user) return { zoneScore, tagScore, prices, cold: true };

  const bump = (l, w) => {
    if (!l) return;
    zoneScore[l.zone] = (zoneScore[l.zone] || 0) + w;
    for (const t of (l.tags || [])) tagScore[t] = (tagScore[t] || 0) + w;
    if (l.price) prices.push(l.price);
  };

  for (const h of db.find('histories', (x) => x.userId === user.id)) bump(db.findById('listings', h.listingId), 1);
  for (const f of db.find('favorites', (x) => x.userId === user.id && x.targetType === 'listing')) bump(db.findById('listings', f.targetId), 3);
  for (const w of db.find('wants', (x) => x.userId === user.id)) bump(db.findById('listings', w.listingId), 4);
  for (const o of db.find('orders', (x) => x.buyerId === user.id)) bump(db.findById('listings', o.listingId), 6);

  const cold = !prices.length && !Object.keys(zoneScore).length;
  prices.sort((a, b) => a - b);
  const medianPrice = prices.length ? prices[Math.floor(prices.length / 2)] : 0;
  return { zoneScore, tagScore, prices, medianPrice, cold };
}

/**
 * 确定性伪随机（同一 seed 结果一致，便于复现与调试）。
 * 乘法散列 + 线性同余，够用且无依赖。
 */
/**
 * 32 位整数混合（mulberry32）。
 *
 * 不要用 `seed * 9301 + 49297 % 233280` 那种老式 LCG ——
 * 相邻 seed 的取值只差一个常数偏移，做「乘以区间长度再取整」时
 * 常常落在同一格，导致 seed 0/1/2/3/4 打散结果完全一样，
 * 「换一批」看起来像没生效。这里换成雪崩性好的混合函数。
 */
function hashInt(x) {
  let t = ((x | 0) + 0x6D2B79F5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

function seededRand(seed) {
  return hashInt(seed) / 4294967296;
}

/** 按 seed 打乱数组（Fisher-Yates，确定性但雪崩性好） */
function seededShuffle(arr, seed) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(seededRand(seed * 1000003 + i * 977) * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/**
 * 推荐排序
 *
 * opts:
 *   seed    —— 换一批时前端自增，用于「同分档内随机」
 *   exclude —— 累计已展示过的 id 数组（不是只有上一批！）。
 *              这些排到后面而不是删掉，保证候选耗尽时仍能填满一屏
 *
 * 返回附带的 meta 由调用方组装（是否已轮完全部候选）。
 */
function recommendListings(user, limit, opts) {
  const seed = (opts && opts.seed) || 0;
  const exclude = new Set((opts && opts.exclude) || []);
  const { zoneScore, tagScore, medianPrice, cold } = buildProfile(user);
  const meId = user ? user.id : 0;
  const seen = new Set(db.find('histories', (h) => h.userId === meId).map((h) => h.listingId));

  let cands = db.find('listings', (l) => l.status === 'on' && l.sellerId !== meId);
  const scored = cands.map((l) => {
    let score = 0;
    const reasons = [];
    const zs = zoneScore[l.zone] || 0;
    if (zs > 0) { score += Math.min(18, zs * 2.2); reasons.push('你常看这个分区'); }
    let tagHit = 0;
    for (const t of (l.tags || [])) {
      const ts = tagScore[t] || 0;
      if (ts > 0 && tagHit < 3) { score += Math.min(9, ts * 1.6); tagHit++; }
    }
    if (tagHit) reasons.push('符合你的偏好标签');
    if (medianPrice > 0 && l.price) {
      const ratio = Math.abs(l.price - medianPrice) / medianPrice;
      if (ratio < 0.35) { score += 4; reasons.push('价格区间合适'); }
      else if (ratio < 0.8) score += 1.6;
      else score -= 1.5;
    }
    // 热度
    score += Math.min(10, (l.views || 0) / 60 + (l.favoriteCount || 0) * 0.35 + (l.wantCount || 0) * 0.9);
    // 时效
    const ageH = (Date.now() - (l.createdAt || 0)) / 3600000;
    if (ageH < 24) score += 3; else if (ageH < 72) score += 1.5;
    // 已看过降权
    if (seen.has(l.id)) score -= 6;
    // 同校区加权
    const seller = db.findById('users', l.sellerId);
    if (user && seller && seller.campus && user.campus && seller.campus === user.campus) score += 1.5;
    // 冷启动：按热度均衡
    if (cold) score = (l.views || 0) / 50 + (l.favoriteCount || 0) * 0.5 + (l.wantCount || 0) * 1.2;

    let reason = reasons[0] || (cold ? '校园热门好物' : '综合推荐');
    if (score > 22) reason = reasons[0] || '为你精选';
    return { l, score, reason };
  });

  scored.sort((a, b) => b.score - a.score);

  // 分档随机：按「名次」每组 4 个。
  // 用名次而不是分数阈值 —— 分数跨度大时阈值分档会让多数商品独占一档，shuffle 失效。
  // 档位之间的先后仍保持高分优先，只打散档内顺序，推荐质量不塌。
  const GROUP = 4;
  const ordered = [];
  for (let i = 0; i < scored.length; i += GROUP) {
    ordered.push(...seededShuffle(scored.slice(i, i + GROUP), seed + i));
  }

  // 累计排除：优先给没看过的；已看过的排后面（候选耗尽时仍需填满一屏）
  const fresh = ordered.filter((s) => !exclude.has(s.l.id));
  const repeated = ordered.filter((s) => exclude.has(s.l.id));
  const ranked = fresh.concat(repeated);

  // 分区打散，避免首页清一色
  const picked = [];
  const perZone = {};
  for (const s of ranked) {
    if (picked.length >= limit) break;
    const z = s.l.zone;
    if ((perZone[z] || 0) >= 3) continue;
    perZone[z] = (perZone[z] || 0) + 1;
    picked.push(s);
  }
  for (const s of ranked) {
    if (picked.length >= limit) break;
    if (picked.indexOf(s) === -1) picked.push(s);
  }

  const items = picked.slice(0, limit).map((s) => Object.assign(deco.decorateListing(s.l, user), {
    reason: s.reason,
    score: Math.round(s.score * 10) / 10
  }));

  // 候选池 = 所有「非自己发布的在售商品」
  const poolSize = cands.length;
  return {
    items,
    poolSize,
    /** 候选池里没被看过的还剩几件（0 表示该循环了） */
    unseen: Math.max(0, poolSize - exclude.size)
  };
}

function recommendReasonText(user) {
  const { zoneScore, cold } = buildProfile(user);
  if (cold) return '根据校园热度为你推荐';
  const top = Object.keys(zoneScore).sort((a, b) => zoneScore[b] - zoneScore[a])[0];
  const ZONE_NAME = {
    used: '二手闲置', errand: '代拿代跑', service: '校园服务', game: '游戏账号', rental: '物品租借',
    barter: '以物换物', group: '拼团拼单', graduation: '毕业季', lost: '失物招领'
  };
  return top ? '根据你在「' + (ZONE_NAME[top] || top) + '」的浏览与收藏推荐' : '根据你的兴趣为你推荐';
}

module.exports = function register(route) {
  /* ================= 1. 拼团 ================= */

  /** 商品的拼团列表（进行中的团 + 自动匹配提示） */
  route('GET', '/api/groupbuy/listing/:listingId', (ctx) => {
    const me = ctx.user || null;
    const listing = db.findById('listings', ctx.params.listingId);
    if (!listing) fail('商品不存在', 404);
    group.sweepExpired();
    const list = db.find('groups', (g) => g.listingId === listing.id)
      .sort((a, b) => {
        const rank = (x) => (x.status === 'open' ? 0 : 1);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        return (b.members || []).length - (a.members || []).length;
      })
      .map((g) => Object.assign(group.decoGroup(g, me), { expireLeft: leftText(g.expireAt) }));
    const matchable = group.findMatchable(listing.id, me ? me.id : 0);
    return {
      list,
      targetCount: group.parseTarget(listing),
      matchableId: matchable ? matchable.id : null,
      matchableCount: matchable ? (matchable.members || []).length : 0,
      autoTip: matchable
        ? '已为你匹配到一个 ' + (matchable.members || []).length + ' 人的团，参团即可一起等成团'
        : '暂无进行中的团，参团将自动为你开一个新团'
    };
  });

  /** 参团（自动匹配）→ 返回团信息与新订单 id，前端去支付 */
  route('POST', '/api/groupbuy/join', (ctx) => {
    const me = needUser(ctx);
    const b = ctx.body || {};
    const listing = db.findById('listings', b.listingId);
    if (!listing) fail('商品不存在');
    if (listing.tradeMode !== 'group') fail('该商品不是拼团商品');
    if (listing.status !== 'on') fail('该商品已下架');
    if (listing.sellerId === me.id) fail('不能参加自己发布的拼团');

    group.sweepExpired();
    const qty = Math.max(1, Math.min(99, util.num(b.qty, 1)));

    // 已在某个进行中的团里 → 直接复用（未支付则继续付款）
    const mine = db.one('groups', (g) =>
      g.listingId === listing.id && g.status === 'open' && (g.members || []).some((m) => m.userId === me.id)
    );
    if (mine) {
      const mem = mine.members.find((m) => m.userId === me.id);
      if (mem.orderId) {
        const order = db.findById('orders', mem.orderId);
        if (order && order.status === 'pending') {
          return { group: group.decoGroup(mine, me), orderId: order.id, reused: true };
        }
        if (order && order.status !== 'pending' && order.status !== 'canceled') {
          fail('你已参团并完成付款，无需重复参团');
        }
      }
      // 有新数量则更新
      mem.qty = qty;
      db.saveSoon();
      const o = createGroupOrder(listing, me, qty, b.tradeMethod, b.remark);
      mem.orderId = o.id;
      return { group: group.decoGroup(mine, me), orderId: o.id };
    }

    // 自动匹配已有团，否则开新团
    const target = group.findMatchable(listing.id, me.id);
    let g;
    let matched = false;
    if (target) { g = target; matched = true; } else { g = group.openGroup(listing, me.id, qty, null); }

    const order = createGroupOrder(listing, me, qty, b.tradeMethod, b.remark);
    group.joinGroup(g, me.id, qty, order.id);
    if (!g.leaderId) g.leaderId = me.id;
    const listingTitle = listing.title;
    if (g.leaderId !== me.id) {
      ws.notifyUser(g.leaderId, '「' + me.nickname + '」加入了你的拼团：' + listingTitle, { groupId: g.id, title: listingTitle });
    }
    return {
      group: group.decoGroup(g, me),
      orderId: order.id,
      matched,
      tip: matched ? '已自动匹配到现有拼团，付款后即占坑' : '已为你开团，付款后等待其他同学加入'
    };
  });

  /** 开团（显式，不自动匹配） */
  route('POST', '/api/groupbuy/open', (ctx) => {
    const me = needUser(ctx);
    const b = ctx.body || {};
    const listing = db.findById('listings', b.listingId);
    if (!listing) fail('商品不存在');
    if (listing.tradeMode !== 'group') fail('该商品不是拼团商品');
    if (listing.status !== 'on') fail('该商品已下架');
    const qty = Math.max(1, Math.min(99, util.num(b.qty, 1)));
    const g = group.openGroup(listing, me.id, qty, null);
    const order = createGroupOrder(listing, me, qty, b.tradeMethod, b.remark);
    const mem = g.members.find((m) => m.userId === me.id);
    if (mem) mem.orderId = order.id;
    db.saveSoon();
    return { group: group.decoGroup(g, me), orderId: order.id, tip: '已开团，快分享给同学一起拼' };
  });

  /** 我参与的拼团（必须注册在 /:id 之前，否则会被 :id 抢先匹配） */
  route('GET', '/api/groupbuy/mine', (ctx) => {
    const me = needUser(ctx);
    group.sweepExpired();
    const list = db.find('groups', (g) => (g.members || []).some((m) => m.userId === me.id))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((g) => {
        const out = group.decoGroup(g, me);
        out.expireLeft = leftText(g.expireAt);
        return out;
      });
    return {
      list,
      ongoing: list.filter((x) => x.status === 'open').length,
      success: list.filter((x) => x.status === 'success').length
    };
  });

  /** 团详情 */
  route('GET', '/api/groupbuy/:id', (ctx) => {
    const me = ctx.user || null;
    group.sweepExpired();
    const g = db.findById('groups', ctx.params.id);
    if (!g) fail('拼团不存在', 404);
    const out = group.decoGroup(g, me);
    out.expireLeft = leftText(g.expireAt);
    out.shareTip = '邀请同学一起拼，满 ' + g.targetCount + ' 人即成团';
    return { group: out };
  });

  /** 退出拼团（仅未支付时） */
  route('POST', '/api/groupbuy/:id/quit', (ctx) => {
    const me = needUser(ctx);
    const g = db.findById('groups', ctx.params.id);
    if (!g) fail('拼团不存在', 404);
    const i = (g.members || []).findIndex((m) => m.userId === me.id);
    if (i === -1) fail('你不在这个团里');
    if (g.members[i].paid) fail('已付款，请走订单退款流程');
    const mem = g.members.splice(i, 1)[0];
    if (mem.orderId) {
      const o = db.findById('orders', mem.orderId);
      if (o && o.status === 'pending') { o.status = 'canceled'; o.timeline.push({ status: 'canceled', time: Date.now(), note: '退出拼团，订单取消' }); }
    }
    // 团长退出且团里还有人就转移团长
    if (g.leaderId === me.id && g.members.length) g.leaderId = g.members[0].userId;
    if (!g.members.length) g.status = 'failed';
    db.saveSoon();
    return { ok: true };
  });

  /* ================= 2. 校园墙 ================= */

  route('GET', '/api/wall', (ctx) => {
    const me = ctx.user || null;
    const q = ctx.query;
    const type = q.get('type') || 'all';
    const sort = q.get('sort') || 'new';
    const kw = (q.get('keyword') || '').trim();
    const mine = q.get('mine') === '1';
    let list = db.find('walls', (w) => w.status !== 'hidden');
    if (type !== 'all') list = list.filter((w) => w.type === type);
    if (mine) { const u = needUser(ctx); list = list.filter((w) => w.authorId === u.id); }
    if (kw) list = list.filter((w) => util.match(w.content, kw) || util.match(w.toName, kw));
    if (sort === 'hot') list.sort((a, b) => (((b.likeBase || 0) + (b.likes || []).length) * 2 + (b.commentCount || 0) * 3) - (((a.likeBase || 0) + (a.likes || []).length) * 2 + (a.commentCount || 0) * 3));
    else list.sort((a, b) => b.createdAt - a.createdAt);
    const page = util.paginate(list, q.get('page'), q.get('pageSize') || 10);
    return Object.assign({}, page, { list: page.list.map((w) => decoWall(w, me)) });
  });

  route('POST', '/api/wall', (ctx) => {
    const me = needUser(ctx);
    const b = ctx.body || {};
    const content = util.clampText(b.content, 800);
    if (!content) fail('说点什么再发布吧');
    const type = b.type === 'love' ? 'love' : 'all';
    const salt = Date.now() % 9973;
    const w = db.insert('walls', {
      type,
      content,
      images: (b.images || []).slice(0, 9),
      toName: util.clampText(b.toName, 30),
      authorId: me.id,
      anonName: b.anonymous === false ? util.clampText(b.nickname, 20) || me.nickname : anonName(me.id, salt),
      anonymous: b.anonymous !== false,
      likes: [], likeBase: 0, commentCount: 0,
      status: 'on', createdAt: Date.now()
    });
    return { wall: decoWall(w, me) };
  });

  /**
   * 修改校园墙内容（作者本人或管理员）：文案 / 配图。
   * 前端暂未接入，主要给内容维护用。
   * 校园墙展示时会隐藏作者（匿名），但库里 authorId 是真实存在的，故仍可做归属校验。
   */
  route('PATCH', '/api/wall/:id', async (ctx) => {
    const me = needUser(ctx);
    const f = await db.findByIdWithFallback('walls', ctx.params.id);
    const w = f.doc;
    if (!w || (w.authorId !== me.id && !me.isAdmin)) fail('无权操作', 403);
    const b = ctx.body || {};
    const patch = {};
    if (b.content !== undefined) {
      const c = util.clampText(b.content, 800);
      if (!c) fail('内容不能为空');
      patch.content = c;
    }
    if (b.images !== undefined) patch.images = (b.images || []).slice(0, 9);
    return { wall: decoWall(db.update('walls', w.id, patch), me) };
  });

  route('GET', '/api/wall/:id', (ctx) => {
    const me = ctx.user || null;
    const w = db.findById('walls', ctx.params.id);
    if (!w || w.status === 'hidden') fail('内容不存在或已删除', 404);
    const comments = db.find('wallComments', (c) => c.wallId === w.id && c.status !== 'hidden')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => Object.assign(stripAnon(c), {
        likeCount: (c.likeBase || 0) + (c.likes || []).length,
        liked: me ? (c.likes || []).indexOf(me.id) !== -1 : false,
        isMine: me ? c.authorId === me.id : false,
        timeText: util.relTime(c.createdAt)
      }));
    return { wall: decoWall(w, me), comments };
  });

  route('POST', '/api/wall/:id/like', (ctx) => {
    const me = needUser(ctx);
    const w = db.findById('walls', ctx.params.id);
    if (!w) fail('内容不存在', 404);
    const i = (w.likes || []).indexOf(me.id);
    if (i === -1) w.likes.push(me.id); else w.likes.splice(i, 1);
    db.saveSoon();
    if (i === -1 && w.authorId !== me.id) {
      ws.notifyUser(w.authorId, '你的校园墙收到了一个赞 ❤️');
    }
    // 互动消息：只在「刚点上赞」时提醒（取消赞不提醒）；自己赞自己由 it.add 丢弃
    if (i === -1) {
      it.add({
        toUserId: w.authorId, actorId: me.id, type: 'wall_like',
        targetId: w.id, title: w.content
      });
    }
    return { liked: i === -1, likeCount: (w.likeBase || 0) + w.likes.length };
  });

  route('POST', '/api/wall/:id/comments', (ctx) => {
    const me = needUser(ctx);
    const w = db.findById('walls', ctx.params.id);
    if (!w) fail('内容不存在', 404);
    const content = util.clampText((ctx.body || {}).content, 300);
    if (!content) fail('评论内容不能为空');
    const b = ctx.body || {};
    const salt = Date.now() % 9973;
    const c = db.insert('wallComments', {
      wallId: w.id, content,
      authorId: me.id,
      anonName: b.anonymous === false ? me.nickname : anonName(me.id, salt),
      anonymous: b.anonymous !== false,
      replyToName: util.clampText(b.replyToName, 30),
      likes: [], likeBase: 0, status: 'on', createdAt: Date.now()
    });
    w.commentCount = db.find('wallComments', (x) => x.wallId === w.id && x.status !== 'hidden').length;
    db.saveSoon();
    if (w.authorId !== me.id) ws.notifyUser(w.authorId, '你的校园墙收到了新评论：' + content.slice(0, 26));
    /**
     * 互动消息：**评论者是谁要看「匿名开关」**。
     *   非匿名 → 照常展示真实昵称；
     *   匿名   → 只把墙上同款匿名昵称带过去（`actorName`）。
     * 绝不能让互动消息变成反查匿名账号的入口 —— 校园墙的核心就是匿名
     * （见本文件顶部的 stripAnon / anonName）。
     */
    it.add({
      toUserId: w.authorId, actorId: me.id, type: 'wall_comment',
      targetId: w.id, commentId: c.id, text: content, title: w.content,
      actorName: c.anonymous ? c.anonName : ''
    });
    return {
      comment: Object.assign(stripAnon(c), { timeText: '刚刚', likeCount: 0, liked: false, isMine: true }),
      commentCount: w.commentCount
    };
  });

  route('POST', '/api/wall/comments/:id/like', (ctx) => {
    const me = needUser(ctx);
    const c = db.findById('wallComments', ctx.params.id);
    if (!c) fail('评论不存在', 404);
    const i = (c.likes || []).indexOf(me.id);
    if (i === -1) c.likes.push(me.id); else c.likes.splice(i, 1);
    db.saveSoon();
    // 互动消息：点赞者不匿名（匿名的是评论本身），照常展示真实昵称/头像
    if (i === -1) {
      it.add({
        toUserId: c.authorId, actorId: me.id, type: 'wall_comment_like',
        targetId: c.wallId, commentId: c.id, text: c.content, title: c.content
      });
    }
    return { liked: i === -1, likeCount: (c.likeBase || 0) + c.likes.length };
  });

  route('DELETE', '/api/wall/:id', async (ctx) => {
    const me = needUser(ctx);
    // 多实例：别的实例发的墙本实例内存里没有 → 直查兜底，否则「删不掉自己的帖子」
    const f = await db.findByIdWithFallback('walls', ctx.params.id);
    const w = f.doc;
    if (!w) fail('内容不存在', 404);
    if (w.authorId !== me.id) fail('只能删除自己发布的内容', 403);
    w.status = 'hidden';
    db.saveSoon();
    return { ok: true };
  });

  /* ================= 3. 学习资源 ================= */

  route('GET', '/api/resources', (ctx) => {
    const me = ctx.user || null;
    const q = ctx.query;
    const category = q.get('category') || '';
    const course = q.get('course') || '';
    const kw = (q.get('keyword') || '').trim();
    const sort = q.get('sort') || 'new';
    let list = db.find('resources', (r) => r.status !== 'hidden' && r.status !== 'deleted');
    if (category) list = list.filter((r) => r.category === category);
    if (course) list = list.filter((r) => r.course === course);
    if (kw) list = list.filter((r) => util.match(r.title, kw) || util.match(r.desc, kw) || (r.tags || []).some((t) => util.match(t, kw)));
    if (sort === 'hot') list.sort((a, b) => (b.downloads || 0) * 2 + (b.likeBase || 0) + (b.likes || []).length - ((a.downloads || 0) * 2 + (a.likeBase || 0) + (a.likes || []).length));
    else if (sort === 'download') list.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
    else list.sort((a, b) => b.createdAt - a.createdAt);
    const page = util.paginate(list, q.get('page'), q.get('pageSize') || 10);
    return Object.assign({}, page, {
      list: page.list.map((r) => decoResource(r, me)),
      categories: RES_CATEGORIES
    });
  });

  route('POST', '/api/resources', (ctx) => {
    const me = needUser(ctx);
    const b = ctx.body || {};
    const title = util.clampText(b.title, 60);
    if (!title) fail('请填写资料标题');
    if (!b.fileUrl) fail('请上传资料文件');
    const r = db.insert('resources', {
      title,
      desc: util.clampText(b.desc, 300),
      course: util.clampText(b.course, 40),
      category: RES_CATEGORIES.some((c) => c.code === b.category) ? b.category : 'other',
      tags: (b.tags || []).slice(0, 5),
      fileUrl: b.fileUrl,
      fileName: util.clampText(b.fileName, 80),
      fileSize: util.num(b.fileSize),
      fileExt: util.clampText(b.fileExt, 10),
      uploaderId: me.id,
      downloads: 0, likes: [], likeBase: 0,
      status: 'on', createdAt: Date.now()
    });
    return { resource: decoResource(r, me) };
  });

  route('GET', '/api/resources/mine', (ctx) => {
    const me = needUser(ctx);
    const list = db.find('resources', (r) => r.uploaderId === me.id && r.status !== 'deleted')
      .sort((a, b) => b.createdAt - a.createdAt);
    return { list: list.map((r) => decoResource(r, me)) };
  });

  route('GET', '/api/resources/courses', () => {
    const counts = {};
    for (const r of db.get('resources')) {
      if (r.status === 'hidden' || r.status === 'deleted') continue;
      if (!r.course) continue;
      counts[r.course] = (counts[r.course] || 0) + 1;
    }
    const list = Object.keys(counts).map((name) => ({ name, count: counts[name] }))
      .sort((a, b) => b.count - a.count).slice(0, 16);
    return { list, categories: RES_CATEGORIES };
  });

  route('GET', '/api/resources/:id', (ctx) => {
    const me = ctx.user || null;
    const r = db.findById('resources', ctx.params.id);
    if (!r || r.status === 'hidden' || r.status === 'deleted') fail('资料不存在或已删除', 404);
    const related = db.find('resources', (x) => x.id !== r.id && x.status === 'on' && (x.category === r.category || (x.course && x.course === r.course)))
      .slice(0, 6).map((x) => decoResource(x, me));
    return { resource: decoResource(r, me), related };
  });

  /** 下载：计数 + 返回文件地址 */
  route('POST', '/api/resources/:id/download', (ctx) => {
    const me = needUser(ctx);
    const r = db.findById('resources', ctx.params.id);
    if (!r) fail('资料不存在', 404);
    r.downloads = (r.downloads || 0) + 1;
    db.saveSoon();
    if (r.uploaderId !== me.id) {
      ws.notifyUser(r.uploaderId, '「' + me.nickname + '」下载了你分享的《' + r.title + '》');
    }
    return { url: r.fileUrl, fileName: r.fileName || r.title, downloads: r.downloads };
  });

  route('POST', '/api/resources/:id/like', (ctx) => {
    const me = needUser(ctx);
    const r = db.findById('resources', ctx.params.id);
    if (!r) fail('资料不存在', 404);
    const i = (r.likes || []).indexOf(me.id);
    if (i === -1) r.likes.push(me.id); else r.likes.splice(i, 1);
    db.saveSoon();
    if (i === -1) {
      it.add({
        toUserId: r.uploaderId, actorId: me.id, type: 'resource_like',
        targetId: r.id, title: r.title
      });
    }
    return { liked: i === -1, likeCount: (r.likeBase || 0) + r.likes.length };
  });

  route('DELETE', '/api/resources/:id', (ctx) => {
    const me = needUser(ctx);
    const r = db.findById('resources', ctx.params.id);
    if (!r) fail('资料不存在', 404);
    if (r.uploaderId !== me.id) fail('只能删除自己上传的资料', 403);
    r.status = 'deleted';
    db.saveSoon();
    return { ok: true };
  });

  /* ================= 4. AI 智能推荐 ================= */

  route('GET', '/api/recommend', (ctx) => {
    const me = ctx.user || null;
    const limit = Math.max(4, Math.min(30, util.num(ctx.query.get('limit'), 12)));
    const r = recommendListings(me, limit);
    return {
      list: r.items,
      poolSize: r.poolSize,
      unseen: r.unseen,
      reason: recommendReasonText(me),
      personalized: !!me && !buildProfile(me).cold,
      updatedAt: Date.now()
    };
  });

  /** 首页个性化聚合：推荐 + 猜你喜欢 + 你的分区
   *  换一批：前端传 seed（自增）+ exclude（上批 id），后端在同分档内重新打散并优先返回新面孔
   */
  route('GET', '/api/recommend/home', (ctx) => {
    const me = ctx.user || null;
    const profile = buildProfile(me);
    const seed = util.num(ctx.query.get('seed'));
    const excludeRaw = String(ctx.query.get('exclude') || '').trim();
    const exclude = excludeRaw
      ? excludeRaw.split(',').map((x) => util.num(x)).filter(Boolean)
      : [];
    const r = recommendListings(me, 12, { seed, exclude });
    return {
      list: r.items,
      /** 候选池总量 / 还没看过的数量 —— 前端据此判断「是否已看完一轮」并重置循环 */
      poolSize: r.poolSize,
      unseen: r.unseen,
      reason: recommendReasonText(me),
      personalized: !!me && !profile.cold,
      topZones: Object.keys(profile.zoneScore || {})
        .sort((a, b) => profile.zoneScore[b] - profile.zoneScore[a]).slice(0, 3),
      topTags: Object.keys(profile.tagScore || {})
        .sort((a, b) => profile.tagScore[b] - profile.tagScore[a]).slice(0, 6)
    };
  });

  /* ================= 5. 交易担保 ================= */

  /** 担保资金流水（买家视角） */
  route('GET', '/api/escrow/order/:id', (ctx) => {
    const me = needUser(ctx);
    const o = db.findById('orders', ctx.params.id);
    if (!o || (o.buyerId !== me.id && o.sellerId !== me.id)) fail('订单不存在', 404);
    const listing = db.findById('listings', o.listingId);
    const paid = ['paid', 'shipped', 'done', 'refunding', 'refunded'].includes(o.status);
    const released = o.status === 'done';
    const refunded = o.status === 'refunded';
    const escrow = db.one('escrows', (e) => e.orderId === o.id) || null;
    const steps = [
      { key: 'pay', label: '买家付款', sub: '¥' + util.yuan(o.payAmount), done: paid, time: paid ? (o.timeline.find((t) => t.status === 'paid') || {}).time : 0 },
      { key: 'hold', label: '平台托管', sub: '资金由平台暂管，卖家尚未收到', done: paid && !refunded, time: paid ? (o.timeline.find((t) => t.status === 'paid') || {}).time : 0 },
      { key: 'ship', label: '卖家交付', sub: '按约定方式交付商品', done: ['shipped', 'done'].includes(o.status), time: (o.timeline.find((t) => t.status === 'shipped') || {}).time || 0 },
      { key: released ? 'release' : 'release2', label: released ? '货款已放款' : '确认收货后放款', sub: released ? '已打款给卖家' : '确认收货后 ¥' + util.yuan(o.payAmount) + ' 打给卖家', done: released, time: released ? (o.timeline.find((t) => t.status === 'done') || {}).time : 0 }
    ];
    return {
      order: deco.decorateOrder(o, me),
      steps,
      escrowStatus: refunded ? 'refunded' : released ? 'released' : paid ? 'holding' : 'none',
      escrowText: refunded ? '已退款给买家' : released ? '已放款给卖家' : paid ? '平台托管中' : '等待买家付款',
      amount: o.payAmount,
      amountText: util.yuan(o.payAmount),
      guarantee: [
        '货款由平台托管，确认收货后才打给卖家',
        '商品与描述不符可申请退款，卖家拒绝可申请平台介入',
        '所有交易记录可追溯，聊天记录可作为凭证'
      ],
      escrow
    };
  });

  /** 申请平台介入 */
  route('POST', '/api/orders/:id/intervene', (ctx) => {
    const me = needUser(ctx);
    const o = db.findById('orders', ctx.params.id);
    if (!o || (o.buyerId !== me.id && o.sellerId !== me.id)) fail('订单不存在', 404);
    const reason = util.clampText((ctx.body || {}).reason, 200);
    if (!reason) fail('请说明遇到的问题');
    const rep = db.insert('reports', {
      reporterId: me.id, targetType: 'order', targetId: o.id,
      reason: '申请平台介入：' + reason.slice(0, 40), detail: reason,
      status: 'pending', createdAt: Date.now()
    });
    db.insert('escrows', {
      orderId: o.id, type: 'intervene', userId: me.id, reason, status: 'open', createdAt: Date.now()
    });
    db.saveSoon();
    ws.notifyUser(o.buyerId === me.id ? o.sellerId : o.buyerId,
      '对方对订单「' + o.snapshot.title + '」申请了平台介入，客服将尽快处理', { orderId: o.id, title: o.snapshot.title });
    return { ok: true, reportId: rep.id };
  });

  /** 担保规则说明 */
  route('GET', '/api/escrow/info', () => ({
    title: '平台担保交易',
    points: [
      { t: '资金托管', d: '买家付款后货款暂存平台，卖家看不到也拿不走，避免收了钱不发货。' },
      { t: '确认放款', d: '买家收到商品并确认收货后，货款才会打给卖家，双方都安心。' },
      { t: '无理由退款', d: '待发货 / 待收货阶段均可发起退款申请，卖家拒绝可申请平台介入。' },
      { t: '平台介入', d: '出现纠纷可一键申请客服介入，平台依据订单与聊天记录判定。' },
      { t: '自动退款', d: '拼团到期未成团、买家取消等场景，货款原路自动退回。' }
    ]
  }));
};

/* ---------------- 内部：拼团订单创建 ---------------- */
function createGroupOrder(listing, me, qty, tradeMethod, remark) {
  const amount = listing.price * qty;
  return db.insert('orders', {
    orderNo: util.orderNo(),
    buyerId: me.id, sellerId: listing.sellerId, listingId: listing.id,
    snapshot: {
      title: listing.title, image: listing.images[0], price: listing.price,
      priceUnit: listing.priceUnit, zone: listing.zone, tradeMode: listing.tradeMode
    },
    qty, amount, payAmount: amount,
    status: 'pending', payType: null,
    tradeMethod: util.clampText(tradeMethod, 20) || (listing.tradeMethods || ['校内面交'])[0],
    location: listing.location, remark: util.clampText(remark, 100),
    isGroupBuy: true,
    timeline: [{ status: 'created', time: Date.now(), note: '拼团订单已创建，付款后占坑' }]
  });
}
