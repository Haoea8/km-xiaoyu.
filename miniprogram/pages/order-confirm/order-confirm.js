/**
 * 确认订单 → 提交 → 支付
 * 参数：listingId, qty, orderId（拼团已在服务端建单时传入）, group=1
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');
const { ZONE_MAP, TRADE_MODES } = require('../../utils/const');

Page({
  data: {
    loading: true,
    submitting: false,

    listing: null,
    images: [],
    zoneText: '',
    modeText: '',
    unitPriceText: '0',
    originalText: '',

    qty: 1,
    isPreOrder: false,
    presetOrderId: 0,
    isGroup: false,
    groupInfo: '',

    tradeMethods: [],
    tradeMethod: '',
    remark: '',

    goodsText: '0.00',
    totalText: '0.00',
    totalFen: 0,

    balanceFen: 0,
    balanceText: '0.00',
    payMethod: 'balance'
  },

  onLoad(opts) {
    this.listingId = Number(opts.listingId || 0);
    const qty = Math.max(1, Number(opts.qty || 1));
    const presetOrderId = Number(opts.orderId || 0);
    this.setData({
      qty,
      isPreOrder: !!presetOrderId,
      presetOrderId,
      isGroup: opts.group === '1'
    });
    if (!this.listingId) return wx.showToast({ title: '缺少商品信息', icon: 'none' });
    this.fetch();
  },

  async fetch() {
    try {
      const tasks = [
        api.get('/api/listings/' + this.listingId),
        api.get('/api/wallet', null, { silent: true })
      ];
      const [res, wallet] = await Promise.all(tasks);
      const l = res.listing;
      const zone = ZONE_MAP[l.zone] || null;
      const isGroup = l.tradeMode === 'group';
      const methods = (l.tradeMethods && l.tradeMethods.length ? l.tradeMethods : ['校内面交']).slice();

      // 拼团预建单：用订单快照保证金额一致
      let pre = null;
      if (this.data.isPreOrder && this.data.presetOrderId) {
        try {
          const or = await api.get('/api/orders/' + this.data.presetOrderId, null, { silent: true });
          pre = or.order;
        } catch (e) { /* 忽略 */ }
      }

      this.setData({
        listing: l,
        images: (l.images || []).map(api.abs),
        zoneText: zone ? zone.name : '',
        modeText: TRADE_MODES[l.tradeMode] || '',
        unitPriceText: util.fmtPrice(l.price),
        originalText: l.originalPrice > l.price ? util.fmtPrice(l.originalPrice) : '',
        isGroup,
        groupInfo: isGroup
          ? ((l.attrs && l.attrs['成团人数']) || '') + (l.attrs && l.attrs['截止'] ? ' · ' + l.attrs['截止'] + '截止' : '')
          : '',
        tradeMethods: methods,
        tradeMethod: (pre && pre.tradeMethod) || methods[0],
        remark: (pre && pre.remark) || '',
        balanceFen: wallet.balance || 0,
        balanceText: util.fmtMoney(wallet.balance || 0),
        loading: false
      });
      this.calc();
    } catch (e) {
      this.setData({ loading: false });
      // 原来这里**静默** 800ms 后返回上一页：用户只看到页面一闪而过，
      // 不知道发生了什么，感觉像「莫名跳到了别的页面」。
      // 先把原因说出来，再返回。
      wx.showToast({ title: e.message || '商品信息获取失败', icon: 'none', duration: 1800 });
      setTimeout(() => wx.navigateBack(), 1100);
    }
  },

  calc() {
    const l = this.data.listing;
    if (!l) return;
    const fen = l.price * this.data.qty;
    this.setData({ totalFen: fen, goodsText: util.fmtMoney(fen), totalText: util.fmtMoney(fen) });
  },

  onQty(e) {
    const d = Number(e.currentTarget.dataset.delta || 0);
    let q = this.data.qty + d;
    q = Math.max(1, Math.min(99, q));
    this.setData({ qty: q });
    this.calc();
  },

  onQtyInput(e) {
    const v = String(e.detail.value || '').replace(/\D/g, '');
    const q = v ? Math.max(1, Math.min(99, Number(v))) : 1;
    this.setData({ qty: q });
    this.calc();
  },

  onMethod(e) { this.setData({ tradeMethod: e.currentTarget.dataset.v }); },

  onPay(e) {
    const m = e.currentTarget.dataset.v;
    if (m === 'balance' && this.data.balanceFen < this.data.totalFen) {
      return wx.showModal({
        title: '余额不足',
        content: '当前余额 ¥' + this.data.balanceText + '，还差 ¥' + util.fmtMoney(this.data.totalFen - this.data.balanceFen) + '。是否先去充值？',
        confirmText: '去充值',
        success: (r) => { if (r.confirm) wx.navigateTo({ url: '/pages/wallet/wallet?recharge=1' }); }
      });
    }
    this.setData({ payMethod: m });
  },

  onRemark(e) { this.data.remark = e.detail.value; },

  async onSubmit() {
    if (this.data.submitting) return;
    if (!app.guard()) return;
    this.setData({ submitting: true });
    wx.showLoading({ title: '正在创建订单', mask: true });
    try {
      let orderId = this.data.presetOrderId;
      if (!orderId) {
        const created = await api.post('/api/orders', {
          listingId: this.listingId,
          qty: this.data.qty,
          tradeMethod: this.data.tradeMethod,
          remark: this.data.remark
        }, { silent: true });
        orderId = created.order.id;
        // ⚠️ 立刻记下 orderId：若用户随后取消支付，回来重试时要复用这笔单，
        // 否则会再建一笔 —— 同一商品两笔订单（一笔已付、一笔永远待付款）。
        this.setData({ presetOrderId: orderId, isPreOrder: true });
      }
      wx.hideLoading();
      /**
       * 只建单，不在这里扣款。
       *
       * 原来这里是「建单 → 立即支付」两步连做，结果订单从不下车到「待付款」，
       * 「待付款」列表永远空着、也就没有作用；用户也没有「确认支付」的机会，
       * 点一下钱就出去了。现在改为：
       *   建单 → 跳订单详情（状态=待付款）→ 用户在详情里点「立即支付」并二次确认
       * 取消支付时订单就停在待付款，可以去列表里继续付或取消。
       */
      wx.showToast({ title: '订单已创建，请完成支付', icon: 'none', duration: 1200 });
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/order-detail/order-detail?id=' + orderId + '&pending=1' });
      }, 900);
    } catch (e) {
      wx.hideLoading();
      this.setData({ submitting: false });
      wx.showToast({ title: e.message || '下单失败', icon: 'none' });
    }
  },

  goDetail() { wx.navigateTo({ url: '/pages/detail/detail?id=' + this.listingId }); },

  goChat() {
    if (!this.data.listing) return;
    app.openChat({ listingId: this.listingId, sendCard: true });
  }
});
