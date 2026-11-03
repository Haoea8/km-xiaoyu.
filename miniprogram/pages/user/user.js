/**
 * 用户主页：资料 + 在售宝贝 + 关注 + 聊一聊
 * 参数：id
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

Page({
  data: {
    statusBar: 20,
    id: 0,
    loading: true,
    user: null,
    avatarAbs: '',
    listings: [],
    /** 后端返回的全部（在售 + 已售出 + 本人已下架）；tab 切换时从它挑，避免重复请求 */
    allListings: [],
    isFollowed: false,
    isMe: false,
    stats: null,
    tab: 'selling'
  },

  onLoad(opts) {
    this.setData({
      statusBar: app.globalData.statusBarHeight,
      id: Number(opts.id || 0),
      tab: opts.tab === 'all' ? 'all' : 'selling'
    });
    this.fetch();
  },

  /**
   * 从商品详情页返回时重新拉一次。
   *
   * 之前只有 onLoad：在详情页「重新上架 / 下架 / 删除」后返回主页，列表还是进来时
   * 的旧数据 —— 必须先下拉刷新才能看到变化。这就是「上架了要在主页刷新才出现」。
   * 首次 onShow 时 user 还是 null（fetch 尚未回），不会重复请求。
   */
  onShow() {
    if (this.data.user) this.fetch();
  },

  onPullDownRefresh() { this.fetch().then(() => wx.stopPullDownRefresh()); },

  async fetch() {
    if (!this.data.id) return;
    try {
      const res = await api.get('/api/users/' + this.data.id);
      const u = res.user;
      const myId = app.globalData.user && app.globalData.user.id;
      const raw = (res.listings || []).map((l) => Object.assign(l, {
        cover: api.abs((l.images && l.images[0]) || ''),
        priceText: util.fmtPrice(l.price)
      }));
      this.setData({
        user: u,
        avatarAbs: api.abs(u.avatar || ''),
        stats: u.stats || {},
        allListings: raw,
        listings: this.pickList(raw, this.data.tab),
        isFollowed: !!res.isFollowed,
        isMe: myId === u.id,
        loading: false
      });
    } catch (e) {
      this.setData({ loading: false });
      setTimeout(() => wx.navigateBack(), 900);
    }
  },

  /**
   * 点「动态」→ 看 TA 发过什么（圈子帖子 / 校园墙 / 学习资料 聚合成一条时间线）。
   * 之前这个数字只是个数字，点了没反应 —— 用户的原话是
   * 「至少能知道发了什么」。
   */
  goDynamics(e) {
    const uid = Number(e.currentTarget.dataset.uid) || this.data.id;
    if (!uid) return;
    if (!Number((this.data.stats || {}).posts || 0)) {
      wx.showToast({ title: '还没有发过动态', icon: 'none' });
      return;
    }
    const name = e.currentTarget.dataset.name || (this.data.user && this.data.user.nickname) || '';
    wx.navigateTo({
      url: '/pages/my-dynamics/my-dynamics?id=' + uid + '&name=' + encodeURIComponent(name)
    });
  },

  async onFollow() {
    if (!app.guard()) return;
    if (this.data.isMe) return wx.showToast({ title: '不能关注自己', icon: 'none' });
    try {
      const res = await api.post('/api/users/' + this.data.id + '/follow', {}, { silent: true });
      this.setData({
        isFollowed: res.followed,
        'stats.followers': (this.data.stats.followers || 0) + (res.followed ? 1 : -1)
      });
      wx.showToast({ title: res.followed ? '已关注' : '已取消关注', icon: 'none' });
    } catch (e) { /* 已提示 */ }
  },

  chat() {
    if (!app.guard()) return;
    if (this.data.isMe) return wx.showToast({ title: '这是你自己的主页', icon: 'none' });
    app.openChat({ peerId: this.data.id });
  },

  goDetail(e) { wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id }); },

  /**
   * 按 tab 挑列表。
   *   selling —— 只显示真正在售（status=on 且未被拍下/卖出）
   *   all     —— 在售 → 已售出（含被拍下）→ 已下架，依次往下；同段内按发布时间倒序
   *              （已下架的永远压在最下面，重新上架后会自己回到上面的在售段）
   */
  pickList(all, tab) {
    const arr = all || [];
    const takenOf = (x) => x.status === 'sold' || x.taken;
    if (tab !== 'all') return arr.filter((x) => x.status === 'on' && !takenOf(x));
    const rank = (x) => (x.status === 'off' ? 2 : takenOf(x) ? 1 : 0);
    return arr.slice().sort((a, b) =>
      rank(a) - rank(b) || (b.createdAt || 0) - (a.createdAt || 0));
  },

  onTab(e) {
    const k = e.currentTarget.dataset.k === 'all' ? 'all' : 'selling';
    this.setData({ tab: k, listings: this.pickList(this.data.allListings, k) });
  },

  copyUid() {
    wx.setClipboardData({ data: 'UID ' + this.data.id, success: () => wx.showToast({ title: '已复制', icon: 'none' }) });
  },

  goMyGroups() {
    if (!app.guard()) return;
    wx.navigateTo({ url: '/pages/my-groups/my-groups' });
  },

  onReport() {
    if (!app.guard() || this.data.isMe) return;
    wx.showActionSheet({
      itemList: ['虚假信息', '涉嫌诈骗', '辱骂骚扰', '发送垃圾广告', '其他违规'],
      success: async (r) => {
        try {
          await api.post('/api/reports', {
            targetType: 'user', targetId: this.data.id,
            reason: ['虚假信息', '涉嫌诈骗', '辱骂骚扰', '发送垃圾广告', '其他违规'][r.tapIndex], detail: ''
          });
          wx.showToast({ title: '举报已提交', icon: 'none' });
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  onShareAppMessage() {
    const u = this.data.user || {};
    return { title: (u.nickname || '同学') + ' 的校园主页', path: '/pages/user/user?id=' + this.data.id };
  }
});
