/**
 * 登录：微信授权 + 演示账号一键登录
 */
const app = getApp();
const api = require('../../utils/api');

Page({
  data: {
    statusBar: 20,
    loading: false,
    accounts: [],
    agree: true
  },

  onLoad() {
    this.setData({ statusBar: app.globalData.statusBarHeight });
    this.loadAccounts();
  },

  async loadAccounts() {
    try {
      const res = await api.get('/api/test-accounts', null, { silent: true });
      this.setData({
        accounts: (res.accounts || []).map((a) => Object.assign(a, { avatar: api.abs(a.avatar) }))
      });
    } catch (e) { /* 忽略 */ }
  },

  /** 微信授权登录 */
  async onWechat() {
    if (!this.data.agree) return wx.showToast({ title: '请先同意用户协议', icon: 'none' });
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      /**
       * ⚠️ 不再调用 wx.getUserProfile 去取昵称头像。
       *
       * 微信已于 2022-10-25 **回收**该接口：调用时仍会弹出授权框，
       * 但只返回「微信用户」+ 灰色默认头像 —— 拿不到真实昵称头像。
       * 留着它只会造成「我明明授权了，怎么还是『微信用户』」的困惑
       *（实测多人测试时每个人都是「微信用户xxxx」，就是这个原因）。
       *
       * 官方替代方案是「头像昵称填写能力」，已接到 pages/settings：
       *   点「头像」→ 一键带入微信头像；昵称输入框键盘上方有一键用微信昵称。
       * 所以这里只按 openid 建号，昵称用默认值，之后再让用户去设置里完善。
       */
      const res = await api.post('/api/login', { nickname: '', avatar: '' }, { silent: true });
      this.finish(res);
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '登录失败', icon: 'none' });
    }
  },

  /** 演示账号一键登录 */
  async onAccount(e) {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const res = await api.post('/api/login', { testUserId: Number(e.currentTarget.dataset.id) }, { silent: true });
      this.finish(res);
    } catch (err) {
      this.setData({ loading: false });
      wx.showToast({ title: err.message || '登录失败', icon: 'none' });
    }
  },

  async finish(res) {
    api.setToken(res.token);
    await app.afterLogin(res.user);
    wx.showToast({ title: res.isNew ? '欢迎加入科贸小鱼' : '登录成功', icon: 'none', duration: 800 });
    setTimeout(() => {
      const pages = getCurrentPages();
      if (pages.length > 1) wx.navigateBack();
      else wx.switchTab({ url: '/pages/index/index' });
    }, 800);
  },

  toggleAgree() { this.setData({ agree: !this.data.agree }); },

  showAgree() {
    wx.showModal({
      title: '用户协议与隐私政策',
      content: '本平台为校园二手交易与生活服务平台。我们仅收集必要的账号信息用于交易与沟通，不会向第三方出售你的个人信息。请勿脱离平台私下转账。',
      showCancel: false,
      confirmText: '我知道了'
    });
  },

  onSkip() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/index/index' });
  }
});
