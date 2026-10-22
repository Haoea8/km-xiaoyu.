'use strict';
/**
 * 拼团核心逻辑：自动匹配成团 / 参团 / 成团判定 / 到期处理
 * 被 routes/extend.js（拼团 API）与 routes/trade.js（支付回调）共用
 */
const db = require('./db');
const ws = require('./events');

const MIN = 60 * 1000;

/** 从商品属性里解析成团人数 */
function parseTarget(listing) {
  const raw = (listing.attrs && (listing.attrs['成团人数'] || listing.attrs['目标人数'])) || '';
  const m = String(raw).match(/\d+/);
  const n = m ? Number(m[0]) : 0;
  return Math.max(2, Math.min(50, n || 3));
}

/** 解析截团时间描述 → 时间戳（支持"本周日""3天后""48小时"等，无法识别则默认 3 天） */
function parseExpire(listing, from) {
  const base = from || Date.now();
  const raw = (listing.attrs && (listing.attrs['截止'] || listing.attrs['截团时间'])) || '';
  const s = String(raw);
  const h = s.match(/(\d+)\s*小时/);
  const d = s.match(/(\d+)\s*天/);
  if (h) return base + Number(h[1]) * 60 * MIN;
  if (d) return base + Number(d[1]) * 24 * 60 * MIN;
  const week = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
  const w = s.match(/周([一二三四五六日天])/);
  if (w) {
    const target = week[w[1]];
    const now = new Date(base);
    const cur = now.getDay() === 0 ? 7 : now.getDay();
    let diff = target - cur;
    if (diff <= 0) diff += 7;
    const end = new Date(base + diff * 24 * 60 * MIN);
    end.setHours(23, 59, 59, 0);
    return end.getTime();
  }
  return base + 3 * 24 * 60 * MIN;
}

/** 团进度装饰 */
function decoGroup(g, me) {
  const listing = db.findById('listings', g.listingId);
  const members = (g.members || []).map((m) => {
    const u = db.findById('users', m.userId);
    return {
      userId: m.userId,
      nickname: u ? u.nickname : '同学',
      avatar: u ? u.avatar : '',
      isLeader: m.userId === g.leaderId,
      paid: !!m.paid,
      joinedAt: m.joinedAt,
      orderId: m.orderId || null
    };
  });
  const paidCount = members.filter((m) => m.paid).length;
  const left = Math.max(0, g.targetCount - paidCount);
  const now = Date.now();
  const status = g.status === 'open' && g.expireAt && g.expireAt < now ? 'failed' : g.status;
  return {
    id: g.id,
    listingId: g.listingId,
    listing: listing ? {
      id: listing.id, title: listing.title, price: listing.price, priceUnit: listing.priceUnit,
      image: (listing.images && listing.images[0]) || '', zone: listing.zone, tradeMode: listing.tradeMode
    } : null,
    leaderId: g.leaderId,
    targetCount: g.targetCount,
    memberCount: members.length,
    paidCount,
    needCount: left,
    members,
    status,
    statusText: status === 'open' ? (left > 0 ? '还差 ' + left + ' 人成团' : '已成团')
      : status === 'success' ? '拼团成功' : '拼团失败',
    expireAt: g.expireAt,
    expireText: g.expireAt ? require('./util').relTime(g.expireAt) : '',
    successAt: g.successAt || null,
    isMine: me ? (g.members || []).some((m) => m.userId === me.id) : false,
    isLeader: me ? g.leaderId === me.id : false,
    myOrderId: me ? ((g.members || []).find((m) => m.userId === me.id) || {}).orderId || null : null,
    minePaid: me ? !!((g.members || []).find((m) => m.userId === me.id) || {}).paid : false,
    createdAt: g.createdAt
  };
}

/** 自动匹配：找一个「进行中、未满、未过期」的团，优先选人数最多的（更容易成团） */
function findMatchable(listingId, excludeUserId) {
  const now = Date.now();
  const list = db.find('groups', (g) =>
    g.listingId === Number(listingId) &&
    g.status === 'open' &&
    (!g.expireAt || g.expireAt > now) &&
    (g.members || []).length < g.targetCount
  );
  // 排除自己已经在的团
  const filtered = list.filter((g) => !excludeUserId || !(g.members || []).some((m) => m.userId === excludeUserId));
  filtered.sort((a, b) => {
    const d = (b.members || []).length - (a.members || []).length;
    if (d !== 0) return d;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  return filtered[0] || null;
}

/** 成团判定与通知 */
function checkSuccess(g) {
  if (!g || g.status !== 'open') return false;
  const paid = (g.members || []).filter((m) => m.paid).length;
  if (paid >= g.targetCount) {
    g.status = 'success';
    g.successAt = Date.now();
    db.saveSoon();
    const listing = db.findById('listings', g.listingId);
    const title = listing ? listing.title : '拼团商品';
    for (const m of g.members) {
      ws.notifyUser(m.userId, '🎉 拼团成功！「' + title + '」已凑满 ' + g.targetCount + ' 人，等待卖家发货。', {
        groupId: g.id, title, amount: listing ? listing.price : 0
      });
    }
    if (listing) {
      db.update('listings', listing.id, {
        attrs: Object.assign({}, listing.attrs, { 已参团: paid + ' 人', 拼团状态: '已成团' })
      });
    }
    return true;
  }
  return false;
}

/** 订单支付成功后：把参团记录标记为已支付，并尝试成团 */
function onOrderPaid(order, user) {
  if (!order) return null;
  const listing = db.findById('listings', order.listingId);
  if (!listing || listing.tradeMode !== 'group') return null;
  const now = Date.now();
  let g = db.one('groups', (x) =>
    x.listingId === listing.id &&
    (x.members || []).some((m) => m.userId === user.id && m.orderId === order.id)
  );
  if (!g) {
    // 兼容直接下单未走拼团入口的情况：自动补一个团
    const m = findMatchable(listing.id, null);
    if (m) {
      g = m;
      g.members.push({ userId: user.id, joinedAt: now, qty: order.qty || 1, orderId: order.id, paid: true });
    } else {
      g = db.insert('groups', {
        listingId: listing.id, leaderId: user.id, targetCount: parseTarget(listing),
        members: [{ userId: user.id, joinedAt: now, qty: order.qty || 1, orderId: order.id, paid: true }],
        status: 'open', expireAt: parseExpire(listing, now), createdAt: now
      });
    }
  } else {
    const mem = g.members.find((m) => m.userId === user.id && m.orderId === order.id);
    if (mem) mem.paid = true;
  }
  db.saveSoon();
  const paid = (g.members || []).filter((m) => m.paid).length;
  db.update('listings', listing.id, {
    attrs: Object.assign({}, listing.attrs, { 已参团: paid + ' 人' })
  });
  checkSuccess(g);
  return g;
}

/** 发起新团（开团） */
function openGroup(listing, leaderId, qty, orderId) {
  const now = Date.now();
  return db.insert('groups', {
    listingId: listing.id,
    leaderId,
    targetCount: parseTarget(listing),
    members: [{ userId: leaderId, joinedAt: now, qty: qty || 1, orderId: orderId || null, paid: false }],
    status: 'open',
    expireAt: parseExpire(listing, now),
    createdAt: now
  });
}

/** 加入指定团 */
function joinGroup(g, userId, qty, orderId) {
  if (!g) return null;
  const now = Date.now();
  const exist = (g.members || []).find((m) => m.userId === userId);
  if (exist) {
    if (orderId) exist.orderId = orderId;
    exist.paid = false;
    db.saveSoon();
    return g;
  }
  g.members.push({ userId, joinedAt: now, qty: qty || 1, orderId: orderId || null, paid: false });
  db.saveSoon();
  return g;
}

/** 到期未成团的团 → failed（查询时惰性执行） */
function sweepExpired() {
  const now = Date.now();
  let changed = 0;
  for (const g of db.get('groups')) {
    if (g.status === 'open' && g.expireAt && g.expireAt < now) {
      g.status = 'failed';
      changed++;
      const listing = db.findById('listings', g.listingId);
      const title = listing ? listing.title : '拼团商品';
      for (const m of g.members) {
        ws.notifyUser(m.userId, '😢 「' + title + '」拼团到期未成团，已自动全额退款。', { groupId: g.id, title });
      }
    }
  }
  if (changed) db.saveSoon();
  return changed;
}

module.exports = { parseTarget, parseExpire, decoGroup, findMatchable, checkSuccess, onOrderPaid, openGroup, joinGroup, sweepExpired };
