'use strict';
/**
 * 云函数 campus —— 科贸小鱼后端（云开发版）
 *
 * 调用方式（小程序端统一走 utils/api.js）：
 *   wx.cloud.callFunction({
 *     name: 'campus',
 *     data: { path: '/api/listings?page=1', method: 'GET', data: {}, token, scope: 'api' }
 *   })
 *
 * 返回值：{ code: 0|4xx, data } —— 与本地 REST 版完全一致的响应结构，
 * 因此小程序页面代码无需任何改动。
 */
const db = require('./db');
const auth = require('./auth');
const events = require('./events');
const sign = require('./sign');

/* ---------------- 路由表 ---------------- */
const routes = [];
function route(method, p, handler, scope) {
  routes.push({ method, path: p, handler, scope: scope || 'api' });
}
function matchRoute(method, pathname, scope) {
  for (const r of routes) {
    if (r.method !== method || r.scope !== scope) continue;
    const a = r.path.split('/');
    const b = pathname.split('/');
    if (a.length !== b.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
      else if (a[i] !== b[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

require('./route-core')(route);
require('./route-trade')(route);
require('./route-social')(route);
require('./route-extend')(route);
require('./route-ai')(route);
require('./route-admin')(route);

/* ---------------- 初始化处理 ----------------
 * 适配云函数默认 3 秒超时：分批推进，每次调用只做一小部分。
 *
 *   POST /api/_setup?step=1    推进一步（前端循环调用直到 done）
 *   POST /api/_setup?force=1   清空进度，从头开始
 *   POST /api/_setup           兼容模式：在时间预算内尽量多推进
 */
async function handleSetup(u) {
  const q = u.searchParams;
  try {
    if (q.get('force') === '1') {
      return { code: 0, data: await db.initStep('reset') };
    }
    if (q.get('step') === '1') {
      return { code: 0, data: await db.initStep('step') };
    }

    // 兼容模式：预算 1000ms（3 秒上限，留足冷启动与网络余量）
    const reports = [];
    const budget = Date.now() + 1000;
    for (let i = 0; i < 30; i++) {
      const r = await db.initStep('step');
      reports.push(r);
      if (r.done) break;
      if (Date.now() > budget) break;
    }
    const last = reports[reports.length - 1] || {};
    const verify = db.snapshotCounts();
    return {
      code: 0,
      data: {
        done: !!last.done,
        steps: reports.length,
        last,
        verify,
        ok: !!last.done,
        note: last.done ? undefined : '未完成，请继续调用本接口'
      }
    };
  } catch (e) {
    return { code: 500, message: '初始化失败：' + e.message };
  }
}

/* ---------------- 入口 ---------------- */
exports.main = async (event) => {
  const ev = event || {};
  const rawPath = ev.path || '/';

  // 1) 先解析 path / query（纯字符串处理，零 DB 开销）
  let u;
  try {
    u = new URL('http://cloudbase.local' + (rawPath.startsWith('/') ? rawPath : '/' + rawPath));
  } catch (e) {
    return { code: 400, message: '非法请求路径' };
  }
  const isSetup = u.pathname === '/api/_setup' || u.pathname === '/api/_init';

  // 2) 初始化路径：不走全量加载，直接分片推进
  if (isSetup) return await handleSetup(u);

  // 3) 业务路径：先用「单文档读」廉价判断是否需要初始化
  //    关键：不能先做 db.ensure()（全量读 23 集合，冷启动时会直接吃掉 3 秒超时）
  try {
    const st = await db.quickState();
    if (!st.initialized) {
      // initStep 内部会把种子数据写进内存，随后的 ensure() 直接复用，不再读库
      await db.initStep('step');
    }
  } catch (e) { /* 初始化失败不阻塞业务 */ }

  // 4) 加载数据到内存（同一实例只做一次）
  await db.ensure();

  const method = String(ev.method || 'GET').toUpperCase();
  const scope = ev.scope === 'admin' ? 'admin' : 'api';

  const m = matchRoute(method, u.pathname, scope);
  if (!m) return { code: 404, message: '接口不存在' };

  // 3) 身份（直查数据库，绕过内存镜像 —— 多实例下才能拿到最新 session）
  const token = String(ev.token || '');
  let user = null;
  let admin = null;
  if (scope === 'admin') {
    admin = await auth.adminByToken(token);
    if (!admin && u.pathname !== '/admin-api/login') {
      return { code: 401, message: '请先登录管理后台' };
    }
  } else {
    user = await auth.userByToken(token);
    if (user && user.banned) {
      return { code: 403, message: '账号已被封禁，如有疑问请联系管理员' };
    }
  }

  const ctx = {
    params: m.params,
    query: u.searchParams,
    body: ev.data || null,
    token,
    user,
    admin,
    /** 云函数内没有原生请求对象 */
    req: null,
    res: null
  };

  // 4) 执行 + 落库
  try {
    const out = await m.handler(ctx);
    // 等待挂起的异步任务（AI 客服回复等）写完，否则 main 返回后进程冻结会丢失
    try { await events.drainPending(); } catch (e) { /* 不影响主流程 */ }
    await db.flush();

    // 5) 图片签名 —— **必须放在 flush 之后**：
    //    签名要多一次外部调用（getTempFileURL），放在落库前面会挤占持久化预算。
    //    **小程序端（api）与管理后台（admin）都要签**：
    //    后台已改为透传线上云函数，云端头像/商品图是 cloud://（私有桶），
    //    桌面浏览器加载不了 —— 这就是「用户管理里全是空头像」的原因。
    let data = out === undefined ? {} : out;
    if (scope === 'api' || scope === 'admin') data = await sign.resolve(data);

    return { code: 0, data };
  } catch (e) {
    try { await events.drainPending(); } catch (e3) { /* 忽略 */ }
    try { await db.flush(); } catch (e2) { /* 忽略 */ }
    return {
      code: e.status || 400,
      message: e.message || '请求失败'
    };
  }
};
