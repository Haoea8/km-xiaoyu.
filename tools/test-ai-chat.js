/**
 * AI 客服对话端到端测试。
 *
 * 复现用户反馈的场景：
 *   1) 发消息内容变成 "[object Object]"（事件对象被当参数）
 *   2) AI 完全不回复
 *   3) 前端提示「发送失败」
 *
 * 本测试在 mock 数据库上真实加载云函数，走完整链路：
 *   初始化 → 登录 → 打开与 AI 的会话 → 发消息 → 断言 AI 回复已生成
 */
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';

/* ---------- mock 数据库 ---------- */
const store = {};
function col(n) { if (!store[n]) store[n] = {}; return store[n]; }

function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) { col(name)[String(id)] = Object.assign({ _id: String(id) }, data); return Promise.resolve({}); },
        get() {
          const d = col(name)[String(id)];
          if (!d) { const e = new Error('document does not exist'); return Promise.reject(e); }
          return Promise.resolve({ data: d });
        },
        remove() { delete col(name)[String(id)]; return Promise.resolve({}); }
      };
    },
    where(cond) {
      const match = (d) => Object.keys(cond || {}).every((k) => {
        const v = d[k];
        const want = cond[k];
        // 支持数组包含匹配（conversations.members 是数组）
        if (Array.isArray(v)) return v.indexOf(want) > -1;
        return v === want;
      });
      const q = {
        limit() { return q; },
        get() { return Promise.resolve({ data: Object.values(col(name)).filter(match) }); }
      };
      return q;
    },
    limit() { return { get: () => Promise.resolve({ data: Object.values(col(name)) }) }; },
    skip() { return this; },
    get() { return Promise.resolve({ data: Object.values(col(name)) }); }
  };
}

const fake = {
  DYNAMIC_CURRENT_ENV: 'mock',
  init() {},
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

(async () => {
  const app = require(FN + '/index.js');

  console.log('=== 1. 初始化数据 ===');
  for (let i = 0; i < 40; i++) {
    const r = await app.main({ path: '/api/_setup', method: 'POST', data: {} });
    if (r.data && r.data.done) break;
  }
  console.log('  users=' + Object.keys(store.users || {}).length + '  messages=' + Object.keys(store.messages || {}).length);

  console.log('\n=== 2. 登录 ===');
  const login = await app.main({ path: '/api/login', method: 'POST', data: { testUserId: 2 } });
  if (login.code !== 0) { no('登录失败: ' + login.message); process.exit(1); }
  const token = login.data.token;
  const me = login.data.user;
  ok('登录成功: ' + me.nickname + ' (id=' + me.id + ')');

  console.log('\n=== 3. 打开与 AI 客服的会话 ===');
  const open = await app.main({
    path: '/api/conversations/open', method: 'POST', data: {}, token
  });
  if (open.code !== 0) { no('打开会话失败: ' + open.message); process.exit(1); }
  const conv = open.data.conversation;
  const aiId = conv.peer && conv.peer.id;
  ok('会话 id=' + conv.id + '  对方=' + conv.peer.nickname + '  isAI=' + conv.peer.isAI);

  if (!conv.peer.isAI) no('对方不是 AI，测试前提不成立');
  else ok('对方确实是 AI 客服');

  const before = Object.keys(store.messages || {}).length;

  console.log('\n=== 4. 发送消息（复现用户场景） ===');
  const send = await app.main({
    path: '/api/conversations/' + conv.id + '/messages',
    method: 'POST',
    data: { content: '怎么发布商品呀？', type: 'text' },
    token
  });
  if (send.code !== 0) {
    no('发送失败: ' + send.code + ' ' + send.message);
    no('→ 这正是用户看到的「发送失败」');
  } else {
    ok('消息发送成功: "' + send.data.message.content + '"');
  }

  const after = Object.keys(store.messages || {}).length;
  const added = after - before;
  console.log('  消息数 ' + before + ' → ' + after + '（新增 ' + added + '）');

  if (added >= 2) ok('新增 ≥2 条（用户消息 + AI 回复）');
  else if (added === 1) no('只新增了用户消息，AI 没有回复');
  else no('一条也没写入');

  console.log('\n=== 5. 检查 AI 回复内容 ===');
  const msgs = Object.values(store.messages || {})
    .filter((m) => m.convId === conv.id)
    .sort((a, b) => a.id - b.id);
  const aiMsgs = msgs.filter((m) => m.senderId === aiId);
  const lastAi = aiMsgs[aiMsgs.length - 1];

  if (lastAi && lastAi.content) {
    ok('AI 已回复: "' + lastAi.content.slice(0, 60).replace(/\n/g, ' ') + '"');
  } else {
    no('没有找到 AI 的回复消息');
  }

  console.log('\n=== 6. AI 回复语义正确性 ===');
  if (lastAi) {
    const c = lastAi.content || '';
    if (/发布|「\+」|按钮|上传/.test(c)) ok('回复内容与「怎么发布商品」相关');
    else no('回复内容不相关: ' + c.slice(0, 60));
    if (c.indexOf('[object Object]') === -1) ok('回复中没有 [object Object]');
    else no('回复出现 [object Object]');
  }

  console.log('\n=== 7. 多种问法都应得到回复 ===');
  {
    const asks = ['怎么拼团', '支付方式有哪些', '帮我找自行车', '我要退款'];
    for (const q of asks) {
      const b = Object.keys(store.messages).length;
      await app.main({
        path: '/api/conversations/' + conv.id + '/messages',
        method: 'POST', data: { content: q, type: 'text' }, token
      });
      const a = Object.keys(store.messages).length;
      if (a - b >= 2) console.log('  ✓ 「' + q + '」→ 有回复');
      else { console.log('  ❌ 「' + q + '」→ 无回复'); bad++; }
    }
  }

  console.log('\n=== 8. 前端传参防御（模拟事件对象被误传） ===');
  {
    // 修复前：bindtap="send" 会把事件对象传进 send()，String(事件对象) = "[object Object]"
    // 修复后前端已有类型防御，这里验证「若真的收到非字符串，服务端不会崩」
    const b = Object.keys(store.messages).length;
    const r = await app.main({
      path: '/api/conversations/' + conv.id + '/messages',
      method: 'POST', data: { content: '[object Object]', type: 'text' }, token
    });
    const a = Object.keys(store.messages).length;
    if (r.code === 0 && a - b >= 2) ok('即使内容是 [object Object]，AI 也会兜底回复（不再无响应）');
    else no('异常内容导致无回复');
  }

  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ AI 客服对话链路正常'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
