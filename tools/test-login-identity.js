/**
 * 登录身份（openid 去重）与已读落库 专项测试。
 *
 * 背景：用户反馈「重新登录后聊天记录不见了 / 点 AI 客服报会话不存在」。
 * 根因是登录路由**完全没用 openid**，每次「微信一键登录」都新建一个空账号：
 *     openid: 'dev_' + util.randomToken(8)   ← 每次都随机
 * 于是同一个微信号每次登录都是新用户，上一账号的数据全部「消失」。
 *
 * 本脚本验证修复后：
 *   1) 同一 openid 反复登录 → 始终同一账号（数据不再丢）
 *   2) 不同 openid → 各自独立账号
 *   3) 拿不到 openid（云端测试/mock）→ 保持原有「新建账号」行为
 *   4) 同一账号不会重复收到欢迎语
 *   5) 昵称有变化时才更新
 *   6) 已读状态能跨冷启动保留（此前就地改 readBy + saveSoon 是空实现，不落库）
 *   7) 未读欢迎语的自愈能落库
 *
 * 用法：node tools/test-login-identity.js
 */
const Module = require('module');

const FN = 'D:/wx/campus-xianyu/cloudfunctions/campus';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/* ---------- mock：集合→文档 ---------- */
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

/** 可控的 OPENID */
const wx = { openid: '' };
const fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'mock', init() { },
  getWXContext: () => (wx.openid ? { OPENID: wx.openid } : {}),
  database: () => ({ collection: makeCollection, createCollection(n) { col(n); return Promise.resolve({}); } })
};
const origLoad = Module._load;
Module._load = function (r) { if (r === 'wx-server-sdk') return fakeSdk; return origLoad.apply(this, arguments); };

(async () => {
  const app = require(FN + '/index.js');
  const db = require(FN + '/db.js');
  const call = (p, m, d, t) => app.main({ path: p, method: m, data: d || {}, token: t || '' });

  for (let i = 0; i < 40; i++) { const r = await call('/api/_setup', 'POST', {}); if (r.data && r.data.done) break; }

  console.log('=== 1. 【核心】同一 openid 反复登录 = 同一账号 ===');
  {
    wx.openid = 'openid_AAA';
    const a = await call('/api/login', 'POST', { nickname: '阿强' });
    const idA = a.data.user.id;
    console.log('      第 1 次登录：id=' + idA + ' 昵称=' + a.data.user.nickname + ' isNew=' + a.data.isNew);

    const b = await call('/api/login', 'POST', { nickname: '阿强' });
    const idB = b.data.user.id;
    console.log('      第 2 次登录：id=' + idB + ' 昵称=' + b.data.user.nickname + ' isNew=' + b.data.isNew);

    if (idA === idB) ok('两次登录是同一个账号（id=' + idA + '）—— 数据不会再「消失」');
    else no('两次登录得到不同账号（' + idA + ' vs ' + idB + '）→ 正是「数据不见了」的根因');
    if (a.data.isNew === true && b.data.isNew === false) ok('isNew 正确：首次 true、再次 false');
    else no('isNew 异常：' + a.data.isNew + ' / ' + b.data.isNew);

    // 该账号的用户记录只有一条
    const sameOpenid = db.find('users', (u) => u.openid === 'openid_AAA');
    if (sameOpenid.length === 1) ok('数据库里该 openid 只有 1 条用户记录（没有重复建号）');
    else no('出现了 ' + sameOpenid.length + ' 条同 openid 的记录');
  }

  console.log('\n=== 2. 同一账号只收到一条欢迎语 ===');
  {
    wx.openid = 'openid_AAA';
    await call('/api/login', 'POST', { nickname: '阿强' });   // 再来一次
    await call('/api/login', 'POST', { nickname: '阿强' });
    const me = db.one('users', (u) => u.openid === 'openid_AAA');
    const ai = db.one('users', (u) => u.isAI);
    const conv = db.one('conversations', (c) => c.members.indexOf(me.id) !== -1 && c.members.indexOf(ai.id) !== -1);
    const welcomes = conv ? db.find('messages', (m) => m.convId === conv.id && /^欢迎来到科贸小鱼/.test(m.content || '')) : [];
    console.log('      该账号 AI 会话里的欢迎语：' + welcomes.length + ' 条');
    if (welcomes.length === 1) ok('老用户重新登录不会再收到欢迎语（只发一次）');
    else if (welcomes.length === 0) no('欢迎语缺失');
    else no('欢迎语重复 ' + welcomes.length + ' 条');
  }

  console.log('\n=== 3. 不同 openid = 不同账号 ===');
  {
    wx.openid = 'openid_AAA';
    const a = await call('/api/login', 'POST', { nickname: '阿强' });
    wx.openid = 'openid_BBB';
    const b = await call('/api/login', 'POST', { nickname: '阿明' });
    console.log('      AAA → id=' + a.data.user.id + '，BBB → id=' + b.data.user.id);
    if (a.data.user.id !== b.data.user.id) ok('不同微信号各自独立账号（互不干扰）');
    else no('不同 openid 竟然共用了同一个账号');
  }

  console.log('\n=== 4. 拿不到 openid 时保持原行为（云端测试场景）===');
  {
    wx.openid = '';   // 模拟云端测试
    const a = await call('/api/login', 'POST', { nickname: '测试甲' });
    const b = await call('/api/login', 'POST', { nickname: '测试乙' });
    if (a.data.user.id !== b.data.user.id) ok('无 openid 时仍各建新账号（行为与修复前一致，不破坏原逻辑）');
    else no('无 openid 时复用了同一账号，可能影响云端测试');

    // openid 不该下发到前端，所以从库里查
    const uA = db.findById('users', a.data.user.id);
    if (uA && /^dev_/.test(String(uA.openid))) ok('退化 openid 仍带 dev_ 前缀（' + uA.openid + '）');
    else no('退化 openid 异常：' + (uA && uA.openid));

    if (a.data.user.openid === undefined) ok('接口未下发 openid（安全设计，publicUser 已剔除）');
    else no('接口下发了 openid，存在泄露风险');
  }

  console.log('\n=== 5. 昵称有变化才更新 ===');
  {
    wx.openid = 'openid_AAA';
    const a = await call('/api/login', 'POST', { nickname: '阿强' });
    const b = await call('/api/login', 'POST', { nickname: '强哥' });
    const c = await call('/api/login', 'POST', {});
    console.log('      改名前=' + a.data.user.nickname + ' 改名后=' + b.data.user.nickname + ' 不传昵称=' + c.data.user.nickname);
    if (b.data.user.nickname === '强哥') ok('传了新昵称则更新');
    else no('昵称未更新：' + b.data.user.nickname);
    if (c.data.user.nickname === '强哥') ok('不传昵称时保留原值（不会被覆盖成「微信用户」）');
    else no('不传昵称被覆盖成 ' + c.data.user.nickname);
  }

  console.log('\n=== 6. 【核心】已读状态能跨冷启动保留 ===');
  {
    wx.openid = 'openid_AAA';
    const login = await call('/api/login', 'POST', { nickname: '强哥' });
    const token = login.data.token;
    const me = login.data.user;
    const ai = db.one('users', (u) => u.isAI);
    const conv = db.one('conversations', (c) => c.members.indexOf(me.id) !== -1 && c.members.indexOf(ai.id) !== -1);

    // 人为造一条未读的 AI 文本消息
    const msg = db.insert('messages', {
      convId: conv.id, senderId: ai.id, type: 'text', content: '这是一条测试回复', readBy: [ai.id]
    });
    await db.flush();
    console.log('      造出未读消息 #' + msg.id);

    // 标记已读
    const r = await call('/api/conversations/' + conv.id + '/read', 'POST', {}, token);
    console.log('      markRead code=' + r.code);
    await db.flush();                    // 请求结束的落库

    // 冷启动后检查
    await db.ensure(true);
    const after = db.findById('messages', msg.id);
    const readBy = (after && after.readBy) || [];
    console.log('      冷启动后 readBy=[' + readBy.join(',') + ']');
    if (readBy.indexOf(me.id) > -1) ok('已读状态落库成功，冷启动后仍为已读（红点不会反复出现）');
    else no('已读状态丢失（readBy=' + JSON.stringify(readBy) + '）→ 红点会反复出现');
  }

  console.log('\n=== 7. 【核心】未读欢迎语的自愈能落库 ===');
  {
    wx.openid = 'openid_AAA';
    const first = await call('/api/login', 'POST', { nickname: '强哥' });
    const me = first.data.user;
    const ai = db.one('users', (u) => u.isAI);
    const conv = db.one('conversations', (c) => c.members.indexOf(me.id) !== -1 && c.members.indexOf(ai.id) !== -1);
    const w = db.one('messages', (m) => m.convId === conv.id && /^欢迎来到科贸小鱼/.test(m.content || ''));
    if (!w) { console.log('  – 未找到欢迎语，跳过'); }
    else {
      // 模拟老数据：把欢迎语改回「仅 AI 已读」
      db.update('messages', w.id, { readBy: [ai.id] });
      await db.flush();
      console.log('      制造未读欢迎语 #' + w.id);

      // 重新登录 → 自愈
      await call('/api/login', 'POST', { nickname: '强哥' });
      await db.flush();
      await db.ensure(true);            // 冷启动
      const after = db.findById('messages', w.id);
      const readBy = (after && after.readBy) || [];
      console.log('      冷启动后 readBy=[' + readBy.join(',') + ']');
      if (readBy.indexOf(me.id) > -1) ok('自愈结果落库成功，冷启动后仍是已读');
      else no('自愈没有落库（readBy=' + JSON.stringify(readBy) + '）→ 红点会再次出现');
    }
  }

  /* ---------- 8. 演示账号列表不能泄露真人账号 ---------- */
  console.log('\n=== 8. 「演示账号」列表不能包含真人（否则多人测试时账号会串）===');
  {
    /**
     * 登录页有个「演示账号 · 一键体验」，点一下就以那个人的身份登进去。
     * 它原本只按 cert==='student' 过滤，而**真人填了学院 cert 就会变 student**
     * （见 PATCH /api/me）→ 真人账号也进了列表，别人一键就能登成他，
     * 看到对方的聊天、订单、余额。云端实测确实如此（真实 openid 账号出现在列表里）。
     *
     * 修法：只返回**没有 openid** 的账号 —— 种子演示号 openid 为空，真人一定有。
     * 这里**两个方向都要断言**：真人必须被挡、种子必须还在（否则单人演示会少账号）。
     */
    const accountsOf = async () => {
      const r = await call('/api/test-accounts', 'GET', {});
      return (r.data && r.data.accounts) || [];
    };

    // ① 真人：有 openid（微信一键登录），且填过学院 → cert=student
    wx.openid = 'oREAL_probe_1234567890abcdef';
    const realLogin = await call('/api/login', 'POST', { nickname: '真人甲' });
    wx.openid = '';
    const realId = realLogin.data && realLogin.data.user && realLogin.data.user.id;
    if (!realId) no('构造真人账号失败，本用例无效');
    else {
      db.update('users', realId, { cert: 'student' });   // 模拟「填了学院」
      const ids1 = (await accountsOf()).map((a) => a.id);
      if (ids1.indexOf(realId) === -1) ok('真人账号（有 openid + cert=student）不在演示列表里 ← 这条就是防串号的');
      else no('真人账号出现在演示列表里（id=' + realId + '）→ 任何人都能一键登成他！');
    }

    // ② 种子演示账号：无 openid + cert=student → 必须仍然可见
    const seed = db.insert('users', {
      nickname: '演示种子号' + Math.floor(Math.random() * 1000), avatar: '/static/avatars/a01.jpg',
      openid: '', gender: 0, bio: '', college: '测试学院', grade: '', campus: '某校',
      credit: 80, cert: 'student', balance: 0, status: 'normal', noticeRead: [], joinedAt: Date.now()
    });
    const ids2 = (await accountsOf()).map((a) => a.id);
    if (ids2.indexOf(seed.id) > -1) ok('无 openid 的种子账号仍在列表里（单人演示不受影响）');
    else no('种子演示账号被误挡了（id=' + seed.id + '）→ 登录页会少演示账号');

    // ③ 「拿不到 openid」时退化产生的 dev_ 账号也不该出现在列表里（那是脏账号，不是演示账号）
    const dev = db.insert('users', {
      nickname: 'dev脏账号' + Math.floor(Math.random() * 1000), avatar: '/static/avatars/a02.jpg',
      openid: 'dev_probe_' + Math.random().toString(36).slice(2, 8),
      gender: 0, bio: '', college: '', grade: '', campus: '某校',
      credit: 80, cert: 'student', balance: 0, status: 'normal', noticeRead: [], joinedAt: Date.now()
    });
    const ids3 = (await accountsOf()).map((a) => a.id);
    if (ids3.indexOf(dev.id) === -1) ok('dev_ 异常登录产生的账号也不在列表里');
    else no('dev_ 账号出现在演示列表里（id=' + dev.id + '）');

    // 收尾：清掉本用例造的数据，避免影响后续用例
    try {
      db.removeById('users', seed.id);
      db.removeById('users', dev.id);
    } catch (e) { /* 忽略 */ }
  }

  Module._load = origLoad;
  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 登录身份与已读落库均正确'));
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  Module._load = origLoad;
  console.error('测试崩溃:', e);
  process.exit(1);
});
