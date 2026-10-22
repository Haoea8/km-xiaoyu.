'use strict';
/**
 * AI 客服智能体「小校助手」
 * 默认使用内置意图引擎（规则 + 商品检索 + 订单查询）；
 * 若在管理后台 / db.meta.config.ai 配置了大模型（OpenAI 兼容接口），
 * 将优先调用大模型，失败自动回落到内置引擎，保证演示不中断。
 */
const db = require('./db');

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

/** 大模型通道（可选）：配置后优先生效，失败回落内置引擎 */
async function llmReply(user, text) {
  // 与环境变量优先的配置解析保持一致（见 ai-assist.llmConfig）
  const cfg = require('./ai-assist').llmConfig();
  if (!cfg.enabled) return null;

  try {
    const system = '你是大学生校园生活服务平台「科贸小鱼」的 AI 客服小校助手，语气亲切活泼，回答简洁实用。平台功能：二手闲置/代拿代跑/校园拼团/物品租借/以物换物/失物招领/校园圈子/游戏账号担保交易。用户昵称：' +
      (user ? user.nickname : '同学') + '。';
    const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model || 'gpt-4o-mini',
        messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
        temperature: 0.7, max_tokens: 500
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return content ? { text: String(content).trim(), quickReplies: QUICK } : null;
  } catch (e) { return null; }
}

function generateReply(user, text) {
  return rulesReply(user, text);
}

module.exports = { generateReply, rulesReply, llmReply, searchListings, listingCard };
