/**
 * 订单状态机回归：状态回退 / 无限发货 / 重复付款。
 *
 * 钉的是三条用户反馈：
 *   1. 「已发货后有时会回退成待发货，还能再点发货」——本实例镜像停在 paid，
 *      写操作基于旧值判断并把旧值写回库。
 *   2. 「已完成还会回到待发货」——同上。
 *   3. 「买家付款有时会付两次」——双击/并发时两个请求都读到 pending。
 *
 * 做法：不启动两个进程，而是**手工把内存镜像改回旧值**，模拟「别的实例已经推进、
 * 本实例还不认识」的时序，然后打同一个接口。
 *
 * 用法：node tools/test-order-state.js
 */
const Module = require('module');

const path = require('path');
const PN = path.resolve(__dirname, '..') + path.sep;
const FN = PN + 'cloudfunctions/campus';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

const store = {};
const col = (n) => (store[n] = store[n] || {});
const copy = (d) => JSON.parse(JSON.stringify(d));

function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) { col(name)[String(id)] = Object.assign({ _id: String(id) }, copy(data)); return Promise.resolve({}); },
        get() {
          const d = col(name)[String(id)];
          if (!d) return Promise.reject(new Error('document does not exist'));
          return Promise.resolve({ data: copy(d) });
        },
        remove() { delete col(name)[String(id)]; return Promise.resolve({}); }
      };
    },
    where(cond) {
      const match = (d) => Object.keys(cond || {}).every((k) => d[k] === cond[k]);
      const q = { limit() { return q; }, get() { return Promise.resolve({ data: Object.values(col(name)).filter(match).map(copy) }); } };
      return q;
    },
    limit() { return { get: () => Promise.resolve({ data: Object.values(col(name)).map(copy) }) }; },
    skip() { return this; },
    get() { return Promise.resolve({ data: Object.values(col(name)).map(copy) }); }
  };
}

const fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'mock', init() { }, getWXContext: () => ({}),
  database: () => ({ collection: makeCollection, createCollection(n) { col(n); return Promise.resolve({}); } })
};

const origLoad = Module._load;
Module._load = function (r) { if (r === 'wx-server-sdk') return fakeSdk; return origLoad.apply(this, arguments); };

const dbRow = (c, id) => (store[c] || {})[String(id)] || null;

(async () => {
  const app = require(FN + '/index.js');
  const db = require(FN + '/db.js');

  console.log('=== 准备：初始化 ===');
  for (let i = 0; i < 40; i++) {
    const r = await app.main({ path: '/api/_setup', method: 'POST', data: {} });
    if (r.data && r.data.done) break;
  }

  const buyer = (await app.main({ path: '/api/login', method: 'POST', data: { testUserId: 2 } })).data.token;
  const seller = (await app.main({ path: '/api/login', method: 'POST', data: { testUserId: 7 } })).data.token;
  if (!buyer || !seller) { no('登录失败'); process.exit(1); }

  // 找一件别人在卖的单件商品
  const list = (await app.main({ path: '/api/listings?page=1', method: 'GET', data: {}, token: buyer })).data.list;
  const mine = (await app.main({ path: '/api/me', method: 'GET', data: {}, token: buyer })).data.user;
  const target = list.find((l) => l.sellerId !== mine.id && l.status === 'on' && !l.tradeMode) || list.find((l) => l.sellerId !== mine.id && l.status === 'on');
  if (!target) { no('没有可下单的商品'); process.exit(1); }

  console.log('\n=== 1. 下单 → 支付 ===');
  const ordered = await app.main({ path: '/api/orders', method: 'POST', data: { listingId: target.id, qty: 1 }, token: buyer });
  if (ordered.code !== 0) { no('下单失败：' + ordered.message); process.exit(1); }
  const orderId = ordered.data.order.id;
  ok('下单成功 #' + orderId);

  const paid = await app.main({ path: '/api/orders/' + orderId + '/pay', method: 'POST', data: { method: 'balance' }, token: buyer });
  if (paid.code !== 0) { no('支付失败：' + paid.message); process.exit(1); }
  ok('支付成功（status=' + paid.data.order.status + '）');

  console.log('\n=== 2. 卖家发货（第一次）===');
  // 用卖家账号发货：先看这单的 sellerId 是否等于 seller 账号，不等就用该卖家登录
  const orderRow = dbRow('orders', orderId);
  const sellerLogin = await app.main({ path: '/api/login', method: 'POST', data: { testUserId: orderRow.sellerId } });
  const sellerToken = sellerLogin.code === 0 ? sellerLogin.data.token : seller;

  const ship1 = await app.main({ path: '/api/orders/' + orderId + '/ship', method: 'POST', data: { note: '放 3 栋快递柜' }, token: sellerToken });
  if (ship1.code !== 0) { no('首次发货失败：' + ship1.message); } else ok('首次发货成功');

  console.log('\n=== 3. 模拟「本实例镜像过期」：内存改回 paid，再点一次发货 ===');
  const memOrder = db.findById('orders', orderId);
  memOrder.status = 'paid';
  memOrder.timeline = memOrder.timeline.filter((t) => t.status !== 'shipped');
  const ship2 = await app.main({ path: '/api/orders/' + orderId + '/ship', method: 'POST', data: { note: '重复发货' }, token: sellerToken });
  if (ship2.code !== 0) ok('二次发货被拒：' + ship2.message);
  else no('二次发货竟然成功了（状态机没拦住）');

  console.log('\n=== 4. 详情必须显示最新状态（不能回退）===');
  const detail = await app.main({ path: '/api/orders/' + orderId, method: 'GET', data: {}, token: buyer });
  const st = detail.data && detail.data.order && detail.data.order.status;
  if (st === 'shipped') ok('详情 status=' + st + '（未回退）');
  else no('详情 status=' + st + '（应为 shipped）');

  console.log('\n=== 5. 重复付款：内存改回 pending + 商品改回 on，再付一次 ===');
  const mem2 = db.findById('orders', orderId);
  mem2.status = 'pending';
  mem2.timeline = mem2.timeline.filter((t) => t.status !== 'paid');
  const memL = db.findById('listings', target.id);
  if (memL) memL.status = 'on';
  const pay2 = await app.main({ path: '/api/orders/' + orderId + '/pay', method: 'POST', data: { method: 'balance' }, token: buyer });
  if (pay2.code !== 0) ok('二次支付被拒：' + pay2.message);
  else no('二次支付竟然成功了（会重复扣钱）');

  console.log('\n=== 6. 库里状态未被旧值冲掉 ===');
  const dbOrder = dbRow('orders', orderId);
  if (dbOrder.status === 'shipped') ok('库中订单仍为 shipped');
  else no('库中订单变成了 ' + dbOrder.status);
  const dbL = dbRow('listings', target.id);
  if (dbL.status === 'sold') ok('商品仍为 sold');
  else no('商品状态 ' + dbL.status + '（应为 sold）');

  console.log('\n' + (bad ? '❌ 有 ' + bad + ' 项未通过' : '✅ 状态不回退 / 发货幂等 / 不重复扣款'));
  process.exit(bad ? 1 : 0);
})();
