/**
 * 用 mock 的 wx-server-sdk 真正「加载并调用」云函数，捕捉语法检查抓不到的
 * 运行时错误（如引用已删除的变量、拼错字段名）。
 *
 * mock 一个极简内存数据库，实现 collection().doc().set/get/remove()、
 * createCollection、分页 get()，让云函数能完整跑一遍初始化流程。
 */
const path = require('path');
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';

/* ---------- 极简内存数据库 ---------- */
const store = {};                 // { collection: { id: doc } }
const stats = { gets: 0, sets: 0, creates: 0, removes: 0 };

function col(name) {
  if (!store[name]) { store[name] = {}; }
  return store[name];
}

function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) {
          stats.sets++;
          col(name)[String(id)] = Object.assign({ _id: String(id) }, data);
          return Promise.resolve({ stats: { updated: 1 } });
        },
        get() {
          stats.gets++;
          const d = col(name)[String(id)];
          if (!d) return Promise.reject(new Error('document does not exist'));
          return Promise.resolve({ data: d });
        },
        remove() {
          stats.removes++;
          delete col(name)[String(id)];
          return Promise.resolve({ stats: { removed: 1 } });
        }
      };
    },
    limit() { return { get: () => { stats.gets++; return Promise.resolve({ data: Object.values(col(name)) }); } }; },
    skip() { return this; },
    where() { return { get: () => Promise.resolve({ data: Object.values(col(name)) }) }; },
    get() { stats.gets++; return Promise.resolve({ data: Object.values(col(name)) }); }
  };
}

const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'mock-env',
  init() {},
  getWXContext: () => ({ APPID: 'wxmock' }),
  database: () => ({
    collection: makeCollection,
    createCollection(name) {
      stats.creates++;
      col(name);
      return Promise.resolve({});
    }
  })
};

/* ---------- 注入 mock ---------- */
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeCloud;
  return origLoad.apply(this, arguments);
};

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

async function run() {
  console.log('=== 1. 加载云函数模块 ===');
  let app;
  try {
    delete require.cache[require.resolve(FN + '/index.js')];
    app = require(FN + '/index.js');
    ok('模块加载成功（无引用错误）');
  } catch (e) {
    no('模块加载失败: ' + e.message);
    console.log(e.stack);
    process.exit(1);
  }

  console.log('\n=== 2. 调 /api/_setup 推进初始化 ===');
  let rounds = 0;
  let done = false;
  let lastData = null;
  try {
    for (let i = 0; i < 40; i++) {
      const r = await app.main({ path: '/api/_setup', method: 'POST', data: {} });
      rounds++;
      if (r.code !== 0) { no('第 ' + i + ' 轮返回 code=' + r.code + ' ' + r.message); break; }
      lastData = r.data;
      if (r.data && r.data.done) { done = true; break; }
    }
    if (done) ok('初始化完成，用了 ' + rounds + ' 次调用');
    else no('40 次调用仍未完成，进度: ' + JSON.stringify(lastData && lastData.last));
  } catch (e) {
    no('调用抛异常: ' + e.message);
    console.log(e.stack);
  }

  console.log('\n=== 3. 落库数据检查 ===');
  const expect = { users: 9, listings: 49, posts: 16, groups: 4, walls: 10, resources: 10 };
  for (const [name, want] of Object.entries(expect)) {
    const got = Object.keys(store[name] || {}).length;
    if (got === want) ok(name + ' = ' + got);
    else if (got > 0) no(name + ' = ' + got + '（期望 ' + want + '）');
    else no(name + ' 为空');
  }

  console.log('\n=== 4. 业务接口可用性 ===');
  try {
    const home = await app.main({ path: '/api/home', method: 'GET', data: {} });
    if (home.code === 0 && home.data && Array.isArray(home.data.feed)) {
      ok('/api/home 返回 feed ' + home.data.feed.length + ' 条，zones ' + home.data.zones.length + ' 个');
    } else {
      no('/api/home 返回异常: ' + JSON.stringify(home).slice(0, 200));
    }
  } catch (e) { no('/api/home 抛异常: ' + e.message); }

  try {
    const list = await app.main({ path: '/api/listings?page=1&pageSize=5', method: 'GET', data: {} });
    if (list.code === 0 && list.data && list.data.list) {
      ok('/api/listings 返回 ' + list.data.list.length + ' 条，total=' + list.data.total);
    } else {
      no('/api/listings 返回异常');
    }
  } catch (e) { no('/api/listings 抛异常: ' + e.message); }

  try {
    const posts = await app.main({ path: '/api/posts?sort=new&page=1&pageSize=5', method: 'GET', data: {} });
    if (posts.code === 0 && posts.data && posts.data.list) ok('/api/posts 返回 ' + posts.data.list.length + ' 条');
    else no('/api/posts 返回异常');
  } catch (e) { no('/api/posts 抛异常: ' + e.message); }

  try {
    const wall = await app.main({ path: '/api/wall?page=1&pageSize=5', method: 'GET', data: {} });
    if (wall.code === 0 && wall.data && wall.data.list) ok('/api/wall 返回 ' + wall.data.list.length + ' 条');
    else no('/api/wall 返回异常');
  } catch (e) { no('/api/wall 抛异常: ' + e.message); }

  try {
    const res = await app.main({ path: '/api/resources?page=1&pageSize=5', method: 'GET', data: {} });
    if (res.code === 0 && res.data && res.data.list) ok('/api/resources 返回 ' + res.data.list.length + ' 条');
    else no('/api/resources 返回异常');
  } catch (e) { no('/api/resources 抛异常: ' + e.message); }

  console.log('\n=== 5. 幂等性：再调一次不应重复写 ===');
  try {
    const before = Object.keys(store.users || {}).length;
    const r = await app.main({ path: '/api/_setup', method: 'POST', data: {} });
    const after = Object.keys(store.users || {}).length;
    if (r.code === 0 && r.data.done && before === after) ok('重复调用安全：users 仍为 ' + after + ' 条');
    else no('重复调用异常：' + before + ' → ' + after + '，done=' + (r.data && r.data.done));
  } catch (e) { no('重复调用抛异常: ' + e.message); }

  console.log('\n=== 统计 ===');
  console.log('  读 ' + stats.gets + ' 次 / 写 ' + stats.sets + ' 次 / 建集合 ' + stats.creates + ' 次');

  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 全部通过：云函数可正常加载、初始化并响应业务接口'));
  process.exit(bad ? 1 : 0);
}

run().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
