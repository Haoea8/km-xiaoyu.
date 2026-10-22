/**
 * 校园墙详情：内容 + 评论（匿名） + 点赞 + 举报
 */
const app = getApp();
const api = require('../../utils/api');

const REPORT_ITEMS = ['垃圾广告', '辱骂骚扰', '虚假信息', '涉嫌诈骗', '色情低俗', '其他违规'];

Page({
  data: {
    id: 0,
    loading: true,
    wall: null,
    images: [],
    comments: [],
    input: '',
    anonymous: true,
    sending: false
  },

  onLoad(opts) {
    this.setData({ id: Number(opts.id || 0) });
    this.fetch();
  },

  onPullDownRefresh() { this.fetch().then(() => wx.stopPullDownRefresh()); },

  async fetch() {
    if (!this.data.id) return;
    try {
      const res = await api.get('/api/wall/' + this.data.id);
      const w = res.wall;
      this.setData({
        wall: w,
        images: (w.images || []).map(api.abs),
        comments: res.comments || [],
        loading: false
      });
    } catch (e) {
      this.setData({ loading: false });
      setTimeout(() => wx.navigateBack(), 900);
    }
  },

  previewImage(e) {
    wx.previewImage({ current: this.data.images[e.currentTarget.dataset.index], urls: this.data.images });
  },

  async onLike() {
    if (!app.guard()) return;
    try {
      const res = await api.post('/api/wall/' + this.data.id + '/like', {}, { silent: true });
      this.setData({ 'wall.liked': res.liked, 'wall.likeCount': res.likeCount });
    } catch (e) { /* 忽略 */ }
  },

  async likeComment(e) {
    if (!app.guard()) return;
    const id = Number(e.currentTarget.dataset.id);
    try {
      const res = await api.post('/api/wall/comments/' + id + '/like', {}, { silent: true });
      this.setData({
        comments: this.data.comments.map((c) => (c.id === id
          ? Object.assign({}, c, { liked: res.liked, likeCount: res.likeCount }) : c))
      });
    } catch (e) { /* 忽略 */ }
  },

  onInput(e) { this.setData({ input: e.detail.value }); },
  toggleAnon() { this.setData({ anonymous: !this.data.anonymous }); },

  async onSend() {
    const content = String(this.data.input || '').trim();
    if (!content) return wx.showToast({ title: '说点什么吧', icon: 'none' });
    if (this.data.sending) return;
    this.setData({ sending: true });
    try {
      const res = await api.post('/api/wall/' + this.data.id + '/comments', {
        content, anonymous: this.data.anonymous
      }, { loading: true });
      this.setData({
        comments: this.data.comments.concat([res.comment]),
        'wall.commentCount': res.commentCount,
        input: '', sending: false
      });
      wx.showToast({ title: '评论成功', icon: 'none' });
    } catch (e) {
      this.setData({ sending: false });
    }
  },

  onReport() {
    if (!app.guard()) return;
    if (this.data.wall && this.data.wall.isMine) return this.onDelete();
    wx.showActionSheet({
      itemList: REPORT_ITEMS,
      success: async (r) => {
        try {
          await api.post('/api/reports', {
            targetType: 'wall', targetId: this.data.id,
            reason: REPORT_ITEMS[r.tapIndex], detail: ''
          });
          wx.showToast({ title: '举报已提交', icon: 'none' });
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  onDelete() {
    wx.showModal({
      title: '删除这条墙', content: '删除后无法恢复，确定继续？',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await api.del('/api/wall/' + this.data.id, {}, { loading: true });
          wx.showToast({ title: '已删除', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 700);
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  onShareAppMessage() {
    const w = this.data.wall || {};
    return {
      title: (w.content || '').slice(0, 30) || '校园墙',
      path: '/pages/wall-detail/wall-detail?id=' + w.id
    };
  }
});
