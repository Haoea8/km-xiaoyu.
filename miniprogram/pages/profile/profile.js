/**
 * 我的：个人中心
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

Page({
  data: {
    statusBar: 20,
    logged: false,
    user: null,
    stats: { published: 0, sold: 0, bought: 0, favorites: 0, posts: 0, following: 0, followers: 0 },
    balanceText: '0.00',
    unread: 0,
    orders: { pending: 0, paid: 0, shipped: 0, refunding: 0 }
  },

  onLoad() {
    this.setData({ statusBar: app.globalData.statusBarHeight });
    this.onUser = (u) => this.applyUser(u);
    app.on('user', this.onUser);
    app.on('unread', (n) => this.setData({ unread: n || 0 }));
  },

  onUnload() { app.off('user', this.onUser); },

  onShow() {
    app.syncTabBar(this, 'mine');
    const logged = !!api.token();
    this.setData({ logged, unread: typeof app.totalUnread === 'function' ? app.totalUnread() : (app.globalData.unread || 0) });
    if (!logged) return;
    this.fetch();
  },

  onPullDownRefresh() { this.fetch().then(() => wx.stopPullDownRefresh()); },

  async fetch() {
    try {
      const res = await api.get('/api/me');
      this.applyUser(res.user);
    } catch (e) { /* 忽略 */ }
    // 订单角标
    try {
      const o = await api.get('/api/orders?role=buyer&status=ongoing', null, { silent: true });
      const items = o.items || [];
      this.setData({
        orders: {
          pending: items.filter((x) => x.status === 'pending').length,
          paid: items.filter((x) => x.status === 'paid').length,
          shipped: items.filter((x) => x.status === 'shipped').length,
          refunding: items.filter((x) => x.status === 'refunding').length
        }
      });
    } catch (e) { /* 忽略 */ }
  },

  applyUser(u) {
    if (!u) { this.setData({ user: null }); return; }
    this.setData({
      user: Object.assign({}, u, { avatarAbs: api.abs(u.avatar || '') }),
      stats: u.stats || this.data.stats,
      balanceText: util.fmtMoney(u.balance || 0)
    });
  },

  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },

  goOrders(e) {
    if (!app.guard()) return;
    const role = e.currentTarget.dataset.role || 'buyer';
    const status = e.currentTarget.dataset.status || 'all';
    wx.navigateTo({ url: '/pages/orders/orders?role=' + role + '&status=' + status });
  },

  goWallet() { if (!app.guard()) return; wx.navigateTo({ url: '/pages/wallet/wallet' }); },
  goCollection() { if (!app.guard()) return; wx.navigateTo({ url: '/pages/collection/collection' }); },
  goMyGroups() { if (!app.guard()) return; wx.navigateTo({ url: '/pages/my-groups/my-groups' }); },
  goMyResources() { if (!app.guard()) return; wx.navigateTo({ url: '/pages/resource/resource?mine=1' }); },
  goAddress() { if (!app.guard()) return; wx.navigateTo({ url: '/pages/address/address' }); },
  goSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); },
  goUser() {
    if (!this.data.user) return this.goLogin();
    wx.navigateTo({ url: '/pages/user/user?id=' + this.data.user.id });
  },
  /** 我的动态：帖子 / 校园墙 / 学习资料 聚合页 */
  goDynamics() {
    const u = this.data.user || {};
    wx.navigateTo({ url: '/pages/my-dynamics/my-dynamics?id=' + (u.id || '') + '&name=' + encodeURIComponent(u.nickname || '') });
  },

  goMyListings() {
    if (!app.guard()) return;
    wx.navigateTo({ url: '/pages/user/user?id=' + (this.data.user && this.data.user.id) + '&tab=selling' });
  },
  goPublish() { if (!app.guard()) return; wx.navigateTo({ url: '/pages/publish/publish' }); },
  goChat() { if (!app.guard()) return; wx.switchTab({ url: '/pages/message/message' }); },
  goWall() { wx.navigateTo({ url: '/pages/wall/wall' }); },
  goResource() { wx.navigateTo({ url: '/pages/resource/resource' }); },

  copyUid() {
    const u = this.data.user;
    if (!u) return;
    wx.setClipboardData({ data: 'UID ' + u.id, success: () => wx.showToast({ title: '已复制', icon: 'none' }) });
  },

  onShareAppMessage() {
    return { title: '科贸小鱼 · 校园生活服务与二手交易平台', path: '/pages/index/index' };
  }
});
