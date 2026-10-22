/**
 * 帖子详情：内容 + 点赞 + 收藏 + 评论（两级结构）
 *
 * 评论区是**两级**的（小红书那种）：顶层评论下面挂回复，
 * 每条顶层评论默认只露 2 条回复，多的折起来给一个「展开 N 条回复」。
 *
 * ⚠️ 两级结构由**前端**用 `util.commentTree()` 建（后端给两级或扁平都能建）。
 *    原因：云函数是独立部署的 —— 小程序发了新版、云函数还是旧版时，
 *    旧版返回的是**平铺**评论。若前端只会读 `replies` 字段，
 *    界面就是「回复了一条评论，却显示成一条单独的评论」，
 *    而用户根本看不出原因在部署上（这正是被反馈过的问题）。
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

const REPORT_ITEMS = ['垃圾广告', '辱骂骚扰', '虚假信息', '涉嫌诈骗', '侵权盗版', '其他违规'];

/** 每条顶层评论默认露几条回复，超过就折叠 */
const REPLY_PREVIEW = 2;

/**
 * 头像的渲染数据。
 *
 * ⚠️ 必须自己算「首字字标」，不能只依赖 `src`。
 *   服务端已经保证 author 不是 null 了，但**图片本身**仍然可能加载不出来：
 *     - 头像字段是空的（微信一键登录后没设置过头像）
 *     - 是 /static/avatars/aXX.jpg 这类路径，而云存储里没有对应文件
 *     - 是刚上传的 fileID / 临时链接（可能过期）
 *   这时 <image> 渲染出来是一片空白 —— 就是用户说的「头像掉了」。
 *   所以头像框里**先铺一层首字字标、图片盖在上面**：
 *   图片正常就完全盖住，图片空或加载失败就露出字标。两种情况都不是白块。
 *   （字标算法在 utils/util.avatarFallback，卡片/首页共用同一套配色。）
 */
function av(u) {
  const o = Object.assign({}, u || {});
  o.avatar = api.abs(o.avatar || '');
  return Object.assign(o, util.avatarFallback(o));
}

Page({
  data: {
    id: 0,
    loading: true,
    /** 首屏加载失败的原因。原来这里失败会**自动退页**，用户的感觉是"莫名其妙被弹走、评论也没了" */
    error: '',
    post: null,
    images: [],
    /** 顶层评论（每条自带 replies / visibleReplies / hiddenCount） */
    comments: [],
    /** 本次要发的评论配图（本机临时路径，最多 3 张；发送时才上传云存储） */
    cImages: [],
    maxCImages: 3,
    /** 评论总条数（**含回复**），用于「全部评论（N）」和留言图标上的数字 */
    commentTotal: 0,
    /**
     * 「评论没能加载出来」的提示。
     * 用于「帖子卡片上显示有评论、点进来却一条都没有」——
     * 与其让用户以为评论被吞了，不如明确告诉他并给一个重试入口。
     */
    commentHint: '',
    /** 展开状态：顶层评论 id → true */
    expanded: {},
    liked: false,
    likeCount: 0,
    fav: false,
    isMine: false,
    input: '',
    replyTo: null,
    sending: false,
    focusInput: false
  },

  onLoad(opts) {
    this.setData({ id: Number(opts.id || 0) });
    this.fetch();
  },

  /**
   * 回到本页时静默对一次账。
   *
   * 别人可能刚评论/回复，也可能刚改了头像昵称（本项目每人各自改各自的）；
   * 而手里这份是进页面那一刻取的。从对方主页返回时对一次，
   * 就不会出现「明明刚刷新过还是旧的」。2 秒内不重复，避免和 onLoad 撞车。
   */
  onShow() {
    if (!this._loadedAt) return;
    if (Date.now() - this._loadedAt < 2000) return;
    this.fetch({ silent: true });
  },

  onPullDownRefresh() { this.fetch().then(() => wx.stopPullDownRefresh()); },

  retry() { this.setData({ loading: true, error: '' }); this.fetch(); },

  /**
   * 只重拉评论（不闪骨架屏）。
   *
   * 用于「帖子卡片上有 N 条评论、点进来一条都没有」的情况：
   * 那通常是这一次读没拿到数据，重试一次就好 —— 别让用户以为评论被吞了。
   */
  reloadComments() { this.setData({ commentHint: '' }); this.fetch(); },

  /**
   * 拉详情 + 评论。
   * @param {{silent?: boolean, retry?: number}} opts silent=true 用于后台对账：失败不提示、不打扰页面
   */
  async fetch(opts) {
    const o = opts || {};
    if (!this.data.id) return;
    try {
      const res = await api.get('/api/posts/' + this.data.id, {}, o.silent ? { silent: true } : undefined);
      this._loadedAt = Date.now();
      const p = res.post || {};
      // 两级结构在前端建：后端给两级（新）或扁平（旧）都能正确嵌套
      let roots = util.commentTree(res.comments).map((c) => Object.assign({}, c, {
        author: av(c.author),
        // 评论配图：老评论没有 images 字段 → 空数组（不需要数据迁移）
        images: (c.images || []).map(api.abs),
        replies: (c.replies || []).map((r) => Object.assign({}, r, {
          author: av(r.author),
          images: (r.images || []).map(api.abs)
        }))
      }));
      // 条数以**实际列出的条数**为准，保证「全部评论（N）」与列出来的条数一致
      let total = util.countComments(roots);
      let hint = '';

      /**
       * 「外面显示有评论、进来却一条都没有」。
       * 实测这是**读数据不稳定**（多实例/部署版本不一致）导致的，
       * 自动重试一次往往就好了 —— 试完仍为空才提示，并给「重新加载」入口。
       */
      const stored = Number(p.commentCount || 0);
      if (!roots.length && stored > 0 && !o.silent) {
        if (!o.retry) {
          const again = await this.fetch(Object.assign({}, o, { retry: 1 })).catch(() => null);
          return again;
        }
        hint = '评论没能加载出来（帖子显示有 ' + stored + ' 条）';
      }

      this.setData({
        // commentCount 也用**真实条数**：服务端可能是旧版（返回脏的存储值），
        // 而页面这里明明数得清列出来的条数 —— 用数得清的，数字与列表才一致
        post: Object.assign(p, { author: av(p.author), commentCount: total }),
        images: (p.images || []).map(api.abs),
        liked: !!p.liked,
        fav: !!p.isFavorite,
        likeCount: p.likeCount || 0,
        isMine: !!p.isMine,
        comments: this.withView(roots, this.data.expanded),
        commentTotal: total,
        commentHint: hint,
        loading: false,
        error: ''
      });
    } catch (e) {
      // 后台对账失败 → 悄悄算了，不要打断用户正在看的页面
      if (o.silent) return;
      // 首屏失败 → 留在本页显示原因 + 「重新加载」。
      // 原来是 setTimeout(navigateBack)，用户看到的是"页面自己退回去了"。
      this.setData({ loading: false, error: (e && e.message) || '加载失败，请重试' });
    }
  },

  /** 计算每条顶层评论要露出几条回复（默认 2 条，展开后全露） */
  withView(list, expanded) {
    const ex = expanded || {};
    return (list || []).map((c) => {
      const replies = c.replies || [];
      const visibleReplies = ex[c.id] ? replies : replies.slice(0, REPLY_PREVIEW);
      return Object.assign({}, c, {
        replies,
        visibleReplies,
        hiddenCount: replies.length - visibleReplies.length
      });
    });
  },

  /** 展开 / 收起某一楼的回复 */
  toggleReplies(e) {
    const id = Number(e.currentTarget.dataset.id || 0);
    if (!id) return;
    const expanded = Object.assign({}, this.data.expanded);
    if (expanded[id]) delete expanded[id];
    else expanded[id] = true;
    this.setData({ expanded, comments: this.withView(this.data.comments, expanded) });
  },

  /** 在两层里找一条评论（回复是针对二级评论发的，不能只找顶层） */
  findComment(id) {
    const n = Number(id);
    for (const c of this.data.comments) {
      if (c.id === n) return c;
      for (const r of (c.replies || [])) if (r.id === n) return r;
    }
    return null;
  },

  async onLike() {
    if (!app.guard()) return;
    try {
      const res = await api.post('/api/posts/' + this.data.id + '/like', {}, { silent: true });
      this.setData({ liked: res.liked, likeCount: res.likeCount });
    } catch (e) { /* 忽略 */ }
  },

  async onFav() {
    if (!app.guard()) return;
    try {
      const res = await api.post('/api/favorites/toggle', { targetType: 'post', targetId: this.data.id }, { silent: true });
      // ⚠️ 必须把返回的收藏状态写回 data —— 原实现只弹了个 toast，
      // 所以图标永远不变红、也永远取消不掉（视觉上"点了没反应"）。
      this.setData({ fav: !!res.favorited });
      wx.showToast({ title: res.favorited ? '已收藏' : '已取消收藏', icon: 'none' });
    } catch (e) { /* 已提示 */ }
  },

  previewImage(e) {
    wx.previewImage({ current: this.data.images[e.currentTarget.dataset.index], urls: this.data.images });
  },

  onInput(e) {
    /**
     * ⚠️ 必须用 setData，不能只写 `this.data.input = ...`。
     *
     * 只改 this.data 不会把数据推到视图层，WXML 里
     * `class="c-send {{input ? 'on' : ''}}"` 永远算出空字符串
     * → 发送按钮**永远保持灰色**，输入了字也不变红。
     */
    this.setData({ input: e.detail.value });
  },

  /**
   * 点某条评论（正文或「回复」）→ 把回复目标记下来，输入框自动聚焦。
   *
   * 两级评论都要能找到目标：点二级评论的「回复」是**回复那个人**，
   * 不是新开一条顶层评论（用户明确要求小红书那种"缩到被回复的人底下"）。
   */
  replyTo(e) {
    const id = Number(e.currentTarget.dataset.id || 0);
    if (!id) return;
    const c = this.findComment(id);
    if (!c) return;
    this.setData({
      replyTo: {
        id: c.id,
        name: (c.author && c.author.nickname) || '对方',
        // 它属于哪一楼：发完要自动展开那一楼，否则用户看不到自己刚发的回复
        rootId: c.rootId || c.id
      },
      focusInput: true
    });
  },

  cancelReply() { this.setData({ replyTo: null }); },

  /** 让某一楼的回复展开（发完回复后调用） */
  expandRootOf(rootId) {
    const id = Number(rootId || 0);
    if (!id || this.data.expanded[id]) return;
    const expanded = Object.assign({}, this.data.expanded);
    expanded[id] = true;
    this.setData({ expanded, comments: this.withView(this.data.comments, expanded) });
  },

  /**
   * 选评论配图（最多 3 张）。
   *
   * 这里只拿**本机临时路径**做预览，真正上传放在发送时（见 onSend）——
   * 用户选完又删掉的话，就不会白传一遍云存储。
   */
  chooseCommentImage() {
    const left = this.data.maxCImages - this.data.cImages.length;
    if (left <= 0) return wx.showToast({ title: '最多 ' + this.data.maxCImages + ' 张图', icon: 'none' });
    wx.chooseMedia({
      count: left,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (r) => {
        const paths = (r.tempFiles || []).map((f) => f.tempFilePath).filter(Boolean);
        if (!paths.length) return;
        this.setData({ cImages: this.data.cImages.concat(paths).slice(0, this.data.maxCImages) });
      }
    });
  },

  removeCommentImage(e) {
    const i = Number(e.currentTarget.dataset.i);
    const arr = this.data.cImages.slice();
    arr.splice(i, 1);
    this.setData({ cImages: arr });
  },

  previewPicked(e) {
    const i = Number(e.currentTarget.dataset.i);
    if (!this.data.cImages.length) return;
    wx.previewImage({ current: this.data.cImages[i], urls: this.data.cImages });
  },

  /** 点评论里的图 → 看大图（同一条评论的几张一起，可以左右划） */
  previewCommentImage(e) {
    const id = Number(e.currentTarget.dataset.id);
    const i = Number(e.currentTarget.dataset.i) || 0;
    const c = this.findComment(id);
    const urls = (c && c.images) || [];
    if (!urls.length) return;
    wx.previewImage({ current: urls[i] || urls[0], urls });
  },

  async onSend() {
    const content = String(this.data.input || '').trim();
    const picked = this.data.cImages.slice();
    // 文字和图片**有一个**就能发；两个都空才提示（纯图评论是正常需求）
    if (!content && !picked.length) {
      return wx.showToast({ title: '说点什么，或配张图', icon: 'none' });
    }
    if (this.data.sending) return;
    const targeting = this.data.replyTo;
    this.setData({ sending: true });
    try {
      /**
       * 配图先传云存储拿 fileID —— **不能直接把本机临时路径存库**。
       * 临时路径只在这台设备有效，别的手机打开就是一块白
       * （发帖那边踩过一模一样的坑，见 post-create.js 的注释）。
       */
      const imgs = [];
      for (const p of picked) imgs.push(await api.upload(p));

      await api.post('/api/posts/' + this.data.id + '/comments', {
        content, replyTo: targeting ? targeting.id : null, images: imgs
      }, { loading: true, silent: true });
      this.setData({ input: '', replyTo: null, focusInput: false, cImages: [] });
      wx.showToast({ title: targeting ? '回复成功' : '评论成功', icon: 'none' });
      /**
       * 发完**重新拉一次**，而不是把返回的那条 concat 到数组末尾。
       *
       * ① 回复要挂到"被回复的那条评论"下面。本地插一条得自己算层级，
       *    算错就变成"回复跑到外面成了一条普通评论"（用户反馈过这个现象）。
       * ② 顺便把别人的新评论、被回复者的最新头像昵称一起带回来。
       * 代价是多一次云函数调用，校园体量完全可接受 —— 换来"页面所见 = 服务端结构"。
       */
      await this.fetch({ silent: true });
      if (targeting) this.expandRootOf(targeting.rootId);
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '发送失败，请重试', icon: 'none' });
    }
    this.setData({ sending: false });
  },

  goAuthor() {
    const a = this.data.post && this.data.post.author;
    if (!a) return;
    if (a.isAI) return app.openChat({ peerId: a.id });
    wx.navigateTo({ url: '/pages/user/user?id=' + a.id });
  },

  /**
   * 点评论者的头像/昵称 → 进对方主页。
   *
   * 之前评论区的头像和昵称**没有任何点击事件**，
   * 用户明确要求「点击那些留言以及帖子那些人的头像可以进入他们的主页」。
   */
  goUser(e) {
    const id = Number(e.currentTarget.dataset.id || 0);
    if (!id) return;
    wx.navigateTo({ url: '/pages/user/user?id=' + id });
  },

  chatAuthor() {
    const a = this.data.post && this.data.post.author;
    if (!a) return;
    if (this.data.isMine) return wx.showToast({ title: '这是你自己的帖子', icon: 'none' });
    app.openChat({ peerId: a.id });
  },

  goCircle() {
    const c = this.data.post && this.data.post.circle;
    if (!c) return;
    wx.navigateTo({ url: '/pages/circle-detail/circle-detail?id=' + c.id });
  },

  goTopic(e) {
    wx.navigateTo({ url: '/pages/circle-detail/circle-detail?topic=' + encodeURIComponent(e.currentTarget.dataset.name) });
  },

  onReport() {
    if (!app.guard()) return;
    if (this.data.isMine) return this.onDelete();
    wx.showActionSheet({
      itemList: REPORT_ITEMS,
      success: async (r) => {
        try {
          await api.post('/api/reports', {
            targetType: 'post', targetId: this.data.id,
            reason: REPORT_ITEMS[r.tapIndex], detail: ''
          });
          wx.showToast({ title: '举报已提交', icon: 'none' });
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  onDelete() {
    wx.showModal({
      title: '删除帖子', content: '删除后无法恢复，确定继续？',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await api.del('/api/posts/' + this.data.id, {}, { loading: true });
          wx.showToast({ title: '已删除', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 700);
        } catch (e) { /* 已提示 */ }
      }
    });
  },

  onShareAppMessage() {
    const p = this.data.post || {};
    return {
      title: (p.content || '').slice(0, 30) || '校园圈子',
      path: '/pages/post-detail/post-detail?id=' + p.id,
      imageUrl: this.data.images[0] || ''
    };
  }
});
