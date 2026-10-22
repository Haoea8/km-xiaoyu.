/**
 * tabBar 行为测试（真跑逻辑，不只是正则匹配）
 *
 * 在沙箱里 mock 掉小程序运行时（Component / getApp / getCurrentPages / wx），
 * 加载真实的 custom-tab-bar/index.js，然后模拟点击每个 tab，
 * 断言两件事：
 *   1. wx.switchTab 被调用，且 url 正确（页面真的会切）
 *   2. 高亮 selected 指向正确的下标
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = 'D:/wx/campus-xianyu/miniprogram/custom-tab-bar/index.js';
const APPJSON = 'D:/wx/campus-xianyu/miniprogram/app.json';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/* ---------- 读取 app.json 的合法 tab 路径 ---------- */
const appJson = JSON.parse(fs.readFileSync(APPJSON, 'utf8'));
const legalTabs = appJson.tabBar.list.map((t) => '/' + t.pagePath);

/* ---------- 在沙箱里加载组件 ---------- */
let compConfig = null;
const switchCalls = [];
let currentRoute = '/pages/index/index';

const sandbox = {
  console,
  setTimeout: (fn) => { /* 测试里不跑重试定时器 */ },
  getApp: () => ({ globalData: { unread: 0 }, guard: () => true, tabbar: null }),
  getCurrentPages: () => [{ route: currentRoute.replace(/^\//, '') }],
  Component: (cfg) => { compConfig = cfg; },
  wx: {
    switchTab: (o) => { switchCalls.push(o.url); if (o.success) o.success(); },
    navigateTo: (o) => { switchCalls.push('NAV:' + o.url); }
  }
};
sandbox.global = sandbox;

try {
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), sandbox, { filename: FILE });
  ok('组件加载成功');
} catch (e) {
  no('组件加载失败: ' + e.message);
  process.exit(1);
}

if (!compConfig) { no('未捕获到 Component 配置'); process.exit(1); }

/* ---------- 构造组件实例 ---------- */
function makeInstance() {
  const inst = {
    data: JSON.parse(JSON.stringify(compConfig.data)),
    setData(patch) { Object.assign(this.data, patch); },  // 小程序 setData 同步更新 this.data
    syncSelected: compConfig.methods.syncSelected,
    setActive: compConfig.methods.setActive,
    onTap: compConfig.methods.onTap
  };
  return inst;
}

/* ---------- 断言函数 ---------- */
function tap(inst, index) {
  const item = inst.data.list[index];
  switchCalls.length = 0;
  inst.onTap({ currentTarget: { dataset: { index, item } } });
  return { item, calls: switchCalls.slice() };
}

console.log('\n=== 1. 从左到右依次点击（每次都从别的页出发）===');
{
  const inst = makeInstance();

  for (let i = 0; i < inst.data.list.length; i++) {
    const item = inst.data.list[i];

    // 起点固定选一个「不是目标」的 tab，保证这是一次真实跳转
    const from = i === 0 ? 4 : 0;
    inst.setData({ selected: from });
    currentRoute = inst.data.list[from].pagePath;

    const r = tap(inst, i);

    if (item.key === 'publish') {
      if (r.calls[0] === 'NAV:/pages/publish/publish') ok('点「发布」→ navigateTo 正确');
      else no('点「发布」应 navigateTo，实际: ' + JSON.stringify(r.calls));
      continue;
    }

    const switched = r.calls.indexOf(item.pagePath) > -1;
    const hi = inst.data.selected === i;
    if (switched && hi) {
      ok('点「' + item.text + '」→ switchTab(' + item.pagePath + ') + 高亮[' + i + ']');
    } else {
      no('点「' + item.text + '」失败 → switchTab=' + JSON.stringify(r.calls) + ' 高亮=' + inst.data.selected);
    }
  }
}

console.log('\n=== 2. 返回首页时也要能切（双向）===');
{
  const inst = makeInstance();
  inst.setData({ selected: 4 });           // 当前在「我的」
  currentRoute = '/pages/profile/profile';
  const r = tap(inst, 0);                  // 点「首页」
  const item = inst.data.list[0];
  if (r.calls.indexOf(item.pagePath) > -1 && inst.data.selected === 0) {
    ok('「我的」→ 点「首页」→ 切换+高亮都正确');
  } else {
    no('从我的回首页失败: switchTab=' + JSON.stringify(r.calls) + ' 高亮=' + inst.data.selected);
  }
}

console.log('\n=== 3. 点击当前页不应重复 switchTab ===');
{
  const inst = makeInstance();
  inst.setData({ selected: 3 });
  currentRoute = '/pages/message/message';
  const r = tap(inst, 3);
  if (r.calls.length === 0) ok('点当前页 → 不触发 switchTab（避免无谓切换）');
  else no('点当前页仍触发了: ' + JSON.stringify(r.calls));
}

console.log('\n=== 4. 穷举：4×4 所有组合 ===');
{
  const tabIdx = [0, 1, 3, 4];
  let allOk = true;
  for (const from of tabIdx) {
    for (const to of tabIdx) {
      const inst = makeInstance();
      inst.setData({ selected: from });
      currentRoute = inst.data.list[from].pagePath;
      const r = tap(inst, to);
      const target = inst.data.list[to];
      if (from === to) {
        if (r.calls.length !== 0) { allOk = false; no('[' + from + '→' + to + '] 同页不应切换'); }
      } else {
        const good = r.calls.indexOf(target.pagePath) > -1 && inst.data.selected === to;
        if (!good) { allOk = false; no('[' + from + '→' + to + '] 失败'); }
      }
    }
  }
  if (allOk) ok('12 个跨页组合 + 4 个同页组合 全部正确');
}

console.log('\n=== 5. switchTab 目标路径合法性 ===');
{
  const inst = makeInstance();
  let allLegal = true;
  for (let i = 0; i < inst.data.list.length; i++) {
    const item = inst.data.list[i];
    if (item.key === 'publish') continue;
    if (legalTabs.indexOf(item.pagePath) === -1) {
      allLegal = false;
      no('tabBar 里的 ' + item.pagePath + ' 不在 app.json tabBar.list 中');
    }
  }
  if (allLegal) ok('全部 tab 路径都在 app.json 的 tabBar.list 里（' + legalTabs.join(', ') + '）');
}

console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 全部通过：点哪个切哪个，高亮同步正确'));
process.exit(bad ? 1 : 0);
