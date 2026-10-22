'use strict';
/** 基础 API：登录 / 用户 / 钱包 / 地址 / 收藏 / 浏览记录 / 公告 / 举报 / 上传 */
const path = require('path');
const fs = require('fs');
const db = require('../db');
const util = require('../util');
const auth = require('../auth');
const deco = require('../deco');
const ws = require('../ws');
const it = require('../interactions');

function needUser(ctx) {
  if (!ctx.user) { const e = new Error('请先登录'); e.status = 401; throw e; }
  return ctx.user;
}
function fail(message, status) { const e = new Error(message); e.status = status || 400; throw e; }

module.exports = function register(route) {
  /* ---------- 登录 / 会话 ---------- */
  route('POST', '/api/login', (ctx) => {
    const { nickname, avatar, testUserId } = ctx.body || {};
    let user = null;
    let isNew = false;
    if (testUserId) {
      user = db.findById('users', testUserId);
      if (!user) fail('测试账号不存在');
    } else {
      const pool = ['a01', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07', 'a08'];
      const suffix = Math.random().toString(36).slice(2, 6);
      user = db.insert('users', {
        nickname: util.clampText(nickname, 20) || ('微信用户' + suffix),
        avatar: avatar || ('/static/avatars/' + pool[Math.floor(Math.random() * pool.length)] + '.jpg'),
        openid: 'dev_' + util.randomToken(8),
        gender: 0, bio: '', college: '', grade: '',
        campus: '广东科贸职业学院（清远校区）', credit: 80, cert: 'none',
        balance: 0, status: 'normal', noticeRead: [], joinedAt: Date.now()
      });
      isNew = true;
      ws.notifyUser(user.id, '欢迎来到科贸小鱼！我是 AI 客服小校助手。可以先逛逛首页，或点底部「+」发布你的第一件闲置～ 有任何问题随时找我。');
    }
    const token = auth.createSession(user.id);
    return { token, user: util.publicUser(user), isNew };
  });

  route('POST', '/api/logout', (ctx) => { auth.destroySession(ctx.token); return { ok: true }; });

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
    const out = util.publicUser(Object.assign({}, me));
    // 走「以库为准」的统计：本地单实例其实等价，但两侧保持同构，避免以后跑偏
    out.stats = await deco.userStatsFresh(me.id);
    return { user: out };
  });

  route('PATCH', '/api/me', (ctx) => {
    const me = needUser(ctx);
    const b = ctx.body || {};
    const patch = {};
    for (const k of ['nickname', 'avatar', 'bio', 'college', 'grade', 'campus', 'gender', 'contact']) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    if (patch.nickname !== undefined) patch.nickname = util.clampText(patch.nickname, 20) || me.nickname;
    if (patch.bio !== undefined) patch.bio = util.clampText(patch.bio, 60);
    if (patch.college !== undefined && patch.college && me.cert === 'none') patch.cert = 'student';
    const user = db.update('users', me.id, patch);
    return { user: util.publicUser(user) };
  });

  /* ---------- 他人主页 ---------- */
  route('GET', '/api/users/:id', (ctx) => {
    const u = db.findById('users', ctx.params.id);
    if (!u) fail('用户不存在', 404);
    const me = ctx.user;
    const listings = db.find('listings', (l) => l.sellerId === u.id && l.status === 'on')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((l) => deco.decorateListing(l, me));
    const isFollowed = me ? !!db.one('follows', (f) => f.userId === me.id && f.targetUserId === u.id) : false;
    const out = util.publicUser(u);
    out.stats = deco.userStats(u.id);
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
  route('GET', '/api/wallet', (ctx) => {
    const me = needUser(ctx);
    const list = db.find('transactions', (t) => t.userId === me.id).sort((a, b) => b.createdAt - a.createdAt);
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
  route('GET', '/api/favorites', (ctx) => {
    const me = needUser(ctx);
    const type = ctx.query.get('type') || 'listing';
    const favs = db.find('favorites', (f) => f.userId === me.id && f.targetType === type).sort((a, b) => b.createdAt - a.createdAt);
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

  route('POST', '/api/favorites/toggle', (ctx) => {
    const me = needUser(ctx);
    const { targetType, targetId } = ctx.body || {};
    if (!['listing', 'post'].includes(targetType) || !targetId) fail('参数错误');
    const existed = db.one('favorites', (f) => f.userId === me.id && f.targetType === targetType && f.targetId === Number(targetId));
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
  route('GET', '/api/notices', (ctx) => {
    const me = ctx.user;
    const read = me ? (me.noticeRead || []) : [];
    const list = db.get('notices').slice().sort((a, b) => b.createdAt - a.createdAt)
      .map((n) => Object.assign({}, n, { read: read.indexOf(n.id) !== -1, timeText: util.relTime(n.createdAt) }));
    return { list, unread: list.filter((n) => !n.read).length };
  });

  /**
   * 单条公告详情（与云函数版同名同语义）。
   * 首页公告原来点下去是 switchTab 到校园圈子 —— 那是错的，现在进本接口驱动的详情页。
   */
  route('GET', '/api/notices/:id', (ctx) => {
    const n = db.findById('notices', ctx.params.id);
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
  route('POST', '/api/upload', (ctx) => new Promise((resolve, reject) => {
    needUser(ctx);
    let Busboy;
    try { Busboy = require('busboy'); } catch (e) { reject(Object.assign(new Error('上传组件未安装'), { status: 500 })); return; }
    let bb;
    try {
      bb = Busboy({ headers: ctx.req.headers, limits: { fileSize: 30 * 1024 * 1024 } });
    } catch (e) { reject(Object.assign(new Error('上传格式错误'), { status: 400 })); return; }
    const urls = [];
    const metas = [];
    let pending = 0;
    let done = false;
    const MIME_EXT = {
      'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/jpeg': '.jpg',
      'application/pdf': '.pdf', 'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.ms-powerpoint': '.ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'text/plain': '.txt', 'text/markdown': '.md', 'application/x-rar-compressed': '.rar',
      'application/vnd.rar': '.rar', 'application/octet-stream': ''
    };
    bb.on('file', (name, file, info) => {
      const mime = info.mimeType || 'application/octet-stream';
      const rawName = String(info.filename || '');
      let ext = '';
      const m = rawName.match(/\.[A-Za-z0-9]{1,8}$/);
      if (m) ext = m[0].toLowerCase();
      if (!ext) ext = MIME_EXT[mime] || '';
      const fn = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext;
      const dir = path.join(__dirname, '..', '..', 'static', 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, fn);
      pending++;
      let size = 0;
      file.on('data', (c) => { size += c.length; });
      const out = fs.createWriteStream(fp);
      file.pipe(out);
      out.on('close', () => {
        const url = '/static/uploads/' + fn;
        urls.push(url);
        metas.push({ url, name: rawName || fn, ext, size, mime });
        pending--;
      });
    });
    bb.on('close', () => {
      done = true;
      if (!urls.length) reject(Object.assign(new Error('未收到文件'), { status: 400 }));
      else resolve({ urls, url: urls[0], files: metas, file: metas[0] });
    });
    bb.on('error', () => reject(Object.assign(new Error('上传失败'), { status: 500 })));
    ctx.req.pipe(bb);
  }));
};
