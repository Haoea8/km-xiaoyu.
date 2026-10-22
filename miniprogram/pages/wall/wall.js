/**
 * 校园墙：匿名表白墙 / 万能墙
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

const TABS = [
  { key: 'any', label: '全部', q: '' },
  { key: 'love', label: '表白墙', q: 'love' },
  { key: 'general', label: '万能墙', q: 'all' }
];

const REPORT_ITEMS = ['垃圾广告', '辱骂骚扰', '虚假信息', '涉嫌诈骗', '色情低俗', '其他违规'];

Page({
  data: {
    tabs: TABS,
    tabKey: 'any',
    sort: 'new',
    list: [],
    page: 1,
    hasMore: true,
    loading: true,
    loadingMore: false,

    /** 发布面板 */
    showPost: false,
    postType: 'love',
    content: '',
    images: [],
    toName: '',
    anonymous: true,
    submitting: false
  },

  onLoad() { this.fetch(true); },
  onPullDownRefresh() { this.fetch(true).then(() => wx.stopPullDownRefresh()); },
  onReachBottom() { this.loadMore(); },

  async fetch(reset) {
    if (reset) this.setData({ page: 1, hasMore: true, loading: true });
    try {
      const p = reset ? 1 : this.data.page;
      const tab = TABS.find((t) => t.key === this.data.tabKey) || TABS[0];
      let url = '/api/wall?sort=' + this.data.sort + '&page=' + p + '&pageSize=10';
      if (tab.q) url += '&type=' + tab.q;
      const res = await api.get(url);
      const list = (res.list || []).map((w) => this.deco(w));
      this.setData({
        list: reset ? list : this.data.list.concat(list),
        page: p,
        hasMore: !!res.hasMore,
        loading: false,
        loadingMore: false
      });
    } catch (e) {
      this.setData({ loading: false, loadingMore: false });
    }
  },

  deco(w) {
    return Object.assign(w, {
      images: (w.images || []).map(api.abs),
      typeText: w.type === 'love' ? '表白墙' : '万能墙',
      initial: (w.anonName || '匿')[0],
      preview: (w.content || '').slice(0, 60)
    });
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.setData({ loadingMore: true, page: this.data.page + 1 });
    this.fetch(false);
  },

  onType(e) {
    const tabKey = e.currentTarget.dataset.k;
    if (tabKey === this.data.tabKey) return;
    this.setData({ tabKey, list: [] });
    this.fetch(true);
  },

  onSort(e) {
    const sort = e.currentTarget.dataset.k;
    if (sort === this.data.sort) return;
    this.setData({ sort, list: [] });
    this.fetch(true);
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/wall-detail/wall-detail?id=' + e.currentTarget.dataset.id });
  },

  previewImage(e) {
    const { id, index } = e.currentTarget.dataset;
    const w = this.data.list.find((x) => x.id === Number(id));
    if (!w) return;
    wx.previewImage({ current: w.images[index], urls: w.images });
  },

  async onLike(e) {
    if (!app.guard()) return;
    const id = Number(e.currentTarget.dataset.id);
    try {
      const res = await api.post('/api/wall/' + id + '/like', {}, { silent: true });
      this.setData({
        list: this.data.list.map((w) => (w.id === id ? Object.assign({}, w, { liked: res.liked, likeCount: res.likeCount }) : w))
      });
    } catch (err) { /* 忽略 */ }
  },

  onReport(e) {
    if (!app.guard()) return;
    const id = Number(e.currentTarget.dataset.id);
    wx.showActionSheet({
      itemList: REPORT_ITEMS,
      success: async (r) => {
        try {
          await api.post('/api/reports', { targetType: 'wall', targetId: id, reason: REPORT_ITEMS[r.tapIndex], detail: '' });
          wx.showToast({ title: '举报已提交', icon: 'none' });
        } catch (err) { /* 已提示 */ }
      }
    });
  },

  /* ---------- 发布 ---------- */
  openPost() {
    if (!app.guard()) return;
    this.setData({ showPost: true, postType: this.data.tabKey === 'love' ? 'love' : 'all' });
  },

  /** 头部快捷入口：直接指定墙类型 */
  openPostQuick(e) {
    if (!app.guard()) return;
    this.setData({ showPost: true, postType: e.currentTarget.dataset.t === 'love' ? 'love' : 'all' });
  },
  closePost() { this.setData({ showPost: false }); },
  noop() { /* 阻止冒泡 */ },

  setPostType(e) { this.setData({ postType: e.currentTarget.dataset.t }); },
  onContent(e) { this.setData({ content: e.detail.value }); },
  onToName(e) { this.setData({ toName: e.detail.value }); },
  toggleAnon() { this.setData({ anonymous: !this.data.anonymous }); },

  chooseImage() {
    const left = 9 - this.data.images.length;
    if (left <= 0) return wx.showToast({ title: '最多 9 张', icon: 'none' });
    wx.chooseMedia({
      count: left, mediaType: ['image'], sizeType: ['compressed'],
      success: (r) => this.setData({ images: this.data.images.concat(r.tempFiles.map((f) => f.tempFilePath)) })
    });
  },
  removeImage(e) {
    const images = this.data.images.slice();
    images.splice(Number(e.currentTarget.dataset.index), 1);
    this.setData({ images });
  },

  async submitPost() {
    const content = String(this.data.content || '').trim();
    if (!content) return wx.showToast({ title: '写点什么再发布吧', icon: 'none' });
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    wx.showLoading({ title: '发布中', mask: true });
    try {
      const urls = [];
      for (const p of this.data.images) urls.push(await api.upload(p));
      await api.post('/api/wall', {
        type: this.data.postType,
        content,
        images: urls,
        toName: this.data.toName,
        anonymous: this.data.anonymous
      }, { silent: true });
      wx.hideLoading();
      wx.showToast({ title: '发布成功', icon: 'success' });
      this.setData({ showPost: false, content: '', images: [], toName: '', submitting: false });
      this.fetch(true);
    } catch (e) {
      wx.hideLoading();
      this.setData({ submitting: false });
      wx.showToast({ title: e.message || '发布失败', icon: 'none' });
    }
  },

  onShareAppMessage() {
    return { title: '校园墙 · 匿名说出心里话', path: '/pages/wall/wall' };
  }
});
