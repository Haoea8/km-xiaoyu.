/**
 * 「直接改字段也要落库」回归测试。
 *
 * 背景（真实事故）：
 *   云函数版 flush() 只写 dirty 里的文档，而 saveSoon() 原来是**空实现**，
 *   于是云函数里二十多处
 *       o.status = 'shipped'; o.timeline.push(...); db.saveSoon();
 *   这种「直接改内存字段」的写法**全都不落库** ——
 *   只在当前实例内存里生效，冷启动或换实例后回退。
 *
 *   实测证据（云端真实数据）：
 *     发消息后 messages 集合里有了新消息，但 conversations.lastMessage 没变，
 *     会话列表里的「最新一条」永远停在会话创建那一刻的内容。
 *
 *   修法：saveSoon() 改为置标记，flush() 前做一次「文档内容与基线比对」，
 *   把改过的文档 markDirty 后交给既有的批量写入逻辑。
 *   一处生效，覆盖全部调用点，之后新写的代码也不会再踩。
 *
 * 本测试就是钉住这件事：调接口改状态后，**直接从 mock 数据库读**，
 * 断言值真的写进去了（而不是只在内存里）。
 *
 * 用法：node tools/test-persist.js
 */
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';

/* ---------- mock 数据库（写入即体现在 store 里，可被断言） ---------- */
const store = {};
function col(n) { if (!store[n]) store[n] = {}; return store[n]; }

/**
 * 深拷贝一份文档。
 * 库与云函数内存必须是两份独立数据，否则「改内存」会顺带改到「库」，
 * 断言就永远成立，测不出「没落库」这种 bug。
 */
const copy = (d) => JSON.parse(JSON.stringify(d));

function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) {
          // ⚠️ 必须**深拷贝**。
          // 若用 Object.assign 浅拷贝，文档里的数组/对象（如 likes / timeline）
          // 会与云函数内存中的那份共享同一个引用 —— 于是「改内存」等于「改库」，
          // 断言会假通过，测试就失去意义了。
          col(name)[String(id)] = Object.assign({ _id: String(id) }, JSON.parse(JSON.stringify(data)));
          return Promise.resolve({});
        },
        get() {
          const d = col(name)[String(id)];
          if (!d) { const e = new Error('document does not exist'); return Promise.reject(e); }
          // 读出去也给一份深拷贝，避免调用方改到「库里」的那份
          return Promise.resolve({ data: JSON.parse(JSON.stringify(d)) });
        },
        remove() { delete col(name)[String(id)]; return Promise.resolve({}); }
      };
    },
    where(cond) {
      const match = (d) => Object.keys(cond || {}).every((k) => {
        const v = d[k];
        const want = cond[k];
        if (Array.isArray(v)) return v.indexOf(want) > -1;
        return v === want;
      });
      const q = {
        limit() { return q; },
        get() { return Promise.resolve({ data: Object.values(col(name)).filter(match).map(copy) }); }
      };
      return q;
    },
    limit() { return { get: () => Promise.resolve({ data: Object.values(col(name)).map(copy) }) }; },
    skip() { return this; },
    get() { return Promise.resolve({ data: Object.values(col(name)).map(copy) }); }
  };
}

const fake = {
  DYNAMIC_CURRENT_ENV: 'mock',
  init() { },
  getWXContext: () => ({}),
  database: () => ({ collection: makeCollection, createCollection(n) { col(n); return Promise.resolve({}); } })
};

const origLoad = Module._load;
Module._load = function (r) {
  if (r === 'wx-server-sdk') return fake;
  return origLoad.apply(this, arguments);
};

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/** 从 mock 库里取一条文档（就是「云数据库里真实存着的样子」） */
const dbDoc = (coll, id) => (store[coll] || {})[String(id)] || null;

(async () => {
  const app = require(FN + '/index.js');

  console.log('=== 准备：初始化 + 登录 ===');
  for (let i = 0; i < 40; i++) {
    const r = await app.main({ path: '/api/_setup', method: 'POST', data: {} });
    if (r.data && r.data.done) break;
  }
  const login = await app.main({ path: '/api/login', method: 'POST', data: { testUserId: 2 } });
  if (login.code !== 0) { no('登录失败: ' + login.message); process.exit(1); }
  const token = login.data.token;
  ok('登录成功: ' + login.data.user.nickname + ' (id=2)');

  console.log('\n=== 1. 发消息后，会话的 lastMessage / lastTime 必须落库 ===');
  {
    // 找一个「我」参与的会话
    const convs = await app.main({ path: '/api/conversations', method: 'GET', data: {}, token });
    const conv = (convs.data.list || [])[0];
    if (!conv) { no('没有可用会话'); }
    else {
      const before = dbDoc('conversations', conv.id);
      const beforeMsg = before ? before.lastMessage : '(会话不存在)';
      const text = '落库测试' + Date.now().toString().slice(-6);

      const sent = await app.main({
        path: '/api/conversations/' + conv.id + '/messages', method: 'POST',
        data: { content: text, type: 'text' }, token
      });
      if (sent.code !== 0) no('发消息失败: ' + sent.message);
      else {
        const after = dbDoc('conversations', conv.id);
        if (after && after.lastMessage === text) ok('会话 #' + conv.id + ' 的 lastMessage 已落库：「' + text + '」');
        else no('lastMessage 没落库！库里仍是「' + (after ? after.lastMessage : 'null') + '」（发消息前是「' + beforeMsg + '」）');
        if (after && after.lastTime > (before ? before.lastTime : 0)) ok('lastTime 也已更新（' + new Date(after.lastTime).toLocaleTimeString() + '）');
        else no('lastTime 没有更新');
        // 消息本身也要在（这条本来就走 insert，属于对照）
        const msgInDb = Object.values(store.messages || {}).some((m) => m.content === text);
        if (msgInDb) ok('消息本身也写进了 messages 集合（对照项）');
        else no('消息没落库');
      }
    }
  }

  console.log('\n=== 2. 点赞后，帖子的 likes 必须落库 ===');
  {
    const posts = await app.main({ path: '/api/posts?limit=10', method: 'GET', data: {} });
    const post = (posts.data.list || []).find((p) => p.authorId !== 2);
    if (!post) no('没有可点赞的帖子');
    else {
      const inDb = (p, uid) => !!p && Array.isArray(p.likes) && p.likes.indexOf(uid) > -1;
      const before = dbDoc('posts', post.id);
      const wasLiked = inDb(before, 2);
      const r = await app.main({ path: '/api/posts/' + post.id + '/like', method: 'POST', data: {}, token });
      if (r.code !== 0) no('点赞失败: ' + r.message);
      else {
        const after = dbDoc('posts', post.id);
        const nowLiked = inDb(after, 2);
        if (nowLiked !== wasLiked) ok('帖子 #' + post.id + ' 的 likes 已落库（' + (wasLiked ? '取消点赞' : '点赞') + '，库内 likes=' + JSON.stringify(after.likes) + '）');
        else no('likes 没落库！库里仍是 ' + JSON.stringify(before && before.likes) + '（期望被' + (wasLiked ? '移除' : '加入') + ' 2）');
      }
    }
  }

  console.log('\n=== 3. 订单状态流转必须落库（下单 → 付款）===');
  {
    const listings = await app.main({ path: '/api/listings?page=1', method: 'GET', data: {} });
    const item = (listings.data.list || []).find((l) => l.sellerId !== 2 && l.status === 'on' && l.price < 200000);
    if (!item) no('没有可下单的商品');
    else {
      // 余额不够先充值（免得测试失败在付款那一步，掩盖真正要测的落库）
      const me = await app.main({ path: '/api/me', method: 'GET', data: {}, token });
      const bal = (me.data && me.data.user && me.data.user.balance) || 0;
      if (bal < item.price + 1000) {
        const rec = await app.main({ path: '/api/wallet/recharge', method: 'POST', data: { amount: item.price + 10000 }, token });
        if (rec.code === 0) ok('余额不足，已先充值（余额 ' + bal + ' → 补到足额）');
      }

      const created = await app.main({
        path: '/api/orders', method: 'POST',
        data: { listingId: item.id, qty: 1, tradeMethod: 'face' }, token
      });
      if (created.code !== 0) no('下单失败: ' + created.message);
      else {
        const oid = created.data.order.id;
        const o0 = dbDoc('orders', oid);
        ok('订单 #' + oid + ' 已创建，库内 status=' + (o0 && o0.status));

        const paid = await app.main({ path: '/api/orders/' + oid + '/pay', method: 'POST', data: {}, token });
        if (paid.code !== 0) no('付款失败: ' + paid.message);
        else {
          const o1 = dbDoc('orders', oid);
          if (o1 && (o1.status === 'paid' || o1.status === 'shipped')) ok('付款后 orders.status 已落库 = ' + o1.status);
          else no('订单状态没落库！库里仍是 ' + (o1 && o1.status));
          // 商品应变为已售（走 db.update，对照项）
          const l1 = dbDoc('listings', item.id);
          if (l1 && l1.status !== 'on') ok('商品状态也已落库 = ' + l1.status + '（对照项）');
        }
      }
    }
  }

  console.log('\n=== 4. 会话列表的预览必须来自「最后一条消息」（自愈过期数据）===');
  {
    // 背景：conversations.lastMessage 曾经长期不落库，库里的值停在会话创建那一刻，
    // 消息列表就一直显示旧内容、时间也停住（用户：「不显示最新的话题」）。
    // 现在 decoConv 直接从 messages 推预览，所以**即使库里的字段是旧的**也要显示最新的。
    const convs = await app.main({ path: '/api/conversations', method: 'GET', data: {}, token });
    const conv = (convs.data.list || [])[0];
    if (!conv) no('没有可用会话');
    else {
      // 列表预览的规则（与 events.js 的 lastPreview 一致）
      const previewOf = (m) => {
        if (!m) return '';
        if (m.type === 'listing') return '[商品] ' + ((m.card && m.card.title) || '');
        if (m.type === 'listings') return '[商品推荐]';
        if (m.type === 'image') return '[图片]';
        if (m.type === 'order') return '[订单] ' + ((m.card && m.card.title) || '');
        return m.content || '';
      };

      const text = '预览自愈测试' + Date.now().toString().slice(-6);
      await app.main({
        path: '/api/conversations/' + conv.id + '/messages', method: 'POST',
        data: { content: text, type: 'text' }, token
      });

      // 人为把库里的字段改回旧值，模拟「历史遗留的过期数据」
      const raw = dbDoc('conversations', conv.id);
      if (raw) {
        raw.lastMessage = '这是一条很旧的内容';
        raw.lastTime = 1;
      }

      // 期望值 = 库里该会话最新一条消息的预览
      // （可能是对方/AI 的回复，因为 AI 会话会自动回一句）
      const newest = Object.values(store.messages || {})
        .filter((m) => m.convId === conv.id)
        .sort((a, b) => a.id - b.id).pop();
      const wantMsg = previewOf(newest);

      const after = await app.main({ path: '/api/conversations', method: 'GET', data: {}, token });
      const row = (after.data.list || []).find((c) => c.id === conv.id);

      if (row && row.lastMessage === wantMsg) {
        ok('库里字段是旧值「这是一条很旧的内容」时，列表仍显示最新一条：「' + wantMsg.slice(0, 24) + '」');
      } else {
        no('列表没跟上最新消息：实际 ' + JSON.stringify(row && row.lastMessage) + '，期望 ' + JSON.stringify(wantMsg.slice(0, 30)));
      }
      if (row && row.lastTime === newest.createdAt) {
        ok('时间也来自最后一条消息（' + new Date(row.lastTime).toLocaleTimeString() + '），不是库里的旧值');
      } else {
        no('时间不是最后一条消息的时间');
      }
    }
  }

  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 直接改字段的改动都会落库（saveSoon 已真正生效）'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
