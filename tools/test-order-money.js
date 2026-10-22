/**
 * 订单 / 钱包「钱相关」回归测试。
 *
 * 背景（真实事故，用户上报）：
 *   「充钱不同步；然后这个会吞钱 —— 买了一个商品、提醒发货进入会话后返回，
 *     订单界面显示待付款，再退到待付款列表发现多了一个同样的商品也是待付款，
 *     两个都是待付款，而且付的钱也没还回来。」
 *
 * 查云端真实数据后定位到 5 个问题（钱其实没算错，但界面与数据确实有 bug）：
 *   1. **重复下单**：下单与支付是两次请求；「建单成功、支付失败」后客户端允许重试，
 *      重试时又建了一笔 → 同一商品两笔订单（一笔已付、一笔永远待付款）。
 *      实测线上：订单 #10（pending，19:13:43）与 #9（paid，19:13:53）同一商品。
 *   2. **可重复支付**：/pay 不检查商品是否已售出、是否已有已付订单 →
 *      用户对那笔孤儿单再点「立即支付」会真的再扣一次钱（真正的吞钱场景）。
 *   3. **钱包明细时间少 8 小时**：云函数运行时是 UTC，
 *      `new Date().getHours()` 得到 UTC 小时（截图里 18:45 的交易显示成 10:45）。
 *   4. **钱包明细会过期**：余额是直查库的（新），流水却读内存镜像（旧）——
 *      多实例下表现就是「刚充了钱，余额变了、明细里没有」，即「充值不同步」。
 *   5. **钱包页返回不刷新**（无 onShow）。
 *
 * 本测试钉住 1~5。用法：node tools/test-order-money.js
 */
const Module = require('module');
const fs = require('fs');

const PN = 'D:/wx/campus-xianyu/';
const FN = PN + 'cloudfunctions/campus';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/* ============================================================
 * 一、云函数侧（下单幂等 / 支付防护 / 时区 / 钱包流水）
 * ============================================================ */
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
    // ⚠️ 必须提供 skip()：db.fetchCollection（全量分页读取）会调 col.skip(n)，
    //    缺了它会被 try/catch 吞掉并返回空数组 —— 直查数据库的接口会静默变空。
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

const dbDoc = (c, id) => (store[c] || {})[String(id)] || null;
const ordersOf = (pred) => Object.values(store.orders || {}).filter(pred);

(async () => {
  const app = require(FN + '/index.js');
  const util = require(FN + '/util.js');

  console.log('=== 准备：初始化 + 登录 ===');
  for (let i = 0; i < 40; i++) {
    const r = await app.main({ path: '/api/_setup', method: 'POST', data: {} });
    if (r.data && r.data.done) break;
  }
  const login = await app.main({ path: '/api/login', method: 'POST', data: { testUserId: 2 } });
  if (login.code !== 0) { no('登录失败: ' + login.message); process.exit(1); }
  const token = login.data.token;
  const meId = login.data.user.id;
  ok('登录成功 (id=' + meId + ')');

  // 充点钱，后面要用余额支付
  await app.main({ path: '/api/wallet/recharge', method: 'POST', data: { amount: 100000 }, token });

  /**
   * 挑一个**明确的「出售/出租」在售商品**作为被测对象：
   * 拼团/服务/免费类支付后本来就不会标记售出（语义如此），拿它们测「已售出」会误判。
   *
   * ⚠️ 还要排除「已被任何未完成订单占用」的商品 ——
   *    现在有「拍下即锁」，挑到已经被人拍下的商品会直接下单失败，
   *    那不是被测逻辑的问题，而是选材不当。
   */
  const list = (await app.main({ path: '/api/listings?page=1', method: 'GET', data: {}, token })).data.list;
  const ACTIVE = ['pending', 'paid', 'shipped', 'refunding'];
  const activeSet = new Set(Object.values(store.orders || {})
    .filter((o) => ACTIVE.indexOf(o.status) > -1)
    .map((o) => o.listingId));
  const sellables = list.filter((l) =>
    l.sellerId !== meId && l.status === 'on' &&
    ['sell', 'rent'].includes(l.tradeMode) && !activeSet.has(l.id));
  const onSale = sellables[0];
  if (!onSale) { no('找不到可购买的商品（sell/rent 且在售、未被占用）'); process.exit(1); }
  console.log('  被测商品：#' + onSale.id + ' mode=' + onSale.tradeMode + ' price=' + onSale.price +
    '（已被占用：否）');

  /** 「我 + 该商品」的订单 */
  const myOrdersOfTarget = () => ordersOf((o) => o.buyerId === meId && o.listingId === onSale.id);

  /* ---------- 1. 下单必须幂等 ---------- */
  console.log('\n=== 1. 同一买家 + 同一商品：重复下单不会产生第二笔 ===');
  let orderA = null;
  {
    const n0 = myOrdersOfTarget().length;
    const r1 = await app.main({ path: '/api/orders', method: 'POST', data: { listingId: onSale.id, qty: 1 }, token });
    if (r1.code !== 0) { no('第一次下单失败: ' + r1.message); process.exit(1); }
    orderA = r1.data.order;
    const n1 = myOrdersOfTarget().length;
    if (n1 === n0 + 1) ok('第一次下单新建了 1 笔（' + n0 + ' → ' + n1 + '）');
    else if (n1 === n0) ok('第一次下单复用了已有的待付款单（' + n0 + ' 笔未增加）');
    else no('第一次下单订单数异常：' + n0 + ' → ' + n1);

    const r2 = await app.main({ path: '/api/orders', method: 'POST', data: { listingId: onSale.id, qty: 1 }, token });
    const n2 = myOrdersOfTarget().length;
    if (r2.code === 0 && n2 === n1) ok('再下一次单：订单数不变（' + n1 + ' → ' + n2 + '）← 原来会多出一笔孤儿单');
    else no('重复下单产生了新订单（' + n1 + ' → ' + n2 + '）');
    if (r2.code === 0 && r2.data.order.id === orderA.id) ok('两次都返回同一笔订单 #' + orderA.id);
    else no('返回了不同订单：' + (r2.data && r2.data.order && r2.data.order.id) + ' vs ' + orderA.id);
  }

  /* ---------- 2. 改数量：更新原单，不新建 ---------- */
  console.log('\n=== 2. 改数量应更新原单，不隐藏地新建一笔 ===');
  {
    const n0 = myOrdersOfTarget().length;
    const r = await app.main({ path: '/api/orders', method: 'POST', data: { listingId: onSale.id, qty: 3 }, token });
    const n1 = myOrdersOfTarget().length;
    if (r.code === 0 && n1 === n0 && r.data.order.id === orderA.id) ok('数量改为 3 后仍是订单 #' + orderA.id + '，订单数不变');
    else no('改数量产生了新订单（' + n0 + ' → ' + n1 + '）');
    const doc = dbDoc('orders', orderA.id);
    if (doc && doc.qty === 3 && doc.payAmount === onSale.price * 3) ok('数量与金额已同步（qty=3, payAmount=' + doc.payAmount + '）');
    else no('数量/金额没更新：' + JSON.stringify(doc && { qty: doc.qty, payAmount: doc.payAmount }));
    // 改回 1，便于后续用例
    await app.main({ path: '/api/orders', method: 'POST', data: { listingId: onSale.id, qty: 1 }, token });
  }

  /* ---------- 3. 支付后：不能重复支付、不能为已售商品再下单 ---------- */
  console.log('\n=== 3. 支付成功后：不可重复支付，也不可再为同一商品下单 ===');
  {
    const pay = await app.main({ path: '/api/orders/' + orderA.id + '/pay', method: 'POST', data: { method: 'balance' }, token });
    if (pay.code === 0 && pay.data.order.status === 'paid') ok('订单 #' + orderA.id + ' 支付成功');
    else no('支付失败: ' + pay.message);

    const again = await app.main({ path: '/api/orders/' + orderA.id + '/pay', method: 'POST', data: { method: 'balance' }, token });
    if (again.code !== 0) ok('同一笔订单再付一次被拒：「' + again.message + '」');
    else no('同一笔订单被重复支付 → 会重复扣钱！');

    const l = dbDoc('listings', onSale.id);
    if (l && l.status === 'sold') ok('商品已标记售出（status=sold）');
    else no('商品没标记售出：' + (l && l.status));

    const reorder = await app.main({ path: '/api/orders', method: 'POST', data: { listingId: onSale.id, qty: 1 }, token });
    if (reorder.code !== 0) ok('已售出后再下单被拒：「' + reorder.message + '」');
    else no('已售出却还能下单（新订单 #' + reorder.data.order.id + '）');
  }

  /* ---------- 4. 防护要看得见「其它实例/历史脏数据」里的已付订单 ---------- */
  console.log('\n=== 4. 防护要看得见「数据库里」的已付订单（不只内存镜像）===');
  {
    // 造一个「商品仍在售、但数据库里已存在另一笔已付订单」的不一致状态，
    // 模拟「别的实例建的订单」或历史脏数据 —— 只看内存镜像就会漏判。
    // （sellables 已排除被占用的商品，这里只需再避开上面用过的那个）
    const l2 = sellables.find((l) => l.id !== onSale.id);
    if (!l2) { console.log('  （没有第二个可测商品，跳过）'); }
    else {
      const mine = await app.main({ path: '/api/orders', method: 'POST', data: { listingId: l2.id, qty: 1 }, token });
      const payId = 900002;
      col('orders')[String(payId)] = {
        _id: String(payId), id: payId, orderNo: 'PEER-PAID', buyerId: meId, sellerId: l2.sellerId,
        listingId: l2.id, snapshot: { title: l2.title }, qty: 1, amount: l2.price, payAmount: l2.price,
        status: 'paid', payType: 'wxpay', createdAt: Date.now(), timeline: []
      };
      const r = await app.main({ path: '/api/orders/' + mine.data.order.id + '/pay', method: 'POST', data: { method: 'balance' }, token });
      if (r.code !== 0 && /付过款|已被购买|重复/.test(r.message)) ok('检测到同商品已有已付订单并拒绝：「' + r.message + '」');
      else no('没检测到库里的已付订单（返回：' + JSON.stringify(r).slice(0, 90) + '）');
    }
  }

  /* ---------- 5. 时间格式化必须是北京时间（云函数跑在 UTC） ---------- */
  console.log('\n=== 5. 时间格式化按东八区（云函数运行时是 UTC）===');
  {
    // 2026-10-15 18:45:52 +08:00
    const ts = Date.UTC(2026, 9, 15, 10, 45, 52);
    const s = util.fmtTime(ts);
    if (s === '2026-10-15 18:45') ok('fmtTime(18:45 CST) = ' + s + '（原来会显示成 10:45）');
    else no('fmtTime 结果不对：' + s + '（期望 2026-10-15 18:45）');

    // 跨日边界：北京时间 00:30 属于当天，不能被算到前一天
    const ts2 = Date.UTC(2026, 9, 14, 16, 30, 0);   // = 10-15 00:30 CST
    const s2 = util.fmtTime(ts2);
    if (s2 === '2026-10-15 00:30') ok('凌晨边界正确：' + s2);
    else no('凌晨边界错误：' + s2 + '（期望 2026-10-15 00:30）');
  }

  /* ---------- 6. 钱包流水：包含最新交易且按时间倒序 ---------- */
  console.log('\n=== 6. 钱包流水要包含最新交易（不能是过期镜像）===');
  {
    const before = await app.main({ path: '/api/wallet', method: 'GET', data: {}, token });
    const n0 = (before.data.transactions || []).length;
    await app.main({ path: '/api/wallet/recharge', method: 'POST', data: { amount: 1234 }, token });
    const after = await app.main({ path: '/api/wallet', method: 'GET', data: {}, token });
    const list = after.data.transactions || [];
    if (list.length === n0 + 1) ok('充值后流水立刻多出 1 条（' + n0 + ' → ' + list.length + '）');
    else no('流水没跟上新充值：' + n0 + ' → ' + list.length);
    if (list[0] && list[0].amount === 1234) ok('最新一笔排在最前（amount=' + list[0].amount + '）');
    else no('排序不对，首条 amount=' + (list[0] && list[0].amount));
    const desc = list.every((t, i) => i === 0 || list[i - 1].createdAt >= t.createdAt);
    if (desc) ok('流水按时间倒序');
    else no('流水没有按时间倒序');
    if (list[0] && list[0].timeText && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(list[0].timeText)) ok('每条都带 timeText：' + list[0].timeText);
    else no('timeText 缺失或格式不对');
  }

  /* ============================================================
   * 二、小程序侧
   * ============================================================ */
  console.log('\n=== 7. 客户端：支付失败后重试必须复用同一笔订单 ===');
  {
    const calls = { create: 0, pay: [] };
    let payShouldFail = true;

    const apiMock = {
      get: async (p) => {
        if (/\/api\/listings\//.test(p)) {
          return { listing: { id: 14, price: 28000, images: ['a.jpg'], zone: 'idle', tradeMode: 'sell', tradeMethods: ['校内面交'], originalPrice: 0 } };
        }
        if (p === '/api/wallet') return { balance: 100000 };
        return {};
      },
      post: async (p, body) => {
        if (p === '/api/orders') { calls.create++; return { order: { id: 77 } }; }
        if (/\/api\/orders\/\d+\/pay/.test(p)) {
          calls.pay.push(p);
          if (payShouldFail) throw new Error('云端响应超时');
          return { order: { id: 77, status: 'paid' } };
        }
        return {};
      },
      abs: (p) => p,
      upload: async () => 'cloud://x'
    };

    const appMock = { guard: () => true, openChat() { }, bootstrap() { } };
    global.Page = (o) => { global.__p = o; };
    global.getApp = () => appMock;
    const toasts = [];
    global.wx = {
      showToast: (o) => toasts.push(o && o.title), showLoading() { }, hideLoading() { },
      showModal() { }, navigateTo() { }, redirectTo() { }, navigateBack() { }, stopPullDownRefresh() { }
    };
    const orig2 = Module._load;
    Module._load = function (r) {
      if (r === '../../utils/api') return apiMock;
      if (r === '../../utils/util') return { fmtPrice: (x) => String(x), fmtMoney: (x) => String(x), relTime: () => '' };
      if (r === '../../utils/const') return { ZONE_MAP: {}, TRADE_MODES: {} };
      return orig2.apply(this, arguments);
    };
    require(PN + 'miniprogram/pages/order-confirm/order-confirm.js');
    Module._load = orig2;

    const def = global.__p;
    const page = {};
    for (const k of Object.keys(def)) page[k] = def[k];
    page.data = JSON.parse(JSON.stringify(def.data));
    page.setData = function (patch) { Object.assign(this.data, patch); };
    page.listingId = 14;
    // 直接给好渲染结果，跳过 fetch
    page.setData({ listing: { price: 28000 }, balanceFen: 100000, totalFen: 28000, qty: 1, tradeMethod: '校内面交', payMethod: 'balance' });

    await page.onSubmit();                       // 第一次：建单成功、支付失败
    if (calls.create === 1) ok('第一次提交建了 1 笔单');
    else no('第一次提交建单次数异常：' + calls.create);
    if (page.data.presetOrderId === 77) ok('支付失败后已记住 orderId=77（重试会复用它）');
    else no('没有记住 orderId：' + page.data.presetOrderId + ' → 重试会再建一笔单');
    if (page.data.submitting === false) ok('失败后允许重试（submitting 已复位）');
    else no('失败后无法重试');

    payShouldFail = false;
    await page.onSubmit();                       // 第二次：应复用 77，不再建单
    if (calls.create === 1) ok('重试没有重复建单（建单次数仍为 1）← 这就是线上「多出一笔待付款」的根因');
    else no('重试又建了单（共 ' + calls.create + ' 次）→ 会再产生一笔孤儿订单');
    if (calls.pay.length === 2 && /\/api\/orders\/77\/pay/.test(calls.pay[1])) ok('两次支付都打在订单 #77 上：' + calls.pay.join(' , '));
    else no('支付目标不对：' + JSON.stringify(calls.pay));
  }

  console.log('\n=== 8. 钱包页必须在返回时刷新（否则「充值不同步」）===');
  {
    const src = fs.readFileSync(PN + 'miniprogram/pages/wallet/wallet.js', 'utf8');
    if (/onShow\s*\(/.test(src)) ok('wallet.js 有 onShow');
    else no('wallet.js 没有 onShow → 从下单流程返回时余额/明细都是旧的');
    if (/onShow\s*\([^)]*\)\s*\{[^}]*fetch\(\)/.test(src)) ok('onShow 里会重新拉取');
    else no('onShow 里没有 fetch');
    if (!/onLoad\s*\([^)]*\)\s*\{[\s\S]{0,120}?this\.fetch\(\)/.test(src)) ok('已把 fetch 从 onLoad 移到 onShow（避免重复请求）');
    else no('onLoad 里还留着 fetch，会与 onShow 重复请求');
  }

  /* ---------- 9. 拍下即锁（与闲鱼一致） ---------- */
  console.log('\n=== 9. 单件商品：被拍下后其他人就买不到（拼团/服务不受限）===');
  {
    // 换一个买家（user 7），用来演「别人」
    const loginB = await app.main({ path: '/api/login', method: 'POST', data: { testUserId: 7 } });
    if (loginB.code !== 0) { no('第二个买家登录失败：' + loginB.message); }
    else {
      const tokenB = loginB.data.token;
      const meB = loginB.data.user.id;
      ok('第二个买家登录成功 (id=' + meB + ')');

      /** 挑一个「没有任何订单」的在售商品（避免种子数据里的历史订单干扰）
       *  ⚠️ 必须同时排除 A 和 B **自己发布的**商品 ——
       *     否则会撞上「不能购买自己的商品」，让这个用例测不到锁定逻辑。 */
      const all = (await app.main({ path: '/api/listings?page=1', method: 'GET', data: {}, token })).data.list;
      const hasOrder = (lid) => Object.values(store.orders || {})
        .some((o) => o.listingId === lid && ['pending', 'paid', 'shipped', 'refunding'].indexOf(o.status) > -1);
      const clean = (mode) => all.find((l) =>
        l.status === 'on' && l.tradeMode === mode &&
        l.sellerId !== meId && l.sellerId !== meB &&
        !hasOrder(l.id));
      const uniq = clean('sell') || clean('rent') || clean('free');
      /**
       * 多人/多次类（拼团、服务）不需要"干净" —— 它们本来就不该被锁，
       * 所以即使已有订单，两个买家也都能下单。
       * 只需排除双方自己发布的（否则会撞上「不能购买自己的商品」）。
       */
      const multi = all.find((l) =>
        l.status === 'on' && ['service', 'group'].includes(l.tradeMode) &&
        l.sellerId !== meId && l.sellerId !== meB);

      if (!uniq) no('找不到干净的单件商品，跳过锁定用例');
      else {
        console.log('  单件商品：#' + uniq.id + '（' + uniq.tradeMode + '）');

        // ① 买家 B 拍下
        const orderB = await app.main({ path: '/api/orders', method: 'POST', data: { listingId: uniq.id, qty: 1 }, token: tokenB });
        if (orderB.code === 0) ok('买家 B 拍下成功（订单 #' + orderB.data.order.id + '，待付款）');
        else no('买家 B 下单失败：' + orderB.message);

        // ② 买家 A（我）再拍 → 必须被拒
        const orderA2 = await app.main({ path: '/api/orders', method: 'POST', data: { listingId: uniq.id, qty: 1 }, token });
        if (orderA2.code !== 0) ok('买家 A 再拍被拒：「' + String(orderA2.message).slice(0, 40) + '」← 拍下即锁生效');
        else no('被拍下后仍能下单（会产生订单 #' + orderA2.data.order.id + '）→ 锁定没生效');

        // ③ 详情页要能看出来（否则用户会一直点"立即购买"）
        const detail = await app.main({ path: '/api/listings/' + uniq.id, method: 'GET', data: {}, token });
        const lock = detail.data && detail.data.listing && detail.data.listing.lock;
        if (lock && lock.mine === false) ok('详情页返回 lock（mine=false）→ 前端可显示「已被拍下」并禁用按钮');
        else no('详情页没返回 lock：' + JSON.stringify(lock));

        // ④ 拍下者自己看详情 → mine=true（他可以继续付款，不该被挡）
        const detailB = await app.main({ path: '/api/listings/' + uniq.id, method: 'GET', data: {}, token: tokenB });
        const lockB = detailB.data && detailB.data.listing && detailB.data.listing.lock;
        if (lockB && lockB.mine === true) ok('拍下者自己看详情 lock.mine=true（可继续付款）');
        else no('拍下者自己看到的 lock 不对：' + JSON.stringify(lockB));

        // ⑤ 买家 B 取消订单 → 商品自动释放
        if (orderB.code === 0) {
          const cancel = await app.main({ path: '/api/orders/' + orderB.data.order.id + '/cancel', method: 'POST', data: {}, token: tokenB });
          if (cancel.code === 0) ok('买家 B 取消订单');
          else no('取消失败：' + cancel.message);
          const orderA3 = await app.main({ path: '/api/orders', method: 'POST', data: { listingId: uniq.id, qty: 1 }, token });
          if (orderA3.code === 0) ok('取消后商品自动释放，买家 A 可以拍下了（订单 #' + orderA3.data.order.id + '）');
          else no('取消后仍买不到：' + orderA3.message);
          // 收拾：把 A 刚建的单也取消，避免影响别的用例
          if (orderA3.code === 0) {
            await app.main({ path: '/api/orders/' + orderA3.data.order.id + '/cancel', method: 'POST', data: {}, token });
          }
        }
      }

      if (!multi) console.log('  （没有干净的服务/拼团类商品，跳过「不锁」用例）');
      else {
        console.log('  多人/多次类商品：#' + multi.id + '（' + multi.tradeMode + '）');
        const o1 = await app.main({ path: '/api/orders', method: 'POST', data: { listingId: multi.id, qty: 1 }, token: tokenB });
        const o2 = await app.main({ path: '/api/orders', method: 'POST', data: { listingId: multi.id, qty: 1 }, token });
        if (o1.code === 0 && o2.code === 0) ok('「' + multi.tradeMode + '」类不被锁定：两人都能下单（拼团/服务需要这样）');
        else no('「' + multi.tradeMode + '」类被误锁了：B=' + o1.code + ' A=' + o2.code);
        // 收拾
        if (o1.code === 0) await app.main({ path: '/api/orders/' + o1.data.order.id + '/cancel', method: 'POST', data: {}, token: tokenB });
        if (o2.code === 0) await app.main({ path: '/api/orders/' + o2.data.order.id + '/cancel', method: 'POST', data: {}, token });
      }
    }
  }

  /* ---------- 10. 多人多次类商品：每个参与者都能付款 ---------- */
  console.log('\n=== 10. 拼团/服务：多人付款不该被「已付过款」挡住 ===');
  {
    // 真实事故（smoke2 的「满员自动成团」抓到）：
    // 防重复付款原本**不分商品类型**，一律「同商品已有已付款订单就拒绝」——
    // 于是拼团 B、C 各一笔单、C 先付成功后，B 再付被拒 → 团永远停在「还差 1 人成团」。
    // 多人类商品（group/service）每人一笔单是**正常状态**，必须放行。
    const loginB = await app.main({ path: '/api/login', method: 'POST', data: { testUserId: 7 } });
    if (loginB.code !== 0) no('第二个买家登录失败：' + loginB.message);
    else {
      const tokenB = loginB.data.token;
      const meB = loginB.data.user.id;
      const all = (await app.main({ path: '/api/listings?page=1', method: 'GET', data: {}, token })).data.list;
      const target = all.find((l) =>
        l.status === 'on' && ['group', 'service'].indexOf(l.tradeMode) > -1 &&
        l.sellerId !== meId && l.sellerId !== meB);

      if (!target) console.log('  （找不到可用的拼团/服务类商品，跳过）');
      else {
        console.log('  目标商品：#' + target.id + '（' + target.tradeMode + '）单价 ' + target.price);
        // 保证两个买家都有余额，避免「余额不足」干扰本用例
        await app.main({ path: '/api/wallet/recharge', method: 'POST', data: { amount: 1000000 }, token });
        await app.main({ path: '/api/wallet/recharge', method: 'POST', data: { amount: 1000000 }, token: tokenB });

        const oA = await app.main({ path: '/api/orders', method: 'POST', data: { listingId: target.id, qty: 1 }, token });
        const oB = await app.main({ path: '/api/orders', method: 'POST', data: { listingId: target.id, qty: 1 }, token: tokenB });
        if (oA.code !== 0 || oB.code !== 0) no('下单失败：A=' + oA.code + ' B=' + oB.code);
        else {
          const payA = await app.main({ path: '/api/orders/' + oA.data.order.id + '/pay', method: 'POST', data: { method: 'balance' }, token });
          if (payA.code === 0) ok('参与者 A 付款成功');
          else no('参与者 A 付款失败：' + payA.message);

          const payB = await app.main({ path: '/api/orders/' + oB.data.order.id + '/pay', method: 'POST', data: { method: 'balance' }, token: tokenB });
          if (payB.code === 0) ok('参与者 B 也能付款 ← 就是这一步曾被拦死（拼团成团的关键）');
          else no('参与者 B 被「已经付过款了」挡住：' + payB.message + ' → 拼团永远成不了团');
        }
      }
    }
    // 反向对照：单件类是别的分支（本文件第 4 节已断言「已存在已付订单 → 拒绝」，
    // 若上面第 10 节通过而第 4 节也通过，说明是「按类型区分」而不是「把防护关掉了」）。
  }

  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 下单幂等、支付不重复扣款、拍下即锁、多人付款、钱包时间与流水均正确'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
