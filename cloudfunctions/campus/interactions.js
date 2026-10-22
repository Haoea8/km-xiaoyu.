'use strict';
/**
 * 互动消息（点赞 / 评论 / 回复 / 收藏 / 关注…）
 *
 * 与「聊天式通知」是两套东西，别混：
 *   - 业务/系统通知（订单、拼团、审核、欢迎语）→ events.notifyUser 写进
 *     「用户 ↔ AI 助手」会话，属于通知中心；
 *   - **他人对我的内容做的互动** → 写 interactions 集合，走独立的
 *     「互动消息」页（pages/interaction），像抖音的消息页那样单独成框。
 *
 * 设计要点（踩过的坑都在这里）：
 *
 * 1) **不给自己发**：toUserId === actorId 直接丢弃。
 *    否则「自己给自己的帖子点赞/收藏」也会冒一条红点，用户会以为程序坏了。
 *
 * 2) **短时间内的重复互动要合并**：同一个人对同一个对象的同类动作用
 *    30 分钟窗口去重，只保留一条（刷新时间 + 重新置为未读）。
 *    否则「点赞 → 取消 → 再点赞」会在列表里刷出好几条一模一样的。
 *
 * 3) **只存事实，不存昵称头像**：actor 的昵称/头像在**读取时**才装饰。
 *    对方改了名，我们这边历史消息也要跟着变新 —— 和 deco.sellerBrief 同源。
 *
 * 4) **读取一律直查数据库**：云端是多实例，内存镜像只是冷启动快照、永不刷新
 *    （详见 db.js 顶部说明）。只读内存会「别人给我点了赞，我这儿一个都没有」。
 *
 * 5) 本文件在 cloudfunctions/campus/ 与 server/src/ 下**完全一致**（镜像文件），
 *    差异用 `typeof db.xxx === 'function'` 探测，避免两份代码慢慢跑偏。
 */
const db = require('./db');
const deco = require('./deco');
const util = require('./util');

/** 同一 (toUserId, actorId, type, targetId) 在该时间窗内只保留一条 */
const MERGE_WINDOW = 30 * 60 * 1000;

/** 拉取策略：单个用户最多回捞多少条互动 */
const WARM_LIMIT = 500;

/** warm 的节流窗口（毫秒）：避免每次刷新角标都去查一次库 */
const WARM_TTL = 15 * 1000;

/**
 * 互动类型表。
 *   text   —— 「<对方昵称> <text>」，昵称在展示时拼
 *   target —— 点进去要跳到哪里（页面对照见 linkOf）
 */
const TYPES = {
  post_like: { text: '赞了你的帖子', target: 'post' },
  post_comment: { text: '评论了你的帖子', target: 'post' },
  comment_reply: { text: '回复了你', target: 'post' },
  /* ⚠ 目前**没有入口**（保留备用）：帖子评论还没有「点赞」功能 ——
     前端没有调用、后端也没有路由，所以不会有 comment_like 记录。
     将来给帖子评论加点赞时，在 route-social.js 的点赞路由里
     it.add({ type: 'comment_like', toUserId: c.authorId, ... }) 即可
     （写法可对照 route-extend.js 里校园墙的 wall_comment_like）。 */
  comment_like: { text: '赞了你的评论', target: 'post' },
  wall_like: { text: '赞了你的校园墙', target: 'wall' },
  wall_comment: { text: '评论了你的校园墙', target: 'wall' },
  wall_comment_like: { text: '赞了你的评论', target: 'wall' },
  listing_fav: { text: '收藏了你的商品', target: 'listing' },
  listing_want: { text: '想要你的商品', target: 'listing' },
  post_fav: { text: '收藏了你的帖子', target: 'post' },
  resource_like: { text: '赞了你的资料', target: 'resource' },
  follow: { text: '关注了你', target: 'user' }
};

/** 单行摘要裁短（评论正文可能很长，列表只展示一行） */
function brief(t, n) {
  return String(t === undefined || t === null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, n || 40);
}

/* ---------------- 写入 ---------------- */

/**
 * 写入一条互动消息。
 *
 * @param {object} opts
 *   toUserId  收件人（被点赞/被评论/被收藏的人）
 *   actorId   动作发起人
 *   type      TYPES 里的键
 *   targetId  互动发生在哪个对象上（帖子/商品/墙/资料的 id）
 *   targetType 可选，默认取 TYPES[type].target
 *   commentId 可选，评论类互动带上是哪条评论
 *   text      可选，正文摘要（评论内容）
 *   title     可选，主体标题（商品名 / 帖子摘要）
 *   image     可选，主体缩略图
 *   actorName 可选，**只给匿名场景用**（校园墙）：传了它就只展示这个昵称，
 *             不再出售 deco 的真实昵称/头像 —— 否则匿名评论者一点进互动消息
 *             就被反查出来了（校园墙的核心功能就是匿名，见 route-extend.js）。
 * @returns {object|null} 新写入或被合并的那条记录；被忽略时返回 null
 */
function add(opts) {
  const o = opts || {};
  const toUserId = Number(o.toUserId);
  const actorId = Number(o.actorId);
  if (!toUserId || !actorId) return null;
  // 1) 自己对自己：不提醒
  if (toUserId === actorId) return null;
  const meta = TYPES[o.type];
  if (!meta) return null;
  // 2) 收件人必须存在，且不能是 AI 助手（AI 没有「我的帖子」）
  const to = db.findById('users', toUserId);
  if (!to || to.isAI) return null;

  const targetId = Number(o.targetId) || 0;
  const now = Date.now();
  const patch = {
    text: meta.text,
    content: brief(o.text, 40),
    title: brief(o.title, 40),
    image: o.image || '',
    // 有值就代表「只展示这个昵称」；为空则照常按 actorId 装饰真实资料。
    // 走 patch 是为了合并路径也能把旧的匿名昵称清掉（同一人后来非匿名互动时）。
    actorName: o.actorName ? brief(o.actorName, 20) : ''
  };

  // 3) 合并窗口内同人同对象的同类互动
  const dup = db.one('interactions', (r) =>
    Number(r.toUserId) === toUserId &&
    Number(r.actorId) === actorId &&
    r.type === o.type &&
    Number(r.targetId) === targetId &&
    now - Number(r.createdAt || 0) < MERGE_WINDOW);
  if (dup) {
    // 置回未读：用户可能已经看过上一条，这次是**新的**互动
    db.update('interactions', dup.id, Object.assign({}, patch, { read: false, createdAt: now }));
    db.saveSoon();
    return db.findById('interactions', dup.id);
  }

  const rec = db.insert('interactions', Object.assign({
    toUserId,
    actorId,
    type: o.type,
    targetType: o.targetType || meta.target,
    targetId,
    commentId: Number(o.commentId) || 0,
    read: false,
    createdAt: now
  }, patch));
  db.saveSoon();
  return rec;
}

/**
 * 把库里「已读」的标记合并进内存（**只做 false → true 的单向合并**）。
 *
 * 为什么需要（这是「红点点进去看了，退出来红点还在」的真因）：
 *   `db.fetchByField` **不覆盖**内存里已有的同 id 记录（怕冲掉本实例还没落库的改动）。
 *   于是在实例 A 点开互动消息、已读写进库之后，实例 B 的内存里这些记录**永远**
 *   停在 read:false —— 角标算出来一直是正数，而且不会自己好（内存镜像永不刷新）。
 *   read 只可能 false→true（没有人会把已读改回未读），所以单向合并是安全的。
 *
 * @param {Array} rows 刚从库里读回来的互动记录
 */
function reconcileRead(rows) {
  const list = rows || [];
  if (!list.length) return 0;
  const byId = new Map(db.get('interactions').map((x) => [String(x.id), x]));
  let fixed = 0;
  for (const r of list) {
    const m = byId.get(String(r.id));
    if (m && r.read && !m.read) { m.read = true; fixed++; }
  }
  return fixed;
}

/** 把某用户的互动消息回捞进内存镜像（云端多实例必需；本地是空操作） */
async function warm(userId, force) {
  const uid = Number(userId);
  if (!uid) return;
  if (typeof db.fetchByField !== 'function') return;    // 本地单实例：内存即真相
  const now = Date.now();
  if (!force && warm._at[uid] && now - warm._at[uid] < WARM_TTL) return;
  warm._at[uid] = now;

  const have = () => new Set(db.get('interactions').map((x) => String(x.id)));
  try {
    const got = await db.fetchByField('interactions', 'toUserId', uid, WARM_LIMIT);
    if (got && got.length) { reconcileRead(got); return; }
  } catch (e) { /* 继续走全量兜底 */ }
  /**
   * 兜底：`where({toUserId})` 在字段类型不一致（历史数据存成字符串）时
   * **会静默返回空数组、不报错** —— 表现就是「互动消息页明明有红点却一条都没有」。
   * 这里按项目惯例再全量拉一次，用 Number() 比对。
   */
  if (typeof db.readAllFromDb !== 'function') return;
  try {
    const all = await db.readAllFromDb('interactions', true);
    const mine = (all || []).filter((r) => Number(r.toUserId) === uid);
    if (!mine.length) return;
    const seen = have();
    for (const r of mine) if (!seen.has(String(r.id))) db.get('interactions').push(r);
    reconcileRead(mine);
  } catch (e) { /* 忽略：至少还有内存兜底 */ }
}
warm._at = {};

/* ---------------- 读取 / 展示 ---------------- */

/** 互动消息点进去要去的页面 */
function linkOf(r) {
  // 「关注了你」有意义的去处是**对方的主页**（targetId 是收件人自己，不能用）
  if (r.type === 'follow') return '/pages/user/user?id=' + (Number(r.actorId) || 0);
  const t = r.targetType || ((TYPES[r.type] || {}).target) || 'post';
  const id = Number(r.targetId) || 0;
  if (!id) return '';
  if (t === 'listing') return '/pages/detail/detail?id=' + id;
  if (t === 'wall') return '/pages/wall-detail/wall-detail?id=' + id;
  if (t === 'resource') return '/pages/resource-detail/resource-detail?id=' + id;
  if (t === 'user') return '/pages/user/user?id=' + id;
  return '/pages/post-detail/post-detail?id=' + id;
}

/**
 * 装饰成前端直接可渲染的一行。
 *
 * ⚠️ `deco.sellerBrief` 是**同步读内存**的，actor 的资料必须先 warm/refresh 过，
 *    否则会渲染成「用户123」占位（看起来像昵称丢了）。
 */
function decorate(r) {
  const meta = TYPES[r.type] || { text: '有新互动', target: 'post' };
  return {
    id: r.id,
    type: r.type,
    /**
     * 匿名场景（校园墙）只给匿名昵称，`id: 0` 也保证前端不会拿它去跳主页，
     * 否则「点一下头像 → 跳到匿名评论者的个人主页」等于直接公开了身份。
     */
    actor: r.actorName
      ? { id: 0, nickname: String(r.actorName), avatar: '' }
      : deco.sellerBrief(r.actorId),
    typeText: meta.text,
    content: r.content || '',
    title: r.title || '',
    image: r.image || '',
    targetType: r.targetType || meta.target,
    targetId: Number(r.targetId) || 0,
    commentId: Number(r.commentId) || 0,
    read: !!r.read,
    createdAt: r.createdAt || 0,
    timeText: util.relTime(r.createdAt),
    link: linkOf(r)
  };
}

/**
 * 互动消息列表（分页）。
 * @returns {{list:Array, unread:number, total:number, page:number, hasMore:boolean}}
 */
async function list(userId, opts) {
  const uid = Number(userId);
  if (!uid) return { list: [], unread: 0, total: 0, page: 1, hasMore: false };
  const o = opts || {};
  const page = Math.max(1, Number(o.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(o.pageSize) || 20));

  // 第 1 页必定回库（进页面就要看到真实已读状态，红点与列表同口径）；
  // 翻页走节流，省掉每页一次查询。
  await warm(uid, page === 1);
  const rows = db.find('interactions', (r) => Number(r.toUserId) === uid)
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const unread = rows.filter((r) => !r.read).length;
  const total = rows.length;
  const start = (page - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);

  // actor 的昵称/头像：列表页用 TTL 节流即可（一次几十个，别每页全量点读）
  if (slice.length && typeof db.warmUsers === 'function') {
    try { await db.warmUsers(slice.map((r) => r.actorId)); } catch (e) { /* 忽略 */ }
  }

  return {
    list: slice.map(decorate),
    unread,
    total,
    page,
    hasMore: start + slice.length < total
  };
}

/** 未读数（消息 tab 角标 / 互动入口红点用） */
async function unreadCount(userId) {
  const uid = Number(userId);
  if (!uid) return 0;
  /**
   * ⚠️ 这里必须 **force**（不看 15 秒节流）。
   *
   * 节流省下的是「一次 where 查询」，代价却是「红点残留」：
   * 用户点进互动消息看完退出来，本实例若还在 TTL 窗口内就不会回库，
   * 算出来的未读仍是旧值 → 红点不消失，直到下一次冷启动。
   * 用户不会认为这是「省了一次查询」，只会认为坏了。
   */
  await warm(uid, true);
  return db.find('interactions', (r) => Number(r.toUserId) === uid && !r.read).length;
}

/**
 * 标记已读。
 * @param {number} id 传 0/不传 = 全部已读（进页面时用）
 */
async function markRead(userId, id) {
  const uid = Number(userId);
  if (!uid) return { unread: 0 };
  const target = Number(id) || 0;
  // force：刚看完就点刷新，不能被 15 秒节流挡在旧数据上
  await warm(uid, true);
  const rows = db.find('interactions', (r) => Number(r.toUserId) === uid);
  let changed = 0;
  for (const r of rows) {
    if (target && Number(r.id) !== target) continue;
    if (r.read) continue;
    // 必须走 db.update（它会 markDirty），直接改字段 + saveSoon 在云函数版里不落库
    db.update('interactions', r.id, { read: true });
    changed++;
  }
  const unread = rows.filter((r) => !r.read).length;
  return { ok: true, changed, unread };
}

module.exports = { TYPES, MERGE_WINDOW, add, list, unreadCount, markRead, linkOf, decorate };
