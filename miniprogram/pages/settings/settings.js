/**
 * 设置：个人资料 / 缓存 / 关于 / 退出登录
 */
const app = getApp();
const api = require('../../utils/api');
const { CLOUD_ENV } = require('../../utils/config');
const { COLLEGES, GRADES } = require('../../utils/const');

const GENDERS = ['未设置', '男', '女'];

Page({
  data: {
    logged: false,
    user: null,
    avatarAbs: '',
    colleges: COLLEGES,
    grades: GRADES,
    genders: GENDERS,
    collegeIndex: 0,
    gradeIndex: 0,
    genderIndex: 0,

    nickname: '',
    bio: '',
    saving: false,
    cacheSize: '',

    version: '1.0.0',
    envId: CLOUD_ENV,
    uploading: false
  },

  onLoad() {
    this.setData({ logged: !!api.token() });
    this.load();
    this.calcCache();
  },

  onShow() {
    if (this.data.logged && !this.data.user) this.load();
  },

  async load() {
    try {
      const res = await api.get('/api/me');
      this.applyUser(res.user);
    } catch (e) { /* 忽略 */ }
  },

  applyUser(u) {
    if (!u) return;
    const ci = COLLEGES.indexOf(u.college);
    const gi = GRADES.indexOf(u.grade);
    const gen = u.gender === 1 ? 1 : u.gender === 2 ? 2 : 0;
    this.setData({
      user: u,
      avatarAbs: api.abs(u.avatar || ''),
      nickname: u.nickname || '',
      bio: u.bio || '',
      collegeIndex: ci > -1 ? ci : 0,
      gradeIndex: gi > -1 ? gi : 0,
      genderIndex: gen
    });
    app.setUser(u);
  },

  onNickname(e) { this.setData({ nickname: e.detail.value }); },
  onBio(e) { this.setData({ bio: e.detail.value }); },
  onCollege(e) { this.setData({ collegeIndex: Number(e.detail.value) }); },
  onGrade(e) { this.setData({ gradeIndex: Number(e.detail.value) }); },
  onGender(e) { this.setData({ genderIndex: Number(e.detail.value) }); },

  /**
   * 一键使用【微信头像】（微信「头像昵称填写能力」）。
   *
   * 为什么需要它：`wx.getUserProfile` 已被微信回收（2022-10-25 起），
   * 调用时仍会弹授权框，但**只返回「微信用户」+ 灰色默认头像** —— 拿不到真实头像。
   * 官方指定的替代方案就是 `open-type="chooseAvatar"`（本方法）+ `input type="nickname"`。
   *
   * 注意：`e.detail.avatarUrl` 是**临时文件路径**（wxfile:// 开头），
   * 必须上传到云存储才能持久化，否则小程序重启后头像就没了。
   * 所以这里直接复用与「从相册选」相同的上传流程。
   */
  /**
   * 头像上传成功后的统一收尾。
   *
   * ⚠️ 这里**故意不再调 this.load()**（以前两处都调了，就是「要传两次才生效」的原因）：
   *    /api/me 读的是**实例内存快照**。上传+保存可能落在云函数实例 A，
   *    紧接着的这次 GET 落到实例 B —— B 的快照还停在旧头像，
   *    applyUser() 会把刚设好的 avatarAbs **覆盖回旧图**，
   *    用户看到的就是「第一次传了没反应，得再传一次」。
   *
   *    正确做法：直接用 PATCH 的返回值落地（服务端返回的就是刚写进去的那份），
   *    页面立刻变新，其余页面靠 app.setUser() 同步。
   */
  afterAvatar(fileID, r, tip) {
    const u = Object.assign({}, this.data.user || {}, { avatar: fileID }, (r && r.user) || {});
    if (!u.avatar) u.avatar = fileID;
    this.applyUser(u);
    wx.hideLoading();
    this.setData({ uploading: false });
    wx.showToast({ title: tip, icon: 'success' });
  },

  async onChooseAvatar(e) {
    const url = e.detail && e.detail.avatarUrl;
    if (!url) return;
    if (!app.guard()) return;
    if (this.data.uploading) return;
    this.setData({ uploading: true });
    wx.showLoading({ title: '上传头像', mask: true });
    try {
      const fileID = await api.upload(url, 'avatars');
      const r = await api.patch('/api/me', { avatar: fileID }, { silent: true });
      this.afterAvatar(fileID, r, '已使用微信头像');
    } catch (err) {
      wx.hideLoading();
      this.setData({ uploading: false });
      wx.showToast({ title: err.message || '上传失败', icon: 'none' });
    }
  },

  /** 更换头像 → 云存储 */
  changeAvatar() {
    if (!app.guard()) return;
    if (this.data.uploading) return;      // 防连点：两次上传会互相覆盖
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'],
      success: async (r) => {
        const path = r.tempFiles[0].tempFilePath;
        this.setData({ uploading: true });
        wx.showLoading({ title: '上传头像', mask: true });
        try {
          const fileID = await api.upload(path, 'avatars');
          const res = await api.patch('/api/me', { avatar: fileID }, { silent: true });
          this.afterAvatar(fileID, res, '头像已更新');
        } catch (e) {
          wx.hideLoading();
          this.setData({ uploading: false });
          wx.showToast({ title: e.message || '上传失败', icon: 'none' });
        }
      }
    });
  },

  async onSave() {
    if (!app.guard()) return;
    const nickname = String(this.data.nickname || '').trim();
    if (!nickname) return wx.showToast({ title: '昵称不能为空', icon: 'none' });
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      await api.patch('/api/me', {
        nickname,
        bio: this.data.bio,
        college: COLLEGES[this.data.collegeIndex],
        grade: GRADES[this.data.gradeIndex],
        gender: this.data.genderIndex
      }, { loading: true });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ saving: false });
      this.load();
    } catch (e) {
      this.setData({ saving: false });
    }
  },

  calcCache() {
    try {
      const info = wx.getStorageInfoSync();
      this.setData({ cacheSize: (info.currentSize || 0) + ' KB' });
    } catch (e) { /* 忽略 */ }
  },

  clearCache() {
    wx.showModal({
      title: '清除缓存',
      content: '将清除本地缓存（不会退出登录，也不会删除你发布的内容）。',
      success: (r) => {
        if (!r.confirm) return;
        try {
          const token = api.token();
          wx.clearStorageSync();
          if (token) api.setToken(token);
          this.calcCache();
          wx.showToast({ title: '已清除', icon: 'success' });
        } catch (e) {
          wx.showToast({ title: '清除失败', icon: 'none' });
        }
      }
    });
  },

  about() {
    wx.showModal({
      title: '关于科贸小鱼',
      content: '校园生活服务与二手交易综合平台\n\n传智杯第九届 AI 微信小程序开发挑战赛作品\n基于微信云开发（云函数 + 云数据库 + 云存储）\n\n版本 ' + this.data.version,
      showCancel: false,
      confirmText: '知道了'
    });
  },

  showEnv() {
    wx.setClipboardData({
      data: this.data.envId,
      success: () => wx.showToast({ title: '环境 ID 已复制', icon: 'none' })
    });
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      confirmText: '退出',
      success: async (r) => {
        if (!r.confirm) return;
        await app.logout();
        wx.showToast({ title: '已退出登录', icon: 'none' });
        setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 700);
      }
    });
  },

  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },

  copyUid() {
    const u = this.data.user;
    if (!u) return;
    wx.setClipboardData({ data: 'UID ' + u.id, success: () => wx.showToast({ title: '已复制', icon: 'none' }) });
  }
});
