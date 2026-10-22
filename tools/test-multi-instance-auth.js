/**
 * 复现并验证「多实例登录态丢失」问题。
 *
 * 场景：
 *   实例 A 处理登录（写 session）→ 前端拿到 token
 *   实例 B（更早启动、内存镜像里没有这条 session）处理 /api/me
 *   → 旧实现：查内存找不到 session → 401 → 前端清 token → 表现为「登录成功却仍显示未登录」
 *   → 新实现：直查数据库 → 找到 session → 200
 *
 * 做法：为每个「实例」建立独立的模块缓存（模拟独立内存镜像），
 * 用同一份底层数据库 store 共享数据。
 *
 * 注意（踩过的坑）：清缓存必须在 mod.load 之前，且要用**规范化后的路径**比对 ——
 * Windows 下 Module._cache 的键是反斜杠路径，用正斜杠前缀去比会静默匹配不上，
 * 两个实例就变成共享同一份内存，测试退化为「什么都没验证」。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';
const origLoad = Module._load;

/* ---------- 共享底层数据库（模拟真实云数据库） ---------- */
const store = {};
function col(n) { if (!store[n]) store[n] = {}; return store[n]; }

function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) { col(name)[String(id)] = Object.assign({ _id: String(id) }, data); return Promise.resolve({}); },
        get() {
          const d = col(name)[String(id)];
          if (!d) { const e = new Error('document does not exist'); e.errCode = -502004; return Promise.reject(e); }
          return Promise.resolve({ data: d });
        },
        remove() { delete col(name)[String(id)]; return Promise.resolve({}); }
      };
    },
    where(cond) {
      const match = (d) => Object.keys(cond || {}).every((k) => d[k] === cond[k]);
      const q = {
        limit() { return q; },
        get() { return Promise.resolve({ data: Object.values(col(name)).filter(match) }); }
      };
      return q;
    },
    limit() { return { get: () => Promise.resolve({ data: Object.values(col(name)) }) }; },
    skip() { return this; },
    get() { return Promise.resolve({ data: Object.values(col(name)) }); }
  };
}

function fakeCloud() {
  return {
    DYNAMIC_CURRENT_ENV: 'mock',
    init() {},
    getWXContext: () => ({}),
    database: () => ({ collection: makeCollection, createCollection(n) { col(n); return Promise.resolve({}); } })
  };
}

/* ---------- 创建「一个独立实例」的模块环境 ---------- */
const FN_NORM = path.resolve(FN).replace(/\\/g, '/');
let instances = 0;

/**
 * 每个实例独立的 require 缓存 → 独立的 db.js 内存镜像。
 *
 * ⚠️ 必须在加载**之前**清缓存：
 *   - 清在之后 → db.js 里 `require('./seed')` 会解析出**第二份 db.js**（data 为 null），
 *     表现为「初始化失败：Cannot read properties of null (reading 'seq')」
 *   - 用正斜杠前缀去比 → Windows 下 Module._cache 的键是反斜杠，永远匹配不上，
 *     两个实例其实共享同一份内存，测试就退化成「什么都没验证」
 */
function newInstance(label) {
  let cleared = 0;
  for (const k of Object.keys(Module._cache)) {
    const norm = k.replace(/\\/g, '/');
    if (norm.startsWith(FN_NORM + '/') && norm.indexOf('/node_modules/') === -1) { delete Module._cache[k]; cleared++; }
  }
  if (instances++ > 0 && cleared === 0) {
    throw new Error('未能清理模块缓存，实例之间不会真正隔离（检查路径分隔符/大小写）');
  }
  const load = (request, parent, isMain) => {
    if (request === 'wx-server-sdk') return fakeCloud();
    return origLoad.call(Module, request, parent, isMain);
  };
  const mod = new Module(FN + '/index.js', null);
  mod.filename = FN + '/index.js';
  mod.paths = Module._nodeModulePaths(FN);

  const prevLoad = Module._load;
  Module._load = load;
  try {
    mod.load(FN + '/index.js');
  } finally {
    Module._load = prevLoad;
  }
  return mod.exports;
}

/* ---------- 运行 ---------- */
let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

(async () => {
  console.log('=== 准备：实例 A 完成初始化 ===');
  const A = newInstance('A');
  for (let i = 0; i < 40; i++) {
    const r = await A.main({ path: '/api/_setup', method: 'POST', data: {} });
    if (r.data && r.data.done) break;
  }
  const userCount = Object.keys(store.users || {}).length;
  console.log('  库中 users = ' + userCount);

  console.log('\n=== 实例 B 在「登录之前」就启动（模拟并发实例） ===');
  const B = newInstance('B');
  // B 先跑一次业务请求，把数据加载进自己的内存镜像
  const warm = await B.main({ path: '/api/home', method: 'GET', data: {} });
  console.log('  B 预热 /api/home → code=' + warm.code);

  console.log('\n=== 实例 A 处理登录 ===');
  const login = await A.main({ path: '/api/login', method: 'POST', data: { testUserId: 2 } });
  if (login.code !== 0) { no('登录失败: ' + login.message); process.exit(1); }
  const token = login.data.token;
  ok('登录成功，token = ' + token.slice(0, 12) + '…  userId=' + login.data.user.id);

  console.log('\n=== 关键：用实例 B 校验这个 token（B 内存里没有该 session） ===');
  const me = await B.main({ path: '/api/me', method: 'GET', data: {}, token });

  if (me.code === 0 && me.data.user) {
    ok('/api/me 通过（实例 B 直查数据库拿到 session）');
    ok('返回用户: ' + me.data.user.nickname);
  } else {
    no('/api/me 失败 code=' + me.code + ' ' + (me.message || ''));
    no('→ 这正是导致「登录成功却显示未登录」的原因');
  }

  console.log('\n=== 反向验证：伪造 token 必须被拒 ===');
  const fake = await B.main({ path: '/api/me', method: 'GET', data: {}, token: 'not_a_real_token' });
  if (fake.code === 401) ok('伪造 token → 401（鉴权有效）');
  else no('伪造 token 未被拒绝，code=' + fake.code);

  console.log('\n=== 多实例交叉校验 ===');
  {
    const C = newInstance('C');
    await C.main({ path: '/api/home', method: 'GET', data: {} });
    const me3 = await C.main({ path: '/api/me', method: 'GET', data: {}, token });
    if (me3.code === 0) ok('第三个实例 C 也能通过（不依赖内存镜像）');
    else no('实例 C 校验失败 code=' + me3.code);
  }

  console.log('\n=== sessions 落库格式 ===');
  {
    const keys = Object.keys(store.sessions || {});
    if (keys.indexOf(token) > -1) ok('session 以 token 作为 _id 落库（O(1) 直查）');
    else no('session 未按 token 落库，keys=' + keys.join(','));
  }

  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 多实例登录态问题已修复'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
