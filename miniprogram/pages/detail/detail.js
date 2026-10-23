const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');
const { ZONE_MAP, TRADE_MODES, REPORT_REASONS } = require('../../utils/const');

Page({
  data: {
    statusBar: 20,
    id: 0,
    loading: true,
    listing: null,
    related: [],
    images: [],
    current: 1,
    priceText: '0',
    oldPriceText: '',
    zone: null,
    modeText: '',
    fav: false,
    want: false,
    isMine: false,
    seller: null,

    /** 底部主按钮：文案与禁用态由「商品状态 + 是否已被他人拍下」共同决定 */
    buyText: '立即购买',
    buyDisabled: false,

    /** 拼团 */
    isGroup: false,
    groups: [],
    targetCount: 0,
    autoTip: '',
    matchableId: null
  },

  onLoad(opts) {
    this.setData({ statusBar: app.globalData.statusBarHeight, id: Number(opts.id || 0) });
    this.fetch();
  },

  onShow() {
    if (this.data.loading) return;
    this.fetch();
  },

  async fetch() {
    if (!this.data.id) return;
    try {
      const res = await api.get('/api/listings/' + this.data.id);
      const l = res.listing;
      const zone = ZONE_MAP[l.zone] || null;
      // 拍下即锁：`lock` 由服务端给出（存在未完成订单时非空）
      //   lock.mine === false            → 别人拍的，按钮禁用并说明原因
      //   lock.mine === true 且 pending  → 我拍的但还没付款，按钮照常可用（去复用我那笔单）
      //   lock.mine === true 且非 pending → 我已经买过了，不能再买
      //     （原来没区分这一种：已付款后按钮仍显示「立即购买」、点进去才被服务端拒绝，
      //      提示还是「该宝贝已被你拍下，暂时无法购买」—— 自己拍的却说无法购买，自相矛盾）
      const lock = l.lock || null;
      const takenByOther = !!(lock && !lock.mine);
      const myPending = !!(lock && lock.mine && lock.status === 'pending');
      const myBought = !!(lock && lock.mine && lock.status !== 'pending');
      const buyText = l.status === 'sold' ? '已卖出'
        : l.status === 'off' ? '已下架'
          : takenByOther ? (l.tradeMode === 'group' ? '已成团' : '已被拍下')
            : myBought ? '已购买'
              : (l.tradeMode === 'group' ? '立即拼团' : '立即购买');
      this.setData({
        listing: l,
        images: (l.images || []).map((i) => api.abs(i)),
        priceText: util.fmtPrice(l.price),
        oldPriceText: l.originalPrice > l.price ? util.fmtPrice(l.originalPrice) : '',
        zone,
        modeText: TRADE_MODES[l.tradeMode] || '',
        fav: !!l.isFavorite,
        want: !!l.isWanted,
        isMine: !!l.isMine,
        // 卖家头像要转成云存储路径。
        // 种子里存的是 /static/avatars/a04.jpg 这种相对路径，
        // 不转换的话 image 会把它当相对路径请求（http://127.0.0.1:xxx/__pageframe__/static/...）
        // 从而报「Failed to load image」且头像显示空白。
        seller: l.seller ? Object.assign({}, l.seller, { avatar: api.abs(l.seller.avatar) }) : null,
        isGroup: l.tradeMode === 'group',
        // 已卖掉：商品售出，或已经被别人拍下（含未付款）
      isSoldOut: l.status === 'sold' || (lock && !lock.mine),
      buyText,
        buyDisabled: l.status !== 'on' || takenByOther || myBought,
        related: (res.related || []).map((r) => Object.assign(r, {
          cover: api.abs((r.images && r.images[0]) || ''),
          priceText: util.fmtPrice(r.price)
        })),
        loading: false
      });
      if (l.tradeMode === 'group') this.loadGroups();
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  /** 拼团信息 */
  async loadGroups() {
    try {
      const res = await api.get('/api/groupbuy/listing/' + this.data.id, null, { silent: true });
      this.setData({
        groups: (res.list || []).map((g) => Object.assign(g, {
          members: (g.members || []).map((m) => Object.assign(m, { avatar: api.abs(m.avatar) }))
        })),
        targetCount: res.targetCount || 0,
        autoTip: res.autoTip || '',
        matchableId: res.matchableId || null
      });
    } catch (e) { /* 忽略 */ }
  },

  onSwiperChange(e) { this.setData({ current: e.detail.current + 1 }); },

  previewImage(e) {
    const idx = e.currentTarget.dataset.index || 0;
    wx.previewImage({ current: this.data.images[idx], urls: this.data.images });
  },

  async onFav() {
    if (!app.guard()) return;
    try {
      const res = await api.post('/api/favorites/toggle', { targetType: 'listing', targetId: this.data.id });
      this.setData({ fav: !!res.favorited });
      wx.showToast({ title: res.favorited ? '已收藏' : '已取消收藏', icon: 'none' });
    } catch (e) { /* 已提示 */ }
  },

  async onWant() {
    if (!app.guard()) return;
    if (this.data.isMine) return wx.showToast({ title: '这是你发布的商品', icon: 'none' });
    try {
      const res = await api.post('/api/listings/' + this.data.id + '/want', {});
      this.setData({ want: !!res.wanted, 'listing.wantCount': res.wantCount });
      wx.showToast({ title: res.wanted ? '已标记想要' : '已取消', icon: 'none' });
    } catch (e) { /* 已提示 */ }
  },

  onChat() {
    if (!app.guard()) return;
    if (this.data.isMine) return wx.showToast({ title: '不能和自己聊天哦', icon: 'none' });
    app.openChat({ listingId: this.data.id, sendCard: true });
  },

  /** 立即购买（普通商品） */
  onBuy() {
    if (!app.guard()) return;
    const l = this.data.listing;
    if (!l) return;
    if (l.isMine) return wx.showToast({ title: '不能购买自己的商品', icon: 'none' });
    if (l.status !== 'on') return wx.showToast({ title: '该宝贝已下架或已售出', icon: 'none' });
    // lock 由服务端给出（存在未完成订单时非空）。
    // 按钮已是禁用样式，这里兜住「直接点进来」的情况，并把话说明白 ——
    // 关键是**自己拍下的两种情况要分开**：
    const lock = l.lock;
    if (lock) {
      if (!lock.mine) {
        return wx.showToast({
          title: lock.status === 'pending' ? '这件宝贝已经被拍下了，暂时买不到' : '这件宝贝已经卖掉了',
          icon: 'none', duration: 2200
        });
      }
      if (lock.status !== 'pending') {
        // 我已付款/待发货/已完成 → 已经买过了，别再说「无法购买」让人困惑
        return wx.showToast({
          title: '你已经拍下过这件商品了，可在「我的订单」查看进度',
          icon: 'none', duration: 2400
        });
      }
      // 我拍下但还没付款 → 去那笔订单继续付款（不再重复建单）
      return wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + lock.orderId });
    }
    wx.navigateTo({ url: '/pages/order-confirm/order-confirm?listingId=' + l.id + '&qty=1' });
  },

  /** 参加拼团（自动匹配） */
  async onJoinGroup() {
    if (!app.guard()) return;
    const l = this.data.listing;
    if (!l) return;
    if (l.isMine) return wx.showToast({ title: '不能参加自己发布的拼团', icon: 'none' });
    try {
      const res = await api.post('/api/groupbuy/join', { listingId: l.id, qty: 1 }, { loading: '匹配拼团中' });
      wx.showToast({ title: res.tip || '已加入拼团', icon: 'none', duration: 1600 });
      setTimeout(() => {
        wx.navigateTo({ url: '/pages/order-confirm/order-confirm?listingId=' + l.id + '&qty=1&orderId=' + res.orderId + '&group=1' });
      }, 900);
    } catch (e) { /* 已提示 */ }
  },

  goGroup(e) {
    wx.navigateTo({ url: '/pages/group-detail/group-detail?id=' + e.currentTarget.dataset.id });
  },

  goSeller() {
    const s = this.data.seller;
    if (!s) return;
    if (s.isAI) return app.openChat({ peerId: s.id });
    wx.navigateTo({ url: '/pages/user/user?id=' + s.id });
  },

  goRelated(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  onReport() {
    if (!app.guard()) return;
    wx.showActionSheet({
      itemList: REPORT_REASONS,
      success: async (r) => {
        try {
          await api.post('/api/reports', {
            targetType: 'listing', targetId: this.data.id,
            reason: REPORT_REASONS[r.tapIndex], detail: ''
          });
          wx.showToast({ title: '举报已提交，我们会尽快处理', icon: 'none' });
        } catch (e) { /* 已提示 */ }
      },
      // 必须写 fail：否则一旦调用失败（例如 itemList 超限）界面毫无反应，
      // 排查时只能靠猜。取消/点蒙层也会走 fail，要排掉，别误报成错误。
      fail: (res) => {
        const msg = (res && res.errMsg) || '';
        if (/cancel/i.test(msg)) return;
        wx.showToast({ title: '打开举报选项失败，请重试', icon: 'none' });
      }
    });
  },

  onManage() {
    const l = this.data.listing;
    if (!l) return;
    const isOn = l.status === 'on';
    wx.showActionSheet({
      itemList: [isOn ? '下架该宝贝' : '重新上架', '删除该宝贝'],
      success: async (r) => {
        try {
          if (r.tapIndex === 0) {
            await api.patch('/api/listings/' + l.id, { status: isOn ? 'off' : 'on' }, { loading: true });
            wx.showToast({ title: isOn ? '已下架' : '已上架', icon: 'none' });
          } else {
            await api.del('/api/listings/' + l.id, {}, { loading: true });
            wx.showToast({ title: '已删除', icon: 'none' });
            setTimeout(() => wx.navigateBack(), 600);
            return;
          }
          this.fetch();
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  goZone() {
    if (!this.data.zone) return;
    wx.navigateTo({ url: '/pages/zone/zone?zone=' + this.data.zone.code });
  },

  onShareAppMessage() {
    const l = this.data.listing || {};
    return {
      title: this.data.isGroup
        ? '【拼团】' + l.title + ' 还差 ' + Math.max(0, this.data.targetCount - this.data.groups.reduce((s, g) => s + (g.paidCount || 0), 0)) + ' 人成团'
        : (l.title || '科贸小鱼好物'),
      path: '/pages/detail/detail?id=' + l.id,
      imageUrl: this.data.images[0] || ''
    };
  }
});
