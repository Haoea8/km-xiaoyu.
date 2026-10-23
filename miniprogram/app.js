/**
 * 科贸小鱼 · 全局逻辑（云开发版）
 * 负责：云环境初始化、登录态、用户信息、实时订阅、全局事件总线、未读汇总
 */
const api = require('./utils/api');
const rt = require('./utils/ws');
const util = require('./utils/util');
const { CLOUD_ENV } = require('./utils/config');

App({
  globalData: {
    statusBarHeight: 20,
    navBarHeight: 64,
    capsule: null,
    user: null,
    unread: 0,
    /**
     * 互动消息未读（点赞/评论/回复/收藏/关注，见 pages/interaction）。
     * 与私信未读分开存：消息页要分别显示两个入口的红点，
     * 而底部 tab 角标要的是**两者之和**（见 totalUnread）。
     */
    interactionUnread: 0,
    unreadAi: 0,
    aiConvId: null,
    /** 最近一次的会话消息（供聊天页消费） */
    lastIncoming: null,
    cloudReady: false,
    cloudDataReady: false,
    initRunning: false,
    booting: false,
    envId: CLOUD_ENV
  },

  listeners: {},

  on(event, fn) {
    (this.listeners[event] = this.listeners[event] || []).push(fn);
  },
  off(event, fn) {
    const arr = this.listeners[event];
    if (!arr) return;
    if (!fn) { delete this.listeners[event]; return; }
    const i = arr.indexOf(fn);
    if (i > -1) arr.splice(i, 1);
  },
  emit(event, payload) {
    const arr = this.listeners[event];
    if (arr) arr.slice().forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } });
  },

  onLaunch() {
    this.setupMetrics();
    this.setupCloud();
    api.init();

    // 实时层事件
    rt.on('convUpdate', (payload) => {
      this.emit('convUpdate', payload);
      this.refreshUnread();
    });
    rt.on('message', (payload) => {
      this.globalData.lastIncoming = payload;
      this.emit('message', payload);
      this.refreshUnread();
    });
    rt.on('sysNotice', (payload) => this.emit('sysNotice', payload));

    // 数据初始化（云函数按每次一个集合分片推进，这里循环加速）
    this.ensureCloudData();

    // 已登录则静默拉取资料
    if (api.token()) this.bootstrap();

    // 检查是否有新版本可用（换了体验版后，用户端不会自动用上新代码）
    this.checkUpdate();
  },

  /**
   * 检查并应用小程序新版本。
   *
   * 为什么需要：上传新体验版后，微信的默认策略是「下次冷启动」才用新代码，
   * 于是很容易遇到「明明传了新版本，别人手机上还是旧的」。
   * 这里主动检查，新版下载完成后提示重启，点一下立即生效。
   *
   * 注意：开发者工具里通常不触发（工具是实时编译的），只有真机有效。
   */
  checkUpdate() {
    try {
      if (!wx.getUpdateManager) return;
      const um = wx.getUpdateManager();
      um.onUpdateReady(() => {
        wx.showModal({
          title: '发现新版本',
          content: '新版本已准备好，重启后生效。是否立即重启？',
          confirmText: '立即重启',
          cancelText: '稍后',
          success: (r) => { if (r.confirm) um.applyUpdate(); }
        });
      });
      um.onUpdateFailed(() => {
        wx.showModal({
          title: '更新失败',
          content: '新版本下载失败。请删除本小程序后重新打开，即可加载最新版本。',
          showCancel: false
        });
      });
    } catch (e) { /* 非关键路径，失败静默 */ }
  },

  /**
   * 确保云端演示数据就绪。
   *
   * 背景：云函数默认超时 3 秒，全量初始化（建 23 集合 + 写约 290 条）一次做不完，
   * 因此云端按「集合」分片推进。云函数内部每次调用会尽量在 2.2 秒预算内多推几步，
   * 这里循环调用若干轮直到云端返回 done。
   *
   * 不阻塞启动：调用方不 await；失败静默（用户正常操作也会逐步推进）。
   */
  async ensureCloudData() {
    if (this.globalData.initRunning) return;
    this.globalData.initRunning = true;
    try {
      for (let i = 0; i < 20; i++) {
        const r = await api.post('/api/_setup', {}, { silent: true }).catch(() => null);
        if (!r) break;
        if (r.done) {
          this.globalData.cloudDataReady = true;
          this.emit('cloudDataReady', r);
          console.log('[init] 云端数据就绪', r.verify || '');
          break;
        }
      }
    } catch (e) {
      console.warn('[init] 数据初始化中断', e && e.message);
    } finally {
      this.globalData.initRunning = false;
    }
  },

  onShow() {
    if (!api.token()) return;
    if (!this.globalData.user) return this.bootstrap();
    /**
     * 每次回到前台都顺手刷一次「我」的资料（**节流 5 分钟**）。
     *
     * 为什么必须刷：头像/昵称是服务端签发的**临时 https**，有效期过了图就 403 ——
     * 而 globalData.user 是登录时缓存的那一份，可能已经挂了大半天。
     * 表现就是「聊天页/我的页 自己的头像变成字标」，别人头像却正常（人家是刚拉的）。
     * 这是全局唯一的一份「我」，刷这里等于所有页面一起修好。
     */
    this.refreshMe();
  },

  /**
   * 重新拉一次「我」的资料。
   * @param {boolean} force 忽略节流（改完头像/昵称后调用）
   */
  async refreshMe(force) {
    if (!api.token()) return null;
    const now = Date.now();
    if (!this._meAt) this._meAt = 0;
    if (!force && now - this._meAt < 5 * 60 * 1000) return this.globalData.user;
    this._meAt = now;
    try {
      const res = await api.get('/api/me', null, { silent: true });
      if (res && res.user) this.setUser(res.user);
      return res && res.user;
    } catch (e) {
      // 失败就沿用旧资料：不能因为刷新失败把用户踢下线
      return this.globalData.user;
    }
  },

  /** 初始化云开发环境 */
  setupCloud() {
    if (!wx.cloud) {
      console.error('[cloud] 当前基础库不支持云开发，请使用 2.2.3 以上版本');
      return;
    }
    try {
      wx.cloud.init({ env: CLOUD_ENV, traceUser: true });
      this.globalData.cloudReady = true;
      console.log('[cloud] 云开发环境已初始化:', CLOUD_ENV);
    } catch (e) {
      console.error('[cloud] 初始化失败', e);
    }
  },

  setupMetrics() {
    const g = this.globalData;
    // 优先用新接口，避免 wx.getSystemInfoSync 的废弃告警
    try {
      if (wx.getWindowInfo) {
        const info = wx.getWindowInfo();
        g.statusBarHeight = info.statusBarHeight || 20;
        g.windowWidth = info.windowWidth;
        g.windowHeight = info.windowHeight;
        if (!g.windowWidth || !g.windowHeight) throw new Error('empty');
      } else {
        const info = wx.getSystemInfoSync();
        g.statusBarHeight = info.statusBarHeight || 20;
        g.windowWidth = info.windowWidth;
        g.windowHeight = info.windowHeight;
      }
    } catch (e) {
      g.statusBarHeight = g.statusBarHeight || 20;
    }

    try {
      const rect = wx.getMenuButtonBoundingClientRect();
      if (rect && rect.height) {
        const gap = Math.max(4, rect.top - g.statusBarHeight);
        g.capsule = rect;
        g.navBarHeight = gap * 2 + rect.height;
      }
    } catch (e) {
      g.navBarHeight = g.navBarHeight || 64;
    }
  },

  /** 启动后：拉资料 + 开启实时订阅 */
  async bootstrap() {
    if (this.globalData.booting) return;
    this.globalData.booting = true;
    try {
      const res = await api.get('/api/me', null, { silent: true });
      this.setUser(res.user);
      this._meAt = Date.now();
      rt.connect();
      this.refreshUnread();
    } catch (e) {
      // 只有服务端明确否定身份（401）才清登录态。
      // 超时/网络错误必须保留 token，否则会把已登录用户误踢下线。
      if (e && e.code === 401) {
        api.clearToken();
        this.globalData.user = null;
        this.emit('user', null);
      }
    } finally {
      this.globalData.booting = false;
    }
  },

  setUser(user) {
    this.globalData.user = user;
    this.emit('user', user);
    const pages = getCurrentPages();
    const top = pages[pages.length - 1];
    if (top && typeof top.onUserChange === 'function') top.onUserChange(user);
  },

  /** 登录成功后的统一入口 */
  async afterLogin(user) {
    this.setUser(user);
    rt.connect();
    await this.refreshUnread();
  },

  /** 退出登录 */
  async logout() {
    try { await api.post('/api/logout', {}, { silent: true }); } catch (e) { /* 忽略 */ }
    api.clearToken();
    rt.close();
    this.globalData.user = null;
    this.globalData.unread = 0;
    this.globalData.interactionUnread = 0;
    this.setBadge();
    this.emit('user', null);
  },

  /**
   * 底部 tab 角标要显示的**总数**。
   *
   * 为什么要有这个函数：角标现在汇总了两类未读（私信 + 互动消息），
   * 而项目里读 `globalData.unread` 的地方有好几处（tabbar 组件、消息页、
   * 我的页）。如果每处各自相加，漏掉一处就是「消息页有红点、底部没有」
   * 这类对不上的怪现象 —— 所以统一从这里取。
   */
  totalUnread() {
    return (this.globalData.unread || 0) + (this.globalData.interactionUnread || 0);
  },

  /**
   * 更新互动消息未读数。
   *
   * 互动消息页在「进入即清零」之后会调它 —— 不这样做的话，用户看完出来，
   * 底部 tab 还挂着旧角标，直到下一次轮询才发现（那几秒看起来就是 bug）。
   */
  setInteractionUnread(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v === (this.globalData.interactionUnread || 0)) return;
    this.globalData.interactionUnread = v;
    this.setBadge();
  },

  /** 未读数汇总（会话列表 + 互动消息） */
  async refreshUnread() {
    // 未登录时必须把未读与角标一并清掉。
    // 否则会残留上一次登录的红点 —— 表现为「消息页显示『登录后查看消息』，
    // 但底部消息 tab 还挂着一个红点」，看起来像出了 bug。
    if (!api.token()) {
      if (this.globalData.unread || this.globalData.unreadAi || this.globalData.interactionUnread) {
        this.globalData.unread = 0;
        this.globalData.unreadAi = 0;
        this.globalData.interactionUnread = 0;
        this.globalData.aiConvId = null;
        this.setBadge();
      }
      return;
    }
    try {
      const res = await api.get('/api/conversations', null, { silent: true });
      const list = res.list || [];
      const aiConv = list.find((c) => c.peer && c.peer.isAI);
      this.globalData.unread = list.reduce((s, c) => s + (c.unread || 0), 0);
      // 互动未读由本接口顺带下发（同一个接口拿全，少一次请求、也少一次对不上的机会）
      this.globalData.interactionUnread = res.interactionUnread || 0;
      this.globalData.unreadAi = aiConv ? aiConv.unread : 0;
      this.globalData.aiConvId = aiConv ? aiConv.id : null;
      this.setBadge();
      this.emit('unread', this.globalData.unread);
    } catch (e) { /* 静默 */ }
  },

  setBadge() {
    const total = this.totalUnread();
    try {
      if (total > 0) wx.setTabBarBadge({ index: 2, text: total > 99 ? '99+' : String(total) });
      else wx.removeTabBarBadge({ index: 2 });
    } catch (e) { /* 非 tab 页忽略 */ }
    // 每个 tab 页面各有一个 tabBar 实例，这里只能同步「当前」那个；
    // 其余实例由组件在 pageLifetimes.show 里自行 syncUnread。
    if (this.tabbar) {
      if (typeof this.tabbar.setUnread === 'function') this.tabbar.setUnread(total);
      else this.tabbar.setData({ unread: total });
    }
  },

  /**
   * 统一同步底部 tabBar 的高亮与未读数。
   * 页面在 onShow 里调用：app.syncTabBar(this, 'mine')
   *
   * 为什么按 key 而不是下标：自定义 tabBar 中间插了「发布」按钮，
   * 视觉顺序与 app.json 的 tabBar.list 下标不一致，传下标必然错位。
   */
  syncTabBar(page, key) {
    if (!page || !page.getTabBar) return;
    const tb = page.getTabBar();
    if (!tb) return;
    if (typeof tb.setActive === 'function') tb.setActive(key);
    tb.setData({ unread: this.totalUnread() });
  },

  /** 打开聊天（统一入口，自动处理登录与 AI 会话） */
  async openChat(opts) {
    const { peerId, listingId, sendCard } = opts || {};
    if (!api.token()) { wx.navigateTo({ url: '/pages/login/login' }); return; }
    try {
      wx.showLoading({ title: '进入会话', mask: true });
      const res = await api.post('/api/conversations/open', { peerId, listingId, sendCard }, { silent: true });
      wx.hideLoading();
      // 可选：进会话前先替用户发一条消息（提醒发货 / 催付款这种一键动作）
      if (opts && opts.text) {
        try {
          await api.post('/api/conversations/' + res.conversation.id + '/messages', { type: 'text', content: opts.text }, { silent: true });
        } catch (e) { /* 发送失败不挡跳转，用户仍能看到会话 */ }
      }
      const peer = res.conversation.peer || {};
      wx.navigateTo({
        url: '/pages/chat/chat?id=' + res.conversation.id +
          '&name=' + encodeURIComponent(peer.nickname || '聊天') +
          (peer.isAI ? '&ai=1' : '')
      });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '进入会话失败', icon: 'none' });
    }
  },

  /** 需要登录的操作统一守卫 */
  guard() {
    if (api.token()) return true;
    wx.showModal({
      title: '还没登录',
      content: '登录后即可使用完整功能，是否现在登录？',
      confirmText: '去登录',
      cancelText: '再逛逛',
      success: (r) => { if (r.confirm) wx.navigateTo({ url: '/pages/login/login' }); }
    });
    return false;
  },

  toast(title) { wx.showToast({ title, icon: 'none' }); },
  money(fen) { return util.fmtPrice(fen); }
});
