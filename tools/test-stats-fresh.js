/**
 * 主页统计「收藏一会 1 一会 2」回归测试。
 *
 * 现象（用户原话）：明明只收藏了一个，不断刷新却时不时显示 1 个、2 个；
 * 在售 / 已卖出 / 已买到 也有同样的抖动。
 *
 * 根因：`deco.userStats()` 走 `db.find`，读的是**本实例冷启动快照**。
 * 收藏写进实例 A，刷新时请求落到实例 B → B 里没有（或还留着已取消的旧记录），
 * 数字就抖。修法：个人主页 / 我的页改用 `userStatsFresh()`，**从库里数**。
 *
 * 附带守一个更隐蔽的坑：`post-create` 上传前的「跳过判断」。
 * 开发者工具的 chooseMedia 返回 `http://tmp/xxx.jpeg`（本机临时文件），
 * 若用 `^https?://` 一刀切跳过上传，就会把这个本地路径存进库 →
 * 开发工具里看得见、手机上一块白（正是用户反馈的现象）。
 *
 * 用法：node tools/test-stats-fresh.js
 */
const Module = require('module');
const fs = require('fs');

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ✗ ' + m); bad++; };

const ROOT = 'D:/wx/campus-xianyu';

/* ---------- 内存镜像（旧）与云库（新）故意不一致 ---------- */
const mem = {
  listings: [{ id: 1, sellerId: 1, status: 'on' }, { id: 2, sellerId: 1, status: 'on' }],
  posts: [{ id: 1, authorId: 1 }, { id: 2, authorId: 1 }],
  orders: [],
  // 内存里还留着一条「已取消收藏」的旧记录 → 数出 2
  favorites: [{ id: 1, userId: 1, listingId: 10 }, { id: 2, userId: 1, listingId: 11 }],
  follows: [{ id: 1, userId: 1, targetUserId: 9 }]
};
const disk = {
  // 库里其实只有 1 件在售、1 条收藏
  listings: [{ id: 1, sellerId: 1, status: 'on' }, { id: 2, sellerId: 1, status: 'sold' }],
  posts: [{ id: 1, authorId: 1 }],
  orders: [],
  favorites: [{ id: 1, userId: 1, listingId: 10 }],
  follows: [{ id: 1, userId: 1, targetUserId: 9 }]
};

let readAllFails = false;

const dbMock = {
  find: (name, pred) => (mem[name] || []).filter(pred || (() => true)),
  readAllFromDb: async (name) => {
    if (readAllFails) throw new Error('mock 读库失败');
    return (disk[name] || []).map((x) => Object.assign({}, x));
  },
  findById: () => null,
  one: () => null,
  get: (n) => mem[n] || []
};

const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /deco\.js$/.test(parent.filename || '')) {
    if (request === './db') return dbMock;
    if (request === './util') return { relTime: () => '刚刚', fmtPrice: () => '0', clampText: (s) => s };
  }
  return orig.apply(this, arguments);
};

const deco = require(ROOT + '/cloudfunctions/campus/deco.js');

(async () => {
  console.log('=== 1. 内存版会数错（这是抖动的来源）===');
  {
    const s = deco.userStats(1);
    if (s.favorites === 2) ok('userStats（内存）数出 2 条收藏 —— 与库里的 1 条不符，正是抖动来源');
    else no('内存版收藏为 ' + s.favorites + '，用例前提不对');
    if (s.published === 2) ok('userStats（内存）在售数出 2 —— 库里其实是 1 在售 + 1 已卖出');
    else no('内存版在售为 ' + s.published);
  }

  console.log('\n=== 2. 库版必须和「真实数据」一致 ===');
  {
    const s = await deco.userStatsFresh(1);
    if (s.favorites === 1) ok('收藏 = 1（不再一会儿 1 一会儿 2）');
    else no('收藏 = ' + s.favorites + '，应为 1');
    if (s.published === 1 && s.sold === 1) ok('在售 = 1、已卖出 = 1（各状态分别数，不重复计）');
    else no('在售 ' + s.published + ' / 已卖出 ' + s.sold);
    if (s.posts === 1) ok('动态 = 1');
    else no('动态 = ' + s.posts);
    if (s.following === 1) ok('关注 = 1');
    else no('关注 = ' + s.following);
  }

  console.log('\n=== 3. 读库失败时要退回内存，不能把页面搞挂 ===');
  {
    readAllFails = true;
    let threw = null;
    let s = null;
    try { s = await deco.userStatsFresh(1); } catch (e) { threw = e; }
    if (!threw && s && s.favorites === 2) ok('读库异常 → 退回内存值（有数字，不抛错）');
    else no('读库异常时行为不对：threw=' + (threw && threw.message) + ' stats=' + JSON.stringify(s));
    readAllFails = false;
  }

  console.log('\n=== 4. 发帖上传：本地临时文件必须上传，不能原样存库 ===');
  {
    const src = fs.readFileSync(ROOT + '/miniprogram/pages/post-create/post-create.js', 'utf8');
    const naive = /if\s*\(\s*\/\^https\?:\/\/\/\.test\(p\)\s*\)\s*\{\s*urls\.push\(p\)/.test(src);
    if (!naive) ok('没有「凡 http(s) 就跳过上传」的一刀切写法');
    else no('又退回了一刀切：开发者工具的 http://tmp/ 会被当成远端图存库（手机必白）');

    if (/localTmp/.test(src) && /\(tmp\|usr\)/.test(src)) ok('有 tmp/usr 本地临时路径的识别（会走上传）');
    else no('缺少本地临时路径识别');
  }

  console.log('\n' + (bad ? '✗ 有 ' + bad + ' 项失败' : '✓ 全部通过'));
  process.exit(bad ? 1 : 0);
})();
