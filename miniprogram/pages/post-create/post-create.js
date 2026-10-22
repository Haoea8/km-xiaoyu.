/**
 * 发布帖子：内容 + 图片 + 圈子 + 话题
 */
const app = getApp();
const api = require('../../utils/api');

const HOT_TOPICS = ['跳蚤市场', '学习交流', '吃喝玩乐', '运动健身', '失物招领', '吐槽树洞', '毕业季', '拼团互助', '求推荐', '有偿求助'];

Page({
  data: {
    circles: [],
    circleIndex: 0,
    content: '',
    images: [],
    topics: [],
    topicInput: '',
    hotTopics: HOT_TOPICS,
    submitting: false,
    maxImages: 9
  },

  onLoad(opts) {
    if (!app.guard()) return;
    /** 幂等键：本次进入发帖页只生成一次，重试也用它（服务端据此去重） */
    this.reqId = 'P' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    this.presetCircleId = Number(opts.circleId || 0);
    if (opts.topic) this.setData({ topics: [decodeURIComponent(opts.topic)] });
    this.loadCircles();
  },

  async loadCircles() {
    try {
      const res = await api.get('/api/circles', null, { silent: true });
      const list = res.list || [];
      let idx = 0;
      if (this.presetCircleId) {
        const i = list.findIndex((c) => c.id === this.presetCircleId);
        if (i > -1) idx = i;
      }
      this.setData({ circles: list, circleIndex: idx });
    } catch (e) { /* 忽略 */ }
  },

  onCircleChange(e) { this.setData({ circleIndex: Number(e.detail.value) }); },

  onContent(e) { this.setData({ content: e.detail.value }); },

  onTopicInput(e) { this.setData({ topicInput: e.detail.value }); },

  addTopic(e) {
    const t = String(e.currentTarget.dataset.t || this.data.topicInput || '').trim().replace(/^#/, '');
    if (!t) return;
    if (this.data.topics.length >= 4) return wx.showToast({ title: '最多添加 4 个话题', icon: 'none' });
    if (this.data.topics.indexOf(t) > -1) return wx.showToast({ title: '话题已添加', icon: 'none' });
    this.setData({ topics: this.data.topics.concat([t]), topicInput: '' });
  },

  removeTopic(e) {
    const t = e.currentTarget.dataset.t;
    this.setData({ topics: this.data.topics.filter((x) => x !== t) });
  },

  chooseImage() {
    const left = this.data.maxImages - this.data.images.length;
    if (left <= 0) return wx.showToast({ title: '最多 9 张图', icon: 'none' });
    wx.chooseMedia({
      count: left, mediaType: ['image'], sizeType: ['compressed'],
      success: (r) => {
        const paths = r.tempFiles.map((f) => f.tempFilePath);
        this.setData({ images: this.data.images.concat(paths) });
      }
    });
  },

  removeImage(e) {
    const i = Number(e.currentTarget.dataset.index);
    const images = this.data.images.slice();
    images.splice(i, 1);
    this.setData({ images });
  },

  previewImage(e) {
    wx.previewImage({ current: this.data.images[e.currentTarget.dataset.index], urls: this.data.images });
  },

  async onSubmit() {
    const content = String(this.data.content || '').trim();
    if (!content) return wx.showToast({ title: '写点什么再发布吧', icon: 'none' });
    // 同步锁 + data 标记双保险：连点在同一帧进来也只会走一次。
    // （图片要逐张上传，中间有几百毫秒~几秒的空窗，正是重复发帖的高发期。）
    if (this.locked || this.data.submitting) return;
    this.locked = true;
    this.setData({ submitting: true });
    wx.showLoading({ title: '发布中', mask: true });
    try {
      const urls = [];
      for (const p of this.data.images) {
        /**
         * ⚠️ 只跳过「手机上已经能访问」的地址：cloud://（已上云）或 https:// 远端图。
         *
         * 不能简单判 `^https?://`：**微信开发者工具**的 chooseMedia 返回的是
         * `http://tmp/xxx.jpeg`（本机临时文件）。照原样存库的话，
         * 开发工具里能显示（文件就在电脑上），手机打开就是一块白 ——
         * 这就是「电脑上发的帖子，手机看不到图」的真正原因。
         */
        const localTmp = /^https?:\/\/(tmp|usr)[\/.]/i.test(p) || /^wxfile:\/\//i.test(p);
        if (!localTmp && (api.isCloudFile(p) || /^https:\/\//i.test(p))) { urls.push(p); continue; }
        const url = await api.upload(p);
        urls.push(url);
      }
      const circle = this.data.circles[this.data.circleIndex];
      const res = await api.post('/api/posts', {
        content,
        images: urls,
        topics: this.data.topics,
        circleId: circle ? circle.id : undefined,
        /** 幂等键：服务端据此去重，连点/重试只会有一条帖子 */
        reqId: this.reqId
      }, { silent: true });
      wx.hideLoading();
      wx.showToast({ title: '发布成功', icon: 'success' });
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/post-detail/post-detail?id=' + res.post.id });
      }, 800);
    } catch (e) {
      wx.hideLoading();
      // 解锁可重试；reqId 不变 —— 若这次其实已建好（响应超时），重试拿回同一条
      this.locked = false;
      this.setData({ submitting: false });
      wx.showToast({ title: e.message || '发布失败', icon: 'none' });
    }
  },

  onCancel() { wx.navigateBack(); }
});
