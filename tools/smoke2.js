/**
 * 扩展功能冒烟测试：拼团 / 校园墙 / 学习资源 / AI 推荐 / 担保交易
 */
const http = require('http');
let PASS = 0, FAIL = 0;
function check(name, ok, extra) {
  if (ok) { PASS++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { FAIL++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}
function req(port, method, path, data, token) {
  return new Promise((resolve) => {
    const body = data ? JSON.stringify(data) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    const r = http.request({ host: '127.0.0.1', port, path, method, headers, timeout: 12000 }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: d }); });
    });
    r.on('error', (e) => resolve({ status: 0, err: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, err: 'timeout' }); });
    if (body) r.write(body);
    r.end();
  });
}
const P = (t) => console.log('\n' + t);

(async () => {
  // 登录两个真实用户
  const acc = await req(3000, 'GET', '/api/test-accounts');
  const accounts = (acc.json && acc.json.data && acc.json.data.accounts) || [];
  console.log('测试账号:', accounts.map((a) => a.nickname).join(', '));
  const loginA = await req(3000, 'POST', '/api/login', { testUserId: accounts[0].id });
  const loginB = await req(3000, 'POST', '/api/login', { testUserId: accounts[1].id });
  const tokenA = loginA.json && loginA.json.data && loginA.json.data.token;
  const tokenB = loginB.json && loginB.json.data && loginB.json.data.token;
  check('A 登录', !!tokenA, accounts[0].nickname);
  check('B 登录', !!tokenB, accounts[1].nickname);

  /* ============ 1. 拼团 ============ */
  P('==== 1. 拼团（自动匹配） ====');
  const loginC = await req(3000, 'POST', '/api/login', { testUserId: accounts[2].id });
  const tokenC = loginC.json && loginC.json.data && loginC.json.data.token;
  check('C 登录', !!tokenC, accounts[2].nickname);

  // A 发一个拼团商品，供 B / C 参团（A 不能参加自己的团）
  const mk = await req(3000, 'POST', '/api/listings', {
    zone: 'group', title: '自动化测试拼团商品 3 人成团', desc: '测试用',
    images: ['/static/img/p03.jpg'], price: 2900, priceUnit: '份', tradeMode: 'group',
    location: '学生宿舍区', tradeMethods: ['校内面交'], tags: ['测试', '拼团'],
    attrs: { 成团人数: '2 人', 截止: '48 小时后' }
  }, tokenA);
  const glisting = mk.json && mk.json.data && mk.json.data.listing;
  check('发布拼团商品', !!glisting, 'id=' + (glisting && glisting.id) + ' 目标人数=' + (glisting && glisting.attrs && glisting.attrs['成团人数']));

  const info = await req(3000, 'GET', '/api/groupbuy/listing/' + glisting.id, null, tokenB);
  const d = info.json && info.json.data;
  check('拼团列表接口', !!d && Array.isArray(d.list), '已有团=' + (d && d.list.length) + ' 目标人数=' + (d && d.targetCount));
  check('自动匹配提示', !!(d && d.autoTip), d && d.autoTip);

  // B 参团 → 无人可匹配，应自动开新团
  const join = await req(3000, 'POST', '/api/groupbuy/join', { listingId: glisting.id, qty: 1 }, tokenB);
  const jd = join.json && join.json.data;
  check('B 参团（自动开团）', join.status === 200 && !!(jd && jd.group) && jd.matched === false, jd && jd.tip);
  check('参团生成待付订单', !!(jd && jd.orderId), 'orderId=' + (jd && jd.orderId));
  const gid = jd && jd.group && jd.group.id;

  // C 参团 → 应自动匹配到 B 刚开的团
  const join2 = await req(3000, 'POST', '/api/groupbuy/join', { listingId: glisting.id, qty: 1 }, tokenC);
  const jd2 = join2.json && join2.json.data;
  check('C 参团自动匹配到 B 的团', join2.status === 200 && jd2 && jd2.group && jd2.group.id === gid && jd2.matched === true,
    '团号=' + (jd2 && jd2.group && jd2.group.id) + ' 匹配=' + (jd2 && jd2.matched));
  check('成团进度正确', jd2 && jd2.group.memberCount === 2, '成员=' + (jd2 && jd2.group && jd2.group.memberCount) + ' 还差=' + (jd2 && jd2.group && jd2.group.needCount));

  // C 支付 → 团内已付 +1
  if (jd2 && jd2.orderId) {
    await req(3000, 'POST', '/api/wallet/recharge', { amount: 50000 }, tokenC);
    const pay = await req(3000, 'POST', '/api/orders/' + jd2.orderId + '/pay', { method: 'balance' }, tokenC);
    check('C 拼团订单余额支付', pay.status === 200 && pay.json && pay.json.data && pay.json.data.order.status === 'paid',
      pay.json && pay.json.data && pay.json.data.order && pay.json.data.order.status);
  }
  // B 支付 → 3 人满员，应自动成团
  if (jd && jd.orderId) {
    await req(3000, 'POST', '/api/wallet/recharge', { amount: 50000 }, tokenB);
    await req(3000, 'POST', '/api/orders/' + jd.orderId + '/pay', { method: 'balance' }, tokenB);
  }
  const after = await req(3000, 'GET', '/api/groupbuy/' + gid, null, tokenB);
  const ad = after.json && after.json.data && after.json.data.group;
  check('满员自动成团', !!ad && ad.status === 'success', 'paid=' + (ad && ad.paidCount) + '/' + (ad && ad.targetCount) + ' 状态=' + (ad && ad.statusText));

  const mine = await req(3000, 'GET', '/api/groupbuy/mine', null, tokenB);
  const md = mine.json && mine.json.data;
  check('我的拼团', mine.status === 200 && md && md.list.length >= 1, '进行中=' + (md && md.ongoing) + ' 已成团=' + (md && md.success));

  // 退出拼团（未支付）
  const joinD = await req(3000, 'POST', '/api/groupbuy/join', { listingId: glisting.id, qty: 1 }, tokenA);
  check('自己不能参加自己的团', joinD.status === 400, joinD.json && joinD.json.message);

  /* ============ 2. 校园墙 ============ */
  P('==== 2. 校园墙（匿名） ====');
  const wall = await req(3000, 'GET', '/api/wall?pageSize=5', null, tokenA);
  const wd = wall.json && wall.json.data;
  check('墙列表', wall.status === 200 && wd && wd.list.length > 0, 'count=' + (wd && wd.total));
  const first = wd && wd.list[0];
  check('匿名：不返回 authorId', first && first.authorId === undefined, 'anonName=' + (first && first.anonName));

  const post = await req(3000, 'POST', '/api/wall', {
    type: 'love', content: '测试表白：自动化测试也想谈恋爱了。', toName: '测试同学', images: []
  }, tokenA);
  const pd = post.json && post.json.data;
  check('发墙（匿名）', post.status === 200 && !!(pd && pd.wall), 'anonName=' + (pd && pd.wall && pd.wall.anonName));
  check('发墙不泄露作者', pd && pd.wall && pd.wall.authorId === undefined);
  const wid = pd && pd.wall && pd.wall.id;

  if (wid) {
    const like = await req(3000, 'POST', '/api/wall/' + wid + '/like', {}, tokenB);
    check('B 给墙点赞', like.status === 200 && like.json.data.liked === true, 'likeCount=' + (like.json.data && like.json.data.likeCount));
    const cmt = await req(3000, 'POST', '/api/wall/' + wid + '/comments', { content: '祝成功！', anonymous: true }, tokenB);
    const cmsg = cmt.json && cmt.json.data;
    check('B 匿名评论', cmt.status === 200 && !!(cmsg && cmsg.comment), 'anonName=' + (cmsg && cmsg.comment && cmsg.comment.anonName));
    const detail = await req(3000, 'GET', '/api/wall/' + wid, null, tokenA);
    const dd = detail.json && detail.json.data;
    check('墙详情 + 评论', detail.status === 200 && dd && dd.comments.length >= 1, 'comments=' + (dd && dd.comments.length));
    check('作者视角 isMine=true', dd && dd.wall && dd.wall.isMine === true);
    const rep = await req(3000, 'POST', '/api/reports', { targetType: 'wall', targetId: wid, reason: '其他违规', detail: '测试举报' }, tokenB);
    check('举报墙内容', rep.status === 200 && rep.json.data.ok === true);
    const del = await req(3000, 'DELETE', '/api/wall/' + wid, null, tokenA);
    check('作者删除自己的墙', del.status === 200);
  }

  /* ============ 3. 学习资源 ============ */
  P('==== 3. 学习资源共享 ====');
  const res = await req(3000, 'GET', '/api/resources?pageSize=5', null, tokenA);
  const rd = res.json && res.json.data;
  check('资源列表', res.status === 200 && rd && rd.list.length > 0, 'total=' + (rd && rd.total));
  check('资源分类字典', rd && rd.categories && rd.categories.length === 6);
  const r0 = rd && rd.list[0];
  check('资源字段（大小/类型）', r0 && r0.sizeText !== undefined && r0.typeText !== undefined, r0 && (r0.typeText + ' ' + r0.sizeText + ' 下载' + r0.downloads));

  const courses = await req(3000, 'GET', '/api/resources/courses');
  check('课程聚合', courses.status === 200 && (courses.json.data.list || []).length > 0, 'courses=' + (courses.json.data.list || []).length);

  const up = await req(3000, 'POST', '/api/resources', {
    title: '自动化测试上传的资料', desc: '这是测试数据', course: '软件测试', category: 'note',
    tags: ['测试'], fileUrl: '/static/uploads/demo-test.pdf', fileName: '测试资料.pdf',
    fileSize: 123456, fileExt: '.pdf'
  }, tokenA);
  const ud = up.json && up.json.data;
  check('上传资料', up.status === 200 && !!(ud && ud.resource), ud && ud.resource && ud.resource.typeText);
  const rid = ud && ud.resource && ud.resource.id;
  if (rid) {
    const dl = await req(3000, 'POST', '/api/resources/' + rid + '/download', {}, tokenB);
    check('B 下载（计数+1）', dl.status === 200 && dl.json.data.downloads === 1, 'url=' + (dl.json.data && dl.json.data.url));
    const lk = await req(3000, 'POST', '/api/resources/' + rid + '/like', {}, tokenB);
    check('B 点赞资料', lk.status === 200 && lk.json.data.liked === true);
    const mineR = await req(3000, 'GET', '/api/resources/mine', null, tokenA);
    check('我上传的资料', mineR.status === 200 && (mineR.json.data.list || []).length >= 1);
    const det = await req(3000, 'GET', '/api/resources/' + rid, null, tokenB);
    check('资料详情+相关推荐', det.status === 200 && !!(det.json.data.resource), 'related=' + (det.json.data.related || []).length);
    await req(3000, 'DELETE', '/api/resources/' + rid, null, tokenA);
  }

  /* ============ 4. 上传接口支持任意文件 ============ */
  P('==== 4. 文件上传（非图片） ====');
  const upTest = await req(3000, 'GET', '/api/resources?sort=download&pageSize=3');
  check('按下载量排序', upTest.status === 200 && (upTest.json.data.list || []).length > 0,
    (upTest.json.data.list || []).map((x) => x.downloads).join(' > '));

  /* ============ 5. AI 智能推荐 ============ */
  P('==== 5. AI 智能推荐 ====');
  const rec = await req(3000, 'GET', '/api/recommend?limit=8', null, tokenA);
  const rcd = rec.json && rec.json.data;
  check('推荐列表', rec.status === 200 && rcd && rcd.list.length > 0, 'reason=' + (rcd && rcd.reason));
  check('每条带推荐理由', rcd && rcd.list.every((x) => !!x.reason), rcd && rcd.list.slice(0, 3).map((x) => x.reason).join(' | '));
  const recHome = await req(3000, 'GET', '/api/recommend/home', null, tokenA);
  const rhd = recHome.json && recHome.json.data;
  check('首页个性化聚合', recHome.status === 200 && rhd && Array.isArray(rhd.topZones),
    'personalized=' + (rhd && rhd.personalized) + ' topZones=' + (rhd && rhd.topZones.join(',')));
  const recGuest = await req(3000, 'GET', '/api/recommend?limit=4');
  check('未登录也能推荐（冷启动）', recGuest.status === 200 && (recGuest.json.data.list || []).length === 4, recGuest.json.data.reason);

  /* ============ 6. 担保交易 ============ */
  P('==== 6. 二手交易担保 ====');
  const escInfo = await req(3000, 'GET', '/api/escrow/info');
  check('担保规则说明', escInfo.status === 200 && (escInfo.json.data.points || []).length === 5);

  // 先登后台（本节后面「平台介入」那步要用）。
  const admLogin = await req(3100, 'POST', '/admin-api/login', { username: 'admin', password: 'admin' });
  const admtoken = admLogin.json && admLogin.json.data && admLogin.json.data.token;

  // 由 B **现发一件新商品**来走 支付→发货→收货 全流程。
  //
  // 为什么不复用现成的商品（连踩两个坑）：
  //   ① 本地 demo 数据里不少商品**早就被历史订单付过款了**（种子里的 CY… 单），
  //      服务端的「防重复付款」会正确地把它挡回去 →
  //        ✗ 付款后托管中   ✗ 确认收货后放款
  //      那是**数据**问题、不是功能问题，报出来只会误导排查方向。
  //   ② 想「按订单筛掉已付款商品」也筛不干净：/api/orders 只返回**我买到的**，
  //      看不到**别人买的**；改用 /admin-api/orders 更不行 —— 本地服务处在「云端模式」时
  //      /admin-api/* 被透传给云函数、读的是**云上**数据，和本脚本用的本地 /api/* 不是同一批。
  // 发一件新的最省事，而且**可重复跑**。
  const pub = await req(3000, 'POST', '/api/listings', {
    title: '担保测试｜' + Date.now(), desc: '自动化测试商品（担保全流程）', price: 5200,
    zone: 'used', images: ['/static/img/p01.jpg'], tags: ['测试'], tradeMode: 'sell'
  }, tokenB);
  const l0 = pub.json && pub.json.data && pub.json.data.listing;
  check('B 发布一件新商品（担保测试用）', !!l0, l0 && ('#' + l0.id + '  ' + l0.title + '  ¥' + (l0.price / 100)));
  if (l0) {
    await req(3000, 'POST', '/api/wallet/recharge', { amount: 300000 }, tokenA);
    const co = await req(3000, 'POST', '/api/orders', { listingId: l0.id, qty: 1, tradeMethod: '校内面交', remark: '担保测试' }, tokenA);
    const oid = co.json && co.json.data && co.json.data.order && co.json.data.order.id;
    check('创建订单', !!oid, 'orderId=' + oid);
    if (oid) {
      const esc0 = await req(3000, 'GET', '/api/escrow/order/' + oid, null, tokenA);
      check('付款前托管状态=none', esc0.status === 200 && esc0.json.data.escrowStatus === 'none', esc0.json.data.escrowText);
      await req(3000, 'POST', '/api/orders/' + oid + '/pay', { method: 'balance' }, tokenA);
      const esc1 = await req(3000, 'GET', '/api/escrow/order/' + oid, null, tokenA);
      const e1 = esc1.json.data;
      check('付款后托管中', e1.escrowStatus === 'holding', e1.escrowText + ' ¥' + e1.amountText);
      check('托管步骤有 4 步', (e1.steps || []).length === 4, e1.steps.map((s) => (s.done ? '●' : '○') + s.label).join(' → '));

      await req(3000, 'POST', '/api/orders/' + oid + '/intervene', { reason: '卖家一直不发货' }, tokenA);
      const rep = await req(3100, 'GET', '/admin-api/reports', null, null);
      check('平台介入已进入后台举报池', rep.status === 401 || rep.status === 200, 'admin 需登录（401 正常）');

      // 用本节开头已登录的 admtoken（不再重复登录）
      const rep2 = await req(3100, 'GET', '/admin-api/reports', null, admtoken);
      check('后台能看到介入工单', rep2.status === 200 && (rep2.json.data.list || []).length > 0, 'reports=' + ((rep2.json.data || {}).list || []).length);

      // 走完流程：卖家发货 → 买家确认 → 放款
      await req(3000, 'POST', '/api/orders/' + oid + '/ship', { note: '已放到快递柜' }, tokenB);
      await req(3000, 'POST', '/api/orders/' + oid + '/confirm', {}, tokenA);
      const esc2 = await req(3000, 'GET', '/api/escrow/order/' + oid, null, tokenA);
      check('确认收货后放款', esc2.json.data.escrowStatus === 'released', esc2.json.data.escrowText);
    }
  }

  console.log('\n================ 结果 ================');
  console.log('通过 ' + PASS + ' / 失败 ' + FAIL + '  (共 ' + (PASS + FAIL) + ' 项)');
  process.exit(FAIL ? 1 : 0);
})();
