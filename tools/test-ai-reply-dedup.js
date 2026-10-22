/**
 * AI 回复「一条消息被回几次」的专项测试。
 *
 * 用户反馈截图里出现 3 条 AI 回复、称呼各不相同（秀同学 / 王鸿秀同学 / 尧明秀同学），
 * 而对应的用户提问却不完整。怀疑同一句提问被多次送进大模型。
 *
 * 本脚本打断点式地统计：
 *   1) 一条用户消息 → LLM 被调用几次
 *   2) 落库的 AI 消息有几条（有无重复回复）
 *   3) 前端兜底通道 /ai-reply 再打一次，会不会又生成一条
 *   4) 幂等保护在「主通道已回复」时是否真的生效
 *   5) 称呼是否稳定正确（prompt 里的昵称有没有被读错）
 *
 * 用法：node tools/test-ai-reply-dedup.js
 */
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/* ---------- mock 云数据库（集合→文档） ---------- */
const store = {};
function col(n) { if (!store[n]) store[n] = {}; return store[n]; }
function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) { col(name)[String(id)] = Object.assign({ _id: String(id) }, data); return Promise.resolve({}); },
        get() {
          const d = col(name)[String(id)];
          return d ? Promise.resolve({ data: d }) : Promise.reject(new Error('document does not exist'));
        },
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

/* ---------- mock https：统计 LLM 调用次数 ---------- */
const llm = { calls: [], reply: '', echoPrompt: false };
const httpsMock = {
  request(opts, cb) {
    llm.calls.push({ at: Date.now(), model: opts && opts.path });
    let text = llm.reply || ('AI回复#' + llm.calls.length);
    if (llm.echoPrompt && llm.lastSystem) text = llm.lastSystem;
    const body = Buffer.from(JSON.stringify({ choices: [{ message: { content: text } }] }), 'utf8');
    const req = {
      on() { return req; },
      write(chunk) {
        // 记下请求体里的 system prompt，供「昵称是否正确」断言使用
        try {
          const j = JSON.parse(String(chunk));
          const sys = (j.messages || []).find((m) => m.role === 'system');
          if (sys) llm.lastSystem = sys.content;
        } catch (e) { }
        return true;
      },
      end() {
        setTimeout(() => {
          const res = {
            statusCode: 200,
            on(ev, fn) {
              if (ev === 'data') fn(body);
              if (ev === 'end') setTimeout(fn, 0);
              return res;
            }
          };
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

const post = (app, path, body, token) => app.main({ path, method: 'POST', data: body || {}, token: token || '' });

(async () => {
  const app = require(FN + '/index.js');
  const db = require(FN + '/db.js');

  /* 初始化演示数据 */
  for (let i = 0; i < 40; i++) {
    const r = await post(app, '/api/_setup', {});
    if (r.data && r.data.done) break;
  }
  const login = await post(app, '/api/login', { testUserId: 2 });
  const token = login.data.token;
  const me = login.data.user;

  /* 配上假的 LLM，让 llmReply 走通 */
  db.load().meta.config.ai = { baseUrl: 'https://fake.example.com/v1', model: 'test-model', apiKey: 'fake-key' };
  await db.flush();

  console.log('=== 0. 前置状态 ===');
  console.log('      当前用户：' + me.nickname + '（id=' + me.id + '）');
  const open = await post(app, '/api/conversations/open', {}, token);
  const conv = open.data.conversation;
  console.log('      AI 会话：conv=' + conv.id + '  peer=' + (conv.peer && conv.peer.nickname) + '  isAI=' + (conv.peer && conv.peer.isAI));

  const aiMsgs = () => db.find('messages', (m) => m.convId === conv.id && m.senderId === conv.peer.id);
  const myMsgs = () => db.find('messages', (m) => m.convId === conv.id && m.senderId === me.id);

  console.log('\n=== 1. 一条消息 → LLM 调用次数与 AI 落库条数 ===');
  {
    llm.calls.length = 0;
    const beforeAi = aiMsgs().length;
    const beforeMe = myMsgs().length;

    const r = await post(app, '/api/conversations/' + conv.id + '/messages', { content: '我是王鸿秀', type: 'text' }, token);

    const d = r.data || {};
    console.log('      响应 code=' + r.code + '  message.id=' + (d.message && d.message.id) + '  aiMessage=' + (d.aiMessage ? '#' + d.aiMessage.id : 'null'));
    console.log('      LLM 被调用 ' + llm.calls.length + ' 次，AI 落库新增 ' + (aiMsgs().length - beforeAi) + ' 条，用户消息新增 ' + (myMsgs().length - beforeMe) + ' 条');

    if (llm.calls.length === 1) ok('一次提问只调用 LLM 1 次');
    else no('一次提问调用了 LLM ' + llm.calls.length + ' 次！会产生多条不同回复');
    if (aiMsgs().length - beforeAi === 1) ok('只落库 1 条 AI 回复');
    else no('落库了 ' + (aiMsgs().length - beforeAi) + ' 条 AI 回复（用户看到的就是"AI 回了好几次"）');
    if (d.aiMessage) ok('主通道直接带回了 aiMessage（前端无需再触发）');
    else no('主通道没带回 aiMessage —— 前端会走兜底通道，可能重复');
  }

  console.log('\n=== 2. 送给大模型的 system prompt 是否含正确昵称 ===');
  {
    // 让假 LLM 把收到的 system prompt 原样回显，就能验证 prompt 内容
    llm.reply = '';
    llm.echoPrompt = true;
    const beforeAi = aiMsgs().length;
    await post(app, '/api/conversations/' + conv.id + '/messages', { content: '我是王鸿秀', type: 'text' }, token);
    const newAi = aiMsgs().filter((m) => m.id > (aiMsgs().sort((a, b) => a.id - b.id)[0] || {}).id);
    const last = aiMsgs().sort((a, b) => b.id - a.id)[0];
    const text = last ? String(last.content) : '';
    console.log('      prompt 里【当前用户】片段：' + (text.match(/【当前用户】[^\n]{0,60}/) || ['(未回显)'])[0]);
    if (text.indexOf('昵称：' + me.nickname) > -1) ok('prompt 用的是当前登录用户的昵称「' + me.nickname + '」');
    else no('prompt 里没有正确昵称（可能取错用户）');
    llm.echoPrompt = false;
  }

  console.log('\n=== 3. 已回复后再打 /ai-reply（前端兜底）不应重复 ===');
  {
    llm.calls.length = 0;
    const beforeAi = aiMsgs().length;
    const r = await post(app, '/api/conversations/' + conv.id + '/ai-reply', {}, token);
    const d = r.data || {};
    console.log('      响应：' + JSON.stringify(d).slice(0, 100));
    console.log('      LLM 被调用 ' + llm.calls.length + ' 次，AI 落库新增 ' + (aiMsgs().length - beforeAi) + ' 条');
    if (d.skipped) ok('幂等生效：识别出已回复并跳过（skipped=true）');
    else no('未跳过，返回 ' + JSON.stringify(d));
    if (aiMsgs().length - beforeAi === 0 && llm.calls.length === 0) ok('没有产生重复回复');
    else no('产生了重复回复！');
  }

  console.log('\n=== 4. 连打 4 次 /ai-reply（模拟前端重试/多次轮询兜底）===');
  {
    llm.calls.length = 0;
    const beforeAi = aiMsgs().length;
    for (let i = 0; i < 4; i++) await post(app, '/api/conversations/' + conv.id + '/ai-reply', {}, token);
    const added = aiMsgs().length - beforeAi;
    console.log('      LLM 调用 ' + llm.calls.length + ' 次，新增 AI 回复 ' + added + ' 条');
    if (added === 0) ok('连打 4 次也不重复（幂等可靠）');
    else no('连打 4 次产生了 ' + added + ' 条重复回复！');
  }

  console.log('\n=== 5. 连发 3 条提问，每条应各有且仅有一条回复 ===');
  {
    llm.calls.length = 0;
    const beforeAi = aiMsgs().length;
    const beforeMe = myMsgs().length;
    // 模拟用户连发（前端每次发送都会调一次 POST /messages）
    llm.reply = '';
    await post(app, '/api/conversations/' + conv.id + '/messages', { content: '问题一', type: 'text' }, token);
    await post(app, '/api/conversations/' + conv.id + '/messages', { content: '问题二', type: 'text' }, token);
    await post(app, '/api/conversations/' + conv.id + '/messages', { content: '问题三', type: 'text' }, token);
    const aiAdd = aiMsgs().length - beforeAi;
    const meAdd = myMsgs().length - beforeMe;
    console.log('      用户消息 +' + meAdd + '，AI 回复 +' + aiAdd + '，LLM 调用 ' + llm.calls.length + ' 次');
    if (meAdd === 3 && aiAdd === 3 && llm.calls.length === 3) ok('三条提问 → 三条回复，一一对应，无多无少');
    else no('对应关系不对（用户 +' + meAdd + '，AI +' + aiAdd + '，LLM ' + llm.calls.length + '）');
  }

  console.log('\n=== 6. AI 消息的排序（前端按 id 排序，必须单调递增）===');
  {
    const list = aiMsgs().slice().sort((a, b) => a.id - b.id);
    let mono = true;
    for (let i = 1; i < list.length; i++) if (list[i].id <= list[i - 1].id) mono = false;
    if (mono) ok('AI 消息 id 单调递增，按 id 排序能还原正确顺序（' + list.length + ' 条）');
    else no('id 有重复/乱序，前端排序会错乱');
    const all = db.find('messages', (m) => m.convId === conv.id).slice().sort((a, b) => a.id - b.id);
    let sent = true;
    for (const m of all) if (m.senderId !== me.id && m.senderId !== conv.peer.id) sent = false;
    if (sent) ok('会话里只有我与 AI 双方消息（共 ' + all.length + ' 条），不存在第三方串入');
    else no('会话里出现了非双方的消息');
  }

  Module._load = origLoad;
  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 后端回复链路正确：一问一答、幂等去重、称呼取自当前用户'));
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  Module._load = origLoad;
  console.error('测试崩溃:', e);
  process.exit(1);
});
