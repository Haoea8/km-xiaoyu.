/**
 * 圈子详情 / 话题聚合页
 * 参数：id（圈子 id）或 topic（话题名）
 */
const app = getApp();
const api = require('../../utils/api');

Page({
  data: {
    circleId: 0,
    topic: '',
    title: '圈子',
    circle: null,
    color: '#1FA45B',
    initial: '圈',
    posts: [],
    page: 1,
    hasMore: true,
    loading: true,
    loadingMore: false,
    sort: 'new'
  },

  onLoad(opts) {
    const circleId = Number(opts.id || 0);
    const topic = opts.topic ? decodeURIComponent(opts.topic) : '';
    this.setData({
      circleId,
      topic,
      title: topic ? ('#' + topic) : '圈子'
    });
    this.load();
  },

  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },
  onReachBottom() { this.loadMore(); },

  async load() {
    this.setData({ loading: true });
    if (this.data.circleId) {
      try {
        const res = await api.get('/api/circles/' + this.data.circleId, null, { silent: true });
        const c = res.circle;
        this.setData({
          circle: c,
          title: c.name,
          color: c.color,
          initial: (c.name || '圈')[0]
        });
      } catch (e) { /* 忽略 */ }
    }
    return this.fetch(true);
  },

  async fetch(reset) {
    if (reset) this.setData({ page: 1, hasMore: true });
    try {
      const p = reset ? 1 : this.data.page;
      const q = [];
      if (this.data.circleId) q.push('circleId=' + this.data.circleId);
      if (this.data.topic) q.push('topic=' + encodeURIComponent(this.data.topic));
      q.push('sort=' + this.data.sort, 'page=' + p, 'pageSize=10');
      const res = await api.get('/api/posts?' + q.join('&'));
      const list = (res.list || []).map((x) => Object.assign(x, {
        author: Object.assign(x.author || {}, { avatar: api.abs(x.author && x.author.avatar) })
      }));
      this.setData({
        posts: reset ? list : this.data.posts.concat(list),
        page: p,
        hasMore: !!res.hasMore,
        loading: false,
        loadingMore: false
      });
    } catch (e) {
      this.setData({ loading: false, loadingMore: false });
    }
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.setData({ loadingMore: true, page: this.data.page + 1 });
    this.fetch(false);
  },

  onSort(e) {
    const sort = e.currentTarget.dataset.k;
    if (sort === this.data.sort) return;
    this.setData({ sort, loading: true, posts: [] });
    this.fetch(true);
  },

  goPost(e) { wx.navigateTo({ url: '/pages/post-detail/post-detail?id=' + e.currentTarget.dataset.id }); },

  goCreate() {
    if (!app.guard()) return;
    const q = [];
    if (this.data.circleId) q.push('circleId=' + this.data.circleId);
    if (this.data.topic) q.push('topic=' + encodeURIComponent(this.data.topic));
    wx.navigateTo({ url: '/pages/post-create/post-create' + (q.length ? '?' + q.join('&') : '') });
  },

  async onLike(e) {
    if (!app.guard()) return;
    const id = e.detail.id;
    try {
      const res = await api.post('/api/posts/' + id + '/like', {}, { silent: true });
      this.setData({
        posts: this.data.posts.map((p) => (p.id === Number(id)
          ? Object.assign({}, p, { liked: res.liked, likeCount: res.likeCount }) : p))
      });
    } catch (err) { /* 忽略 */ }
  },

  onShareAppMessage() {
    const c = this.data.circle;
    return {
      title: c ? ('校园圈子 · ' + c.name) : ('话题 #' + this.data.topic),
      path: c ? ('/pages/circle-detail/circle-detail?id=' + c.id)
        : ('/pages/circle-detail/circle-detail?topic=' + encodeURIComponent(this.data.topic))
    };
  }
});
