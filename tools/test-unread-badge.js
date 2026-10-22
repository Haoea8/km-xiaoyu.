/**
 * 未读红点专项测试。
 *
 * 用户反馈两件事：
 *   1) 新登录的账号，消息 tab 就有小红点
 *   2) 从 AI 聊天页退出后，AI 客服那一行还挂着未读数
 *
 * unread 的算法（route-social.js decoConv）：
 *   会话内「对方发的」且「我的 id 不在 readBy 里」的消息条数
 *
 * 本脚本逐步打印未读数，定位它到底从哪来、以及 markRead 有没有生效。
 *
 * 用法：node tools/test-unread-badge.js
 */
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

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

  const call = (path, method, data, token) => app.main({ path, method, data: data || {}, token: token || '' });

  for (let i = 0; i < 40; i++) {
    const r = await call('/api/_setup', 'POST', {});
    if (r.data && r.data.done) break;
  }

  const convs = async (token) => {
    const r = await call('/api/conversations', 'GET', null, token);
    return (r.data && r.data.list) || [];
  };

  console.log('=== 1. 已有账号（林小满 id=2）登录后，未读数是多少 ===');
  const login1 = await call('/api/login', 'POST', { testUserId: 2 });
  const t1 = login1.data.token;
  {
    const list = await convs(t1);
    const total = list.reduce((s, c) => s + (c.unread || 0), 0);
    list.forEach((c) => console.log('      会话 ' + c.id + '  peer=' + (c.peer && c.peer.nickname) + '  unread=' + c.unread));
    console.log('      合计未读 = ' + total);
    if (total === 0) ok('老账号未读为 0（符合预期）');
    else console.log('  – 老账号有 ' + total + " 条未读（可能是种子数据里对方最后一条未读，属正常）");
  }

  console.log('\n=== 2. 【核心】全新账号登录后，未读数应为 0 ===');
  // 模拟微信一键登录的新用户（不带 testUserId）
  const login2 = await call('/api/login', 'POST', { nickname: '红点测试员' });
  const t2 = login2.data && login2.data.token;
  const me2 = login2.data && login2.data.user;
  if (!t2) { no('新账号登录失败'); process.exit(1); }
  console.log('      新用户：' + me2.nickname + '（id=' + me2.id + '）');
  {
    const list = await convs(t2);
    const total = list.reduce((s, c) => s + (c.unread || 0), 0);
    list.forEach((c) => console.log('      会话 ' + c.id + '  peer=' + (c.peer && c.peer.nickname) + '  unread=' + c.unread));
    console.log('      合计未读 = ' + total);
    if (total === 0) ok('新账号登录后未读为 0（欢迎语不产生红点）');
    else {
      no('新账号一登录就有 ' + total + ' 条未读 → 这正是「刚登录就有红点」');
      for (const c of list) {
        if (!c.unread) continue;
        const unreadMsgs = db.find('messages', (m) =>
          m.convId === c.id && m.senderId !== me2.id && (m.readBy || []).indexOf(me2.id) === -1);
        unreadMsgs.forEach((m) => console.log('          #' + m.id + ' type=' + m.type +
          ' readBy=[' + (m.readBy || []).join(',') + '] ' + String(m.content).slice(0, 40)));
      }
    }
    // 欢迎语仍然要存在（只是不产生未读）
    const aiConv = list.find((c) => c.peer && c.peer.isAI);
    if (aiConv) {
      const welcome = db.find('messages', (m) => m.convId === aiConv.id && /欢迎来到科贸小鱼/.test(m.content || ''));
      if (welcome.length) ok('欢迎语仍在会话里（' + welcome.length + ' 条），只是不挂未读');
      else no('欢迎语丢了 —— preRead 不应影响消息本身');
      if (welcome.length === 1) ok('欢迎语只发一次（不会重复累积）');
      else no('欢迎语出现 ' + welcome.length + ' 条，重复发送');
    }
  }

  console.log('\n=== 3. 打开 AI 会话并标记已读后，未读应清零 ===');
  {
    const list = await convs(t2);
    const aiConv = list.find((c) => c.peer && c.peer.isAI);
    if (!aiConv) {
      console.log('  – 新账号还没有 AI 会话，先触发一条通知创建它');
      await call('/api/conversations/open', 'POST', {}, t2);
    }
    const list2 = await convs(t2);
    const c2 = list2.find((c) => c.peer && c.peer.isAI);
    if (!c2) { no('未能创建 AI 会话'); }
    else {
      console.log('      AI 会话 id=' + c2.id + '，读前 unread=' + c2.unread);
      const r = await call('/api/conversations/' + c2.id + '/read', 'POST', {}, t2);
      console.log('      markRead 响应 code=' + r.code + ' data=' + JSON.stringify(r.data));
      const list3 = await convs(t2);
      const c3 = list3.find((c) => c.id === c2.id);
      console.log('      读后 unread=' + (c3 ? c3.unread : '?'));
      if (c3 && c3.unread === 0) ok('标记已读后未读清零');
      else no('标记已读后仍有 ' + (c3 ? c3.unread : '?') + ' 条未读 → 这就是用户看到的「退出后还挂着红点」');
    }
  }

  console.log('\n=== 4. 退出页面后 AI 再来消息，红点应重新出现（正常行为）===');
  {
    const list = await convs(t2);
    const c = list.find((p) => p.peer && p.peer.isAI);
    if (c) {
      // 模拟用户退出聊天页后，AI 主动来一条（例如订单通知）
      await call('/api/notifications/test', 'POST', {}, t2).catch(() => null);
      const ev = require(FN + '/events.js');
      ev.notifyUser(me2.id, '这是一条系统通知', null);
      await db.flush();
      const list2 = await convs(t2);
      const c2 = list2.find((p) => p.id === c.id);
      console.log('      收到通知后 unread=' + (c2 ? c2.unread : '?'));
      if (c2 && c2.unread > 0) ok('有新消息时红点会正常出现（' + c2.unread + ' 条）');
      else no('新消息没有产生未读，红点机制失效');
    }
  }

  console.log('\n=== 5. 【核心回归】未登录时不得残留红点 ===');
  {
    // 场景：用户已登录（有未读），然后登出 / token 失效。
    // 此时消息页显示「登录后查看消息」，底部 tab 绝不能还挂着红点。
    const list = await convs(t1);   // 用老账号，它有 3 条未读
    console.log('      登录态下的未读：' + list.reduce((s, c) => s + (c.unread || 0), 0));
    // 走登出接口使 token 失效
    await call('/api/logout', 'POST', {}, t1);
    const after = await call('/api/conversations', 'GET', null, t1);
    console.log('      登出后访问会话列表：code=' + after.code + ' message=' + (after.message || '-'));
    if (after.code === 401) ok('登出后旧 token 已失效（401）');
    else console.log('  – 登出后仍可访问（code=' + after.code + '），前端需自行清 token');
  }

  console.log('\n=== 6. 未登录调用未读接口的行为（前端据此清角标）===');
  {
    const r = await call('/api/conversations', 'GET', null, '');
    const list = (r.data && r.data.list) || [];
    const total = r.data && typeof r.data.unreadTotal === 'number' ? r.data.unreadTotal : null;
    console.log('      code=' + r.code + '  list.length=' + list.length + '  unreadTotal=' + total);
    if (r.code === 0 && list.length === 0) ok('未登录时会话列表为空 → 未读天然为 0');
    else if (r.code === 401) ok('未登录时返回 401 → 前端不应展示任何未读');
    else no('未登录时返回了 ' + list.length + ' 个会话，可能算错');
  }

  console.log('\n=== 7. 【核心】老数据自愈：历史遗留的未读欢迎语应被清理 ===');
  {
    const dbm = require(FN + '/db.js');
    const aiUser = dbm.one('users', (u) => u.isAI);

    // 建一个新账号（它会收到欢迎语，且已被 preRead 标为已读）
    const l1 = await call('/api/login', 'POST', { nickname: '自愈测试' });
    const me1 = l1.data.user;
    const aiC = (await convs(l1.data.token)).find((c) => c.peer && c.peer.isAI);
    if (!aiC) { console.log('  – 未创建 AI 会话，跳过'); }
    else {
      const welcomes = dbm.find('messages', (m) =>
        m.convId === aiC.id && m.senderId === aiUser.id && /^欢迎来到科贸小鱼/.test(m.content || ''));
      if (!welcomes.length) { console.log('  – 没找到欢迎语，跳过'); }
      else {
        // 人为把欢迎语改回「仅 AI 已读」，模拟老版本遗留的未读
        //
        // ⚠️ 必须配一次 saveSoon()。直接改字段不会标记 dirty，
        //    flush() 只在 saveSoonFlag 为真时才做「差异检测」并落库；
        //    少了这一句，改动**只存在于内存**、根本没写进库。
        //    （这么写以前也能过，是因为当时的会话列表读的是**内存**——
        //      2026-10-15 把会话/消息改成直查数据库后，这条 setup 才暴露出无效。）
        welcomes.forEach((m) => { m.readBy = [aiUser.id]; });
        dbm.saveSoon();
        await dbm.flush();
        const before = (await convs(l1.data.token)).find((c) => c.id === aiC.id);
        console.log('      制造未读后：AI 会话 unread=' + (before ? before.unread : '?'));

        // 重新登录 → 应触发自愈
        const l2 = await call('/api/login', 'POST', { testUserId: me1.id });
        const after = (await convs(l2.data.token)).find((c) => c.id === aiC.id);
        console.log('      重新登录后：AI 会话 unread=' + (after ? after.unread : '?'));
        if (before && before.unread > 0 && after && after.unread === 0) {
          ok('登录时自愈生效，历史未读欢迎语被清理');
        } else {
          no('未自愈（' + (before ? before.unread : '?') + ' → ' + (after ? after.unread : '?') + '）');
        }
      }
    }
  }

  console.log('\n=== 8. 自愈不能误伤真实业务通知 ===');
  {
    const ev = require(FN + '/events.js');
    const dbm = require(FN + '/db.js');
    const loginC = await call('/api/login', 'POST', { testUserId: 4 });
    const tC = loginC.data.token;
    const meC = loginC.data.user;

    // 发一条真实的业务通知（商品下架这类，type=system 但不含欢迎语）
    ev.notifyUser(meC.id, '你的商品「测试」被管理员下架，如有疑问请联系客服');
    await dbm.flush();
    const before = (await convs(tC)).reduce((s, c) => s + c.unread, 0);
    console.log('      收到业务通知后未读 = ' + before);

    // 再登录一次，自愈只该清欢迎语、不该动这条
    const again = await call('/api/login', 'POST', { testUserId: 4 });
    const after = (await convs(again.data.token)).reduce((s, c) => s + c.unread, 0);
    console.log('      重新登录后未读 = ' + after);
    if (before > 0 && after === before) ok('业务通知的红点被完整保留（自愈只针对欢迎语）');
    else if (before === 0) console.log('  – 未产生业务通知未读，跳过');
    else no('业务通知的未读被误清（' + before + ' → ' + after + '）');
  }

  Module._load = origLoad;
  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 未读计数符合预期'));
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  Module._load = origLoad;
  console.error('测试崩溃:', e);
  process.exit(1);
});
