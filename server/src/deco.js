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
 * ⚠️ **绝不返回 null**（与云函数版保持一致，见 cloudfunctions/campus/deco.js）。
 * 调用方全是同步渲染，wxml 里直接写 `item.author.nickname`；
 * 一旦返回 null，页面上就是**头像和昵称同时空白**。
 * 这里退化成占位作者：昵称「用户<id>」、头像留空（前端用昵称首字画圆形字标兜底）。
 *
 * 本地单实例模式下内存即真相，占位基本不会出现；
 * 保留它是为了**云端/本地行为一致**，避免同一份前端在两种后端下表现不同。
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
  // 收藏状态：前端要据此把星标变红实心（与云函数版一致，原先这里漏了）
  out.isFavorite = me ? isFav(me, 'post', p.id) : false;
  out.isMine = me ? p.authorId === me.id : false;
  out.timeText = require('./util').relTime(p.createdAt);
  return out;
}

/**
 * 用**评论的真实条数**覆盖这批帖子（副本）上的 `commentCount`。
 *
 * 与云函数版同名同语义（见 cloudfunctions/campus/deco.js）：
 * `commentCount` 是派生字段，被多处写、读过它的地方又当唯一真相，
 * 于是历史脏值会让「列表上的数字」与「详情页实际列出的条数」对不上
 * （用户反馈：「从外面看明明显示有两条评论，进去后却一条都没有」）。
 *
 * 本地服务是单实例、内存即真相，所以直接按内存统计即可。
 * 返回同步结果；调用方写 `await` 也没关系（await 一个非 Promise 是合法的）。
 */
function realCommentCounts(posts) {
  const arr = posts || [];
  if (!arr.length) return arr;
  const cnt = Object.create(null);
  for (const c of db.get('comments')) {
    const k = Number(c.postId);
    if (k) cnt[k] = (cnt[k] || 0) + 1;
  }
  for (const p of arr) p.commentCount = cnt[Number(p.id)] || 0;
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
