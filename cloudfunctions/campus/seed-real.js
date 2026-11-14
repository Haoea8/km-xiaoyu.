'use strict';
/**
 * 真实运营数据种子。
 *
 * 来源：本项目在微信体验版上真实运行了 33 天（2026-10-13 ~ 11-15）后，
 * 从云开发数据库导出 users / listings / orders 三个集合，清洗后固化于此。
 *
 * 清洗规则（见 tools/build-seed-real.py 的同类逻辑）：
 *   - 剔除 2 笔 ¥999,999 的支付联调测试单
 *   - 用户余额全部归零（原为测试充值，非真实资金）
 *   - id 重排为 1..N 连续整数，外键（sellerId / buyerId / listingId）同步重映射
 *   - 去掉云数据库专用字段 _id / _openid
 *
 * 规模：33 用户 / 98 商品 / 36 订单，订单总额 ¥3754.60，已完成 5 笔。
 * 数据文件：seed-real-data.json
 */
const db = require('./db');

let RAW = null;
try {
  RAW = require('./seed-real-data.json');
} catch (e) {
  RAW = null;   // 数据文件缺失时静默降级，由调用方回退到 seed.js
}

/**
 * 把真实数据写入内存库，替代 seed.js 的程序化生成。
 * 只负责三个核心集合；校园墙 / 学习资源 / 拼团仍由 seed2.js 生成，
 * 因为那部分依赖随机组合，导出意义不大。
 */
function build() {
  if (!RAW) throw new Error('seed-real-data.json 缺失');

  const data = db.load();

  // 清空（与 seed.js 一致：直接置空数组，再由 insertMany 写入）
  data.users = [];
  data.listings = [];
  data.orders = [];

  db.insertMany('users', RAW.users || []);
  db.insertMany('listings', RAW.listings || []);
  db.insertMany('orders', RAW.orders || []);

  /**
   * 把自增游标推到最大 id。
   * 不推的话，后续用户新增商品会从 id=1 开始，与已有记录撞号，
   * findById 会命中旧记录，表现为「编辑 A 商品却改到了 B」。
   */
  data.seq = data.seq || {};
  data.seq.users = (RAW.users || []).length;
  data.seq.listings = (RAW.listings || []).length;
  data.seq.orders = (RAW.orders || []).length;

  return {
    users: data.seq.users,
    listings: data.seq.listings,
    orders: data.seq.orders
  };
}

module.exports = { build, available: !!RAW };
