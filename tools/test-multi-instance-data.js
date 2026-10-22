/**
 * 多实例「内存镜像过期」回归测试 —— 专治「不同人看到的数据不一致」。
 *
 * 真实事故（2026-10-15 多人测试时集中暴露）：
 *   1) 评论被吞：A 发的评论，B 看不到；「评论数 4 条、列表只渲染 2 条」；
 *      不同测试人员看到的评论不一致、不完整，有时完全看不到。
 *   2) 刚发布的商品点进详情「商品不存在」，过一会儿又正常。
 *   3) 收藏后取消不掉（toggle 误判「没收藏过」→ 又插入一条）。
 *
 * 根因是同一个：云函数**多实例**下，每个实例的 `db.get()` 是它**冷启动时的快照**，
 * 之后永不刷新。A 实例写入的数据，B 实例的内存里没有 → B 读不到。
 *
 * ⚠️ 为什么以前的测试测不出来：
 *   所有 mock 都是**单实例**（内存即真相），永远走不到"内存落后于数据库"这条路径。
 *   本测试用「清模块缓存后重新 require」造出两个**真正独立**的实例，
 *   共享同一个 mock 云数据库，从而稳定复现该时序。
 */
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';
const FN_DIR = FN;

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/**
 * 把「两级评论」的响应拍平成一维（顶层 + 各自的 replies）。
 *
 * 2026-10-15 起 `GET /api/posts/:id` 返回的是小红书式两级结构：
 *   { comments: [ {..顶层.., replies: [ {..回复..} ]} ], commentTotal: N }
 * 以前的测试按「扁平数组」写（`data.comments` 直接就是所有评论）——
 * 结构改了之后那些断言会**静默失效**（`some()` 检查顶层就够了、但 `.find(replyTo)` 永远找不到）。
 * 统一用这个函数取值，避免"结构一变、测试变哑"。
 */
const flatComments = (data) => {
  const roots = (data && data.comments) || [];
  const out = [];
  for (const r of roots) {
    out.push(r);
    for (const x of (r.replies || [])) out.push(x);
  }
  return out;
};

/* ---------- 共享的 mock 云数据库（两个实例共用它，模拟云端） ---------- */
const store = {};
const col = (n) => (store[n] = store[n] || {});
const copy = (d) => JSON.parse(JSON.stringify(d));
const rejected = [];   // 记录被拒绝的非法写入（模拟 CloudBase 拒绝 NaN）

/** CloudBase 不接受 NaN 这类非有限数字 —— mock 必须同样抛错，否则会假通过 */
function assertWritable(data, where) {
  const walk = (o, path) => {
    if (o === null || o === undefined) return;
    if (typeof o === 'number' && !Number.isFinite(o)) {
      rejected.push(where + ': NaN/Infinity at ' + path);
      throw new Error('Invalid value at ' + where + ' (' + path + ': not a finite number)');
    }
    if (Array.isArray(o)) o.forEach((v, i) => walk(v, path + '[' + i + ']'));
    else if (typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], path + '.' + k);
  };
  walk(data, 'root');
}
function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) {
          try { assertWritable(data, name + '/' + id); }
          catch (e) { return Promise.reject(e); }
          col(name)[String(id)] = Object.assign({ _id: String(id) }, copy(data));
          return Promise.resolve({});
        },
        get() {
          const d = col(name)[String(id)];
          return d ? Promise.resolve({ data: copy(d) }) : Promise.reject(new Error('doc not found'));
        },
        remove() { delete col(name)[String(id)]; return Promise.resolve({}); }
      };
    },
    where(cond) {
      const match = (d) => Object.keys(cond || {}).every((k) => (Array.isArray(d[k]) ? d[k].indexOf(cond[k]) > -1 : d[k] === cond[k]));
      const q = {
        limit() { return q; },
        skip() { return q; },
        get() { return Promise.resolve({ data: Object.values(col(name)).filter(match).map(copy) }); }
      };
      return q;
    },
    limit() { return { skip() { return this; }, get: () => Promise.resolve({ data: Object.values(col(name)).map(copy) }) }; },
    skip() { return this; },
    get() { return Promise.resolve({ data: Object.values(col(name)).map(copy) }); }
  };
}
const fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'mock', init() { },
  getWXContext: () => ({}),          // 拿不到 openid（模拟真机以外的环境）
  database: () => ({ collection: makeCollection, createCollection(n) { col(n); return Promise.resolve({}); } })
};
const origLoad = Module._load;
Module._load = function (r) { if (r === 'wx-server-sdk') return fakeSdk; return origLoad.apply(this, arguments); };

/**
 * 造一个**全新的云函数实例**：清掉该目录下所有模块缓存后重新 require。
 * 这样 db.js 的模块级内存（data / loaded）是全新的，等价于云端另一个实例。
 *
 * ⚠️ Windows 上 require.cache 的键是**反斜杠**路径，直接和正斜杠前缀比较会匹配不到
 *    → 缓存没清干净 → 两次 require 拿到**同一个实例** → 测试形同虚设。
 *    第一版就栽在这里：反向对照时发现"退回 bug 写法测试依然全绿"。
 *    所以这里统一归一化路径，并由调用方断言两份内存确实是不同对象（见文件末尾自检）。
 */
function loadInstance() {
  const norm = (s) => String(s).replace(/\\/g, '/');
  const prefix = norm(FN_DIR);
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
  /* ---------- 建两个独立实例 ---------- */
  console.log('=== 0. 造两个独立的云函数实例（模拟多实例并发）===');
  const A = loadInstance();
  if (!await setup(A.app)) { no('实例 A 初始化失败'); process.exit(1); }
  const B = loadInstance();
  if (!await setup(B.app)) { no('实例 B 初始化失败'); process.exit(1); }
  ok('两个实例都已就绪（各自持有一份独立的冷启动内存快照）');

  /**
   * ★ 自检（必须在两边**真正加载完内存**之后做）。
   *
   * 注意 `_setup` 只是把数据写进库；实例的内存是**第一次真实业务请求**时才加载的
   * （`_setup` 发现"已初始化"就直接返回，不做全量加载）。
   * 所以这里先各发一次业务请求把内存顶起来，再比较 ——
   * 否则 B 的内存还是 null，自检通过也说明不了问题。
   *
   * 这是本测试成立的前提：若模块缓存没清干净（例如 Windows 下路径分隔符不匹配），
   * 两次 require 会返回同一个实例、共用同一份内存 —— 那样无论代码有没有 bug，
   * 测试都会「全绿」，完全测不出跨实例问题（第一版就是这样假通过的）。
   */
  await A.app.main({ path: '/api/posts?page=1&pageSize=1', method: 'GET', data: {} });
  await B.app.main({ path: '/api/posts?page=1&pageSize=1', method: 'GET', data: {} });
  if (!A.db.raw() || !B.db.raw()) {
    no('★ 实例内存未加载，自检无效（raw() 为空）');
    process.exit(1);
  }
  if (A.db.raw() === B.db.raw()) {
    no('★ 两个实例共用同一份内存 —— 本测试失效（模块缓存未被清掉）');
    console.log('  请检查 loadInstance 的路径归一化（Windows 用反斜杠）');
    process.exit(1);
  }
  ok('★ 自检通过：两份内存是不同对象，且都已加载（确实是两个独立实例）');

  // 登录一个用户（用测试账号，走 testUserId 分支）
  const acc = await A.app.main({ path: '/api/test-accounts', method: 'GET', data: {} });
  const meId = (acc.data.accounts[0] || {}).id;
  const login = await A.app.main({ path: '/api/login', method: 'POST', data: { testUserId: meId } });
  const token = login.data && login.data.token;
  ok('登录成功 id=' + meId);

  /* ---------- 1. 评论：A 发的，B 必须也能看到 ---------- */
  console.log('\n=== 1. 评论跨实例可见（「评论被吞」）===');
  const posts = await A.app.main({ path: '/api/posts?page=1&pageSize=5', method: 'GET', data: {}, token });
  const pid = (posts.data.list[0] || {}).id;
  if (!pid) { no('没有可用的帖子'); process.exit(1); }
  ok('取到帖子 #' + pid);

  // B 先读一次，拿到它自己内存里的评论数（作为基线）
  const b0 = await B.app.main({ path: '/api/posts/' + pid, method: 'GET', data: {}, token });
  const baseCount = b0.data.commentTotal || 0;

  // A 发一条评论（这条只存在于 A 的内存 + 云端数据库里）
  const MARK = '跨实例评论' + Date.now();
  const cmt = await A.app.main({
    path: '/api/posts/' + pid + '/comments', method: 'POST', data: { content: MARK }, token
  });
  if (cmt.code !== 0) no('A 发评论失败：' + cmt.message);
  else ok('A 发出评论：' + MARK);

  // B 再读 → 修复后必须能看到（拍平两级结构后再找）
  const b1 = await B.app.main({ path: '/api/posts/' + pid, method: 'GET', data: {}, token });
  const list = flatComments(b1.data);
  const seen = list.some((c) => c.content === MARK);
  if (seen) ok('B 能看到 A 发的评论（跨实例可见）');
  else no('B 看不到 A 发的评论 —— 「评论被吞 / 不同人看到的不一致」又出现了');

  /* ---------- 2. 评论数必须等于实际条数 ---------- */
  console.log('\n=== 2. 评论数 = 实际列出的条数（「评论数对不上」）===');
  const cnt = b1.data.post && b1.data.post.commentCount;
  if (cnt === list.length) ok('评论数(' + cnt + ') == 实际条数(' + list.length + ')');
  else no('评论数(' + cnt + ') ≠ 实际条数(' + list.length + ') → 前端就会显示「(4) 却只有 2 条」');
  if (b1.data.commentTotal === list.length) ok('commentTotal(' + b1.data.commentTotal + ') == 拍平后的实际条数(' + list.length + ')');
  else no('commentTotal(' + b1.data.commentTotal + ') ≠ 实际条数(' + list.length + ') → 计数字段不可信');
  if (list.length > baseCount) ok('评论条数确实增加了（' + baseCount + ' → ' + list.length + '）');
  else no('评论条数没增加（' + baseCount + ' → ' + list.length + '）');

  /* ---------- 3. 商品：A 发的，B 查详情必须能查到 ---------- */
  console.log('\n=== 3. 刚发布的商品跨实例可见（「商品不存在」）===');
  const pub = await A.app.main({
    path: '/api/listings', method: 'POST', token,
    data: { title: '跨实例商品' + Date.now(), desc: 't', price: 100, zone: 'used', images: ['/static/img/p01.jpg'], tags: ['测试'], tradeMode: 'sell' }
  });
  const lid = pub.data && pub.data.listing && pub.data.listing.id;
  if (!lid) no('A 发布商品失败：' + pub.message);
  else {
    ok('A 发布商品 #' + lid);
    const d = await B.app.main({ path: '/api/listings/' + lid, method: 'GET', data: {}, token });
    if (d.code === 0 && d.data.listing) ok('B 能查到刚发布的商品详情（不会「商品不存在」）');
    else no('B 查不到 → 前端就是「刚发完点进详情：商品不存在」');

    // 列表里也要能看到
    const l = await B.app.main({ path: '/api/listings?page=1&pageSize=60&sort=new', method: 'GET', data: {}, token });
    const inList = ((l.data.list) || []).some((x) => x.id === lid);
    if (inList) ok('B 的商品列表里也能看到它');
    else no('B 的商品列表看不到它（「别人发布的我看不到，过一会又出现」）');

    // 交易区里的锁状态要能算出来（依赖 findActiveOrder 直查）
    if (d.code === 0 && d.data.listing && d.data.listing.lock === null) ok('无占用订单时 lock=null（正常）');
    else ok('lock 字段：' + JSON.stringify(d.data && d.data.listing && d.data.listing.lock));
  }

  /* ---------- 4. 收藏：A 收藏，B 能取消（而不是再加一条） ---------- */
  console.log('\n=== 4. 收藏跨实例可取消（「收藏取消不掉」）===');
  /**
   * 先把状态**归一化到「未收藏」**：种子数据里可能本就有这个用户对该帖的收藏，
   * 直接断言 favorited===true 会误判（第一版测试就栽在这里）。
   * 用详情页返回的 isFavorite 作为权威状态，必要时 toggle 一次。
   */
  const isFavNow = async () => {
    const r = await A.app.main({ path: '/api/posts/' + pid, method: 'GET', data: {}, token });
    return !!(r.data && r.data.post && r.data.post.isFavorite);
  };
  for (let i = 0; i < 3 && await isFavNow(); i++) {
    await A.app.main({ path: '/api/favorites/toggle', method: 'POST', data: { targetType: 'post', targetId: pid }, token });
  }
  if (!await isFavNow()) ok('已把基线归一化到「未收藏」');
  else no('无法把状态归零，本用例无效');

  const fav1 = await A.app.main({ path: '/api/favorites/toggle', method: 'POST', data: { targetType: 'post', targetId: pid }, token });
  if (fav1.code === 0 && fav1.data.favorited === true) ok('A 收藏成功（未收藏 → 已收藏）');
  else no('A 收藏失败：' + (fav1.message || JSON.stringify(fav1.data)));

  // B 来取消 —— 修复前 B 内存里没有这条收藏，会误判「没收藏过」而**再加一条**
  const fav2 = await B.app.main({ path: '/api/favorites/toggle', method: 'POST', data: { targetType: 'post', targetId: pid }, token });
  if (fav2.code === 0 && fav2.data.favorited === false) ok('B 能把 A 的收藏取消掉（toggle 直查数据库生效）');
  else no('B 取消失败，反而又收藏了一次（favorited=' + (fav2.data && fav2.data.favorited) + '）');

  // 详情页的收藏状态要跟着变
  const d2 = await B.app.main({ path: '/api/posts/' + pid, method: 'GET', data: {}, token });
  if (d2.data.post && d2.data.post.isFavorite === false) ok('取消后详情返回 isFavorite=false（图标可复原）');
  else no('详情返回的 isFavorite 不对：' + (d2.data.post && d2.data.post.isFavorite));

  /* ---------- 5. 加回收藏后，另一实例读详情应显示已收藏 ---------- */
  console.log('\n=== 5. 收藏状态跨实例可见（图标要变红实心）===');
  await A.app.main({ path: '/api/favorites/toggle', method: 'POST', data: { targetType: 'post', targetId: pid }, token });
  const d3 = await B.app.main({ path: '/api/posts/' + pid, method: 'GET', data: {}, token });
  if (d3.data.post && d3.data.post.isFavorite === true) ok('B 读到 isFavorite=true（前端可把星标变红实心）');
  else no('B 读到 isFavorite=' + (d3.data.post && d3.data.post.isFavorite) + ' → 图标不会变红');
  // 收尾：取消掉，避免影响其它用例
  await A.app.main({ path: '/api/favorites/toggle', method: 'POST', data: { targetType: 'post', targetId: pid }, token });

  /* ---------- 6. 聊天消息：发了之后从另一个实例重进必须还能看到 ---------- */
  console.log('\n=== 6. 聊天消息跨实例可见（「发了的消息再进去就看不到了」）===');
  {
    // 在 A 实例给 AI 客服发消息（open 不带 peerId 时会落到 AI 会话）
    const open = await A.app.main({ path: '/api/conversations/open', method: 'POST', data: {}, token });
    const convId = open.data && open.data.conversation && open.data.conversation.id;
    if (!convId) no('打不开会话：' + (open.message || ''));
    else {
      ok('A 打开会话 #' + convId + '（对方 ' + (open.data.conversation.peer && open.data.conversation.peer.nickname) + '）');
      const MARK = '跨实例消息' + Date.now();
      const sent = await A.app.main({
        path: '/api/conversations/' + convId + '/messages',
        method: 'POST', data: { content: MARK, type: 'text' }, token
      });
      if (sent.code !== 0) no('A 发消息失败：' + sent.message);
      else ok('A 发出消息：' + MARK);

      /**
       * ★ 关键：**B 实例**用**普通读取**（不带 afterId）看这个会话。
       * 修复前这里走的是内存读取 → 看不到 A 刚发的消息
       *（正是「明明发了的消息，退出去再进来就看不到了，反复进也一样」）。
       */
      const read = await B.app.main({
        path: '/api/conversations/' + convId + '/messages',
        method: 'GET', data: { limit: 50 }, token
      });
      const msgs = (read.data && read.data.list) || [];
      const seen = msgs.some((m) => m.content === MARK);
      if (seen) ok('B 普通读取（无 afterId）也能看到该消息 → 重进聊天页不会再「丢消息」');
      else no('B 普通读取看不到该消息 —— 「发了的消息再进来就没了」又出现了');

      // 会话列表（消息 tab）的预览 / 未读也要跟上。
      // ⚠️ 不能断言"预览 == 我刚发的那条" —— AI 客服会自动回复，
      //    最后一条理应变成 AI 的回复（第一版测试就是这么误判的）。
      //    改为断言：预览是按**最新那条**算的（lastTime 与库里最大 id 那条的 createdAt 一致）。
      const convs = await B.app.main({ path: '/api/conversations', method: 'GET', data: {}, token });
      const conv = ((convs.data && convs.data.list) || []).find((c) => c.id === convId);
      if (conv) {
        let newest = null;
        for (const m of msgs) if (!newest || m.id > newest.id) newest = m;
        if (conv.lastMessage && String(conv.lastMessage).trim()) ok('消息 tab 有预览：' + String(conv.lastMessage).slice(0, 20) + '…');
        else no('消息 tab 预览为空');
        if (newest && Math.abs((conv.lastTime || 0) - newest.createdAt) < 1500) {
          ok('预览时间 = 最新那条消息的时间（说明是按最新数据算的，不是过期快照）');
        } else {
          no('预览时间过期：conv.lastTime=' + conv.lastTime + ' 最新消息=' + (newest && newest.createdAt));
        }
        if (conv.unread > 0) ok('未读数也算得出来（unread=' + conv.unread + '）');
        else no('未读数为 0 —— 别的实例发的消息没被算进未读');
      } else no('B 的消息 tab 里找不到该会话');
    }
  }

  /* ---------- 7. 评论回复关系（replyToName）+ 小红书式两级嵌套 ---------- */
  console.log('\n=== 7. 回复别人：缩在那条评论底下；「回复某人」只在该显示时显示 ===');
  {
    // 先发一条"母评论"（= 顶层大评论），再针对它回复
    const mom = await A.app.main({
      path: '/api/posts/' + pid + '/comments', method: 'POST', data: { content: '母评论' + Date.now() }, token
    });
    const momId = mom.data && mom.data.comment && mom.data.comment.id;
    if (!momId) no('母评论创建失败');
    else {
      const R1 = '回楼主' + Date.now();
      await A.app.main({
        path: '/api/posts/' + pid + '/comments', method: 'POST',
        data: { content: R1, replyTo: momId }, token
      });
      const r = await B.app.main({ path: '/api/posts/' + pid, method: 'GET', data: {}, token });

      // ① 拍平后能按 replyTo 找回这条回复（跨实例）
      const target = flatComments(r.data).find((c) => c.content === R1);
      if (!target) no('没找到回复的那条评论');
      /**
       * ★ 回复**顶层大评论** → 不应显示「回复某人」。
       * 那条回复本来就缩在这条大评论底下，再写一遍「回复 楼主」是冗余的。
       */
      else if (target.replyToName) no('回复顶层大评论却带了 replyToName(' + target.replyToName + ') → 会多显示一行「回复 楼主」');
      else ok('★ 回复顶层大评论 → 不显示「回复某人」（符合预期）');

      // ② 小红书式结构：这条回复必须挂在母评论那一楼的 replies 里，**不是单开一层**
      const roots = (r.data.comments) || [];
      const root = roots.find((c) => Number(c.id) === Number(momId));
      if (!root) no('母评论没出现在顶层（它应该是一层楼）');
      else {
        const nested = (root.replies || []).some((x) => x.content === R1);
        if (nested) ok('回复缩在母评论的 replies 里（两级结构，非单开一条评论）');
        else no('回复没挂在母评论底部 → 前端会变成「直接回复帖子」那种平铺');
        // 回复不该再作为顶层出现（否则会重复显示）
        const dupTop = roots.some((c) => c.content === R1);
        if (!dupTop) ok('该回复没有在顶层重复出现（不会重复渲染）');
        else no('该回复同时出现在顶层 → 会重复显示');

        // ③ ★ 回复**大评论下面的子评论** → 必须显示「回复 某人」
        const sub = (root.replies || []).find((x) => x.content === R1);
        if (!sub) no('找不到那条子评论，无法验证第二级回复');
        else {
          const R2 = '回子评论' + Date.now();
          const r2 = await A.app.main({
            path: '/api/posts/' + pid + '/comments', method: 'POST',
            data: { content: R2, replyTo: sub.id }, token
          });
          const expectName = (r2.data && r2.data.comment && r2.data.comment.replyToName) || '';
          if (expectName) ok('★ 回复子评论 → 带上了被回复者昵称（' + expectName + '）');
          else no('★ 回复子评论却没带 replyToName → 看不出在回谁');

          // 跨实例再读一次，确认走的是同一套规则
          const r3 = await B.app.main({ path: '/api/posts/' + pid, method: 'GET', data: {}, token });
          const t2 = flatComments(r3.data).find((c) => c.content === R2);
          if (t2 && t2.replyToName) ok('跨实例读到的也是「回复 ' + t2.replyToName + '」');
          else no('跨实例读这条回复时 replyToName 丢了（' + (t2 && t2.replyToName) + '）');
        }
      }
    }
  }

  /* ---------- 8. 评论读取的兜底：postId 存成字符串也要读得到 ---------- */
  console.log('\n=== 8. 评论读取兜底（「外面显示 2 条、进去一条都没有」）===');
  {
    /**
     * 真实场景：帖子卡片上显示「💬 2」，点进详情却是「全部评论（0）」。
     * 一类成因是 `where({postId: 2})` **查不到** —— 历史数据可能把 postId
     * 存成了字符串（"2" ≠ 2），而 `where` 匹配不上时**不报错、返回空数组**，
     * 于是被当成「这个帖子没有评论」。修法是加一级「全量拉取 + Number 比对」的兜底。
     *
     * 这里直接在共享云库里造一条 postId 为**字符串**的评论：
     * 两个实例的内存里都没有它 → 只能靠兜底查库拿到。
     */
    const SPOST = 987002;
    const SCID = 987002;
    col('posts')[String(SPOST)] = {
      _id: String(SPOST), id: SPOST, authorId: 2, circleId: 1, content: '字符串 postId 的帖子',
      images: [], topics: [], likes: [], likeBase: 0, commentCount: 1, createdAt: Date.now()
    };
    col('comments')[String(SCID)] = {
      _id: String(SCID), id: SCID, postId: String(SPOST),   // ← 故意的：字符串
      authorId: 2, content: '这条评论的 postId 是字符串', replyTo: null, createdAt: Date.now()
    };
    const sd = await B.app.main({ path: '/api/posts/' + SPOST, method: 'GET', data: {}, token });
    const sflat = flatComments(sd.data);
    if (sflat.length === 1) ok('postId 存成字符串的评论也能读到（兜底生效），共 ' + sflat.length + ' 条');
    else no('读不到 → 前端就是「外面显示有评论、进去一条都没有」（实际 ' + sflat.length + ' 条）');
    if (sd.data.commentTotal === sflat.length) ok('commentTotal 与列出的条数一致（' + sd.data.commentTotal + '）');
    else no('commentTotal(' + sd.data.commentTotal + ') 与列出的条数(' + sflat.length + ') 不一致');
  }

  /* ---------- 9. 列表的评论数必须来自真实评论（两个方向都测） ---------- */
  console.log('\n=== 9. 列表上的评论数 = 真实条数（「数字与列表对不上」）===');
  {
    // ① 把存储字段写成脏值（999）→ 列表必须仍返回真实条数
    const posts0 = await A.app.main({ path: '/api/posts?page=1&pageSize=5&sort=new', method: 'GET', data: {}, token });
    const target = ((posts0.data.list) || []).find((p) => Number(p.id) === Number(pid));
    if (!target) no('列表里找不到被测帖子');
    else {
      const realCnt = flatComments((await B.app.main({ path: '/api/posts/' + pid, method: 'GET', data: {}, token })).data).length;
      // 直接改共享云库里的存储值（模拟历史脏值）
      col('posts')[String(pid)].commentCount = 999;
      const l1 = await A.app.main({ path: '/api/posts?page=1&pageSize=5&sort=new', method: 'GET', data: {}, token });
      const got = ((l1.data.list) || []).find((p) => Number(p.id) === Number(pid));
      if (got && got.commentCount === realCnt) ok('存储值被写脏(999)时，列表仍返回真实条数(' + realCnt + ')');
      else no('列表返回 ' + (got && got.commentCount) + '，期望真实条数 ' + realCnt + ' → 「外面 N 条、进去不一致」会复发');

      // ② 反方向：只在存储字段里加、评论集合里不加 → 数字**不能**跟着涨
      col('posts')[String(pid)].commentCount = 8888;
      const l2 = await A.app.main({ path: '/api/posts?page=1&pageSize=5&sort=new', method: 'GET', data: {}, token });
      const got2 = ((l2.data.list) || []).find((p) => Number(p.id) === Number(pid));
      if (got2 && got2.commentCount === realCnt) ok('存储字段不会影响列表数字（反方向也成立）');
      else no('反方向失败：列表返回 ' + (got2 && got2.commentCount) + '，期望 ' + realCnt);
    }
  }

  /* ---------- 10. 头像/昵称：别人后改的资料必须看到最新值，且绝不为空 ---------- */
  console.log('\n=== 10. 头像/昵称跨实例刷新（「加载不出来 / 刷新就没了 / 改了名还是旧的」）===');
  {
    // 真实场景（用户原话）：「头像和名字是我们自己后面各自改各自的」。
    // A 上改（改动落在 A 的内存 + 云库），B 的内存还是冷启动时的旧值。
    const NEWNICK = '改名' + Date.now();
    const NEWAV = '/static/avatars/a05.jpg';
    const patched = await A.app.main({
      path: '/api/me', method: 'PATCH', data: { nickname: NEWNICK, avatar: NEWAV }, token
    });
    if (!patched.data || !patched.data.user) no('A 改资料失败：' + patched.message);
    else ok('A 把自己的昵称/头像改成：' + NEWNICK);

    // A 发一个帖子（作者就是刚改名的用户）
    const np = await A.app.main({
      path: '/api/posts', method: 'POST', token, data: { content: '改名后的帖子' + Date.now(), images: [] }
    });
    const npid = np.data && np.data.post && np.data.post.id;
    if (!npid) no('A 发帖失败：' + np.message);
    else {
      // B 读这个帖子 → 作者昵称/头像必须是新值，且不能为 null
      const d = await B.app.main({ path: '/api/posts/' + npid, method: 'GET', data: {}, token });
      const au = d.data && d.data.post && d.data.post.author;
      if (!au) no('B 读到作者为 null → 页面上「头像和昵称同时空白」');
      else {
        if (au.nickname === NEWNICK) ok('B 看到的是新昵称（' + au.nickname + '）→ 不再「刷新就变回旧的」');
        else no('B 看到旧昵称（' + au.nickname + '，期望 ' + NEWNICK + '）→ 内存镜像过期');
        if (au.avatar === NEWAV) ok('B 看到的是新头像（' + au.avatar + '）');
        else no('B 看到的头像不对（' + au.avatar + '，期望 ' + NEWAV + '）');
      }

      // 评论列表里的作者昵称也不能空白（这里有 4 条评论，比新帖更能说明问题）
      const cpage = await B.app.main({ path: '/api/posts/' + pid, method: 'GET', data: {}, token });
      const cl = flatComments(cpage.data);
      const blank = cl.filter((c) => !c.author || !c.author.nickname);
      if (cl.length && !blank.length) ok('评论里的作者昵称都不为空（' + cl.length + ' 条）');
      else no('有 ' + blank.length + ' 条评论的作者昵称为空（共 ' + cl.length + ' 条）');
    }

    /**
     * 更强的一种：这个人是**别的实例注册的**，B 的内存里根本没有他。
     * 直接在共享库里造一个用户 + 他的帖子（两个实例的内存都不含这两条）。
     * 修复前：B 读 → sellerBrief 找不到人 → author=null → 头像昵称一起空白。
     * 修复后：兜底查库把作者拉进来 → 昵称头像都正确。
     */
    const GHOST = 987001;
    const GPOST = 987001;
    col('users')[String(GHOST)] = { _id: String(GHOST), id: GHOST, nickname: '幽灵同学', avatar: '/static/avatars/a07.jpg', credit: 100, isAI: false };
    col('posts')[String(GPOST)] = { _id: String(GPOST), id: GPOST, authorId: GHOST, circleId: 1, content: '只在云库里的帖子', images: [], topics: [], likes: [], likeBase: 0, commentCount: 0, createdAt: Date.now() };
    const gd = await B.app.main({ path: '/api/posts/' + GPOST, method: 'GET', data: {}, token });
    const ga = gd.data && gd.data.post && gd.data.post.author;
    if (ga && ga.nickname === '幽灵同学') ok('别人注册的用户，B 也能显示正确昵称头像（不再空白）');
    else if (ga && ga.nickname) ok('B 至少给出占位昵称（' + ga.nickname + '），不会是空白');
    else no('B 读到 author=' + JSON.stringify(ga) + ' → 头像昵称同时空白');
  }

  /* ---------- 11. mock 自检 ---------- */
  console.log('\n=== 11. mock 自身是否如实镜像了云数据库行为 ===');
  if (rejected.length) console.log('  （本次记录了 ' + rejected.length + ' 次非法写入被拒：' + rejected.slice(0, 2).join('; ') + '）');
  const nanRej = await (async () => {
    try { await makeCollection('__probe').doc('x').set({ data: { v: NaN } }); return false; }
    catch (e) { return true; }
  })();
  if (nanRej) ok('mock 会拒绝 NaN 写入（与 CloudBase 一致）');
  else no('mock 不拒绝 NaN —— 会掩盖真实问题');

  Module._load = origLoad;
  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 多实例下的评论/商品/收藏/头像昵称全部跨实例一致、计数正确'));
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  Module._load = origLoad;
  console.error('测试崩溃:', e);
  process.exit(1);
});
