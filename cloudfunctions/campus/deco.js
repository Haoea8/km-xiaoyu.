'use strict';
/** 数据装饰：给原始记录补充前端所需的关联信息（卖家 / 作者 / 圈子 / 点赞态等） */
const db = require('./db');
const { ORDER_STATUS } = require('./const');

/** 由一个**用户对象**生成简介（对象是刚从库里查到的权威值时用这个） */
function briefOf(u) {
  if (!u) return { id: 0, nickname: '匿名', avatar: '', missing: true };
  return {
    id: u.id, nickname: u.nickname, avatar: u.avatar, credit: u.credit,
    cert: u.cert, isAI: !!u.isAI, campus: u.campus, bio: u.bio, college: u.college
  };
}

/**
 * 按 id 取用户简介（同步，读内存镜像）。
 *
 * ⚠️ **绝不返回 null**。
 *   调用方全是同步渲染 —— wxml 里直接写 `item.author.nickname`，
 *   一旦这里返回 null，页面上就是**头像和昵称同时空白**。
 *   用户看到的现象是「头像名字掉了」，而真正的原因（本实例内存里没有这个人，
 *   或内存里还是他改资料之前的旧值）在界面上完全看不出来，
 *   每次都要从前端一路查到云函数内存镜像才能定位。
 *
 *   所以这里退化成**占位作者**：昵称「用户<id>」、头像留空。
 *   头像**故意留空**——前端会用昵称首字画一个圆形字标兜底（见 post-detail 的
 *   .avatar-box），比灰块清楚，也避免去请求一个不存在的图片。
 *
 *   正常情况下真实资料由 `db.refreshUsers(ids)` 提前以库为准查回来，
 *   这个占位只是最后一道保险（真出现了，说明用户在数据库里确实不存在）。
 */
function sellerBrief(id) {
  const n = Number(id);
  const u = n ? db.findById('users', n) : null;
  if (!u) return { id: n || 0, nickname: n ? ('用户' + n) : '匿名', avatar: '', missing: true };
  return briefOf(u);
}

function isFav(me, type, id) {
  return !!db.one('favorites', (f) => f.userId === me.id && f.targetType === type && f.targetId === Number(id));
}

function decorateListing(l, me) {
  if (!l) return null;
  const out = Object.assign({}, l);
  out.seller = sellerBrief(l.sellerId);
  out.isFavorite = me ? isFav(me, 'listing', l.id) : false;
  out.isMine = me ? l.sellerId === me.id : false;
  out.timeText = require('./util').relTime(l.createdAt);
  return out;
}

function decorateOrder(o, me) {
  if (!o) return null;
  const out = Object.assign({}, o);
  out.buyer = sellerBrief(o.buyerId);
  out.seller = sellerBrief(o.sellerId);
  out.isBuyer = me ? o.buyerId === me.id : false;
  // 自买自卖（历史测试单）：两侧是同一个人，页面不该出现「联系买家/卖家」
  out.isSelfOrder = String(o.buyerId) === String(o.sellerId);
  out.statusText = ORDER_STATUS[o.status] || o.status;
  out.timeText = require('./util').relTime(o.createdAt);
  return out;
}

function decoratePost(p, me) {
  if (!p) return null;
  const out = Object.assign({}, p);
  out.author = sellerBrief(p.authorId);
  const circle = db.findById('circles', p.circleId);
  out.circle = circle ? { id: circle.id, name: circle.name, icon: circle.icon, color: circle.color } : null;
  out.likeCount = (p.likeBase || 0) + (p.likes ? p.likes.length : 0);
  out.liked = me ? (p.likes || []).indexOf(me.id) !== -1 : false;
  // 收藏状态：前端要据此把星标变红实心。
  // 原先**漏了这个字段**（decorateListing 有、decoratePost 没有），
  // 于是帖子详情页永远不知道"我收藏过没"，图标也就永远不变 —— 这是「收藏没反馈」的一半原因。
  // 注意 isFav 读内存，调用方需要先 await db.warmFavorites(me.id) 把它补准。
  out.isFavorite = me ? isFav(me, 'post', p.id) : false;
  out.isMine = me ? p.authorId === me.id : false;
  out.timeText = require('./util').relTime(p.createdAt);
  return out;
}

/**
 * 用**评论集合的真实条数**覆盖这批帖子（副本）上的 `commentCount`。
 *
 * 为什么需要它：`commentCount` 是**派生字段** —— 发评论 +1、删评论 -1、
 * 历史上还有一段「按本实例内存条数重算」，于是不同实例写出来的值会互相覆盖，
 * 留下与真实评论数不符的脏值。而读的地方把它当唯一真相，
 * 前端就会看到「列表上的数字」与「详情页实际列出的条数」长期对不上。
 *
 * 用户反馈的原话：「从外面看明明显示有两条评论，进去后却一条都没有」。
 *
 * 做法与 `decoConv` 里 lastMessage 的处理一致：**使用处从源数据重新推导**，
 * 存储字段退化成兜底（读库失败时仍显示存储值，至少不空白）。
 *
 * ⚠️ 只允许改**传进来的副本**。调用方要先 `deco.decoratePost()`（它内部是
 *    `Object.assign({}, p)` 浅拷贝）再调用本函数 —— 直接改内存里的原对象
 *    会被 `markChangedByDiff` 当成变更写回库。
 *
 * @param {Array} posts 已装饰过的帖子副本数组
 * @returns {Promise<Array>} 同一个数组（原地改 commentCount）
 */
async function realCommentCounts(posts) {
  const arr = posts || [];
  if (!arr.length) return arr;
  try {
    // 严格模式：读失败要抛出，否则「读失败」会被当成「一条评论都没有」
    // → 把正确的数字覆盖成 0，比不修更糟。
    const all = await db.readAllFromDb('comments', true);
    const cnt = Object.create(null);
    for (const c of (all || [])) {
      const k = Number(c.postId);
      if (k) cnt[k] = (cnt[k] || 0) + 1;
    }
    for (const p of arr) p.commentCount = cnt[Number(p.id)] || 0;
  } catch (e) { /* 读库失败 → 保留存储值 */ }
  return arr;
}

function userStats(userId) {
  const listings = db.find('listings', (l) => l.sellerId === userId);
  const posts = db.find('posts', (p) => p.authorId === userId);
  const orders = db.find('orders', (o) => o.buyerId === userId || o.sellerId === userId);
  return {
    published: listings.filter((l) => l.status === 'on').length,
    sold: listings.filter((l) => l.status === 'sold').length + orders.filter((o) => o.sellerId === userId && o.status === 'done').length,
    bought: orders.filter((o) => o.buyerId === userId && o.status === 'done').length,
    favorites: db.find('favorites', (f) => f.userId === userId).length,
    posts: posts.length,
    following: db.find('follows', (f) => f.userId === userId).length,
    followers: db.find('follows', (f) => f.targetUserId === userId).length
  };
}

/**
 * 以**数据库**为准的用户统计（异步版）。
 *
 * 为什么需要它（用户真实反馈）：
 *   「明明只收藏了一个，不断刷新却时不时显示 1 个、2 个」；
 *   在售 / 已卖出 / 已买到 也有同样的抖动。
 *
 * 根因还是多实例的内存快照：上面的 userStats 走 `db.find`，读的是**本实例
 * 冷启动那一刻**的数据。收藏写进了实例 A，刷新时请求落到实例 B ——
 * B 里没有这条（或还留着已取消的旧记录），数字就一会儿 1 一会儿 2。
 *
 * 这些数字是「用户正盯着看」的，不能容忍 10 秒 TTL 或快照误差，
 * 所以个人主页 / 我的页**一律用这个从库里数**。集合都不大，代价可接受。
 */
async function userStatsFresh(userId) {
  const uid = Number(userId) || 0;
  const pull = async (name) => {
    try {
      const rows = await db.readAllFromDb(name);
      if (rows && rows.length) return rows;
    } catch (e) { /* 读库失败 → 退回内存，至少别把页面搞挂 */ }
    return db.find(name, () => true);
  };
  const [listings, posts, orders, favorites, follows] = await Promise.all([
    pull('listings'), pull('posts'), pull('orders'), pull('favorites'), pull('follows')
  ]);
  const mine = (rows, field) => rows.filter((x) => Number(x[field]) === uid);
  const myListings = mine(listings, 'sellerId');
  const myOrders = orders.filter((o) => Number(o.buyerId) === uid || Number(o.sellerId) === uid);
  return {
    published: myListings.filter((l) => l.status === 'on').length,
    sold: myListings.filter((l) => l.status === 'sold').length +
      myOrders.filter((o) => Number(o.sellerId) === uid && o.status === 'done').length,
    bought: myOrders.filter((o) => Number(o.buyerId) === uid && o.status === 'done').length,
    favorites: mine(favorites, 'userId').length,
    posts: mine(posts, 'authorId').length,
    following: mine(follows, 'userId').length,
    followers: follows.filter((f) => Number(f.targetUserId) === uid).length
  };
}

module.exports = { sellerBrief, briefOf, decorateListing, decorateOrder, decoratePost, realCommentCounts, userStats, userStatsFresh, isFav };
