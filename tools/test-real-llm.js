/**
 * 真实大模型端到端测试。
 *
 * 用【真实】GLM API + 本地 mock 数据库，完整跑一遍 ai.js 的逻辑：
 *   用户提问 → 注入系统实时数据 → 调 GLM → 拿到真 AI 回答
 *
 * 这能验证：代码正确性 + key 有效性 + prompt 设计效果
 * （真实云环境只差一个数据库来源，逻辑完全相同）
 */
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';
const KEY = process.argv[2] || 'af2ec2082198416e92ea8ac3367b4af0.tPVlngh68k1YM9Bv';
const BASE = 'https://open.bigmodel.cn/api/paas/v4';
const MODEL = 'glm-4-flash';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/* ---------- mock 数据库 ---------- */
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

  console.log('=== 准备：初始化数据 ===');
  for (let i = 0; i < 40; i++) {
    const r = await app.main({ path: '/api/_setup', method: 'POST', data: {} });
    if (r.data && r.data.done) break;
  }
  console.log('  users=' + Object.keys(store.users).length + '  listings=' + Object.keys(store.listings).length);

  const login = await app.main({ path: '/api/login', method: 'POST', data: { testUserId: 2 } });
  const user = login.data.user;
  console.log('  登录: ' + user.nickname + '（信用 ' + user.credit + '）');

  // 注入真实配置
  const db = require(FN + '/db.js');
  db.load().meta.config.ai = { baseUrl: BASE, model: MODEL, apiKey: KEY };
  console.log('  已配大模型: ' + MODEL);

  const ai = require(FN + '/ai.js');

  console.log('\n=== 真实调用 GLM（5 个典型问题）===');
  const questions = [
    '怎么发布商品',
    '帮我找自行车',
    '我的订单有哪些',
    '拼团是怎么玩的',
    '你能做什么'
  ];

  for (const q of questions) {
    const t0 = Date.now();
    let reply = null;
    try {
      reply = await ai.generateReply(user, q);
    } catch (e) {
      no('「' + q + '」抛异常: ' + e.message);
      continue;
    }
    const ms = Date.now() - t0;
    console.log('');
    console.log('  ── 问：' + q + '  （' + ms + 'ms）');
    if (reply && reply.text) {
      console.log('     答：' + String(reply.text).replace(/\n/g, '\n         '));
    } else {
      no('无回复');
    }
  }

  console.log('\n=== 断言 ===');
  const r1 = await ai.generateReply(user, '怎么发布商品');
  if (r1 && /发布|\+/.test(r1.text)) ok('「怎么发布商品」回答与平台流程相关');
  else no('回答不相关: ' + (r1 && r1.text));

  const r2 = await ai.generateReply(user, '帮我找自行车');
  if (r2 && /自行车|山地车|单车/.test(r2.text)) ok('「帮我找自行车」引用了真实商品（含自行车/山地车）');
  else no('没有引用真实商品: ' + (r2 && r2.text));

  const r3 = await ai.generateReply(user, '我的订单有哪些');
  if (r3 && /订单/.test(r3.text)) ok('「我的订单」回答涉及订单');
  else no('订单回答异常');

  const allText = [r1, r2, r3].map((x) => (x && x.text) || '').join(' ');
  if (allText.indexOf('[object Object]') === -1) ok('所有回复均无 [object Object]');
  else no('出现 [object Object]');

  if (allText.indexOf('作为AI') === -1 && allText.indexOf('作为 AI') === -1) {
    ok('未出现「作为AI」这类通用机器人话术（保持了系统身份）');
  } else {
    console.log('  – 出现了通用机器人话术，可考虑收紧 prompt');
  }

  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 真实大模型链路全部通过'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
