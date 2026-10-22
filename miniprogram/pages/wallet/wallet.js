/**
 * 我的钱包：余额 + 充值 + 交易明细
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

const AMOUNTS = [1000, 2000, 5000, 10000, 20000, 50000];
const TYPE_TEXT = {
  recharge: { text: '充值', sign: '+' },
  pay: { text: '购买商品', sign: '-' },
  pay_wx: { text: '微信支付（演示）', sign: '-' },
  income: { text: '卖出收入', sign: '+' },
  refund: { text: '退款', sign: '+' },
  refund_wx: { text: '微信退款（演示）', sign: '+' },
  withdraw: { text: '提现', sign: '-' }
};

Page({
  data: {
    loading: true,
    balance: 0,
    balanceText: '0.00',
    amounts: AMOUNTS.map((a) => ({ fen: a, yuan: a / 100 })),
    amountIndex: 2,
    customYuan: '',
    transactions: [],
    showRecharge: false
  },

  onLoad(opts) {
    if (!app.guard()) return;
    if (opts.recharge === '1') this.setData({ showRecharge: true });
  },

  /**
   * 每次回到本页都重新拉一次。
   *
   * ⚠️ 原来只在 onLoad 拉取：从下单/买家付款流程返回钱包时，
   * 页面还是旧的（余额与明细都不更新），用户看到的就是「充了钱没同步」。
   * 放在 onShow 里既覆盖首次进入（onLoad 之后必然触发一次 onShow），
   * 也覆盖从其它页面返回的场景。
   */
  onShow() {
    if (!app.guard()) return;
    this.fetch();
  },

  onPullDownRefresh() { this.fetch().then(() => wx.stopPullDownRefresh()); },

  async fetch() {
    try {
      const res = await api.get('/api/wallet');
      this.setData({
        balance: res.balance || 0,
        balanceText: util.fmtMoney(res.balance || 0),
        transactions: (res.transactions || []).map((t) => {
          const meta = TYPE_TEXT[t.type] || { text: t.type, sign: '' };
          return Object.assign(t, {
            typeText: meta.text,
            sign: t.amount >= 0 ? '+' : '-',
            amountText: util.fmtMoney(Math.abs(t.amount)),
            positive: t.amount >= 0
          });
        }),
        loading: false
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  openRecharge() { this.setData({ showRecharge: true }); },
  closeRecharge() { this.setData({ showRecharge: false }); },
  noop() { /* 阻止冒泡 */ },

  onAmount(e) { this.setData({ amountIndex: Number(e.currentTarget.dataset.i), customYuan: '' }); },
  onCustom(e) { this.setData({ customYuan: e.detail.value }); },

  async doRecharge() {
    let fen = Number(this.data.amounts[this.data.amountIndex].fen);
    if (this.data.customYuan) {
      fen = Math.round(Number(this.data.customYuan) * 100);
    }
    if (!(fen > 0)) return wx.showToast({ title: '请输入有效金额', icon: 'none' });
    if (fen > 500000) return wx.showToast({ title: '单次最多充值 5000 元', icon: 'none' });
    try {
      await api.post('/api/wallet/recharge', { amount: fen }, { loading: '充值中' });
      wx.showToast({ title: '充值成功', icon: 'success' });
      this.setData({ showRecharge: false, customYuan: '' });
      this.fetch();
      app.bootstrap();
    } catch (e) { /* 已提示 */ }
  },

  onWithdraw() {
    wx.showModal({
      title: '提现',
      content: '演示环境暂不支持真实提现。余额可用于平台内购买商品，或提现至微信零钱（正式版）。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  onShareAppMessage() { return { title: '科贸小鱼', path: '/pages/index/index' }; }
});
