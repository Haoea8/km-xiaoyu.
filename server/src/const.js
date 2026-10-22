'use strict';
/** 全局常量：业务分区、订单状态、举报原因等（前后端共用口径） */

const ZONES = [
  { code: 'used', name: '二手闲置', icon: 'bag', color: '#FF7043' },
  { code: 'errand', name: '代拿代跑', icon: 'scooter', color: '#29B6F6' },
  { code: 'service', name: '校园服务', icon: 'wrench', color: '#66BB6A' },
  { code: 'game', name: '游戏账号', icon: 'gamepad', color: '#7C4DFF' },
  { code: 'rental', name: '物品租借', icon: 'clock', color: '#26A69A' },
  { code: 'barter', name: '以物换物', icon: 'swap', color: '#EC407A' },
  { code: 'group', name: '校园拼团', icon: 'groupbuy', color: '#FFA726' },
  { code: 'graduation', name: '毕业季', icon: 'cap', color: '#5C6BC0' },
  { code: 'lost', name: '失物招领', icon: 'key', color: '#78909C' }
];

const ORDER_STATUS = {
  pending: '待付款',
  paid: '待发货',
  shipped: '待收货',
  done: '已完成',
  canceled: '已取消',
  refunding: '退款中',
  refunded: '已退款'
};

const REPORT_REASONS = [
  '虚假信息 / 货不对板',
  '售卖违禁物品',
  '涉嫌诈骗或诱导私下转账',
  '骚扰辱骂',
  '侵权盗图',
  '其他违规内容'
];

module.exports = { ZONES, ORDER_STATUS, REPORT_REASONS };
