/**
 * 我的动态 / TA 的动态
 *
 * 为什么要有这一页：主页上写着「动态 3」，但点不进去、也不知道那 3 条到底是什么。
 * 这里把这个人发过的**圈子帖子 / 校园墙 / 学习资料**聚合成一条时间线，
 * 一眼能看到「他到底发过什么」，点一条进对应详情。
 *
 * 数据来源（都是已有接口，只是补了按作者过滤）：
 *   GET /api/posts?authorId=<uid>
 *   GET /api/wall?mine=1            ← 只能看自己的墙（匿名性）
 *   GET /api/resources/mine
 *
 * 注意：校园墙是**匿名**的，别人的墙贴服务端只允许按 mine 取自己的，
 * 所以看 TA 的动态时不会出现 TA 的墙贴 —— 这是刻意的，不是漏了。
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'post', label: '帖子' },
  { key: 'wall', label: '校园墙' },
  { key: 'resource', label: '学习资料' }
];

Page({
  data: {
    tabs: TABS,
    tab: 'all',
    loading: true,
    all: [],
    list: [],
    isMe: false,
    name: ''
  },

  onLoad(opts) {
    const myId = (app.globalData.user && app.globalData.user.id) || 0;
    this.uid = Number(opts.id || 0) || myId;
    this.setData({ isMe: this.uid === myId, name: decodeURIComponent(opts.name || '') });
  },

  onShow() { this.load(); },

  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    if (!this.uid) { this.setData({ loading: false }); return; }
    this.setData({ loading: true });
    const uid = this.uid;
    const isMe = this.data.isMe;

    const [posts, walls, res] = await Promise.all([
      api.get('/api/posts?authorId=' + uid, null, { silent: true }).catch(() => ({})),
      // 墙贴只有本人能按 mine 拉（匿名保护），看别人时直接跳过
      isMe ? api.get('/api/wall?mine=1', null, { silent: true }).catch(() => ({})) : Promise.resolve({}),
      isMe ? api.get('/api/resources/mine', null, { silent: true }).catch(() => ({})) : Promise.resolve({})
    ]);

    const items = [];

    for (const p of (posts.list || [])) {
      items.push({
        id: 'post-' + p.id,
        type: 'post',
        typeText: '圈子帖子',
        icon: '💬',
        title: String(p.content || '').replace(/\s+/g, ' ').slice(0, 80) || '（无正文）',
        cover: api.abs((p.images && p.images[0]) || ''),
        meta: '赞 ' + ((p.likes || []).length) + ' · 评论 ' + (p.commentCount || 0),
        timeText: util.relTime(p.createdAt),
        createdAt: p.createdAt || 0,
        link: '/pages/post-detail/post-detail?id=' + p.id
      });
    }

    for (const w of (walls.list || [])) {
      items.push({
        id: 'wall-' + w.id,
        type: 'wall',
        typeText: '校园墙',
        icon: '❤️',
        title: String(w.content || '').replace(/\s+/g, ' ').slice(0, 80) || '（无正文）',
        cover: '',
        meta: '赞 ' + Math.round((w.likeBase || 0) + (w.likes || []).length) + ' · 评论 ' + (w.commentCount || 0),
        timeText: util.relTime(w.createdAt),
        createdAt: w.createdAt || 0,
        link: '/pages/wall-detail/wall-detail?id=' + w.id
      });
    }

    for (const r of (res.list || [])) {
      items.push({
        id: 'res-' + r.id,
        type: 'resource',
        typeText: '学习资料',
        icon: '📚',
        title: r.title || '（无标题）',
        cover: api.abs(r.cover || ''),
        meta: '下载 ' + (r.downloads || 0) + ' · 赞 ' + (r.likes || 0),
        timeText: util.relTime(r.createdAt),
        createdAt: r.createdAt || 0,
        link: '/pages/resource-detail/resource-detail?id=' + r.id
      });
    }

    items.sort((a, b) => b.createdAt - a.createdAt);
    this.setData({ all: items, loading: false });
    this.filter();
  },

  /** 按当前 tab 过滤（纯前端，数据就那么些，不值得再请求一次） */
  filter() {
    const t = this.data.tab;
    const list = t === 'all' ? this.data.all : this.data.all.filter((x) => x.type === t);
    this.setData({ list });
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.k;
    if (tab === this.data.tab) return;
    this.setData({ tab });
    this.filter();
  },

  open(e) {
    const item = this.data.list[Number(e.currentTarget.dataset.i)];
    if (!item || !item.link) return;
    wx.navigateTo({ url: item.link, fail: () => wx.showToast({ title: '内容可能已被删除', icon: 'none' }) });
  }
});
