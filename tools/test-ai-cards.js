/**
 * AI 商品卡片（商品链接）专项测试。
 *
 * 用户反馈：问「帮我找自行车」，AI 只回了一段文字描述，
 * 没有可点击的商品卡片。而**规则引擎**是会给卡片的。
 *
 * 根因：generateReply 里
 *     const llm = await llmReply(user, text);
 *     if (llm && llm.text) return llm;     // ← 大模型只回文字，cards 丢了
 *     return rulesReply(user, text);        // ← 只有规则引擎带 cards
 * 配了 AI Key 之后走大模型，于是卡片消失。
 *
 * 验证修复后：
 *   1) 大模型路径下「找东西」也要带 cards
 *   2) cards 结构正确（含 listingId，前端据此跳详情）
 *   3) 非找东西的提问不要硬塞卡片
 *   4) 规则引擎路径行为不变
 *   5) 后端会把「文字 + 卡片」两条消息都返回（aiMessages）
 *
 * 用法：node tools/test-ai-cards.js
 */
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
        get() { const d = col(name)[String(id)]; return d ? Promise.resolve({ data: d }) : Promise.reject(new Error('x')); },
        remove() { delete col(name)[String(id)]; return Promise.resolve({}); }
      };
    },
    where(cond) {
      const m = (d) => Object.keys(cond || {}).every((k) => Array.isArray(d[k]) ? d[k].indexOf(cond[k]) > -1 : d[k] === cond[k]);
      const q = { limit() { return q; }, get() { return Promise.resolve({ data: Object.values(col(name)).filter(m) }); } };
      return q;
    },
    limit() { return { get: () => Promise.resolve({ data: Object.values(col(name)) }) }; },
    skip() { return this; },
    get() { return Promise.resolve({ data: Object.values(col(name)) }); }
  };
}
const fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'mock', init() { }, getWXContext: () => ({}),
  database: () => ({ collection: makeCollection, createCollection(n) { col(n); return Promise.resolve({}); } })
};

/* ---------- mock https：假的大模型 ---------- */
const llm = { text: '这里有一辆山地自行车，650 元，成色不错哦。', calls: 0 };
const httpsMock = {
  request(opts, cb) {
    llm.calls++;
    const body = Buffer.from(JSON.stringify({ choices: [{ message: { content: llm.text } }] }), 'utf8');
    const req = {
      on() { return req; }, write() { return true; },
      end() {
        setTimeout(() => {
          const res = { statusCode: 200, on(ev, fn) { if (ev === 'data') fn(body); if (ev === 'end') setTimeout(fn, 0); return res; } };
          cb(res);
        }, 0);
        return req;
      },
      setTimeout() { }, destroy() { }
    };
    return req;
  }
};

const origLoad = Module._load;
Module._load = function (r) {
  if (r === 'wx-server-sdk') return fakeSdk;
  if (r === 'https' || r === 'http') return httpsMock;
  return origLoad.apply(this, arguments);
};

(async () => {
  const app = require(FN + '/index.js');
  const db = require(FN + '/db.js');
  const ai = require(FN + '/ai.js');
  const call = (p, m, d, t) => app.main({ path: p, method: m, data: d || {}, token: t || '' });

  for (let i = 0; i < 40; i++) { const r = await call('/api/_setup', 'POST', {}); if (r.data && r.data.done) break; }
  const login = await call('/api/login', 'POST', { testUserId: 2 });
  const token = login.data.token;
  const me = login.data.user;

  console.log('=== 0. 前置：数据里有没有「自行车」可搜 ===');
  const bikes = db.find('listings', (l) => l.status === 'on' && /自行|单车|车/.test(String(l.title)));
  console.log('      在售中标题含「车」的：' + bikes.length + ' 件');
  bikes.slice(0, 3).forEach((l) => console.log('        #' + l.id + ' ' + l.title + '  ' + (l.price / 100).toFixed(2) + '元'));

  console.log('\n=== 1. 【核心】大模型路径下「找东西」必须带商品卡片 ===');
  {
    // 配上假的大模型
    db.load().meta.config.ai = { baseUrl: 'https://fake.example.com/v1', model: 'test', apiKey: 'k' };
    await db.flush();
    llm.calls = 0;
    llm.text = '当然可以！我们这里有一辆山地自行车，650 元，刚保养好。';

    const reply = await ai.generateReply(me, '帮我找自行车');
    console.log('      走了大模型: ' + (llm.calls > 0 ? '是' : '否'));
    console.log('      文字: ' + String(reply.text).slice(0, 40) + '…');
    console.log('      cards: ' + (reply.cards ? reply.cards.length + ' 个' : '无'));

    if (llm.calls > 0) ok('确实走的是大模型路径');
    else no('没走大模型，测试前提不成立');
    if (reply.cards && reply.cards.length) ok('大模型回复也带上了商品卡片（' + reply.cards.length + ' 个）');
    else no('大模型回复没有卡片 → 用户看不到商品链接');

    const c = (reply.cards || [])[0] || {};
    console.log('      卡片字段: ' + Object.keys(c).join(', '));
    if (c.listingId) ok('卡片带 listingId（前端据此跳商品详情）');
    else no('卡片缺 listingId，点不进去');
    if (c.title) ok('卡片有标题：' + String(c.title).slice(0, 24));
    else no('卡片缺标题');
  }

  console.log('\n=== 2. 非「找东西」的提问不应硬塞卡片 ===');
  {
    llm.calls = 0;
    llm.text = '发布闲置：点底部「+」选分区，上传图片填价格即可。';
    const reply = await ai.generateReply(me, '怎么发布闲置');
    console.log('      cards: ' + (reply.cards && reply.cards.length ? reply.cards.length + ' 个' : '无'));
    if (!reply.cards || !reply.cards.length) ok('普通问答不会硬塞商品卡片');
    else no('普通问答被塞了 ' + reply.cards.length + ' 个卡片，可能干扰用户');
  }

  console.log('\n=== 3. 搜不到时不应返回空卡片 ===');
  {
    llm.calls = 0;
    llm.text = '暂时没有找到相关商品哦。';
    const reply = await ai.generateReply(me, '找宇宙飞船发动机');
    console.log('      cards: ' + (reply.cards && reply.cards.length ? reply.cards.length + ' 个' : '无'));
    if (!reply.cards || !reply.cards.length) ok('搜不到时不给卡片（前端也不会渲染空卡片区）');
    else no('搜不到却给了 ' + reply.cards.length + ' 个卡片');
  }

  console.log('\n=== 4. 规则引擎路径行为不变（大模型不可用时）===');
  {
    const saved = db.load().meta.config.ai;
    db.load().meta.config.ai = null;         // 关掉大模型 → 回落规则引擎
    await db.flush();
    const reply = await ai.generateReply(me, '帮我找自行车');
    console.log('      文字: ' + String(reply.text).slice(0, 40) + '…');
    console.log('      cards: ' + (reply.cards ? reply.cards.length + ' 个' : '无'));
    if (reply.cards && reply.cards.length) ok('规则引擎仍然返回卡片（原有行为未被破坏）');
    else no('规则引擎的卡片丢了！');
    db.load().meta.config.ai = saved;
    await db.flush();
  }

  console.log('\n=== 5. 【核心】主通道要回传「文字 + 卡片」两条消息 ===');
  {
    db.load().meta.config.ai = { baseUrl: 'https://fake.example.com/v1', model: 'test', apiKey: 'k' };
    await db.flush();
    llm.text = '当然可以！我们这里有一辆山地自行车，650 元。';

    const open = await call('/api/conversations/open', 'POST', {}, token);
    const conv = open.data.conversation;
    const beforeAi = db.find('messages', (m) => m.convId === conv.id && m.senderId === conv.peer.id).length;

    const r = await call('/api/conversations/' + conv.id + '/messages', 'POST', { content: '帮我找自行车', type: 'text' }, token);
    const d = r.data || {};
    const list = d.aiMessages || (d.aiMessage ? [d.aiMessage] : []);
    console.log('      aiMessage(旧字段): ' + (d.aiMessage ? ('#' + d.aiMessage.id) : 'null'));
    console.log('      aiMessages(新字段): ' + list.length + ' 条');
    list.forEach((m) => console.log('        #' + m.id + ' type=' + m.type + ' 内容=' + String(m.content || '(卡片)').slice(0, 26)));

    const afterAi = db.find('messages', (m) => m.convId === conv.id && m.senderId === conv.peer.id).length;
    const produced = afterAi - beforeAi;
    console.log('      本次实际产生 AI 消息 ' + produced + ' 条');
    if (list.length === produced) ok('回传条数与实际产生一致（' + produced + ' 条），不漏消息');
    else no('实际产生 ' + produced + ' 条，只回传 ' + list.length + ' 条 → 会有消息要等轮询');
    if (list.length >= 2) ok('文字 + 商品卡片两条都回传了（前端可一次渲染到位）');
    else console.log('  – 本次只有 ' + list.length + ' 条（未触发卡片）');

    // 顺序必须是「文字在前、卡片在后」
    const types = list.map((m) => m.type).join(',');
    if (list.length >= 2) {
      if (list[0].type === 'text' && list[list.length - 1].type === 'listings') ok('顺序正确：文字 → 卡片（' + types + '）');
      else no('顺序异常：' + types);
    }
  }

  Module._load = origLoad;
  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ AI 商品卡片链路正确：大模型回复也带卡片，且两条消息都回传'));
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  Module._load = origLoad;
  console.error('测试崩溃:', e);
  process.exit(1);
});
