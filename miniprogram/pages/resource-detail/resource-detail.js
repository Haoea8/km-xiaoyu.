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
      wx.hideLoading();
      wx.showLoading({ title: '下载中', mask: true });

      /**
       * 演示资料：服务端把文件内容（base64）直接放在 inline 里，不经过云存储，
       * 这里写到本地临时目录再打开，避免在作者/使用者的存储桶里留文件。
       */
      if (res.inline) {
        const ext = (String(res.fileName || '').match(/\.[A-Za-z0-9]+$/) || ['.bin'])[0];
        const filePath = wx.env.USER_DATA_PATH + '/res_' + this.data.id + ext;
        wx.getFileSystemManager().writeFileSync(filePath, res.inline, 'base64');
        wx.hideLoading();
        this.setData({ downloading: false, 'r.downloads': res.downloads });
        this.openLocal(filePath);
        return;
      }

      const url = api.abs(res.url);
      /**
       * 云存储文件走 wx.cloud.downloadFile：它认 cloud:// fileID，
       * 且不受「downloadFile 合法域名」限制。普通 http 地址才用 wx.downloadFile。
       */
      const isCloud = api.isCloudFile(url);
      const task = isCloud
        ? wx.cloud.downloadFile({ fileID: url })
        : new Promise((resolve, reject) => wx.downloadFile({
          url,
          success: (r) => (r.statusCode === 200 ? resolve(r) : reject(new Error('HTTP ' + r.statusCode))),
          fail: reject
        }));
      task.then((r) => {
        wx.hideLoading();
        this.setData({ downloading: false, 'r.downloads': res.downloads });
        this.openLocal(r.tempFilePath);
      }).catch(() => {
        wx.hideLoading();
        this.setData({ downloading: false });
        wx.showToast({ title: '下载失败，请稍后重试', icon: 'none' });
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ downloading: false });
    }
  },

  /** 打开本地文件；zip 这类 wx 不支持预览的格式给个明确提示 */
  openLocal(filePath) {
    wx.openDocument({
      filePath,
      showMenu: true,
      fail: () => wx.showToast({ title: '该格式不支持预览，已保存到本地', icon: 'none' })
    });
  },

  /**
   * 预览（复制链接）。
   *
   * 云存储文件没有永久地址，必须现换一个 https 临时链接，
   * 复制 cloud:// 或包内路径粘到浏览器里都是打不开的。
   * preview=1 不计数、不发通知。
   */
  async onPreview() {
    const r = this.data.r;
    if (!r) return;
    wx.showLoading({ title: '生成链接', mask: true });
    try {
      const res = await api.post('/api/resources/' + r.id + '/download?preview=1', {}, { silent: true });
      wx.hideLoading();
      if (res.noLink || !res.url) {
        return wx.showToast({ title: '演示资料不提供外链，请直接下载', icon: 'none' });
      }
      wx.setClipboardData({
        data: res.url,
        success: () => wx.showToast({ title: '下载链接已复制', icon: 'none' })
      });
    } catch (e) {
      wx.hideLoading();
    }
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
