/**
 * 订单详情：状态机操作 + 平台担保资金托管明细 + 时间线
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');
const { ORDER_STATUS, ZONE_MAP, TRADE_MODES } = require('../../utils/const');

const TIMELINE_ICON = {
  created: '📝', paid: '💰', shipped: '📦', done: '✅',
  canceled: '🚫', refunding: '↩️', refunded: '💸'
};

const REPORT_ITEMS = ['虚假交易', '恶意拖欠', '商品与描述不符', '辱骂骚扰', '其他违规'];

Page({
  data: {
    id: 0,
    loading: true,
    order: null,
    cover: '',
    statusText: '',
    statusColor: '',
    amountText: '0.00',
    payText: '0.00',
    unitPriceText: '0',
    createdText: '',
    zoneText: '',
    modeText: '',
    timeline: [],
    steps: [],
    stepIndex: 0,
    isBuyer: false,
    peer: null,
    acts: [],

    /** 平台担保 */
    escrow: null,
    escrowSteps: [],
    escrowText: '',
    escrowStatus: 'none',
    guarantee: [],
    showGuarantee: false
  },

  onLoad(opts) {
    this.setData({ id: Number(opts.id || 0) });
    if (opts.paid === '1') {
      setTimeout(() => wx.showToast({ title: '支付成功，等待卖家发货', icon: 'none', duration: 2200 }), 400);
    }
    this.fetch();
  },

  onShow() {
    if (!this.data.id || this.data.loading) return;
    this.fetch();
  },

  onPullDownRefresh() { this.fetch().then(() => wx.stopPullDownRefresh()); },

  async fetch() {
    try {
      const [res, esc] = await Promise.all([
        api.get('/api/orders/' + this.data.id),
        api.get('/api/escrow/order/' + this.data.id, null, { silent: true }).catch(() => null)
      ]);
      const o = res.order;
      const st = ORDER_STATUS[o.status] || { text: o.status, color: '#9AA0A6' };
      const zone = ZONE_MAP[o.snapshot.zone] || null;
      const steps = [
        { key: 'created', label: '已下单' },
        { key: 'paid', label: '已付款' },
        { key: 'shipped', label: '已发货' },
        { key: 'done', label: '已完成' }
      ];
      const order = ['created', 'paid', 'shipped', 'done'];
      let idx = -1;
      order.forEach((k, i) => { if ((o.timeline || []).some((t) => t.status === k)) idx = i; });
      if (o.status === 'canceled' || o.status === 'refunded') idx = -1;

      this.setData({
        order: o,
        cover: api.abs((o.snapshot && o.snapshot.image) || ''),
        statusText: st.text,
        statusColor: st.color,
        amountText: util.fmtMoney(o.amount),
        payText: util.fmtMoney(o.payAmount),
        unitPriceText: util.fmtPrice(o.snapshot ? o.snapshot.price : 0),
        createdText: util.fmtTime(o.createdAt),
        zoneText: zone ? zone.name : (o.snapshot.zone || ''),
        modeText: TRADE_MODES[o.snapshot.tradeMode] || '',
        timeline: (o.timeline || []).slice().reverse().map((t) => Object.assign({}, t, {
          timeText: util.fmtTime(t.time),
          icon: TIMELINE_ICON[t.status] || '•'
        })),
        steps,
        stepIndex: idx,
        isBuyer: !!o.isBuyer,
        peer: o.isBuyer ? o.seller : o.buyer,
        acts: this.actions(o),
        // 担保
        escrow: esc || null,
        escrowSteps: esc ? esc.steps : [],
        escrowText: esc ? esc.escrowText : '',
        escrowStatus: esc ? esc.escrowStatus : 'none',
        guarantee: esc ? esc.guarantee : [],
        loading: false
      });
    } catch (e) {
      this.setData({ loading: false });
      setTimeout(() => wx.navigateBack(), 900);
    }
  },

  actions(o) {
    const isBuyer = !!o.isBuyer;
    const acts = [];
    if (o.status === 'pending') {
      acts.push({ act: 'cancel', label: '取消订单', ghost: true });
      if (isBuyer) acts.push({ act: 'pay', label: '立即支付 ¥' + util.fmtMoney(o.payAmount), main: true });
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
        acts.push({ act: 'remind', label: '提醒收货', ghost: true });
      }
    } else if (o.status === 'refunding') {
      if (isBuyer) acts.push({ act: 'chat', label: '联系卖家', ghost: true });
      else {
        acts.push({ act: 'reject', label: '拒绝退款', ghost: true });
        acts.push({ act: 'agree', label: '同意退款', main: true });
      }
    } else {
      // 终态（done / canceled / refunded）：买家可再次购买，卖家只能联系买家。
      // 之前不分角色一律给「再次购买」——卖家点进去是自己那件已卖掉的商品。
      if (isBuyer) acts.push({ act: 'rebuy', label: '再次购买', ghost: true });
      else acts.push({ act: 'chat', label: '联系买家', ghost: true });
    }
    // 每个状态都留一个联系入口
    if (!acts.some((a) => a.act === 'chat')) {
      acts.push({ act: 'chat', label: isBuyer ? '联系卖家' : '联系买家', ghost: true });
    }
    acts.sort((a, b) => (a.main ? 1 : 0) - (b.main ? 1 : 0));

    if (o.isSelfOrder) {
      return acts.filter((a) => a.act !== 'chat');
    }
    return acts;
  },

  onAction(e) {
    const act = e.currentTarget.dataset.act;
    const o = this.data.order;
    const map = {
      pay: () => this.pay(o),
      cancel: () => this.cancel(o),
      ship: () => this.ship(o),
      confirm: () => this.confirm(o),
      refund: () => this.refund(o),
      agree: () => this.decide(o, true),
      reject: () => this.decide(o, false),
      remind: () => this.remind(),
      chat: () => this.chat(),
      rebuy: () => wx.navigateTo({ url: '/pages/detail/detail?id=' + o.listingId })
    };
    if (map[act]) map[act]();
  },

  /** 提醒发货 / 催付款：进会话并自动发一条消息 */
  remind() {
    const o = this.data.order || {};
    const isBuyer = !!o.isBuyer;
    let text;
    if (isBuyer) text = '你好，我这边已经付款了（订单 ' + (o.orderNo || o.id) + '），麻烦尽快发货，谢谢～';
    else if (o.status === 'shipped') text = '你好，宝贝已经交付了（订单 ' + (o.orderNo || o.id) + '），麻烦确认收货，货款才会到账，谢谢～';
    else text = '你好，订单 ' + (o.orderNo || o.id) + ' 还在等待付款，方便的时候付一下，谢谢～';
    const peerId = (this.data.peer && this.data.peer.id) || (isBuyer ? o.sellerId : o.buyerId) || 0;
    if (!peerId) return wx.showToast({ title: '对方信息加载中', icon: 'none' });
    app.openChat({ peerId, text });
  },

  chat() {
    const o = this.data.order || {};
    const isBuyer = !!o.isBuyer;
    // peer.id 可能为 0（对方用户没被序列化出来）→ 退回订单上的 id，别把 0 发给后端（会提示「对方不存在」）
    const peerId = (this.data.peer && this.data.peer.id) || (isBuyer ? o.sellerId : o.buyerId) || 0;
    if (!peerId) {
      return wx.showToast({ title: '对方信息加载中，请稍后重试', icon: 'none' });
    }
    app.openChat({ peerId });
  },

  toggleGuarantee() { this.setData({ showGuarantee: !this.data.showGuarantee }); },

  async pay(o) {
    // 防双击（服务端也会拦「已付过」，这里只是别让用户等两次）
    if (this.__paying) return wx.showToast({ title: '正在支付，请稍候', icon: 'none' });
    this.__paying = true;
    try {
      // 支付前二次确认：钱一出去就是托管状态，必须让用户明确「确认支付」
      const go = await new Promise((resolve) => {
        wx.showModal({
          title: '确认支付',
          content: '需支付 ¥' + util.fmtMoney(o.payAmount) + '，货款先由平台托管，确认收货后才打给卖家。',
          confirmText: '确认支付',
          cancelText: '稍后支付',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false)
        });
      });
      if (!go) {
        wx.showToast({ title: '订单已保存到「待付款」', icon: 'none' });
        return;
      }
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
              if (String(e && e.message || '').indexOf('已经付过款') > -1) this.fetch();
            } finally { resolve(); }
          },
          fail: () => resolve()
        });
      });
    } finally { this.__paying = false; }
  },

  cancel(o) {
    wx.showModal({
      title: '取消订单', content: '确定要取消这笔订单吗？', confirmText: '确定取消',
      success: async (r) => {
        if (!r.confirm) return;
        try { await api.post('/api/orders/' + o.id + '/cancel', {}, { loading: true }); wx.showToast({ title: '订单已取消', icon: 'none' }); this.fetch(); } catch (e) { /* 已提示 */ }
      }
    });
  },

  ship(o) {
    wx.showModal({
      title: '确认发货', content: '确认已完成交付？', editable: true, placeholderText: '发货说明（选填）',
      success: async (r) => {
        if (!r.confirm) return;
        try { await api.post('/api/orders/' + o.id + '/ship', { note: r.content || '' }, { loading: true }); wx.showToast({ title: '已发货', icon: 'none' }); this.fetch(); } catch (e) { /* 已提示 */ }
      }
    });
  },

  confirm(o) {
    wx.showModal({
      title: '确认收货', content: '确认已收到商品？确认后货款将从平台打给卖家。',
      success: async (r) => {
        if (!r.confirm) return;
        try { await api.post('/api/orders/' + o.id + '/confirm', {}, { loading: true }); wx.showToast({ title: '交易完成', icon: 'success' }); this.fetch(); } catch (e) { /* 已提示 */ }
      }
    });
  },

  refund(o) {
    wx.showModal({
      title: '申请退款', editable: true, placeholderText: '请填写退款原因',
      success: async (r) => {
        if (!r.confirm) return;
        try { await api.post('/api/orders/' + o.id + '/refund', { reason: r.content || '买家申请退款' }, { loading: true }); wx.showToast({ title: '已提交退款申请', icon: 'none' }); this.fetch(); } catch (e) { /* 已提示 */ }
      }
    });
  },

  decide(o, approve) {
    wx.showModal({
      title: approve ? '同意退款' : '拒绝退款',
      content: approve ? '同意后将把货款退还给买家。' : '拒绝后订单将回到「待发货」。',
      editable: !approve, placeholderText: '拒绝理由（选填）',
      success: async (r) => {
        if (!r.confirm) return;
        try { await api.post('/api/orders/' + o.id + '/refund/decide', { approve, note: r.content || '' }, { loading: true }); wx.showToast({ title: approve ? '已同意退款' : '已拒绝退款', icon: 'none' }); this.fetch(); } catch (e) { /* 已提示 */ }
      }
    });
  },

  /** 申请平台介入 */
  onIntervene() {
    if (!app.guard()) return;
    wx.showModal({
      title: '申请平台介入',
      content: '请描述你遇到的问题，客服会结合订单与聊天记录处理。',
      editable: true,
      placeholderText: '例如：卖家一直不发货 / 商品与描述不符',
      success: async (r) => {
        if (!r.confirm) return;
        if (!r.content) return wx.showToast({ title: '请填写问题描述', icon: 'none' });
        try {
          await api.post('/api/orders/' + this.data.id + '/intervene', { reason: r.content }, { loading: true });
          wx.showToast({ title: '已提交，客服会尽快处理', icon: 'none', duration: 1800 });
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  copyNo() {
    const no = this.data.order && this.data.order.orderNo;
    if (!no) return;
    wx.setClipboardData({ data: no, success: () => wx.showToast({ title: '订单号已复制', icon: 'none' }) });
  },

  goListing() { wx.navigateTo({ url: '/pages/detail/detail?id=' + this.data.order.listingId }); },

  goPeer() {
    const p = this.data.peer;
    if (!p) return;
    if (p.isAI) return app.openChat({});
    wx.navigateTo({ url: '/pages/user/user?id=' + p.id });
  },

  onReport() {
    wx.showActionSheet({
      itemList: REPORT_ITEMS,
      success: async (r) => {
        try {
          await api.post('/api/reports', {
            targetType: 'order', targetId: this.data.id,
            reason: REPORT_ITEMS[r.tapIndex], detail: ''
          });
          wx.showToast({ title: '举报已提交', icon: 'none' });
        } catch (e) { /* 已提示 */ }
      }
    });
  }
});
