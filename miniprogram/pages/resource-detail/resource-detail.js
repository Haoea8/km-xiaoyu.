/**
 * 资料详情：信息 + 下载 + 点赞 + 举报
 */
const app = getApp();
const api = require('../../utils/api');

const REPORT_ITEMS = ['侵权盗版', '虚假资料', '含病毒风险', '涉黄涉政', '广告推广', '其他违规'];

Page({
  data: {
    id: 0,
    loading: true,
    r: null,
    uploaderAvatar: '',
    related: [],
    downloading: false
  },

  onLoad(opts) {
    this.setData({ id: Number(opts.id || 0) });
    this.fetch();
  },

  onPullDownRefresh() { this.fetch().then(() => wx.stopPullDownRefresh()); },

  async fetch() {
    if (!this.data.id) return;
    try {
      const res = await api.get('/api/resources/' + this.data.id);
      const r = res.resource;
      this.setData({
        r,
        uploaderAvatar: api.abs((r.uploader && r.uploader.avatar) || ''),
        related: (res.related || []).map((x) => Object.assign(x, { typeColor: this.typeColor(x.category) })),
        loading: false
      });
    } catch (e) {
      this.setData({ loading: false });
      setTimeout(() => wx.navigateBack(), 900);
    }
  },

  typeColor(cat) {
    const map = { course: '#F5A623', exam: '#EF5350', note: '#22B573', book: '#7A5AF8', code: '#FFA726', other: '#8D9AA8' };
    return map[cat] || '#8D9AA8';
  },

  /** 下载：计数 + 保存文件到本地 */
  async onDownload() {
    if (!app.guard()) return;
    if (this.data.downloading) return;
    this.setData({ downloading: true });
    wx.showLoading({ title: '准备下载', mask: true });
    try {
      const res = await api.post('/api/resources/' + this.data.id + '/download', {}, { silent: true });
      const url = api.abs(res.url);
      wx.hideLoading();
      wx.showLoading({ title: '下载中', mask: true });
      wx.downloadFile({
        url,
        success: (r) => {
          wx.hideLoading();
          this.setData({ downloading: false, 'r.downloads': res.downloads });
          if (r.statusCode !== 200) return wx.showToast({ title: '下载失败', icon: 'none' });
          wx.openDocument({
            filePath: r.tempFilePath,
            showMenu: true,
            fail: () => wx.showToast({ title: '已下载，可在聊天中查看', icon: 'none' })
          });
        },
        fail: () => {
          wx.hideLoading();
          this.setData({ downloading: false });
          wx.showToast({ title: '下载失败，请检查服务是否启动', icon: 'none' });
        }
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ downloading: false });
    }
  },

  /** 预览（浏览器打开 / 复制链接） */
  onPreview() {
    const r = this.data.r;
    if (!r) return;
    wx.setClipboardData({
      data: api.abs(r.fileUrl),
      success: () => wx.showToast({ title: '下载链接已复制', icon: 'none' })
    });
  },

  async onLike() {
    if (!app.guard()) return;
    try {
      const res = await api.post('/api/resources/' + this.data.id + '/like', {}, { silent: true });
      this.setData({ 'r.liked': res.liked, 'r.likeCount': res.likeCount });
    } catch (e) { /* 忽略 */ }
  },

  chatUploader() {
    const r = this.data.r;
    if (!r || !r.uploader) return;
    if (r.isMine) return wx.showToast({ title: '这是你上传的资料', icon: 'none' });
    app.openChat({ peerId: r.uploader.id });
  },

  goRelated(e) { wx.navigateTo({ url: '/pages/resource-detail/resource-detail?id=' + e.currentTarget.dataset.id }); },

  onReport() {
    if (!app.guard()) return;
    if (this.data.r && this.data.r.isMine) return this.onDelete();
    wx.showActionSheet({
      itemList: REPORT_ITEMS,
      success: async (r) => {
        try {
          await api.post('/api/reports', {
            targetType: 'resource', targetId: this.data.id,
            reason: REPORT_ITEMS[r.tapIndex], detail: ''
          });
          wx.showToast({ title: '举报已提交', icon: 'none' });
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  onDelete() {
    wx.showModal({
      title: '删除资料', content: '删除后其他同学将无法下载，确定继续？',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await api.del('/api/resources/' + this.data.id, {}, { loading: true });
          wx.showToast({ title: '已删除', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 700);
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  onShareAppMessage() {
    const r = this.data.r || {};
    return {
      title: '【学习资料】' + (r.title || ''),
      path: '/pages/resource-detail/resource-detail?id=' + r.id
    };
  }
});
