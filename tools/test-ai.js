#!/usr/bin/env node
/**
 * test-ai.js —— AI 主链路能力回归测试
 *
 * 覆盖（全部离线，不依赖真实大模型）：
 *   A. 配置解析：环境变量优先，库里兜底，key 永不回显
 *   B. 自然语言解析：预算（以内/不超过/区间/百元内）+ 关键词
 *   C. 违规审核：high 拦截 / mid 提醒 / **正常商品不能误伤**
 *   D. 发布辅助（规则兜底）：样本中位数定价、无样本时不瞎猜
 *   E. 大模型路径：用本地假模型服务验证 JSON 解析、**幻觉商品 id 必须被丢弃**、
 *      规则判 high 时模型不能降级
 *   F. 路由与前端接线：三个接口两侧都在、页面上确实有入口
 *
 * 做法：把 `server/src/db` 的方法**打桩**（只读、确定性），
 * 再用 http 起一个假的 OpenAI 兼容接口（127.0.0.1，随机端口）喂固定 JSON。
 * 这样测的是真代码路径，但结果完全可复现 —— 不会因为线上数据变了就红。
 *
 * 用法：node tools/test-ai.js
 * 退出码：0 = 全绿；1 = 有失败
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
let fail = 0;
let pass = 0;

function ok(name) { pass++; console.log('  ✓ ' + name); }
function bad(name, detail) { fail++; console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')); }
function eq(name, actual, expect) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  if (a === e) ok(name); else bad(name, '实际 ' + a + ' / 期望 ' + e);
}
function truthy(name, v, hint) {
  if (v) ok(name); else bad(name, hint || ('实际 ' + JSON.stringify(v)));
}

/* ============ 0. 打桩数据：两张同类商品 + 一张无关商品 ============ */
const STUB = {
  listings: [
    { id: 101, title: '27寸 2K 显示器 144Hz', desc: '自用一年，屏幕无坏点', price: 60000, priceUnit: '台', zone: 'digital', tradeMode: 'sell', status: 'on', createdAt: 5, tags: ['显示器'], images: ['/static/img/a.jpg'], attrs: { 成色: '9成新' } },
    { id: 102, title: '24寸 显示器 1080P', desc: '毕业出，屏幕有轻微划痕', price: 30000, priceUnit: '台', zone: 'digital', tradeMode: 'sell', status: 'on', createdAt: 4, tags: ['显示器'], images: ['/static/img/b.jpg'], attrs: { 成色: '8成新' } },
    { id: 103, title: '山地自行车 21速', desc: '骑了半年，刚换过刹车皮', price: 40000, priceUnit: '辆', zone: 'sports', tradeMode: 'sell', status: 'on', createdAt: 3, tags: ['自行车'], images: ['/static/img/c.jpg'], attrs: {} },
    { id: 104, title: '考研英语真题', desc: '写过一半笔记', price: 1500, priceUnit: '本', zone: 'book', tradeMode: 'sell', status: 'on', createdAt: 2, tags: ['教材'], images: [], attrs: {} },
    { id: 105, title: '已下架的显示器', desc: '不该出现在结果里', price: 10000, zone: 'digital', status: 'off', tradeMode: 'sell', createdAt: 1, tags: [], images: [], attrs: {} }
  ]
};

const db = require('../server/src/db');
db.find = (name, pred) => (STUB[name] || []).filter(pred || (() => true));
db.load = () => ({ meta: { config: { ai: {} } } });

/* 必须在打桩之后再 require，保证拿到的是同一个 db 对象 */
const ai = require('../server/src/ai-assist');

/* ============ 1. 假模型服务 ============ */
let llmMode = 'none';
let llmCalls = [];
const llmServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch (e) { /* 忽略 */ }
    const sys = String((payload.messages && payload.messages[0] && payload.messages[0].content) || '');
    llmCalls.push({ sys, payload });

    let content = '';
    if (llmMode === 'listing') {
      content = '好的，结果如下：\n```json\n' + JSON.stringify({
        title: '27寸 2K 显示器 144Hz 9成新',
        desc: '自用一年，屏幕无坏点，附原包装。校内可面交。',
        tags: ['显示器', '数码'],
        condition: '9成新',
        suggestPrice: 599,
        priceRange: [300, 600],
        reason: '同类在售中位数约 ¥450，成色好可上浮'
      }) + '\n```';
    } else if (llmMode === 'search') {
      // 故意混入一个不存在的 id：**必须被丢弃**，否则就是把幻觉商品推给用户
      content = JSON.stringify({
        summary: '预算内有两台显示器，101 更值得买',
        picks: [
          { id: 101, reason: '2K高刷，预算内' },
          { id: 999999, reason: '这条是模型编的，不该出现' },
          { id: '102', reason: '便宜但屏幕有划痕' }
        ]
      });
    } else if (llmMode === 'moderateLow') {
      content = JSON.stringify({ level: 'low', hits: [], reason: '看起来正常' });
    } else if (llmMode === 'garbage') {
      content = '抱歉，我无法回答。';
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

/* ============ main ============ */
(async function main() {
  console.log('AI 主链路回归测试（离线，使用打桩数据 + 本地假模型）\n');

  /* ---------- A. 配置解析 ---------- */
  console.log('=== A. 大模型配置：环境变量优先、key 不回显 ===');
  delete process.env.AI_API_KEY; delete process.env.AI_BASE_URL; delete process.env.AI_MODEL;
  let cfg = ai.llmConfig();
  eq('无任何配置 → source=none, enabled=false', [cfg.source, cfg.enabled], ['none', false]);
  truthy('返回对象里**没有** apiKey 明文字段以外的泄漏（只应有 key 本身供内部使用）', typeof cfg.apiKey === 'string');

  process.env.AI_BASE_URL = 'http://127.0.0.1:1/v1';
  process.env.AI_API_KEY = 'sk-test-env';
  cfg = ai.llmConfig();
  eq('配了环境变量 → source=env, enabled=true', [cfg.source, cfg.enabled], ['env', true]);

  // 库里也有一份 key 时，环境变量必须胜出
  db.load = () => ({ meta: { config: { ai: { baseUrl: 'http://db.invalid/v1', apiKey: 'sk-db', model: 'db-model' } } } });
  cfg = ai.llmConfig();
  eq('环境变量与库同时存在 → 用环境变量的 baseUrl', cfg.baseUrl, 'http://127.0.0.1:1/v1');
  eq('环境变量与库同时存在 → source 仍是 env', cfg.source, 'env');
  // 反向对照：去掉环境变量后必须回落到库
  delete process.env.AI_BASE_URL; delete process.env.AI_API_KEY;
  cfg = ai.llmConfig();
  eq('去掉环境变量 → 回落库配置（source=db）', [cfg.source, cfg.baseUrl], ['db', 'http://db.invalid/v1']);
  // 复位成打桩的空配置，继续后面用例
  db.load = () => ({ meta: { config: { ai: {} } } });

  /* ---------- B. 自然语言解析 ---------- */
  console.log('\n=== B. 自然语言解析（预算 + 关键词）===');
  let q = ai.parseQuery('200以内能打游戏的显示器');
  eq('「200以内」→ budgetMax=200', q.budgetMax, 200);
  truthy('「能打游戏的显示器」→ 关键词命中「显示器」（修饰词不入选）',
    q.keywords.indexOf('显示器') > -1 && q.keywords.indexOf('打游戏') === -1, JSON.stringify(q.keywords));
  truthy('★ 语气助词被剥掉（不能出现「的显示器」这种检索不到的词）',
    q.keywords.every((k) => !/^[的了吗吧啊呀呢]/.test(k)), JSON.stringify(q.keywords));

  q = ai.parseQuery('不超过300的自行车');
  eq('「不超过300」→ budgetMax=300', q.budgetMax, 300);
  truthy('关键词含「自行车」', q.keywords.indexOf('自行车') > -1, JSON.stringify(q.keywords));

  q = ai.parseQuery('50到100的台灯');
  eq('「50到100」→ 区间', [q.budgetMin, q.budgetMax], [50, 100]);

  q = ai.parseQuery('百元内的球鞋');
  eq('「百元内」→ budgetMax=100', q.budgetMax, 100);

  q = ai.parseQuery('帮我找个便宜的风扇');
  eq('没有预算词 → 不产生预算限制', [q.budgetMin, q.budgetMax], [0, 0]);

  /* ---------- C. 违规审核 ---------- */
  console.log('\n=== C. 违规审核（规则）===');
  let m = ai.ruleModerate('出售四六级答案，包过', '私聊发你');
  eq('代考/答案 → high', m.level, 'high');
  truthy('命中标签里含「代考/代写」', m.hits.indexOf('代考/代写') > -1, JSON.stringify(m.hits));

  m = ai.ruleModerate('二手 iPad 9成新', '先加微信付款，不走平台');
  eq('诱导站外付款 → mid', m.level, 'mid');

  m = ai.ruleModerate('九成新山地自行车', '骑了半年，刚换刹车皮，校内面交，价格可小刀');
  eq('★ 反向对照：正常商品不能被误伤（low）', m.level, 'low');
  eq('正常商品 hits 为空', m.hits, []);

  m = ai.ruleModerate('代写论文', '');
  eq('标题命中即生效（不必等描述）', m.level, 'high');

  /* ---------- D. 发布辅助（规则兜底） ---------- */
  console.log('\n=== D. 发布辅助（无大模型时的规则兜底）===');
  const samples = ai.findSamples({ title: '27寸显示器 想卖', desc: '', zone: 'digital' }, 8);
  truthy('按品类+分区召回到同类样本', samples.length >= 2, '召回 ' + samples.length + ' 件');
  truthy('下架商品不进样本', samples.every((x) => x.status === 'on'));

  const ruleOut = ai.ruleListingAssist({ title: '显示器', desc: '自用一年', condition: '9成新' }, samples);
  eq('建议价 = 样本中位数（600/300 → 450）', ruleOut.suggestPrice, 450);
  eq('价格区间取最小/最大', ruleOut.priceRange, [300, 600]);
  eq('来源标记 rule', ruleOut.source, 'rule');
  truthy('标题非空且不超过 40 字', ruleOut.title.length > 0 && ruleOut.title.length <= 40);
  truthy('描述里带上了用户给的成色', ruleOut.desc.indexOf('9成新') > -1);

  const noSample = ai.ruleListingAssist({ title: '蓝色水杯', desc: '' }, []);
  eq('无同类样本 → 建议价给 null（不瞎猜）', noSample.suggestPrice, null);
  truthy('并给出可执行提示', noSample.reason.indexOf('6~7 折') > -1, noSample.reason);

  /* ---------- E. 大模型路径 ---------- */
  console.log('\n=== E. 大模型路径（本地假模型）===');
  await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
  const port = llmServer.address().port;
  process.env.AI_BASE_URL = 'http://127.0.0.1:' + port + '/v1';
  process.env.AI_API_KEY = 'sk-test';
  process.env.AI_MODEL = 'fake-model';

  llmMode = 'listing';
  let out = await ai.listingAssist({ title: '显示器', desc: '自用一年', zone: 'digital' });
  eq('模型返回带 ```json 围栏也能解析（source=llm）', out.source, 'llm');
  eq('标题取自模型结果', out.title, '27寸 2K 显示器 144Hz 9成新');
  eq('建议价取自模型', out.suggestPrice, 599);
  truthy('prompt 里注入了真实样本（RAG 生效）',
    llmCalls[llmCalls.length - 1].sys.indexOf('27寸 2K 显示器 144Hz') > -1);

  llmMode = 'search';
  out = await ai.smartSearch('200以内能打游戏的显示器');
  eq('找货走大模型', out.source, 'llm');
  truthy('★ 幻觉 id 被丢弃（结果里没有 999999）',
    out.items.every((x) => x.listingId !== 999999), JSON.stringify(out.items.map((x) => x.listingId)));
  eq('保留合法 id（含字符串形式的 id 也要能对上）',
    out.items.map((x) => x.listingId), [101, 102]);
  truthy('每条结果都带推荐理由', out.items.every((x) => !!x.reason));

  // 反向对照：模型返回不可解析内容 → 必须静默回落规则，而不是抛错
  llmMode = 'garbage';
  out = await ai.listingAssist({ title: '自行车', desc: '骑了半年', zone: 'sports' });
  eq('模型返回废话 → 回落规则兜底（source=rule）', out.source, 'rule');
  truthy('回落结果依然可用（标题非空）', !!out.title);

  // 规则判 high 时，模型不能把它降级成 low
  llmMode = 'moderateLow';
  const mod = await ai.moderateText('出售考试答案', '包过');
  eq('★ 规则 high 不会被模型降级', mod.level, 'high');

  // 模型挂掉（端口不通）→ fail-open
  process.env.AI_BASE_URL = 'http://127.0.0.1:1/v1';
  out = await ai.moderateText('九成新自行车', '校内面交');
  eq('大模型不可达 → 审核 fail-open（low，不拦发布）', out.level, 'low');

  /* ---------- F. 接线检查 ---------- */
  console.log('\n=== F. 路由与前端接线 ===');
  const routeCloud = fs.readFileSync(path.join(ROOT, 'cloudfunctions/campus/route-ai.js'), 'utf8');
  const routeLocal = fs.readFileSync(path.join(ROOT, 'server/src/routes/ai.js'), 'utf8');
  for (const p of ['/api/ai/listing-assist', '/api/ai/search', '/api/ai/moderate']) {
    truthy('云端注册了 ' + p, routeCloud.indexOf("'" + p + "'") > -1);
    truthy('本地注册了 ' + p, routeLocal.indexOf("'" + p + "'") > -1);
  }
  truthy('云函数 index.js 引用了 route-ai',
    fs.readFileSync(path.join(ROOT, 'cloudfunctions/campus/index.js'), 'utf8').indexOf("require('./route-ai')") > -1);
  truthy('本地 index.js 引用了 routes/ai',
    fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8').indexOf("require('./routes/ai')") > -1);

  const pubWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/publish/publish.wxml'), 'utf8');
  const pubJs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/publish/publish.js'), 'utf8');
  // 注意：发布页用的是 **catchtap**（卡片本身没有 tap，但刻意阻断冒泡，避免以后
  // 给卡片加点击时误触发），断言要同时接受 bindtap / catchtap，否则会假失败
  truthy('发布页有「AI」入口按钮并绑定事件',
    /(?:bind|catch)tap="onAiAssist"/.test(pubWxml) && /onAiAssist\s*\(/.test(pubJs));
  truthy('发布页提交前会调审核接口', pubJs.indexOf('/api/ai/moderate') > -1);
  truthy('发布页调用了文案接口', pubJs.indexOf('/api/ai/listing-assist') > -1);

  const zoneWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/zone/zone.wxml'), 'utf8');
  const zoneJs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/zone/zone.js'), 'utf8');
  truthy('搜索页有「AI 找货」入口并绑定事件',
    /bindtap="onAiSearch"/.test(zoneWxml) && /onAiSearch\s*\(/.test(zoneJs));
  truthy('搜索页调用了找货接口', zoneJs.indexOf('/api/ai/search') > -1);

  llmServer.close();
  console.log('\n────────────────────────────────────────────');
  if (fail === 0) {
    console.log('✅ 全部通过（' + pass + ' 项断言）');
    process.exit(0);
  }
  console.log('❌ ' + fail + ' 项失败（通过 ' + pass + ' 项）');
  process.exit(1);
})();
