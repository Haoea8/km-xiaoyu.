'use strict';
/**
 * AI 主链路接口（云函数版）
 *
 *   POST /api/ai/listing-assist  发布辅助：标题/描述/标签/建议价（RAG：注入平台同类在售样本）
 *   POST /api/ai/search          自然语言找货：解析预算与品类 → 检索 → 大模型重排
 *   POST /api/ai/moderate        违规审核：规则 + 大模型，取更严的一方
 *
 * 三个接口的共同约定：
 *   - **永不因为大模型失败而报错**：无 key、超时、返回非 JSON 都回落内置引擎，
 *     返回里用 `source: 'llm' | 'rule'` 标明来源，前端可据此提示「AI 思考中」之类的文案。
 *   - 只在登录后可用（发布辅助、找货都跟用户相关），未登录返回 401，
 *     与项目其余接口一致，前端 api.js 收到 401 会清 token。
 *
 * ⚠️ 与 `server/src/routes/ai.js` 是镜像代码，路由必须同步（check-mirror.js 会校验）。
 */
const ai = require('./ai-assist');

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

    const out = await ai.listingAssist({
      title,
      desc,
      zone: String(b.zone || '').trim(),
      tradeMode: String(b.tradeMode || '').trim(),
      condition: String(b.condition || '').trim()
    });

    return out;
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
