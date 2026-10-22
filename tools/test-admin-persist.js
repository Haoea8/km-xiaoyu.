/**
 * admin 凭据持久化回归测试。
 *
 * 守护的 bug：早期 db.js 的 flush() 只写 meta/seq 与 meta/config，
 * 内部 load() 只读回 seq / config / initialized —— 都没覆盖 meta.admin，
 * 导致云函数一冷启动 meta.admin 就变 undefined，
 * /admin-api/login 必然 401（与密码设成什么值无关）。
 *
 * 断言：
 *   1) 初始化后内存里有 admin 凭据
 *   2) flush 后云数据库出现 meta/admin 文档（真的落库了）
 *   3) 冷启动（db.ensure(true)）后 admin 仍在，且值正确
 *   4) 冷启动后 adminLogin 仍能成功
 *   5) 自愈：云端 meta/admin 被删掉后，冷启动能补回默认凭据并重新落库
 *   6) 改密码后能持久化（模拟后台改密）
 *   7) 只有 meta/admin 被写，meta/config 不含 admin（避免密码下发给客户端）
 *
 * 用法：node tools/test-admin-persist.js
 */
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/* ---------- mock：与云端一致的「集合 -> 文档」模型 ---------- */
const store = {};
function col(n) { if (!store[n]) store[n] = {}; return store[n]; }
function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) { col(name)[String(id)] = Object.assign({ _id: String(id) }, data); return Promise.resolve({}); },
        get() {
          const d = col(name)[String(id)];
          return d ? Promise.resolve({ data: d }) : Promise.reject(new Error('document does not exist'));
        },
        remove() { delete col(name)[String(id)]; return Promise.resolve({}); }
      };
    },
    where(cond) {
      const match = (d) => Object.keys(cond || {}).every((k) => Array.isArray(d[k]) ? d[k].indexOf(cond[k]) > -1 : d[k] === cond[k]);
      const q = { limit() { return q; }, get() { return Promise.resolve({ data: Object.values(col(name)).filter(match) }); } };
      return q;
    },
    limit() { return { get: () => Promise.resolve({ data: Object.values(col(name)) }) }; },
    skip() { return this; },
    get() { return Promise.resolve({ data: Object.values(col(name)) }); }
  };
}
const fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'mock', init() {}, getWXContext: () => ({}),
  database: () => ({ collection: makeCollection, createCollection(n) { col(n); return Promise.resolve({}); } })
};
const origLoad = Module._load;
Module._load = function (r) { if (r === 'wx-server-sdk') return fakeSdk; return origLoad.apply(this, arguments); };

(async () => {
  const app = require(FN + '/index.js');
  const db = require(FN + '/db.js');
  const auth = require(FN + '/auth.js');

  /* ---------- 1. 初始化 ---------- */
  console.log('=== 1. 初始化（seed + 落库）===');
  for (let i = 0; i < 40; i++) {
    const r = await app.main({ path: '/api/_setup', method: 'POST', data: {} });
    if (r.data && r.data.done) break;
  }
  const memAdmin = db.load().meta && db.load().meta.admin;
  if (memAdmin && memAdmin.username) ok('内存里有 admin 凭据：' + memAdmin.username);
  else no('内存里没有 admin 凭据');

  /* ---------- 2. 真的落库了吗 ---------- */
  console.log('\n=== 2. flush 后云数据库应出现 meta/admin 文档 ===');
  const adminDoc = store.meta && store.meta.admin;
  if (adminDoc && adminDoc.value && adminDoc.value.password) {
    ok('已落库 meta/admin，字段: ' + Object.keys(adminDoc).filter((k) => k !== '_id').join(', '));
  } else {
    no('云数据库里没有 meta/admin（bug 未修复）');
  }

  /* ---------- 3. 冷启动后仍在吗（核心） ---------- */
  console.log('\n=== 3. 冷启动（db.ensure(true)）后 admin 应存活 ===');
  await db.ensure(true);          // 等价于云函数新实例的首次全量加载
  const afterAdmin = db.load().meta && db.load().meta.admin;
  if (afterAdmin && afterAdmin.password) {
    ok('冷启动后 meta.admin = ' + JSON.stringify(afterAdmin));
  } else {
    no('冷启动后 meta.admin = ' + JSON.stringify(afterAdmin) + '（凭据丢失！）');
  }

  /* ---------- 4. 冷启动后还能登录吗 ---------- */
  console.log('\n=== 4. 冷启动后 adminLogin 应成功 ===');
  const t1 = await auth.adminLogin('admin', 'admin');
  if (t1) ok('admin/admin 登录成功（有 token）');
  else no('admin/admin 登录失败 —— 后台在云端无法登录');

  /* ---------- 5. 自愈：云端缺凭据时能补回 ---------- */
  console.log('\n=== 5. 自愈：云端 meta/admin 被删后应补回默认凭据 ===');
  delete store.meta.admin;                       // 模拟老版本遗留下来的空档
  await db.ensure(true);                         // 冷启动 + 自愈
  const healed = db.load().meta && db.load().meta.admin;
  if (healed && healed.username === 'admin') ok('内存已补回默认凭据：' + JSON.stringify(healed));
  else no('未能自愈，meta.admin = ' + JSON.stringify(healed));
  await db.flush();                              // 请求结束的落库
  const healedDoc = store.meta.admin;
  if (healedDoc && healedDoc.value) ok('自愈结果已重新落库');
  else no('自愈后未落库，下次冷启动还会丢');

  /* ---------- 6. 改密码能持久化 ---------- */
  console.log('\n=== 6. 后台改密后应能持久化 ===');
  const nexPw = 'new-pw-' + Date.now();
  db.load().meta.admin.password = nexPw;         // 模拟后台改密
  await db.flush();
  await db.ensure(true);                         // 冷启动
  const afterPw = db.load().meta && db.load().meta.admin;
  if (afterPw && afterPw.password === nexPw) ok('新密码跨冷启动保留');
  else no('新密码丢失，冷启动后为 ' + JSON.stringify(afterPw));
  const t2 = await auth.adminLogin('admin', nexPw);
  if (t2) ok('用新密码登录成功');
  else no('用新密码登录失败');
  const t3 = await auth.adminLogin('admin', 'admin');
  if (!t3) ok('旧密码已失效');
  else no('旧密码仍可登录');

  /* ---------- 7. config 里不能混进 admin（安全） ---------- */
  console.log('\n=== 7. 安全：admin 不能出现在 config 里 ===');
  const cfg = store.meta.config && store.meta.config.value;
  if (cfg && cfg.admin) no('config 里混进了 admin —— 可能随接口下发给客户端，等于泄露后台密码');
  else ok('config 不含 admin（config 会被下发给客户端，必须保持干净）');

  /* ---------- 8. 恢复默认密码，方便后续人工验证 ---------- */
  console.log('\n=== 8. 复位为默认密码 admin ===');
  db.load().meta.admin = { username: 'admin', password: 'admin' };
  await db.flush();
  await db.ensure(true);
  const reset = db.load().meta && db.load().meta.admin;
  if (reset && reset.password === 'admin') ok('已复位：' + JSON.stringify(reset));
  else no('复位失败');

  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ admin 凭据已能跨冷启动保留，登录可用，且不泄露到 config'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
