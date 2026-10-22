/**
 * 校园论坛：圈子广场 + 话题 + 帖子流
 */
const app = getApp();
const api = require('../../utils/api');

const TABS = [
  { key: 'new', label: '最新' },
  { key: 'hot', label: '热门' }
];

Page({
  data: {
    tabs: TABS,
    sort: 'new',
    circles: [],
    topics: [],
    posts: [],
    page: 1,
    hasMore: true,
    loading: true,
    loadingMore: false,
    keyword: ''
  },

  onLoad() {
    this.loadAll();
  },

  onShow() {
    app.syncTabBar(this, 'circle');
    if (!this.data.loading) this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() { this.loadMore(); },

  async loadAll() {
    this.setData({ loading: true });
    try {
      const [circles, topics] = await Promise.all([
        api.get('/api/circles'),
        api.get('/api/topics')
      ]);
      this.setData({
        circles: (circles.list || []).map((c) => Object.assign({}, c, { initial: (c.name || '圈')[0] })),
        topics: topics.list || []
      });
      await this.fetchPosts(true);
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  async refresh() {
    const [circles, topics] = await Promise.all([
      api.get('/api/circles', null, { silent: true }).catch(() => ({ list: [] })),
      api.get('/api/topics', null, { silent: true }).catch(() => ({ list: [] }))
    ]);
    if ((circles.list || []).length) {
      this.setData({
        circles: circles.list.map((c) => Object.assign({}, c, { initial: (c.name || '圈')[0] })),
        topics: topics.list || []
      });
    }
    return this.fetchPosts(true);
  },

  async fetchPosts(reset) {
    if (reset) this.setData({ page: 1, hasMore: true });
    try {
      const p = reset ? 1 : this.data.page;
      const res = await api.get('/api/posts?sort=' + this.data.sort + '&page=' + p + '&pageSize=10');
      const list = this.deco(res.list);
      const posts = reset ? list : this.data.posts.concat(list);
      this.setData({ posts, page: p, hasMore: !!res.hasMore, loading: false, loadingMore: false });
    } catch (e) {
      this.setData({ loading: false, loadingMore: false });
    }
  },

  deco(list) {
    return (list || []).map((x) => Object.assign(x, {
      author: Object.assign(x.author || {}, { avatar: api.abs(x.author && x.author.avatar) })
    }));
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.keyword) return;
    this.setData({ loadingMore: true, page: this.data.page + 1 });
    this.fetchPosts(false);
  },

  onSort(e) {
    const sort = e.currentTarget.dataset.k;
    if (sort === this.data.sort) return;
    this.setData({ sort, loading: true, posts: [], keyword: '' });
    this.fetchPosts(true);
  },

  onSearch(e) {
    const kw = (e.detail.value || '').trim();
    this.setData({ keyword: kw });
    if (!kw) return this.fetchPosts(true);
    this.doSearch(kw);
  },

  async doSearch(kw) {
    this.setData({ loading: true });
    try {
      const res = await api.get('/api/posts?keyword=' + encodeURIComponent(kw) + '&pageSize=20');
      this.setData({ posts: this.deco(res.list), hasMore: false, loading: false });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  clearSearch() {
    if (!this.data.keyword) return;
    this.setData({ keyword: '' });
    this.fetchPosts(true);
  },

  goCircle(e) { wx.navigateTo({ url: '/pages/circle-detail/circle-detail?id=' + e.currentTarget.dataset.id }); },
  goTopic(e) { wx.navigateTo({ url: '/pages/circle-detail/circle-detail?topic=' + encodeURIComponent(e.currentTarget.dataset.name) }); },
  goPost(e) { wx.navigateTo({ url: '/pages/post-detail/post-detail?id=' + e.currentTarget.dataset.id }); },

  goCreate() {
    if (!app.guard()) return;
    wx.navigateTo({ url: '/pages/post-create/post-create' });
  },

  /** 卡片内点赞 */
  async onLike(e) {
    if (!app.guard()) return;
    const id = e.detail.id;
    try {
      const res = await api.post('/api/posts/' + id + '/like', {}, { silent: true });
      const posts = this.data.posts.map((p) => (p.id === Number(id)
        ? Object.assign({}, p, { liked: res.liked, likeCount: res.likeCount }) : p));
      this.setData({ posts });
    } catch (err) { /* 忽略 */ }
  }
});
