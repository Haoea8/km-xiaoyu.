/**
 * 云端「管理员会话」回归测试。
 *
 * 背景（真实事故）：管理后台接上云端后，`/admin-api/login` 返回 200 + token
 * （看起来登录成功），但**之后每一个管理接口都 401「请先登录管理后台」**。
 *
 * 根因：`auth.createSession` 里对 userId 一律做了 `Number()` 强转，
 * 而 admin 会话传的是**用户名（字符串）** → `Number('admin')` = **NaN**；
 * CloudBase **拒绝写入 NaN** → set() 抛错被静默吞掉 →
 * 函数**返回了 token，但库里根本没有 session**。
 *
 * 实测证据（云库 sessions 集合）：20 条全是 `type: "user"`，
 * **一条 `type: "admin"` 都没有**。
 *
 * 为什么原来的测试测不出来：mock 的 `set()` 只是
 * `JSON.parse(JSON.stringify(data))`，NaN 会被转成 null 而不报错 ——
 * **mock 只镜像了「正常路径」，没镜像「会抛错的行为」**。
 * 本测试的核心就是补上这一点：mock 会像 CloudBase 一样对 NaN 抛错。
 *
 * 用法：node tools/test-admin-session.js
 */
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';

/* ============================================================
 * mock 数据库：**像 CloudBase 一样拒绝非法值**
 * ============================================================ */
const store = {};
const col = (n) => (store[n] = store[n] || {});
const copy = (d) => JSON.parse(JSON.stringify(d));
const rejected = [];   // 记录被拒绝的非法写入，便于断言

/**
 * 测试开关：置 true 时 sessions 集合的写入必然失败。
 *
 * ⚠️ 不能用「替换 fakeSdk.database」来模拟故障 —— db.js 内部缓存了 _db
 *    （`if (!_db) { ... }`），替换 SDK 后它拿到的还是旧实例，故障模拟不生效。
 *    所以做在这个闭包变量上：makeCollection 每次调用都会读它。
 */
let failSessionsWrite = false;

/**
 * 递归校验：CloudBase 只接受 string / 有限 number / boolean / null /
 * object / array / Date。遇到 NaN、Infinity、undefined、function 一律抛错。
 *
 * ⚠️ 这一段是本测试的**关键**：没有它，NaN 会被 JSON 序列化成 null，
 *    测试会假通过，而云端却是真实失败。
 */
function assertWritable(v, path) {
  if (v === null) return;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(v)) {
      rejected.push({ path, value: String(v) });
      throw new Error('Invalid value at ' + path + ': ' + String(v) + ' is not a finite number');
    }
    return;
  }
  if (v instanceof Date) return;
  if (Array.isArray(v)) { v.forEach((x, i) => assertWritable(x, path + '[' + i + ']')); return; }
  if (t === 'undefined' || t === 'function' || t === 'symbol') {
    rejected.push({ path, value: t });
    throw new Error('Invalid value at ' + path + ': type ' + t + ' is not supported');
  }
  if (t === 'object') { for (const k of Object.keys(v)) assertWritable(v[k], path + '.' + k); return; }
  rejected.push({ path, value: t });
  throw new Error('Invalid value at ' + path + ': unsupported type ' + t);
}

function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) {
          if (name === 'sessions' && failSessionsWrite) {
            return Promise.reject(new Error('模拟云库故障：sessions 写入失败'));
          }
          try {
            assertWritable(data, name + '/' + id);
          } catch (e) {
            return Promise.reject(e);          // ← 与 CloudBase 一致：抛错，而不是存进去
          }
          col(name)[String(id)] = Object.assign({ _id: String(id) }, copy(data));
          return Promise.resolve({});
        },
        get() {
          const d = col(name)[String(id)];
          if (!d) return Promise.reject(new Error('document does not exist'));
          return Promise.resolve({ data: copy(d) });
        },
        remove() { delete col(name)[String(id)]; return Promise.resolve({}); }
      };
    },
    where(cond) {
      const match = (d) => Object.keys(cond || {}).every((k) => d[k] === cond[k]);
      const q = {
        limit() { return q; },
        get() { return Promise.resolve({ data: Object.values(col(name)).filter(match).map(copy) }); }
      };
      return q;
    },
    limit() { return { get: () => Promise.resolve({ data: Object.values(col(name)).map(copy) }) }; },
    // ⚠️ 必须提供 skip()：db.fetchCollection（全量分页读取）会调 col.skip(n)，
    //    缺了它会被 try/catch 吞掉并返回空数组 —— 统计接口就会静默变成全 0。
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

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

(async () => {
  const app = require(FN + '/index.js');

  console.log('=== 准备：初始化 ===');
  for (let i = 0; i < 40; i++) {
    const r = await app.main({ path: '/api/_setup', method: 'POST', data: {} });
    if (r.data && r.data.done) break;
  }
  const adminDoc = (store.meta || {}).admin;
  if (adminDoc) ok('meta.admin 已就绪');
  else console.log('  （注意：meta.admin 缺失时登录会失败，下面会单独说明）');

  console.log('\n=== 1. mock 必须像 CloudBase 一样拒绝 NaN（否则本测试无意义）===');
  {
    rejected.length = 0;
    let threw = false;
    try { await makeCollection('probe').doc('x').set({ data: { v: NaN } }); } catch (e) { threw = true; }
    if (threw && rejected.length) ok('写入 NaN 会抛错（模拟 CloudBase 行为）✓');
    else no('mock 没拒绝 NaN —— 那这个测试就抓不到本次事故，必须先修 mock');
    rejected.length = 0;
  }

  console.log('\n=== 2. 管理员登录：必须真的建出 admin 会话（不能是 NaN）===');
  let token = '';
  {
    const r = await app.main({ path: '/admin-api/login', method: 'POST', data: { username: 'admin', password: 'admin' }, scope: 'admin' });
    if (r.code !== 0) {
      no('登录失败：' + r.message);
      console.log('      （若 meta.admin 不存在，请先执行一次初始化）');
    } else {
      token = r.data.token;
      ok('登录返回 200 + token（长度 ' + token.length + '）');

      const sess = Object.values(store.sessions || {}).find((s) => s.type === 'admin');
      if (sess) ok('云库（mock）里确实建出了 type=admin 的会话');
      else no('库里没有 admin 会话 —— 正是本次事故的症状（登录成功但后续全 401）');

      if (sess && sess.userId === 'admin') ok('会话的 userId 存的是字符串 "admin"（不是 NaN，也不是 null）');
      else no('会话的 userId 不对：' + JSON.stringify(sess && sess.userId));

      if (sess && Number.isFinite(sess.userId)) no('userId 竟然是数字 —— 说明强转仍在，会写出 NaN');
      else ok('userId 未被错误强转成数字');
    }
  }

  console.log('\n=== 3. 用这个 token 访问管理接口必须成功（端到端）===');
  {
    if (!token) { no('没有 token，跳过'); }
    else {
      const me = await app.main({ path: '/admin-api/me', method: 'GET', data: {}, token, scope: 'admin' });
      if (me.code === 0 && me.data && me.data.username === 'admin') ok('/admin-api/me → code=0，username=admin');
      else no('/admin-api/me 失败：code=' + me.code + ' ' + String(me.message || ''));

      const st = await app.main({ path: '/admin-api/stats', method: 'GET', data: {}, token, scope: 'admin' });
      if (st.code === 0 && st.data && st.data.totals) ok('/admin-api/stats → code=0，取到 totals');
      else no('/admin-api/stats 失败：code=' + st.code + ' ' + String(st.message || ''));
    }
  }

  console.log('\n=== 4. 写库真失败时必须「登录失败」，不能给个用不了的 token ===');
  {
    failSessionsWrite = true;
    const r = await app.main({ path: '/admin-api/login', method: 'POST', data: { username: 'admin', password: 'admin' }, scope: 'admin' });
    failSessionsWrite = false;

    const gaveUselessToken = r.code === 0 && r.data && r.data.token;
    if (gaveUselessToken) no('库写失败却仍返回了 token（用户会看到「登录成功但所有操作 401」）');
    else if (r.code !== 0) ok('库写失败 → 登录直接失败并给出原因：' + String(r.message || '').slice(0, 56));
    else no('返回异常：' + JSON.stringify(r).slice(0, 90));
  }

  console.log('\n=== 5. 普通用户登录不受影响（回归）===');
  {
    const r = await app.main({ path: '/api/login', method: 'POST', data: { testUserId: 2 } });
    if (r.code === 0 && r.data && r.data.token) ok('用户登录正常，拿到 token');
    else no('用户登录被破坏：' + String(r.message || ''));
    const sess = Object.values(store.sessions || {}).find((s) => s.type === 'user' && s.userId === 2);
    if (sess) ok('user 会话的 userId 仍是数字 2（没被改成字符串）');
    else no('user 会话的 userId 不对');
    if (r.code === 0) {
      const me = await app.main({ path: '/api/me', method: 'GET', data: {}, token: r.data.token });
      if (me.code === 0) ok('/api/me 正常返回');
      else no('/api/me 失败：' + String(me.message || ''));
    }
  }

  console.log('\n=== 6. 仪表盘数字必须来自数据库（镜像过期也要准）===');
  {
    /**
     * 复现用户上报的现象：「后台刷新时圈子帖子的数一直变来变去，
     * 我删了个帖子加了个新帖子」。
     *
     * 根因：统计接口读 db.get()，那是**本实例冷启动时的快照**；
     * 云函数并发多实例、各自快照时间不同，刷新命中不同实例 → 数字跳。
     *
     * 这里构造真实的「镜像过期」场景：**直接往库里塞一条帖子**（不动内存镜像），
     * 断言统计仍把它算进去 —— 也就是数字来自数据库这个权威源。
     */
    const dbMod = require(FN + '/db.js');
    const mirrorN = dbMod.get('posts').length;   // 镜像条数（全程保持 N 不变）
    const statsPosts = async () => {
      const r = await app.main({ path: '/admin-api/stats', method: 'GET', data: {}, token, scope: 'admin' });
      return (r.data && r.data.totals && r.data.totals.posts);
    };

    // A) 库里比镜像多 1 条 → 统计必须跟着库走
    col('posts')['999001'] = {
      _id: '999001', id: 999001, content: '来自其它实例的帖子',
      authorId: 2, createdAt: Date.now(), likes: [], commentCount: 0
    };
    if (dbMod.get('posts').length === mirrorN) ok('已构造「镜像过期」：库里多了 1 条，但本实例镜像没变');
    else no('没能构造镜像过期 —— 本测试失去意义');
    const nA = await statsPosts();
    if (nA === mirrorN + 1) ok('统计 = ' + nA + '（镜像 ' + mirrorN + ' + 库里新增 1）→ 数字来自数据库 ✓');
    else no('统计没跟上库里的新数据：' + nA + '，期望 ' + (mirrorN + 1));
    delete col('posts')['999001'];               // 复原，便于下一步

    // B) 镜像比库多 1 条 → 统计**不该**算它（反方向，防止实现只对一边）
    const ghost = { id: 999003, content: '只存在于镜像里的帖子', authorId: 2, createdAt: Date.now(), likes: [], commentCount: 0 };
    dbMod.get('posts').push(ghost);
    const nB = await statsPosts();
    if (nB === mirrorN) ok('统计 = ' + nB + '（镜像里的「幽灵帖」没被计入）→ 完全以数据库为准 ✓');
    else no('统计把镜像里的幽灵帖也算进去了：' + nB + '，期望 ' + mirrorN);
    {
      const arr = dbMod.get('posts');            // 清理幽灵帖，避免影响后续用例
      const gi = arr.findIndex((p) => p.id === 999003);
      if (gi > -1) arr.splice(gi, 1);
    }

    // C) 列表接口也要一致（否则「删了帖子列表里还在」）
    col('posts')['999002'] = {
      _id: '999002', id: 999002, content: '另一个实例的帖子-列表可见性',
      authorId: 2, createdAt: Date.now(), likes: [], commentCount: 0
    };
    const pl = await app.main({ path: '/admin-api/posts?page=1', method: 'GET', data: {}, token, scope: 'admin' });
    const seen = (pl.data.list || []).some((p) => p.id === 999002);
    if (seen) ok('「圈子管理」列表也能看到库里的新帖子 → 列表同样直查数据库');
    else no('列表看不到库里新增的帖子（说明列表还在读过期镜像）');
    delete col('posts')['999002'];
  }

  console.log('\n=== 7. 近 7 天曲线用北京时间自然日（云函数跑在 UTC）===');
  {
    const utilFn = require(FN + '/util.js');
    const s0 = utilFn.bjDayStart(0);
    const asBj = new Date(s0 + utilFn.TZ_OFFSET_MS);
    if (asBj.getUTCHours() === 0 && asBj.getUTCMinutes() === 0 && asBj.getUTCSeconds() === 0) {
      ok('bjDayStart(0) 落在北京时间 0 点整');
    } else {
      no('bjDayStart(0) 不是北京 0 点：' + asBj.toISOString());
    }
    if (s0 <= Date.now() && Date.now() < s0 + 86400e3) ok('当前时刻落在「今天」区间内');
    else no('区间不对：' + new Date(s0).toISOString() + ' ~ ' + new Date(s0 + 86400e3).toISOString());

    // 直接钉住换算关系：北京 0 点 = UTC 前一天 16:00。
    // 旧实现用 new Date().getFullYear()/getMonth()/getDate()（UTC 环境）取日界，
    // 得的是 UTC 0 点，会把北京 0:00~8:00 的数据算到前一天。
    const u = new Date(s0);
    if (u.getUTCHours() === 16 && u.getUTCMinutes() === 0) {
      ok('北京 0 点 = UTC 16:00 ✓（旧实现按 UTC 0 点算，会把 0:00~8:00 的数据记到前一天）');
    } else {
      no('日界换算不对：UTC ' + u.getUTCHours() + ':' + u.getUTCMinutes() + '，期望 16:00');
    }

    const lbl = utilFn.bjDayLabel(s0);
    if (/^\d{1,2}\/\d{1,2}$/.test(lbl)) ok('日期标签格式正确：' + lbl);
    else no('标签格式不对：' + lbl);

    // 昨天 / 6 天前的整日步进
    if (utilFn.bjDayStart(1) === s0 - 86400e3) ok('bjDayStart(1) 恰好是前一天');
    else no('日期步进不对');
  }

  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 管理员会话能真正建立，且写库失败时会明确报错'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
