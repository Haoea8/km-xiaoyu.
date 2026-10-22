/**
 * 我的订单：买家 / 卖家双视角 + 状态筛选
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');
const { ORDER_STATUS } = require('../../utils/const');

const ROLE_TABS = [
  { key: 'buyer', label: '我买到的' },
  { key: 'seller', label: '我卖出的' }
];

const STATUS_TABS = [
  { key: 'all', label: '全部' },
  { key: 'ongoing', label: '进行中' },
  { key: 'pending', label: '待付款' },
  { key: 'paid', label: '待发货' },
  { key: 'shipped', label: '待收货' },
  { key: 'refunding', label: '退款' },
  { key: 'done', label: '已完成' }
];

/** 每个状态下的操作按钮（按角色） */
function actionsOf(o, role) {
  const isBuyer = role === 'buyer';
  const acts = [];
  if (o.status === 'pending') {
    acts.push({ act: 'cancel', label: '取消订单', ghost: true });
    if (isBuyer) acts.push({ act: 'pay', label: '立即支付', main: true });
    else acts.push({ act: 'remind', label: '催买家付款', main: true });
  } else if (o.status === 'paid') {
    if (isBuyer) {
      acts.push({ act: 'refund', label: '申请退款', ghost: true });
      acts.push({ act: 'remind', label: '提醒发货', main: true });
    } else {
      acts.push({ act: 'refund', label: '处理退款', ghost: true });
      acts.push({ act: 'ship', label: '立即发货', main: true });
    }
  } else if (o.status === 'shipped') {
    if (isBuyer) {
      acts.push({ act: 'refund', label: '申请退款', ghost: true });
      acts.push({ act: 'confirm', label: '确认收货', main: true });
    } else {
      acts.push({ act: 'chat', label: '联系买家', ghost: true });
    }
  } else if (o.status === 'refunding') {
    if (isBuyer) acts.push({ act: 'chat', label: '联系卖家', ghost: true });
    else {
      acts.push({ act: 'reject', label: '拒绝退款', ghost: true });
      acts.push({ act: 'agree', label: '同意退款', main: true });
    }
  } else if (o.status === 'done' || o.status === 'canceled' || o.status === 'refunded') {
    acts.push({ act: 'rebuy', label: '再次购买', ghost: true });
  }
  return acts;
}

Page({
  data: {
    roleTabs: ROLE_TABS,
    statusTabs: STATUS_TABS,
    role: 'buyer',
    status: 'all',
    loading: true,
    list: []
  },

  onLoad(opts) {
    this.setData({
      role: opts.role === 'seller' ? 'seller' : 'buyer',
      status: opts.status || 'all'
    });
  },

  onShow() {
    if (!app.guard()) { this.setData({ loading: false }); return; }
    this.fetch();
  },

  onPullDownRefresh() { this.fetch().then(() => wx.stopPullDownRefresh()); },

  async fetch() {
    this.setData({ loading: true });
    try {
      const res = await api.get('/api/orders?role=' + this.data.role + '&status=' + this.data.status);
      const role = this.data.role;
      const list = (res.items || []).map((o) => {
        const st = ORDER_STATUS[o.status] || { text: o.status, color: '#9AA0A6' };
        return Object.assign(o, {
          cover: api.abs((o.snapshot && o.snapshot.image) || ''),
          priceText: util.fmtMoney(o.snapshot ? o.snapshot.price : 0),
          amountText: util.fmtMoney(o.amount),
          payText: util.fmtMoney(o.payAmount),
          statusText2: st.text,
          statusColor: st.color,
          timeText2: util.fmtTime(o.createdAt),
          counterpart: role === 'buyer' ? o.seller : o.buyer,
          acts: actionsOf(o, role)
        });
      });
      this.setData({ list, loading: false });
    } catch (e) {
      this.setData({ list: [], loading: false });
    }
  },

  onRole(e) {
    const role = e.currentTarget.dataset.k;
    if (role === this.data.role) return;
    this.setData({ role, status: 'all' });
    this.fetch();
  },

  onStatus(e) {
    this.setData({ status: e.currentTarget.dataset.k });
    this.fetch();
  },

  goDetail(e) { wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + e.currentTarget.dataset.id }); },
  goListing(e) { wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id }); },

  onAction(e) {
    const { act, id } = e.currentTarget.dataset;
    const o = this.data.list.find((x) => x.id === Number(id));
    if (!o) return;
    const map = {
      pay: () => this.pay(o),
      cancel: () => this.cancel(o),
      ship: () => this.ship(o),
      confirm: () => this.confirm(o),
      refund: () => this.refund(o),
      agree: () => this.decide(o, true),
      reject: () => this.decide(o, false),
      remind: () => this.remind(o),
      chat: () => app.openChat({ peerId: this.data.role === 'buyer' ? o.sellerId : o.buyerId, listingId: o.listingId }),
      rebuy: () => wx.navigateTo({ url: '/pages/detail/detail?id=' + o.listingId })
    };
    if (map[act]) map[act]();
  },

  async pay(o) {
    const w = await api.get('/api/wallet', null, { silent: true }).catch(() => ({ balance: 0 }));
    const balance = w.balance || 0;
    wx.showActionSheet({
      itemList: ['余额支付（可用 ¥' + util.fmtMoney(balance) + '）', '微信支付（演示）'],
      success: async (r) => {
        const method = r.tapIndex === 0 ? 'balance' : 'wxpay';
        if (method === 'balance' && balance < o.payAmount) {
          return wx.showModal({
            title: '余额不足',
            content: '还差 ¥' + util.fmtMoney(o.payAmount - balance) + '，是否去充值？',
            confirmText: '去充值',
            success: (m) => { if (m.confirm) wx.navigateTo({ url: '/pages/wallet/wallet?recharge=1' }); }
          });
        }
        try {
          await api.post('/api/orders/' + o.id + '/pay', { method }, { loading: '支付中' });
          wx.showToast({ title: '支付成功', icon: 'success' });
          this.fetch();
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  cancel(o) {
    wx.showModal({
      title: '取消订单', content: '确定要取消这笔订单吗？', confirmText: '确定取消',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await api.post('/api/orders/' + o.id + '/cancel', {}, { loading: true });
          wx.showToast({ title: '订单已取消', icon: 'none' });
          this.fetch();
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  ship(o) {
    wx.showModal({
      title: '确认发货', content: '确认已完成交付？确认后买家即可收货。',
      editable: true, placeholderText: '发货说明（选填，如：放在 3 栋快递柜）',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await api.post('/api/orders/' + o.id + '/ship', { note: r.content || '' }, { loading: true });
          wx.showToast({ title: '已发货', icon: 'none' });
          this.fetch();
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  confirm(o) {
    wx.showModal({
      title: '确认收货', content: '确认已收到商品？确认后货款将打给卖家。',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await api.post('/api/orders/' + o.id + '/confirm', {}, { loading: true });
          wx.showToast({ title: '交易完成', icon: 'success' });
          this.fetch();
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  refund(o) {
    wx.showModal({
      title: '申请退款', editable: true, placeholderText: '请填写退款原因',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await api.post('/api/orders/' + o.id + '/refund', { reason: r.content || '买家申请退款' }, { loading: true });
          wx.showToast({ title: '已提交退款申请', icon: 'none' });
          this.fetch();
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  decide(o, approve) {
    wx.showModal({
      title: approve ? '同意退款' : '拒绝退款',
      content: approve ? '同意后将把货款退还给买家。' : '拒绝后订单将回到「待发货」状态。',
      editable: !approve, placeholderText: '拒绝理由（选填）',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await api.post('/api/orders/' + o.id + '/refund/decide', { approve, note: r.content || '' }, { loading: true });
          wx.showToast({ title: approve ? '已同意退款' : '已拒绝退款', icon: 'none' });
          this.fetch();
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  remind(o) {
    app.openChat({ peerId: this.data.role === 'buyer' ? o.sellerId : o.buyerId, listingId: o.listingId });
  }
});
