'use strict';
/**
 * 真实运营数据种子。
 *
 * 来源：本项目在微信体验版上真实运行了 33 天（2026-10-13 ~ 11-15）后，
 * 从云开发数据库导出 users / listings / orders / circles / posts / comments
 * / walls / wallComments / resources 九个集合，清洗后固化于此。
 *
 * 清洗规则（见 tools/build-seed-full.py 的同类逻辑）：
 *   - 剔除 2 笔 ¥999,999 的支付联调测试单
 *   - 用户余额全部归零（原为测试充值，非真实资金）
 *   - 各集合 id 重排为 1..N 连续整数，外键（sellerId / buyerId / listingId /
 *     circleId / authorId / postId / wallId / uploaderId / likes / replyTo）
 *     同步重映射
 *   - 剔除 5 条孤儿评论（对应帖子已删）
 *   - 去掉云数据库专用字段 _id / _openid / reqId
 *   - commentCount 按实际评论数重算
 *
 * 规模：33 用户 / 98 商品 / 36 订单 / 6 圈子 / 38 帖子 / 58 评论
 *       / 27 校园墙 / 24 墙评 / 10 学习资源
 * 数据文件：seed-real-data.json
 */
const db = require('./db');

let RAW = null;
try {
  RAW = require('./seed-real-data.json');
} catch (e) {
  RAW = null;   // 数据文件缺失时静默降级，由调用方回退到 seed.js
}

/** 被真实数据覆盖的集合 */
const COLLECTIONS = [
  'users', 'listings', 'orders',
  'circles', 'posts', 'comments',
  'walls', 'wallComments', 'resources'
];

/**
 * 用真实数据覆盖对应集合。
 *
 * 调用时机：必须在 seed.js / seed2.js 之后执行 —— 那两个脚本负责生成
 * 收藏、会话、消息、通知、举报、地址、关注、拼团等辅助集合，
 * 真实数据只覆盖有实际导出的九个集合。
 */
function build() {
  if (!RAW) throw new Error('seed-real-data.json 缺失');

  const data = db.load();
  data.seq = data.seq || {};

  for (const name of COLLECTIONS) {
    const rows = RAW[name] || [];
    if (!rows.length) continue;

    data[name] = [];
    db.insertMany(name, rows);

    /**
     * 把自增游标推到最大 id。
     * 不推的话，后续用户新增记录会从 id=1 开始，与已有数据撞号，
     * findById 会命中旧记录，表现为「编辑 A 商品却改到了 B」。
     */
    data.seq[name] = rows.reduce((m, r) => Math.max(m, r.id || 0), 0);
  }

  /**
   * 交易流水清空：真实用户余额已归零，seed.js 生成的程序化流水
   * （充值 / 购买 / 卖出）与零余额相互矛盾，展示出来只会让后台对不上账。
   */
  data.transactions = [];

  return COLLECTIONS.reduce((acc, name) => {
    acc[name] = (RAW[name] || []).length;
    return acc;
  }, {});
}

module.exports = { build, available: !!RAW };
