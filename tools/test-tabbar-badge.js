/**
 * 自定义 tabBar 红点同步测试。
 *
 * 用户反馈：未登录（消息页显示「登录后查看消息」）时，底部消息 tab 仍挂着红点 1。
 *
 * 根因：每个 tab 页面各有一个 tabBar 组件实例，而 app.setBadge() 只会更新
 * 「最近 attached 的那个」。组件原来只在 attached() 时读一次 unread，
 * pageLifetimes.show() 只同步高亮、不同步红点 —— 于是未读清零后，
 * 其他实例仍挂着旧红点。
 *
 * 本脚本真正加载 custom-tab-bar/index.js，模拟「两个实例」的场景。
 *
 * 用法：node tools/test-tabbar-badge.js
 */
const Module = require('module');

const TABBAR = 'D:/wx/campus-xianyu/miniprogram/custom-tab-bar/index.js';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/* ---------- mock 全局 ---------- */
const appMock = {
  globalData: { unread: 0 },
  tabbar: null,
  guard: () => true
};
let currentPages = [{ route: 'pages/index/index' }];

global.getApp = () => appMock;
global.getCurrentPages = () => currentPages;
global.wx = { switchTab() { }, navigateTo() { } };
global.Component = (opts) => { global.__compDef = opts; };
global.setTimeout = (fn) => { /* 测试里不同步重试 */ };

require(TABBAR);
const def = global.__compDef;
if (!def) { console.error('无法加载 custom-tab-bar（Component 未被调用）'); process.exit(1); }

/** 造一个组件实例：合并 lifetimes/pageLifetimes/methods */
function makeInst() {
  const inst = { data: JSON.parse(JSON.stringify(def.data || {})) };
  inst.setData = function (patch) { Object.assign(this.data, patch); };
  const merge = (src) => { for (const k of Object.keys(src || {})) inst[k] = src[k]; };
  merge(def.methods);
  merge(def.lifetimes);
  merge(def.pageLifetimes);
  delete inst.detached;
  return inst;
}

(async () => {
  /** 在指定路由下新建一个 tabBar 实例（模拟某个 tab 页面的组件） */
  function spawn(route) {
    currentPages = [{ route }];
    const inst = makeInst();
    inst.attached();
    return inst;
  }

  console.log('=== 1. attached 时应读取全局未读数 ===');
  const msgBar = spawn('pages/message/message');   // 消息页的实例
  const mineBar = spawn('pages/profile/profile');  // 我的页的实例
  {
    appMock.globalData.unread = 3;
    const a = spawn('pages/index/index');
    if (a.data.unread === 3) ok('实例 attached 后 unread=3');
    else no('实例 unread=' + a.data.unread + '，应为 3');
    if (appMock.tabbar === a) ok('app.tabbar 指向最新 attached 的实例');
    else no('app.tabbar 未更新');
  }

  console.log('\n=== 2. 【核心】其他实例的红点不应残留（用户报的场景）===');
  {
    // 两个 tab 页面各有一个实例，此时都有未读
    appMock.globalData.unread = 3;
    msgBar.syncUnread();
    mineBar.syncUnread();
    console.log('      消息页实例 unread=' + msgBar.data.unread + '，我的页实例 unread=' + mineBar.data.unread);
    if (msgBar.data.unread === 3 && mineBar.data.unread === 3) ok('两个实例都显示 3（登录态）');

    // 用户登出：未读清零，setBadge 只更新 app.tabbar（= 最后 attached 的我的页实例）
    appMock.globalData.unread = 0;
    appMock.tabbar.setUnread(0);
    console.log('      登出后：消息页实例=' + msgBar.data.unread + '，我的页实例=' + mineBar.data.unread);
    if (mineBar.data.unread === 0) ok('app.tabbar 指向的实例已清零');
    if (msgBar.data.unread === 3) ok('前置状态：另一个实例确实残留了 3（这就是 bug 现场）');

    // 用户切回消息页 → pageLifetimes.show
    currentPages = [{ route: 'pages/message/message' }];
    msgBar.show();
    if (msgBar.data.unread === 0) ok('切回时自动同步为 0 —— 红点不再残留（修复生效）');
    else no('消息页实例仍是 ' + msgBar.data.unread + ' → 「未登录却还有红点」');
  }

  console.log('\n=== 3. show 时高亮与红点都要同步 ===');
  {
    const c = spawn('pages/index/index');
    appMock.globalData.unread = 5;
    c.syncUnread();
    appMock.globalData.unread = 0;
    c.setData({ selected: 0 });
    currentPages = [{ route: 'pages/message/message' }];
    c.show();
    const expectIdx = def.data.list.findIndex((it) => it.pagePath === '/pages/message/message');
    if (c.data.selected === expectIdx) ok('高亮定位到消息 tab（idx=' + expectIdx + '）');
    else no('高亮 idx=' + c.data.selected + '，应为 ' + expectIdx);
    if (c.data.unread === 0) ok('红点同步为 0');
    else no('红点仍为 ' + c.data.unread);
  }

  console.log('\n=== 4. setUnread 不应产生无意义 setData ===');
  {
    appMock.globalData.unread = 2;
    const d = spawn('pages/circle/circle');
    let count = 0;
    const orig = d.setData.bind(d);
    d.setData = function (p) { count++; return orig(p); };
    d.setUnread(2);      // 值未变
    if (count === 0) ok('值相同时不触发 setData（避免无谓渲染）');
    else no('值相同仍 setData 了 ' + count + ' 次');
    d.setUnread(7);
    if (count === 1 && d.data.unread === 7) ok('值变化时正常更新为 7');
    else no('更新异常，count=' + count + ' unread=' + d.data.unread);
  }

  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ tabBar 红点同步正确：切页会重新同步，不会残留旧红点'));
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('测试崩溃:', e);
  process.exit(1);
});
