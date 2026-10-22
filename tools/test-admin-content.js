/**
 * 管理后台「内容侧」接口测试：校园墙 / 学习资源 / 拼团 / 公告编辑。
 *
 * 为什么单独一个文件：test-admin-ui.js 覆盖的是「交易主链路」那 8 个视图，
 * 而首页的 校园墙 / 学习资源 / 拼团 三个入口此前在后台完全没有对应接口，
 * 数量也无处可看。这一组接口是后补的，单独测更容易定位。
 *
 * 默认**只做可逆操作**（隐藏→恢复、临时公告增改删），不会真的关团、不会改密码。
 *   node tools/test-admin-content.js              # 打 3100（默认）
 *   ADMIN_PORT=3101 node tools/test-admin-content.js
 *   ALLOW_PASSWORD=1 node tools/test-admin-content.js   # 额外验证改密码（会写库，但会改回）
 *
 * 断言一律看 `body.code`（云端模式下 /admin-api/* 恒 200，结果在 code 里）。
 */
const http = require('http');

const PORT = Number(process.env.ADMIN_PORT || 3100);
const HOST = process.env.ADMIN_HOST_IP || '127.0.0.1';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };
const info = (m) => console.log('    · ' + m);

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request({ host: HOST, port: PORT, path, method, headers }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(s); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, raw: s, json: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const get = (p, t) => req('GET', p, undefined, t);
const post = (p, b, t) => req('POST', p, b || {}, t);
const put = (p, b, t) => req('PUT', p, b || {}, t);
const del = (p, t) => req('DELETE', p, undefined, t);

/** 云端恒 200，结果在 code；本地是真状态码。统一取出「是不是成功」与「错误码」 */
function unwrap(r) {
  const code = r.json && r.json.code;
  const success = r.status === 200 && code === 0;
  const errCode = success ? 0 : (code || r.status);
  return { success, errCode, data: (r.json && r.json.data) || null, message: (r.json && r.json.message) || '' };
}

(async () => {
  /* ---------- 0. 登录 + 未登录 401 ---------- */
  console.log('=== 0. 鉴权 ===');
  const anon = await get('/admin-api/walls');
  const anonU = unwrap(anon);
  if (anon.status === 401 || anonU.errCode === 401) ok('未登录访问 /admin-api/walls → 401（接口存在且受保护）');
  else if (anon.status === 404) no('/admin-api/walls 返回 404 —— 新接口没生效（云端需重新部署）');
  else no('未登录访问返回 ' + anon.status + ' / code=' + anonU.errCode + '，应为 401');

  const login = await post('/admin-api/login', { username: 'admin', password: 'admin' });
  const lu = unwrap(login);
  if (!lu.success) {
    no('登录失败：' + (lu.message || login.status) + '（若已改过密码，请用新密码手工验证）');
    console.log('\n共 ' + bad + ' 个问题');
    process.exit(1);
  }
  const token = lu.data.token;
  ok('登录成功，token 长度 ' + token.length);

  /* ---------- 1. 仪表盘统计含内容侧 ---------- */
  console.log('\n=== 1. 仪表盘：内容侧数量 ===');
  const st = unwrap(await get('/admin-api/stats', token));
  if (!st.success) no('stats 失败：' + st.message);
  else {
    const t = st.data.totals || {};
    const keys = [['walls', '校园墙'], ['resources', '学习资源'], ['groupsOpen', '进行中拼团'], ['comments', '帖子评论'], ['wallComments', '墙评论']];
    const missing = keys.filter((k) => typeof t[k[0]] !== 'number');
    if (missing.length) no('totals 缺少字段：' + missing.map((m) => m[0]).join(','));
    else ok('totals 含内容侧：' + keys.map((k) => k[1] + ' ' + t[k[0]]).join(' / '));
  }

  /* ---------- 2. 校园墙列表 ---------- */
  console.log('\n=== 2. 校园墙列表 ===');
  const wl = unwrap(await get('/admin-api/walls?page=1', token));
  let wallId = 0, wallOrigStatus = '';
  if (!wl.success) no('walls 列表失败：' + wl.message);
  else {
    const list = wl.data.list || [];
    if (!list.length) no('walls 列表为空（本地种子应有内容）');
    else {
      const w = list[0];
      const need = ['id', 'content', 'anonName', 'authorId', 'likeCount', 'commentCount', 'status', 'timeText'];
      const miss = need.filter((k) => !(k in w));
      if (miss.length) no('字段缺失：' + miss.join(','));
      else ok('共 ' + wl.data.total + ' 条，字段齐全（含 authorId，供风控追溯）');
      wallId = w.id; wallOrigStatus = w.status;
      info('样例行：#' + w.id + ' [' + w.status + '] ' + String(w.content).slice(0, 24));
      // 匿名性：后台**不应该**回传作者昵称
      if ('author' in w || 'authorName' in w) no('后台接口回传了作者昵称字段（匿名墙不应泄露）');
      else ok('未回传作者昵称（只有 id，符合匿名设计）');
    }
  }

  /* ---------- 3. 校园墙 隐藏 → 恢复（可逆） ---------- */
  console.log('\n=== 3. 校园墙 隐藏 / 恢复 ===');
  if (!wallId) no('跳过（没有可用的墙内容）');
  else {
    const hide = unwrap(await post('/admin-api/walls/' + wallId + '/status', { op: 'hide' }, token));
    if (!hide.success) no('隐藏失败：' + hide.message);
    else {
      const hidden = unwrap(await get('/admin-api/walls?status=hidden&page=1', token));
      const found = ((hidden.data && hidden.data.list) || []).some((x) => x.id === wallId);
      if (found) ok('隐藏后能在 status=hidden 列表里查到 #' + wallId);
      else no('隐藏后查不到 #' + wallId + '（status 没写进去？）');

      const show = unwrap(await post('/admin-api/walls/' + wallId + '/status', { op: 'show' }, token));
      if (!show.success) no('恢复失败：' + show.message);
      else {
        const back = unwrap(await get('/admin-api/walls?status=on&page=1', token));
        const okBack = ((back.data && back.data.list) || []).some((x) => x.id === wallId && x.status === 'on');
        if (okBack) ok('恢复后回到显示中（已还原，未留副作用）');
        else no('恢复后没回到 on');
      }
    }
    // 非法操作要被拒
    const badOp = unwrap(await post('/admin-api/walls/' + wallId + '/status', { op: 'boom' }, token));
    if (!badOp.success) ok("非法 op 被拒（" + badOp.errCode + '）');
    else no('非法 op 竟然成功了');
  }

  /* ---------- 4. 学习资源 ---------- */
  console.log('\n=== 4. 学习资源列表 + 隐藏/恢复 ===');
  const rl = unwrap(await get('/admin-api/resources?page=1', token));
  let resId = 0;
  if (!rl.success) no('resources 列表失败：' + rl.message);
  else {
    const list = rl.data.list || [];
    if (!list.length) no('resources 列表为空');
    else {
      const r = list[0];
      const need = ['id', 'title', 'course', 'category', 'uploaderId', 'downloads', 'status'];
      const miss = need.filter((k) => !(k in r));
      if (miss.length) no('字段缺失：' + miss.join(','));
      else ok('共 ' + rl.data.total + ' 条，字段齐全');
      resId = r.id;
      if (r.status === 'deleted') no('默认列表里出现了 status=deleted 的资料（应被过滤）');
      else ok('默认列表已过滤 deleted');
    }
  }
  if (!resId) no('跳过资源写操作');
  else {
    const hide = unwrap(await post('/admin-api/resources/' + resId + '/status', { op: 'hide' }, token));
    if (!hide.success) no('资源隐藏失败：' + hide.message);
    else {
      const list = unwrap(await get('/admin-api/resources?status=hidden&page=1', token));
      const found = ((list.data && list.data.list) || []).some((x) => x.id === resId);
      if (found) ok('隐藏后能在 status=hidden 查到 #' + resId);
      else no('隐藏后查不到 #' + resId);
      const show = unwrap(await post('/admin-api/resources/' + resId + '/status', { op: 'show' }, token));
      if (show.success) ok('已恢复（未留副作用）');
      else no('恢复失败：' + show.message);
    }
  }

  /* ---------- 5. 拼团列表 + 关团保护 ---------- */
  console.log('\n=== 5. 拼团列表 + 关团保护 ===');
  const gl = unwrap(await get('/admin-api/groups?page=1', token));
  if (!gl.success) no('groups 列表失败：' + gl.message);
  else {
    const list = gl.data.list || [];
    if (!list.length) no('groups 列表为空');
    else {
      const g = list[0];
      const need = ['id', 'listingId', 'targetCount', 'memberCount', 'paidCount', 'status', 'statusText'];
      const miss = need.filter((k) => !(k in g));
      if (miss.length) no('字段缺失：' + miss.join(','));
      else ok('共 ' + gl.data.total + ' 个团，字段齐全；样例 #' + g.id + ' ' + g.paidCount + '/' + g.targetCount + ' ' + g.status);
    }

    // 有已付款成员的团：必须拒绝关团（把提示说清楚，而不是只回 400）
    const paidGroup = list.find((x) => x.status === 'open' && x.paidCount > 0);
    if (paidGroup) {
      const r = unwrap(await post('/admin-api/groups/' + paidGroup.id + '/close', {}, token));
      if (!r.success && /付款/.test(r.message)) ok('已付款的团被拒（' + r.errCode + '：' + r.message + '）');
      else no('已付款的团竟然允许关（' + r.errCode + ' ' + r.message + '）—— 钱的状态不能被后台随手改');
    } else info('当前没有「进行中且已付款」的团，跳过该项');

    // 已结束的团：重复关也要拒
    const closed = list.find((x) => x.status !== 'open');
    if (closed) {
      const r = unwrap(await post('/admin-api/groups/' + closed.id + '/close', {}, token));
      if (!r.success) ok('已结束的团再次关团被拒（' + r.errCode + '）');
      else no('已结束的团还能被再关一次');
    } else info('当前没有已结束的团，跳过该项');

    // 不存在的团
    const r404 = unwrap(await post('/admin-api/groups/99999999/close', {}, token));
    if (!r404.success) ok('不存在的团返回错误（' + r404.errCode + '）');
    else no('关一个不存在的团竟然成功');
  }

  /* ---------- 6. 公告 编辑（自建 → 改 → 删） ---------- */
  console.log('\n=== 6. 公告编辑（增 → 改 → 删） ===');
  const mark = '[自测] 临时公告 ' + Date.now();
  const add = unwrap(await post('/admin-api/notices', { title: mark, content: '原始内容' }, token));
  if (!add.success) no('新建测试公告失败：' + add.message);
  else {
    const nid = add.data.notice.id;
    const upd = unwrap(await put('/admin-api/notices/' + nid, { title: mark + ' 改', content: '改过的内容' }, token));
    if (!upd.success) no('PUT 公告失败：' + upd.message + '（云端是否已部署新路由？）');
    else {
      const list = unwrap(await get('/admin-api/notices', token));
      const got = (list.data && list.data.list || []).find((x) => x.id === nid);
      if (got && got.content === '改过的内容' && /改$/.test(got.title)) ok('公告内容已更新，列表读到的是新值');
      else no('公告更新后列表仍是旧值');
    }
    // 空标题要被拒
    const empty = unwrap(await put('/admin-api/notices/' + nid, { title: '   ' }, token));
    if (!empty.success) ok('空标题被拒（' + empty.errCode + '）');
    else no('空标题竟然能保存');
    const rm = unwrap(await del('/admin-api/notices/' + nid, token));
    if (rm.success) ok('测试公告已删除（未留残留）');
    else no('删除测试公告失败：' + rm.message);
  }

  /* ---------- 7. 举报覆盖 order 类型 ---------- */
  console.log('\n=== 7. 举报：被举报对象解析 ===');
  const rp = unwrap(await get('/admin-api/reports?status=all', token));
  if (!rp.success) no('reports 失败：' + rp.message);
  else {
    const list = rp.data.list || [];
    const types = {};
    list.forEach((r) => { types[r.targetType] = (types[r.targetType] || 0) + 1; });
    ok('共 ' + list.length + ' 条举报，类型：' + JSON.stringify(types));
    const orphan = list.filter((r) => r.targetType && ['listing', 'post', 'user', 'order', 'wall', 'resource'].indexOf(r.targetType) < 0);
    if (orphan.length) no('出现未处理的 targetType：' + orphan.map((r) => r.targetType).join(','));
    else ok('所有 targetType 都在已知集合内');
    const withTarget = list.filter((r) => r.target);
    if (list.length && !withTarget.length) no('所有举报的 target 都是 null（对象解析失败）');
    else ok('target 解析正常：' + withTarget.length + '/' + list.length + ' 条能取到被举报对象');
  }

  /* ---------- 8. 改密码（可选） ---------- */
  if (String(process.env.ALLOW_PASSWORD) === '1') {
    console.log('\n=== 8. 修改管理员密码（会写库，跑完改回） ===');
    const wrong = unwrap(await post('/admin-api/password', { oldPassword: 'definitely-wrong', newPassword: 'abc123456' }, token));
    if (!wrong.success) ok('原密码错误被拒（' + wrong.errCode + '）');
    else no('错误的原密码竟然通过了');

    const shortPwd = unwrap(await post('/admin-api/password', { oldPassword: 'admin', newPassword: '123' }, token));
    if (!shortPwd.success) ok('过短的新密码被拒');
    else no('3 位密码竟然通过了');

    const chg = unwrap(await post('/admin-api/password', { oldPassword: 'admin', newPassword: 'test123456' }, token));
    if (!chg.success) no('改密码失败：' + chg.message);
    else {
      const relogin = unwrap(await post('/admin-api/login', { username: 'admin', password: 'test123456' }));
      if (relogin.success) ok('新密码可以登录');
      else no('新密码登录失败');
      // 改回（用新 token，旧 token 已在改密码时清掉）
      const back = unwrap(await post('/admin-api/password', { oldPassword: 'test123456', newPassword: 'admin' }, relogin.data.token));
      if (back.success) ok('已改回 admin（未留副作用）');
      else no('改回失败，请手工把密码改回：' + back.message);
    }
  } else {
    console.log('\n=== 8. 改密码：已跳过（设 ALLOW_PASSWORD=1 才跑） ===');
  }

  console.log('\n' + (bad ? '✗ 共 ' + bad + ' 个问题' : '✅ 内容侧接口全部通过'));
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e && e.message);
  console.error('确认服务已启动：node server/src/index.js（端口 ' + PORT + '）');
  process.exit(1);
});
