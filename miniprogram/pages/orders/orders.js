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
  // 以订单上的真实角色为准：tab 只是筛选器，混进买家单时不能按 tab 判断
  const isBuyer = (o && o.isBuyer !== undefined) ? !!o.isBuyer : role === 'buyer';
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
    // 终态：买家能「再次购买」，卖家不该有购买按钮 —— 之前这里不分角色，
    // 卖家在「我卖出的 · 已完成」里看到「再次购买」，点进去还是自己那件商品。
    if (isBuyer) acts.push({ act: 'rebuy', label: '再次购买', ghost: true });
    else acts.push({ act: 'chat', label: '联系买家', ghost: true });
  }
  // 每个状态都保留一个「联系对方」入口（买到的→联系卖家，卖出的→联系买家）
  if (!acts.some((a) => a.act === 'chat')) {
    acts.push({ act: 'chat', label: isBuyer ? '联系卖家' : '联系买家', ghost: true });
  }
  // 自买自卖的历史测试单没有「对方」：去掉联系入口，换成一个能点的「查看订单」，
  // 避免用户点了看到「不能和自己发起会话」这种莫名其妙的报错。
  if (o.isSelfOrder) {
    const rest = acts.filter((a) => a.act !== 'chat');
    rest.push({ act: 'view', label: '查看订单', ghost: true });
    return rest;
  }
  return acts;
}

/** 对方 userId：订单字段优先，缺失时退回序列化出来的 brief（列表接口可能只给 brief） */
function peerIdOf(o, role) {
  const isBuyer = (o && o.isBuyer !== undefined) ? !!o.isBuyer : role === 'buyer';
  const brief = isBuyer ? o.seller : o.buyer;
  return (isBuyer ? o.sellerId : o.buyerId) || (brief && brief.id) || 0;
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
        const cp = role === 'buyer' ? o.seller : o.buyer;
        return Object.assign(o, {
          cover: api.abs((o.snapshot && o.snapshot.image) || ''),
          priceText: util.fmtMoney(o.snapshot ? o.snapshot.price : 0),
          amountText: util.fmtMoney(o.amount),
          payText: util.fmtMoney(o.payAmount),
          statusText2: st.text,
          statusColor: st.color,
          timeText2: util.fmtTime(o.createdAt),
          // 头像走「字标 + 图片」双层：avatar 为空或链接过期时只显示字标
          counterpart: Object.assign({}, cp || { nickname: '用户' }, {
            avatar: api.abs((cp && cp.avatar) || ''),
            avatarErr: false
          }),
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
      chat: () => app.openChat({ peerId: peerIdOf(o, this.data.role), listingId: o.listingId }),
      rebuy: () => wx.navigateTo({ url: '/pages/detail/detail?id=' + o.listingId }),
      view: () => this.goDetail({ currentTarget: { dataset: { id: o.id } } })
    };
    if (map[act]) map[act]();
  },

  async pay(o) {
    // 防双击：连点两下会发两次支付请求（服务端也会拦，但先在这里挡住，体验更好）
    if (this.__paying) return wx.showToast({ title: '正在支付，请稍候', icon: 'none' });
    this.__paying = true;
    const unlock = () => { this.__paying = false; };
    try {
      const w = await api.get('/api/wallet', null, { silent: true }).catch(() => ({ balance: 0 }));
      const balance = w.balance || 0;
      await new Promise((resolve) => {
        wx.showActionSheet({
          itemList: ['余额支付（可用 ¥' + util.fmtMoney(balance) + '）', '微信支付（演示）'],
          success: async (r) => {
            const method = r.tapIndex === 0 ? 'balance' : 'wxpay';
            if (method === 'balance' && balance < o.payAmount) {
              wx.showModal({
                title: '余额不足',
                content: '还差 ¥' + util.fmtMoney(o.payAmount - balance) + '，是否去充值？',
                confirmText: '去充值',
                success: (m) => { if (m.confirm) wx.navigateTo({ url: '/pages/wallet/wallet?recharge=1' }); resolve(); },
                fail: resolve
              });
              return;
            }
            try {
              await api.post('/api/orders/' + o.id + '/pay', { method }, { loading: '支付中' });
              wx.showToast({ title: '支付成功', icon: 'success' });
              this.fetch();
            } catch (e) {
              // 服务端判定「已付过」不是错误，刷新即可
              if (String(e && e.message || '').indexOf('已经付过款') > -1) this.fetch();
            } finally { resolve(); }
          },
          fail: () => resolve()
        });
      });
    } finally { unlock(); }
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

  /**
   * 提醒发货 / 催买家付款：进会话并自动替用户发一条消息。
   * 之前只跳会话、什么都不发，用户还得自己再打一遍字。
   */
  remind(o) {
    const isBuyer = (o && o.isBuyer !== undefined) ? !!o.isBuyer : this.data.role === 'buyer';
    const text = isBuyer
      ? ('你好，我这边已经付款了（订单 ' + (o.orderNo || o.id) + '），麻烦尽快发货，谢谢～')
      : ('你好，订单 ' + (o.orderNo || o.id) + ' 还在等待付款，方便的时候付一下，谢谢～');
    app.openChat({ peerId: peerIdOf(o, this.data.role), listingId: o.listingId, text });
  },

  /** 头像图片加载失败 → 退回字标（不留下破图） */
  onAvatarErr(e) {
    const idx = e.currentTarget.dataset.idx;
    const key = 'list[' + idx + '].counterpart.avatar';
    this.setData({ [key]: '' });
  }
});
