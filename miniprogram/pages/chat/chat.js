/**
 * 聊天页：真人实时对话 / AI 客服
 * 参数：id（会话 id）、name（对方昵称）、ai=1
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');
const ws = require('../../utils/ws');
const { QUICK_WORDS, AI_QUICK } = require('../../utils/const');

const EMOJIS = ['😀', '😂', '🥹', '😍', '🤔', '😎', '🥳', '😭', '👍', '🙏', '🔥', '❤️', '🎉', '💰', '📦', '🚀', '😅', '🤝', '✨', '🍜'];

const REPORT_ITEMS = ['辱骂骚扰', '涉嫌诈骗', '发送垃圾广告', '其他违规'];

Page({
  data: {
    statusBar: 20,
    navBar: 44,
    convId: 0,
    peerId: 0,
    name: '聊天',
    peerAvatar: '',
    /**
     * 头像为空时的「字标」兜底（昵称首字 + 底色），见 util.avatarFallback。
     *
     * 只绑 <image src> 是不够的：src 为空、或图片 403/被清理时，
     * <image> 会渲染成一个灰白方块 —— 用户看到的就是「头像显示不出来」。
     * 所以模板是「图片 + 字标」双层：图片在且没报错才显示。
     */
    peerAvatarLetter: '',
    peerAvatarBg: '#E6E9ED',
    peerAvatarFg: '#8A9099',
    peerAvatarErr: false,

    /** 我自己的头像（用于「我发的消息」那一侧；此前只有对方头像，我这边是空的） */
    myAvatar: '',
    myAvatarLetter: '',
    myAvatarBg: '#E6E9ED',
    myAvatarFg: '#8A9099',
    myAvatarErr: false,
    isAI: false,

    loading: true,
    messages: [],
    scrollInto: '',
    hasMore: false,
    loadingMore: false,
    bottomPx: 56,

    input: '',
    showMore: false,
    showEmoji: false,
    showQuick: false,

    quickWords: QUICK_WORDS,
    aiQuick: AI_QUICK,
    emojis: EMOJIS,

    typing: false,
    myListings: [],
    sending: false
  },

  onLoad(opts) {
    const convId = Number(opts.id || 0);
    const name = decodeURIComponent(opts.name || '聊天');
    this.setData({
      statusBar: app.globalData.statusBarHeight,
      navBar: app.globalData.navBarHeight,
      convId, name,
      isAI: opts.ai === '1'
    });
    this.initEvents();
    if (!convId) {
      this.setData({ loading: false });
      return wx.showToast({ title: '会话不存在', icon: 'none' });
    }
    this.syncMyAvatar();
    this.load(true);
    this.markRead();
    this.startWatching();
  },

  /**
   * 开启消息订阅 + 轮询兜底。
   *
   * watch() 是云数据库实时推送，但它依赖集合权限允许客户端读取；
   * 而消息是云函数以管理员身份写入的，默认权限下客户端很可能读不到。
   * 因此**无论 watch 是否建立成功，都同时开启轮询**：
   *   - watch 生效时：新消息几乎实时（体验最好）
   *   - watch 失效时：轮询保证消息不丢（3 秒内到达）
   * 两条路并存，靠 pullNew 的 id 去重，不会重复显示。
   */
  startWatching() {
    try {
      ws.watchMessages(this.data.convId);
    } catch (e) {
      console.warn('[chat] watch 建立失败，仅用轮询', e && e.message);
    }
    // 兜底轮询：始终启动
    this.startPolling();
  },

  /** 轮询拉取新消息 */
  startPolling() {
    if (this.polling) return;
    this.polling = true;
    this.pollTimer2 = setInterval(() => {
      this.pullNew();
    }, 3000);
  },

  stopPolling() {
    this.polling = false;
    if (this.pollTimer2) { clearInterval(this.pollTimer2); this.pollTimer2 = null; }
  },

  /**
   * 最后一条「已落库」的消息。
   *
   * 必须跳过乐观上屏的临时消息（id 形如 tmp-123）：
   * 若拿它当 afterId 传给后端，util.num('tmp-123') 得到 NaN，
   * 增量条件失效，轮询会退化成「每次重拉最新一页」。
   */
  lastRealMsg() {
    const list = this.data.messages;
    for (let i = list.length - 1; i >= 0; i--) {
      if (typeof list[i].id === 'number') return list[i];
    }
    return null;
  },

  /**
   * 拉取比本地最新一条更新的消息。
   * 返回是否有新增 —— 调用方（等待 AI 回复）需要据此判断要不要继续等。
   */
  async pullNew() {
    const last = this.lastRealMsg();
    /**
     * 增量游标要**同时**带上 id 和 createdAt：
     *   - afterId：兼容旧后端（也能覆盖「同一实例顺序递增」的常见情况）
     *   - afterAt：真正的游标。多实例下 id 不随时间单调，别的实例刚写进来的
     *     消息 id 可能**比游标更小** → 只按 id 拉永远拉不到它，
     *     表现为「对方发的消息要退出重进才出现 / 接收不同步」。
     * 后端会以 afterAt 为准（留 2 秒重叠，重复的按 id 去重，不会重复显示）。
     */
    const at = last ? this.sortT(last) : 0;
    const q = '/api/conversations/' + this.data.convId + '/messages?limit=50' +
      (last ? '&afterId=' + last.id : '') +
      (at ? '&afterAt=' + at : '');
    const res = await api.get(q, null, { silent: true }).catch(() => null);
    if (!res || !res.list || !res.list.length) return false;
    // 走统一的合并入口：即便这次响应比已有数据旧，也只会补，不会删
    const r = this.applyMessages(res.list);
    if (!r.added) return false;
    // 收到对方（含 AI）消息就收起「正在输入」（已读上报由 applyMessages 统一处理）
    if (r.gotPeer && this.data.typing) this.setData({ typing: false });
    return true;
  },

  onUnload() {
    app.off('message', this.onMsg);
    app.off('typing', this.onTyping);
    app.off('read', this.onReadEvt);
    app.off('user', this.onUser);
    clearTimeout(this.typingTimer);
    clearTimeout(this.pollTimer);
    this.stopPolling();
    ws.closeMessages();
  },

  initEvents() {
    this.onMsg = (payload) => {
      if (!payload || Number(payload.convId) !== this.data.convId) return;
      this.appendMsg(payload.message);
      const myId = app.globalData.user && app.globalData.user.id;
      if (payload.message.senderId !== myId) this.markRead();
    };
    this.onTyping = (payload) => {
      if (!payload || Number(payload.convId) !== this.data.convId) return;
      this.setData({ typing: true });
      clearTimeout(this.typingTimer);
      this.typingTimer = setTimeout(() => this.setData({ typing: false }), 2600);
    };
    this.onReadEvt = (payload) => {
      if (!payload || Number(payload.convId) !== this.data.convId) return;
      const myId = app.globalData.user && app.globalData.user.id;
      if (payload.by !== myId) {
        this.setData({ messages: this.data.messages.map((m) => Object.assign({}, m, { read: true })) });
      }
    };
    // 用户信息到达后必须重算「哪条是我发的」。
    // 冷启动时 load() 可能比 app.bootstrap() 先返回，此时 globalData.user 还是 null，
    // myId 会算成 0 —— 于是自己发的消息全被判成对方的，
    // 渲染到左边、配上对方头像，看起来就像「我问的那句丢了」。
    this.onUser = () => this.redecoAll();
    app.on('message', this.onMsg);
    app.on('typing', this.onTyping);
    app.on('read', this.onReadEvt);
    app.on('user', this.onUser);
  },

  /** app.js 的 setUser 会回调当前页面的 onUserChange（与上面的 'user' 事件双保险） */
  onUserChange() { this.redecoAll(); },

  /**
   * 用户信息可用后，用正确的 myId 重算所有已落库消息的 mine。
   * 临时消息的 mine 恒为 true，不需要重算。
   */
  /**
   * 同步「我的头像」。
   *
   * 我发的消息此前完全没有头像（模板里只有 `wx:if="{{!item.mine}}"` 的对方头像），
   * 而样式 `.msg-row.mine { flex-direction: row-reverse }` 本就是给「我这侧带头像」准备的。
   * 用户信息可能比 load() 晚到，所以除了首屏，用户信息到达时也要补一次。
   */
  syncMyAvatar() {
    const u = app.globalData.user || {};
    const av = api.abs(u.avatar || '');
    const fb = util.avatarFallback(u);
    const patch = {};
    if (av !== this.data.myAvatar) { patch.myAvatar = av; patch.myAvatarErr = false; }
    if (fb.letter !== this.data.myAvatarLetter) patch.myAvatarLetter = fb.letter;
    if (fb.bg !== this.data.myAvatarBg) patch.myAvatarBg = fb.bg;
    if (fb.fg !== this.data.myAvatarFg) patch.myAvatarFg = fb.fg;
    if (Object.keys(patch).length) this.setData(patch);
  },

  /** 同步对方头像（同样带字标兜底；AI 客服通常没有头像，字标正好顶住） */
  syncPeerAvatar(peer) {
    const p = peer || {};
    const av = api.abs(p.avatar || '');
    const fb = util.avatarFallback(p);
    const patch = {};
    if (av !== this.data.peerAvatar) { patch.peerAvatar = av; patch.peerAvatarErr = false; }
    if (fb.letter !== this.data.peerAvatarLetter) patch.peerAvatarLetter = fb.letter;
    if (fb.bg !== this.data.peerAvatarBg) patch.peerAvatarBg = fb.bg;
    if (fb.fg !== this.data.peerAvatarFg) patch.peerAvatarFg = fb.fg;
    if (Object.keys(patch).length) this.setData(patch);
  },

  /** 头像图片加载失败（空 key / 临时链接过期 / 文件被清）→ 退回字标 */
  onMyAvatarErr() { this.setData({ myAvatarErr: true }); },
  onPeerAvatarErr() { this.setData({ peerAvatarErr: true }); },

  redecoAll() {
    const myId = (app.globalData.user && app.globalData.user.id) || 0;
    if (!myId) return;
    this.syncMyAvatar();
    let changed = false;
    const list = this.data.messages.map((m) => {
      if (typeof m.id !== 'number') return m;       // 临时消息跳过
      if (m.mine === (m.senderId === myId)) return m; // 已经正确
      changed = true;
      return this.deco(m, myId);
    });
    if (changed) this.setData({ messages: list });
  },

  /**
   * 等用户信息就绪（最多 ms 毫秒）。
   * 用于 load()：宁可多等一会儿，也不要用 myId=0 渲染出一屏"对方消息"。
   */
  waitUser(ms) {
    if (app.globalData.user) return Promise.resolve(app.globalData.user);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (app.globalData.user || Date.now() - t0 > ms) return resolve(app.globalData.user || null);
        setTimeout(tick, 120);
      };
      tick();
    });
  },

  /**
   * 从后台切回前台、或从别的页面返回时，主动补拉一次。
   * 手机切后台会断开 watch 订阅，回来时可能漏消息（此前要等 3 秒轮询）。
   */
  onShow() {
    if (!this.data.convId || this.data.loading) return;
    this.pullNew();
    // 自己的头像可能是很久以前缓存的签名链接（已过期 → 显示字标），
    // 回到页面时顺手换一张新的，失败也不打扰用户
    if (app.refreshMe) {
      app.refreshMe().then(() => this.syncMyAvatar()).catch(() => { });
    }
  },

  async load(first) {
    try {
      // 先等用户信息就绪：否则 myId=0 会把「我发的」全判成「对方发的」，
      // 渲染到左边配上对方头像 —— 表现就是「聊天记录缺了我问的那句」。
      if (!app.globalData.user) await this.waitUser(1500);
      // 用户信息就绪后立刻同步我的头像（首屏可能比 bootstrap 早）
      this.syncMyAvatar();
      // 一次多取一些：此前 limit=50，对话稍长就会出现「重进页面显示不全」
      const res = await api.get('/api/conversations/' + this.data.convId + '/messages?limit=100', null, { silent: !first });
      const conv = res.conversation || {};
      const incoming = res.list || [];
      // ⚠️ 必须「合并」而不是「替换」：
      //    这个响应可能是几秒前发出的（云函数冷启动），回来时列表里
      //    已经多了用户刚发的消息和 AI 的回复。整份覆盖会把它们抹掉。
      const r = this.applyMessages(incoming, { forceScroll: true, loading: false });
      this.setData({
        isAI: !!(conv.peer && conv.peer.isAI) || this.data.isAI,
        peerId: (conv.peer && conv.peer.id) || 0,
        name: (conv.peer && conv.peer.nickname) || this.data.name,
        hasMore: incoming.length >= 100
      });
      this.syncPeerAvatar(conv.peer);
      if (this.data.isAI && !this.data.myListings.length) this.loadMyListings();
    } catch (e) {
      this.setData({ loading: false });
      const msg = (e && e.message) || '';

      // 会话读不到时的自愈。
      //
      // ⚠️ 这里**绝对不能**用 app.openChat({}) 兜底：
      //    openChat 不带 peerId 时，后端会回落到 AI 用户，
      //    于是在「卖家会话」之上又压了一层「AI 会话」——
      //    用户点的是卖家、看到的却是 AI，返回才回到卖家会话。
      //    （这个坑踩过一次，别再改回去。）
      //
      // 正确做法：**同一个会话重试一次**。
      // 刚建好的会话可能由另一个云函数实例落库，
      // 本实例第一次读会短暂报「会话不存在」，重试就能命中。
      if (!this.staleRetried && /不存在/.test(msg)) {
        this.staleRetried = true;
        wx.showToast({ title: '正在重新进入会话…', icon: 'none', duration: 1200 });
        setTimeout(() => this.load(true), 600);
        return;
      }

      // 重试后仍读不到 → 会话确实失效了（例如换账号后残留了旧会话 id）。
      // 提示后退出本页，让用户自己重进；不能把他丢进别的会话。
      if (/不存在/.test(msg)) {
        wx.showToast({ title: '会话已失效，请返回重进', icon: 'none', duration: 1500 });
        setTimeout(() => {
          // getCurrentPages 是小程序全局，理论上一定存在；
          // 这里用 typeof 兜一下，避免在个别环境/单页栈下抛错。
          const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
          if (pages && pages.length > 1) wx.navigateBack();
          else wx.switchTab({ url: '/pages/message/message' });
        }, 1500);
      }
    }
  },

  deco(m, myId) {
    const mine = m.senderId === myId;
    const card = m.card;
    return Object.assign({}, m, {
      mine,
      timeText: util.fmtTime(m.createdAt),
      isText: m.type === 'text',
      isImage: m.type === 'image',
      isListing: m.type === 'listing',
      isListings: m.type === 'listings' && Array.isArray(card),
      isOrder: m.type === 'order',
      isSystem: m.type === 'system',
      read: (m.readBy || []).length > 1,
      cardImg: card && card.image ? api.abs(card.image) : '',
      cardPrice: card && card.amount !== undefined ? util.fmtPrice(card.amount) : (card && card.price !== undefined ? util.fmtPrice(card.price) : ''),
      cards: Array.isArray(card) ? card.map((x) => Object.assign({}, x, {
        cover: api.abs(x.image || (x.images && x.images[0]) || ''),
        priceText: util.fmtPrice(x.price || 0)
      })) : []
    });
  },

  lastId(list) {
    if (!list.length) return '';
    return 'msg-' + list[list.length - 1].id;
  },

  /**
   * 把服务端消息「合并」进当前列表（按 id 去重 + 排序），而不是整份替换。
   *
   * 为什么必须合并：
   *   load() 用的是「取最新一页」的响应。云函数有冷启动，首次响应可能 3~8 秒
   *   才回来。这期间用户可能已经发了消息、AI 也回复了 —— 若此时把响应整份
   *   覆盖上去，新到的消息就被一份「旧快照」抹掉了。
   *   典型表现：「AI 刚回复完就消失」「自己发的图不见了，退出重进才出现」。
   *
   * 合并天然解决了三件事：
   *   1) 迟到的旧响应只会补进缺失的消息，绝不会删除已有的
   *   2) 乐观上屏的临时消息（id 非数字）始终保留，排在最后
   *   3) 无论服务端返回的是增量的还是整页的，顺序都按 id 排好
   *
   * @param {Array} incoming 服务端原始消息数组（未 deco）
   * @returns {{list:Array, added:number, gotPeer:boolean}}
   */
  /**
   * 把服务端消息合并进当前列表。
   *
   * 两条原则（缺一条都会出问题）：
   *
   *  1) **只增不删、按 id 去重。**
   *     云函数有冷启动，load() 的响应可能 3~8 秒后才回来；若此时整份覆盖，
   *     用户刚发的消息和 AI 回复就被一份「旧快照」抹掉了。
   *
   *  2) **顺序按 createdAt 排，不按 id 排。**
   *     id 在多实例下不随时间单调（seq*65536+随机槽位），按 id 排会把时间戳
   *     19:52 的消息插到 19:50 上面 —— 就是「消息乱跑」。详见 sortT()。
   *     排的是「整份列表」，这样**已经渲染错位的老消息也会被纠正**；
   *     而 AI 回复的 createdAt 天然晚于提问，不会出现「答非所问」的错位。
   *
   * @param {Array} incoming 服务端原始消息数组（未 deco）
   * @returns {{list:Array, added:number, gotPeer:boolean}}
   */
  /**
   * 消息的**排序键**：一律用 `createdAt`（服务端写入时刻），**不要用 id**。
   *
   * 为什么不能用 id 排队（这是「消息乱跑」的真正原因）：
   *   云函数是多实例的，id 被拆成 `seq * 65536 + 本实例随机槽位`（见 db.js nextId），
   *   槽位是两个实例各自随机抽的。于是**同一时刻/相邻时刻**的两条消息，
   *   id 谁大谁小完全看槽位 —— 19:52 发的那条可能比 19:50 发的那条 id 更小。
   *   按 id 排序的表现就是截图里那样：时间戳 19:52、19:50、19:52 上下翻飞，
   *   自己发的消息和对方的消息互相穿插，同一秒发的两条一会在上、一会在下。
   *
   * 结论：**id 只用来去重，时间轴只认 createdAt。**
   * 老数据若缺 createdAt（种子/迁移产物），退化为 0 排在最前，不会乱序。
   */
  sortT(m) {
    if (!m) return 0;
    if (typeof m.createdAt === 'number') return m.createdAt;
    if (m.createdAt) {
      const t = new Date(m.createdAt).getTime();
      if (!isNaN(t)) return t;
    }
    return 0;
  },
  /** 上面返回 0 的情况：数字 id 的老消息按时间轴最前；临时消息（tmp-）按「还没落库=最新」排最后 */
  sortTLoose(m) {
    const t = this.sortT(m);
    if (t) return t;
    return typeof m.id === 'number' ? 0 : Number.MAX_SAFE_INTEGER;
  },

  mergeMessages(incoming) {
    const myId = (app.globalData.user && app.globalData.user.id) || 0;
    const existing = this.data.messages;

    // 已有消息按 id 建索引（临时消息单独留到最后）
    const byId = new Map();
    for (const m of existing) if (typeof m.id === 'number') byId.set(m.id, m);

    // 收集真正的新消息；已存在的只更新内容，不改变位置
    const fresh = [];
    let gotPeer = false;
    for (const raw of (incoming || [])) {
      if (!raw || typeof raw.id !== 'number') continue;
      const dec = this.deco(raw, myId);
      if (byId.has(raw.id)) { byId.set(raw.id, dec); continue; }
      byId.set(raw.id, dec);
      fresh.push(dec);
      if (raw.senderId !== myId) gotPeer = true;
    }

    if (!fresh.length) {
      // 没有新消息：仅用服务端版本覆盖同 id 的（顺序与位置完全不变）
      return {
        list: existing.map((m) => (typeof m.id === 'number' && byId.has(m.id) ? byId.get(m.id) : m)),
        added: 0,
        gotPeer: false
      };
    }

    // 有新增：把「已有 + 新增」并成一份，统一按时间重排（同毫秒再按 id 稳定）
    const all = [];
    for (const m of existing) {
      if (typeof m.id === 'number') {
        const v = byId.get(m.id);
        if (v) all.push(v);
      } else {
        all.push(m);              // 乐观上屏的临时消息（tmp-）原样保留
      }
    }
    for (const m of fresh) all.push(m);
    all.sort((a, b) => (this.sortTLoose(a) - this.sortTLoose(b)) || ((Number(a.id) || 0) - (Number(b.id) || 0)));
    return { list: all, added: fresh.length, gotPeer };
  },

  /** 合并并渲染（所有消息进入 data 的唯一入口） */
  applyMessages(incoming, extra) {
    const r = this.mergeMessages(incoming);
    const patch = Object.assign({}, extra || {}, { messages: r.list });
    delete patch.forceScroll;   // 仅作控制用途，不写进 data
    // 有新增、或调用方要求时，才滚动到底部
    if (r.added || extra === undefined || extra.forceScroll) patch.scrollInto = this.lastId(r.list);
    this.setData(patch);
    // 收到对方（含 AI）的新消息就立刻上报已读。
    // 放在这里而不是各调用点，是为了覆盖**所有**消息入口：
    // 发送接口返回值、轮询、实时订阅、事件推送 —— 漏掉任何一条，
    // 退出聊天后消息中心都会留着未读红点。
    if (r.gotPeer) this.markRead();
    return r;
  },

  appendMsg(m) {
    if (!m) return;
    return this.applyMessages([m], { forceScroll: true, typing: false });
  },

  /**
   * 用服务端返回的真实消息替换乐观上屏的临时消息。
   *
   * 必须先去重：轮询/订阅可能已经抢先把这条真实消息插进来了，
   * 直接 push 会导致同一句话显示两遍。
   * （此前 send() 就是这么写的 filter + push，存在重复风险）
   */
  replaceTemp(tempId, realMsg) {
    if (!realMsg) { this.dropTemp(tempId); return; }
    // 先移除临时消息（保留其他临时消息的先后顺序），再合并真实消息。
    // 合并会按 id 排到正确位置，且自带去重 —— 不会因为轮询抢先插入而重复。
    const kept = this.data.messages.filter((m) => m.id !== tempId);
    this.setData({ messages: kept });
    this.applyMessages([realMsg], { forceScroll: true });
  },

  /** 撤回乐观上屏的临时消息（发送失败时用） */
  dropTemp(tempId) {
    if (!tempId) return;
    this.setData({ messages: this.data.messages.filter((m) => m.id !== tempId) });
  },

  async loadMore() {
    if (this.data.loadingMore || !this.data.hasMore) return;
    const first = this.data.messages.find((m) => typeof m.id === 'number');
    if (!first) return;
    this.setData({ loadingMore: true });
    try {
      // 翻页游标同样以时间为准（beforeAt），id 只作兼容兜底
      const at = this.sortT(first);
      const res = await api.get('/api/conversations/' + this.data.convId + '/messages?limit=50&beforeId=' + first.id +
        (at ? '&beforeAt=' + at : ''), null, { silent: true });
      const older = res.list || [];
      // 同样走合并：合并会自动把更早的消息按 id 排到列表**前面**
      this.applyMessages(older);
      this.setData({ hasMore: older.length >= 50, loadingMore: false });
    } catch (e) {
      this.setData({ loadingMore: false });
    }
  },

  markRead() {
    api.post('/api/conversations/' + this.data.convId + '/read', {}, { silent: true })
      .then(() => app.refreshUnread())
      .catch(() => {});
  },

  onInput(e) {
    this.setData({ input: e.detail.value });
    const now = Date.now();
    if (now - (this.lastTyping || 0) > 3000) {
      this.lastTyping = now;
      ws.typing(this.data.convId);
    }
  },

  onBlur() { /* 保留键盘收起处理位 */ },

  toggleMore() {
    const showMore = !this.data.showMore;
    this.setData({ showMore, showEmoji: false, showQuick: false, bottomPx: showMore ? 300 : 56 });
    if (showMore && !this.data.myListings.length) this.loadMyListings();
  },

  toggleEmoji() {
    const showEmoji = !this.data.showEmoji;
    this.setData({ showEmoji, showMore: false, showQuick: false, bottomPx: showEmoji ? 250 : 56 });
  },

  toggleQuick() {
    const showQuick = !this.data.showQuick;
    this.setData({ showQuick, showMore: false, showEmoji: false, bottomPx: showQuick ? 300 : 56 });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/message/message' });
  },

  goOrder() { wx.navigateTo({ url: '/pages/orders/orders' }); },
  goMine() { wx.switchTab({ url: '/pages/profile/profile' }); },

  tapEmoji(e) {
    this.setData({ input: (this.data.input || '') + e.currentTarget.dataset.e });
  },

  tapQuick(e) {
    this.send(e.currentTarget.dataset.w);
    this.setData({ showQuick: false, bottomPx: 56 });
  },

  async loadMyListings() {
    try {
      const res = await api.get('/api/my-listings?status=on', null, { silent: true });
      this.setData({
        myListings: (res.items || []).slice(0, 20).map((l) => Object.assign(l, {
          cover: api.abs((l.images && l.images[0]) || ''),
          priceText: util.fmtPrice(l.price)
        }))
      });
    } catch (e) { /* 忽略 */ }
  },

  /**
   * 统一的发送入口。
   *
   * 注意：wxml 里 bindtap / bindconfirm 会把「事件对象」作为第一个实参传进来，
   * 若直接写成 bindtap="send"，则 send(text) 收到的是事件对象，
   * String(事件对象) 会变成 "[object Object]" 被发出去。
   * 因此这里显式定义不接收参数的包装函数，并做类型防御。
   */
  onSend() {
    this.send();
  },

  async send(text) {
    // 防御：万一被误传了事件对象/其他非字符串，忽略它，改用输入框内容
    let raw = text;
    if (raw !== undefined && typeof raw !== 'string') raw = undefined;

    const content = String(raw === undefined ? this.data.input : raw).trim();
    if (!content) return;
    if (this.data.sending) return;

    this.setData({ sending: true, input: '', showQuick: false, showMore: false, showEmoji: false, bottomPx: 56 });

    // 乐观更新：消息立刻上屏，不让用户等网络往返
    const myId = (app.globalData.user && app.globalData.user.id) || 0;
    const tempId = 'tmp-' + Date.now();
    const temp = {
      id: tempId, mine: true, isText: true, isImage: false, isListing: false,
      isOrder: false, isSystem: false, isListings: false,
      // createdAt 必须给：列表按时间排序，没有它临时消息会被排到最前面去
      createdAt: Date.now(),
      content, timeText: '刚刚', read: false, quickReplies: null
    };
    const withTemp = this.data.messages.concat([temp]);
    this.setData({ messages: withTemp, scrollInto: 'msg-' + tempId });

    if (this.data.isAI) this.setData({ typing: true });

    try {
      const r = await ws.sendChat(this.data.convId, { content, msgType: 'text' });
      // 用真实消息替换临时消息（内部已去重）
      this.replaceTemp(tempId, r.message);

      // 云函数已在同一次请求里带上 AI 回复（可能是「文字 + 商品卡片」多条）
      const aiMsgs = r.aiMessages || (r.aiMessage ? [r.aiMessage] : []);
      if (aiMsgs.length) {
        this.applyMessages(aiMsgs, { forceScroll: true, typing: false });
      } else if (this.data.isAI) {
        // 兜底：主通道没带回 AI 回复时，主动等一会儿并轮询拉取
        this.awaitAiReply();
      }
    } catch (e) {
      // 发送失败：撤回临时消息，把内容还给输入框
      this.dropTemp(tempId);
      this.setData({ input: content, typing: false });
      wx.showToast({ title: (e && e.message) || '发送失败', icon: 'none' });
    } finally {
      this.setData({ sending: false });
    }
  },

  /**
   * 主动等待 AI 回复。
   *
   * 不能「拉一次就放弃」：大模型往返 2~5 秒，拉早了拿不到，
   * 用户就会以为「发出去没反应，得再发一条才回复」——
   * 其实那条回复早就写进数据库了，只是前端没去取。
   *
   * 这里按退避间隔连拉几轮；全都没等到才走异步通道兜底
   * （/ai-reply 是幂等的，已回复过会直接跳过，不会重复回复）。
   */
  async awaitAiReply() {
    if (this.aiWaiting) return;
    this.aiWaiting = true;
    const base = this.lastRealMsg();
    // 判断「有没有新回复」同样用时间轴：id 在多实例下不代表先后
    const baseAt = this.sortT(base);
    const delays = [900, 1500, 2500, 4000];
    try {
      for (const d of delays) {
        await new Promise((resolve) => setTimeout(resolve, d));
        // 已离开聊天页，或「正在输入」已被收到的消息收起 → 结束等待
        if (!this.data.isAI || !this.data.typing) return;
        await this.pullNew();
        const got = this.data.messages.some((m) =>
          !m.mine && !m.isSystem && typeof m.id === 'number' && this.sortT(m) > baseAt);
        if (got) { this.setData({ typing: false }); return; }
      }
      // 多轮都没等到 → 走异步通道兜底，再拉一次
      try { await ws.requestAiReply(this.data.convId); } catch (e) { /* 忽略 */ }
      await this.pullNew();
      this.setData({ typing: false });
    } finally {
      this.aiWaiting = false;
    }
  },

  /** 发送自己的商品卡片（同样要求「发出去就看得见」） */
  async sendListing(e) {
    const id = e.currentTarget.dataset.id;
    const l = this.data.myListings.find((x) => x.id === Number(id));
    if (!l) return;
    this.setData({ showMore: false, bottomPx: 56 });
    const card = { listingId: l.id, title: l.title, image: (l.images && l.images[0]) || '', price: l.price, priceUnit: l.priceUnit };

    const tempId = 'tmp-card-' + Date.now();
    const temp = {
      id: tempId, mine: true, isText: false, isImage: false, isListing: true,
      isListings: false, isOrder: false, isSystem: false,
      createdAt: Date.now(),
      card, cardImg: l.cover || '', cardPrice: l.priceText || '', timeText: '发送中', read: false
    };
    this.setData({
      messages: this.data.messages.concat([temp]),
      scrollInto: 'msg-' + tempId
    });
    if (this.data.isAI) this.setData({ typing: true });

    try {
      const res = await ws.sendChat(this.data.convId, { content: '', msgType: 'listing', card });
      this.replaceTemp(tempId, res.message);
      const aiMsgs = res.aiMessages || (res.aiMessage ? [res.aiMessage] : []);
      if (aiMsgs.length) {
        this.applyMessages(aiMsgs, { forceScroll: true, typing: false });
      } else if (this.data.isAI) {
        this.awaitAiReply();
      }
    } catch (err) {
      this.dropTemp(tempId);
      if (this.data.isAI) this.setData({ typing: false });
      wx.showToast({ title: '发送失败', icon: 'none' });
    }
  },

  /**
   * 发送图片。
   *
   * 关键改动：先用「本地临时路径」乐观上屏，用户立刻看到自己选的图；
   * 上传完成后再用服务端返回的真实消息替换。
   * 此前是发完什么都不做，图片要等轮询、或退出重进才出现。
   */
  sendImage() {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sizeType: ['compressed'],
      success: async (r) => {
        const localPath = r.tempFiles[0].tempFilePath;
        this.setData({ showMore: false, bottomPx: 56 });

        const tempId = 'tmp-img-' + Date.now();
        const temp = {
          id: tempId, mine: true, isText: false, isImage: true, isListing: false,
          isListings: false, isOrder: false, isSystem: false,
          createdAt: Date.now(),
          content: localPath, timeText: '发送中', read: false, uploading: true
        };
        this.setData({
          messages: this.data.messages.concat([temp]),
          scrollInto: 'msg-' + tempId
        });
        if (this.data.isAI) this.setData({ typing: true });

        try {
          const url = await api.upload(localPath);
          const res = await ws.sendChat(this.data.convId, { content: url, msgType: 'image' });
          this.replaceTemp(tempId, res.message);
          const aiMsgs = res.aiMessages || (res.aiMessage ? [res.aiMessage] : []);
          if (aiMsgs.length) {
            this.applyMessages(aiMsgs, { forceScroll: true, typing: false });
          } else if (this.data.isAI) {
            this.awaitAiReply();
          }
        } catch (e) {
          this.dropTemp(tempId);
          if (this.data.isAI) this.setData({ typing: false });
          wx.showToast({ title: (e && e.message) || '图片发送失败', icon: 'none' });
        }
      }
    });
  },

  tapCard(e) {
    const id = e.currentTarget.dataset.id;
    const type = e.currentTarget.dataset.type;
    if (!id) return;
    // 订单卡带的是 orderId，之前一律当商品 id 打开 → 提示「商品不存在」
    if (type === 'order') {
      wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + id });
      return;
    }
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
  },

  previewImg(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.previewImage({ urls: [url] });
  },

  goPeer() {
    if (this.data.isAI || !this.data.peerId) return;
    wx.navigateTo({ url: '/pages/user/user?id=' + this.data.peerId });
  },

  onReport() {
    if (this.data.isAI) return;
    wx.showActionSheet({
      itemList: REPORT_ITEMS,
      success: async (r) => {
        try {
          await api.post('/api/reports', {
            targetType: 'user', targetId: this.data.peerId,
            reason: REPORT_ITEMS[r.tapIndex], detail: ''
          });
          wx.showToast({ title: '举报已提交', icon: 'none' });
        } catch (e) { /* 已提示 */ }
      }
    });
  }
});
