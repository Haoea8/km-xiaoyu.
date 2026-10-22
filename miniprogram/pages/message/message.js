/**
 * 消息中心：AI 客服入口 + 会话列表（实时刷新）
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');
const ws = require('../../utils/ws');

Page({
  data: {
    loading: true,
    logged: false,
    list: [],
    aiConv: null,
    people: [],
    unreadTotal: 0,
    /** 互动消息未读（点赞/评论/收藏/关注）——「互动消息」入口自己的红点 */
    interactionUnread: 0,
    connected: false
  },

  onLoad() {
    this.onMsg = (payload) => {
      if (!payload || !payload.message) return;
      this.bumpConv(payload.convId, payload.message);
    };
    this.onReadEvt = () => { this.load(true); };
    this.onConnected = () => this.setData({ connected: true });
    this.onUnread = () => this.load(true);
    app.on('message', this.onMsg);
    app.on('read', this.onReadEvt);
    app.on('wsConnected', this.onConnected);
    app.on('unread', this.onUnread);
  },
  onUnload() {
    this.stopPoll();
    app.off('message', this.onMsg);
    app.off('read', this.onReadEvt);
    app.off('wsConnected', this.onConnected);
    app.off('unread', this.onUnread);
  },

  onShow() {
    app.syncTabBar(this, 'message');
    const logged = !!api.token();
    this.setData({ connected: ws.isConnected(), logged });
    if (!logged) {
      this.stopPoll();
      this.setData({ loading: false, list: [], people: [], aiConv: null, interactionUnread: 0 });
      return;
    }
    this.load();
    this.startPoll();
  },

  /** 离开页面就停掉轮询（tab 页不会销毁，必须显式停，否则切走了还在打请求） */
  onHide() { this.stopPoll(); },

  /**
   * 互动消息的未读**没有实时推送通道**（私信才走 ws），
   * 所以本页可见时轻量轮询一下未读数 —— 否则别人刚给你点了赞，
   * 要等到下次进这个页面才会出现红点，用户会觉得「没有通知」。
   * 只取一个数字，开销很小（GET /api/interactions/unread）。
   */
  startPoll() {
    this.stopPoll();
    this.pollTimer = setInterval(async () => {
      if (!api.token()) return;
      try {
        const r = await api.get('/api/interactions/unread', null, { silent: true });
        const n = (r && r.unread) || 0;
        if (n !== this.data.interactionUnread) {
          this.setData({ interactionUnread: n });
          app.setInteractionUnread(n);
        }
      } catch (e) { /* 静默：轮询失败不打扰用户 */ }
    }, 10000);
  },
  stopPoll() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  },

  /**
   * 账号变化（登录 / 退出 / 换号）时，必须丢掉上一账号的会话缓存。
   *
   * 否则用户换号后立刻点「AI 客服」，用的还是旧账号的会话 id，
   * 后端会以「会话不存在」拒绝 —— 看起来就像数据丢了。
   */
  onUserChange() {
    this.setData({ list: [], people: [], aiConv: null, unreadTotal: 0, interactionUnread: 0 });
    if (api.token()) this.load(true);
  },

  onPullDownRefresh() { this.load(true).then(() => wx.stopPullDownRefresh()); },

  async load(silent) {
    if (!silent) this.setData({ loading: true });
    try {
      const res = await api.get('/api/conversations', null, { silent: !!silent });
      const list = (res.list || []).map((c) => this.deco(c));
      const aiConv = list.find((c) => c.peer && c.peer.isAI) || null;
      const unreadTotal = res.unreadTotal || 0;
      const interactionUnread = res.interactionUnread || 0;
      this.setData({
        list, aiConv,
        people: list.filter((c) => !(c.peer && c.peer.isAI)),
        unreadTotal,
        interactionUnread,
        loading: false
      });
      // 与底部 tab 角标保持一致：这里拿到的是最新数据，
      // 若不回写全局，就会出现「AI 那行显示 1、底部 tab 却没有角标」的错乱。
      // 角标 = 私信 + 互动，所以两个数都要回写（接口一次都给了）。
      if ((app.globalData.unread || 0) !== unreadTotal ||
        (app.globalData.interactionUnread || 0) !== interactionUnread) {
        app.globalData.unread = unreadTotal;
        app.globalData.interactionUnread = interactionUnread;
        app.setBadge();
      }
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  deco(c) {
    const peer = c.peer || {};
    return Object.assign({}, c, {
      peerAvatar: api.abs(peer.avatar || ''),
      peerName: peer.nickname || '用户',
      initial: (peer.nickname || '用')[0],
      isAI: !!peer.isAI,
      lastMessage: c.lastMessage || (peer.isAI ? '有疑问随时问我～' : '打个招呼吧'),
      timeText: c.timeText || util.relTime(c.lastTime)
    });
  },

  /** 新消息把会话顶到列表最前 */
  bumpConv(convId, msg) {
    const myId = app.globalData.user && app.globalData.user.id;
    // 身份还没到位时不要猜：myId 为 undefined 会让 mine 恒为 false，
    // 于是「自己发的消息」也被算成未读，凭空多出红点。
    // 这种情况直接走一次服务端拉取，让计数以服务端为准。
    if (!myId) { this.load(true); return; }
    const list = this.data.list.slice();
    const i = list.findIndex((c) => c.id === Number(convId));
    if (i < 0) { this.load(true); return; }
    const c = list.splice(i, 1)[0];
    const mine = msg.senderId === myId;
    c.lastMessage =
      msg.type === 'listing' ? '[商品] ' + ((msg.card && msg.card.title) || '')
        : msg.type === 'listings' ? '[为你推荐]'
          : msg.type === 'order' ? '[订单] ' + ((msg.card && msg.card.title) || '')
            : msg.type === 'system' ? '[通知] ' + (msg.content || '')
              : msg.type === 'image' ? '[图片]'
                : msg.content || '';
    c.lastTime = msg.createdAt || Date.now();
    c.timeText = '刚刚';
    let delta = 0;
    if (!mine) { c.unread = (c.unread || 0) + 1; delta = 1; }
    list.unshift(c);
    this.setData({
      list,
      aiConv: list.find((x) => x.peer && x.peer.isAI) || null,
      people: list.filter((x) => !(x.peer && x.peer.isAI)),
      // 局部自增的同时也要同步总数，否则会出现
      // 「AI 那一行显示 4、底部 tab 显示 1」这种对不上的情况
      unreadTotal: (this.data.unreadTotal || 0) + delta
    });
    if (delta) {
      app.globalData.unread = this.data.unreadTotal;
      app.setBadge();
    }
  },

  open(e) {
    const c = this.data.list.find((x) => x.id === Number(e.currentTarget.dataset.id));
    if (!c) return;
    wx.navigateTo({
      url: '/pages/chat/chat?id=' + c.id + '&name=' + encodeURIComponent(c.peerName) + (c.isAI ? '&ai=1' : '')
    });
  },

  /** 互动消息入口：点赞 / 评论 / 回复 / 收藏 / 想要 / 关注（独立页面 pages/interaction） */
  openInteraction() {
    if (!app.guard()) return;
    wx.navigateTo({ url: '/pages/interaction/interaction' });
  },

  openAi() {
    const ai = this.data.aiConv;
    // 会话 id 必须存在才直接跳转；否则走统一入口重新开一次会话，
    // 避免拼出 ?id=undefined 导致聊天页报「会话不存在」
    if (ai && ai.id) return wx.navigateTo({ url: '/pages/chat/chat?id=' + ai.id + '&name=' + encodeURIComponent(ai.peerName) + '&ai=1' });
    if (!app.guard()) return;
    app.openChat({});
  },

  openUser(e) {
    const id = e.currentTarget.dataset.uid;
    if (!id) return;
    wx.navigateTo({ url: '/pages/user/user?id=' + id });
  },

  delConv(e) {
    const id = Number(e.currentTarget.dataset.id);
    wx.showModal({
      title: '删除会话',
      content: '仅从列表中移除（聊天记录仍保留在服务器）。',
      success: (r) => {
        if (!r.confirm) return;
        const list = this.data.list.filter((c) => c.id !== id);
        this.setData({
          list,
          people: list.filter((c) => !(c.peer && c.peer.isAI)),
          aiConv: list.find((c) => c.peer && c.peer.isAI) || null
        });
        wx.showToast({ title: '已移除', icon: 'none' });
      }
    });
  },

  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); }
});
