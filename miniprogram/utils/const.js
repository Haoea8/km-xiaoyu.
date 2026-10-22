/**
 * 前端常量：交易分区、订单状态、举报原因、快捷短语
 * 与后端 server/src/const.js 保持一致
 */

const ZONES = [
  { code: 'used', name: '二手闲置', short: '二', color: '#FFB300', bg: 'linear-gradient(135deg,#FFD54F,#FFB300)', desc: '闲置好物流转' },
  { code: 'errand', name: '代拿代跑', short: '代', color: '#29B6F6', bg: 'linear-gradient(135deg,#6FD3FF,#29B6F6)', desc: '快递外卖代取' },
  { code: 'service', name: '校园服务', short: '服', color: '#26C6A0', bg: 'linear-gradient(135deg,#5FE0BD,#26C6A0)', desc: '技能与跑腿' },
  { code: 'game', name: '游戏账号', short: '游', color: '#7A5AF8', bg: 'linear-gradient(135deg,#A58BFF,#7A5AF8)', desc: '账号代练交易' },
  { code: 'rental', name: '物品租借', short: '租', color: '#FFA726', bg: 'linear-gradient(135deg,#FFC466,#FFA726)', desc: '按天租更划算' },
  { code: 'barter', name: '以物换物', short: '换', color: '#EC5FA8', bg: 'linear-gradient(135deg,#FF8FC9,#EC5FA8)', desc: '不用钱也能换' },
  { code: 'group', name: '拼团拼单', short: '拼', color: '#EF5350', bg: 'linear-gradient(135deg,#FF8A80,#EF5350)', desc: '人多价更低' },
  { code: 'graduation', name: '毕业季', short: '毕', color: '#42A5F5', bg: 'linear-gradient(135deg,#7EC4FF,#42A5F5)', desc: '毕业清仓专区' },
  { code: 'lost', name: '失物招领', short: '失', color: '#8D9AA8', bg: 'linear-gradient(135deg,#B7C3D0,#8D9AA8)', desc: '丢的捡的都在这' }
];

const ZONE_MAP = {};
ZONES.forEach((z) => { ZONE_MAP[z.code] = z; });

const ORDER_STATUS = {
  pending: { text: '待付款', color: '#FFC53D' },
  paid: { text: '待发货', color: '#2AA9E0' },
  shipped: { text: '待收货', color: '#7A5AF8' },
  done: { text: '已完成', color: '#22B573' },
  canceling: { text: '取消中', color: '#9AA0A6' },
  canceled: { text: '已取消', color: '#9AA0A6' },
  refunding: { text: '退款中', color: '#EF5350' },
  refunded: { text: '已退款', color: '#9AA0A6' }
};

const TRADE_MODES = {
  sell: '出售',
  rent: '出租',
  barter: '置换',
  group: '拼团',
  service: '服务',
  free: '免费送'
};

/**
 * 商品举报原因。
 *
 * ⚠️ 最多 6 项：wx.showActionSheet 的 itemList「数组长度最大为 6」（官方文档），
 *    超限时接口直接调用失败 —— 界面上就是「点了完全没反应」。
 *    这里原本有 7 项（多了一个「辱骂骚扰」），导致详情页的举报按钮点了没反应，
 *    而其它页面（4~6 项）都正常，很容易被误判成玄学。
 *    修改本数组时务必保持 ≤ 6，并跑一遍 tools/check-ui-limits.js。
 *    「辱骂骚扰」属聊天场景，商品举报用不到，已移除。
 */
const REPORT_REASONS = ['虚假信息', '违禁物品', '价格欺诈', '涉嫌诈骗', '侵权盗版', '其他违规'];

const QUICK_WORDS = ['还在吗？', '可以便宜一点吗？', '什么时候方便交易？', '校内哪里面交？', '可以留给我吗？'];

/** AI 客服快捷提问 */
const AI_QUICK = ['怎么发布闲置？', '怎么下单支付？', '拼团怎么参加？', '想租东西怎么找？', '遇到骗子怎么办？'];

const COLLEGES = ['广东科贸职业学院（清远校区）', '广东科贸职业学院（广州校区）', '广东科贸职业学院（白云校区）'];

const GRADES = ['大一', '大二', '大三', '大四', '毕业一年内'];

module.exports = { ZONES, ZONE_MAP, ORDER_STATUS, TRADE_MODES, REPORT_REASONS, QUICK_WORDS, AI_QUICK, COLLEGES, GRADES };
