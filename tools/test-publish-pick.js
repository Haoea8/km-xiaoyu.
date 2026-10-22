/**
 * 发布页「交易方式 / 支持方式」可点性 + 导航栏右侧插槽不被胶囊遮挡 + 列表封面兜底。
 *
 * 三个都是 2026-10-17 用户真机反馈出来的「看着像不能用」的问题：
 *
 *   ① 交易方式（出售/出租/置换/拼团/服务/免费送）**怎么点都不高亮**
 *      —— `onModeChange` 读的是 `e.detail.value`（那是 picker 的字段），
 *         而 wxml 绑的是 tap + data-index → `Number(undefined)` = **NaN**
 *         → `modeIndex===index` 恒假 → 六个格子永远不选中。
 *   ② 支持方式（校内面交/宿舍自提/快递寄送/线上交付）**也不高亮**
 *      —— wxml 里写的是 `{{methods.indexOf(item) > -1 ? 'on' : ''}}`，
 *         而 **wxml 的表达式不支持函数调用**，`indexOf` 恒不生效（不报错）。
 *         连默认已选的「校内面交」都不亮。数据其实是对的，界面完全没反馈。
 *   ③ 导航栏右侧插槽（发布/发帖/上传…）**被微信胶囊按钮压住**
 *      —— `.nb-right { right: 16rpx }` ≈ 8px，而胶囊就钉在右上角。
 *   ④ 列表封面偶发不加载 → 一块纯灰，分不清「没图」还是「没加载出来」。
 *
 * 用法：node tools/test-publish-pick.js    （离线）
 */
const Module = require('module');
const fs = require('fs');

const ROOT = 'D:/wx/campus-xianyu/miniprogram';
const PUBLISH = ROOT + '/pages/publish/publish.js';
const PUBLISH_WXML = ROOT + '/pages/publish/publish.wxml';
const NAVBAR_JS = ROOT + '/components/navbar/navbar.js';
const NAVBAR_WXML = ROOT + '/components/navbar/navbar.wxml';
const ZONE_JS = ROOT + '/pages/zone/zone.js';
const ZONE_WXML = ROOT + '/pages/zone/zone.wxml';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => realSetTimeout(fn, 0);   // 让「延迟重试」在测试里立刻跑
const tick = () => new Promise((r) => realSetTimeout(r, 20));

/* ---------- 极简 setData：支持 "list[0].cover" 这种路径写法 ---------- */
function makeSetData(inst) {
  inst.setData = function (patch, cb) {
    for (const k of Object.keys(patch || {})) {
      const m = k.match(/^([A-Za-z_$][\w$]*)\[(\d+)\]\.([A-Za-z_$][\w$]*)$/);
      if (m) {
        const arr = this.data[m[1]];
        if (arr && arr[Number(m[2])]) arr[Number(m[2])][m[3]] = patch[k];
      } else {
        this.data[k] = patch[k];
      }
    }
    if (typeof cb === 'function') cb();
  };
}
function instantiate(def, extra) {
  const inst = {};
  for (const k of Object.keys(def)) if (typeof def[k] === 'function') inst[k] = def[k];
  inst.data = JSON.parse(JSON.stringify(def.data || {}));
  Object.assign(inst.data, extra || {});
  makeSetData(inst);
  return inst;
}

/* ---------- mock ---------- */
const calls = { toast: [] };
global.wx = {
  showToast: (o) => calls.toast.push((o && o.title) || ''),
  showLoading() { }, hideLoading() { }, navigateTo() { }, navigateBack() { },
  showModal() { }, getStorageSync: () => [], setStorageSync() { }, removeStorageSync() { },
  stopPullDownRefresh() { }, getMenuButtonBoundingClientRect: () => ({ left: 281, top: 26, width: 87, height: 32, right: 368 }),
  getSystemInfoSync: () => ({ windowWidth: 375 }), getWindowInfo: () => ({ windowWidth: 375 })
};
global.getApp = () => ({ globalData: { user: { id: 2 }, statusBarHeight: 24, navBarHeight: 64 }, guard: () => true });

const apiMock = {
  abs: (p) => p || '', token: () => 't',
  get: async () => ({ list: [], hasMore: false, total: 0 }),
  post: async () => ({ listing: { id: 1 } }), upload: async (p) => p
};
const constMock = {
  ZONES: [{ code: 'used', name: '二手闲置' }],
  ZONE_MAP: { used: { code: 'used', name: '二手闲置', color: '#000' } },
  TRADE_MODES: {}
};

function loadPage(file) {
  const orig = Module._load;
  Module._load = function (request) {
    if (request === '../../utils/api') return apiMock;
    if (request === '../../utils/util') return { fmtPrice: (v) => String(v / 100) };
    if (request === '../../utils/const') return constMock;
    return orig.apply(this, arguments);
  };
  let def = null;
  global.Page = (o) => { def = o; };
  delete require.cache[require.resolve(file)];
  require(file);
  Module._load = orig;
  return def;
}

/* ================= A. 交易方式（tap + data-index） ================= */
console.log('=== A. 交易方式：点格子必须真的选中 ===');
{
  const def = loadPage(PUBLISH);
  if (!def) { no('无法加载 publish.js'); }
  else {
    const p = instantiate(def);
    if (p.data.modeIndex !== 0) no('初始 modeIndex 应为 0（出售）');
    else ok('初始选中「出售」');

    // 真实 tap 事件的 detail 只有 {x,y}，没有 value —— 这正是 bug 的触发条件
    p.onModeChange({ currentTarget: { dataset: { index: 3 } }, detail: { x: 10, y: 20 } });
    if (p.data.modeIndex === 3) ok('点第 4 个（拼团）→ modeIndex=3，格子会高亮');
    else no('★ 点击后 modeIndex=' + p.data.modeIndex + '（应为 3）—— 交易方式还是选不了');

    // 反向对照：旧写法在当前事件下会得到 NaN
    const legacy = Number(({ x: 10, y: 20 }).value);
    if (Number.isNaN(legacy)) ok('反向对照：旧写法 Number(e.detail.value) 在这里 = NaN（所以旧版怎么点都不亮）');
    else no('反向对照失败：旧写法竟然拿到了有效值');

    p.onModeChange({ currentTarget: { dataset: { index: 9 } } });
    if (p.data.modeIndex === 3) ok('越界下标被忽略（不会把界面点空）');
    else no('★ 越界下标把 modeIndex 改成了 ' + p.data.modeIndex);

    p.onModeChange({ currentTarget: { dataset: {} } });
    if (p.data.modeIndex === 3) ok('缺少 data-index 时保持原值');
    else no('★ 缺少 data-index 时被改成了 ' + p.data.modeIndex);

    p.onModeChange({ currentTarget: { dataset: { index: 0 } }, detail: {} });
    if (p.data.modeIndex === 0) ok('点回第 1 个（出售）→ modeIndex=0');
    else no('★ 点回第 1 个失败');

    // 切到「免费送」时价格可留空（既有行为不能被这次改动破坏）
    p.onModeChange({ currentTarget: { dataset: { index: 5 } }, detail: {} });
    const wxml = fs.readFileSync(PUBLISH_WXML, 'utf8');
    if (p.data.modeIndex === 5 && /disabled="\{\{modes\[modeIndex\]\.key === 'free'\}\}"/.test(wxml)) {
      ok('切到「免费送」后价格框仍走 disabled（联动没坏）');
    } else no('★ 免费送的价格联动坏了');
  }
}

/* ================= B. 支持方式（wxml 不能调 indexOf） ================= */
console.log('\n=== B. 支持方式：选中状态必须看得见 ===');
{
  const def = loadPage(PUBLISH);
  const p = instantiate(def);
  const pool0 = p.data.methodPool;
  if (Array.isArray(pool0) && pool0.length === 4 && pool0[0].on === true && pool0[1].on === false) {
    ok('初始 pool 带 on 标记：「' + pool0[0].name + '」选中、其余未选');
  } else no('★ 初始 methodPool 不是 [{name,on}] 形态 —— chip 依旧不会高亮');

  p.toggleMethod({ currentTarget: { dataset: { m: '快递寄送' } } });
  const on = p.data.methodPool.filter((x) => x.on).map((x) => x.name);
  if (on.length === 2 && on.indexOf('快递寄送') > -1) ok('点「快递寄送」→ 两个都亮（' + on.join('/') + '）');
  else no('★ 点「快递寄送」后选中项 = ' + JSON.stringify(on));
  if (p.data.methods.length === 2 && p.data.methods.indexOf('快递寄送') > -1) ok('methods（提交用）同步更新');
  else no('★ methods 没跟 methodPool 同步，提交会丢');

  p.toggleMethod({ currentTarget: { dataset: { m: '校内面交' } } });
  if (p.data.methods.length === 1 && p.data.methods[0] === '快递寄送') ok('再点一次可取消（剩 1 个）');
  else no('★ 取消失败：' + JSON.stringify(p.data.methods));

  const before = calls.toast.length;
  p.toggleMethod({ currentTarget: { dataset: { m: '快递寄送' } } });   // 想取消最后一个
  if (p.data.methods.length === 1 && calls.toast.length > before && /至少保留/.test(calls.toast[calls.toast.length - 1])) {
    ok('最后一个不允许取消，并给了提示');
  } else no('★ 允许取消到 0 个，或没给提示');

  const wxml = fs.readFileSync(PUBLISH_WXML, 'utf8');
  if (/methods\.indexOf\(/.test(wxml)) no('★ wxml 里仍有 indexOf()（wxml 不支持函数调用，恒为假）');
  else ok('wxml 里已无 indexOf() 调用');
  if (/class="mchip \{\{item\.on \? 'on' : ''\}\}"/.test(wxml) && /data-m="\{\{item\.name\}\}"/.test(wxml)) {
    ok('chip 用 item.on 控制高亮、data-m 传名字');
  } else no('★ chip 绑定不是预期形态');
}

/* ================= C. 发布页顶部「发布」已移除 ================= */
console.log('\n=== C. 发布页不再占用导航栏右侧（原来被胶囊挡住） ===');
{
  const wxml = fs.readFileSync(PUBLISH_WXML, 'utf8');
  if (/slot="right"/.test(wxml)) no('★ 发布页还在往导航栏右侧塞按钮（会被胶囊压住）');
  else ok('发布页已移除 slot="right" 的「发布」');
  if (/btn-submit/.test(wxml) && /立即发布/.test(wxml)) ok('底部「立即发布」仍在（唯一入口没丢）');
  else no('★ 底部发布按钮不见了 —— 会无法发布');
}

/* ================= D. 导航栏组件避开胶囊 ================= */
console.log('\n=== D. 导航栏右侧插槽要避开微信胶囊 ===');
{
  let def = null;
  const orig = Module._load;
  global.Component = (o) => { def = o; };
  delete require.cache[require.resolve(NAVBAR_JS)];
  require(NAVBAR_JS);
  Module._load = orig;

  const inst = { data: JSON.parse(JSON.stringify(def.data)) };
  makeSetData(inst);
  def.lifetimes.attached.call(inst);
  // 375 宽、胶囊 left=281 → 右移 375-281+8 = 102
  if (inst.data.rightPad === 102) ok('按胶囊位置算出 rightPad=102px（375 宽 / 胶囊 left=281）');
  else no('★ rightPad=' + inst.data.rightPad + '（应为 102）');
  if (inst.data.statusBarHeight === 24 && inst.data.navBarHeight === 64) ok('状态栏/导航高仍取自 globalData');
  else no('★ 高度计算被破坏');

  // 拿不到胶囊信息时必须回退到默认值，而不是崩掉或变 NaN
  global.wx.getMenuButtonBoundingClientRect = () => { throw new Error('no api'); };
  const inst2 = { data: JSON.parse(JSON.stringify(def.data)) };
  makeSetData(inst2);
  def.lifetimes.attached.call(inst2);
  if (inst2.data.rightPad === 16) ok('接口不可用时回退默认 16px（不影响渲染）');
  else no('★ 回退值异常：' + inst2.data.rightPad);

  const nwxml = fs.readFileSync(NAVBAR_WXML, 'utf8');
  if (/style="right:\{\{rightPad\}\}px;"/.test(nwxml)) ok('navbar.wxml 用 rightPad 定位右侧插槽');
  else no('★ navbar.wxml 没接 rightPad，样式还是写死的 16rpx');
}

/* ================= E. 列表封面兜底 ================= */
(async () => {
console.log('\n=== E. 列表封面：失败先重试一次，再失败才占位 ===');
{
  const def = loadPage(ZONE_JS);
  // ⚠️ 先剥掉 wxml 注释再判断 —— 否则「注释里解释了为什么去掉 lazy-load」会被当成还在用它
  //    （本项目 check-adaptive.js 对 CSS 注释也做过同样的处理）
  const zxml = fs.readFileSync(ZONE_WXML, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  if (/binderror="onCoverError"/.test(zxml)) ok('封面绑了 binderror → 不再是一块纯灰');
  else no('★ 封面没有 binderror，加载失败就是白块');
  if (/lazy-load/.test(zxml)) no('★ 列表封面仍在用 lazy-load（真机上个别图不触发加载）');
  else ok('列表封面已去掉 lazy-load');

  const p = instantiate(def, {
    list: [{ id: 1, title: 'a', cover: 'https://x/img.jpg?sign=1' }],
    hasMore: false, loading: false
  });
  const url = p.data.list[0].cover;
  p.onCoverError({ currentTarget: { dataset: { index: 0 } } });
  if (p.data.list[0].retried === true) ok('第一次失败：标记 retried 并准备重试');
  else no('★ 第一次失败没有进入重试分支');
  await tick();
  if (p.data.list[0].cover === url && !p.data.list[0].imgFail) {
    ok('重试后 src 回填为原链接（逼迫组件重新发起加载）');
  } else no('★ 重试后 cover=' + JSON.stringify(p.data.list[0].cover) + ' imgFail=' + p.data.list[0].imgFail);

  p.onCoverError({ currentTarget: { dataset: { index: 0 } } });   // 第二次仍失败
  if (p.data.list[0].imgFail === true) ok('第二次仍失败：显示「图片加载失败」占位');
  else no('★ 第二次失败没有落成占位，用户还是只看到灰块');

  p.onCoverError({ currentTarget: { dataset: { index: 99 } } });  // 越界不应崩
  ok('越界下标不抛错（已容错）');
}

console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 交易方式/支持方式可选、导航栏不压胶囊、封面失败有重试与占位'));
process.exit(bad ? 1 : 0);
})();
