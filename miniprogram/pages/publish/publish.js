/**
 * 发布宝贝：图片 + 分区 + 交易方式 + 价格 + 标签
 */
const app = getApp();
const api = require('../../utils/api');
const util = require('../../utils/util');
const { ZONES, TRADE_MODES } = require('../../utils/const');

const MODES = [
  { key: 'sell', label: '出售', desc: '一手交钱一手交货' },
  { key: 'rent', label: '出租', desc: '按天/按次收租金' },
  { key: 'barter', label: '置换', desc: '以物换物不用钱' },
  { key: 'group', label: '拼团', desc: '凑人数拿低价' },
  { key: 'service', label: '服务', desc: '代跑代拿技能' },
  { key: 'free', label: '免费送', desc: '白送给同学' }
];

/**
 * 预设交易地点。
 *
 * 最后一项是「其他」：选中后由用户自己填写具体地点。
 * 后端本来就接受自由文本 —— `util.clampText(b.location, 30) || '校内'`，
 * 上限 30 个字符。所以输入框的 maxlength 必须与它一致，
 * 否则用户写了 40 字、提交后被静默截断，还以为存下来了。
 */
const LOCATIONS = ['学生宿舍区', '第一教学楼', '图书馆', '食堂门口', '体育馆', '校门口', '南区快递中心', '线上交易', '其他（手动填写）'];
/** 「其他」在 LOCATIONS 中的下标 */
const OTHER_INDEX = LOCATIONS.length - 1;
/** 与后端 clampText(b.location, 30) 对齐 */
const LOCATION_MAX = 30;
/**
 * 预设计价单位。
 *
 * 这一行最终是「**数量 + 单位**」两段式：
 *
 *     计价单位        [ 2 ] 件 ›
 *                     ↑自己写   ↑只能选（没光标、删不掉、移不动）
 *
 * 演变过程（两次都改了）：
 *   - 最初是个自由输入框：谁都能写「asdf」，且清空时 `|| '件'` 会把「件」写回，
 *     导致「删不掉、光标乱跑」；
 *   - 于是整格换成选择器 —— 但那样**连数字也写不了了**，而数量是要用户自己填的。
 *   - 所以拆成两段：数字是输入框（用户自己写），单位是选择器（不可编辑）。
 *
 * 拼接后写进 priceUnit（如「2件」），这样详情页/商品卡/订单快照里
 * 现成的 `/{{priceUnit}}` 不用改就能显示成「¥20/2件」。
 */
const UNITS = ['件', '个', '套', '台', '本', '双', '箱', '斤', '份', '次', '小时', '天', '月', '其他（手动填写）'];
/** 「其他」在 UNITS 中的下标 */
const UNIT_OTHER_INDEX = UNITS.length - 1;
/**
 * 单位文字上限。
 * 注意：**不要**用「数量 + 单位」的总长去反推这个值。
 * 我第一版把它限成 2 字，理由是「数量(≤2位)+单位 ≤ 后端 4 字上限」——
 * 那等于让后端的存储长度去限制用户能填什么，用户直接反馈「不要搞件数限制」。
 * 正确做法是放宽后端（见 route-trade.js 的 clampText(b.priceUnit, 12)），
 * 前端不设件数上限。
 */
const UNIT_MAX = 4;
/** 与后端 clampText(b.priceUnit, 12) 对齐：超了就给提示，绝不静默截断 */
const UNIT_FINAL_MAX = 12;
/** 自定义单位里不要出现数字或空格 —— 数量有专门的输入框 */
const UNIT_BAD_CHARS = /[\d\s]/;
const METHOD_POOL = ['校内面交', '宿舍自提', '快递寄送', '线上交付'];
/**
 * 把「已选中的方式」映射成带 `on` 标记的渲染数组。
 *
 * ⚠️ 为什么必须预先算好：wxml 的表达式**不支持函数调用**。
 * 原来 wxml 里写的是 `class="mchip {{methods.indexOf(item) > -1 ? 'on' : ''}}"`，
 * 而 `indexOf` 在 wxml 里恒不生效（不报错、也不命中）→ 四个 chip **永远不高亮**，
 * 包括默认已选的「校内面交」。数据其实变了，但界面毫无反馈，
 * 用户看到的就是「支持方式选不了」（2026-10-17 反馈）。
 */
const makeMethodPool = (selected) => {
  const sel = selected || [];
  return METHOD_POOL.map((name) => ({ name, on: sel.indexOf(name) > -1 }));
};

Page({
  data: {
    zones: ZONES,
    modes: MODES,
    locations: LOCATIONS,
    methodPool: makeMethodPool(['校内面交']),

    zoneIndex: 0,
    modeIndex: 0,
    locationIndex: 0,
    /** 选「其他」时手填的地点 */
    locationOther: '',
    /** 是否选中了「其他」——选中才显示输入框 */
    isOtherLocation: false,
    /** 输入框长度上限（透传给 wxml，与后端一致） */
    locationMax: LOCATION_MAX,
    methods: ['校内面交'],

    /** 计价单位：「数量（自己写）+ 单位（只能选）」 */
    units: UNITS,
    unitIndex: 0,
    unitCount: '',
    unitOther: '',
    isOtherUnit: false,
    unitMax: UNIT_MAX,

    images: [],
    maxImages: 9,
    title: '',
    desc: '',
    priceYuan: '',
    originalYuan: '',
    tags: [],
    tagInput: '',
    attrs: [],
    attrKey: '',
    attrVal: '',
    groupTarget: '',
    groupDeadline: '',

    submitting: false,
    agree: true,

    /* ---- AI 帮我写 ---- */
    aiBusy: false,
    aiTip: '',
    aiSource: ''
  },

  onLoad(opts) {
    if (!app.guard()) return;
    /**
     * 幂等键：**本次进入发布页只生成一次**，重试也用它。
     * 服务端按它去重 —— 连点、超时重发、请求已到但界面还在转圈时再点，
     * 都只会建出一件商品（线上真实出现过「一次发布出来好几件一模一样的」）。
     * 发布成功后页面会 redirect 到详情；下次再进发布页会拿到新的 reqId。
     */
    this.reqId = 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const zone = opts.zone || '';
    const zi = ZONES.findIndex((z) => z.code === zone);
    this.setData({ zoneIndex: zi > -1 ? zi : 0 });
  },

  onZoneChange(e) { this.setData({ zoneIndex: Number(e.detail.value) }); },
  /**
   * 选交易方式。
   *
   * ⚠️ 这个方法是**点格子**（bindtap + data-index），不是 picker ——
   * 原来写成 `Number(e.detail.value)`（picker 才有 detail.value），
   * 点击事件的 detail 只有 {x, y}，于是 `Number(undefined)` = **NaN**，
   * modeIndex 变成 NaN → `modeIndex===index` 永远为假 → **六个格子怎么点都不高亮**
   * （用户反馈「交易方式选不了」）。
   * 现在读 currentTarget.dataset.index，并顺手兼容 picker 的 detail.value。
   */
  onModeChange(e) {
    const ds = (e.currentTarget && e.currentTarget.dataset) || {};
    const raw = ds.index !== undefined ? ds.index : (e.detail && e.detail.value);
    const i = Number(raw);
    if (!Number.isInteger(i) || i < 0 || i >= MODES.length) return;  // 非法值不动，避免把界面点空
    this.setData({ modeIndex: i });
  },
  onLocationChange(e) {
    const i = Number(e.detail.value);
    // 切回预设地点时**保留**手填内容：用户再切回「其他」不用重新打一遍
    this.setData({ locationIndex: i, isOtherLocation: i === OTHER_INDEX });
  },
  onLocationOther(e) { this.setData({ locationOther: e.detail.value }); },

  /** 当前选中的交易地点：选「其他」时取手填内容（已去首尾空白） */
  currentLocation() {
    if (this.data.locationIndex !== OTHER_INDEX) return LOCATIONS[this.data.locationIndex] || '';
    return String(this.data.locationOther || '').trim();
  },

  onUnitChange(e) {
    const i = Number(e.detail.value);
    this.setData({ unitIndex: i, isOtherUnit: i === UNIT_OTHER_INDEX });
  },
  /**
   * 数量：只留数字，且**去掉前导零**，不限制位数（用户明确要求别限件数）。
   *
   * 去掉前导零是必需的：否则「00」「01」都能填进去，而「每 00 件」毫无意义。
   * 效果：输入 0 → 空（等同不填，即「件」）；输入 00 / 007 → 空 / 7。
   *
   * ⚠️ **必须 return**：小程序的 input 只有在 bindinput 处理函数**返回字符串**时，
   *    才会用返回值替换输入框里的内容。只 setData 的话是「数据变了、输入框没变」——
   *    表现就是数据里已经是空，框里却还显示着 `00000`（这个坑踩过）。
   *
   * 注意也不要在空值时兜底写回默认值 —— 那会让输入框清不空。
   */
  onUnitCount(e) {
    const v = String(e.detail.value || '').replace(/\D/g, '').replace(/^0+/, '');
    this.setData({ unitCount: v });
    return v;
  },
  onUnitOther(e) { this.setData({ unitOther: e.detail.value }); },

  /** 单位文字部分：预设直接取，选「其他」时取手填内容 */
  currentUnitText() {
    if (this.data.unitIndex !== UNIT_OTHER_INDEX) return UNITS[this.data.unitIndex] || '件';
    return String(this.data.unitOther || '').trim();
  },

  /**
   * 最终写进 priceUnit 的值。
   * 数量留空或为 1 时只存单位本身（「件」），避免现有数据与展示变成「¥20/1件」。
   */
  currentUnit() {
    const unit = this.currentUnitText();
    if (!unit) return '';
    const n = Number(this.data.unitCount || 1);
    return (Number.isFinite(n) && n > 1) ? (n + unit) : unit;
  },

  toggleMethod(e) {
    const m = e.currentTarget.dataset.m;
    const list = this.data.methods.slice();
    const i = list.indexOf(m);
    if (i > -1) { if (list.length <= 1) return wx.showToast({ title: '至少保留一种方式', icon: 'none' }); list.splice(i, 1); }
    else list.push(m);
    // 两件事必须同时做：① methods 用于提交 ② methodPool 负责把 on 标记算好（wxml 不会算）
    this.setData({ methods: list, methodPool: makeMethodPool(list) });
  },

  onTitle(e) { this.setData({ title: e.detail.value }); },
  onDesc(e) { this.setData({ desc: e.detail.value }); },
  onPrice(e) { this.setData({ priceYuan: e.detail.value }); },
  onOriginal(e) { this.setData({ originalYuan: e.detail.value }); },
  onGroupTarget(e) { this.setData({ groupTarget: e.detail.value }); },
  onGroupDeadline(e) { this.setData({ groupDeadline: e.detail.value }); },
  onTagInput(e) { this.setData({ tagInput: e.detail.value }); },
  onAttrKey(e) { this.setData({ attrKey: e.detail.value }); },
  onAttrVal(e) { this.setData({ attrVal: e.detail.value }); },

  /**
   * 「AI 帮我写」：根据标题/分区/交易方式生成标题+描述+标签+建议价。
   *
   * 后端把「平台同类在售商品」注入 prompt（RAG），所以建议价来自真实样本，
   * 不是模型瞎猜；大模型不可用时后端自动降级为规则引擎，接口不会失败。
   *
   * 交互上只覆盖「用户还没写」的东西：
   *   - 标题/描述都已填 → 先确认再覆盖（手写内容不能被无声吞掉）；
   *   - 价格已有值 → 不覆盖，只把建议价写进提示行，让用户自己决定。
   */
  async onAiAssist() {
    if (this.data.aiBusy) return;
    const title = String(this.data.title || '').trim();
    const desc = String(this.data.desc || '').trim();
    if (!title && !desc) {
      return wx.showToast({ title: '先写个标题或说一句是什么', icon: 'none' });
    }

    if (title && desc) {
      const go = await new Promise((resolve) => {
        wx.showModal({
          title: '让 AI 重写？',
          content: '会覆盖当前的标题和描述（价格只在你没填时才改）。',
          confirmText: '重写',
          cancelText: '取消',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false)
        });
      });
      if (!go) return;
    }

    this.setData({ aiBusy: true });
    wx.showLoading({ title: 'AI 写作中', mask: true });
    try {
      const out = await api.post('/api/ai/listing-assist', {
        title,
        desc,
        zone: ZONES[this.data.zoneIndex].code,
        tradeMode: MODES[this.data.modeIndex].key
      }, { silent: true });
      wx.hideLoading();

      const patch = {
        aiBusy: false,
        aiTip: out.reason || '',
        aiSource: out.source || 'rule'
      };
      if (out.title) patch.title = out.title;
      if (out.desc) patch.desc = out.desc;
      if (out.suggestPrice && !Number(this.data.priceYuan || 0)) {
        patch.priceYuan = String(out.suggestPrice);
      }
      if (Array.isArray(out.tags) && out.tags.length) {
        const merged = this.data.tags.slice();
        for (const t of out.tags) {
          if (merged.length >= 5) break;
          if (merged.indexOf(t) === -1) merged.push(t);
        }
        patch.tags = merged;
      }
      this.setData(patch);
      wx.showToast({
        title: out.source === 'llm' ? 'AI 已填好，可再改' : '已生成（离线规则）',
        icon: 'none'
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ aiBusy: false });
      wx.showToast({ title: e.message || 'AI 暂时不可用', icon: 'none' });
    }
  },

  addTag(e) {
    const t = String(e.currentTarget.dataset.t || this.data.tagInput || '').trim().replace(/^#/, '');
    if (!t) return;
    if (this.data.tags.length >= 5) return wx.showToast({ title: '最多 5 个标签', icon: 'none' });
    if (this.data.tags.indexOf(t) > -1) return;
    this.setData({ tags: this.data.tags.concat([t]), tagInput: '' });
  },
  removeTag(e) { this.setData({ tags: this.data.tags.filter((x) => x !== e.currentTarget.dataset.t) }); },

  addAttr() {
    const k = String(this.data.attrKey || '').trim();
    const v = String(this.data.attrVal || '').trim();
    if (!k || !v) return wx.showToast({ title: '请填写属性名和值', icon: 'none' });
    if (this.data.attrs.length >= 6) return wx.showToast({ title: '最多 6 条属性', icon: 'none' });
    this.setData({ attrs: this.data.attrs.concat([{ k, v }]), attrKey: '', attrVal: '' });
  },
  removeAttr(e) {
    const i = Number(e.currentTarget.dataset.index);
    const attrs = this.data.attrs.slice();
    attrs.splice(i, 1);
    this.setData({ attrs });
  },

  chooseImage() {
    const left = this.data.maxImages - this.data.images.length;
    if (left <= 0) return wx.showToast({ title: '最多 9 张图', icon: 'none' });
    wx.chooseMedia({
      count: left, mediaType: ['image'], sizeType: ['compressed'],
      success: (r) => this.setData({ images: this.data.images.concat(r.tempFiles.map((f) => f.tempFilePath)) })
    });
  },
  removeImage(e) {
    const images = this.data.images.slice();
    images.splice(Number(e.currentTarget.dataset.index), 1);
    this.setData({ images });
  },
  previewImage(e) {
    wx.previewImage({ current: this.data.images[e.currentTarget.dataset.index], urls: this.data.images });
  },

  toggleAgree() { this.setData({ agree: !this.data.agree }); },

  async onSubmit() {
    /**
     * ⚠️ 两道锁，缺一不可：
     *   - `this.locked` 是**同步**实例锁：连点在同一帧里进来也能被挡住；
     *   - `this.data.submitting` 只有 setData 之后才为真，而在那之前还要过
     *     「校验 + 1~3 秒的 AI 内容审核」—— 光靠它，连点会全部穿过去，
     *     每一下都发一次 POST，于是「点一次发布出来好几件」。
     */
    if (this.locked || this.data.submitting) return;
    if (!this.data.agree) return wx.showToast({ title: '请先同意发布规范', icon: 'none' });

    const title = String(this.data.title || '').trim();
    if (!title) return wx.showToast({ title: '请填写宝贝标题', icon: 'none' });
    if (!this.data.images.length) return wx.showToast({ title: '至少上传 1 张图片', icon: 'none' });

    const mode = MODES[this.data.modeIndex].key;
    const priceYuan = Number(this.data.priceYuan || 0);
    if (mode !== 'free' && !(priceYuan > 0)) return wx.showToast({ title: '请填写有效价格', icon: 'none' });

    if (mode === 'group' && !this.data.groupTarget) {
      return wx.showToast({ title: '拼团请填写成团人数', icon: 'none' });
    }

    // 选了「其他」必须填具体地点，否则等于没写（后端会兜底成「校内」，跟用户意图不符）
    const loc = this.currentLocation();
    if (!loc) return wx.showToast({ title: '请填写具体交易地点', icon: 'none' });

    // 计价单位：只有「其他」手填的情况需要校验（预设项本身就是干净的）
    const unit = this.currentUnit();
    if (this.data.isOtherUnit) {
      if (!unit) return wx.showToast({ title: '请填写计价单位', icon: 'none' });
      // 数量有自己的输入框了，别把数字写进单位文字里
      if (UNIT_BAD_CHARS.test(this.currentUnitText())) {
        return wx.showToast({ title: '数量请填在左边的数字框里', icon: 'none' });
      }
    }
    // 前端不限件数，但拼接后不能超过后端存储上限 —— 明确提示，不静默截断
    if (unit.length > UNIT_FINAL_MAX) {
      return wx.showToast({ title: '计价单位太长了（最多 ' + UNIT_FINAL_MAX + ' 字）', icon: 'none' });
    }

    // AI 内容审核（本地规则 + 大模型，取更严的一方）。
    // 三条纪律：
    //   ① **只拦 high**：mid 级（如「加微信」）只提示不拦，否则会误伤大量正常文案；
    //   ② **请求失败一律放行**：审核服务挂了不能让人发不出东西（fail-open）；
    //   ③ 放在上传图片之前：不合规就没必要先把几 MB 图片传上云。
    // 从这里开始才上锁：前面的校验都是同步的，不会并发；一旦进入「可能要等网络」
    // 的阶段就必须锁住，否则连点会各自发出一份请求。
    this.locked = true;
    try {
      const mod = await api.post('/api/ai/moderate', { title, desc: this.data.desc }, { silent: true });
      if (mod && mod.level === 'high') {
        wx.showModal({
          title: '内容可能违规',
          content: (mod.reason || '命中平台禁止发布的内容') + (mod.suggestion ? '\n' + mod.suggestion : ''),
          showCancel: false
        });
        this.locked = false;          // 被拦下：允许改完再发
        return;
      }
    } catch (e) { /* 审核不可用 → 放行，不影响正常发布 */ }

    this.setData({ submitting: true });
    wx.showLoading({ title: '上传图片', mask: true });
    try {
      const urls = [];
      for (const p of this.data.images) urls.push(await api.upload(p));

      const attrs = {};
      for (const a of this.data.attrs) attrs[a.k] = a.v;
      if (mode === 'group') {
        attrs['成团人数'] = String(this.data.groupTarget).replace(/[^\d]/g, '') + ' 人';
        attrs['截止'] = this.data.groupDeadline || '3 天后';
      }

      wx.showLoading({ title: '发布中', mask: true });
      const res = await api.post('/api/listings', {
        zone: ZONES[this.data.zoneIndex].code,
        title,
        desc: this.data.desc,
        images: urls,
        price: mode === 'free' ? 0 : Math.round(priceYuan * 100),
        originalPrice: this.data.originalYuan ? Math.round(Number(this.data.originalYuan) * 100) : 0,
        priceUnit: unit,
        tradeMode: mode,
        location: loc,
        tradeMethods: this.data.methods,
        tags: this.data.tags,
        attrs,
        /** 幂等键：服务端据此去重，重复提交只会有一条 */
        reqId: this.reqId
      }, { silent: true });

      wx.hideLoading();
      wx.showToast({ title: '发布成功', icon: 'success' });
      setTimeout(() => wx.redirectTo({ url: '/pages/detail/detail?id=' + res.listing.id }), 800);
    } catch (e) {
      wx.hideLoading();
      // 解锁允许重试；reqId **保持不变** —— 若这次其实已在云端建好
      //（例如响应超时），重试会拿回同一件商品，不会多出一条。
      this.locked = false;
      this.setData({ submitting: false });
      wx.showToast({ title: e.message || '发布失败', icon: 'none' });
    }
  },

  onCancel() { wx.navigateBack(); }
});
