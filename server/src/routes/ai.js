'use strict';
/**
 * AI 主链路接口（本地镜像版）
 *
 * 与 `cloudfunctions/campus/route-ai.js` 的路由、参数、返回结构完全一致，
 * 只有 require 路径深度不同（check-mirror.js 校验的是路由指纹，不是逐字节）。
 *
 *   POST /api/ai/listing-assist  发布辅助
 *   POST /api/ai/search          自然语言找货
 *   POST /api/ai/moderate        违规审核
 */
const ai = require('../ai-assist');

function fail(message, status) {
  const e = new Error(message);
  e.status = status || 400;
  throw e;
}

function needUser(ctx) {
  if (!ctx.user) fail('请先登录', 401);
  return ctx.user;
}

module.exports = (route) => {
  /** 发布辅助 */
  route('POST', '/api/ai/listing-assist', async (ctx) => {
    needUser(ctx);
    const b = ctx.body || {};
    const title = String(b.title || '').trim();
    const desc = String(b.desc || '').trim();
    if (!title && !desc) fail('先写一句标题或描述，AI 才有依据');

    return await ai.listingAssist({
      title,
      desc,
      zone: String(b.zone || '').trim(),
      tradeMode: String(b.tradeMode || '').trim(),
      condition: String(b.condition || '').trim()
    });
  });

  /** 自然语言找货 */
  route('POST', '/api/ai/search', async (ctx) => {
    const b = ctx.body || {};
    const q = String(b.query || b.q || '').trim();
    if (!q) fail('说一句想找什么，比如「200 以内能打游戏的显示器」');
    if (q.length > 60) fail('这句话太长了，精简一点更好找');

    return await ai.smartSearch(q);
  });

  /** 违规审核 */
  route('POST', '/api/ai/moderate', async (ctx) => {
    const b = ctx.body || {};
    const title = String(b.title || '').trim();
    const desc = String(b.desc || '').trim();
    if (!title && !desc) return { level: 'low', hits: [], reason: '', suggestion: '', source: 'rule' };

    return await ai.moderateText(title, desc);
  });
};
