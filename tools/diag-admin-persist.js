/**
 * 诊断：admin 凭据在云端能否跨「冷启动」保留？
 *
 * 背景：云函数是「内存态数据 + 显式持久化」的架构。
 * db.js 的 flush() 决定哪些字段会被写进云数据库，load() 决定哪些字段会被读回来。
 * 只有被两者同时覆盖的字段，才能在冷启动后存活。
 *
 * 本脚本 mock 出与云端一致的集合/文档模型，然后：
 *   1) 跑一次初始化（seed），让知识库落库
 *   2) 检查云数据库里到底有哪些 meta 文档
 *   3) 模拟冷启动（强制重新 load），再看 admin 还在不在
 *
 * 用法：node tools/diag-admin-persist.js
 */
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';

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

  console.log('=== 1. 初始化（seed + 落库）===');
  for (let i = 0; i < 40; i++) {
    const r = await app.main({ path: '/api/_setup', method: 'POST', data: {} });
    if (r.data && r.data.done) break;
  }
  console.log('  已完成初始化');

  console.log('\n=== 2. 云数据库 meta 集合里实际有哪些文档 ===');
  const metaDocs = Object.keys(store.meta || {});
  console.log('  文档: ' + (metaDocs.join(', ') || '（无）'));
  for (const d of metaDocs) {
    const v = store.meta[d] || {};
    console.log('    meta/' + d + '  → 字段: ' + Object.keys(v).filter((k) => k !== '_id').join(', '));
  }

  console.log('\n=== 3. 落库的 config 文档里有没有 admin ===');
  const cfgDoc = store.meta && store.meta.config;
  const cfgVal = cfgDoc && cfgDoc.value;
  console.log('  meta/config.value 内容键: ' + (cfgVal ? Object.keys(cfgVal).join(', ') : '（空）'));
  console.log('  含 admin 字段: ' + (cfgVal && cfgVal.admin ? '是' : '否'));

  console.log('\n=== 4. 冷启动前：内存里的 admin 凭据 ===');
  const before = db.load();
  const adminBefore = before.meta && before.meta.admin;
  console.log('  meta.admin = ' + JSON.stringify(adminBefore));
  let loginBefore = null;
  try { loginBefore = await auth.adminLogin('admin', 'admin'); } catch (e) { }
  console.log('  adminLogin("admin","admin") → ' + (loginBefore ? '成功（有 token）' : '失败'));

  console.log('\n=== 5. 模拟冷启动（db.ensure(true) = 新实例首次全量加载）===');
  console.log('  注：db.load() 是同步内存读取（参数被忽略），真正的重载入口是 db.ensure()');
  await db.ensure(true);          // 等同于云函数新实例的首次加载
  const after = db.load();
  const adminAfter = after.meta && after.meta.admin;
  console.log('  meta.admin = ' + JSON.stringify(adminAfter));
  let loginAfter = null;
  try { loginAfter = await auth.adminLogin('admin', 'admin'); } catch (e) { }
  console.log('  adminLogin("admin","admin") → ' + (loginAfter ? '成功（有 token）' : '失败'));

  console.log('\n' + '='.repeat(58));
  const survives = !!(adminAfter && adminAfter.password);
  if (survives) {
    console.log('结论：admin 凭据能跨冷启动保留，云端管理后台可正常登录。');
    console.log('');
    console.log('（该问题已修复：db.js 的 flush() 会写 meta/admin 文档，');
    console.log('  内部 load() 会读回 meta.admin；若云端缺凭据还会自动补默认值。）');
  } else {
    console.log('结论：admin 凭据【无法】跨冷启动保留 —— 说明修复被回退了或未生效。');
    console.log('');
    console.log('历史上出现过的原因（供排查参考）：');
    console.log('  db.js 的 flush() 只写 meta/seq 与 meta/config；');
    console.log('  内部 load() 只读回 seq / config / initialized；');
    console.log('  两处都没覆盖 meta.admin → 冷启动后 admin 变 undefined。');
    console.log('  表现：刚 seed 完能登录，冷启动后 /admin-api/login 一律 401。');
    console.log('');
    console.log('排查方向：确认 db.js 里存在 "meta/admin" 文档的读与写。');
  }
  console.log('='.repeat(58));
  process.exit(0);
})().catch((e) => { console.error('诊断脚本异常:', e); process.exit(1); });
