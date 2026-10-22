/**
 * 拼团详情：进度 + 成员 + 邀请 + 参团
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

Page({
  data: {
    id: 0,
    loading: true,
    group: null,
    listing: null,
    cover: '',
    priceText: '0',
    members: [],
    percent: 0,
    isMine: false,
    minePaid: false,
    canJoin: false,
    myOrderId: null
  },

  onLoad(opts) {
    this.setData({ id: Number(opts.id || 0) });
    this.fetch();
  },

  onShow() {
    if (this.data.loading) return;
    this.fetch();
  },

  onPullDownRefresh() { this.fetch().then(() => wx.stopPullDownRefresh()); },

  async fetch() {
    if (!this.data.id) return;
    try {
      const res = await api.get('/api/groupbuy/' + this.data.id);
      const g = res.group;
      const l = g.listing || {};
      const percent = Math.min(100, Math.round((g.paidCount / Math.max(1, g.targetCount)) * 100));
      this.setData({
        group: g,
        listing: l,
        cover: api.abs(l.image || ''),
        priceText: util.fmtPrice(l.price || 0),
        members: (g.members || []).map((m) => Object.assign(m, { avatar: api.abs(m.avatar) })),
        percent,
        isMine: g.isMine,
        minePaid: g.minePaid,
        myOrderId: g.myOrderId,
        canJoin: g.status === 'open' && !g.isMine,
        loading: false
      });
    } catch (e) {
      this.setData({ loading: false });
      setTimeout(() => wx.navigateBack(), 900);
    }
  },

  async onJoin() {
    if (!app.guard()) return;
    const l = this.data.listing;
    if (!l) return;
    try {
      const res = await api.post('/api/groupbuy/join', { listingId: l.id, qty: 1 }, { loading: '占位中' });
      wx.showToast({ title: res.tip || '已加入', icon: 'none', duration: 1500 });
      setTimeout(() => {
        wx.navigateTo({ url: '/pages/order-confirm/order-confirm?listingId=' + l.id + '&qty=1&orderId=' + res.orderId + '&group=1' });
      }, 800);
    } catch (e) { /* 已提示 */ }
  },

  onPay() {
    if (!this.data.myOrderId) return;
    wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + this.data.myOrderId });
  },

  onQuit() {
    wx.showModal({
      title: '退出拼团',
      content: '退出后你将失去这个团的位置，确定继续？',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await api.post('/api/groupbuy/' + this.data.id + '/quit', {}, { loading: true });
          wx.showToast({ title: '已退出拼团', icon: 'none' });
          this.fetch();
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  goListing() {
    if (!this.data.listing) return;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + this.data.listing.id });
  },

  goUser(e) {
    const uid = Number(e.currentTarget.dataset.uid || 0);
    if (!uid) return;
    if (uid === (app.globalData.user && app.globalData.user.id)) return;
    wx.navigateTo({ url: '/pages/user/user?id=' + uid });
  },

  copyTip() {
    const g = this.data.group;
    if (!g) return;
    const text = '快来和我一起拼「' + (this.data.listing ? this.data.listing.title : '') + '」，还差 ' + g.needCount + ' 人成团！';
    wx.setClipboardData({ data: text, success: () => wx.showToast({ title: '文案已复制', icon: 'none' }) });
  },

  onShareAppMessage() {
    const g = this.data.group || {};
    return {
      title: '还差 ' + (g.needCount || 0) + ' 人成团！' + (this.data.listing ? this.data.listing.title : ''),
      path: '/pages/group-detail/group-detail?id=' + g.id,
      imageUrl: this.data.cover
    };
  }
});
