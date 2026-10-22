'use strict';
/**
 * AI 业务能力层（主链路）
 *
 * 与 `ai.js`（AI 客服「小校助手」）的区别：
 *   - `ai.js`   面向**对话**：用户问一句，机器答一句；
 *   - 本文件面向**业务动作**：发布、找货、审核 —— AI 直接参与交易主流程，
 *     产出的是可落库的字段（标题/描述/建议价）与可执行判定（放行/拦截）。
 *
 * 三个能力：
 *   1) listingAssist(input)  发布辅助：标题 / 描述 / 标签 / 成色 / 建议价
 *   2) smartSearch(query)    自然语言找货：解析预算与品类 → 检索 → 大模型重排
 *   3) moderateText(t, d)    违规审核：本地规则 + 大模型，任一侧命中即生效
 *
 * ---------------------------------------------------------------------------
 * 设计约束（都是踩过的坑，改之前先读）
 * ---------------------------------------------------------------------------
 * ① **一律 fail-open / fail-soft**：大模型超时、返回非 JSON、字段缺失时，
 *    必须回落到内置规则引擎给出结果，**绝不抛错**。
 *    理由：发布是核心动作，AI 挂了不能让用户发不出去；比赛现场断网也不能白屏。
 * ② **RAG 不是噱头**：建议价与找货都把「平台真实在售/成交数据」注入 prompt，
 *    模型基于真实样本作答，而不是凭空编价格 —— 这也是评审看 AI 能力融合的依据。
 * ③ **不污染入参**：所有函数只读 input，返回新对象。
 * ④ 云函数运行时 Node16 没有全局 fetch，HTTP 用 http/https 模块手写。
 * ⑤ 本文件在 cloudfunctions/campus 与 server/src 下**逐字节相同**（require 路径一致）。
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const db = require('./db');

/* ============================ 0. 基础设施 ============================ */

/**
 * 大模型配置解析。
 *
 * **环境变量优先，库里的配置兜底**：
 *   AI_BASE_URL / AI_MODEL / AI_API_KEY
 *
 * 为什么这么排：apiKey 明文存在 meta.config.ai 里，任何能读到库的人都能拿走；
 * 而云函数环境变量只有函数自身与管理员可见，且不会随接口返回给前端。
 * 保留库配置是为了「没配环境变量时仍能用后台改」，否则会把现有部署一刀切断。
 */
function llmConfig() {
  let meta = {};
  try {
    const m = db.load();
    meta = (m.meta && m.meta.config && m.meta.config.ai) || {};
  } catch (e) { meta = {}; }

  const env = process.env || {};
  const envKey = String(env.AI_API_KEY || '').trim();
  const envUrl = String(env.AI_BASE_URL || '').trim();
  const envModel = String(env.AI_MODEL || '').trim();

  const baseUrl = envUrl || String(meta.baseUrl || '').trim();
  const model = envModel || String(meta.model || '').trim();
  const apiKey = envKey || String(meta.apiKey || '').trim();

  let source = 'none';
  if (apiKey) source = envKey ? 'env' : 'db';

  return {
    baseUrl,
    model,
    apiKey,
    source,                       // env | db | none —— 只暴露来源，永不回显 key
    enabled: !!(baseUrl && apiKey)
  };
}

/** 通用 JSON POST（Node16 兼容，不依赖 fetch） */
function postJson(urlStr, payload, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('无效的 baseUrl')); }
    const lib = u.protocol === 'http:' ? http : https;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: (u.pathname || '/') + (u.search || ''),
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': body.length
      }, headers || {}),
      timeout: timeoutMs || 12000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('HTTP ' + res.statusCode + ' ' + text.slice(0, 160)));
        }
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('返回非 JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 调一次大模型，返回纯文本；未配置/失败返回 null（调用方必须能处理 null） */
async function chat(messages, opts) {
  const cfg = llmConfig();
  if (!cfg.enabled) return null;

  const o = opts || {};
  let url = cfg.baseUrl.replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';

  try {
    const data = await postJson(url, {
      model: o.model || cfg.model || 'glm-4-flash',
      messages,
      temperature: typeof o.temperature === 'number' ? o.temperature : 0.5,
      max_tokens: o.maxTokens || 700
    }, { Authorization: 'Bearer ' + cfg.apiKey }, o.timeout || 12000);

    const c = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    return c ? String(c).trim() : null;
  } catch (e) {
    return null;
  }
}

/**
 * 从模型回复里抠出 JSON。
 *
 * 必须容错：即便在 prompt 里明确要求「只输出 JSON」，仍有模型会包一层
 * ```json 围栏，或在前后加一句「好的，以下是结果」。直接 JSON.parse 会抛错，
 * 而 AI 功能抛错会连带整条业务链失败 —— 所以先剥围栏、再取第一个 { 到最后一个 }。
 */
function parseJsonLoose(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

/** 分 → 元（保留两位，避免 19.900000000002 这种） */
function toYuan(cents) {
  const n = Number(cents || 0) / 100;
  return Math.round(n * 100) / 100;
}

/** 元 → 分 */
function toFen(yuan) {
  const n = Number(yuan || 0);
  if (!isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

function clampText(s, n) {
  return String(s == null ? '' : s).trim().slice(0, n);
}

/* ============================ 1. 发布辅助 ============================ */

/** 品类词典：用于从标题/描述里抽标签，以及「没有样本时」的兜底提示 */
const CATEGORY_WORDS = [
  '自行车', '电动车', '滑板', '显示器', '键盘', '鼠标', '耳机', '音箱', '相机', '镜头',
  '手机', '平板', '笔记本', '电脑', '主机', '充电宝', '数据线', '台灯', '风扇', '吹风机',
  '教材', '教辅', '考研', '四六级', '真题', '笔记', '词典', '球鞋', '球拍', '篮球',
  '吉他', '尤克里里', '钢琴', '学士服', '正装', '行李箱', '衣架', '收纳', '锅', '水壶',
  '面膜', '化妆品', '零食', '电子烟', '军训服', '被子', '床垫', '演出票'
];

function guessCategories(text) {
  const t = String(text || '');
  return CATEGORY_WORDS.filter((w) => t.indexOf(w) > -1);
}

/**
 * 取「同类商品」样本 —— 这就是 RAG 的检索环节。
 *
 * 检索策略刻意简单（无向量库）：同分区 + 关键词命中，取最近的若干条在售商品。
 * 对校园二手这种品类密度来讲，关键词检索的召回已经够用；
 * 也正因为简单，它**不依赖任何外部服务**，断网时照样能给出建议价。
 */
function findSamples(input, limit) {
  const zone = String((input && input.zone) || '');
  const text = [input && input.title, input && input.desc].filter(Boolean).join(' ');
  const kws = guessCategories(text);
  const max = limit || 8;

  let list = [];
  try {
    list = db.find('listings', (l) => l && l.status === 'on' && Number(l.price) > 0);
  } catch (e) { list = []; }

  const scored = list.map((l) => {
    let score = 0;
    const lt = String(l.title || '');
    for (const k of kws) if (lt.indexOf(k) > -1) score += 3;
    if (zone && l.zone === zone) score += 2;
    if (input && input.tradeMode && l.tradeMode === input.tradeMode) score += 1;
    return { l, score };
  }).filter((x) => x.score > 0);

  scored.sort((a, b) => b.score - a.score || (b.l.createdAt || 0) - (a.l.createdAt || 0));
  return scored.slice(0, max).map((x) => x.l);
}

function sampleBrief(list) {
  return list.map((l, i) => (i + 1) + '. 「' + l.title + '」 ' +
    toYuan(l.price) + ' 元' + (l.priceUnit ? '/' + l.priceUnit : '') +
    '｜成色：' + ((l.attrs && (l.attrs['成色'] || l.attrs.condition)) || '未标注') +
    '｜' + clampText(l.desc, 40)).join('\n');
}

/** 无大模型时的发布辅助：模板化生成，保证永远有结果 */
function ruleListingAssist(input, samples) {
  const src = input || {};
  const title0 = clampText(src.title, 40);
  const desc0 = clampText(src.desc, 200);
  const cats = guessCategories(title0 + ' ' + desc0);
  const main = cats[0] || '';

  let title = title0;
  if (!title) {
    title = (main || '闲置好物') + (src.condition ? ' ' + src.condition : '');
  }
  // 标题过短时补一个品类词，提升可搜索性（不改用户已写的内容，只在太短时补）
  if (title.length < 6 && main && title.indexOf(main) === -1) title = title + ' ' + main;
  title = clampText(title, 40);

  const parts = [];
  if (desc0) parts.push(desc0.replace(/[。！!]+$/, ''));
  if (src.condition) parts.push('成色：' + src.condition);
  if (!desc0 && main) parts.push(main + '，自用闲置，功能正常');
  parts.push('校内可面交，价格可小刀，诚心要的可以聊～');
  const desc = clampText(parts.join('。'), 500);

  let suggestPrice = null;
  let priceRange = null;
  let reason = '';
  if (samples.length) {
    const prices = samples.map((l) => Number(l.price)).filter((n) => n > 0);
    const mid = median(prices);
    suggestPrice = toYuan(mid);
    priceRange = [toYuan(Math.min.apply(null, prices)), toYuan(Math.max.apply(null, prices))];
    reason = '平台有 ' + samples.length + ' 件同类在售，价格中位数 ¥' + suggestPrice + '。';
  } else {
    reason = '平台暂无同类在售样本，建议按原价的 6~7 折定价，更容易成交。';
  }

  return {
    title,
    desc,
    tags: cats.slice(0, 3),
    condition: clampText(src.condition, 10),
    suggestPrice,
    priceRange,
    reason,
    samples: samples.length,
    source: 'rule'
  };
}

/**
 * 发布辅助：生成标题 / 描述 / 标签 / 建议价。
 *
 * 大模型路径把「平台同类在售样本」注入 system prompt（RAG），
 * 并要求它只输出 JSON；任何环节失败都回落 ruleListingAssist。
 */
async function listingAssist(input) {
  const src = input || {};
  const samples = findSamples(src, 8);
  const fallback = ruleListingAssist(src, samples);

  const priceStats = samples.length ? (function () {
    const p = samples.map((l) => toYuan(l.price));
    return '样本价：' + p.join('/') + ' 元；中位数 ¥' + fallback.suggestPrice +
      '；区间 ¥' + fallback.priceRange[0] + '–¥' + fallback.priceRange[1];
  })() : '平台暂无同类在售样本';

  const sys = [
    '你是广东科贸职业学院「科贸小鱼」小程序的二手交易运营助手，帮同学把商品描述写好、价格定准。',
    '要求：',
    '1. 标题 ≤ 20 字，突出品类 + 关键规格 + 成色，不要夸张词（如「全网最低」「秒杀」）；',
    '2. 描述 ≤ 120 字，客观陈述品牌型号、使用时长、瑕疵、交易方式，不要编造未见过的信息；',
    '3. 标签 2~4 个，每个 ≤ 6 字，用于站内搜索；',
    '4. 建议价必须参考下面给出的真实样本价，给整数或一位小数；没有样本时给 null，不要瞎猜；',
    '5. 只输出 JSON，不要任何解释文字。',
    '',
    '输出格式：',
    '{"title":"","desc":"","tags":[""],"condition":"","suggestPrice":0,"priceRange":[0,0],"reason":""}',
    '',
    '【平台同类在售样本】（这是本系统实时检索到的真实商品，务必据此定价）',
    samples.length ? sampleBrief(samples) : '（暂无）',
    priceStats,
    '',
    '【用户提供的信息】',
    '标题：' + (clampText(src.title, 40) || '（未填）'),
    '描述：' + (clampText(src.desc, 200) || '（未填）'),
    '分区：' + (clampText(src.zone, 20) || '（未选）'),
    '交易方式：' + (clampText(src.tradeMode, 20) || 'sell'),
    '成色：' + (clampText(src.condition, 10) || '（未填）')
  ].join('\n');

  const out = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: '请为这件商品生成标题、描述、标签和建议价。' }
  ], { temperature: 0.4, maxTokens: 600 });

  const j = parseJsonLoose(out);
  if (!j) return fallback;

  // 逐字段校验：模型可能少给/给错类型，缺的字段用规则结果补
  const tags = Array.isArray(j.tags)
    ? j.tags.map((t) => clampText(t, 8)).filter(Boolean).slice(0, 4)
    : fallback.tags;

  let suggestPrice = null;
  if (typeof j.suggestPrice === 'number' && isFinite(j.suggestPrice) && j.suggestPrice > 0) {
    suggestPrice = Math.round(j.suggestPrice * 100) / 100;
  } else if (fallback.suggestPrice) {
    suggestPrice = fallback.suggestPrice;
  }

  return {
    title: clampText(j.title, 40) || fallback.title,
    desc: clampText(j.desc, 500) || fallback.desc,
    tags: tags.length ? tags : fallback.tags,
    condition: clampText(j.condition, 10) || fallback.condition,
    suggestPrice,
    priceRange: fallback.priceRange,
    reason: clampText(j.reason, 120) || fallback.reason,
    samples: samples.length,
    source: 'llm'
  };
}

/* ============================ 2. 自然语言找货 ============================ */

/**
 * 从一句话里解析预算与关键词。
 *
 * 支持：
 *   「200 以内」     → max 200
 *   「不超过 300」   → max 300
 *   「50 到 100」    → 50..100
 *   「百元内」       → max 100
 *   「便宜的显示器」 → kw 显示器（「便宜」是修饰词，不作关键词）
 */
const SEARCH_STOP = [
  '帮我', '帮忙', '我想', '我要', '想找', '想买', '有没有', '有木有', '请问', '麻烦',
  '给我', '找一个', '找一下', '搜一下', '查一下', '看一下', '谁有', '求购', '求',
  '推荐', '便宜', '便宜的', '好用的', '好用', '能', '可以', '打游戏', '打游戏的',
  '一个', '一件', '一把', '一台', '一辆', '一本', '一套', '想要', '附近', '校内'
];

function parseQuery(query) {
  let t = String(query || '').trim();
  const out = { raw: t, keywords: [], budgetMin: 0, budgetMax: 0 };

  // 「百元内」「千元内」这类先量化，避免被后面的数字规则漏掉
  t = t.replace(/百元(?:以)?[内下]/g, ' 100元以内 ').replace(/千元(?:以)?[内下]/g, ' 1000元以内 ');

  // 区间「50-100」「50 到 100」
  const range = t.match(/(\d{1,5})\s*(?:元|块)?\s*(?:-|~|到|至)\s*(\d{1,5})\s*(?:元|块)?/);
  if (range) {
    out.budgetMin = Math.min(Number(range[1]), Number(range[2]));
    out.budgetMax = Math.max(Number(range[1]), Number(range[2]));
  } else {
    const maxM = t.match(/(?:不超过|不高于|低于|少于|最多|预算)\s*(\d{1,5})\s*(?:元|块)?/) ||
      t.match(/(\d{1,5})\s*(?:元|块)?\s*(?:以内|以下|内|封顶)/);
    if (maxM) out.budgetMax = Number(maxM[1]);
    const minM = t.match(/(?:超过|高于|大于|至少)\s*(\d{1,5})\s*(?:元|块)?/) ||
      t.match(/(\d{1,5})\s*(?:元|块)?\s*(?:以上)/);
    if (minM) out.budgetMin = Number(minM[1]);
  }

  // 去掉数字/货币表达，剩下的当关键词
  let rest = t
    .replace(/\d{1,5}\s*(?:元|块)/g, ' ')
    .replace(/\d{1,5}\s*(?:以内|以下|以上|封顶|左右)/g, ' ')
    .replace(/[，。！？、,.!?；;：:"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const s of SEARCH_STOP) rest = rest.split(s).join(' ');
  rest = rest.replace(/\s+/g, ' ').trim();

  // 剥掉粘在词首/词尾的语气助词：「打游戏的显示器」去掉「打游戏」后剩下「的显示器」，
  // 带着这个「的」去检索是命中不了的（标题里写的是「显示器」）。
  // 这一步看起来琐碎，但实测就是它让关键词从 2 个噪声词变回 1 个有效词。
  const words = rest.split(' ').map((w) => w.trim())
    .map((w) => w.replace(/^[的了吗吧啊呀呢]+/, '').replace(/[的了]+$/, '').trim())
    .filter((w) => w.length >= 2 && w.length <= 12);

  // 品类词优先：散文式长句里挖出「显示器」这类真名词
  const cats = guessCategories(rest);
  const kws = [];
  for (const c of cats) if (kws.indexOf(c) === -1) kws.push(c);
  for (const w of words) if (kws.indexOf(w) === -1) kws.push(w);

  out.keywords = kws.slice(0, 4);
  return out;
}

/** 召回：关键词命中计分，预算作为过滤（预算内一条都没有时放宽并标注） */
function recall(intent, limit) {
  let all = [];
  try {
    all = db.find('listings', (l) => l && l.status === 'on');
  } catch (e) { all = []; }

  const kws = intent.keywords;
  const scored = all.map((l) => {
    const hay = (String(l.title || '') + ' ' + String(l.desc || '') + ' ' +
      (l.tags || []).join(' ')).toLowerCase();
    let score = 0;
    for (const k of kws) if (hay.indexOf(String(k).toLowerCase()) > -1) score += 3;
    if (kws.length === 0) score = 1;                     // 没关键词：按热度/时间兜底
    return { l, score };
  }).filter((x) => x.score > 0);

  const inBudget = scored.filter((x) => {
    const p = Number(x.l.price) || 0;
    if (intent.budgetMax && p > intent.budgetMax * 100) return false;
    if (intent.budgetMin && p < intent.budgetMin * 100) return false;
    return true;
  });

  // 预算卡太死会 0 条 → 退回「关键词命中但略超预算」，并让上层说明
  const used = inBudget.length ? inBudget : scored;
  const relaxed = !inBudget.length && scored.length > 0;

  used.sort((a, b) => b.score - a.score || (a.l.price - b.l.price));
  return { items: used.slice(0, limit || 12).map((x) => x.l), relaxed };
}

function cardOf(l, reason) {
  return {
    listingId: l.id,
    title: l.title,
    image: (l.images && l.images[0]) || '',
    price: l.price,
    priceUnit: l.priceUnit || '',
    tradeMode: l.tradeMode || 'sell',
    zone: l.zone || '',
    reason: clampText(reason, 40)
  };
}

function intentText(intent, relaxed) {
  const bits = [];
  if (intent.keywords.length) bits.push('关键词「' + intent.keywords.join(' / ') + '」');
  if (intent.budgetMax && intent.budgetMin) bits.push('预算 ¥' + intent.budgetMin + '–¥' + intent.budgetMax);
  else if (intent.budgetMax) bits.push('预算 ≤ ¥' + intent.budgetMax);
  else if (intent.budgetMin) bits.push('预算 ≥ ¥' + intent.budgetMin);
  if (relaxed) bits.push('预算内暂无库存，以下为相近结果');
  return bits.join('，') || '全部在售';
}

/**
 * 自然语言找货：解析 → 召回 → 大模型重排（可选）→ 结果 + 一句话解释。
 *
 * 大模型只负责「排序 + 给理由」，**不负责编造商品**：
 * 它拿到的候选集来自真实库，返回的 id 必须能在候选集里找到，否则丢弃。
 * 这样即便模型幻觉，也不会把不存在的商品摆到用户面前。
 */
async function smartSearch(query) {
  const intent = parseQuery(query);
  const rec = recall(intent, 12);
  const items = rec.items;

  const base = {
    intent: {
      raw: intent.raw,
      keywords: intent.keywords,
      budgetMin: intent.budgetMin,
      budgetMax: intent.budgetMax,
      relaxed: rec.relaxed
    },
    summary: items.length
      ? '根据' + intentText(intent, rec.relaxed) + '，为你挑了 ' + Math.min(items.length, 6) + ' 件，点开就能看详情。'
      : '没找到匹配的在售商品。换个说法试试，或者发一条求购让同学主动找你～',
    source: 'rule'
  };

  if (!items.length) return Object.assign(base, { items: [] });

  // 无大模型：按召回分数（已在 recall 里排好）取前 6，理由用可解释的规则生成
  const ruleItems = items.slice(0, 6).map((l) => {
    const reasons = [];
    for (const k of intent.keywords) {
      if (String(l.title || '').indexOf(k) > -1) { reasons.push('标题含「' + k + '」'); break; }
    }
    if (intent.budgetMax && Number(l.price) <= intent.budgetMax * 100) reasons.push('预算内');
    return cardOf(l, reasons.join('·') || '同类在售');
  });

  const fallback = Object.assign({}, base, { items: ruleItems, source: 'rule' });

  const sys = [
    '你是校园二手平台的找货助手。用户用一句自然语言描述需求，下面是从平台数据库里检索到的候选商品。',
    '你的任务：从候选里挑出最符合需求的（最多 6 个），并给每个写一句 12 字以内的推荐理由。',
    '规则：',
    '1. 只能从给定候选里选，**绝不编造**不存在的商品；',
    '2. 严格尊重预算，超预算的要在理由里注明「略超预算」；',
    '3. 只输出 JSON，不要解释文字。',
    '',
    '输出格式：{"summary":"一句话总结","picks":[{"id":候选里的 id,"reason":""}]}',
    '',
    '【用户需求】' + intent.raw,
    '【解析结果】' + intentText(intent, rec.relaxed),
    '',
    '【候选商品】',
    items.map((l, i) => (i + 1) + '. id=' + l.id + '｜' + l.title + '｜¥' + toYuan(l.price) +
      (l.priceUnit ? '/' + l.priceUnit : '') + '｜' + clampText(l.desc, 40)).join('\n')
  ].join('\n');

  const out = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: intent.raw }
  ], { temperature: 0.3, maxTokens: 600 });

  const j = parseJsonLoose(out);
  if (!j || !Array.isArray(j.picks) || !j.picks.length) return fallback;

  const byId = {};
  for (const l of items) byId[String(l.id)] = l;
  const picked = [];
  for (const p of j.picks) {
    const l = byId[String(p && p.id)];
    if (!l) continue;                                   // 幻觉 id 直接丢
    if (picked.some((x) => x.listingId === l.id)) continue;
    picked.push(cardOf(l, p.reason));
    if (picked.length >= 6) break;
  }
  if (!picked.length) return fallback;

  return {
    intent: base.intent,
    summary: clampText(j.summary, 80) || base.summary,
    items: picked,
    source: 'llm'
  };
}

/* ============================ 3. 违规内容审核 ============================ */

/**
 * 违规规则库。
 *
 * 分两级：
 *   high —— 直接拦截（违法/欺诈/高风险，平台不该承载）
 *   mid  —— 提醒但不拦（擦边/引导站外交易，人工兜底）
 *
 * 刻意**不做**「看到微信就拦」这种粗暴匹配：二手交易本来就要加微信沟通，
 * 拦了会误伤正常用户。只在「要求脱离平台付款」时才判 mid。
 */
const RULES = [
  { level: 'high', label: '代考/代写', re: /(代考|替考|代写论文|枪手|包过|考试答案|四六级答案|真题答案出售)/ },
  { level: 'high', label: '管制物品', re: /(枪支|弹药|管制刀具|弩|仿真枪|警用|电击器|甩棍)/ },
  { level: 'high', label: '违禁药品', re: /(处方药|麻醉药|安眠药|精神药品|违禁药|毒品|冰毒)/ },
  { level: 'high', label: '证件与账户', re: /(身份证|学生证|校园卡|银行卡|社保卡|营业执照).{0,6}(出售|出租|出借|代办|收)/ },
  { level: 'high', label: '金融违规', re: /(套现|刷单|跑分|洗钱|贷款代办|信用卡代还|虚拟币|USDT)/ },
  { level: 'high', label: '色情低俗', re: /(约炮|一夜情|裸聊|成人视频|色情|原味内衣)/ },
  { level: 'high', label: '烟草电子烟', re: /(电子烟|香烟|烟弹|尼古丁)/ },
  { level: 'high', label: '野生动物制品', re: /(象牙|犀角|穿山甲|保护动物)/ },
  { level: 'mid', label: '站外付款', re: /(私下转账|微信转账|支付宝转账|先付款再发货|加我微信付款|不走平台)/ },
  { level: 'mid', label: '虚假宣传', re: /(全网最低|最低价保证|百分百正品|假一赔十|秒杀全网)/ },
  { level: 'mid', label: '引流站外', re: /(加微信|加vx|加V信|私聊我买|扫码进群|QQ群)/ }
];

const LEVEL_RANK = { low: 0, mid: 1, high: 2 };

function ruleModerate(title, desc) {
  const text = String(title || '') + ' ' + String(desc || '');
  const hits = [];
  let level = 'low';
  for (const r of RULES) {
    if (r.re.test(text)) {
      hits.push(r.label);
      if (LEVEL_RANK[r.level] > LEVEL_RANK[level]) level = r.level;
    }
  }
  return { level, hits };
}

/**
 * 审核：规则 + 大模型。
 *
 * 合并策略：**取下限更严的一方**（rule high 不会被模型降级）。
 * 理由：规则是可审计的确定性判定，模型只用来补规则想不到的表达方式；
 * 反过来让模型「放宽」规则，等于给了绕过审核的口子。
 *
 * 永远 fail-open：模型超时/报错时只用规则结果，接口不抛错。
 */
async function moderateText(title, desc) {
  const rule = ruleModerate(title, desc);
  const text = [clampText(title, 60), clampText(desc, 300)].filter(Boolean).join('\n');

  const base = {
    level: rule.level,
    hits: rule.hits,
    reason: rule.level === 'high'
      ? '命中平台禁止发布的内容：' + rule.hits.join('、')
      : (rule.level === 'mid' ? '有风险表述：' + rule.hits.join('、') + '，建议修改' : ''),
    suggestion: rule.level === 'high'
      ? '请删除相关内容后再发布，违规商品会被下架并记入信用记录。'
      : (rule.level === 'mid' ? '建议去掉「' + (rule.hits[0] || '') + '」类表述，并在平台内完成交易。' : ''),
    source: 'rule'
  };

  if (!text) return base;

  const sys = [
    '你是校园二手交易平台的内容审核员，判断商品文案是否违规。',
    '关注：违法物品、代考代写、证件账户买卖、金融违规、色情低俗、站外付款诱导、虚假宣传。',
    '注意：二手商品描述里出现品牌、成色、瑕疵、价格谈判（如「可小刀」）都是**正常**的，不要误判。',
    '只输出 JSON：{"level":"high|mid|low","hits":[""],"reason":""}',
    'level 含义：high=必须拦截；mid=建议修改；low=正常。'
  ].join('\n');

  const out = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: text }
  ], { temperature: 0.1, maxTokens: 300, timeout: 8000 });

  const j = parseJsonLoose(out);
  if (!j || typeof j.level !== 'string') return base;

  const lv = ['high', 'mid', 'low'].indexOf(String(j.level).toLowerCase()) > -1
    ? String(j.level).toLowerCase() : 'low';

  // 取更严的一方
  const finalLevel = LEVEL_RANK[lv] > LEVEL_RANK[base.level] ? lv : base.level;
  const hits = base.hits.slice();
  if (Array.isArray(j.hits)) {
    for (const h of j.hits) {
      const s = clampText(h, 12);
      if (s && hits.indexOf(s) === -1) hits.push(s);
    }
  }

  return {
    level: finalLevel,
    hits,
    reason: clampText(j.reason, 120) || base.reason,
    suggestion: finalLevel === 'high'
      ? '请删除相关内容后再发布，违规商品会被下架并记入信用记录。'
      : (finalLevel === 'mid' ? '建议修改后再发布，并在平台内完成交易。' : ''),
    source: 'llm'
  };
}

module.exports = {
  llmConfig, chat, parseJsonLoose, toYuan, toFen, median,
  parseQuery, recall, intentText,
  findSamples, ruleListingAssist, listingAssist,
  smartSearch, cardOf,
  RULES, ruleModerate, moderateText
};
