'use strict';
/** 管理后台 API（仅 3100 端口，需管理员令牌） */
const db = require('./db');
const util = require('./util');
const deco = require('./deco');
const ws = require('./events');
const auth = require('./auth');
const group = require('./group');
const { ZONES } = require('./const');

function fail(message, status) { const e = new Error(message); e.status = status || 400; throw e; }

/**
 * 举报「被举报对象」的简要信息。
 *
 * ⚠️ 必须覆盖**所有** targetType —— 少一个分支，那类举报在后台就显示成
 * 「（内容已删除）」，看起来像系统出错，实际是类型没处理（真实踩过：
 * 订单的「申请平台介入」原来落到 else 分支，被当成用户去查 → 永远 null）。
 */
function decoReport(r) {
  const out = Object.assign({}, r, { timeText: util.fmtTime(r.createdAt) });
  out.reporter = deco.sellerBrief(r.reporterId);
  out.target = null;
  if (r.targetType === 'listing') {
    const l = db.findById('listings', r.targetId);
    out.target = l ? { title: l.title, image: l.images[0], price: l.price, status: l.status, seller: deco.sellerBrief(l.sellerId) } : null;
  } else if (r.targetType === 'post') {
    const p = db.findById('posts', r.targetId);
    out.target = p ? { title: String(p.content).slice(0, 40), image: (p.images || [])[0] || '', status: 'on', seller: deco.sellerBrief(p.authorId) } : null;
  } else if (r.targetType === 'wall') {
    const w = db.findById('walls', r.targetId);
    out.target = w ? {
      title: String(w.content || '').slice(0, 40), image: (w.images || [])[0] || '',
      status: w.status === 'hidden' ? 'hidden' : 'on', seller: null, anon: true
    } : null;
  } else if (r.targetType === 'resource') {
    const x = db.findById('resources', r.targetId);
    out.target = x ? { title: x.title, image: '', status: x.status, seller: deco.sellerBrief(x.uploaderId) } : null;
  } else if (r.targetType === 'order') {
    const o = db.findById('orders', r.targetId);
    out.target = o ? {
      title: (o.snapshot && o.snapshot.title) || o.orderNo, image: '', price: o.payAmount,
      status: o.status, orderNo: o.orderNo, seller: deco.sellerBrief(o.sellerId)
    } : null;
  } else {
    const u = db.findById('users', r.targetId);
    out.target = u ? { title: u.nickname, image: u.avatar, status: u.banned ? 'banned' : 'on', seller: null } : null;
  }
  return out;
}

module.exports = function register(route) {
  /* ---------- 登录 ---------- */
  route('POST', '/admin-api/login', async (ctx) => {
    const { username, password } = ctx.body || {};
    const token = await auth.adminLogin(String(username || '').trim(), String(password || ''));
    if (!token) fail('账号或密码错误', 401);
    return { token, username: String(username).trim() };
  }, 'admin');

  route('GET', '/admin-api/me', (ctx) => ({ username: ctx.admin.username }), 'admin');

  /* ---------- 仪表盘 ---------- */
  /**
   * ⚠️ 统计一律**直查数据库**，不读 `db.get()`。
   *
   * 起因（真实事故）：后台「圈子帖子」数一直变来变去 ——
   * 用户删了一个帖子、又加了一个，刷新几次看到的数字不一样。
   *
   * 因为 `db.get()` 读的是**本实例冷启动时的快照**：云函数并发多实例，
   * 每个实例的快照加载时间不同，刷新命中哪个实例就看到哪个时刻的数据。
   * （本文件其余「列表类」接口也有同样的性质，但列表是给人浏览的、
   *   数量级小且用户不易察觉；而仪表盘的**数字**一旦跳动就非常显眼。）
   *
   * 用 readAllFromDb 只读不改：不会碰到内存镜像，
   * 因此不存在「把本实例未落库的改动冲掉」的风险。
   */
  route('GET', '/admin-api/stats', async () => {
    // 除了「交易主链路」，校园墙 / 学习资源 / 拼团 / 评论也要进统计 ——
    // 这些是首页分区的入口，后台一个数都没有的话，运营根本不知道内容量够不够。
    const [usersAll, listings, orders, posts, reports, walls, resources, groups, comments, wallComments] = await Promise.all([
      db.readAllFromDb('users'),
      db.readAllFromDb('listings'),
      db.readAllFromDb('orders'),
      db.readAllFromDb('posts'),
      db.readAllFromDb('reports'),
      db.readAllFromDb('walls'),
      db.readAllFromDb('resources'),
      db.readAllFromDb('groups'),
      db.readAllFromDb('comments'),
      db.readAllFromDb('wallComments')
    ]);
    const users = usersAll.filter((u) => !u.isAI);
    const PAID = ['paid', 'shipped', 'done'];
    const gmv = orders.filter((o) => PAID.includes(o.status)).reduce((s, o) => s + o.payAmount, 0);
    const days = [];
    for (let i = 6; i >= 0; i--) {
      // 用**北京时间的自然日**边界。云函数跑在 UTC，
      // 直接 new Date().getFullYear() 得到的是 UTC 当天，
      // 会把 0:00~8:00 的数据算到前一天。
      const dayStart = util.bjDayStart(i);
      const dayEnd = dayStart + 86400e3;
      const inDay = (t) => t >= dayStart && t < dayEnd;
      days.push({
        label: util.bjDayLabel(dayStart),
        orders: orders.filter((o) => inDay(o.createdAt)).length,
        users: users.filter((u) => inDay(u.createdAt || u.joinedAt)).length,
        listings: listings.filter((l) => inDay(l.createdAt)).length,
        amount: orders.filter((o) => inDay(o.createdAt) && PAID.includes(o.status)).reduce((s, o) => s + o.payAmount, 0)
      });
    }
    return {
      totals: {
        users: users.length,
        listings: listings.length,
        onSale: listings.filter((l) => l.status === 'on').length,
        sold: listings.filter((l) => l.status === 'sold').length,
        orders: orders.length,
        doneOrders: orders.filter((o) => o.status === 'done').length,
        posts: posts.length,
        gmv,
        pendingReports: reports.filter((r) => r.status === 'pending').length,
        // 内容侧总量（后台「内容运营」区用）
        walls: walls.length,
        wallComments: wallComments.length,
        resources: resources.filter((r) => r.status !== 'deleted').length,
        comments: comments.length,
        groupsOpen: groups.filter((g) => g.status === 'open').length,
        groupsAll: groups.length
      },
      days,
      zoneStat: ZONES.map((z) => ({ name: z.name, count: listings.filter((l) => l.zone === z.code).length })),
      recentOrders: orders.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 6).map((o) => deco.decorateOrder(o, null)),
      pendingReports: reports.filter((r) => r.status === 'pending').slice(0, 5).map(decoReport)
    };
  }, 'admin');

  /* ---------- 商品管理 ---------- */
  // 列表类接口同样**直查数据库**：镜像过期时列表会显示「已经删掉的帖子/商品」，
  // 或看不到别人刚加的内容（与仪表盘数字跳动是同一个根因）。
  route('GET', '/admin-api/listings', async (ctx) => {
    const q = ctx.query;
    const status = q.get('status') || 'all';
    const zone = q.get('zone') || '';
    const kw = (q.get('keyword') || '').trim();
    let list = (await db.readAllFromDb('listings')).slice();
    if (status !== 'all') list = list.filter((l) => l.status === status);
    if (zone) list = list.filter((l) => l.zone === zone);
    if (kw) list = list.filter((l) => util.match(l.title, kw) || util.match(String(l.desc), kw));
    list.sort((a, b) => b.createdAt - a.createdAt);
    const page = util.paginate(list, q.get('page'), 12);
    return Object.assign({}, page, {
      list: page.list.map((l) => {
        const out = deco.decorateListing(l, null);
        out.zoneName = (ZONES.find((z) => z.code === l.zone) || {}).name || l.zone;
        return out;
      })
    });
  }, 'admin');

  route('POST', '/admin-api/listings/:id/status', async (ctx) => {
    // 先直查最新（别人的实例可能改过），避免用过期镜像整份覆盖
    const l = await db.findByIdFresh('listings', ctx.params.id);
    if (!l) fail('商品不存在', 404);
    const op = (ctx.body || {}).op;
    if (op === 'delete') {
      db.removeById('listings', l.id);
      db.remove('favorites', (f) => f.targetType === 'listing' && f.targetId === l.id);
      return { ok: true };
    }
    const map = { on: 'on', off: 'off', sold: 'sold', review: 'reviewing' };
    if (!map[op]) fail('不支持的操作');
    await db.updateFresh('listings', l.id, { status: map[op] });
    if (op === 'off' && l.sellerId) ws.notifyUser(l.sellerId, '你的商品「' + l.title + '」被管理员下架，如有疑问请联系客服');
    return { ok: true };
  }, 'admin');

  /* ---------- 用户管理 ---------- */
  route('GET', '/admin-api/users', async (ctx) => {
    const q = ctx.query;
    const kw = (q.get('keyword') || '').trim();
    let list = (await db.readAllFromDb('users')).filter((u) => !u.isAI);
    if (kw) list = list.filter((u) => util.match(u.nickname, kw) || util.match(String(u.college), kw));
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const page = util.paginate(list, q.get('page'), 12);
    return Object.assign({}, page, {
      list: page.list.map((u) => {
        const out = util.publicUser(u);
        out.stats = deco.userStats(u.id);
        out.timeText = util.fmtTime(u.createdAt || u.joinedAt || 0);
        return out;
      })
    });
  }, 'admin');

  route('POST', '/admin-api/users/:id/ban', async (ctx) => {
    // 封禁/解封是**权限相关**的写操作，必须基于最新数据
    const u = await db.findByIdFresh('users', ctx.params.id);
    if (!u || u.isAI) fail('用户不存在', 404);
    const banned = !!(ctx.body || {}).banned;
    await db.updateFresh('users', u.id, { banned });
    if (!banned) ws.notifyUser(u.id, '你的账号已恢复正常，感谢配合平台管理。');
    return { ok: true, banned };
  }, 'admin');

  /* ---------- 订单管理 ---------- */
  route('GET', '/admin-api/orders', async (ctx) => {
    const q = ctx.query;
    const status = q.get('status') || 'all';
    const kw = (q.get('keyword') || '').trim();
    let list = (await db.readAllFromDb('orders')).slice();
    if (status !== 'all') list = list.filter((o) => o.status === status);
    if (kw) list = list.filter((o) => util.match(o.orderNo, kw) || util.match(o.snapshot.title, kw));
    list.sort((a, b) => b.createdAt - a.createdAt);
    const page = util.paginate(list, q.get('page'), 12);
    return Object.assign({}, page, { list: page.list.map((o) => deco.decorateOrder(o, null)) });
  }, 'admin');

  /* ---------- 举报处理 ---------- */
  route('GET', '/admin-api/reports', async (ctx) => {
    const status = ctx.query.get('status') || 'pending';
    let list = (await db.readAllFromDb('reports')).slice();
    if (status !== 'all') list = list.filter((r) => r.status === status);
    list.sort((a, b) => b.createdAt - a.createdAt);
    return { list: list.map(decoReport) };
  }, 'admin');

  route('POST', '/admin-api/reports/:id/handle', async (ctx) => {
    const r = await db.findByIdFresh('reports', ctx.params.id);
    if (!r) fail('举报不存在', 404);
    const action = (ctx.body || {}).action;
    // 处置举报会连带改动被举报对象 —— 一律用 updateFresh（基于最新数据），
    // 否则会把被举报对象的其它字段一起写回旧值（可能覆盖卖家自己的编辑）
    if (action === 'remove') {
      if (r.targetType === 'listing') await db.updateFresh('listings', r.targetId, { status: 'off' });
      else if (r.targetType === 'post') db.removeById('posts', r.targetId);
      else if (r.targetType === 'wall') await db.updateFresh('walls', r.targetId, { status: 'hidden' });
      else if (r.targetType === 'resource') await db.updateFresh('resources', r.targetId, { status: 'hidden' });
      else if (r.targetType === 'order') {
        // 订单不是「内容」，删不得 —— 只能把对应的介入单标记已处理
        const esc = db.find('escrows', (x) => x.orderId === r.targetId && x.status === 'open');
        for (const e of esc) await db.updateFresh('escrows', e.id, { status: 'handled' });
      }
      else if (r.targetType === 'user') await db.updateFresh('users', r.targetId, { banned: true });
    }
    await db.updateFresh('reports', r.id, { status: 'handled', handledAt: Date.now(), action });
    ws.notifyUser(r.reporterId, '你提交的举报已受理并处理完毕，感谢你对社区安全的贡献！');
    return { ok: true };
  }, 'admin');

  /* ---------- 圈子管理 ---------- */
  route('GET', '/admin-api/posts', async (ctx) => {
    const q = ctx.query;
    const kw = (q.get('keyword') || '').trim();
    let list = (await db.readAllFromDb('posts')).slice();
    if (kw) list = list.filter((p) => util.match(p.content, kw));
    list.sort((a, b) => b.createdAt - a.createdAt);
    const page = util.paginate(list, q.get('page'), 12);
    return Object.assign({}, page, {
      list: page.list.map((p) => {
        const out = deco.decoratePost(p, null);
        out.timeText = util.fmtTime(p.createdAt);
        return out;
      })
    });
  }, 'admin');

  route('DELETE', '/admin-api/posts/:id', async (ctx) => {
    const p = await db.findByIdFresh('posts', ctx.params.id);
    if (!p) fail('帖子不存在', 404);
    db.removeById('posts', p.id);
    db.remove('comments', (c) => c.postId === p.id);
    return { ok: true };
  }, 'admin');

  /* ---------- 校园墙管理 ----------
   * 校园墙是「匿名」内容，用户端看不到作者，后台必须看得到 authorId ——
   * 否则同一个人反复发违规内容，运营根本串不起来（只能一条条删）。
   * 但这里**只给 id、不给昵称**：后台是治理用途，不是看匿名帖作者的入口。
   */
  route('GET', '/admin-api/walls', async (ctx) => {
    const q = ctx.query;
    const status = q.get('status') || 'all';
    const kw = (q.get('keyword') || '').trim();
    let list = (await db.readAllFromDb('walls')).slice();
    if (status !== 'all') list = list.filter((w) => (w.status || 'on') === status);
    if (kw) list = list.filter((w) => util.match(w.content, kw) || util.match(w.toName, kw));
    list.sort((a, b) => b.createdAt - a.createdAt);
    const page = util.paginate(list, q.get('page'), 12);
    return Object.assign({}, page, {
      list: page.list.map((w) => ({
        id: w.id,
        content: w.content,
        images: (w.images || []).slice(0, 3),
        typeText: w.type === 'love' ? '表白墙' : '万能求助',
        anonName: w.anonName || '匿名同学',
        anonymous: w.anonymous !== false,
        authorId: w.authorId || null,
        likeCount: (w.likeBase || 0) + (w.likes || []).length,
        commentCount: w.commentCount || 0,
        status: w.status || 'on',
        timeText: util.fmtTime(w.createdAt)
      }))
    });
  }, 'admin');

  route('POST', '/admin-api/walls/:id/status', async (ctx) => {
    const w = await db.findByIdFresh('walls', ctx.params.id);
    if (!w) fail('内容不存在', 404);
    const op = (ctx.body || {}).op;
    if (op === 'delete') {
      await db.removeFresh('walls', w.id);
      db.remove('wallComments', (c) => c.wallId === w.id);
      db.saveSoon();
      return { ok: true };
    }
    if (op !== 'hide' && op !== 'show') fail('不支持的操作');
    await db.updateFresh('walls', w.id, { status: op === 'hide' ? 'hidden' : 'on' });
    if (op === 'hide' && w.authorId) {
      ws.notifyUser(w.authorId, '你在校园墙发布的内容因违反社区规范已被隐藏，如有疑问请联系客服');
    }
    return { ok: true, status: op === 'hide' ? 'hidden' : 'on' };
  }, 'admin');

  /* ---------- 学习资源管理 ---------- */
  route('GET', '/admin-api/resources', async (ctx) => {
    const q = ctx.query;
    const status = q.get('status') || 'all';
    const kw = (q.get('keyword') || '').trim();
    let list = (await db.readAllFromDb('resources')).slice();
    if (status === 'hidden') list = list.filter((r) => r.status === 'hidden');
    else if (status === 'on') list = list.filter((r) => r.status === 'on');
    else list = list.filter((r) => r.status !== 'deleted');
    if (kw) list = list.filter((r) => util.match(r.title, kw) || util.match(r.course, kw) || util.match(r.desc, kw));
    list.sort((a, b) => b.createdAt - a.createdAt);
    const page = util.paginate(list, q.get('page'), 12);
    return Object.assign({}, page, {
      list: page.list.map((r) => ({
        id: r.id,
        title: r.title,
        desc: r.desc || '',
        course: r.course || '',
        category: r.category || 'other',
        fileUrl: r.fileUrl || '',
        fileName: r.fileName || '',
        fileExt: r.fileExt || '',
        uploaderId: r.uploaderId || null,
        uploader: deco.sellerBrief(r.uploaderId),
        downloads: r.downloads || 0,
        likeCount: (r.likeBase || 0) + (r.likes || []).length,
        status: r.status || 'on',
        timeText: util.fmtTime(r.createdAt)
      }))
    });
  }, 'admin');

  route('POST', '/admin-api/resources/:id/status', async (ctx) => {
    const r = await db.findByIdFresh('resources', ctx.params.id);
    if (!r) fail('资料不存在', 404);
    const op = (ctx.body || {}).op;
    if (op === 'delete') {
      // 软删除：下载链接可能还留在别人的消息/收藏里，硬删会让那些入口全 404
      await db.updateFresh('resources', r.id, { status: 'deleted' });
      return { ok: true };
    }
    if (op !== 'hide' && op !== 'show') fail('不支持的操作');
    await db.updateFresh('resources', r.id, { status: op === 'hide' ? 'hidden' : 'on' });
    if (op === 'hide' && r.uploaderId) {
      ws.notifyUser(r.uploaderId, '你上传的资料「' + r.title + '」已被管理员隐藏，如有疑问请联系客服');
    }
    return { ok: true, status: op === 'hide' ? 'hidden' : 'on' };
  }, 'admin');

  /* ---------- 拼团管理 ----------
   * 只做「关团」，不做退款：已有付款成员的团不让关（钱的事不能在这里凭空改状态）。
   */
  route('GET', '/admin-api/groups', async (ctx) => {
    const q = ctx.query;
    const status = q.get('status') || 'all';
    let list = (await db.readAllFromDb('groups')).slice();
    if (status !== 'all') {
      const now = Date.now();
      list = list.filter((g) => {
        const st = g.status === 'open' && g.expireAt && g.expireAt < now ? 'failed' : g.status;
        return st === status;
      });
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    const page = util.paginate(list, q.get('page'), 12);
    return Object.assign({}, page, {
      list: page.list.map((g) => {
        const d = group.decoGroup(g, null);
        d.timeText = util.fmtTime(g.createdAt);
        // 成员昵称只给后台看，用于客服核对；不外泄到用户端
        return d;
      })
    });
  }, 'admin');

  route('POST', '/admin-api/groups/:id/close', async (ctx) => {
    const g = await db.findByIdFresh('groups', ctx.params.id);
    if (!g) fail('拼团不存在', 404);
    if (g.status !== 'open') fail('该团已结束，无需关闭');
    const paid = (g.members || []).filter((m) => m.paid);
    if (paid.length) {
      fail('已有 ' + paid.length + ' 人付款，不能直接关团。请先在订单里处理退款后再关闭', 409);
    }
    await db.updateFresh('groups', g.id, { status: 'canceled', canceledAt: Date.now() });
    for (const m of (g.members || [])) {
      if (m.userId) ws.notifyUser(m.userId, '你参与的拼团已被管理员关闭，未付款的订单不会扣款');
    }
    return { ok: true };
  }, 'admin');

  /* ---------- 公告 ---------- */
  route('GET', '/admin-api/notices', async () => ({
    list: (await db.readAllFromDb('notices')).slice().sort((a, b) => b.createdAt - a.createdAt)
      .map((n) => Object.assign({}, n, { timeText: util.fmtTime(n.createdAt) }))
  }), 'admin');

  route('POST', '/admin-api/notices', (ctx) => {
    const b = ctx.body || {};
    const title = util.clampText(b.title, 50);
    const content = util.clampText(b.content, 1000);
    if (!title || !content) fail('标题和内容不能为空');
    const n = db.insert('notices', { title, content, createdAt: Date.now() });
    ws.broadcast({ type: 'notice', title, content });
    return { notice: n };
  }, 'admin');

  route('DELETE', '/admin-api/notices/:id', async (ctx) => {
    // 直接删库（不等 flush）：管理端删公告必须当场可见 ——
    // 只改内存的话，flush 的超时保护可能把删除推迟到"下次调用"，
    // 而紧接着的列表请求落在别的实例上会看到它还在（「删了还在」）。
    await db.removeFresh('notices', ctx.params.id);
    return { ok: true };
  }, 'admin');

  /**
   * 编辑公告。
   *
   * 原来只有「增 / 删」没有「改」—— 公告打错一个字只能删了重发，
   * 但重发会再推一次通知，等于把用户打扰两遍。
   */
  route('PUT', '/admin-api/notices/:id', async (ctx) => {
    const b = ctx.body || {};
    const n = await db.findByIdFresh('notices', ctx.params.id);
    if (!n) fail('公告不存在', 404);
    const patch = {};
    if (b.title !== undefined) {
      const t = util.clampText(b.title, 50);
      if (!t) fail('标题不能为空');
      patch.title = t;
    }
    if (b.content !== undefined) {
      const c = util.clampText(b.content, 1000);
      if (!c) fail('内容不能为空');
      patch.content = c;
    }
    if (!Object.keys(patch).length) fail('没有需要修改的内容');
    const out = await db.updateFresh('notices', n.id, patch);
    // 编辑不推送（避免改个错别字再打扰一遍用户），但要同步刷新在线端的公告列表
    ws.broadcast({ type: 'notice-updated' });
    return { notice: Object.assign({}, out, { timeText: util.fmtTime(out.createdAt) }) };
  }, 'admin');

  /* ---------- 系统设置 ---------- */
  route('GET', '/admin-api/config', () => {
    const cfg = db.load().meta.config || {};
    // AI 配置一律经 llmConfig() 解析：环境变量优先，库里兜底。
    // **永远不回显 apiKey**，只回 hasKey + keySource —— 后台页面据此显示
    // 「已通过云函数环境变量配置（优先级更高）」，避免有人在后台填了 key 却没生效。
    const aiCfg = require('./ai-assist').llmConfig();
    return {
      config: {
        platform: cfg.platform || '科贸小鱼',
        subtitle: cfg.subtitle || '',
        autoApprove: cfg.autoApprove !== false,
        ai: {
          baseUrl: aiCfg.baseUrl || '',
          model: aiCfg.model || '',
          hasKey: !!aiCfg.apiKey,
          keySource: aiCfg.source,                    // env | db | none
          envLocked: aiCfg.source === 'env'           // 环境变量优先时，后台改不动 key
        }
      }
    };
  }, 'admin');

  route('POST', '/admin-api/config', (ctx) => {
    const b = ctx.body || {};
    const meta = db.load().meta;
    meta.config = meta.config || {};
    if (b.autoApprove !== undefined) meta.config.autoApprove = !!b.autoApprove;
    if (b.ai) {
      // 环境变量里配了 key 就不写库：写进去也用不上，反而多一份明文留存
      const envKey = String((process.env || {}).AI_API_KEY || '').trim();
      meta.config.ai = {
        baseUrl: util.clampText(b.ai.baseUrl, 200),
        model: util.clampText(b.ai.model, 60),
        apiKey: envKey
          ? ((meta.config.ai && meta.config.ai.apiKey) || '')
          : (b.ai.apiKey ? util.clampText(b.ai.apiKey, 200) : ((meta.config.ai && meta.config.ai.apiKey) || ''))
      };
    }
    db.saveSoon();
    const after = require('./ai-assist').llmConfig();
    return { ok: true, keySource: after.source, note: after.source === 'env' ? '已由环境变量接管，库内配置不再使用' : '' };
  }, 'admin');

  /* ---------- 管理员密码 ----------
   * 后台一旦允许局域网/其它设备访问，默认的 admin/admin 就是**敞开的大门**。
   * 改密码时顺手清掉其它 admin 会话 —— 否则「改了密码，旧 token 仍然能用」，
   * 改了个寂寞。
   */
  route('POST', '/admin-api/password', async (ctx) => {
    const b = ctx.body || {};
    const me = ctx.admin || {};
    const data = db.load();
    const admin = (data.meta && data.meta.admin) || null;
    if (!admin || admin.username !== me.username) fail('管理员账号不存在', 404);
    if (String(b.oldPassword || '') !== admin.password) fail('原密码不正确', 403);
    const pwd = String(b.newPassword || '');
    if (pwd.length < 6) fail('新密码至少 6 位');
    if (pwd === admin.password) fail('新密码不能与原密码相同');
    admin.password = pwd;
    db.saveSoon();
    // 让其它会话失效（当前这个保留，用户不用重新登录）
    const others = db.find('sessions', (s) => s.type === 'admin' && s.token !== ctx.token);
    for (const s of others) { try { await auth.destroySession(s.token); } catch (e) { /* 忽略 */ } }
    return { ok: true, killed: others.length };
  }, 'admin');

  /* ---------- 评论管理 ----------
   * 为什么要有：评论支持配图之后，后台得能看到图片、能删掉违规评论。
   * 之前后台只有「圈子管理（帖子）」，评论完全不可见，
   * 只能把整条帖子删掉 —— 副作用太大。
   */
  route('GET', '/admin-api/comments', async (ctx) => {
    const q = ctx.query;
    const kw = (q.get('keyword') || '').trim();
    const postId = util.num(q.get('postId'));
    let list = [];
    try { list = await db.readAllFromDb('comments'); } catch (e) { list = db.find('comments', () => true); }
    if (!list || !list.length) list = db.find('comments', () => true);
    if (postId) list = list.filter((c) => Number(c.postId) === postId);
    if (kw) {
      list = list.filter((c) => util.match(c.content, kw) || (c.images || []).length);
    }
    list = list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const page = util.paginate(list, q.get('page'), 12);

    // 所属帖子的摘要：一次读全量，避免逐条查库
    let posts = [];
    try { posts = await db.readAllFromDb('posts'); } catch (e) { posts = db.find('posts', () => true); }
    const pmap = {};
    for (const p of (posts || [])) pmap[Number(p.id)] = p;

    // 作者昵称/头像：列表页 TTL 节流即可
    if (typeof db.warmUsers === 'function') {
      try { await db.warmUsers(page.list.map((c) => c.authorId)); } catch (e) { /* 忽略 */ }
    }

    return Object.assign({}, page, {
      list: page.list.map((c) => {
        const p = pmap[Number(c.postId)] || {};
        return {
          id: c.id,
          postId: c.postId,
          content: c.content || '',
          // 配图：老评论没有这个字段 → 空数组（后台显示「—」）
          images: c.images || [],
          author: deco.sellerBrief(c.authorId),
          postText: String(p.content || '').slice(0, 40),
          timeText: util.fmtTime(c.createdAt || 0)
        };
      })
    });
  }, 'admin');

  route('DELETE', '/admin-api/comments/:id', async (ctx) => {
    // 直查兜底：评论可能是别的实例写的
    const f = await db.findByIdWithFallback('comments', ctx.params.id);
    const c = f.doc;
    if (!c) fail('评论不存在', 404);
    db.removeById('comments', c.id);
    // 帖子的评论数 -1（不减的话「评论 5 条」但点进去只有 4 条）
    const pf = await db.findByIdWithFallback('posts', c.postId);
    if (pf.doc) {
      pf.doc.commentCount = Math.max(0, Number(pf.doc.commentCount || 0) - 1);
      db.saveSoon();
    }
    try { ws.notifyUser(c.authorId, '你的一条评论被管理员删除，如有疑问请联系客服'); } catch (e) { /* 忽略 */ }
    return { ok: true };
  }, 'admin');
};
