/**
 * 聊天页发送链路仿真测试。
 *
 * 真正加载 miniprogram/pages/chat/chat.js（mock 掉 wx / getApp / api / ws），
 * 驱动页面方法，验证「发出去就看得见」这条核心体验。
 *
 * 守护的是这几类真实 bug：
 *   1. 图片/商品卡片消息发完不上屏 → 要等轮询或退出重进才出现
 *   2. 乐观上屏用 tmp- 开头的 id 当 afterId → 后端拿不到增量，轮询退化
 *   3. 用返回值替换临时消息时不去重 → 同一句话显示两遍
 *   4. AI 回复「只拉一次就放弃」→ 用户以为没回复，再发一条才看到上一条的回复
 *   5. 进页面只加载 50 条 → 对话稍长就显示不全
 *
 * 用法：node tools/test-chat-send.js
 */
const Module = require('module');
const fs = require('fs');

const CHAT = 'D:/wx/campus-xianyu/miniprogram/pages/chat/chat.js';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/* ---------- 把定时器加速，测试不用真等 5 秒 ---------- */
const realSetTimeout = global.setTimeout;
const fastTimeout = (fn, ms) => realSetTimeout(fn, 0);
global.setTimeout = fastTimeout;
const tick = () => new Promise((r) => realSetTimeout(r, 20));

/* ---------- mock 依赖 ---------- */
const appMock = {
  globalData: { user: { id: 1 }, statusBarHeight: 20, navBarHeight: 64, lastIncoming: null },
  on() { }, off() { }, emit() { }, refreshUnread() { }, setBadge() { },
  // 统一开会话入口。
  // ⚠️ chat.js 曾经在「会话读不到」时用它兜底：openChat({}) 不带 peerId，
  //    后端会回落到 AI 用户 → 用户点的是卖家会话，却被丢进 AI 会话。
  //    这里记录调用次数，钉住「不许再用它兜底」。
  openChat() { calls.openChat++; }
};

const calls = { apiGet: [], sendChat: [], upload: 0, requestAiReply: 0, markRead: 0, openChat: 0, navigateBack: 0 };
const impl = {
  get: async () => ({ list: [], conversation: {} }),
  sendChat: async () => ({ message: null, aiMessage: null }),
  upload: async () => 'cloud://env.bucket/test.jpg'
};

const apiMock = {
  init() { },
  token: () => 'tok',
  abs: (p) => p || '',
  upload: async () => { calls.upload++; return impl.upload(); },
  get: async (url, data, o) => { calls.apiGet.push(url); return impl.get(url, data, o); },
  post: async (url, body) => {
    if (/\/read$/.test(url)) calls.markRead++;
    return { ok: true };
  },
  del: async () => ({ ok: true })
};

const wsMock = {
  on() { }, off() { }, typing() { }, isConnected: () => true, isWatching: () => false,
  watchMessages() { }, closeMessages() { },
  sendChat: async (convId, payload) => {
    calls.sendChat.push({ convId, payload });
    return impl.sendChat(convId, payload);
  },
  requestAiReply: async () => { calls.requestAiReply++; return { ok: true }; }
};

const utilMock = {
  fmtTime: (t) => '刚刚', fmtPrice: (p) => ((Number(p) || 0) / 100).toFixed(2), relTime: () => '刚刚',
  // 头像字标兜底（utils/util.js 里有；缺了它 syncMyAvatar 会抛错）
  avatarFallback: (u) => {
    const o = u || {};
    return { letter: (String(o.nickname || '?').trim()[0] || '?'), bg: '#FDE7E0', fg: '#D4573A' };
  }
};
const constMock = { QUICK_WORDS: [], AI_QUICK: [] };

/* ---------- mock 小程序全局 ---------- */
const mediaBox = { cb: null };
global.Page = (opts) => { global.__pageDef = opts; };
global.getApp = () => appMock;
// 小程序全局：当前页面栈。这里返回 2 层，表示「聊天页是从别的页面跳进来的」，
// 于是失败兜底走 navigateBack（对应真实观感：返回上一层）。
global.getCurrentPages = () => [{}, {}];
global.wx = {
  getStorageSync: () => '', setStorageSync() { }, removeStorageSync() { },
  showToast() { }, showModal() { }, showLoading() { }, hideLoading() { },
  navigateTo() { }, navigateBack() { calls.navigateBack++; }, switchTab() { }, previewImage() { }, showActionSheet() { },
  cloud: { database: () => ({ collection: () => ({ where: () => ({ watch: () => ({ close() { } }) }) }) }) },
  chooseMedia: (opts) => { mediaBox.cb = opts.success; }
};

/* ---------- 拦截 require，加载 chat.js ---------- */
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../../utils/api') return apiMock;
  if (request === '../../utils/ws') return wsMock;
  if (request === '../../utils/util') return utilMock;
  if (request === '../../utils/const') return constMock;
  return origLoad.apply(this, arguments);
};
require(CHAT);
const pageDef = global.__pageDef;
if (!pageDef) { console.error('无法加载 chat.js（Page 未被调用）'); process.exit(1); }

/* ---------- 构造页面实例 ---------- */
function makePage(extra) {
  const inst = Object.create(null);
  for (const k of Object.keys(pageDef)) {
    inst[k] = typeof pageDef[k] === 'function' ? pageDef[k] : pageDef[k];
  }
  inst.data = JSON.parse(JSON.stringify(pageDef.data || {}));
  inst.setData = function (patch) { Object.assign(this.data, patch); };
  Object.assign(inst.data, extra || {});
  return inst;
}
const ids = (p) => p.data.messages.map((m) => m.id);
const sleep = () => tick();

(async () => {
  console.log('=== 1. lastRealMsg 必须跳过乐观上屏的临时消息 ===');
  {
    const p = makePage();
    p.setData({ messages: [{ id: 1 }, { id: 'tmp-999' }] });
    const last = p.lastRealMsg();
    if (last && last.id === 1) ok('末尾是临时消息时，取到的是真实消息 id=1（不会把 tmp- 传给 afterId）');
    else no('lastRealMsg 取到 ' + JSON.stringify(last) + '，应跳过 tmp-');
    p.setData({ messages: [{ id: 'tmp-a' }, { id: 'tmp-b' }] });
    if (p.lastRealMsg() === null) ok('全部是临时消息时返回 null（调用方不会误用）');
    else no('应返回 null');
  }

  console.log('\n=== 2. replaceTemp 替换临时消息且不产生重复 ===');
  {
    const p = makePage();
    // 模拟「轮询已经抢先把真实消息插进来」的竞态
    p.setData({ messages: [{ id: 'tmp-1', mine: true }, { id: 10, senderId: 1, mine: true }] });
    p.replaceTemp('tmp-1', { id: 10, senderId: 1, type: 'text', content: '你好', createdAt: 1, readBy: [1] });
    const list = p.data.messages;
    if (list.length === 1 && list[0].id === 10) ok('临时消息被移除，真实消息只保留一条（无重复）');
    else no('结果 ' + JSON.stringify(ids(p)) + '，应为 [10]');

    p.setData({ messages: [{ id: 'tmp-2', mine: true }] });
    p.replaceTemp('tmp-2', { id: 11, senderId: 1, type: 'text', content: 'hi', createdAt: 1, readBy: [1] });
    if (ids(p).join(',') === '11') ok('常规替换：临时换成真实');
    else no('结果 ' + ids(p).join(','));

    p.setData({ messages: [{ id: 'tmp-3', mine: true }] });
    p.dropTemp('tmp-3');
    if (p.data.messages.length === 0) ok('dropTemp 能撤回临时消息（发送失败时不残留）');
    else no('dropTemp 未生效');
  }

  console.log('\n=== 3. pullNew 用真实 id 作为 afterId ===');
  {
    const p = makePage({ convId: 5 });
    calls.apiGet.length = 0;
    impl.get = async () => ({ list: [], conversation: {} });
    p.setData({ messages: [{ id: 77 }, { id: 'tmp-x' }] });
    await p.pullNew();
    const url = calls.apiGet[calls.apiGet.length - 1] || '';
    if (/afterId=77/.test(url)) ok('afterId 用的是真实消息 id（URL: ' + url.replace(/^.*messages/, 'messages') + '）');
    else no('afterId 不正确：' + url);

    calls.apiGet.length = 0;
    p.setData({ messages: [{ id: 'tmp-only' }] });
    await p.pullNew();
    const url2 = calls.apiGet[calls.apiGet.length - 1] || '';
    if (!/afterId=/.test(url2)) ok('只有临时消息时不带 afterId（避免 NaN 导致增量失效）');
    else no('不应带 afterId：' + url2);
  }

  console.log('\n=== 4. send：乐观上屏 → 替换 → AI 回复直接显示 ===');
  {
    const p = makePage({ convId: 5, isAI: true, input: '你好', sending: false });
    calls.sendChat.length = 0;
    impl.sendChat = async () => ({
      message: { id: 101, senderId: 1, type: 'text', content: '你好', createdAt: 1, readBy: [1] },
      aiMessage: { id: 102, senderId: 9, type: 'text', content: '嗨，我是小校助手', createdAt: 2, readBy: [9] }
    });
    await p.send();
    const list = ids(p);
    const hasTemp = list.some((x) => String(x).indexOf('tmp-') === 0);
    if (list.length === 2 && list.indexOf(101) > -1 && list.indexOf(102) > -1 && !hasTemp) {
      ok('我的消息 + AI 回复都在屏上，临时消息已清理（' + list.join(', ') + '）');
    } else no('结果 ' + JSON.stringify(list) + '，应为 [101, 102] 且无 tmp-');
    if (p.data.typing === false) ok('「正在输入」已收起');
    else no('typing 应为 false');
    if (p.data.input === '') ok('输入框已清空');
    else no('输入框未清空');
  }

  console.log('\n=== 5. send：主通道没带 AI 回复时，必须主动等到回复（核心修复）===');
  {
    const p = makePage({ convId: 5, isAI: true, input: '怎么发布', sending: false });
    impl.sendChat = async () => ({
      message: { id: 201, senderId: 1, type: 'text', content: '怎么发布', createdAt: 1, readBy: [1] },
      aiMessage: null            // ← 主通道没带回，这正是「发两次才回复」的触发条件
    });
    // 模拟：AI 回复要过几轮才可见（后端正在生成）
    let rounds = 0;
    p.pullNew = async function () {
      rounds++;
      if (rounds >= 3) {
        this.setData({
          messages: this.data.messages.concat([
            { id: 202, senderId: 9, mine: false, isText: true, content: '点底部+号', timeText: '刚刚' }
          ]),
          typing: false
        });
        return true;
      }
      return false;
    };
    await p.send();
    await sleep();
    await sleep();
    if (rounds >= 3 && ids(p).indexOf(202) > -1) {
      ok('连续重试 ' + rounds + ' 轮后拿到了 AI 回复并上屏（旧逻辑只拉 1 次就放弃）');
    } else no('重试 ' + rounds + ' 轮，消息 ' + JSON.stringify(ids(p)) + '；应重试并按到 AI 回复');
    if (p.data.typing === false) ok('「正在输入」已收起');
    else no('typing 应为 false');
  }

  console.log('\n=== 6. sendImage：本地图先上屏 → 上传后替换为 fileID ===');
  {
    const p = makePage({ convId: 5, isAI: false });
    calls.upload = 0;
    impl.sendChat = async () => ({
      message: { id: 301, senderId: 1, type: 'image', content: 'cloud://env.bucket/up.jpg', createdAt: 1, readBy: [1] },
      aiMessage: null
    });
    p.sendImage();
    if (typeof mediaBox.cb !== 'function') { no('chooseMedia 未被调用'); }
    else {
      mediaBox.cb({ tempFiles: [{ tempFilePath: 'wxfile://tmp/local.jpg' }] });
      await sleep();
      const list = p.data.messages;
      const img = list.filter((m) => m.isImage);
      if (img.length === 1 && img[0].content === 'cloud://env.bucket/up.jpg') {
        ok('图片已上屏且已是云文件（' + img[0].content + '）');
      } else no('图片消息异常：' + JSON.stringify(list.map((m) => ({ id: m.id, c: m.content }))));
      if (calls.upload === 1) ok('确实走了上传流程');
      else no('上传次数 ' + calls.upload);
    }
  }

  console.log('\n=== 7. sendImage：上传失败时撤回本地图，不残留 ===');
  {
    const p = makePage({ convId: 5, isAI: false });
    impl.upload = async () => { throw new Error('云存储权限不足'); };
    p.sendImage();
    mediaBox.cb({ tempFiles: [{ tempFilePath: 'wxfile://tmp/bad.jpg' }] });
    await sleep();
    if (p.data.messages.length === 0) ok('失败后临时图片已撤回（不会留下永远发不出去的图）');
    else no('残留 ' + p.data.messages.length + ' 条');
    impl.upload = async () => 'cloud://env.bucket/test.jpg';
  }

  console.log('\n=== 8. sendListing：商品卡片也要上屏 ===');
  {
    const p = makePage({ convId: 5, isAI: false });
    p.setData({ myListings: [{ id: 7, title: '山地自行车', price: 65000, cover: 'cloud://x/a.jpg', priceText: '650.00' }] });
    impl.sendChat = async () => ({
      message: {
        id: 401, senderId: 1, type: 'listing', createdAt: 1, readBy: [1],
        card: { listingId: 7, title: '山地自行车', image: 'cloud://x/a.jpg', price: 65000 }
      },
      aiMessage: null
    });
    await p.sendListing({ currentTarget: { dataset: { id: 7 } } });
    const list = p.data.messages;
    if (list.length === 1 && list[0].id === 401 && list[0].isListing) ok('商品卡片已上屏（id=401, isListing=true）');
    else no('结果 ' + JSON.stringify(list.map((m) => ({ id: m.id, isListing: m.isListing }))));
    if (list[0] && list[0].cardImg) ok('卡片图片已处理（' + list[0].cardImg + '）');
    else no('卡片图片缺失');
  }

  console.log('\n=== 9. 进页面加载上限应为 100（此前 50 会显示不全）===');
  {
    const p = makePage({ convId: 5 });
    calls.apiGet.length = 0;
    impl.get = async () => ({ list: [], conversation: {} });
    await p.load(true);
    const url = calls.apiGet[0] || '';
    if (/limit=100/.test(url)) ok('加载 ' + url.replace(/^.*messages/, 'messages'));
    else no('加载上限不对：' + url);
  }

  console.log('\n=== 10. 切回页面（onShow）应主动补拉 ===');
  {
    const p = makePage({ convId: 5, loading: false });
    let pulled = 0;
    p.pullNew = async () => { pulled++; return true; };
    p.onShow();
    if (pulled === 1) ok('onShow 触发了一次补拉（切后台回来不再漏消息）');
    else no('onShow 补拉次数 ' + pulled);
    const p2 = makePage({ convId: 0, loading: false });
    let pulled2 = 0;
    p2.pullNew = async () => { pulled2++; return true; };
    p2.onShow();
    if (pulled2 === 0) ok('无会话时不补拉（防御到位）');
    else no('不应补拉');
  }

  console.log('\n=== 11. 【核心回归】迟到的旧响应不得抹掉新消息 ===');
  {
    // 精确复现线上现象：云函数冷启动导致 load 的响应很晚才回来，
    // 这期间用户已发消息、AI 也回复了，旧快照覆盖会把它们抹掉。
    const p = makePage({ convId: 5, isAI: true, loading: true, myListings: [{}] });
    let release = null;
    impl.get = () => new Promise((r) => { release = r; });      // 手动控制响应时机

    const loading = p.load(true);                               // 请求发出，挂起
    await sleep();
    // 响应还没回来时，用户发了消息（id 3）且 AI 回复（id 4）
    p.applyMessages([
      { id: 3, senderId: 1, type: 'text', content: '我发的图片', createdAt: 3, readBy: [1] },
      { id: 4, senderId: 9, type: 'text', content: '这是科贸小鱼里的二手商品图片呢', createdAt: 4, readBy: [9] }
    ]);
    if (ids(p).join(',') === '3,4') ok('响应到达前，消息已在屏上（3,4）');
    else no('前置状态异常：' + ids(p).join(','));

    // 迟到的旧响应终于返回 —— 只含更早的 1、2
    release({ list: [
      { id: 1, senderId: 9, type: 'text', content: '欢迎来到科贸小鱼', createdAt: 1, readBy: [9] },
      { id: 2, senderId: 1, type: 'text', content: '好的', createdAt: 2, readBy: [1] }
    ], conversation: {} });
    await loading;

    const got = ids(p).join(',');
    if (got === '1,2,3,4') ok('旧响应只补进了 1,2，新消息 3,4 未被抹掉（' + got + '）');
    else no('消息被覆盖了！结果 ' + got + '，应为 1,2,3,4');
    if (p.data.loading === false) ok('loading 已复位');
    else no('loading 未复位');
    impl.get = async () => ({ list: [], conversation: {} });
  }

  console.log('\n=== 12. mergeMessages 排序与临时消息保留 ===');
  {
    const p = makePage();
    p.setData({ messages: [{ id: 'tmp-1', mine: true }, { id: 5 }] });
    const r = p.mergeMessages([
      { id: 9, senderId: 1, type: 'text', createdAt: 9, readBy: [1] },
      { id: 3, senderId: 9, type: 'text', createdAt: 3, readBy: [9] },
      { id: 5, senderId: 1, type: 'text', createdAt: 5, readBy: [1] }   // 已存在，不应计为新增
    ]);
    if (r.list.map((m) => m.id).join(',') === '3,5,9,tmp-1') ok('按 createdAt 升序排列，临时消息排在最后');
    else no('顺序不对：' + r.list.map((m) => m.id).join(','));
    if (r.added === 2) ok('新增计数正确（2 条，已存在的 5 不重复计）');
    else no('added = ' + r.added + '，应为 2');
    if (r.gotPeer) ok('识别出对方消息（用于收起「正在输入」）');
    else no('未识别出对方消息');
  }

  console.log('\n=== 13. loadMore 把更早的消息排到前面 ===');
  {
    const p = makePage({ convId: 5, hasMore: true, loadingMore: false });
    p.setData({ messages: [{ id: 10, senderId: 1, type: 'text', createdAt: 10, readBy: [1] },
      { id: 11, senderId: 1, type: 'text', createdAt: 11, readBy: [1] }] });
    impl.get = async () => ({ list: [
      { id: 8, senderId: 9, type: 'text', createdAt: 8, readBy: [9] },
      { id: 9, senderId: 1, type: 'text', createdAt: 9, readBy: [1] }
    ], conversation: {} });
    await p.loadMore();
    const got = ids(p).join(',');
    if (got === '8,9,10,11') ok('更早的消息排到了前面（' + got + '）');
    else no('顺序不对：' + got);
    impl.get = async () => ({ list: [], conversation: {} });
  }

  console.log('\n=== 14. 【核心回归】用户信息晚到时，不能把自己的消息判成对方的 ===');
  {
    const savedUser = appMock.globalData.user;
    appMock.globalData.user = null;              // 模拟冷启动：用户信息还没到
    const p = makePage({ convId: 5 });
    // 后端返回：我的消息(1，senderId=我的id=1) + AI 的消息(2)
    const r = p.mergeMessages([
      { id: 1, senderId: 1, type: 'text', content: '我是王鸿秀', createdAt: 1, readBy: [1] },
      { id: 2, senderId: 9, type: 'text', content: '嗨，王鸿秀同学', createdAt: 2, readBy: [9] }
    ]);
    p.setData({ messages: r.list });
    const before = p.data.messages.map((m) => (m.mine ? 'mine' : 'peer')).join(',');
    if (before === 'peer,peer') ok('前置状态：myId 未知时确实全被判成对方（' + before + '）');

    // 用户信息到达
    appMock.globalData.user = savedUser;         // id = 1
    p.redecoAll();
    const after = p.data.messages.map((m) => (m.mine ? 'mine' : 'peer')).join(',');
    if (after === 'mine,peer') ok('用户信息到达后自动纠正：自己发的变成 mine（' + after + '）');
    else no('未纠正，仍为 ' + after + '，应为 mine,peer');
  }

  console.log('\n=== 15. redecoAll 不应影响临时消息 ===');
  {
    const p = makePage();
    p.setData({
      messages: [
        { id: 'tmp-1', mine: true, isText: true, content: '发送中' },
        { id: 7, senderId: 1, type: 'text', content: 'hi', createdAt: 7, readBy: [1], mine: false }
      ]
    });
    p.redecoAll();
    const t = p.data.messages.find((m) => m.id === 'tmp-1');
    const real = p.data.messages.find((m) => m.id === 7);
    if (t && t.mine === true) ok('临时消息保持 mine=true 不被改动');
    else no('临时消息被改了：' + JSON.stringify(t));
    if (real && real.mine === true) ok('已落库消息被纠正为 mine=true');
    else no('已落库消息未纠正：' + JSON.stringify(real));
  }

  console.log('\n=== 16. 【核心回归】AI 回复经发送接口回传时，必须上报已读 ===');
  {
    // 这是「退出聊天后 AI 那一行还挂着红点」的直接原因：
    // AI 回复若通过 send 的返回值上屏，不会经过轮询/订阅，
    // 若不上报已读，服务端就一直认为这条回复未被读。
    const p = makePage({ convId: 5, isAI: true, input: '你好', sending: false });
    calls.markRead = 0;
    impl.sendChat = async () => ({
      message: { id: 501, senderId: 1, type: 'text', content: '你好', createdAt: 1, readBy: [1] },
      aiMessage: { id: 502, senderId: 9, type: 'text', content: '嗨，我是小校助手', createdAt: 2, readBy: [9] }
    });
    await p.send();
    await sleep();
    if (calls.markRead > 0) ok('收到 AI 回复后上报了已读（' + calls.markRead + ' 次）');
    else no('没有上报已读 → 退出后消息中心会一直挂着未读红点');
  }

  console.log('\n=== 17. 【核心回归】已有消息绝不被重排（否则会「答非所问」）===');
  {
    // 场景：AI 回复的 id 可能比后续提问更大——因为它的创建时刻取决于大模型何时返回。
    //   列表已有：欢迎(1) 提问A(10) 提问B(11)
    //   现在到达：回复B(12)、回复A(13)   ← 13 反而比 11 大
    //   若按 id 全局排序 → 1,10,11,12,13 → 回复A 被挤到回复B 后面 = 「答非所问」
    //   正确行为：已有消息保持原位，新消息只插到该去的位置
    const p = makePage({ convId: 5, isAI: true });
    const base = [
      { id: 1, senderId: 9, type: 'text', content: '欢迎', createdAt: 1, readBy: [9] },
      { id: 10, senderId: 1, type: 'text', content: '问题A', createdAt: 2, readBy: [1] },
      { id: 11, senderId: 1, type: 'text', content: '问题B', createdAt: 3, readBy: [1] }
    ];
    p.setData({ messages: p.mergeMessages(base).list });
    const before = ids(p).join(',');
    const r = p.mergeMessages([
      { id: 12, senderId: 9, type: 'text', content: '回复B', createdAt: 4, readBy: [9] },
      { id: 13, senderId: 9, type: 'text', content: '回复A', createdAt: 5, readBy: [9] }
    ]);
    const after = r.list.map((m) => m.id).join(',');
    console.log('      合并前：' + before);
    console.log('      合并后：' + after);
    // 已有消息的相对先后必须逐一保持
    const kept = before.split(',').filter((x) => after.split(',').indexOf(x) > -1);
    const pos = kept.map((x) => after.split(',').indexOf(x));
    const mono = pos.every((v, i) => i === 0 || v > pos[i - 1]);
    if (mono) ok('已有消息的相对顺序完整保持（' + kept.join(',') + '）—— 不会被重排');
    else no('已有消息被重排了：' + kept.join(','));
  }

  console.log('\n=== 18. 商品卡片消息的结构必须与 wxml 一致 ===');
  {
    // chat.wxml 里卡片列表写的是 wx:key="listingId" 与 data-id="{{c.listingId}}"，
    // 所以后端 card 里必须带 listingId。
    // 曾经写成 c.id（字段名对不上），导致 wx:key 全为 undefined → 列表渲染错乱、
    // 点卡片也点不进去，且只有「找东西」这条路径会触发。
    const p = makePage({ convId: 5, isAI: true });
    const r = p.mergeMessages([
      { id: 1, senderId: 1, type: 'text', content: '帮我找辆自行车', createdAt: 1, readBy: [1] },
      { id: 2, senderId: 9, type: 'text', content: '当然可以！有一辆山地自行车', createdAt: 2, readBy: [9] },
      { id: 3, senderId: 9, type: 'listings', content: '', createdAt: 3, readBy: [9],
        card: [{ listingId: 6, title: '山地自行车 深蓝 通勤代步', image: '/static/img/p01.jpg', price: 65000 }] }
    ]);
    p.setData({ messages: r.list });

    if (r.list.length === 3) ok('提问 + AI 文字 + 商品卡片 三条都在列表里');
    else no('列表只有 ' + r.list.length + ' 条，应为 3 条');

    const cardMsg = p.data.messages.find((m) => m.id === 3);
    if (cardMsg && cardMsg.isListings) ok('卡片消息 isListings=true（wxml 才会渲染卡片区）');
    else no('卡片消息未识别为 isListings，wxml 不会渲染');

    const c = ((cardMsg && cardMsg.cards) || [])[0] || {};
    if (c.listingId) ok('卡片含 listingId=' + c.listingId + '（wx:key 与 data-id 依赖它）');
    else no('卡片缺 listingId → wx:key 全为 undefined、列表渲染错乱、点卡片无效');
    if (c.cover) ok('卡片图片：' + c.cover);
    else no('卡片图片缺失');
    if (c.priceText) ok('卡片价格已格式化：' + c.priceText);
    else no('卡片价格缺失');
    if (cardMsg && cardMsg.mine === false) ok('卡片判为对方消息（显示在左侧）');
    else no('卡片消息归属错误');
  }

  console.log('\n=== 19. 会话读不到时：重试原会话，绝不跳 AI 会话 ===');
  {
    // 真实场景：
    //   点「聊一聊」→ 另一个云函数实例刚把会话落库 →
    //   本实例第一次读报「会话不存在」（见 tools/test-conv-fresh.js）
    //   旧实现用 app.openChat({}) 兜底 → 后端回落到 AI 用户
    //   → 用户在「卖家会话」之上又看到一层「AI 会话」，返回才回到卖家会话。
    const savedGet = impl.get;
    const convId = 7;

    // 19.1 第一次失败、第二次成功 → 应静默重试同一个会话，且不碰 openChat
    calls.openChat = 0; calls.navigateBack = 0;
    let n = 0;
    impl.get = async () => {
      n++;
      if (n === 1) throw new Error('会话不存在');
      return { list: [{ id: 30, senderId: 9, type: 'text', content: '在的', createdAt: 1, readBy: [9] }], conversation: {} };
    };
    const p = makePage({ convId, isAI: false });
    p.load(true);
    await sleep(); await sleep(); await sleep(); await sleep();

    if (calls.openChat === 0) ok('没有调用 openChat（不会把用户丢进 AI 会话）');
    else no('调用了 openChat ' + calls.openChat + ' 次 —— 这正是「进卖家会话却冒出 AI 会话」的原因');
    if (n >= 2) ok('对同一个会话重试了（共请求 ' + n + ' 次）');
    else no('没有重试，只请求了 ' + n + ' 次');
    if (p.data.messages.length === 1 && p.data.messages[0].id === 30) ok('重试成功后消息正常上屏');
    else no('重试后消息没上屏：' + JSON.stringify(p.data.messages.map((m) => m.id)));

    // 19.2 一直失败 → 提示后退出本页，同样不碰 openChat
    calls.openChat = 0; calls.navigateBack = 0;
    impl.get = async () => { throw new Error('会话不存在'); };
    const q = makePage({ convId: 999, isAI: false });
    q.load(true);
    await sleep(); await sleep(); await sleep(); await sleep(); await sleep();
    if (calls.openChat === 0) ok('彻底失败时也没调用 openChat');
    else no('彻底失败时调用了 openChat ' + calls.openChat + ' 次');
    if (calls.navigateBack === 1) ok('彻底失败 → 顺势退出本页（不留死页）');
    else no('彻底失败时应返回上一页，实际 navigateBack=' + calls.navigateBack);

    impl.get = savedGet;
  }

  console.log('\n=== 20. 我发的消息必须显示我自己的头像 ===');
  {
    // 模板里原本只有 `wx:if="{{!item.mine}}"` 的对方头像 —— 我发的消息**完全没有头像**，
    // 而样式 `.msg-row.mine { flex-direction: row-reverse }` 本就是给「我这侧带头像」准备的。
    const wxml = fs.readFileSync(CHAT.replace(/\.js$/, '.wxml'), 'utf8');
    const hasMineAvatar = /src="\{\{myAvatar\}\}"/.test(wxml);
    // 头像为空/加载失败时必须有字标兜底（否则就是一块灰白方块）
    const hasLetter = /m-avatar av-letter/.test(wxml) && /\{\{myAvatarLetter\}\}/.test(wxml);
    if (hasMineAvatar && hasLetter) ok('模板里「我发的消息」也有头像（绑定 myAvatar + 字标兜底）');
    else if (!hasMineAvatar) no('模板里我发的消息没有头像 —— 用户会反馈「聊天里我的头像没了」');
    else no('头像缺字标兜底 —— 没设头像时会显示成一块灰白方块');

    // 行为：用户信息里的 avatar 要能同步到 myAvatar
    const savedUser = appMock.globalData.user;
    appMock.globalData.user = { id: 1, avatar: '/static/avatars/a01.jpg' };
    const p = makePage({ convId: 5 });
    p.syncMyAvatar();
    if (p.data.myAvatar) ok('syncMyAvatar 取到了头像：' + p.data.myAvatar);
    else no('syncMyAvatar 没有设置 myAvatar');

    // 用户信息晚到时（冷启动常见）要能补上
    appMock.globalData.user = null;
    const q = makePage({ convId: 5 });
    q.syncMyAvatar();
    if (!q.data.myAvatar) ok('用户信息未就绪时不会瞎猜（myAvatar 保持为空）');
    else no('用户信息为空时不该设置头像');
    appMock.globalData.user = savedUser;
  }

  global.setTimeout = realSetTimeout;
  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 发送链路正确：自己发的立刻可见、判得准，迟到响应不覆盖，AI 回复会主动等到并标记已读'));
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  global.setTimeout = realSetTimeout;
  console.error('测试崩溃:', e);
  process.exit(1);
});
