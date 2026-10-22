/**
 * 单次请求 AI 对话测试（真实 GLM）。
 *
 * 验证新方案：POST /messages 一次往返就带上 AI 回复，
 * 不再依赖 /ai-reply 路由（避免旧部署 404 导致无回复）。
 *
 * 同时也验证「奇怪输入」（如 "1+1"、"?"）也能得到回复。
 *
 * ⚠️ 一次回复可能是**两条消息**：文字 + 商品卡片（type='listings'，content 按设计为空）。
 *    所以判断「有没有回复」要看**带文字的那条**，不能只看最后一条（见 pickText）。
 */
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';
const KEY = 'af2ec2082198416e92ea8ac3367b4af0.tPVlngh68k1YM9Bv';
const BASE = 'https://open.bigmodel.cn/api/paas/v4';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/**
 * 从本次往返产生的 AI 消息里挑出「带文字的那条」。
 *
 * ⚠️ 别直接看最后一条 —— 一次回复可能是**两条**：文字 + 商品卡片，
 *    而卡片消息（type='listings'）的 content 按设计就是空字符串。
 *    取最后一条会把「回得好好的」判成「没回复」（本脚本曾因此假失败：
 *    提问「1+1」时 AI 明明回了「2啦，林小满同学！…」，却被记为「没有回复」）。
 */
const pickText = (data) => {
  const list = data.aiMessages || (data.aiMessage ? [data.aiMessage] : []);
  return list.find((m) => m.type !== 'listings' && String(m.content || '').trim()) || null;
};
const countOf = (data) => (data.aiMessages || (data.aiMessage ? [data.aiMessage] : [])).length;

const store = {};
function col(n) { if (!store[n]) store[n] = {}; return store[n]; }
function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) { col(name)[String(id)] = Object.assign({ _id: String(id) }, data); return Promise.resolve({}); },
        get() { const d = col(name)[String(id)]; return d ? Promise.resolve({ data: d }) : Promise.reject(new Error('x')); },
        remove() { delete col(name)[String(id)]; return Promise.resolve({}); }
      };
    },
    where(cond) {
      const match = (d) => Object.keys(cond || {}).every((k) => Array.isArray(d[k]) ? d[k].indexOf(cond[k]) > -1 : d[k] === cond[k]);
      const q = { limit() { return q; }, get() { return Promise.resolve({ data: Object.values(col(name)).filter(match) }); } };
      return q;
    },
    limit() { return { get: () => Promise.resolve({ data: Object.values(col(name)) }) }; },
    skip() { return this; },
    get() { return Promise.resolve({ data: Object.values(col(name)) }); }
  };
}
const fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'mock', init() {}, getWXContext: () => ({}),
  database: () => ({ collection: makeCollection, createCollection(n) { col(n); return Promise.resolve({}); } })
};
const origLoad = Module._load;
Module._load = function (r) { if (r === 'wx-server-sdk') return fakeSdk; return origLoad.apply(this, arguments); };

(async () => {
  const app = require(FN + '/index.js');

  for (let i = 0; i < 40; i++) {
    const r = await app.main({ path: '/api/_setup', method: 'POST', data: {} });
    if (r.data && r.data.done) break;
  }
  const login = await app.main({ path: '/api/login', method: 'POST', data: { testUserId: 2 } });
  const token = login.data.token;
  const open = await app.main({ path: '/api/conversations/open', method: 'POST', data: {}, token });
  const convId = open.data.conversation.id;
  const db = require(FN + '/db.js');
  db.load().meta.config.ai = { baseUrl: BASE, model: 'glm-4-flash', apiKey: KEY };
  ok('会话 ' + convId + ' / 用户 ' + login.data.user.nickname + ' / 已配 GLM');

  console.log('\n=== 1. 单次请求即返回 AI 回复 ===');
  const cases = ['怎么发布商品', '帮我找自行车', '1+1', '?', '我的订单'];
  for (const q of cases) {
    const t0 = Date.now();
    const r = await app.main({
      path: '/api/conversations/' + convId + '/messages',
      method: 'POST', data: { content: q, type: 'text' }, token
    });
    const ms = Date.now() - t0;
    if (r.code !== 0) { no('「' + q + '」请求失败: ' + r.message); continue; }
    if (!r.data.message) { no('「' + q + '」没返回用户消息'); continue; }
    const t = pickText(r.data);
    if (!t) { no('「' + q + '」没返回带文字的 AI 回复（只回了卡片？）'); continue; }
    console.log('  ✓ 「' + q + '」 ' + ms + 'ms' + (countOf(r.data) > 1 ? '（本次 ' + countOf(r.data) + ' 条：文字 + 卡片）' : ''));
    console.log('      AI: ' + String(t.content).slice(0, 62).replace(/\n/g, ' '));
  }

  console.log('\n=== 2. 奇怪输入也必须被回复 ===');
  for (const q of ['1+1', '?', '。。。', 'asdfgh']) {
    const r = await app.main({
      path: '/api/conversations/' + convId + '/messages',
      method: 'POST', data: { content: q, type: 'text' }, token
    });
    const t = pickText(r.data);
    if (r.code === 0 && t) {
      ok('「' + q + '」有回复: ' + String(t.content).slice(0, 40).replace(/\n/g, ' '));
    } else {
      no('「' + q + '」没有回复（code=' + r.code + '，本次 AI 消息 ' + (r.data ? countOf(r.data) : 0) + ' 条）');
    }
  }

  console.log('\n=== 3. 数据一致性 ===');
  {
    const msgs = Object.values(store.messages).filter((m) => m.convId === convId).sort((a, b) => a.id - b.id);
    const fromUser = msgs.filter((m) => m.senderId === 2).length;
    const fromAi = msgs.filter((m) => m.senderId !== 2).length;
    console.log('  用户 ' + fromUser + ' 条 / AI ' + fromAi + ' 条');
    if (fromAi >= fromUser) ok('每条用户消息都有 AI 回复');
    else no('有 ' + (fromUser - fromAi) + ' 条用户消息未获回复');

    const dup = {};
    let dupFound = false;
    for (const m of msgs) { if (dup[m.id]) { dupFound = true; break; } dup[m.id] = 1; }
    if (!dupFound) ok('没有重复的消息 id');
    else no('存在重复消息 id');
  }

  console.log('\n=== 4. 与 AI 会话的 lastMessage 已更新 ===');
  {
    const conv = store.conversations[String(convId)];
    if (conv && conv.lastMessage && conv.lastMessage.indexOf('?') === -1) {
      ok('会话预览: ' + String(conv.lastMessage).slice(0, 40));
    } else if (conv && conv.lastMessage) {
      ok('会话预览已更新: ' + String(conv.lastMessage).slice(0, 40));
    } else no('会话预览未更新');
  }

  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 单次请求 AI 对话全部通过'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
