/**
 * 搜索 / 专区列表
 * 参数：zone（分区代码）、keyword（关键词）、focus=1（自动聚焦搜索框）
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');
const { ZONES, ZONE_MAP } = require('../../utils/const');

const SORTS = [
  { key: 'recommend', label: '综合' },
  { key: 'new', label: '最新' },
  { key: 'price_asc', label: '价格↑' },
  { key: 'price_desc', label: '价格↓' },
  { key: 'hot', label: '热度' }
];

/**
 * AI 结果卡片的装饰。
 * 后端返回的是 `image`（原图路径，可能是 /static/ 或 cloud://），
 * 列表用的是 `cover`，这里统一转一次 —— 与 `fetch()` 里的映射保持一致，
 * 否则 AI 卡片会是一块白底（image 组件拿到 cloud:// 前缀的相对路径）。
 */
function decoCard(x) {
  return Object.assign({}, x, {
    cover: api.abs(x.image || ''),
    priceText: util.fmtPrice(x.price),
    imgFail: false
  });
}

Page({
  data: {
    statusBar: 20,
    zones: ZONES,
    zone: '',
    zoneName: '全部好物',
    zoneColor: '#1FA45B',
    keyword: '',
    hotWords: [],
    history: [],
    focus: false,
    sorts: SORTS,
    sort: 'recommend',
    onlyOnSale: true,
    list: [],
    page: 1,
    hasMore: true,
    loading: true,
    loadingMore: false,
    total: 0,

    /* ---- AI 找货 ---- */
    aiOn: false,
    aiBusy: false,
    aiSummary: '',
    aiItems: [],
    aiSource: ''
  },

  onLoad(opts) {
    const zone = opts.zone || '';
    const keyword = opts.keyword ? decodeURIComponent(opts.keyword) : '';
    const z = ZONE_MAP[zone];
    this.setData({
      statusBar: app.globalData.statusBarHeight,
      zone,
      keyword,
      zoneName: z ? z.name : (keyword ? '搜索结果' : '全部好物'),
      zoneColor: z ? z.color : '#1FA45B',
      focus: opts.focus === '1',
      history: wx.getStorageSync('searchHistory') || []
    });
    this.loadHot();
    this.fetch(true);
  },

  async loadHot() {
    try {
      const res = await api.get('/api/search/hot', null, { silent: true });
      this.setData({ hotWords: res.words || [] });
    } catch (e) { /* 忽略 */ }
  },

  async fetch(reset) {
    if (reset) this.setData({ page: 1, hasMore: true, loading: true });
    try {
      const p = reset ? 1 : this.data.page;
      const q = ['page=' + p, 'pageSize=10'];
      if (this.data.zone) q.push('zone=' + this.data.zone);
      if (this.data.keyword) q.push('keyword=' + encodeURIComponent(this.data.keyword));
      if (this.data.sort !== 'recommend') q.push('sort=' + this.data.sort);
      const res = await api.get('/api/listings?' + q.join('&'));
      const list = (res.list || []).map((x) => Object.assign(x, {
        cover: api.abs((x.images && x.images[0]) || ''),
        priceText: util.fmtPrice(x.price),
        modeText: x.tradeMode === 'sell' ? '' : ({
          rent: '出租', barter: '置换', group: '拼团', service: '服务', free: '免费送'
        })[x.tradeMode] || ''
      }));
      this.setData({
        list: reset ? list : this.data.list.concat(list),
        page: p,
        hasMore: !!res.hasMore,
        total: res.total || list.length,
        loading: false,
        loadingMore: false
      });

      // 关键词搜到 0 条时，静默让 AI 再理解一次（只在这一个时机触发，
      // 不跟用户的点击抢状态；失败也不打扰，用户看到的仍是原来的空态）
      if (reset && !list.length && this.data.keyword) this.autoAi();
    } catch (e) {
      this.setData({ loading: false, loadingMore: false });
    }
  },

  /* ---------------- AI 找货 ---------------- */

  /** 搜不到时自动兜底：静默补一次（不弹 loading、不弹错误） */
  autoAi() {
    if (this.data.aiOn || this.data.aiBusy) return;
    this.doAiSearch(true);
  },

  /** 用户主动点「AI 找货」 */
  onAiSearch() {
    if (this.data.aiBusy) return;
    const q = String(this.data.keyword || '').trim();
    if (!q) return wx.showToast({ title: '先说一句想找什么', icon: 'none' });
    this.doAiSearch(false);
  },

  async doAiSearch(quiet) {
    const q = String(this.data.keyword || '').trim();
    if (!q) return;
    this.setData({ aiBusy: true });
    if (!quiet) wx.showLoading({ title: 'AI 找货中', mask: true });
    try {
      const out = await api.post('/api/ai/search', { query: q }, { silent: true });
      if (!quiet) wx.hideLoading();
      const items = (out.items || []).map(decoCard);
      this.setData({
        aiBusy: false,
        aiOn: true,
        aiSummary: out.summary || '',
        aiItems: items,
        aiSource: out.source || 'rule'
      });
    } catch (e) {
      if (!quiet) wx.hideLoading();
      this.setData({ aiBusy: false });
      if (!quiet) wx.showToast({ title: e.message || 'AI 暂时不可用', icon: 'none' });
    }
  },

  closeAi() { this.setData({ aiOn: false, aiSummary: '', aiItems: [] }); },

  loadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.setData({ loadingMore: true, page: this.data.page + 1 });
    this.fetch(false);
  },

  onReachBottom() { this.loadMore(); },
  onPullDownRefresh() { this.fetch(true).then(() => wx.stopPullDownRefresh()); },

  onSearchInput(e) { this.setData({ keyword: e.detail.value }); },

  onSearchConfirm(e) {
    const kw = String(e.detail.value || this.data.keyword || '').trim();
    // 换关键词时先收起上一轮的 AI 结果，避免「新查询 + 旧 AI 结论」并排出现
    this.setData({ keyword: kw, list: [], aiOn: false, aiItems: [], aiSummary: '', zoneName: kw ? '搜索结果' : this.data.zoneName });
    if (kw) this.saveHistory(kw);
    this.fetch(true);
  },

  saveHistory(kw) {
    let h = wx.getStorageSync('searchHistory') || [];
    h = [kw].concat(h.filter((x) => x !== kw)).slice(0, 10);
    wx.setStorageSync('searchHistory', h);
    this.setData({ history: h });
  },

  clearHistory() {
    wx.showModal({
      title: '清空搜索历史', content: '确定要清空全部搜索记录吗？',
      success: (r) => {
        if (!r.confirm) return;
        wx.removeStorageSync('searchHistory');
        this.setData({ history: [] });
      }
    });
  },

  tapWord(e) {
    const kw = e.currentTarget.dataset.w;
    this.setData({ keyword: kw, zoneName: '搜索结果', list: [], aiOn: false, aiItems: [], aiSummary: '' });
    this.saveHistory(kw);
    this.fetch(true);
  },

  onZone(e) {
    const code = e.currentTarget.dataset.k;
    const z = ZONE_MAP[code];
    this.setData({
      zone: code,
      keyword: '',
      zoneName: z ? z.name : '全部好物',
      zoneColor: z ? z.color : '#1FA45B',
      list: [],
      aiOn: false, aiItems: [], aiSummary: ''
    });
    this.fetch(true);
  },

  onSort(e) {
    const s = e.currentTarget.dataset.k;
    if (s === this.data.sort) return;
    this.setData({ sort: s, list: [] });
    this.fetch(true);
  },

  clearKeyword() {
    this.setData({ keyword: '', aiOn: false, aiItems: [], aiSummary: '' });
    this.fetch(true);
  },

  /**
   * 封面图加载失败：**先自动重试一次**，仍失败才落成占位文字。
   *
   * 为什么要重试：图片链接是云函数签发的临时 https，偶发网络抖动/解码失败时
   * `image` 组件**不会自己重试**，结果就是一块纯背景色 —— 用户看到的就是
   * 「有时候个别商品没有加载出图片」。重试手法是把 src 清空再回填，
   * 逼组件重新发起一次加载（服务端已实测链接本身是 200，重试通常能成）。
   *
   * 不重试直接显示占位是不行的：那等于把「偶发失败」变成「永远没有图」。
   */
  onCoverError(e) {
    const i = Number(e.currentTarget.dataset.index);
    const item = this.data.list[i];
    if (!item) return;
    if (item.retried) {                       // 第二次仍失败 → 明确告诉用户，别留灰块
      this.setData({ ['list[' + i + '].imgFail']: true });
      return;
    }
    this.setData({ ['list[' + i + '].retried']: true });
    const url = item.cover;
    setTimeout(() => {
      this.setData({ ['list[' + i + '].cover']: '' }, () => {
        this.setData({ ['list[' + i + '].cover']: url });
      });
    }, 300);
  },

  goDetail(e) { wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id }); },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/index/index' });
  },

  goPublish() {
    if (!app.guard()) return;
    wx.navigateTo({ url: '/pages/publish/publish' + (this.data.zone ? '?zone=' + this.data.zone : '') });
  }
});
