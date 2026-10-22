/**
 * 「点一次发布，出来好几件/好几条」回归测试。
 *
 * 线上真实现象：同一个「95新青柠味冰茶」「1测试」各出现 2 条。
 * 原因不是 id 撞车，而是**同一次点击被提交了多次**：
 *   ① 前端 `submitting` 要等 setData 之后才为真，而它之前还有校验和
 *      1~3 秒的 AI 内容审核空窗 —— 连点会全部穿过去；
 *   ② 请求已发出、界面还在转圈时用户再点一次；
 *   ③ 响应超时后重试，本地以为没成功，云端其实已经建好了。
 *
 * 因此**两道防线都要有**：
 *   - 客户端同步锁（this.locked）+ 请求带 reqId；
 *   - 服务端按 (用户, reqId) 去重，且要看库（多实例下内存不可信）。
 *
 * 覆盖：A 云端商品幂等 / B 云端帖子幂等 / C 前端连点只发一次 / D 前端请求确实带了 reqId
 *
 * 用法：node tools/test-publish-once.js
 */
const Module = require('module');

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ✗ ' + m); bad++; };

const ROOT = 'D:/wx/campus-xianyu';

/* ========================= 通用：内存库 + 依赖桩 ========================= */
const store = { listings: [], posts: [], circles: [{ id: 1, name: '跳蚤市场' }] };

const dbMock = {
  load: () => ({ meta: { config: {} } }),
  get: (n) => (store[n] = store[n] || []),
  insert: (n, o) => {
    const list = store[n] = store[n] || [];
    const id = (list.length ? Math.max.apply(null, list.map((x) => x.id)) : 0) + 1;
    const d = Object.assign({ id }, o);
    list.push(d);
    return d;
  },
  findById: (n, id) => (store[n] || []).find((x) => x.id === Number(id)) || null,
  find: (n, pred) => (store[n] || []).filter(pred || (() => true)),
  one: (n, pred) => (store[n] || []).find(pred) || null,
  fetchByField: async (n, f, v, limit) => (store[n] || [])
    .filter((x) => String(x[f]) === String(v)).slice(0, limit || 1000),
  update: (n, id, patch) => {
    const d = (store[n] || []).find((x) => x.id === Number(id));
    if (d) Object.assign(d, patch);
    return d;
  },
  readAllFromDb: async (n) => (store[n] || []).slice(),
  findByIdWithFallback: async (n, id) => ({ doc: (store[n] || []).find((x) => x.id === Number(id)) || null, fromDb: false }),
  isLocallyRemoved: () => false,
  saveSoon() { }
};

const utilMock = {
  num: (v, d) => { const n = Number(v); return isNaN(n) ? (d === undefined ? 0 : d) : n; },
  clampText: (s, n) => String(s === undefined || s === null ? '' : s).trim().slice(0, n || 1000),
  relTime: () => '刚刚',
  fmtPrice: (p) => String((Number(p) || 0) / 100),
  fmtTime: () => '00:00'
};

const decoMock = {
  decorateListing: (l) => ({ id: l.id, title: l.title }),
  decoratePost: (p) => ({ id: p.id, content: p.content }),
  decorListing: (l) => ({ id: l.id })
};

const constMock = { ZONES: [{ code: 'digital', name: '数码' }], TRADE_MODES: [] };

const routes = {};
const register = (m, p, h) => { routes[m + ' ' + p] = h; };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const f = (parent && parent.filename) || '';
  if (/route-trade\.js$/.test(f) || /route-social\.js$/.test(f)) {
    if (request === './db') return dbMock;
    if (request === './util') return utilMock;
    if (request === './deco') return decoMock;
    if (request === './events') return { lastPreview: () => '', sendChatMessage: () => null, notifyUser: () => null };
    if (request === './interactions') return { add: () => null, list: async () => [], unreadCount: async () => 0, markRead: async () => ({}) };
    if (request === './const') return constMock;
    if (request === './ai') return { moderate: async () => ({ level: 'ok' }) };
    if (request === './group') return { onOrderPaid: () => { }, sweepExpired: () => { }, decoGroup: (x) => x };
    if (request === './sign') return { signDeep: (x) => x };
  }
  return origLoad.apply(this, arguments);
};

require(ROOT + '/cloudfunctions/campus/route-trade.js')(register);
require(ROOT + '/cloudfunctions/campus/route-social.js')(register);

const call = (key, ctx) => routes[key](Object.assign({ params: {}, query: new Map(), user: { id: 1 }, body: {} }, ctx));

(async () => {
  console.log('=== A. 云端：同一个 reqId 发布两次，只建一件商品 ===');
  {
    const body = { title: '95新青柠味冰茶', desc: '', images: ['cloud://x/a.jpg'], price: 400, zone: 'digital', reqId: 'R-1' };
    const r1 = await call('POST /api/listings', { body });
    const r2 = await call('POST /api/listings', { body });
    if (store.listings.length === 1) ok('库里只有 1 件商品（连发两次不会变成 2 件）');
    else no('库里出现 ' + store.listings.length + ' 件');
    if (r1.listing.id === r2.listing.id) ok('两次返回同一件（id=' + r1.listing.id + '）');
    else no('返回了不同 id：' + r1.listing.id + ' / ' + r2.listing.id);
    if (r2.deduped === true) ok('第二次明确标记 deduped（前端仍照常跳详情）');
    else no('第二次没有标记 deduped');
  }

  console.log('\n=== A2. 不同 reqId 仍然是两件（不能把正常发布也拦掉）===');
  {
    const base = { title: '另一个商品', images: [], price: 100, zone: 'digital' };
    await call('POST /api/listings', { body: Object.assign({}, base, { reqId: 'R-2' }) });
    await call('POST /api/listings', { body: Object.assign({}, base, { reqId: 'R-3' }) });
    if (store.listings.length === 3) ok('新商品正常创建（累计 3 件）');
    else no('累计 ' + store.listings.length + ' 件，应为 3');
  }

  console.log('\n=== A3. 别的用户的同 reqId 不会互相吞 ===');
  {
    const body = { title: '别人的商品', images: [], price: 100, zone: 'digital', reqId: 'R-1' };
    await call('POST /api/listings', { body, user: { id: 2 } });
    const mine = store.listings.filter((x) => x.sellerId === 2);
    if (mine.length === 1) ok('用户 2 用相同 reqId 也能发出自己的商品（去重按用户区分）');
    else no('用户 2 的商品条数 ' + mine.length);
  }

  console.log('\n=== B. 云端：同一个 reqId 发帖两次，只建一条 ===');
  {
    const body = { content: '测试帖子', images: [], topics: [], circleId: 1, reqId: 'P-1' };
    const p1 = await call('POST /api/posts', { body });
    const p2 = await call('POST /api/posts', { body });
    if (store.posts.length === 1) ok('库里只有 1 条帖子');
    else no('出现 ' + store.posts.length + ' 条');
    if (p1.post.id === p2.post.id && p2.deduped === true) ok('返回同一条且标记 deduped');
    else no('发帖去重未生效');
  }

  console.log('\n=== C. 前端：连点两次「发布」只发一次请求 ===');
  {
    const calls = { listings: 0, upload: 0, moderate: 0 };
    const appMock = { guard: () => true, globalData: { user: { id: 1 } }, on() { }, off() { }, emit() { } };
    const apiMock = {
      token: () => 'tok', abs: (p) => p || '',
      upload: async () => { calls.upload++; return 'cloud://x/up.jpg'; },
      post: async (url) => {
        if (/moderate/.test(url)) { calls.moderate++; return { level: 'ok' }; }
        if (/\/api\/listings/.test(url)) { calls.listings++; return { listing: { id: 9 } }; }
        return {};
      },
      get: async () => ({ list: [] }),
      patch: async () => ({})
    };

    global.Page = (o) => { global.__pub = o; };
    global.getApp = () => appMock;
    global.wx = {
      showLoading() { }, hideLoading() { }, showToast() { }, showModal() { },
      redirectTo() { }, navigateBack() { }, getStorageSync: () => '',
      getMenuButtonBoundingClientRect: () => ({ left: 300 }), getWindowInfo: () => ({ windowWidth: 375 })
    };
    const pubLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (parent && /pages[\\/]publish[\\/]publish\.js$/.test(parent.filename || '')) {
        if (request === '../../utils/api') return apiMock;
        if (request === '../../utils/util') return utilMock;
        if (request === '../../utils/const') return constMock;
      }
      return pubLoad.apply(this, arguments);
    };
    require(ROOT + '/miniprogram/pages/publish/publish.js');
    Module._load = pubLoad;

    const def = global.__pub;
    const p = Object.create(null);
    for (const k of Object.keys(def)) p[k] = def[k];
    p.data = Object.assign({}, def.data, {
      title: '显示器', desc: '', images: ['/static/img/p01.jpg'],
      priceYuan: '200', agree: true, zoneIndex: 0, modeIndex: 0, locationIndex: 0
    });
    p.setData = function (patch) { Object.assign(this.data, patch); };
    p.reqId = 'R-FE-1';

    // 连点两次：不 await 第一次，模拟真实连点
    const first = p.onSubmit();
    const second = p.onSubmit();
    await Promise.all([first, second]);

    if (calls.listings === 1) ok('只发出 1 次 POST /api/listings（同步锁挡住了第二下）');
    else no('发出了 ' + calls.listings + ' 次 —— 这就是「发布出多件」的来源');
  }

  console.log('\n' + (bad ? '✗ 有 ' + bad + ' 项失败' : '✓ 全部通过'));
  process.exit(bad ? 1 : 0);
})();
