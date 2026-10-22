// 全链路冒烟测试：登录 -> 充值 -> 发布 -> 下单 -> 支付 -> 聊天 -> 管理端
const http = require('http');

function req(port, method, path, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port, method, path, headers, timeout: 5000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: d.slice(0, 300) }); });
    });
    r.on('error', (e) => resolve({ err: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ err: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

const P = (...a) => console.log(...a);
let pass = 0, failCnt = 0;
function check(name, ok, extra) {
  if (ok) { pass++; P('  [OK] ' + name + (extra ? '  ' + extra : '')); }
  else { failCnt++; P('  [FAIL] ' + name + (extra ? '  ' + extra : '')); }
}

(async () => {
  P('==== 1. 登录（微信授权模拟） ====');
  const loginA = await req(3000, 'POST', '/api/login', { nickname: '冒烟测试A' });
  check('A 登录', !!(loginA.json && loginA.json.data && loginA.json.data.token), 'uid=' + (loginA.json.data && loginA.json.data.user.id));
  const tokenA = loginA.json.data.token, uidA = loginA.json.data.user.id;

  const loginB = await req(3000, 'POST', '/api/login', { nickname: '冒烟测试B' });
  check('B 登录', !!(loginB.json && loginB.json.data && loginB.json.data.token), 'uid=' + (loginB.json.data && loginB.json.data.user.id));
  const tokenB = loginB.json.data.token, uidB = loginB.json.data.user.id;

  P('==== 2. 个人资料 / 钱包 ====');
  const me = await req(3000, 'GET', '/api/me', null, tokenA);
  check('GET /api/me', me.status === 200 && !!(me.json.data.user.stats), JSON.stringify(me.json.data.user.stats));

  const rc = await req(3000, 'POST', '/api/wallet/recharge', { amount: 10000 }, tokenB);
  check('B 充值 100 元', rc.status === 200 && rc.json.data.balance === 10000, 'balance=' + (rc.json.data && rc.json.data.balance));

  P('==== 3. 发布商品 ====');
  const pub = await req(3000, 'POST', '/api/listings', {
    title: '冒烟测试｜四六级耳机', desc: '自动化测试商品', price: 1200, zone: 'used',
    images: ['/static/img/p01.jpg'], tags: ['测试'], tradeMode: 'sell'
  }, tokenA);
  check('A 发布', pub.status === 200 && !!(pub.json.data.listing), 'listingId=' + (pub.json.data && pub.json.data.listing.id));
  const lid = pub.json.data.listing.id;

  P('==== 4. 想要 / 收藏 / 浏览 ====');
  const want = await req(3000, 'POST', '/api/listings/' + lid + '/want', {}, tokenB);
  check('B 点想要', want.status === 200 && want.json.data.wanted === true, 'wantCount=' + (want.json.data && want.json.data.wantCount));
  const fav = await req(3000, 'POST', '/api/favorites/toggle', { targetType: 'listing', targetId: lid }, tokenB);
  check('B 收藏', fav.status === 200 && fav.json.data.favorited === true);
  const favs = await req(3000, 'GET', '/api/favorites', null, tokenB);
  check('B 收藏列表', favs.status === 200 && favs.json.data.items.length >= 1, 'count=' + (favs.json.data && favs.json.data.items.length));
  const detail = await req(3000, 'GET', '/api/listings/' + lid, null, tokenB);
  check('B 浏览详情（写入足迹）', detail.status === 200 && !!detail.json.data.listing, 'views=' + (detail.json.data && detail.json.data.listing.views));

  P('==== 5. 订单全流程 ====');
  const order = await req(3000, 'POST', '/api/orders', { listingId: lid, qty: 1, remark: '冒烟测试' }, tokenB);
  check('B 下单', order.status === 200 && !!(order.json.data.order), 'orderId=' + (order.json.data && order.json.data.order.id) + ' amount=' + (order.json.data && order.json.data.order.payAmount));
  const oid = order.json.data.order.id;

  const pay = await req(3000, 'POST', '/api/orders/' + oid + '/pay', { method: 'balance' }, tokenB);
  check('B 余额支付', pay.status === 200, JSON.stringify(pay.json && pay.json.data).slice(0, 120));

  const ship = await req(3000, 'POST', '/api/orders/' + oid + '/ship', {}, tokenA);
  check('A 发货', ship.status === 200);
  const confirm = await req(3000, 'POST', '/api/orders/' + oid + '/confirm', {}, tokenB);
  check('B 确认收货', confirm.status === 200);
  const od = await req(3000, 'GET', '/api/orders/' + oid, null, tokenB);
  check('订单状态=done', od.json.data.order.status === 'done', 'status=' + (od.json.data.order && od.json.data.order.status));

  P('==== 6. 会话与真人消息 ====');
  const conv = await req(3000, 'POST', '/api/conversations/open', { peerId: uidA, listingId: lid, sendCard: true }, tokenB);
  check('开启会话（带商品卡片）', conv.status === 200 && !!(conv.json.data.conversation), 'convId=' + (conv.json.data && conv.json.data.conversation.id));
  const cid = conv.json.data.conversation.id;
  const msg = await req(3000, 'POST', '/api/conversations/' + cid + '/messages', { content: '你好，耳机还在吗？' }, tokenB);
  check('B 发消息', msg.status === 200 && !!(msg.json.data.message), 'msgId=' + (msg.json.data && msg.json.data.message.id));
  const msgs = await req(3000, 'GET', '/api/conversations/' + cid + '/messages', null, tokenA);
  check('A 拉取消息', msgs.json.data.list.length >= 2, 'count=' + (msgs.json.data.list.length));
  const convs = await req(3000, 'GET', '/api/conversations', null, tokenA);
  check('A 会话列表', convs.status === 200 && !!(convs.json.data.unreadTotal !== undefined), 'unread=' + (convs.json.data && convs.json.data.unreadTotal));

  P('==== 7. AI 客服（REST 落库 + 机器人回复） ====');
  const aiconv = await req(3000, 'POST', '/api/conversations/open', {}, tokenA);
  check('打开 AI 会话', aiconv.status === 200, 'convId=' + (aiconv.json.data && aiconv.json.data.conversation.id));
  const aiCid = aiconv.json.data.conversation.id;
  const aiMsg = await req(3000, 'POST', '/api/conversations/' + aiCid + '/messages', { content: '怎么发布闲置商品？' }, tokenA);
  check('向 AI 提问', aiMsg.status === 200);
  await new Promise((r) => setTimeout(r, 2600));
  const aiMsgs = await req(3000, 'GET', '/api/conversations/' + aiCid + '/messages', null, tokenA);
  const lastMsg = aiMsgs.json.data.list[aiMsgs.json.data.list.length - 1];
  check('AI 已回复', !!(lastMsg && lastMsg.senderId !== uidA && lastMsg.content.length > 4), '「' + (lastMsg && lastMsg.content.slice(0, 60)) + '」');

  P('==== 8. 圈子 ====');
  const circles = await req(3000, 'GET', '/api/circles', null, tokenA);
  check('圈子列表', circles.json.data.list.length >= 5, 'count=' + circles.json.data.list.length);
  const post = await req(3000, 'POST', '/api/posts', { circleId: circles.json.data.list[0].id, content: '冒烟测试帖 #开学季#', images: ['/static/img/c01.jpg'] }, tokenB);
  check('发帖', post.status === 200 && !!(post.json.data.post), 'postId=' + (post.json.data && post.json.data.post.id));
  const pid = post.json.data.post.id;
  const cmt = await req(3000, 'POST', '/api/posts/' + pid + '/comments', { content: '沙发' }, tokenA);
  check('评论', cmt.status === 200);
  const like = await req(3000, 'POST', '/api/posts/' + pid + '/like', {}, tokenA);
  check('点赞', like.status === 200, 'liked=' + (like.json.data && like.json.data.liked));
  const topics = await req(3000, 'GET', '/api/topics', null, tokenA);
  check('话题列表', topics.status === 200 && topics.json.data.list.length >= 3, 'count=' + (topics.json.data && topics.json.data.list.length));

  P('==== 9. 举报 / 浏览记录 / 公告 ====');
  const rep = await req(3000, 'POST', '/api/reports', { targetType: 'listing', targetId: lid, reason: '虚假信息', detail: '冒烟测试' }, tokenB);
  check('举报提交', rep.status === 200 && rep.json.data.ok === true);
  const his = await req(3000, 'GET', '/api/history', null, tokenB);
  check('浏览记录', his.status === 200 && his.json.data.items.length >= 1, 'count=' + (his.json.data && his.json.data.items.length));
  const nt = await req(3000, 'GET', '/api/notices', null, tokenA);
  check('公告列表', nt.status === 200 && nt.json.data.list.length >= 1, 'count=' + (nt.json.data && nt.json.data.list.length));

  P('==== 10. 管理后台 ====');
  const al = await req(3100, 'POST', '/admin-api/login', { username: 'admin', password: 'admin' });
  check('管理员登录', al.status === 200 && !!(al.json.data && al.json.data.token), JSON.stringify(al.json && al.json.data && al.json.data.admin));
  const at = al.json.data && al.json.data.token;
  if (at) {
    const st = await req(3100, 'GET', '/admin-api/stats', null, at);
    check('看板统计', st.status === 200 && !!(st.json.data.totals && st.json.data.totals.users !== undefined), JSON.stringify(st.json.data && st.json.data.totals));
    const rl = await req(3100, 'GET', '/admin-api/reports', null, at);
    check('举报管理', rl.status === 200 && rl.json.data.list.length >= 1, 'count=' + (rl.json.data && rl.json.data.list.length));
    const ul = await req(3100, 'GET', '/admin-api/users?page=1', null, at);
    check('用户管理', ul.status === 200 && ul.json.data.list.length >= 1, 'count=' + (ul.json.data && ul.json.data.list.length));
    const ol = await req(3100, 'GET', '/admin-api/orders', null, at);
    check('订单管理', ol.status === 200 && ol.json.data.list.length >= 1, 'count=' + (ol.json.data && ol.json.data.list.length));
    const ll = await req(3100, 'GET', '/admin-api/listings', null, at);
    check('商品管理', ll.status === 200, 'count=' + (ll.json.data && ll.json.data.total));
  }

  P('==== 11. WebSocket 实时通道 ====');
  const WebSocket = require('D:/wx/campus-xianyu/node_modules/ws');
  const wsA = new WebSocket('ws://127.0.0.1:3000/ws?token=' + tokenA);
  await new Promise((res) => { wsA.on('open', res); wsA.on('error', res); setTimeout(res, 2500); });
  let got = null;
  const waitMsg = new Promise((res) => {
    wsA.on('message', (buf) => { try { const m = JSON.parse(String(buf)); if (m.type === 'message' && m.convId === cid) res(m); } catch (e) {} });
    setTimeout(() => res(null), 3000);
  });
  const wsB = new WebSocket('ws://127.0.0.1:3000/ws?token=' + tokenB);
  await new Promise((res) => { wsB.on('open', res); wsB.on('error', res); setTimeout(res, 2500); });
  wsB.send(JSON.stringify({ type: 'send', convId: cid, content: 'WS 实时消息测试' }));
  got = await waitMsg;
  check('A 实时收到 B 的消息', !!got, got ? '「' + got.message.content + '」' : '未收到');
  wsA.close(); wsB.close();

  P('\n========== 结果：通过 ' + pass + ' / 失败 ' + failCnt + ' ==========');
})();
