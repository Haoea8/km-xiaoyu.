/**
 * 复现「进卖家会话后又被丢进 AI 会话」。
 *
 * 用户反馈：点商品详情页「聊一聊」→ 进入和卖家的会话，
 * 但紧接着又弹出一个 AI 会话；返回才回到卖家会话。
 *
 * 定位思路（读 chat.js 得到）：
 *   chat.js 的 load() 失败且错误信息含「不存在」时，会自愈：
 *     setTimeout(() => app.openChat({}), 400)
 *   而 app.openChat({}) 不带 peerId → 后端 open 接口回落到 AI 用户
 *   → 于是「卖家会话」之上又压了一层「AI 会话」。
 *
 * 所以真正要回答的是：**为什么刚开的会话，读消息会报「会话不存在」？**
 *
 * 原因（本测试要钉住的）：
 *   db.js 的 load() 是「同一实例只加载一次、之后永不刷新」的全量内存镜像。
 *   云函数多实例并发时：
 *     - 实例 A 新建会话并落库
 *     - 实例 B 的内存镜像是在「会话创建之前」加载的 → 里面没有这条会话
 *     - B 处理 GET /messages 时只查内存 → 误判「会话不存在」404
 *
 * 做法：用真正独立的 require 缓存构造两个「实例」，共享同一份底层数据库。
 *       （现有的 test-multi-instance-auth.js 里嵌套模块仍走全局缓存，
 *         并未真正隔离内存镜像，因此无法复现本问题。）
 */
const Module = require('module');
const path = require('path');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';
// Windows 下 Module._cache 的键是反斜杠路径（D:\wx\...\db.js），
// 用正斜杠前缀去比会永远匹配不上 → 清缓存静默失效 → 两个实例共享同一份内存。
const FN_NORM = path.resolve(FN).replace(/\\/g, '/');

/* ---------- 共享底层数据库（模拟真实云数据库） ---------- */
const store = {};
function col(n) { if (!store[n]) store[n] = {}; return store[n]; }

function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) { col(name)[String(id)] = Object.assign({ _id: String(id) }, data); return Promise.resolve({}); },
        get() {
          const d = col(name)[String(id)];
          if (!d) { const e = new Error('document does not exist'); e.errCode = -502004; return Promise.reject(e); }
          return Promise.resolve({ data: d });
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
        field() { return q; },
        get() { return Promise.resolve({ data: Object.values(col(name)).filter(match) }); }
      };
      return q;
    },
    orderBy() { return this; },
    limit() { return { get: () => Promise.resolve({ data: Object.values(col(name)) }) }; },
    skip() { return this; },
    field() { return this; },
    get() { return Promise.resolve({ data: Object.values(col(name)) }); }
  };
}

function fakeCloud() {
  return {
    DYNAMIC_CURRENT_ENV: 'mock',
    init() {},
    getWXContext: () => ({}),
    database: () => ({ collection: makeCollection, createCollection(n) { col(n); return Promise.resolve({}); } })
  };
}

/**
 * 构造一个「独立实例」。
 *
 * 关键：**加载之前**先清掉本云函数目录的模块缓存，让每次加载都得到一份
 * 全新的模块图 —— 这样 db.js 的 `data`（内存镜像）与 `loaded` 标记都是独立的，
 * 就像云函数的两个实例。
 *
 * 注意必须在加载「之前」清：
 * 若放在加载之后清，db.js 里 `require('./seed')` 会重新解析出一份
 * 新的 db.js（data 为 null），种子数据写不进去，表现为
 * 「初始化失败：Cannot read properties of null (reading 'seq')」。
 *
 * node_modules 不动，避免重复解析第三方包。
 */
let instances = 0;
function newInstance() {
  let candidates = 0, cleared = 0;
  for (const k of Object.keys(Module._cache)) {
    const norm = k.replace(/\\/g, '/');
    if (norm.startsWith(FN_NORM + '/') && norm.indexOf('/node_modules/') === -1) { candidates++; delete Module._cache[k]; cleared++; }
  }
  // 第二次起必然有上一次留下的模块；若此时一个都没清掉，说明路径没匹配上 → 未隔离
  if (instances++ > 0 && cleared === 0) {
    throw new Error('未能清理模块缓存，实例之间不会真正隔离（检查路径大小写/分隔符）');
  }
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud();
    return origLoad.call(Module, request, parent, isMain);
  };
  const mod = new Module(FN + '/index.js', null);
  mod.filename = FN + '/index.js';
  mod.paths = Module._nodeModulePaths(FN);
  try {
    mod.load(FN + '/index.js');
  } finally {
    Module._load = origLoad;
  }
  return mod.exports;
}

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

(async () => {
  console.log('=== 1. 实例 A：初始化 + 登录 ===');
  const A = newInstance();
  for (let i = 0; i < 40; i++) {
    const r = await A.main({ path: '/api/_setup', method: 'POST', data: {} });
    if (r.data && r.data.done) break;
  }
  const login = await A.main({ path: '/api/login', method: 'POST', data: { testUserId: 2 } });
  if (login.code !== 0) { no('登录失败: ' + login.message); process.exit(1); }
  const token = login.data.token;
  const me = login.data.user;
  ok('登录成功: ' + me.nickname + ' (id=' + me.id + ')');

  console.log('\n=== 2. 实例 B 在「会话创建之前」就加载好内存镜像 ===');
  const B = newInstance();
  const warm = await B.main({ path: '/api/home', method: 'GET', data: {} });
  ok('B 预热 /api/home → code=' + warm.code + '（此刻 B 的快照里还没有待会儿要建的会话）');

  console.log('\n=== 3. 找一个「还没聊过」的卖家，用实例 A 开会话 ===');
  // 已有会话的对方（走 A 的接口，模拟前端的真实视角）
  const convs = await A.main({ path: '/api/conversations', method: 'GET', data: {}, token });
  const knownPeers = new Set((convs.data.list || []).map((c) => c.peer && c.peer.id));

  // 找一个不属于我、且还没聊过的商品
  let listing = null;
  for (let page = 1; page <= 3 && !listing; page++) {
    const res = await A.main({ path: '/api/listings?page=' + page, method: 'GET', data: {} });
    for (const l of (res.data && res.data.list) || []) {
      if (l.sellerId !== me.id && !knownPeers.has(l.sellerId)) { listing = l; break; }
    }
  }
  if (!listing) { no('找不到「还没聊过」的商品，无法复现'); process.exit(1); }
  ok('选中商品 #' + listing.id + '「' + listing.title + '」卖家 id=' + listing.sellerId);

  const beforeIds = new Set((convs.data.list || []).map((c) => c.id));
  const opened = await A.main({
    path: '/api/conversations/open', method: 'POST',
    data: { listingId: listing.id, sendCard: true }, token
  });
  if (opened.code !== 0) { no('open 失败: ' + opened.message); process.exit(1); }
  const convId = opened.data.conversation.id;
  if (!beforeIds.has(convId)) ok('实例 A 新建了会话 #' + convId + '（对 A 是新会话）');
  else ok('会话 #' + convId + ' 已存在（A 复用）—— 稍后断言仍成立');

  console.log('\n=== 4. 关键：实例 B 去读这个会话的消息 ===');
  const got = await B.main({ path: '/api/conversations/' + convId + '/messages?limit=100', method: 'GET', data: {}, token });
  console.log('  实例 B 返回 code=' + got.code + (got.message ? '  message=' + got.message : ''));

  if (got.code === 0) {
    ok('B 能读到会话（新会话在其它实例立即可见）');
    console.log('  返回消息条数: ' + ((got.data && got.data.list) || []).length);
  } else {
    no('B 读不到刚建的会话 → 返回「' + (got.message || '') + '」');
    console.log('');
    console.log('  ⚠️  这正是用户看到的现象：');
    console.log('     错误信息含「不存在」→ 前端 chat.js 触发自愈 openChat({})');
    console.log('     → 不带 peerId → 后端回落到 AI 用户 → 压上第二层「AI 会话」');
  }

  console.log('\n=== 5. 会话里的消息也不能丢（sendCard 发出的商品卡）===');
  if (got.code === 0) {
    const list = (got.data && got.data.list) || [];
    const hasCard = list.some((m) => m.type === 'listing');
    if (hasCard) ok('包含了 sendCard 发出的商品卡片消息');
    else no('消息列表为空/缺商品卡片 —— 新会话的消息在 B 实例同样是过期的');
  }

  console.log('\n=== 6. 轮询增量：别的实例写入的新消息必须能被发现 ===');
  {
    // 先让 B 读一次，把会话与已消息补进内存
    const first = await B.main({ path: '/api/conversations/' + convId + '/messages?limit=100', method: 'GET', data: {}, token });
    const base = ((first.data && first.data.list) || []);
    const lastId = base.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
    ok('B 基线：' + base.length + ' 条，最大 id=' + lastId);

    // 实例 A 之外再写入一条（模拟对方/另一个实例发消息）
    const sent = await A.main({
      path: '/api/conversations/' + convId + '/messages', method: 'POST',
      data: { content: '在的，还在吗？', type: 'text' }, token
    });
    if (sent.code !== 0) no('A 发送失败: ' + sent.message);
    else ok('A 已写入新消息 #' + sent.data.message.id);

    // B 用 afterId 轮询 —— 内存镜像里没有这条新消息，只能靠回库拿到
    const inc = await B.main({
      path: '/api/conversations/' + convId + '/messages?limit=50&afterId=' + lastId,
      method: 'GET', data: {}, token
    });
    const list = (inc.data && inc.data.list) || [];
    const has = list.some((m) => String(m.content).indexOf('还在吗') > -1);
    if (inc.code === 0 && has) ok('B 轮询到了 A 写入的新消息（afterId 增量回库生效）');
    else no('B 轮询没拿到新消息：code=' + inc.code + ' 条数=' + list.length + '（消息镜像永不刷新）');
  }

  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败（问题已复现）' : '✅ 新会话在其它实例已可见'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
