/**
 * 聊天「消息乱跑 / 接收不同步 / 头像空白」回归测试。
 *
 * 守护的核心事实：
 *   **消息的时间轴只能认 createdAt，不能认 id。**
 *   云函数多实例下 id = seq * 65536 + 本实例随机槽位（见 db.js nextId），
 *   同一/相邻时刻的两条消息 id 谁大谁小取决于随机槽位 —— 按 id 排序就会出现
 *   「19:52 排在 19:50 上面」「同一秒发的上下翻飞」；按 id 做增量游标还会
 *   **漏消息**（别的实例写入的 id 比游标小 → 永远拉不到 → 要退出重进才看见）。
 *
 * 覆盖两部分（都是加载真实源码，只 mock 依赖）：
 *   A. 云端 route-social.js 的 GET /api/conversations/:id/messages
 *      —— 排序、afterAt/afterId 增量、beforeAt 翻页、会话预览取最新
 *   B. 前端 pages/chat/chat.js
 *      —— 合并排序、临时消息位置、增量游标、头像字标兜底
 *
 * 用法：node tools/test-chat-order.js
 */
const Module = require('module');

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ✗ ' + m); bad++; };

const ROOT = 'D:/wx/campus-xianyu';
const T0 = 1700000000000;

/* =========================================================================
 * A. 云端消息接口
 * ========================================================================= */

// 故意让「更早的消息 id 更大」—— 正是随机槽位造成的真实形态
const MSGS = [
  { id: 9000, convId: 7, senderId: 1, type: 'text', content: 'A', createdAt: T0, readBy: [1] },
  { id: 5000, convId: 7, senderId: 1, type: 'text', content: 'C', createdAt: T0 + 30000, readBy: [1] },
  { id: 100, convId: 7, senderId: 2, type: 'text', content: 'B', createdAt: T0 + 60000, readBy: [2] },
  { id: 50, convId: 7, senderId: 2, type: 'text', content: 'D', createdAt: T0 + 35000, readBy: [2] }
];

const conv = { id: 7, members: [1, 2], createdAt: T0 - 1000 };

const dbMock = {
  findByIdWithFallback: async (name, id) => ({
    doc: name === 'conversations' ? Object.assign({}, conv, { id: Number(id) }) : null,
    fromDb: true
  }),
  fetchByField: async (name, field, value) =>
    name === 'messages' ? MSGS.filter((m) => Number(m.convId) === Number(value)).map((m) => Object.assign({}, m)) : [],
  find: (name, pred) => (name === 'messages' ? MSGS.filter((m) => (pred ? pred(m) : true)) : []),
  findById: (name, id) => (name === 'conversations' ? Object.assign({}, conv, { id: Number(id) }) : null),
  one: () => null,
  get: () => [],
  insert: (name, o) => o,
  update: (name, id, patch) => Object.assign({}, patch, { id })
};

const utilC = {
  num: (v, d) => { const n = Number(v); return isNaN(n) ? (d === undefined ? 0 : d) : n; },
  clampText: (s) => String(s || ''),
  relTime: () => '刚刚',
  fmtPrice: (p) => String((Number(p) || 0) / 100),
  fmtTime: () => '00:00'
};

const routeTable = {};
const registerMock = (method, path, handler) => { routeTable[method + ' ' + path] = handler; };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /route-social\.js$/.test(parent.filename || '')) {
    if (request === './db') return dbMock;
    if (request === './util') return utilC;
    if (request === './deco') return { sellerBrief: (id) => ({ id, nickname: '小校助手', avatar: '' }), briefOf: (u) => u };
    if (request === './events') return { lastPreview: (m) => (m && (m.content || '[' + m.type + ']')) || '' };
    if (request === './interactions') return { TYPES: {}, decorate: (x) => x };
  }
  return origLoad.apply(this, arguments);
};

const socialMod = require(ROOT + '/cloudfunctions/campus/route-social.js');
socialMod(registerMock);
const getMsgs = routeTable['GET /api/conversations/:id/messages'];
if (!getMsgs) { console.error('未注册 GET /api/conversations/:id/messages'); process.exit(1); }

const ask = (query) => getMsgs({
  params: { id: '7' },
  query: new Map(Object.entries(query || {})),
  user: { id: 1 },
  body: {}
});

const texts = (r) => (r.list || []).map((m) => m.content).join('');

(async () => {
  console.log('=== A1. 首屏按 createdAt 升序（而不是 id 升序）===');
  {
    const r = await ask({});
    if (texts(r) === 'ACDB') ok('返回 A→C→D→B（时间顺序）');
    else no('返回 ' + texts(r) + '，应为 ACDB（时间顺序；按 id 排会得到 BCDA? 实际 ' +
      MSGS.slice().sort((a, b) => a.id - b.id).map((m) => m.content).join('') + '）');

    // 反向对照：证明这条断言真的能抓到「按 id 排序」的写法
    const byId = MSGS.slice().sort((a, b) => a.id - b.id).map((m) => m.content).join('');
    if (byId !== texts(r)) ok('反向对照：按 id 排序的结果是 ' + byId + '，与本接口不同 → 断言有效');
    else no('按 id 排序与时间排序结果相同，本用例无法区分（选材有问题）');
  }

  console.log('\n=== A2. afterAt 增量：能拉到 id 更小的新消息 ===');
  {
    // 游标停在 C（t0+30000）。接口留了 2 秒重叠窗口（防止边界漏消息），
    // 所以 C 会被重发一次 —— 前端按 id 去重，不会显示两遍。
    const r1 = await ask({ afterAt: String(T0 + 30000), afterId: '5000' });
    if (texts(r1) === 'CDB') ok('重叠窗口内重发 C，同时带上 D、B（CDB，重复由前端按 id 去重）');
    else no('返回 ' + texts(r1) + '，应为 CDB');

    // 越过重叠窗口后，只剩「游标之后」的消息：D(id=50) + B
    const r2 = await ask({ afterAt: String(T0 + 34000), afterId: '5000' });
    if (texts(r2) === 'DB') ok('返回 D→B（含 id=50 的 D，说明 id 更小也能拉到）');
    else no('返回 ' + texts(r2) + '，应为 DB');

    if (/D/.test(texts(r2))) ok('反向对照：若只认 afterId，id=50 < 5000 的 D 会被漏掉 → 断言有效');
    else no('D 未被返回');
  }

  console.log('\n=== A3. beforeAt 翻页：只拿更早的，且仍是时间升序 ===');
  {
    const r = await ask({ beforeAt: String(T0 + 30000), limit: '50' });
    if (texts(r) === 'A') ok('beforeAt 之后只剩 A');
    else no('返回 ' + texts(r) + '，应为 A');
  }

  console.log('\n=== A4. 会话预览取「时间最新」，不是 id 最大 ===');
  {
    const r = await ask({});
    const lm = r.conversation && r.conversation.lastMessage;
    if (lm === 'B') ok('lastMessage = B（时间最新那一条）');
    else no('lastMessage = ' + lm + '，应为 B（id=9000 的 A 才是最老的一条）');
  }

  /* =======================================================================
   * B. 前端聊天页
   * ======================================================================= */
  console.log('\n=== B1. 合并后按时间排（乱序 id 输入）===');
  {
    const p = makePage();
    p.data.convId = 7;
    p.applyMessages([
      { id: 9000, senderId: 1, type: 'text', content: 'A', createdAt: T0 },
      { id: 100, senderId: 2, type: 'text', content: 'B', createdAt: T0 + 60000 },
      { id: 5000, senderId: 1, type: 'text', content: 'C', createdAt: T0 + 30000 }
    ]);
    if (msgText(p) === 'ACB') ok('客户端顺序 A→C→B');
    else no('客户端顺序 ' + msgText(p) + '，应为 ACB');
  }

  console.log('\n=== B2. 新消息插到正确位置，不会「跑到上面」===');
  {
    const p = makePage();
    p.data.convId = 7;
    p.applyMessages([
      { id: 9000, senderId: 1, type: 'text', content: 'A', createdAt: T0 },
      { id: 100, senderId: 2, type: 'text', content: 'B', createdAt: T0 + 60000 }
    ]);
    // 轮询拉回一条「时间在中间、id 最小」的消息
    p.applyMessages([{ id: 7, senderId: 2, type: 'text', content: 'C', createdAt: T0 + 30000 }]);
    if (msgText(p) === 'ACB') ok('C 落在 A 与 B 之间（id=7 最小也不会顶到最上面）');
    else no('顺序 ' + msgText(p) + '，应为 ACB');
  }

  console.log('\n=== B3. 乐观上屏的临时消息始终在最后 ===');
  {
    const p = makePage();
    p.data.convId = 7;
    p.setData({
      messages: [
        { id: 100, senderId: 2, type: 'text', content: 'B', createdAt: T0 + 60000, mine: false },
        { id: 'tmp-1', mine: true, isText: true, content: '我刚发的', createdAt: Date.now() }
      ]
    });
    p.applyMessages([{ id: 9, senderId: 1, type: 'text', content: 'A', createdAt: T0 }]);
    const last = p.data.messages[p.data.messages.length - 1];
    if (last && last.id === 'tmp-1') ok('临时消息仍在末尾（不会因为新消息插入而被顶到上面）');
    else no('末尾是 ' + JSON.stringify(last && last.id));
  }

  console.log('\n=== B4. 增量拉取带上 afterAt（时间游标）===');
  {
    calls.apiGet.length = 0;
    const p = makePage();
    p.data.convId = 7;
    p.setData({
      messages: [
        { id: 5000, senderId: 1, type: 'text', content: 'C', createdAt: T0 + 30000 },
        { id: 'tmp-9', mine: true, isText: true, content: 'x', createdAt: Date.now() }
      ]
    });
    impl.get = async () => ({ list: [] });
    await p.pullNew();
    const url = calls.apiGet[0] || '';
    if (/afterAt=\d+/.test(url)) ok('URL 含 afterAt：' + url.replace(/^.*messages/, 'messages'));
    else no('URL 缺少 afterAt：' + url);
    if (/afterId=5000/.test(url)) ok('同时保留 afterId（兼容旧后端）');
    else no('URL 缺少 afterId：' + url);
  }

  console.log('\n=== B5. 翻页带上 beforeAt ===');
  {
    calls.apiGet.length = 0;
    const p = makePage();
    p.data.convId = 7;
    p.data.hasMore = true;
    p.setData({
      messages: [
        { id: 9000, senderId: 1, type: 'text', content: 'A', createdAt: T0 },
        { id: 100, senderId: 2, type: 'text', content: 'B', createdAt: T0 + 60000 }
      ]
    });
    impl.get = async () => ({ list: [] });
    await p.loadMore();
    const url = calls.apiGet[0] || '';
    if (/beforeAt=\d+/.test(url)) ok('URL 含 beforeAt：' + url.replace(/^.*messages/, 'messages'));
    else no('URL 缺少 beforeAt：' + url);
  }

  console.log('\n=== B6. 头像字标兜底（不再是一块灰白方块）===');
  {
    const p = makePage();
    appMock.globalData.user = { id: 1, nickname: '张三', avatar: '' };
    p.syncMyAvatar();
    if (p.data.myAvatar === '' && p.data.myAvatarLetter === '张') ok('没设头像 → 字标「张」');
    else no('myAvatar=' + p.data.myAvatar + ' letter=' + p.data.myAvatarLetter);

    appMock.globalData.user = { id: 1, nickname: '张三', avatar: 'cloud://env/a.png' };
    p.data.myAvatarErr = true;
    p.syncMyAvatar();
    if (p.data.myAvatar === 'cloud://env/a.png' && p.data.myAvatarErr === false) ok('有头像 → 用图片，并清掉上一次的加载失败标记');
    else no('myAvatar=' + p.data.myAvatar + ' err=' + p.data.myAvatarErr);

    p.syncPeerAvatar({ id: 99, nickname: '小校助手', avatar: '' });
    if (p.data.peerAvatar === '' && p.data.peerAvatarLetter === '小') ok('AI 客服没头像 → 字标「小」');
    else no('peerAvatar=' + p.data.peerAvatar + ' letter=' + p.data.peerAvatarLetter);

    p.onMyAvatarErr();
    if (p.data.myAvatarErr === true) ok('图片加载失败 → 标记为失败，模板退回字标');
    else no('onMyAvatarErr 未生效');
  }

  console.log('\n' + (bad ? '✗ 有 ' + bad + ' 项失败' : '✓ 全部通过'));
  process.exit(bad ? 1 : 0);
})();

/* ---------- 前端测试脚手架（加载真实 chat.js）---------- */
function msgText(p) { return (p.data.messages || []).map((m) => m.content).join(''); }

const calls = { apiGet: [] };
const impl = { get: async () => ({ list: [], conversation: {} }) };

const appMock = {
  globalData: { user: { id: 1, nickname: '张三', avatar: '' }, statusBarHeight: 20, navBarHeight: 64 },
  on() { }, off() { }, emit() { }, refreshUnread() { }
};

const apiMock = {
  init() { }, token: () => 'tok', abs: (p) => p || '',
  upload: async () => 'cloud://env/x.jpg',
  get: async (url) => { calls.apiGet.push(url); return impl.get(url); },
  post: async () => ({ ok: true })
};

const wsMock = {
  typing() { }, watchMessages() { }, closeMessages() { }, sendChat: async () => ({ message: null }),
  requestAiReply: async () => ({ ok: true })
};

const utilMock = {
  fmtTime: () => '00:00',
  fmtPrice: (p) => String((Number(p) || 0) / 100),
  relTime: () => '刚刚',
  // 与 utils/util.js 同语义的最小实现
  avatarFallback(u) {
    const o = u || {};
    return { letter: (String(o.nickname || '?').trim()[0] || '?'), bg: '#FDE7E0', fg: '#D4573A' };
  }
};

global.Page = (opts) => { global.__pageDef = opts; };
global.getApp = () => appMock;
global.getCurrentPages = () => [{}, {}];
global.wx = {
  getStorageSync: () => '', setStorageSync() { }, removeStorageSync() { },
  showToast() { }, showLoading() { }, hideLoading() { }, navigateTo() { }, navigateBack() { },
  switchTab() { }, previewImage() { }, showActionSheet() { }, chooseMedia() { },
  cloud: { database: () => ({ collection: () => ({ where: () => ({ watch: () => ({ close() { } }) }) }) }) }
};

const pageLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /pages[\\/]chat[\\/]chat\.js$/.test(parent.filename || '')) {
    if (request === '../../utils/api') return apiMock;
    if (request === '../../utils/ws') return wsMock;
    if (request === '../../utils/util') return utilMock;
    if (request === '../../utils/const') return { QUICK_WORDS: [], AI_QUICK: [] };
  }
  return pageLoad.apply(this, arguments);
};
require(ROOT + '/miniprogram/pages/chat/chat.js');
const pageDef = global.__pageDef;
if (!pageDef) { console.error('无法加载 chat.js（Page 未被调用）'); process.exit(1); }

function makePage() {
  const inst = Object.create(null);
  for (const k of Object.keys(pageDef)) inst[k] = pageDef[k];
  inst.data = JSON.parse(JSON.stringify(pageDef.data || {}));
  inst.setData = function (patch) { Object.assign(this.data, patch); };
  return inst;
}
