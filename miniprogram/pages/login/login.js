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
    // 合规要求：协议必须由用户主动勾选，不得默认同意
    agree: false
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
    if (!this.data.agree) return wx.showToast({ title: '请先同意用户协议', icon: 'none' });
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
    /**
     * 协议摘要：分条写，便于阅读。
     * 说明：本小程序未接入在线支付，交易在线下当面完成，故第 ④ 条明确平台边界与免责。
     */
    const content = [
      '本小程序为第九届传智杯参赛作品，仅供学习交流与校内小范围体验，非商业运营。',
      '① 收集：微信昵称、头像、你主动发布的内容',
      '② 用途：账号识别与内容展示，数据存于微信云开发',
      '③ 权利：可随时删除自己发布的内容',
      '④ 边界：本平台现阶段仅提供信息展示与沟通工具，不参与交易、不经手资金、不对物品质量与真伪作担保；在线交易等功能待完善后另行开放。现阶段交易须线下当面完成，请自行核实对方身份与物品状况，风险与纠纷由双方自行承担。'
    ].join('\n');
    wx.showModal({
      title: '用户协议与隐私政策',
      content,
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
