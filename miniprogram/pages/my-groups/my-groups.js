/**
 * 我的拼团：进行中 / 已成团 / 全部
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '拼团中' },
  { key: 'success', label: '已成团' }
];

Page({
  data: {
    tabs: TABS,
    tab: 'all',
    loading: true,
    list: [],
    filtered: [],
    stats: { ongoing: 0, success: 0 }
  },

  onLoad() { this.fetch(); },
  onPullDownRefresh() { this.fetch().then(() => wx.stopPullDownRefresh()); },

  async fetch() {
    if (!app.guard()) { this.setData({ loading: false }); return; }
    try {
      const res = await api.get('/api/groupbuy/mine');
      const list = (res.list || []).map((g) => Object.assign(g, {
        cover: api.abs((g.listing && g.listing.image) || ''),
        priceText: util.fmtPrice((g.listing && g.listing.price) || 0),
        percent: Math.min(100, Math.round((g.paidCount / Math.max(1, g.targetCount)) * 100)),
        members: (g.members || []).slice(0, 5).map((m) => Object.assign(m, { avatar: api.abs(m.avatar) }))
      }));
      this.setData({
        list,
        stats: { ongoing: res.ongoing || 0, success: res.success || 0 },
        loading: false
      });
      this.applyFilter();
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  applyFilter() {
    const t = this.data.tab;
    this.setData({
      filtered: t === 'all' ? this.data.list : this.data.list.filter((g) => g.status === t)
    });
  },

  onTab(e) {
    this.setData({ tab: e.currentTarget.dataset.k });
    this.applyFilter();
  },

  goDetail(e) { wx.navigateTo({ url: '/pages/group-detail/group-detail?id=' + e.currentTarget.dataset.id }); },

  goListing(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  goZone() { wx.navigateTo({ url: '/pages/zone/zone?zone=group' }); }
});
