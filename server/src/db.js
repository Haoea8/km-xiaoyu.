'use strict';
/**
 * 轻量 JSON 数据库：单进程内存态 + 防抖落盘（写临时文件后原子重命名）
 * 覆盖小程序演示所需全部集合；后续换 MySQL/云数据库只需替换本文件实现。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const COLLECTIONS = [
  'users', 'sessions', 'listings', 'favorites', 'wants', 'histories', 'orders', 'transactions',
  'conversations', 'messages', 'circles', 'posts', 'comments', 'reports', 'addresses',
  'notices', 'follows',
  /* 扩展功能：拼团 / 校园墙 / 学习资源 */
  'groups', 'walls', 'wallComments', 'resources', 'escrows',
  /* 互动消息（点赞/评论/回复/收藏…）—— 见 interactions.js */
  'interactions'
];

let data = null;
let saveTimer = null;

function defaults() {
  const d = { meta: { version: 1, createdAt: Date.now() }, seq: {} };
  for (const c of COLLECTIONS) d[c] = [];
  return d;
}

function load() {
  if (data) return data;
  try {
    if (fs.existsSync(DB_FILE)) {
      data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      for (const c of COLLECTIONS) if (!Array.isArray(data[c])) data[c] = [];
      if (!data.seq) data.seq = {};
    } else {
      data = defaults();
    }
  } catch (e) {
    console.error('[db] load failed, start fresh:', e.message);
    data = defaults();
  }
  return data;
}

/**
 * 生成自增 id。
 *
 * ⚠️ **这里刻意保持「连续小数字」，不要照抄云函数版的槽位方案**：
 *   本地服务是**单实例**（就一个 Node 进程），不存在「两个实例各自计数、
 *   生成同一个 id 互相覆盖」的竞态，所以不需要槽位；
 *   保持小 id 才能让本地演示数据、冒烟测试里引用的 id 稳定可读。
 *   云函数是多实例，那边用 `seq * 65536 + 实例随机槽位`，见
 *   cloudfunctions/campus/db.js 的 nextId 与 tools/test-id-uniqueness.js。
 */
function nextId(name) {
  const d = load();
  d.seq[name] = (d.seq[name] || 0) + 1;
  saveSoon();
  return d.seq[name];
}

function get(name) {
  const d = load();
  return d[name] || (d[name] = []);
}

function insert(name, doc) {
  const d = load();
  const now = Date.now();
  const item = Object.assign(
    { id: nextId(name), createdAt: now, updatedAt: now },
    doc
  );
  d[name].push(item);
  saveSoon();
  return item;
}

function insertMany(name, docs) {
  return docs.map((x) => insert(name, x));
}

function findById(name, id) {
  const numId = Number(id);
  return get(name).find((x) => x.id === numId) || null;
}

/**
 * 「内存查不到就去库里捞」的兼容实现。
 *
 * 云函数版（cloudfunctions/campus/db.js）是**真的去数据库捞** —— 那边多实例，
 * 内存只是冷启动快照，别的实例写入的记录本实例根本没有。
 * 本地服务是**单实例、内存即真相**，没有这个问题，所以这里直接返回内存结果。
 *
 * 之所以要提供这个方法：路由层（`route-trade.js` / `route-social.js` / `route-extend.js`）
 * 与云端是**镜像**的，代码里写死了 `await db.findByIdWithFallback(...)`。
 * 少了这个方法，本地一调删除/修改就 TypeError（历史上就出过：上次只改了云端语义，
 * 忘了本地镜像没有这个函数，本地服务的 DELETE 直接崩）。
 *
 * 返回形状与云端保持一致：`{ doc, fromDb }`。
 */
async function findByIdWithFallback(name, id) {
  return { doc: findById(name, id), fromDb: false };
}

/**
 * 以下三个是云端数据层方法的**单实例等价实现**。
 *
 * 云端：readAllFromDb 是真去数据库拉全量（多实例内存不可信）；
 *       findByIdFresh / updateFresh 是「先直查最新、再打补丁、再落库」。
 * 本地：单实例、内存即真相，所以直接落到内存版本即可。
 *
 * 提供它们的原因与 findByIdWithFallback 相同：`server/src/routes/*` 与
 * `cloudfunctions/campus/*` 是镜像代码，路由层写死了这些方法名；
 * 本地缺一个，一调就 TypeError（而且只在本地暴露，容易误判成"线上没问题"）。
 */
async function readAllFromDb(name) {
  return get(name).map((x) => Object.assign({}, x));
}

/**
 * 按字段取一批文档（云端是真查库；本地单实例直接筛内存）。
 *
 * 存在的理由是镜像一致：路由层要用它做**幂等去重**
 * （发布商品/帖子时拿 reqId 查「这条请求是不是已经建过了」）。
 * 本地少一个方法，路由一调就 TypeError —— 而且只在本地暴露。
 */
async function fetchByField(name, field, value, limit) {
  return get(name)
    .filter((x) => String(x[field]) === String(value))
    .slice(0, limit || 1000)
    .map((x) => Object.assign({}, x));
}

async function findByIdFresh(name, id) {
  return findById(name, id);
}

async function updateFresh(name, id, patch) {
  return update(name, id, patch);
}

function find(name, predicate) {
  return get(name).filter(predicate);
}

function one(name, predicate) {
  return get(name).find(predicate) || null;
}

function update(name, id, patch) {
  const item = findById(name, id);
  if (!item) return null;
  Object.assign(item, patch, { updatedAt: Date.now() });
  saveSoon();
  return item;
}

function remove(name, predicate) {
  const d = load();
  const list = d[name];
  let removed = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (predicate(list[i])) { list.splice(i, 1); removed++; }
  }
  if (removed) saveSoon();
  return removed;
}

function removeById(name, id) {
  return remove(name, (x) => x.id === Number(id)) > 0;
}

/**
 * 删除并**立刻落盘**（不等 debounce）。
 *
 * 与云函数版的 `removeFresh` 语义对齐：管理端的删除必须当场可见。
 * 本地是单实例、列表读内存，本来就不会出现「删了还在」；
 * 但走云函数时（本项目本地服务可切云端模式）那条路径依赖 flush，
 * 所以两边的调用方都用同一个名字，避免以后只改一边。
 */
function removeFresh(name, id) {
  const n = Number(id);
  if (!n) return false;
  const ok = findById(name, n) ? (remove(name, (x) => x.id === n) > 0) : false;
  flush();
  return ok;
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 250);
}

function flush() {
  if (!data) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('[db] save failed:', e.message);
  }
}

process.on('exit', () => { try { flush(); } catch (e) {} });
process.on('SIGINT', () => { flush(); process.exit(0); });

module.exports = {
  COLLECTIONS, DATA_DIR, DB_FILE,
  load, flush, saveSoon, get, insert, insertMany,
  findById, findByIdWithFallback, find, one, update, remove, removeById, removeFresh, nextId,
  readAllFromDb, findByIdFresh, updateFresh, fetchByField
};
