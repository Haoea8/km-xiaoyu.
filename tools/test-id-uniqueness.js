/**
 * 多实例「id 不重复」回归测试 —— 专治**静默丢数据**。
 *
 * 真实事故（用户反馈「经常吞评论信息」）：
 *   云函数是**多实例**的，而 `db.nextId()` 原来用的是**每实例内存里的**计数器
 *   （`data.seq[name] += 1`）。两个实例同时冷启动会各自读到同一个 seq，
 *   各自 +1 → **生成同一个 id** → 两份文档写同一个文档 id →
 *   **后写的覆盖先写的，先写的那条凭空消失**。
 *   表现出来就是：帖子上的评论数被两个实例各 +1（显示 2 条），
 *   而 comments 集合里只剩 1 条甚至 0 条 —— 「外面显示有评论、进去一条都没有」。
 *
 * 修法：id 拆成 `seq * 65536 + 本实例的随机槽位`（见 cloudfunctions/campus/db.js 的 nextId）。
 *   - 跨实例：槽位随机 → 同一 seq 也不撞
 *   - 同实例：seq 递增 → 天然不撞
 *   - 仍随 seq 递增 → 聊天 afterId 游标、「最大 id 即最新消息」照旧成立
 *
 * ★ 本测试用的还是「清模块缓存后重新 require」造两个**真正独立**的实例
 *   （共享同一份 mock 云库），并自检两份内存确实是不同对象 ——
 *   否则两次 require 拿到同一个实例，测试会假通过。
 *
 * 反向对照（已验证会变红）：把 nextId 退回 `return data.seq[name]`
 *   → 「两个实例生成同一个 id」「只落库 1 条（有一条被覆盖）」两项立刻失败。
 *
 * 用法：node tools/test-id-uniqueness.js   （离线，无需启动服务）
 */
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';
const SPAN = 65536;   // 与 db.js 的 ID_SLOT_SPAN 保持一致

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/* ---------- 共享的 mock 云数据库（模拟云端，两个实例共用） ---------- */
const store = {};
const col = (n) => (store[n] = store[n] || {});
const copy = (d) => JSON.parse(JSON.stringify(d));
function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) { col(name)[String(id)] = Object.assign({ _id: String(id) }, copy(data)); return Promise.resolve({}); },
        get() { const d = col(name)[String(id)]; return d ? Promise.resolve({ data: copy(d) }) : Promise.reject(new Error('not found')); },
        remove() { delete col(name)[String(id)]; return Promise.resolve({}); }
      };
    },
    where(cond) {
      const match = (d) => Object.keys(cond || {}).every((k) => (Array.isArray(d[k]) ? d[k].indexOf(cond[k]) > -1 : d[k] === cond[k]));
      const q = { limit() { return q; }, skip() { return q; }, get() { return Promise.resolve({ data: Object.values(col(name)).filter(match).map(copy) }); } };
      return q;
    },
    limit() { return { skip() { return this; }, get: () => Promise.resolve({ data: Object.values(col(name)).map(copy) }) }; },
    skip() { return this; },
    get() { return Promise.resolve({ data: Object.values(col(name)).map(copy) }); }
  };
}
const fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'mock', init() { }, getWXContext: () => ({}),
  database: () => ({ collection: makeCollection, createCollection(n) { col(n); return Promise.resolve({}); } })
};
const origLoad = Module._load;
Module._load = function (r) { if (r === 'wx-server-sdk') return fakeSdk; return origLoad.apply(this, arguments); };

function loadInstance() {
  const norm = (s) => String(s).replace(/\\/g, '/');
  const prefix = norm(FN);
  for (const k of Object.keys(require.cache)) {
    const kn = norm(k);
    if (kn.indexOf(prefix) === 0 && kn.indexOf('node_modules') === -1) delete require.cache[k];
  }
  return { app: require(FN + '/index.js'), db: require(FN + '/db.js') };
}
const setup = async (app) => {
  for (let i = 0; i < 40; i++) {
    const r = await app.main({ path: '/api/_setup', method: 'POST', data: {} });
    if (r.data && r.data.done) return true;
  }
  return false;
};

(async () => {
  console.log('=== 0. 造两个独立的云函数实例（模拟多实例并发）===');
  const A = loadInstance();
  if (!await setup(A.app)) { no('实例 A 初始化失败'); process.exit(1); }
  const B = loadInstance();
  if (!await setup(B.app)) { no('实例 B 初始化失败'); process.exit(1); }

  // 用测试账号登录（**不要硬编码 id** —— id 生成方式变了，写死的号会失效）
  const acc = await A.app.main({ path: '/api/test-accounts', method: 'GET', data: {} });
  const meId = (acc.data.accounts[0] || {}).id;
  const login = await A.app.main({ path: '/api/login', method: 'POST', data: { testUserId: meId } });
  const token = login.data && login.data.token;
  if (!token) { no('登录失败（testUserId=' + meId + '）：' + login.message); process.exit(1); }
  // ⚠️ 必须先各发一次业务请求把内存顶起来（_setup 不加载全量），自检才有意义
  await A.app.main({ path: '/api/posts?page=1&pageSize=1', method: 'GET', data: {}, token });
  await B.app.main({ path: '/api/posts?page=1&pageSize=1', method: 'GET', data: {}, token });
  if (A.db.raw() === B.db.raw()) {
    no('★ 两个实例共用同一份内存 —— 本测试失效（模块缓存没清干净）');
    process.exit(1);
  }
  ok('★ 自检通过：两份内存是不同对象（确实是两个独立实例）');

  /* ---------- 1. 并发创建：id 必须不同 ---------- */
  console.log('\n=== 1. A、B 并发创建记录 → id 不能重复 ===');
  const posts = await A.app.main({ path: '/api/posts?page=1&pageSize=5', method: 'GET', data: {}, token });
  const pid = (posts.data.list[0] || {}).id;
  if (!pid) { no('没有可用的帖子'); process.exit(1); }

  const mark = String(Date.now());
  const [ra, rb] = await Promise.all([
    A.app.main({ path: '/api/posts/' + pid + '/comments', method: 'POST', data: { content: 'A的评论' + mark }, token }),
    B.app.main({ path: '/api/posts/' + pid + '/comments', method: 'POST', data: { content: 'B的评论' + mark }, token })
  ]);
  const idA = ra.data && ra.data.comment && ra.data.comment.id;
  const idB = rb.data && rb.data.comment && rb.data.comment.id;
  if (!idA || !idB) { no('评论创建失败（A=' + (ra.message || idA) + '，B=' + (rb.message || idB) + '）'); process.exit(1); }
  console.log('  A 拿到 id=' + idA + '，B 拿到 id=' + idB);
  if (idA !== idB) ok('两个实例生成的 id **不同**（不再互相覆盖）');
  else no('★ 两个实例生成**同一个 id** (' + idA + ') → 先写的必然被覆盖丢失');

  if (Number.isSafeInteger(idA) && Number.isSafeInteger(idB)) ok('id 仍在安全整数范围内（' + Math.max(idA, idB) + '<  2^53）');
  else no('★ id 超出 Number.MAX_SAFE_INTEGER，精度会丢失');

  /* ---------- 2. 两条评论都必须真的落库 ---------- */
  console.log('\n=== 2. 两条评论都要落库（不能丢） ===');
  const rows = Object.values(col('comments') || {}).filter((r) => String(r.content || '').indexOf(mark) >= 0);
  console.log('  云库里实际存下 ' + rows.length + ' 条：' + JSON.stringify(rows.map((r) => r.id + ':' + r.content)));
  if (rows.length === 2) ok('两条都在（没有数据丢失）');
  else no('★ 只落库 ' + rows.length + ' 条 → 有一条被同 id 覆盖**静默丢失**');

  /* ---------- 3. 详情页要能读到两条，且计数一致 ---------- */
  console.log('\n=== 3. 详情页读得到、且数字与列表一致 ===');
  const d = await B.app.main({ path: '/api/posts/' + pid, method: 'GET', data: {}, token });
  const all = [];
  for (const c of (d.data.comments || [])) { all.push(c); for (const r of (c.replies || [])) all.push(r); }
  const seen = all.filter((c) => String(c.content).indexOf(mark) >= 0);
  if (seen.length === 2) ok('详情页看到两条（不会「发了却少一条」）');
  else no('详情页只看到 ' + seen.length + ' 条');
  if (Number(d.data.post && d.data.post.commentCount) === all.length) ok('评论数与实际列出的条数一致（' + all.length + '）');
  else no('评论数 ' + (d.data.post && d.data.post.commentCount) + ' ≠ 列出条数 ' + all.length);

  /* ---------- 4. seq 反推不能把 id 越推越大 ---------- */
  console.log('\n=== 4. 冷启动时用「最大 id 反推 seq」不能把 id 量级撑爆 ===');
  {
    // 直接验证反推公式：id = seq*SPAN + slot → floor(id/SPAN) 应还原成 seq
    const seqOf = (id) => Math.floor(Number(id) / SPAN);
    const idNow = Math.max(idA, idB);
    const back = seqOf(idNow);
    if (back > 0 && back < 1e6) ok('反推出的 seq=' + back + '（正常量级，不会指数膨胀）');
    else no('★ 反推出的 seq=' + back + ' 异常 → 再乘 SPAN 会迅速超过安全整数');

    // 再跑一次冷启动：seq 应被还原到这个量级，生成的 id 只比刚才大一点
    const C = loadInstance();
    await setup(C.app);
    await C.app.main({ path: '/api/posts?page=1&pageSize=1', method: 'GET', data: {}, token });
    const rc = await C.app.main({ path: '/api/posts/' + pid + '/comments', method: 'POST', data: { content: 'C的评论' + mark }, token });
    const idC = rc.data && rc.data.comment && rc.data.comment.id;
    console.log('  冷启动后的新实例 C 拿到 id=' + idC);
    if (idC && idC > idNow && idC < idNow + 100 * SPAN) ok('C 的 id 只比之前大一点（' + idC + '），量级没有膨胀');
    else no('★ C 的 id=' + idC + ' 异常（对比之前最大 ' + idNow + '）→ 存在膨胀/精度风险');
    if (idC && idC !== idA && idC !== idB) ok('C 与 A、B 的 id 都不重复');
    else no('★ C 与之前的 id 重复了');
  }

  Module._load = origLoad;
  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 多实例并发生成的 id 全部不重复、记录不丢失、id 量级稳定'));
  process.exit(bad ? 1 : 0);
})();
