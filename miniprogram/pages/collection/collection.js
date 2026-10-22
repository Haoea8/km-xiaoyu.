/**
 * 我的收藏：宝贝 / 帖子
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

const TABS = [
  { key: 'listing', label: '宝贝' },
  { key: 'post', label: '帖子' }
];

Page({
  data: {
    tabs: TABS,
    type: 'listing',
    loading: true,
    list: []
  },

  onLoad() { this.fetch(); },
  onShow() { if (!this.data.loading) this.fetch(); },
  onPullDownRefresh() { this.fetch().then(() => wx.stopPullDownRefresh()); },

  async fetch() {
    if (!app.guard()) { this.setData({ loading: false }); return; }
    this.setData({ loading: true });
    try {
      const res = await api.get('/api/favorites?type=' + this.data.type);
      const list = (res.items || []).map((x) => {
        if (this.data.type === 'listing') {
          return Object.assign(x, {
            cover: api.abs((x.images && x.images[0]) || ''),
            priceText: util.fmtPrice(x.price)
          });
        }
        return Object.assign(x, {
          author: Object.assign(x.author || {}, { avatar: api.abs(x.author && x.author.avatar) })
        });
      });
      this.setData({ list, loading: false });
    } catch (e) {
      this.setData({ list: [], loading: false });
    }
  },

  onTab(e) {
    const type = e.currentTarget.dataset.k;
    if (type === this.data.type) return;
    this.setData({ type, list: [] });
    this.fetch();
  },

  goDetail(e) { wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id }); },
  goPost(e) { wx.navigateTo({ url: '/pages/post-detail/post-detail?id=' + e.currentTarget.dataset.id }); },

  async unFav(e) {
    const id = Number(e.currentTarget.dataset.id);
    try {
      await api.post('/api/favorites/toggle', { targetType: this.data.type, targetId: id }, { silent: true });
      this.setData({ list: this.data.list.filter((x) => x.id !== id) });
      wx.showToast({ title: '已取消收藏', icon: 'none' });
    } catch (err) { /* 已提示 */ }
  },

  async onLike(e) {
    const id = e.detail.id;
    try {
      const res = await api.post('/api/posts/' + id + '/like', {}, { silent: true });
      this.setData({
        list: this.data.list.map((p) => (p.id === Number(id)
          ? Object.assign({}, p, { liked: res.liked, likeCount: res.likeCount }) : p))
      });
    } catch (err) { /* 忽略 */ }
  },

  goExplore() { wx.switchTab({ url: '/pages/index/index' }); }
});
