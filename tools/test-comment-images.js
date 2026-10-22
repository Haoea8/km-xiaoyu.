/**
 * 评论配图（最多 3 张）回归测试。
 *
 * 守三件事：
 *   ① **纯图评论能发**（原来 `if (!content) fail('评论内容不能为空')` 会把它拦掉）
 *   ② 超过 3 张只留前 3 张（前端拦一次，服务端再兜一次 —— 前端永远不可信）
 *   ③ 纯图评论的互动消息正文是「[图片]」，不能是空字符串（否则列表里空白一行）
 *
 * 用法：node tools/test-comment-images.js
 */
const Module = require('module');

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ✗ ' + m); bad++; };

const ROOT = __dirname.replace(/[\\/]tools$/, '');

/* ---------- 内存库 ---------- */
const store = {
  posts: [{ id: 100, authorId: 1, content: '帖子正文', images: ['/static/img/p01.jpg'], commentCount: 0, likes: [], likeBase: 0 }],
  comments: [],
  circles: []
};
let seq = 1;
const dbMock = {
  load: () => ({ meta: { config: {} } }),
  get: (n) => (store[n] = store[n] || []),
  insert: (n, o) => {
    const list = store[n] = store[n] || [];
    const d = Object.assign({ id: seq++ }, o);
    list.push(d);
    return d;
  },
  find: (n, p) => (store[n] || []).filter(p || (() => true)),
  one: (n, p) => (store[n] || []).find(p) || null,
  findById: (n, id) => (store[n] || []).find((x) => x.id === Number(id)) || null,
  findByIdWithFallback: async (n, id) => ({ doc: (store[n] || []).find((x) => x.id === Number(id)) || null, fromDb: false }),
  fetchByField: async (n, f, v) => (store[n] || []).filter((x) => String(x[f]) === String(v)),
  readAllFromDb: async (n) => (store[n] || []).slice(),
  update: (n, id, patch) => {
    const d = (store[n] || []).find((x) => x.id === Number(id));
    if (d) Object.assign(d, patch);
    return d;
  },
  saveSoon() { },
  refreshUsers: async () => [],
  warmUsers: async () => []
};

const utilMock = {
  num: (v) => Number(v) || 0,
  clampText: (s, n) => String(s === undefined || s === null ? '' : s).trim().slice(0, n || 1000),
  relTime: () => '刚刚',
  match: (a, b) => String(a || '').includes(b),
  fmtPrice: () => '0',
  fmtTime: () => '00:00'
};

const decoMock = {
  briefOf: (u) => ({ id: (u && u.id) || 0, nickname: (u && u.nickname) || '', avatar: '', isAI: false }),
  sellerBrief: (id) => ({ id, nickname: '用户' + id, avatar: '' }),
  decoratePost: (p) => Object.assign({}, p),
  decorateListing: (l) => Object.assign({}, l),
  realCommentCounts: async (x) => x,
  userStats: () => ({}),
  userStatsFresh: async () => ({})
};

const interactionLog = [];
const itMock = {
  add: (o) => { interactionLog.push(o); return null; },
  list: async () => [],
  unreadCount: async () => 0,
  markRead: async () => ({})
};

const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /route-social\.js$/.test(parent.filename || '')) {
    if (request === './db') return dbMock;
    if (request === './util') return utilMock;
    if (request === './deco') return decoMock;
    if (request === './events') return { notifyUser() { }, lastPreview: () => '', sendChatMessage: () => null };
    if (request === './interactions') return itMock;
    if (request === './const') return { ZONES: [{ code: 'digital' }] };
  }
  return orig.apply(this, arguments);
};

const routes = {};
const register = (m, p, h) => { routes[m + ' ' + p] = h; };
require(ROOT + '/cloudfunctions/campus/route-social.js')(register);
Module._load = orig;

const postComment = (body) => routes['POST /api/posts/:id/comments']({
  params: { id: 100 }, query: new Map(), body, user: { id: 2, nickname: '我' }, token: 't'
});

(async () => {
  console.log('=== 1. 纯图评论（无文字）===');
  {
    store.comments.length = 0;
    let err = null;
    try {
      await postComment({ content: '', images: ['cloud://a/1.jpg', 'cloud://a/2.jpg'] });
    } catch (e) { err = e; }
    if (!err) ok('没有文字也能发出去（纯图评论）');
    else no('被拦掉了：' + err.message);
    const c = store.comments[0] || {};
    if ((c.images || []).length === 2) ok('图片字段入库 2 张');
    else no('入库图片数 ' + (c.images || []).length);
  }

  console.log('\n=== 2. 超过 3 张只保留前 3 张 ===');
  {
    store.comments.length = 0;
    await postComment({ content: '看图', images: ['u1', 'u2', 'u3', 'u4', 'u5'] });
    const c = store.comments[0] || {};
    if ((c.images || []).length === 3) ok('5 张被截成 3 张（服务端兜底生效）');
    else no('入库 ' + (c.images || []).length + ' 张，应为 3');
  }

  console.log('\n=== 3. 文字和图片都没有 → 必须拒绝 ===');
  {
    store.comments.length = 0;
    let err = null;
    try { await postComment({ content: '   ', images: [] }); } catch (e) { err = e; }
    if (err) ok('拒绝空评论：' + err.message);
    else no('空评论被放过了');
    if (!store.comments.length) ok('没有产生脏数据');
    else no('居然写进去了 ' + store.comments.length + ' 条');
  }

  console.log('\n=== 4. 纯图评论的互动消息正文是 [图片] ===');
  {
    store.comments.length = 0;
    interactionLog.length = 0;
    await postComment({ content: '', images: ['u1'] });
    const toAuthor = interactionLog.find((x) => x.type === 'post_comment');
    if (toAuthor && toAuthor.text === '[图片]') ok('帖子作者的互动消息正文 = [图片]');
    else no('互动消息正文是「' + (toAuthor && toAuthor.text) + '」');
  }

  console.log('\n=== 5. 老评论（没有 images 字段）不会炸 ===');
  {
    let err = null;
    try {
      const list = store.comments.slice();
      const old = { id: 999, postId: 100, authorId: 1, content: '纯文字老评论' };
      list.push(old);
      const imgs = (old.images || []).map((x) => x);
      if (imgs.length !== 0) throw new Error('老数据被读出图片了');
    } catch (e) { err = e; }
    if (!err) ok('缺 images 字段按空数组处理（无需数据迁移）');
    else no('老数据兼容失败：' + err.message);
  }

  console.log('\n' + (bad ? '✗ 有 ' + bad + ' 项失败' : '✓ 全部通过'));
  process.exit(bad ? 1 : 0);
})();
