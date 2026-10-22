'use strict';
/**
 * 身份鉴权（云开发版）
 *
 * ⚠️ 与本地 Node 版的关键差异：这里全部走「直接查库」，不走内存镜像。
 *
 * 原因：云函数会并发多实例，每个实例各有一份内存镜像。
 * 若 session 写入实例 A 的内存（请求结束才落库），而后续请求命中
 * 更早启动的实例 B，B 的内存里没有这条 session → 鉴权失败。
 * 症状极具迷惑性：登录接口明明成功（库里也有 session），
 * 但紧接着的 /api/me 返回 401，前端误清 token → 表现为「登录成功却仍是未登录」。
 *
 * 因此：
 *   - session 文档以 token 作为 _id，直查 O(1)，无 id 生成依赖
 *   - 用户资料同样直查，保证改名/改头像后立即生效
 */
const db = require('./db');
const { randomToken } = require('./util');

/**
 * 创建会话：直接写库（不经过内存镜像与 flush）
 *
 * ⚠️ 不要把 userId 一律 `Number()` —— 这是本项目踩过的一个真实事故：
 *
 *   user 会话传的是数字 id（没问题），但 **admin 会话传的是用户名（字符串）**，
 *   `Number('admin')` = **NaN**，而 CloudBase **拒绝写入 NaN**，
 *   于是 `set()` 抛错、被下面的 catch 吞掉，函数**返回了 token 但库里没有 session**。
 *
 *   症状极具迷惑性：`/admin-api/login` 返回 200 + token（看起来登录成功），
 *   但之后**每一个管理接口都是 401「请先登录管理后台」**。
 *   实测证据：云库 sessions 集合里只有 `type: "user"`，**一条 admin 会话都没有**。
 *
 *   注意本地版（server/src/auth.js）没有这层强转，所以本地后台一直是好的 ——
 *   问题只在云端暴露，排查时容易被"本地能跑"误导。
 */
async function createSession(userId, type = 'user') {
  const token = randomToken(24);
  const uid = type === 'admin' ? String(userId) : Number(userId);
  const doc = { token, userId: uid, type, createdAt: Date.now() };

  try {
    await db.db().collection('sessions').doc(token).set({ data: doc });
    return token;
  } catch (e) {
    // 集合不存在时补建后重试一次
    try {
      await db.ensureCollection('sessions');
      await db.db().collection('sessions').doc(token).set({ data: doc });
      return token;
    } catch (e2) {
      // ⚠️ 绝不能静默吞掉：会话没写进库，返回的 token 就是个**废 token**，
      //    调用方却以为登录成功 → 用户看到「登录成功但所有操作 401」。
      //    宁可让登录直接失败并说明原因，也不要给出一个用不了的 token。
      console.error('[auth] 创建会话失败（type=' + type + '）：', (e2 && e2.message) || e2);
      throw new Error('会话创建失败，请重试；若持续失败请检查 sessions 集合是否正常');
    }
  }
}

/** 销毁会话：直接删库 */
async function destroySession(token) {
  if (!token) return;
  try {
    await db.db().collection('sessions').doc(token).remove();
  } catch (e) { /* 不存在则忽略 */ }
  // 同时清掉内存镜像里的残留（若已加载）
  try { db.remove('sessions', (s) => s.token === token); } catch (e) { /* 忽略 */ }
}

/** 按 token 取用户：session 与 user 都直查数据库 */
async function userByToken(token) {
  if (!token) return null;
  const sess = await findSession(token, 'user');
  if (!sess) return null;

  try {
    const r = await db.db().collection('users').doc(String(sess.userId)).get();
    const u = r && r.data;
    if (!u) return null;
    const out = Object.assign({}, u);
    delete out._id;
    return out;
  } catch (e) {
    return null;
  }
}

/**
 * 查会话：优先按 token 直接命中文档（O(1)，新格式），
 * 失败时回退扫描 sessions 集合（兼容旧的 id 自增格式）。
 */
async function findSession(token, type) {
  // 新格式：_id 就是 token
  try {
    const r = await db.db().collection('sessions').doc(token).get();
    const s = r && r.data;
    if (s && s.type === type) return s;
  } catch (e) { /* 走回退 */ }

  // 旧格式：token 存在字段里
  try {
    const r = await db.db().collection('sessions')
      .where({ token, type })
      .limit(1)
      .get();
    const list = (r && r.data) || [];
    return list[0] || null;
  } catch (e) {
    return null;
  }
}

/** 管理端 token：同样直查 */
async function adminByToken(token) {
  if (!token) return null;
  const s = await findSession(token, 'admin');
  if (!s) return null;
  return { username: s.userId, isAdmin: true };
}

function tokenFromReq(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  try {
    const u = new URL(req.url, 'http://local');
    return (u.searchParams.get('token') || '').trim();
  } catch (e) { return ''; }
}

async function adminLogin(username, password) {
  const data = db.load();
  const admin = (data.meta && data.meta.admin) || null;
  if (!admin) return null;
  if (admin.username !== username || admin.password !== password) return null;
  return createSession(username, 'admin');
}

module.exports = {
  createSession, destroySession, userByToken, adminByToken, tokenFromReq, adminLogin
};
