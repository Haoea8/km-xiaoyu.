/**
 * 互动消息（点赞 / 评论 / 回复 / 收藏 / 想要 / 关注）
 *
 * 与「消息」页的分工（这是用户明确提的诉求）：
 *   - 消息页 = **私信 + AI 客服**（我和某个人的对话）
 *   - 本页   = 「**别人对我的内容做了什么**」，像抖音的消息页那样单独成框
 *
 * ★ 每行都自带 `link`（服务端 interactions.linkOf 生成），前端**不需要**知道
 *   「哪种互动该跳哪个页面」。这样「新增一种互动类型」只改后端一处，
 *   不会出现「前端跳错页 / 后端加了前端没跟上」的两边跑偏。
 *
 * ★ 匿名保护：校园墙的匿名评论，服务端会把 actor.id 置 0 并只下发匿名昵称。
 *   所以这里点头像不跳主页（跳了就等于把匿名的人公开了）。
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');

/** 每行头像右下角的小角标 —— 一眼看出是「赞」还是「评论」还是「关注」 */
const TYPE_ICON = {
  post_like: '👍', post_comment: '💬', comment_reply: '↩️', comment_like: '👍',
  wall_like: '👍', wall_comment: '💬', wall_comment_like: '👍',
  listing_fav: '⭐', listing_want: '🤝', post_fav: '⭐',
  resource_like: '👍', follow: '➕'
};

/** 「原帖 / 商品 / 墙贴」—— 有评论正文时，用它标出评论挂在哪个内容下面 */
const SRC_NAME = { post: '原帖', listing: '商品', wall: '墙贴', resource: '资料', user: '' };

const PAGE_SIZE = 20;

Page({
  data: {
    loading: true,
    logged: false,
    list: [],
    page: 1,
    hasMore: false,
    total: 0,
    unread: 0
  },

  onLoad() {
    this.onUserChange = () => {
      this.setData({ list: [], page: 1, hasMore: false, total: 0 });
      if (api.token()) this.load();
    };
    app.on('user', this.onUserChange);
  },

  onUnload() { app.off('user', this.onUserChange); },

  onShow() {
    const logged = !!api.token();
    this.setData({ logged });
    if (logged) this.load();
    else this.setData({ loading: false, list: [], total: 0 });
  },

  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(true); },

  /**
   * 拉列表。
   * @param {boolean} more true = 加载下一页（追加）
   */
  async load(more) {
    if (!api.token()) { this.setData({ loading: false, logged: false }); return; }
    const page = more ? this.data.page + 1 : 1;
    if (!more) this.setData({ loading: true });
    try {
      const res = await api.get('/api/interactions?page=' + page + '&pageSize=' + PAGE_SIZE, null, { silent: true });
      const rows = (res.list || []).map((r) => this.deco(r));
      if (!more) {
        /**
         * 「本次新增」高亮：进入页面会立刻把服务端未读清零（红点要马上消失），
         * 所以要先记下「哪些是刚看到的未读」，否则一进来全是已读样式，
         * 用户根本不知道自己刚才错过了什么。
         */
        const newIds = (res.list || []).filter((r) => !r.read).map((r) => r.id);
        rows.forEach((x) => { if (newIds.indexOf(x.id) > -1) x.isNew = true; });
        if (newIds.length) {
          /**
           * 先本地清零，再上报。顺序很重要：
           * 等 POST 回来才清，用户已经看到「红点闪一下还在」；
           * 而且 POST 若因网络慢/失败，红点就真的留下来了。
           * 服务端 markRead 失败最多是多红一次未读，比「点进去也不消」体验好。
           */
          app.setInteractionUnread(0);
          api.post('/api/interactions/read', {}, { silent: true })
            .then(() => app.setInteractionUnread(0))
            .catch(() => { /* 失败也不影响浏览 */ });
        } else {
          app.setInteractionUnread(0);
        }
      }
      this.setData({
        list: more ? this.data.list.concat(rows) : rows,
        page: res.page || page,
        hasMore: !!res.hasMore,
        total: res.total || 0,
        unread: res.unread || 0,
        loading: false
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  /** 服务端返回的一行 → 视图用的字段（图像地址、头像字标、文案拼装都在这里） */
  deco(r) {
    const actor = r.actor || {};
    const content = String(r.content || '');
    const title = String(r.title || '');
    const srcName = SRC_NAME[r.targetType] || '';
    return {
      id: r.id,
      icon: TYPE_ICON[r.type] || '🔔',
      actorId: Number(actor.id) || 0,
      actorName: actor.nickname || '有用户',
      avatar: api.abs(actor.avatar || ''),
      av: util.avatarFallback(actor),
      typeText: r.typeText || '有新互动',
      preview: content || title,
      // 既知道评论内容、又知道它挂在哪条内容下时，补一行来源
      sub: (content && title && srcName) ? (srcName + '：' + title) : '',
      thumb: api.abs(r.image || ''),
      timeText: r.timeText || util.relTime(r.createdAt),
      link: r.link || '',
      isNew: false
    };
  },

  /** 点整行 → 去互动发生的地方（帖子 / 商品 / 墙贴 / 资料 / 对方主页） */
  open(e) {
    const row = this.data.list[Number(e.currentTarget.dataset.i)];
    if (!row) return;
    if (!row.link) { wx.showToast({ title: '内容可能已被删除', icon: 'none' }); return; }
    wx.navigateTo({
      url: row.link,
      fail: () => wx.showToast({ title: '内容可能已被删除', icon: 'none' })
    });
  },

  /**
   * 点头像 → 去对方主页。
   * actorId 为 0 说明是**匿名互动**（校园墙匿名评论）：直接不响应，
   * 否则等于把匿名的人公开了。
   */
  openActor(e) {
    const uid = Number(e.currentTarget.dataset.uid) || 0;
    if (!uid) return;
    wx.navigateTo({ url: '/pages/user/user?id=' + uid });
  },

  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); }
});
