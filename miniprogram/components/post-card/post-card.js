const api = require('../../utils/api');
const util = require('../../utils/util');

Component({
  options: { addGlobalClass: true },
  properties: {
    post: { type: Object, value: null },
    /** 是否显示所属圈子标签 */
    showCircle: { type: Boolean, value: true },
    /** 是否可点击进入详情 */
    clickable: { type: Boolean, value: true }
  },
  data: {
    images: [],
    gridSize: 220,
    /** 作者头像（已转成云存储路径）。wxml 直接用 post.author.avatar 会是
        /static/avatars/xx.jpg 这类相对路径，必须过 api.abs。 */
    authorAvatar: '',
    /** 头像的「字标兜底」：首字 + 配色。头像图片为空/加载失败时露出它，
        避免卡片上出现一块白的圆（用户说的"头像掉了"） */
    authorLetter: '',
    authorBg: '#EFF1F4',
    authorFg: '#929AA5'
  },
  observers: {
    post(v) {
      if (!v) return;
      // 优先 wx.getWindowInfo，避开 getSystemInfoSync 的废弃告警
      let windowWidth = 375;
      try {
        if (wx.getWindowInfo) windowWidth = wx.getWindowInfo().windowWidth || 375;
        else windowWidth = (wx.getSystemInfoSync().windowWidth) || 375;
      } catch (e) { /* 保持默认 */ }
      const width = Math.min(600, windowWidth - 48);
      const author = v.author || {};
      const avd = util.avatarFallback(author);
      this.setData({
        images: (v.images || []).map((i) => api.abs(i)),
        authorAvatar: api.abs(author.avatar || ''),
        authorLetter: avd.letter,
        authorBg: avd.bg,
        authorFg: avd.fg,
        gridSize: util.gridImages((v.images || []).length, width)
      });
    }
  },
  methods: {
    onTap() {
      if (!this.data.clickable) return;
      wx.navigateTo({ url: '/pages/post-detail/post-detail?id=' + this.data.post.id });
    },
    onLike(e) {
      const { post } = this.data;
      if (!this.data.clickable || !post) return;
      // 详情页处理具体点赞，这里仅透传事件
      this.triggerEvent('like', { id: post.id });
    },
    /** 点评论数 → 进详情看评论（列表里没有展开评论的能力） */
    onTapCmt() {
      if (!this.data.clickable) return;
      wx.navigateTo({ url: '/pages/post-detail/post-detail?id=' + this.data.post.id });
    },
    /**
     * 点头像/昵称 → 作者主页。
     *
     * wxml 用 `catchtap` 而不是 `bindtap`：本组件根节点有 `bindtap="onTap"`
     * （点整卡进详情），不阻止冒泡的话点头像会**同时**触发进详情。
     */
    onTapAuthor() {
      const p = this.data.post;
      if (!this.data.clickable || !p || !p.author || !p.author.id) return;
      wx.navigateTo({ url: '/pages/user/user?id=' + p.author.id });
    },
    catchTapNoop() {}
  }
});
