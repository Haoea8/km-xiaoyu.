'use strict';
/**
 * AI 客服智能体「小校助手」
 *
 * 两条通道：
 *  1) 大模型通道（可选，优先）：在 db.meta.config.ai 配置 OpenAI 兼容接口后启用
 *  2) 内置意图引擎（兜底）：规则匹配 + 商品检索 + 订单查询，无外部依赖
 *
 * 大模型通道会在 system prompt 里注入「本系统实时数据」
 * （用户昵称/订单、平台规则、商品命中结果），
 * 因此它回答时是以「科贸小鱼自己的客服」身份作答，而不是通用聊天机器人。
 *
 * ⚠️ 云函数运行时为 Nodejs16.13，没有全局 fetch，
 *    必须用 https/http 模块发请求（这是之前调用必然失败的原因）。
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const db = require('./db');

/** 通用 JSON POST（Node 16 兼容，不依赖 fetch） */
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
      timeout: timeoutMs || 8000
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

function listingCard(l) {
  return { listingId: l.id, title: l.title, image: l.images[0], price: l.price, priceUnit: l.priceUnit };
}

function searchListings(kw) {
  const k = String(kw || '').toLowerCase();
  if (!k) return [];
  const hits = db.find('listings', (l) => l.status === 'on' && (
    String(l.title).toLowerCase().includes(k) ||
    String(l.desc || '').toLowerCase().includes(k) ||
    (l.tags || []).some((t) => String(t).toLowerCase().includes(k))
  ));
  return hits.sort((a, b) => a.price - b.price);
}

const QUICK = ['怎么发布闲置', '支付方式有哪些', '怎么拼团', '帮我找自行车', '联系人工客服'];

function orderAnswer(user) {
  if (!user) return { text: '登录后我就能帮你查订单啦～' };
  const orders = db.find('orders', (o) => o.buyerId === user.id || o.sellerId === user.id)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
  if (!orders.length) {
    return { text: '你还没有订单哦。看到心仪的商品，点进详情页「立即购买」就可以下单了～', quickReplies: QUICK };
  }
  const STATUS = require('./const').ORDER_STATUS;
  const lines = orders.map((o, i) => {
    const role = o.buyerId === user.id ? '买家' : '卖家';
    return (i + 1) + '. 「' + o.snapshot.title + '」 ' + (STATUS[o.status] || o.status) + '（' + role + '身份）';
  });
  return {
    text: '你最近的订单：\n' + lines.join('\n') + '\n\n在「我的 → 我买到的 / 我卖出的」可以查看全部订单详情。',
    quickReplies: ['怎么申请退款', '支付方式有哪些']
  };
}

function rulesReply(user, text) {
  const t = String(text || '').trim();
  const lc = t.toLowerCase();

  // 订单查询
  if (/(订单|物流|发货|收货)/.test(t) && /(查|看|我的|哪|状态|在)/.test(t)) return orderAnswer(user);
  if (/^我的订单/.test(t)) return orderAnswer(user);

  // 商品检索
  const m = t.match(/(?:找|收|想要|有没有|求购|蹲|买)[一个一件个把套本台辆]?\s*([^\s，。！？!?、]{1,12})/) ||
    t.match(/([^\s，。！？!?、]{2,10})(?:还有吗|有人出吗|在哪买)/);
  if (m) {
    const kw = m[1].replace(/(的|吗|呢|啊|吧|了)$/g, '');
    if (kw && !/^(东西|闲置|商品)$/.test(kw)) {
      const hits = searchListings(kw);
      if (hits.length) {
        return {
          text: '帮你找到 ' + hits.length + ' 件和「' + kw + '」相关的在售商品，按价格从低到高排好了，点卡片可以直接看详情：',
          cards: hits.slice(0, 4).map(listingCard),
          quickReplies: ['怎么发布闲置', '支持校内面交吗', '怎么拼团']
        };
      }
      return {
        text: '暂时没搜到「' + kw + '」的在售商品。你可以换个关键词试试，或者点底部「+」发一条求购 / 求物，让同学们主动联系你～',
        quickReplies: ['怎么发布闲置', '平台有哪些专区']
      };
    }
  }

  // 支付
  if (/(支付|付款|付钱|余额|微信支付)/.test(t) && !/退款/.test(t)) {
    return {
      text: '下单后支持两种支付方式：\n1. 余额支付——充值后直接扣款，秒完成；\n2. 微信支付——本演示环境为模拟支付，正式上线可无缝切换真实微信支付。\n\n买家付款后钱款由平台托管，确认收货后才会结算给卖家，交易全程有保障。',
      quickReplies: ['怎么充值', '退款怎么处理', '怎么发布闲置']
    };
  }

  // 充值
  if (/充值/.test(t)) {
    return { text: '打开「我的 → 我的钱包」，点「充值」即可。演示环境充值即时到账，余额可用于全平台下单支付。', quickReplies: ['支付方式有哪些', '退款怎么处理'] };
  }

  // 退款
  if (/(退款|退货|退钱|不要了)/.test(t)) {
    return {
      text: '申请退款：进入「我的 → 我买到的」找到订单 → 点「申请退款」→ 卖家同意后钱款原路退回。\n\n· 卖家未发货：可直接取消订单，钱马上退回；\n· 已发货有争议：平台会介入协调。',
      quickReplies: ['订单在哪里查', '联系人工客服']
    };
  }

  // 发布
  if (/(发布|上架|出售|怎么卖|卖东西|挂)/.test(t)) {
    return {
      text: '发布很简单，四步搞定：\n1. 点底部中间的「+」按钮；\n2. 选择交易分区（二手闲置 / 拼团 / 租借 / 代拿代跑…）；\n3. 上传图片、填标题和价格、选好交易地点；\n4. 点发布，立刻出现在首页！\n\n小贴士：图片清晰 + 标题带关键词，更容易被搜到～',
      quickReplies: ['发布要收费吗', '支持哪些交易方式', '如何提高曝光']
    };
  }
  if (/发布要收费|要收费吗|手续费/.test(t)) {
    return { text: '发布闲置、拼团、租借等全部免费。只有交易成交后，平台收取极低的服务费用于保障交易安全（演示环境免收）。', quickReplies: ['支付方式有哪些'] };
  }

  // 拼团
  if (/拼团/.test(t)) {
    return {
      text: '校园拼团玩法：\n· 在「拼团」分区挑选商品，点「立即参团」并付款；\n· 达到成团人数后统一发货/配送；\n· 到截止时间未成团，系统自动全额退款，不用担心。\n\n你也可以申请当团长，把价格打下来！',
      quickReplies: ['怎么发布闲置', '退款怎么处理']
    };
  }

  // 租借
  if (/(租|出租|租借)/.test(t) && !/拼团/.test(t)) {
    return { text: '物品租借专区支持按天计费：学士服、相机、乐器、球拍、自行车都能租。下单时支付租金，归还后押金原路退回。', quickReplies: ['押金怎么退', '怎么发布闲置'] };
  }

  // 以物换物
  if (/(换物|以物换物|交换)/.test(t)) {
    return { text: '以物换物：在换物专区找到心仪物品，点「发起换物」聊一聊，双方约定好就可以校内交换，平台免费撮合，不需要手续费～', quickReplies: QUICK };
  }

  // 代拿代跑
  if (/(代拿|代跑|跑腿|代取)/.test(t)) {
    return { text: '代拿代跑：快递、外卖、食堂带饭、大件搬运都可以下单，发布需求或直接拍下同学的服务即可，费用当场结算，建议校内当面交易。', quickReplies: QUICK };
  }

  // 游戏账号
  if (/(游戏账号|账号交易)/.test(t)) {
    return { text: '游戏账号交易请在商品页确认「平台担保交易」标识，走担保流程：付款 → 卖家协助改绑 → 你确认收货 → 钱款结算。切勿私下转账！', quickReplies: ['被骗了怎么办', '支付方式有哪些'] };
  }

  // 举报 / 被骗
  if (/(举报|被骗|诈骗|骗子|投诉|骗了)/.test(t)) {
    return {
      text: '遇到可疑卖家请立即举报：商品详情页右上角「…」→「举报」，选择原因提交，管理员会尽快处理。\n\n如果已经被骗：保留所有聊天记录和转账凭证，在订单中发起退款申请，平台会介入；金额较大请第一时间报警。',
      quickReplies: ['怎么申请退款', '联系人工客服']
    };
  }

  // 面交
  if (/(面交|自提|哪里|地点)/.test(t) && !/哪个学校|什么学校/.test(t)) {
    return { text: '平台建议校内公共区域面交（图书馆、食堂门口、宿舍楼下等）。下单时可选择「校内面交 / 宿舍自提 / 校内配送」，约定好时间地点即可。', quickReplies: QUICK };
  }

  // 人工客服
  if (/(人工|真人客服|客服电话)/.test(t)) {
    return { text: '好的，已为你登记转接人工客服～工作时间 9:00-21:00。你也可以把问题说得更详细，我先帮你看看能否直接解决。', quickReplies: ['我的订单', '怎么申请退款'] };
  }

  // 平台介绍
  if (/(有什么功能|有哪些玩法|有什么|平台介绍|是什么|干什么|介绍一下)/.test(t)) {
    return {
      text: '科贸小鱼是咱校同学自己的生活服务平台，不止二手买卖，还有这些玩法：\n· 二手闲置：教材、数码、宿舍好物\n· 代拿代跑：快递外卖食堂带饭\n· 校园拼团：人多价低，不成团自动退款\n· 物品租借：学士服、相机按天租\n· 以物换物：书换书、物换物\n· 失物招领 / 校园圈子：发帖互动\n· 游戏账号：担保交易更放心\n\n想了解哪个直接问我～',
      quickReplies: ['怎么发布闲置', '怎么拼团', '帮我找自行车']
    };
  }

  // 曝光
  if (/(曝光|没人看|看的人少)/.test(t)) {
    return { text: '提升曝光的小技巧：\n1. 图片拍清晰，首图放商品全貌；\n2. 标题带品类关键词（如「考研教材」「27 寸显示器」）；\n3. 价格参考同类商品，写「可小刀」更容易点击；\n4. 每天刷新一下（下架再上架）。', quickReplies: QUICK };
  }

  // 问候
  if (/^(你好|您好|hi|hello|在吗|在不在|嗨|哈喽)/i.test(lc)) {
    return { text: '你好呀～我是科贸小鱼的 AI 客服「小校助手」，发布、下单、支付、拼团的问题都可以问我，也可以直接说「帮我找 xx」试试智能找物！', quickReplies: QUICK };
  }
  if (/(谢谢|感谢|多谢|3q)/i.test(lc)) return { text: '不客气～祝你淘到心仪好物！有其他问题随时找我。', quickReplies: ['怎么发布闲置', '怎么拼团'] };

  // 兜底
  return {
    text: '这个问题我还在学习中～你可以试试问我：「怎么发布闲置」「支付方式有哪些」「怎么拼团」，或者直接说「帮我找自行车」让我帮你搜商品；输入「人工」可转接真人客服。',
    quickReplies: QUICK
  };
}

/**
 * 从用户自然语言里抽取检索候选词（按长度升序，短的先试，召回更高）。
 *
 * 「帮我找自行车」 → ['自行车', '找自行车', '帮我找自行车']
 * 「有没有便宜的显示器」→ ['显示器', '便宜的显示器', ...]
 *
 * 做法：反复剥离口语词，每一步都产出一个候选，最后去重。
 */
const STOP_WORDS = [
  '帮我', '帮忙', '我想', '我要', '想找', '想买', '有没有', '有木有', '请问', '麻烦',
  '给我', '找一下', '搜一下', '查一下', '看一下', '谁有', '求购', '求', '收',
  '安排', '推荐', '便宜', '便宜的', '好用', '找个', '找个', '找', '买', '卖', '要',
  '一下', '怎么样', '多少钱', '的', '了', '吗', '呢', '吧', '啊', '呀', '哦'
];

/** 纯修饰词：本身不是商品名，不应作为检索关键词 */
const PURE_MODIFIERS = [
  '便宜', '便宜的', '好用', '推荐', '哪个好', '划算', '实惠', '全新', '二手',
  '帮我', '帮忙', '我想', '我要', '有没有', '麻烦', '给我'
];

function extractKeywords(text) {
  let t = String(text || '').trim();
  if (!t) return [];
  t = t.replace(/[，。！？、,.!?；;：:"'']/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();

  const set = new Set();
  const queue = [t];
  for (const s of STOP_WORDS) {
    const n = queue.length;
    for (let i = 0; i < n; i++) {
      const w = queue[i];
      if (w.indexOf(s) === -1) continue;
      const parts = w.split(s).filter(Boolean);
      for (const p of parts) {
        const c = p.trim();
        if (c && queue.indexOf(c) === -1) queue.push(c);
      }
    }
  }
  for (const w of queue) {
    const c = w.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').trim();
    if (c.length >= 2 && c.length <= 10) set.add(c);
  }
  // 剔除纯修饰词（它们不是商品名，命中率低且会盖过真正的名词）
  for (const m of PURE_MODIFIERS) set.delete(m);
  // 短词优先：召回更高（「自行车」能命中「山地自行车」）
  return Array.from(set).sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/**
 * 构造 system prompt：注入平台规则 + 用户实时数据 + 商品命中结果。
 * 这是「AI 以本系统身份回答」的核心 —— 它拿到的是真实业务数据，不是泛泛闲聊。
 */
function buildSystemPrompt(user, text) {
  const lines = [];

  lines.push('你是大学生校园生活服务平台「科贸小鱼」的官方 AI 客服，名字叫「小校助手」。');
  lines.push('你要用亲切、活泼、简洁的中文回答，像学长学姐一样，不要长篇大论。');
  lines.push('');
  lines.push('【平台定位】广东科贸职业学院（清远校区）校园二手交易与生活服务平台。');
  lines.push('【业务分区】二手闲置、代拿代跑、校园服务、游戏账号、物品租借、以物换物、校园拼团、毕业季、失物招领。');
  lines.push('【核心规则】');
  lines.push('- 发布：点底部中间「+」→ 选分区 → 上传图片、填标题价格 → 发布');
  lines.push('- 担保交易：买家付款后货款由平台托管，确认收货后才打给卖家');
  lines.push('- 拼团：满员即成团，到期未成团自动全额退款');
  lines.push('- 争议处理：可申请平台介入，客服结合订单与聊天记录处理');
  // 称呼必须严格取自下方【当前用户】，否则模型（尤其低配模型）会自己编名字，
  // 出现「嗨，X同学」但 X 根本不是用户的尴尬情况。
  lines.push('- 称呼用户时，必须原样使用下方【当前用户】里给出的昵称，不要改写、缩写或编造');
  lines.push('- 如果不确定用户是谁，就直接说「同学」，不要猜名字');

  // 用户实时数据
  if (user) {
    lines.push('');
    lines.push('【当前用户】昵称：' + (user.nickname || '同学') +
      '；信用分：' + (user.credit || 80) +
      (user.college ? '；' + user.college : ''));
    try {
      const orders = db.find('orders', (o) => o.buyerId === user.id || o.sellerId === user.id);
      const ongoing = orders.filter((o) => ['pending', 'paid', 'shipped', 'refunding'].indexOf(o.status) > -1);
      lines.push('该用户共有 ' + orders.length + ' 笔订单，其中进行中 ' + ongoing.length + ' 笔。');
    } catch (e) { /* 忽略 */ }
  } else {
    lines.push('');
    lines.push('【当前用户】未登录。涉及订单/发布等问题时，先引导其登录。');
  }

  // 平台实时概况
  try {
    const onSale = db.find('listings', (l) => l.status === 'on');
    lines.push('平台当前在售商品 ' + onSale.length + ' 件。');
  } catch (e) { /* 忽略 */ }

  // 商品检索：若用户像在找东西，把真实结果给它
  try {
    const kws = extractKeywords(text);
    let hits = [];
    let usedKw = '';
    for (const kw of kws) {
      hits = searchListings(kw).slice(0, 5);
      if (hits.length) { usedKw = kw; break; }
    }
    if (hits.length) {
      lines.push('');
      lines.push('【检索到的在售商品】（用户问的是「' + usedKw + '」。回答时可引用这些真实商品，'
        + '价格单位是「分」，如 1500 表示 15 元，请换算成元来表述）：');
      hits.forEach((l, i) => {
        lines.push((i + 1) + '. 「' + l.title + '」 ' + (l.price / 100).toFixed(2) + ' 元' +
          (l.priceUnit ? '/' + l.priceUnit : '') + ' — ' + String(l.desc || '').slice(0, 40));
      });
    }
  } catch (e) { /* 忽略 */ }

  lines.push('');
  lines.push('【要求】只回答与科贸小鱼、校园生活相关的问题；不确定的事不要编造，可引导用户联系人工客服；回答控制在 150 字以内。');

  return lines.join('\n');
}

/**
 * 大模型通道（可选）：配置后优先生效，失败回落内置引擎。
 * 返回 { text, quickReplies } 或 null。
 */
async function llmReply(user, text) {
  // 配置解析统一收敛到 ai-assist.llmConfig()：**环境变量优先，库里兜底**。
  // 目的：换 key 不必改库、也不把 key 留在 meta 里（评审/审计都能看源码）。
  // 没有环境变量时行为与原来完全一致（仍读 meta.config.ai），不会切断现有部署。
  const cfg = require('./ai-assist').llmConfig();

  if (!cfg.enabled) return null;

  const messages = [
    { role: 'system', content: buildSystemPrompt(user, text) },
    { role: 'user', content: String(text || '') }
  ];

  // 兼容 OpenAI 风格：baseUrl 可能已含 /v1，也可能是完整 endpoint
  let url = String(cfg.baseUrl).replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';

  try {
    const data = await postJson(url, {
      model: cfg.model || 'glm-4-flash',
      messages,
      temperature: 0.7,
      max_tokens: 500
    }, { Authorization: 'Bearer ' + cfg.apiKey }, 12000);

    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (!content) return null;
    return { text: String(content).trim(), quickReplies: QUICK };
  } catch (e) {
    return null;
  }
}

/**
 * 统一回复入口：优先大模型，失败回落内置规则引擎。
 *
 * ⚠️ 本函数是 async，调用方必须 await（或包在 Promise.resolve().then 里）。
 * 之前 events.js 对同步版本直接 .then() 导致 TypeError，已一并修正。
 *
 * 关于商品卡片：大模型（llmReply）只返回文字，**不会带 cards**。
 * 若直接 return 大模型结果，用户就只能看到一段商品描述、点不进去，
 * 而「找东西」本该给出可点击的商品卡片。
 * 因此这里在文字之外补一次商品检索，把 cards 挂上去，与规则引擎行为一致。
 */
function findListingsByText(text) {
  const t = String(text || '').trim();
  const m = t.match(/(?:找|收|想要|有没有|求购|蹲|买)[一个一件个把套本台辆]?\s*([^\s，。！？!?、]{1,12})/) ||
    t.match(/([^\s，。！？!?、]{2,10})(?:还有吗|有人出吗|在哪买)/);
  if (m) {
    const kw = m[1].replace(/(的|吗|呢|啊|吧|了)$/g, '');
    if (kw && !/^(东西|闲置|商品)$/.test(kw)) {
      const hits = searchListings(kw);
      if (hits.length) return { kw, hits };
    }
  }
  // 退化：直接按关键词提取再试一轮（例如「英语的」这种没带动词的说法）
  try {
    for (const kw of extractKeywords(t)) {
      const hits = searchListings(kw);
      if (hits.length) return { kw, hits };
    }
  } catch (e) { /* 忽略 */ }
  return { kw: '', hits: [] };
}

/**
 * 生成 AI 回复。
 */
async function generateReply(user, text) {
  const llm = await llmReply(user, text);
  if (llm && llm.text) {
    if (!llm.cards || !llm.cards.length) {
      try {
        const { hits } = findListingsByText(text);
        if (hits.length) llm.cards = hits.slice(0, 4).map(listingCard);
      } catch (e) { /* 卡片失败不影响文字回复 */ }
    }
    return llm;
  }
  return rulesReply(user, text);
}

module.exports = {
  generateReply, rulesReply, llmReply, buildSystemPrompt, extractKeywords,
  searchListings, listingCard, postJson
};
