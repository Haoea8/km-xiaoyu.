/**
 * 首页：搜索 + 九大分区金刚区 + 特色入口 + AI 智能推荐 + 热门内容
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');
const { ZONES } = require('../../utils/const');

/**
 * 「不再提示」记的是**这条公告的 id**，不是布尔值。
 * 换一条新公告还会弹一次（否则以后所有运营公告都触达不到），
 * 但同一条公告点过之后，再打开小程序就不再自动弹。
 */
const NOTICE_MUTED_KEY = 'noticeMutedId';

Page({
  data: {
    statusBar: 20,
    navBar: 44,
    zones: ZONES,
    notice: null,
    noticeClosed: false,
    /** 公告弹窗是否打开（点公告横幅 → 弹窗，不跳页） */
    noticeOpen: false,
    topics: [],
    hotPosts: [],

    /** AI 推荐 */
    recList: [],
    recReason: '正在为你计算…',
    recTags: [],
    personalized: false,
    /**
     * 换一批：自增种子 + 累计已展示 id。
     * 注意是「累计」而不是只有上一批 —— 只传上一批的话，
     * 换到第 3 批时第 1 批的商品又会被捞回来，用户会觉得"没换"。
     */
    recSeed: 0,
    recSeen: [],
    /** 后端告知：候选池里还没看过的还剩几件（0 = 已看完一轮，该重置循环了） */
    recUnseen: 0,
    recRefreshing: false,

    /** 普通瀑布流（未登录/兜底） */
    feed: [],
    page: 1,
    hasMore: true,
    loadingMore: false,
    loading: true,
    user: null
  },

  onLoad() {
    this.setData({ statusBar: app.globalData.statusBarHeight, navBar: app.globalData.navBarHeight });
    this.onUser = (u) => { this.setData({ user: u }); this.loadRecommend(false, true); };
    app.on('user', this.onUser);
    this.loadAll();
  },

  onUnload() {
    app.off('user', this.onUser);
  },

  onShow() {
    app.syncTabBar(this, 'home');
    if (!this.data.loading) this.loadRecommend(true);
  },

  onPullDownRefresh() {
    this.loadAll().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.recList.length) return; // 有推荐时不重复加载
    this.loadMore();
  },

  async loadAll() {
    this.setData({ loading: true });
    try {
      const res = await api.get('/api/home');
      const feed = (res.feed || []).map((x) => Object.assign(x, {
        cover: api.abs((x.images && x.images[0]) || ''),
        priceText: util.fmtPrice(x.price)
      }));
      this.setData({
        // 公告整条带回（含 content），顺手补一个相对时间给弹窗用
        notice: res.notice
          ? Object.assign({}, res.notice, { timeText: util.relTime(res.notice.createdAt) })
          : null,
        feed,
        hotPosts: (res.hotPosts || []).map((p) => Object.assign(p, {
          // 头像：过 api.abs 转云存储路径；同时算出「字标兜底」，
          // 图片为空/加载失败时 wxml 里会露出昵称首字，不会是一块白
          author: Object.assign(p.author || {}, util.avatarFallback(p.author), {
            avatar: api.abs(p.author && p.author.avatar)
          }),
          cover: api.abs((p.images && p.images[0]) || '')
        })),
        loading: false
      });
      // 小程序一打开就弹一次公告（同一页面实例只弹一次，切 tab 回来不重复）
      this.maybeAutoNotice();
    } catch (e) {
      this.setData({ loading: false });
    }
    this.loadTopics();
    // 下拉刷新 / 首次进入：重置推荐循环，从头给一批
    this.loadRecommend(false, true);
  },

  async loadTopics() {
    try {
      const r = await api.get('/api/topics', null, { silent: true });
      this.setData({ topics: (r.list || []).slice(0, 10) });
    } catch (e) { /* 忽略 */ }
  },

  /**
   * 加载 AI 推荐。
   * @param {boolean} silent     静默请求（不弹 loading）
   * @param {boolean} resetSeen  清空累计排除，从第一批重新开始
   */
  async loadRecommend(silent, resetSeen) {
    const seed = resetSeen ? 0 : (this.data.recSeed || 0);
    const seen = resetSeen ? [] : (this.data.recSeen || []);
    if (resetSeen) this.setData({ recSeed: 0, recSeen: [] });
    return this.fetchRecommend(seed, seen, silent);
  },

  /**
   * 真正发请求的一层（与 UI 状态解耦，便于「换一批」显式传参，不依赖 setData 时序）。
   * @param {number} seed
   * @param {number[]} seen  累计已展示过的商品 id
   */
  async fetchRecommend(seed, seen, silent) {
    try {
      const q = [];
      if (seed) q.push('seed=' + seed);
      if (seen && seen.length) q.push('exclude=' + seen.join(','));
      const url = '/api/recommend/home' + (q.length ? '?' + q.join('&') : '');
      const res = await api.get(url, null, { silent: !!silent });
      this.setData({
        recList: (res.list || []).map((x) => Object.assign(x, {
          cover: api.abs((x.images && x.images[0]) || ''),
          priceText: util.fmtPrice(x.price),
          reasonShort: (x.reason || '').replace('你常看这个分区', '常逛分区').replace('符合你的偏好标签', '偏好匹配')
        })),
        recReason: res.reason || '校园热门好物',
        personalized: !!res.personalized,
        recTags: res.topTags || [],
        recUnseen: typeof res.unseen === 'number' ? res.unseen : 0
      });
    } catch (e) { /* 忽略 */ }
  },

  async loadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.setData({ loadingMore: true });
    try {
      const p = this.data.page + 1;
      const res = await api.get('/api/listings?page=' + p + '&pageSize=10');
      const more = (res.list || []).map((x) => Object.assign(x, {
        cover: api.abs((x.images && x.images[0]) || ''),
        priceText: util.fmtPrice(x.price)
      }));
      this.setData({
        feed: this.data.feed.concat(more),
        page: p,
        hasMore: !!res.hasMore,
        loadingMore: false
      });
    } catch (e) {
      this.setData({ loadingMore: false });
    }
  },

  onSearchTap() { wx.navigateTo({ url: '/pages/zone/zone?focus=1' }); },

  onSearchConfirm(e) {
    const kw = (e.detail.value || '').trim();
    if (!kw) return;
    wx.navigateTo({ url: '/pages/zone/zone?keyword=' + encodeURIComponent(kw) });
  },

  goZone(e) {
    wx.navigateTo({ url: '/pages/zone/zone?zone=' + e.currentTarget.dataset.zone });
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  closeNotice() { this.setData({ noticeClosed: true }); },

  /**
   * 点公告 → **弹窗显示正文**（不跳页）。
   *
   * 演进过程：原来是 `bindtap="goCircle"`（跳校园圈子，与公告完全无关）；
   * 改成公告详情页后用户明确反馈「公告弹个窗显示就好了，为什么要跳转」——
   * 公告就是一条短消息，弹窗看完关掉是最轻的做法。
   * 正文已随 `/api/home` 整条下发，不需要额外请求（也就不依赖新接口是否已部署）。
   */
  openNotice() {
    if (!this.data.notice) return;
    this.setData({ noticeOpen: true });
  },

  closeNoticePopup() { this.setData({ noticeOpen: false }); },

  /** 空函数：挂在弹窗内容上阻止冒泡（点正文不应关掉弹窗） */
  noop() {},

  goTopic(e) {
    wx.navigateTo({ url: '/pages/circle-detail/circle-detail?topic=' + encodeURIComponent(e.currentTarget.dataset.name) });
  },

  goPost(e) {
    wx.navigateTo({ url: '/pages/post-detail/post-detail?id=' + e.currentTarget.dataset.id });
  },

  /** 点热帖里的头像/昵称 → 作者主页 */
  goUser(e) {
    const id = Number(e.currentTarget.dataset.id || 0);
    if (!id) return;
    wx.navigateTo({ url: '/pages/user/user?id=' + id });
  },

  /* ---------- 特色入口 ---------- */
  goWall() { wx.navigateTo({ url: '/pages/wall/wall' }); },
  goResource() { wx.navigateTo({ url: '/pages/resource/resource' }); },
  goMyGroups() {
    if (!app.guard()) return;
    wx.navigateTo({ url: '/pages/my-groups/my-groups' });
  },
  goPublish() {
    if (!app.guard()) return;
    wx.navigateTo({ url: '/pages/publish/publish' });
  },
  goCircle() { wx.switchTab({ url: '/pages/circle/circle' }); },

  /**
   * 换一批推荐
   *
   * 三条关键规则（缺一就会出现"点了没反应"）：
   *  1) exclude 传「累计已展示的全部 id」，不只是上一批。
   *     只传上一批的话，换到第 3 批时第 1 批的商品又会被捞回来。
   *  2) seed 自增，让同一档位内的顺序重新打散。
   *  3) 剩余新面孔不足半批时，把累计收缩成「只排除当前这一批」再继续 ——
   *     即开始新一轮循环。注意不能直接把累计清成空数组：
   *     那样会又弹回分数最高的那批老商品，视觉上等于没换。
   */
  async refreshRecommend() {
    if (this.data.recRefreshing) return;

    const prev = (this.data.recList || []).map((x) => x.id).filter(Boolean);
    const prevKey = prev.join(',');
    const seen = this.data.recSeen || [];

    // 剩不到半批新面孔 → 开始新一轮：只排除当前屏幕上的这批，保证换出来的是全新一屏
    const exhausted = prev.length > 0 && this.data.recUnseen < Math.ceil(prev.length / 2);
    const nextSeen = exhausted
      ? prev
      : seen.concat(prev.filter((id) => seen.indexOf(id) === -1));

    const nextSeed = (this.data.recSeed || 0) + 1;
    this.setData({ recRefreshing: true, recSeed: nextSeed, recSeen: nextSeen });
    wx.showToast({
      title: exhausted ? '已看完全部，重新为你推荐' : '正在换一批',
      icon: 'none',
      duration: 800
    });

    // 显式传 seed/seen，保证这次请求用的就是刚算出来的值
    await this.fetchRecommend(nextSeed, nextSeen, true);
    this.setData({ recRefreshing: false });

    // 换完还是同一批（候选确实太少）→ 明确告知，避免用户以为按钮坏了
    const nowKey = (this.data.recList || []).map((x) => x.id).join(',');
    if (!exhausted && nowKey && nowKey === prevKey) {
      wx.showToast({ title: '推荐就这么多啦，稍后再来', icon: 'none', duration: 1200 });
    }
  },

  onShareAppMessage() {
    return { title: '科贸小鱼 · 二手交易 / 代跑 / 拼团 / 校园墙', path: '/pages/index/index' };
  }
});
