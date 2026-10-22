/**
 * AI 大模型通道端到端测试。
 *
 * 起一个本地 HTTP 服务模拟 OpenAI 兼容接口，验证：
 *   1) postJson 能正常发请求（Node 16 无 fetch，必须用 http/https 模块）
 *   2) system prompt 注入了本系统实时数据（商品检索命中会写进去）
 *   3) generateReply 优先走大模型
 *   4) 大模型挂掉时自动回落规则引擎（演示不中断）
 */
const http = require('http');
const fs = require('fs');
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/* ---------- mock 云数据库 ---------- */
const store = {};
function col(n) { if (!store[n]) store[n] = {}; return store[n]; }
function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) { col(name)[String(id)] = Object.assign({ _id: String(id) }, data); return Promise.resolve({}); },
        get() {
          const d = col(name)[String(id)];
          if (!d) return Promise.reject(new Error('document does not exist'));
          return Promise.resolve({ data: d });
        },
        remove() { delete col(name)[String(id)]; return Promise.resolve({}); }
      };
    },
    where(cond) {
      const match = (d) => Object.keys(cond || {}).every((k) => {
        const v = d[k];
        if (Array.isArray(v)) return v.indexOf(cond[k]) > -1;
        return v === cond[k];
      });
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

/* ---------- mock LLM 服务 ---------- */
let lastReq = null;
let llmMode = 'ok';   // ok | fail
const llmServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (llmMode === 'fail') { res.writeHead(500); return res.end('{"error":"boom"}'); }
    try { lastReq = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (e) { lastReq = null; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '【大模型回复】想找自行车的话，我看到平台上有「山地车出租」，还有几款二手山地车在卖，价位 300-800 元，需要我帮你筛选吗？' } }],
      usage: { total_tokens: 100 }
    }));
  });
});

(async () => {
  await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
  const port = llmServer.address().port;
  const baseUrl = 'http://127.0.0.1:' + port + '/v1';
  console.log('mock LLM 服务: ' + baseUrl);

  const app = require(FN + '/index.js');

  console.log('\n=== 1. 初始化 + 登录 ===');
  for (let i = 0; i < 40; i++) {
    const r = await app.main({ path: '/api/_setup', method: 'POST', data: {} });
    if (r.data && r.data.done) break;
  }
  const login = await app.main({ path: '/api/login', method: 'POST', data: { testUserId: 2 } });
  const token = login.data.token;
  ok('登录: ' + login.data.user.nickname);

  const open = await app.main({ path: '/api/conversations/open', method: 'POST', data: {}, token });
  const conv = open.data.conversation;
  ok('AI 会话 id=' + conv.id);

  console.log('\n=== 2. 未配置大模型时应走规则引擎 ===');
  {
    const before = Object.keys(store.messages).length;
    await app.main({
      path: '/api/conversations/' + conv.id + '/messages', method: 'POST',
      data: { content: '怎么发布商品', type: 'text' }, token
    });
    const msgs = Object.values(store.messages).filter((m) => m.convId === conv.id).sort((a, b) => a.id - b.id);
    const last = msgs[msgs.length - 1];
    if (last && last.senderId !== 2 && String(last.content).indexOf('大模型') === -1) {
      ok('走的是内置规则引擎（未配置大模型）');
    } else {
      no('未配置时不应调用大模型');
    }
  }

  console.log('\n=== 3. 配置大模型后应优先走 LLM ===');
  const db = require(FN + '/db.js');
  db.load().meta.config.ai = { baseUrl, model: 'test-model', apiKey: 'sk-test' };
  ok('已注入配置: baseUrl=' + baseUrl + ' model=test-model');

  {
    const before = Object.keys(store.messages).length;
    const send = await app.main({
      path: '/api/conversations/' + conv.id + '/messages', method: 'POST',
      data: { content: '帮我找自行车', type: 'text' }, token
    });
    if (send.code !== 0) { no('发消息失败: ' + send.message); }
    else {
      const after = Object.keys(store.messages).length;
      ok('发消息成功，消息数 ' + before + ' → ' + after);

      const msgs = Object.values(store.messages).filter((m) => m.convId === conv.id).sort((a, b) => a.id - b.id);
      // 问的是「帮我找自行车」，AI 回复会产出「文字 + 商品卡片」**两条**消息
      //（见 events.js：reply.cards 会另发一条 type='listings'）。
      // 所以不能只看最后一条 —— 最后一条通常是卡片（content 为空）。
      const fresh = msgs.slice(-3);
      const textMsg = fresh.find((m) => m.type === 'text' && /【大模型回复】/.test(String(m.content)));
      if (textMsg) {
        ok('AI 文字回复来自大模型: "' + String(textMsg.content).slice(0, 46) + '…"');
      } else {
        const nonEmpty = fresh.filter((m) => String(m.content).trim());
        no('没有走大模型，实际回复: ' + (nonEmpty.length ? String(nonEmpty[nonEmpty.length - 1].content).slice(0, 60) : '（本次没有非空文字消息）'));
      }

      // 问「找东西」必须同时给出可点击的商品卡片
      const cardMsg = fresh.find((m) => m.type === 'listings' && Array.isArray(m.card) && m.card.length);
      if (cardMsg) ok('同时给出了商品卡片：' + cardMsg.card.length + ' 张，首张 listingId=' + cardMsg.card[0].listingId);
      else no('问「找东西」但没有商品卡片消息（大模型路径把 cards 丢了）');
    }
  }

  console.log('\n=== 4. 请求体校验（OpenAI 兼容格式）===');
  if (lastReq) {
    if (lastReq.model === 'test-model') ok('model 字段正确: ' + lastReq.model);
    else no('model 字段不对: ' + lastReq.model);

    if (Array.isArray(lastReq.messages) && lastReq.messages.length >= 2) {
      ok('messages 含 system + user 两条');
    } else no('messages 结构不对');

    const sys = (lastReq.messages || []).find((m) => m.role === 'system');
    if (sys) {
      ok('存在 system prompt（' + sys.content.length + ' 字符）');
      // 检查是否注入了本系统实时数据
      if (sys.content.indexOf('科贸小鱼') > -1) ok('prompt 含平台身份「科贸小鱼」');
      else no('prompt 缺少平台身份');

      if (sys.content.indexOf('担保交易') > -1) ok('prompt 含平台核心规则');
      else no('prompt 缺少平台规则');

      if (/用户|昵称/.test(sys.content)) ok('prompt 注入了当前用户信息');
      else no('prompt 缺少用户信息');

      if (sys.content.indexOf('在售商品') > -1) ok('prompt 注入了平台实时数据（在售商品数）');
      else no('prompt 缺少平台实时数据');

      if (sys.content.indexOf('「') > -1 && /检索到/.test(sys.content)) ok('prompt 注入了商品检索结果（按问题实时查库）');
      else console.log('  – 本次问题未命中商品，检索段未注入（正常）');
    } else no('没有 system prompt');
  } else no('大模型接口没收到请求');

  console.log('\n=== 5. 大模型故障时自动回落（演示不中断）===');
  {
    llmMode = 'fail';
    const before = Object.keys(store.messages).length;
    const send = await app.main({
      path: '/api/conversations/' + conv.id + '/messages', method: 'POST',
      data: { content: '怎么拼团', type: 'text' }, token
    });
    const after = Object.keys(store.messages).length;
    if (send.code === 0 && after - before >= 2) {
      const msgs = Object.values(store.messages).filter((m) => m.convId === conv.id).sort((a, b) => a.id - b.id);
      const last = msgs[msgs.length - 1];
      if (String(last.content).indexOf('大模型') === -1) ok('大模型 500 时自动回落规则引擎，用户仍收到回复');
      else no('回落逻辑异常');
    } else no('大模型故障导致无回复');
    llmMode = 'ok';
  }

  console.log('\n=== 6. 无配置时不应发外部请求 ===');
  {
    db.load().meta.config.ai = null;
    lastReq = null;
    await app.main({
      path: '/api/conversations/' + conv.id + '/messages', method: 'POST',
      data: { content: '你好', type: 'text' }, token
    });
    if (!lastReq) ok('未配置时不发外部请求（零成本、零延迟）');
    else no('未配置却仍发了请求');
  }

  llmServer.close();
  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 大模型通道可用，且规则引擎兜底正常'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
