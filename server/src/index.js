'use strict';
/**
 * 科贸小鱼服务端入口
 *  - 3000：小程序 API + WebSocket + 静态资源（图片/上传文件）
 *  - 3100：管理后台（独立端口，小程序内无任何入口）
 *
 * 管理后台（3100）有两种数据源，启动时自动选择：
 *   1) **云端**（推荐）：在 server/.cloudbase.json 填好 API Key 后启用，
 *      后台看到并操作的是小程序**线上真实数据**（经云函数 campus 透传）。
 *   2) **本地**（兜底）：没配 Key 时用本地演示库 server/data/db.json。
 *      注意本地库与线上是两套数据，操作只影响本地，不影响小程序。
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const auth = require('./auth');
const util = require('./util');
const wsHub = require('./ws');
const seed = require('./seed');
const cloud = require('./cloud');

const API_PORT = Number(process.env.API_PORT || 3000);
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 3100);
/** 监听地址：小程序 API 只对本机（模拟器/开发者工具用），后台默认对局域网开放 */
const API_HOST = process.env.API_HOST || '127.0.0.1';
const ADMIN_HOST = process.env.ADMIN_HOST || '0.0.0.0';

/** 列出本机所有可用的局域网 IPv4 地址（用于启动时打印「手机怎么打开」） */
function lanUrls(port) {
  const out = [];
  const ifs = require('os').networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      // 跳过 169.254.x.x（没拿到 DHCP 时的自分配地址）与回环
      if (it.family === 'IPv4' && !it.internal && !/^169\.254\./.test(it.address)) {
        out.push('http://' + it.address + ':' + port);
      }
    }
  }
  return out;
}
const STATIC_DIR = path.join(__dirname, '..', 'static');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

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

require('./routes/core')(route);
require('./routes/trade')(route);
require('./routes/social')(route);
require('./routes/extend')(route);
require('./routes/ai')(route);
require('./routes/admin')(route);

/* ---------------- 工具 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

function json(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    let over = false;
    req.on('data', (c) => { if (s.length < 3 * 1024 * 1024) s += c; else over = true; });
    req.on('end', () => {
      if (over) return resolve(null);
      try { resolve(s ? JSON.parse(s) : null); } catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function serveStatic(req, res, rootDir, relPath) {
  let rel;
  try { rel = decodeURIComponent(relPath || ''); } catch (e) { rel = relPath; }
  const fp = path.normalize(path.join(rootDir, rel));
  if (!fp.startsWith(path.normalize(rootDir))) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=600' });
    res.end(data);
  });
}

/* ---------------- 请求处理 ---------------- */
async function handleApi(req, res) {
  const u = new URL(req.url, 'http://local');
  const m = matchRoute(req.method, u.pathname, 'api');
  if (!m) return json(res, 404, { code: 404, message: '接口不存在' });
  let body = null;
  const ct = req.headers['content-type'] || '';
  if (['POST', 'PATCH', 'PUT'].includes(req.method) && ct.includes('application/json')) body = await readBody(req);
  const token = auth.tokenFromReq(req);
  const user = auth.userByToken(token);
  if (user && user.banned) return json(res, 403, { code: 403, message: '账号已被封禁，如有疑问请联系管理员' });
  const ctx = { req, res, params: m.params, query: u.searchParams, body, token, user };
  try {
    const out = await m.handler(ctx);
    json(res, 200, { code: 0, data: out });
  } catch (e) {
    json(res, e.status || 400, { code: e.status || 400, message: e.message || '请求失败' });
  }
}

/**
 * 管理后台请求处理。
 *
 * 配了云端 API Key 时，**整个 /admin-api/* 透传给线上云函数**：
 * 复用云端已有的全部管理接口（登录/统计/下架/封号/处理举报/公告/配置），
 * 不在本地重写任何管理逻辑 —— 云端返回的就是 { code, data }，与本地格式一致，
 * 所以前端一行都不用改。
 *
 * 没配 Key 时走本地 db.json（原行为，作为兜底）。
 */
async function handleAdmin(req, res) {
  const u = new URL(req.url, 'http://local');
  const m = matchRoute(req.method, u.pathname, 'admin');
  if (!m) return json(res, 404, { code: 404, message: '接口不存在' });
  let body = null;
  const ct = req.headers['content-type'] || '';
  if (['POST', 'PATCH', 'PUT'].includes(req.method) && ct.includes('application/json')) body = await readBody(req);
  const token = auth.tokenFromReq(req);

  // ---------- 云端模式 ----------
  if (cloud.enabled()) {
    try {
      const out = await cloud.invoke({
        path: u.pathname + (u.search || ''),
        method: req.method,
        data: body,
        token,
        scope: 'admin'
      });
      // 云函数返回 { code, data } / { code, message }，直接照搬给前端
      return json(res, 200, out);
    } catch (e) {
      return json(res, e.status || 502, { code: e.status || 502, message: e.message || '云端请求失败' });
    }
  }

  // ---------- 本地模式（兜底） ----------
  const admin = auth.adminByToken(token);
  if (!admin && u.pathname !== '/admin-api/login') return json(res, 401, { code: 401, message: '请先登录管理后台' });
  const ctx = { req, res, params: m.params, query: u.searchParams, body, token, admin, user: null };
  try {
    const out = await m.handler(ctx);
    json(res, 200, { code: 0, data: out });
  } catch (e) {
    json(res, e.status || 400, { code: e.status || 400, message: e.message || '请求失败' });
  }
}

/* ---------------- 启动 ---------------- */
const CLOUD = cloud.info();

// 本地演示数据只在「本地模式」下准备 —— 云端模式下用的是线上数据，建了也没人看
if (!CLOUD.enabled) {
db.load();
if (db.get('users').length === 0) {
  console.log('[boot] empty database, building seed data...');
  seed.build();
}
// 扩展功能演示数据（校园墙 / 学习资源 / 拼团），幂等
try {
  const seed2 = require('./seed2');
  const r = seed2.build();
  if (r && (r.walls || r.resources || r.groups)) {
    console.log('[boot] extended seed:', JSON.stringify(r));
  }
} catch (e) {
  console.log('[boot] extended seed skipped:', e.message);
}
}

const apiServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://local');
  if (u.pathname.startsWith('/static/')) return serveStatic(req, res, STATIC_DIR, u.pathname.slice('/static/'.length));
  if (u.pathname.startsWith('/api/')) return handleApi(req, res);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('科贸小鱼 API 服务运行中\nHealth: OK\n');
});

const adminServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://local');
  // 数据源信息：由本地服务直接回答（不走 /admin-api 代理），
  // 管理后台据此显示「云端 / 本地」徽标。
  if (u.pathname === '/admin-info') {
    const c = cloud.info();
    return json(res, 200, {
      source: c.enabled ? 'cloud' : 'local',
      envId: c.envId, fn: c.fn, keyHint: c.keyHint,
      hint: c.enabled ? '' : '在 server/.cloudbase.json 填入 API Key 后重启，即可接线上真实数据',
      // 多设备访问信息：后台「系统设置」据此告诉用户「手机/别的电脑怎么打开」
      lanEnabled: ADMIN_HOST === '0.0.0.0',
      lanUrls: ADMIN_HOST === '0.0.0.0' ? lanUrls(ADMIN_PORT) : [],
      adminPort: ADMIN_PORT,
      origin: 'http://' + (req.headers.host || ('127.0.0.1:' + ADMIN_PORT))
    });
  }
  if (u.pathname.startsWith('/admin-api/')) return handleAdmin(req, res);
  if (u.pathname.startsWith('/static/')) return serveStatic(req, res, STATIC_DIR, u.pathname.slice('/static/'.length));
  const fp = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\//, '');
  serveStatic(req, res, PUBLIC_DIR, fp);
});

wsHub.attachWss(apiServer);

/**
 * 端口被占用时给出**可操作**的提示，而不是甩一堆堆栈。
 *
 * 最常见的原因就是「已经有一个实例在运行」（比如重复双击了 start-admin.cmd，
 * 或上一次的窗口没关）。原来会抛未捕获的 EADDRINUSE，用户看到的是
 * net://... 一堆调用栈，完全不知道该怎么办。
 */
function guardListen(server, port, label) {
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error('');
      console.error('  [错误] ' + label + ' 的端口 ' + port + ' 已被占用，服务无法启动。');
      console.error('');
      console.error('  最常见原因：**已经有一个实例在运行**（另一个黑色窗口还没关）。');
      console.error('  处理办法：');
      console.error('    1) 关掉那个已经在运行的服务窗口，再重新启动本程序；');
      console.error('    2) 命令行执行：  netstat -ano | findstr :' + port);
      console.error('       记下结果最后一列的数字（PID），再执行：  taskkill /PID <PID> /F');
      console.error('');
    } else {
      console.error('');
      console.error('  [错误] ' + label + ' 启动失败：' + ((e && e.message) || '未知错误'));
      console.error('');
    }
    process.exit(1);
  });
}

guardListen(apiServer, API_PORT, '小程序服务');
guardListen(adminServer, ADMIN_PORT, '管理后台');

apiServer.listen(API_PORT, API_HOST, () => {
  console.log('[api] 小程序服务: http://127.0.0.1:' + API_PORT);
});

/**
 * 管理后台监听地址。
 *
 * 默认绑 `0.0.0.0`：这样同一 WiFi 下的手机 / 另一台电脑也能打开后台
 * （比赛演示时用平板或别人的电脑看后台，比只在自己这台机器上强）。
 *
 * 代价是「局域网内任何人都能访问登录页」，所以：
 *   - 默认账号密码 admin/admin 必须改（下面会显式告警，后台设置页也有入口）
 *   - 只想自己用：启动前设 ADMIN_HOST=127.0.0.1
 */
adminServer.listen(ADMIN_PORT, ADMIN_HOST, () => {
  console.log('[admin] 管理后台: http://127.0.0.1:' + ADMIN_PORT);
  if (ADMIN_HOST === '0.0.0.0') {
    const urls = lanUrls(ADMIN_PORT);
    if (urls.length) {
      console.log('[admin] 同一 WiFi 下的其它设备可用：');
      urls.forEach((u) => console.log('[admin]   ' + u));
    } else {
      console.log('[admin] 没检测到局域网地址（可能没连 WiFi/网线）');
    }
    console.log('[admin]   ⚠️ 局域网内任何人都能打开登录页 —— 请到【系统设置】把默认密码改掉；');
    console.log('[admin]      只想本机用：设环境变量 ADMIN_HOST=127.0.0.1 后重启。');
  }
  if (CLOUD.enabled) {
    console.log('[admin] 数据源：**云端**（线上真实数据）');
    console.log('[admin]   环境 ' + CLOUD.envId + ' · 云函数 ' + CLOUD.fn + ' · Key ' + CLOUD.keyHint);
  } else {
    console.log('[admin] 数据源：本地演示库 server/data/db.json');
    console.log('[admin]   ⚠️ 与小程序线上数据是两套：这里的操作不影响线上。');
    console.log('[admin]   要接线上真实数据：在 server/.cloudbase.json 填入 API Key 后重启。');
    try {
      const a = (db.load().meta || {}).admin;
      if (a && a.username === 'admin' && a.password === 'admin') {
        console.log('');
        console.log('[admin]   ⚠️⚠️ 当前仍是默认密码 admin/admin，局域网内谁都能进后台！');
        console.log('[admin]        登录后到【系统设置 → 管理员密码】改掉。');
        console.log('');
      }
    } catch (e) { /* 忽略 */ }
  }
});
