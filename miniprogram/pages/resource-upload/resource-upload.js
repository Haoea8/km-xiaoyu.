/**
 * 上传资料：选文件 → 填信息 → 发布
 */
const app = getApp();
const api = require('../../utils/api');

const CATEGORIES = [
  { code: 'course', name: '课件讲义' },
  { code: 'exam', name: '考试真题' },
  { code: 'note', name: '学霸笔记' },
  { code: 'book', name: '电子书' },
  { code: 'code', name: '代码项目' },
  { code: 'other', name: '其他资料' }
];

const HOT_TAGS = ['期末', '考研', '真题', '笔记', '课件', '复习', '实验报告', '答案', '大纲'];

Page({
  data: {
    categories: CATEGORIES,
    categoryIndex: 0,
    title: '',
    desc: '',
    course: '',
    tags: [],
    tagInput: '',
    hotTags: HOT_TAGS,
    file: null,
    uploading: false,
    submitting: false
  },

  onLoad() {
    if (!app.guard()) return;
  },

  /** 从聊天文件选择资料 */
  chooseFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success: (r) => {
        const f = r.tempFiles[0];
        if (!f) return;
        if (f.size > 30 * 1024 * 1024) return wx.showToast({ title: '文件不能超过 30MB', icon: 'none' });
        const name = f.name || '未命名文件';
        const m = name.match(/\.[A-Za-z0-9]{1,8}$/);
        const ext = m ? m[0].toLowerCase() : '';
        this.setData({
          file: {
            path: f.path,
            name,
            size: f.size,
            ext,
            sizeText: f.size > 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB',
            typeText: ext ? ext.replace('.', '').toUpperCase() : 'FILE'
          }
        });
        if (!this.data.title) {
          this.setData({ title: name.replace(/\.[^.]+$/, '') });
        }
      },
      fail: () => { /* 用户取消 */ }
    });
  },

  removeFile() { this.setData({ file: null }); },

  onCategoryChange(e) { this.setData({ categoryIndex: Number(e.detail.value) }); },
  onTitle(e) { this.setData({ title: e.detail.value }); },
  onDesc(e) { this.setData({ desc: e.detail.value }); },
  onCourse(e) { this.setData({ course: e.detail.value }); },
  onTagInput(e) { this.setData({ tagInput: e.detail.value }); },

  addTag(e) {
    const t = String(e.currentTarget.dataset.t || this.data.tagInput || '').trim().replace(/^#/, '');
    if (!t) return;
    if (this.data.tags.length >= 5) return wx.showToast({ title: '最多 5 个标签', icon: 'none' });
    if (this.data.tags.indexOf(t) > -1) return;
    this.setData({ tags: this.data.tags.concat([t]), tagInput: '' });
  },

  removeTag(e) {
    this.setData({ tags: this.data.tags.filter((x) => x !== e.currentTarget.dataset.t) });
  },

  async onSubmit() {
    if (!this.data.file) return wx.showToast({ title: '请先选择要分享的文件', icon: 'none' });
    const title = String(this.data.title || '').trim();
    if (!title) return wx.showToast({ title: '请填写资料标题', icon: 'none' });
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    wx.showLoading({ title: '上传中 0%', mask: true });
    try {
      const fileUrl = await new Promise((resolve, reject) => {
        wx.uploadFile({
          url: api.base() + '/api/upload',
          filePath: this.data.file.path,
          name: 'file',
          header: { Authorization: 'Bearer ' + api.token() },
          success: (res) => {
            try {
              const body = JSON.parse(res.data);
              if (body.code === 0 && body.data && body.data.url) resolve({ url: body.data.url, meta: body.data.file || {} });
              else reject(new Error((body && body.message) || '上传失败'));
            } catch (e) { reject(new Error('上传失败')); }
          },
          fail: () => reject(new Error('上传失败，请检查网络与服务'))
        });
      });

      wx.showLoading({ title: '发布中', mask: true });
      const res = await api.post('/api/resources', {
        title,
        desc: this.data.desc,
        course: this.data.course,
        category: CATEGORIES[this.data.categoryIndex].code,
        tags: this.data.tags,
        fileUrl: fileUrl.url,
        fileName: this.data.file.name,
        fileSize: this.data.file.size,
        fileExt: this.data.file.ext || (fileUrl.meta && fileUrl.meta.ext) || ''
      }, { silent: true });

      wx.hideLoading();
      wx.showToast({ title: '发布成功', icon: 'success' });
      setTimeout(() => wx.redirectTo({ url: '/pages/resource-detail/resource-detail?id=' + res.resource.id }), 800);
    } catch (e) {
      wx.hideLoading();
      this.setData({ submitting: false });
      wx.showToast({ title: e.message || '发布失败', icon: 'none' });
    }
  },

  onCancel() { wx.navigateBack(); }
});
