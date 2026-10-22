/**
 * 「红点点进去看了不消失」回归测试（真实加载 interactions.js，只 mock db/deco/util）。
 *
 * 根因（两段拼起来才是完整的）：
 *   ① 已读写在**实例 A**，角标却被**实例 B** 算：B 的内存里这些互动还是 read:false；
 *   ② `db.fetchByField` **刻意不覆盖**内存已有的同 id 记录（怕冲掉未落库的改动），
 *      于是即使回库查到 read:true，也**不会**把内存里的 false 改过来 —— 红点永远不消。
 *   ③ `unreadCount` 还套了 15 秒 TTL 节流，刚看完退回消息页时可能压根没回库。
 *
 * 断言：
 *   ① 别的实例已经读完（库里 read:true）、本实例内存还是 false → 未读数必须为 0
 *   ② read 只做 false→true 单向合并（内存里已读的不会被库里旧值改回未读）
 *   ③ 本实例 markRead 之后立刻为 0
 *
 * 用法：node tools/test-unread-clear.js
 */
const Module = require('module');

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ✗ ' + m); bad++; };

/* ---------- 会「行为一致」的假数据库：fetchByField 不覆盖内存 ---------- */
const mem = [];    // 本实例内存镜像
const disk = [];   // 云库

const dbMock = {
  get: () => mem,
  find: (name, pred) => (name === 'interactions' ? mem.filter((x) => (pred ? pred(x) : true)) : []),
  findById: (name, id) => mem.find((x) => String(x.id) === String(id)) || null,
  insert: (name, o) => { const d = Object.assign({ id: o.id || mem.length + 1 }, o); mem.push(d); disk.push(Object.assign({}, d)); return d; },
  update: (name, id, patch) => {
    const a = mem.find((x) => String(x.id) === String(id));
    const b = disk.find((x) => String(x.id) === String(id));
    if (a) Object.assign(a, patch);
    if (b) Object.assign(b, patch);
    return a || null;
  },
  saveSoon() { },
  // ★ 真实语义：返回库里的数据，但**只把内存里没有的补进来，绝不覆盖已有项**
  fetchByField: async (name, field, value) => {
    if (name !== 'interactions') return [];
    const rows = disk.filter((d) => String(d[field]) === String(value));
    const have = new Set(mem.map((x) => String(x.id)));
    for (const r of rows) if (!have.has(String(r.id))) mem.push(Object.assign({}, r));
    return rows;
  },
  readAllFromDb: async () => disk.map((d) => Object.assign({}, d)),
  warmUsers: async () => []
};

const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /interactions\.js$/.test(parent.filename || '')) {
    if (request === './db') return dbMock;
    if (request === './deco') return { sellerBrief: () => ({ id: 0, nickname: '', avatar: '' }) };
    if (request === './util') return { relTime: () => '刚刚' };
  }
  return orig.apply(this, arguments);
};

const it = require('D:/wx/campus-xianyu/cloudfunctions/campus/interactions.js');

const seed = () => {
  mem.length = 0; disk.length = 0;
  for (const id of [1, 2, 3]) {
    const row = { id, toUserId: 1, actorId: 9, type: 'post_like', targetType: 'post', targetId: 100, read: false, createdAt: 1700000000000 + id };
    mem.push(Object.assign({}, row));
    disk.push(Object.assign({}, row));
  }
};

(async () => {
  console.log('=== 1. 别的实例已经读完，本实例内存还是未读 → 未读数必须为 0 ===');
  {
    seed();
    const before = await it.unreadCount(1);
    if (before === 3) ok('前置：库与内存都是 3 条未读');
    else no('前置状态不对：' + before);

    // 模拟「在实例 A 点进去看了」：只改库，本实例内存不动
    disk.forEach((r) => { r.read = true; });

    const after = await it.unreadCount(1);
    if (after === 0) ok('未读数归零（fetchByField 不覆盖内存的坑已经补上）');
    else no('未读数仍是 ' + after + ' —— 红点会一直挂着');
  }

  console.log('\n=== 2. read 只做单向合并：不会被库里旧值改回未读 ===');
  {
    seed();
    mem.forEach((r) => { r.read = true; });          // 本实例已读
    disk.forEach((r) => { r.read = false; });        // 库里还是旧值（另一个实例还没看到）
    const n = await it.unreadCount(1);
    if (n === 0) ok('内存里已读的记录保持已读（不会被回库覆盖回去）');
    else no('未读数 ' + n + '，已读被改回未读了');

    // 反向：库里已读、内存未读 → 合并后应为已读
    mem.forEach((r) => { r.read = false; });
    disk.forEach((r) => { r.read = true; });
    const n2 = await it.unreadCount(1);
    if (n2 === 0) ok('反向：库里已读能合并进内存（这正是原 bug 缺失的那一步）');
    else no('反向合并不生效：' + n2);
  }

  console.log('\n=== 3. 本实例 markRead 后立刻为 0 ===');
  {
    seed();
    await it.markRead(1, 0);
    const n = await it.unreadCount(1);
    if (n === 0) ok('markRead(全部) 之后未读为 0');
    else no('markRead 之后仍有 ' + n + ' 条未读');
  }

  console.log('\n=== 4. 列表接口的 unread 与角标同口径 ===');
  {
    seed();
    disk.forEach((r) => { r.read = true; });
    const r = await it.list(1, { page: 1, pageSize: 20 });
    if (r.unread === 0) ok('list().unread 也是 0（不会出现「列表说 0、角标说 3」）');
    else no('list().unread = ' + r.unread);
  }

  console.log('\n' + (bad ? '✗ 有 ' + bad + ' 项失败' : '✓ 全部通过'));
  process.exit(bad ? 1 : 0);
})();
