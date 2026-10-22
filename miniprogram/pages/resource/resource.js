/**
 * 学习资源：分类 + 课程 + 搜索 + 排序
 */
const app = getApp();
const api = require('../../utils/api');

const SORTS = [
  { key: 'new', label: '最新' },
  { key: 'hot', label: '最热' },
  { key: 'download', label: '下载最多' }
];

Page({
  data: {
    categories: [],
    category: '',
    courses: [],
    course: '',
    keyword: '',
    sort: 'new',
    sorts: SORTS,
    list: [],
    page: 1,
    hasMore: true,
    loading: true,
    loadingMore: false
  },

  onLoad() { this.loadMeta(); this.fetch(true); },
  onPullDownRefresh() { this.fetch(true).then(() => wx.stopPullDownRefresh()); },
  onReachBottom() { this.loadMore(); },

  async loadMeta() {
    try {
      const res = await api.get('/api/resources/courses', null, { silent: true });
      this.setData({
        categories: res.categories || [],
        courses: (res.list || []).slice(0, 12)
      });
    } catch (e) { /* 忽略 */ }
  },

  async fetch(reset) {
    if (reset) this.setData({ page: 1, hasMore: true, loading: true });
    try {
      const p = reset ? 1 : this.data.page;
      const q = ['sort=' + this.data.sort, 'page=' + p, 'pageSize=10'];
      if (this.data.category) q.push('category=' + this.data.category);
      if (this.data.course) q.push('course=' + encodeURIComponent(this.data.course));
      if (this.data.keyword) q.push('keyword=' + encodeURIComponent(this.data.keyword));
      const res = await api.get('/api/resources?' + q.join('&'));
      const list = (res.list || []).map((r) => this.deco(r));
      this.setData({
        list: reset ? list : this.data.list.concat(list),
        page: p,
        hasMore: !!res.hasMore,
        loading: false,
        loadingMore: false
      });
      if (reset && res.categories && !this.data.categories.length) {
        this.setData({ categories: res.categories });
      }
    } catch (e) {
      this.setData({ loading: false, loadingMore: false });
    }
  },

  deco(r) {
    return Object.assign(r, {
      uploaderAvatar: api.abs((r.uploader && r.uploader.avatar) || ''),
      typeColor: this.typeColor(r.category)
    });
  },

  typeColor(cat) {
    const map = { course: '#F5A623', exam: '#EF5350', note: '#22B573', book: '#7A5AF8', code: '#FFA726', other: '#8D9AA8' };
    return map[cat] || '#8D9AA8';
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.setData({ loadingMore: true, page: this.data.page + 1 });
    this.fetch(false);
  },

  onCategory(e) {
    const c = e.currentTarget.dataset.k;
    this.setData({ category: this.data.category === c ? '' : c, list: [] });
    this.fetch(true);
  },

  onCourse(e) {
    const c = e.currentTarget.dataset.k;
    this.setData({ course: this.data.course === c ? '' : c, list: [] });
    this.fetch(true);
  },

  onSort(e) {
    const s = e.currentTarget.dataset.k;
    if (s === this.data.sort) return;
    this.setData({ sort: s, list: [] });
    this.fetch(true);
  },

  onSearch(e) {
    this.setData({ keyword: (e.detail.value || '').trim(), list: [] });
    this.fetch(true);
  },

  clearAll() {
    this.setData({ category: '', course: '', keyword: '', list: [] });
    this.fetch(true);
  },

  goDetail(e) { wx.navigateTo({ url: '/pages/resource-detail/resource-detail?id=' + e.currentTarget.dataset.id }); },

  goUpload() {
    if (!app.guard()) return;
    wx.navigateTo({ url: '/pages/resource-upload/resource-upload' });
  },

  onShareAppMessage() {
    return { title: '校园学习资源共享 · 真题 / 笔记 / 课件', path: '/pages/resource/resource' };
  }
});
