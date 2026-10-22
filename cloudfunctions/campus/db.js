'use strict';
/**
 * 云数据库适配层
 *
 * 设计目标：与本地 JSON 版 db.js 保持 **完全相同的同步接口**，
 * 使 routes/ 下的业务代码无需改动即可运行在云函数里。
 *
 * 实现方式：内存镜像 + 增量落库
 *   - 冷启动时把云数据库各集合读入内存
 *   - 业务代码同步读写内存（快）
 *   - 单次调用结束前 flush() 把变更的文档增量写回云数据库
 *
 * 一致性前提：云函数配置为「单实例」（maxInstances=1），
 * 所有请求共用同一实例的内存镜像，因此内存即为权威数据。
 */
const cloud = require('wx-server-sdk');

const COLLECTIONS = [
  'users', 'sessions', 'listings', 'favorites', 'wants', 'histories', 'orders', 'transactions',
  'conversations', 'messages', 'circles', 'posts', 'comments', 'reports', 'addresses',
  'notices', 'follows',
  'groups', 'walls', 'wallComments', 'resources', 'escrows',
  /* 互动消息（点赞/评论/回复/收藏…）—— 见 interactions.js */
  'interactions',
  'meta'
];

const PAGE = 1000;

let _db = null;
let data = null;
let loaded = false;
let loadingPromise = null;

/**
 * 变更检测基线（集合名 -> { docId: JSON 字符串 }）。
 *
 * 用途：让 saveSoon() 变成真正的「保存已改动的文档」。
 *
 * 背景（真实事故）：云函数版里 flush() 只写 dirty 里的文档，而最早的
 * saveSoon() 是**空实现**（注释写着「请求结束统一 flush」，但 flush 并不知道
 * 哪些文档被直接改过字段）。于是所有
 *     o.status = 'shipped'; o.timeline.push(...); db.saveSoon();
 * 这种写法在云端**全部不落库** —— 订单状态、点赞、拼团进度、会话列表预览
 * 都只在当前实例的内存里生效，冷启动/换实例后统统回退。
 * 实测证据：发消息后 messages 里有了新消息，但 conversations.lastMessage 没变。
 *
 * 这里不再逐个改动那二十多处调用点（容易漏、也容易改错），
 * 而是在 flush 前做一次「文档内容对比」：与基线不同的就 markDirty，
 * 交给既有的批量写入逻辑落库。一处生效，之后新写的代码也不会再踩。
 */
let baseline = null;
let saveSoonFlag = false;
let configSnapshot = '';
let adminSnapshot = '';   // 云端已存的 admin 凭据快照，用于判断是否需要回写
let colsReady = false;   // 本次实例是否已确认集合存在
let seedReady = false;   // 本次实例是否已生成种子数据
const dirty = {};    // name -> Map(id -> doc)
const removed = {};  // name -> Set(id)

function db() {
  if (!_db) {
    cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
    _db = cloud.database();
  }
  return _db;
}

function defaults() {
  const d = { seq: {}, meta: { config: {}, initialized: false, admin: null } };
  for (const c of COLLECTIONS) d[c] = [];
  return d;
}

/** 写入进度标记（分片初始化用） */
async function readState() {
  try {
    const s = await db().collection('meta').doc('state').get();
    const v = (s && s.data) || {};
    return {
      initialized: !!v.initialized,
      written: Array.isArray(v.written) ? v.written : []
    };
  } catch (e) {
    return { initialized: false, written: [] };
  }
}

let stateCache = null;

/**
 * 廉价查询初始化状态（单文档读 + 实例内缓存）。
 *
 * 为什么需要：业务入口若先做 db.ensure()（全量读 23 个集合），
 * 冷启动时会直接吃掉云函数 3 秒超时。这里只读 meta/state 一个文档。
 */
async function quickState() {
  if (stateCache) return stateCache;
  stateCache = await readState();
  return stateCache;
}

/** 取内存中各集合条数（不读库） */
function snapshotCounts() {
  if (!data) return {};
  const out = {};
  for (const n of ['users', 'listings', 'posts', 'groups', 'walls', 'resources', 'messages']) {
    out[n] = get(n).length;
  }
  return out;
}

async function saveState(state) {
  try {
    await db().collection('meta').doc('state').set({
      data: { initialized: !!state.initialized, written: state.written || [], at: Date.now() }
    });
  } catch (e) { /* 忽略 */ }
  stateCache = { initialized: !!state.initialized, written: (state.written || []).slice() };
}

/**
 * 按需保证单个集合存在。
 *
 * 相比「一次性探测 23 个集合」，这里只在真正要写某个集合前探测它，
 * 冷启动开销从 ~23 次往返降到 1 次。
 */
const colsOk = {};
async function ensureCollection(name) {
  if (colsOk[name]) return true;
  try {
    await db().collection(name).limit(1).get();
    colsOk[name] = true;
    return true;
  } catch (e) {
    try {
      await db().createCollection(name);
    } catch (e2) { /* 已存在则忽略 */ }
    colsOk[name] = true;
    return true;
  }
}

/** 重置内存为「刚 seed 完」的状态 */
function resetAndSeed() {
  const cfg = (data && data.meta && data.meta.config) || {};
  const fresh = defaults();
  fresh.meta.config = cfg;
  data = fresh;
  clearDirty();
  loaded = true;
  withPlainIds(() => {
    require('./seed').build();
    require('./seed2').build();
  });
  snapshotBaseline();
}

/**
 * 分片初始化：每次调用只推进「一个集合」的写入。
 *
 * 背景：云函数默认超时仅 3 秒，而全量初始化（建集合 + 写 ~290 条）需要 10 秒以上，
 * 一次性做完必然超时。因此拆成多次调用，前端循环推进，每步都远低于 3 秒。
 *
 * 幂等：进度存在 meta.state.written；每次重新 seed 得到的 id 由 seq 决定，
 * 重置后生成结果一致 → 重复写同一集合是覆盖，不会产生重复数据。
 *
 * @param {string} action 'step' 推进一步 | 'reset' 清空进度
 */
async function initStep(action) {
  // 0) 重置进度
  if (action === 'reset') {
    await saveState({ initialized: false, written: [] });
    for (const k of Object.keys(colsOk)) delete colsOk[k];
    seedReady = false;
    return { done: false, reset: true };
  }

  // 1) 读进度（单文档读；集合不存在时 ensureCollection 会补建）
  await ensureCollection('meta');
  const state = await quickState();
  if (state.initialized) {
    return { done: true, alreadyDone: true, written: state.written.length };
  }

  // 3) 生成种子数据（纯内存）。同一实例内只做一次，避免每次 step 都重新 build
  if (!seedReady) {
    resetAndSeed();
    seedReady = true;
  }

  // 4) 计算待写集合：有数据且尚未写入
  const pending = COLLECTIONS.filter(
    (n) => n !== 'meta' && get(n).length > 0 && state.written.indexOf(n) === -1
  );

  const totalCols = COLLECTIONS.filter((n) => n !== 'meta' && get(n).length > 0).length;

  if (pending.length === 0) {
    // 5) 全部写完 → 标记完成
    state.initialized = true;
    await saveState(state);
    return { done: true, written: state.written.length, counts: snapshotCounts() };
  }

  // 6) 写第一个待写集合（deadline 收紧，给冷启动与网络留足余量）
  const col = pending[0];
  const rows = get(col).length;
  const f = await flush({ only: [col], deadline: Date.now() + 1200 });

  if (f.pending === 0 && f.errors.length === 0) {
    state.written.push(col);
    await saveState(state);
  }

  return {
    done: false,
    col,
    rows,
    wrote: f.written,
    errors: f.errors,
    pending: f.pending,
    progress: state.written.length + '/' + totalCols,
    next: pending.slice(1, 4)
  };
}

/** 清空待写入队列（初始化重来时使用） */
function clearDirty() {
  for (const k of Object.keys(dirty)) delete dirty[k];
  for (const k of Object.keys(removed)) delete removed[k];
}

/** 全量读取某个集合（分页拉取，突破单次 1000 条限制） */
/**
 * 分页读取整个集合。
 *
 * @param {string} name
 * @param {boolean} [strict] true = 读失败时**抛出**（而不是静默返回空数组）。
 *   调用方要拿结果去**覆盖某个派生值**（例如用真实评论数覆盖 commentCount）时
 *   必须用严格模式：否则「读失败」与「集合本来就是空的」都返回 []，
 *   会把正确的值误清成 0 —— 比不修更糟。
 */
async function fetchCollection(name, strict) {
  const col = db().collection(name);
  const out = [];
  let skip = 0;
  for (;;) {
    let res;
    try {
      res = await col.skip(skip).limit(PAGE).get();
    } catch (e) {
      // 集合不存在时云数据库会报错，视为空集合
      if (strict) throw e;
      return [];
    }
    const list = (res && res.data) || [];
    out.push(...list);
    if (list.length < PAGE) break;
    skip += PAGE;
    if (skip > 20000) break; // 安全上限
  }
  return out;
}

/**
 * 把一批用户**以数据库为准**同步进内存（并发点读，带 TTL）。
 *
 * 为什么必须「刷新」而不只是「补缺」：
 *   `deco.sellerBrief(id)` 是**同步**函数（列表里要调用几十次），只能读内存；
 *   而本实例的内存镜像是冷启动快照、**永不刷新**。于是用户的头像/昵称
 *   在**两个方向**上都会错：
 *     ① 缺失 —— 这个人是别的实例刚注册的，本实例快照里根本没有他
 *        → 头像和昵称**同时空白**（sellerBrief 返回 null，前端渲染空字符串）
 *     ② 过期 —— 用户改过头像/昵称（本项目每人各自改各自的），本实例里还是旧值
 *        → 显示旧头像旧昵称
 *   「有时能显示、一刷新又没了」正是这两个方向的合成效果：
 *   请求在「启动得晚的实例（已含新资料）」和「启动得早的实例（旧资料/没有这个人）」
 *   之间来回落，同一个页面刷新两次就可能落到不同实例上。
 *
 * 做法：并发点读（`doc(String(id)).get()`，与 findByIdWithFallback 同一套 API，
 * 真实云库与测试 mock 都支持），然后**原地合并**进内存。
 *
 * ⚠️ 必须原地 Object.assign，**不能替换数组里的对象引用**：
 *    `markDirty` / `dirty[name]` 里存的是对象引用，替换引用会让 flush 把
 *    旧对象（旧数据）写回数据库。
 *
 * 三个安全边界：
 *   - 本实例里该用户有**未落库的改动**（在 dirty 里）→ 跳过：本地比库里新，别覆盖。
 *   - 本实例刚删了它（removed）→ 跳过。
 *   - 非 force 调用下，同一个用户 TTL 内不重复刷 → 列表翻页不会每页都查一遍。
 *
 * @param {Array<number|string>} ids 用户 id 列表（可含重复/空值）
 * @param {{force?:boolean}} [opts]
 *   `force=true` → **不看 TTL，每次都回库读**。用于「用户正盯着看、
 *   改了资料要立刻看到」的**低基数**场景：帖子详情、他人主页、回复对象。
 *   这些页面正是用户反馈「头像/昵称加载不出来、刷新就没了、
 *   改了名别人还是看到旧的」的地方，不能让 TTL 把它们挡在旧值上。
 *   列表页（首页 / 商品列表 / 订单 / 会话）仍走 TTL 节流：一次要查几十个
 *   卖家/作者，每页全量点读会把库打满；代价是列表上的名字最多旧 10 秒（详情页不受影响）。
 */
const USER_REFRESH_TTL = 10 * 1000;
const userRefreshedAt = new Map();

async function refreshUsers(ids, opts) {
  if (!data) return;   // 内存还没加载，无所谓"预热"
  const force = !!(opts && opts.force);
  const uniq = Array.from(new Set((ids || []).map((x) => Number(x)).filter((n) => !!n)));
  if (!uniq.length) return;
  const now = Date.now();
  const need = uniq.filter((id) => {
    if (isLocallyRemoved('users', id)) return false;
    if (dirty.users && dirty.users.has(String(id))) return false;
    if (!force && now - (userRefreshedAt.get(id) || 0) < USER_REFRESH_TTL) return false;
    return true;
  });
  if (!need.length) return;
  // 先盖时间戳再发请求：某个 id 查失败也不会被每个请求反复重试、把库打满
  for (const id of need) userRefreshedAt.set(id, now);

  await Promise.all(need.map(async (id) => {
    try {
      await ensureCollection('users');
      const res = await db().collection('users').doc(String(id)).get();
      const raw = res && res.data;
      if (!raw) return;
      const o = Object.assign({}, raw);
      delete o._id;
      o.id = Number(o.id || id);
      const list = get('users');
      const i = list.findIndex((x) => x.id === o.id);
      if (i === -1) list.push(o);
      else Object.assign(list[i], o);   // 原地合并：库里是权威值（头像/昵称/学院…）
    } catch (e) { /* 单点失败不影响其它用户 */ }
  }));
}

/**
 * 兼容旧调用点。
 *
 * 语义已经从「只把内存里没有的用户补进来」升级为「以库为准刷新这批用户」，
 * 这样所有原先只调用 warmUsers 的地方（帖子列表、订单、会话…）都一并受益，
 * 不必逐个去改。（保留旧名字是为了让这次改动只在一处生效。）
 */
async function warmUsers(ids) { return refreshUsers(ids); }

/**
 * 把某个用户的收藏**以数据库为准同步**进内存。
 *
 * 为什么需要：`deco.isFav()` 是**同步**函数（列表里要调用几十次），只能读内存。
 * 多实例下内存是冷启动快照，会同时错在**两个方向**：
 *   - 别人**新增**的收藏，本实例看不到 → 图标不亮、toggle 误判「没收藏过」又加一条
 *   - 别人**删除**的收藏，本实例内存里那条旧副本**阴魂不散** → 图标还是红的、
 *     「取消收藏了刷新又回来」（幽灵记录）
 *
 * ⚠️ 所以必须**替换**该用户的收藏，而不是像 fetchByField 那样"只补不删"。
 *    只补的话，幽灵记录永远清不掉 —— 这正是「取消收藏显示正常、但图标仍变不回来」的根因。
 *
 * 安全性：收藏是「单个用户自己的一小撮数据」，以库为准是安全的；
 * 本实例若刚新增/删除，都会在**本次请求结束前 flush 落库**（见 index.js 的 await db.flush()），
 * 因此下一个请求从库里读到的就是最新状态。
 * 查库失败时**不动内存**，宁可保留旧判断，也不要把用户的收藏清空。
 */
async function warmFavorites(userId) {
  if (!userId) return;
  const uid = Number(userId);
  let all = null;
  try { all = await fetchCollection('favorites'); } catch (e) { return; }
  if (!all) return;
  const mine = all
    .map((d) => {
      const o = Object.assign({}, d);
      delete o._id;
      if (o.id !== undefined && o.id !== null && o.id !== '') o.id = Number(o.id);
      return o;
    })
    // 跳过「本实例刚删、尚未落库」的（那一条我们已经删了，别再放回来）
    .filter((f) => Number(f.userId) === uid && !isLocallyRemoved('favorites', f.id));
  data.favorites = get('favorites').filter((f) => Number(f.userId) !== uid).concat(mine);
}

/**
 * 直查数据库取某个用户对某类目标的收藏记录。
 *
 * 用于 **toggle / 判断是否已收藏** 这类「读后写」的场景 ——
 * 必须看数据库的真值，只看内存镜像会误判（见 warmFavorites 的说明）。
 *
 * @returns {Promise<object[]>} 命中的收藏文档（可能为空数组）
 */
async function findFavorites(userId, targetType, targetId) {
  try {
    const list = await fetchByField('favorites', 'userId', Number(userId), 500);
    return (list || []).filter((f) =>
      f.targetType === targetType && Number(f.targetId) === Number(targetId));
  } catch (e) {
    // 查库失败退回内存，至少不比原来差
    return find('favorites', (f) =>
      f.userId === Number(userId) && f.targetType === targetType && Number(f.targetId) === Number(targetId));
  }
}

/**
 * 直查数据库取整个集合（绕过内存镜像，**不改动内存**）。
 *
 * 起因（真实事故）：管理后台「圈子帖子」数一直变来变去 ——
 * 用户删了一个帖子、又加了一个，刷新几次看到的数不一样。
 *
 * 因为统计接口读的是 `db.get()`，而那是**本实例冷启动时的快照**：
 * 云函数并发多实例，每个实例的快照加载时间不同，
 * 刷新命中哪个实例、就看到哪个时刻的数据 → 数字跳。
 *
 * 为什么不用「重新拉取覆盖内存镜像」：`dirty` 在 flush 之后并不会清空，
 * 无法判断"本实例的改动是否已落库"，覆盖有冲掉未落库改动的风险。
 * 而这个函数**只读不改**，天然没有这个问题。
 *
 * 集合都不大（十几到几十条），Promise.all 并发拉取开销可忽略。
 *
 * @param {string} name 集合名
 * @param {boolean} [strict] true = 读失败时**抛出**，而不是静默返回空数组。
 *   默认（宽松）适合「拿它当列表数据、失败就退回内存」的场景；
 *   而**要用结果覆盖派生值**的场景（如用真实评论数覆盖 commentCount）
 *   必须传 true —— 否则会把「读失败」误判成「一条都没有」，
 *   反而把正确的数字清成 0。
 * @returns {Promise<object[]>} 文档数组（已去掉 _id）
 */
async function readAllFromDb(name, strict) {
  const docs = await fetchCollection(name, strict);
  return (docs || [])
    .map((d) => {
      const o = Object.assign({}, d);
      delete o._id;
      // 与 fetchByField 保持一致：id 归一化成数字。
      // 不归一化时，从库读回的 id 可能是字符串，前端 `item.id === 目标id` 比较
      // 或后续「按 id 查详情」就会失败（表现为「点进去商品不存在」）。
      if (o.id !== undefined && o.id !== null && o.id !== '') o.id = Number(o.id);
      return o;
    })
    // 跳过「本实例刚删、尚未落库」的 —— 库里还在，但对我们已经不存在了
    .filter((o) => !isLocallyRemoved(name, o.id));
}

/**
 * 强制从数据库读一条（**不看内存镜像**）。
 *
 * `findByIdWithFallback` 是「镜像优先、缺失才查库」，适用于**读**；
 * 但管理端的**写**操作必须拿到最新版本 —— 否则会基于过期镜像
 * 把整份文档写回去，覆盖掉别人（其它实例/其它管理员）的改动。
 */
async function findByIdFresh(name, id) {
  const n = Number(id);
  if (!n) return null;
  try {
    await ensureCollection(name);
    const res = await db().collection(name).doc(String(n)).get();
    const raw = res && res.data;
    if (!raw) return null;
    const o = Object.assign({}, raw);
    delete o._id;
    o.id = Number(o.id || n);
    return o;
  } catch (e) {
    return null;
  }
}

/**
 * 「先直查最新、再打补丁、再落库」的更新。
 *
 * 为什么要专门做这个：`db.update` 是在**本实例的内存镜像**上打补丁，
 * 而 flush 会把**整份文档**写回数据库 ——
 * 若镜像已经过期（别的实例改过），这次更新就会把那些改动一起覆盖掉。
 * 管理端操作的是别人创建/维护的数据，最容易踩这个。
 *
 * 更新后同步进内存镜像，保证同一实例的后续读取一致。
 */
async function updateFresh(name, id, patch) {
  const fresh = await findByIdFresh(name, id);
  if (!fresh) return null;
  const merged = Object.assign({}, fresh, patch, { updatedAt: Date.now() });
  const list = get(name);
  const i = list.findIndex((x) => x.id === merged.id);
  if (i > -1) list[i] = merged; else list.push(merged);
  markDirty(name, merged);
  saveSoon();
  return merged;
}

/** 冷启动加载全量数据到内存（同一实例只做一次） */async function load(force) {
  if (loaded && !force) return data;
  if (loadingPromise && !force) return loadingPromise;
  loadingPromise = (async () => {
    const d = defaults();
    const names = COLLECTIONS.filter((n) => n !== 'meta');
    const results = await Promise.all(names.map((n) => fetchCollection(n)));
    names.forEach((n, i) => {
      d[n] = results[i].map((doc) => {
        const o = Object.assign({}, doc);
        delete o._id;
        return o;
      }).sort((a, b) => (a.id || 0) - (b.id || 0));
    });
    // meta：seq 计数器 + 平台配置 + 管理凭据 + 初始化状态
    try {
      const m = await db().collection('meta').doc('seq').get();
      d.seq = (m && m.data && m.data.value) || {};
    } catch (e) {
      d.seq = {};
    }
    try {
      const c = await db().collection('meta').doc('config').get();
      d.meta.config = (c && c.data && c.data.value) || {};
    } catch (e) {
      d.meta.config = {};
    }
    // 管理后台凭据。单独存一个文档，不放进 config ——
    // config 可能通过接口下发给客户端，混进去等于泄露后台密码。
    try {
      const a = await db().collection('meta').doc('admin').get();
      d.meta.admin = (a && a.data && a.data.value) || null;
    } catch (e) {
      d.meta.admin = null;
    }
    // 先按「云端实际存着的值」记快照，再自愈；
    // 顺序不能反，否则快照会等于自愈后的值，flush 会认为无需回写。
    adminSnapshot = JSON.stringify(d.meta.admin || null);
    if (!d.meta.admin) {
      // 老版本没有持久化过 admin → 补回默认凭据，本次请求结束的 flush 会落库。
      d.meta.admin = Object.assign({}, require('./const').DEFAULT_ADMIN);
    }
    try {
      const s = await db().collection('meta').doc('state').get();
      d.meta.initialized = !!(s && s.data && s.data.initialized);
    } catch (e) {
      d.meta.initialized = false;
    }
    /**
     * 兜底：seq 缺失或落后时，用各集合现有最大 id 反推回 seq，避免新插入 id 冲突。
     *
     * ⚠️ 必须**除以 ID_SLOT_SPAN** 才能还原成 seq。
     *    直接取「最大 id」当日志的话，会把「已经发出去的 id」（= seq*SPAN + 槽位）
     *    当成新的 seq，下次再乘 SPAN → id 量级呈指数膨胀，几轮就超过
     *    Number.MAX_SAFE_INTEGER（JS 数字精度丢失、id 开始互相碰撞）。
     *    历史的小 id（种子 1~49）反推出来是 0，不影响 seq 的继续递增。
     */
    for (const n of names) {
      const maxSeq = d[n].reduce((m, x) => Math.max(m, Math.floor((Number(x.id) || 0) / ID_SLOT_SPAN)), 0);
      if (!d.seq[n] || d.seq[n] < maxSeq) d.seq[n] = maxSeq;
    }
    data = d;
    loaded = true;
    configSnapshot = JSON.stringify(d.meta.config || {});
    // 基线必须在「刚加载完」时建立：之后任何字段改动都能被比对出来
    snapshotBaseline();
    return data;
  })();
  return loadingPromise;
}

function get(name) {
  if (!data) throw new Error('db not loaded');
  if (!data[name]) data[name] = [];
  return data[name];
}

function markDirty(name, doc) {
  if (!dirty[name]) dirty[name] = new Map();
  dirty[name].set(String(doc.id), doc);
  if (removed[name]) removed[name].delete(String(doc.id));
}

/**
 * id 的「槽位」间隔：每个 (seq) 号下最多容纳这么多实例各自持有的一段 id。
 *
 * 由来：原来 `nextId` 直接用**每实例内存里的**计数器 `data.seq[name] += 1`，
 * 而云函数是**多实例**的 —— 两个实例同时冷启动会各自读到同一个 seq，
 * 各自 +1 → **生成同一个 id** → 两份文档写同一个文档 id → **后写的覆盖先写的**。
 * 这是**静默丢数据**，实测可稳定复现（见 tools/test-id-uniqueness.js）：
 *   A 拿到 id=26，B 也拿到 id=26 → 云库里只剩 B 那一条，A 的评论凭空消失。
 * 用户反馈的「经常吞评论信息」正是这个机制：帖子上的评论数被两个实例各 +1（=2），
 * 而 comments 集合里只剩 1 条甚至 0 条。
 *
 * 现在把 id 拆成两段：`seq * 65536 + 本实例的随机槽位`。
 *   - **跨实例**：槽位随机（65536 分之一才撞），同一 seq 也不会重复；
 *   - **同实例**：seq 递增，天然不重复；
 *   - **顺序**：仍然随 seq 递增（聊天 afterId 游标、「最大 id 即最新消息」都照旧成立）；
 *   - **量级**：seq 到百万级时 id 仍只有 10 位数，远小于 Number.MAX_SAFE_INTEGER，
 *     也**不会**让历史的小 id（种子数据 1~49）与新 id 的先后顺序错乱。
 */
/**
 * 种子导入期间的 id 模式：true = 用朴素连续 id（1、2、3…，即改动前的行为）。
 *
 * 为什么种子要和运行时分开：
 *   ① 种子导入**只由一个实例做一次**（受 `meta.state.initialized` 保护），
 *      不存在跨实例并发 → 不需要槽位；
 *   ② 分片初始化靠「重复 seed 得到**相同** id → 覆盖写」来保证幂等
 *      （见 initStep 的注释）。若种子 id 带随机槽位，换个实例重跑就会生成
 *      另一套 id → 变成**重复数据**而不是覆盖；
 *   ③ 线上已有的种子数据就是 1~49 这种小数字，保持一致便于排查。
 *   运行时新写入的记录仍然走带槽位的 id（见 nextId），从而避免多实例互相覆盖。
 */
let plainIdMode = false;

/** 在「朴素 id 模式」下执行种子构建（异常也保证恢复现场） */
function withPlainIds(fn) {
  plainIdMode = true;
  try { fn(); } finally { plainIdMode = false; }
}

const ID_SLOT_SPAN = 65536;
const INSTANCE_SLOT = Math.floor(Math.random() * ID_SLOT_SPAN);

function nextId(name) {
  if (!data.seq[name]) data.seq[name] = 0;
  data.seq[name] += 1;
  if (!dirty.meta) dirty.meta = new Map();
  return plainIdMode ? data.seq[name] : data.seq[name] * ID_SLOT_SPAN + INSTANCE_SLOT;
}

function insert(name, obj) {
  const id = obj.id || nextId(name);
  const doc = Object.assign({ id }, obj);
  doc.createdAt = doc.createdAt || Date.now();
  get(name).push(doc);
  markDirty(name, doc);
  return doc;
}

function insertMany(name, list) {
  return (list || []).map((o) => insert(name, o));
}

function findById(name, id) {
  const n = Number(id);
  if (!n) return null;
  return get(name).find((x) => x.id === n) || null;
}

/**
 * 内存镜像未命中时回查一次数据库（并发实例下的可见性兜底）。
 *
 * 为什么需要：
 *   本模块的内存镜像是「同一实例只加载一次」且**永不刷新**（见 load()）。
 *   云函数多实例并发时会撞上这个时序 ——
 *     实例 A 新建会话并落库
 *     实例 B 的内存快照是在这之前加载的 → 里面没有这条会话
 *     B 处理「读这个会话的消息」时只查内存 → 误判「会话不存在」
 *   前端拿到「不存在」会走自愈逻辑 → 把用户从「卖家会话」丢进「AI 会话」。
 *   （见 tools/test-conv-fresh.js，该测试专门复现这个时序。）
 *
 * 命中数据库后会把文档补进内存，后续请求仍是内存速查，不额外增加开销。
 *
 * @returns {{doc: object|null, fromDb: boolean}} fromDb=true 表示内存镜像里原本没有
 */
/**
 * 本实例是否「已删除该文档、但还没落库」。
 *
 * ⚠️ 这是「直查数据库」方案必须配套处理的一面：
 *   我删了一条记录（removeById 只改内存 + 标记 removed，flush 才写库），
 *   紧接着又直查数据库 —— 库里那条**还在**，于是被我当成"别人的数据"补回内存，
 *   用户看到的现象就是「删了又回来」「取消收藏没效果」。
 *
 * 所以：凡是「直查数据库」的路径，都要用本函数跳过这些 id。
 */
function isLocallyRemoved(name, id) {
  const set = removed[name];
  return !!(set && set.has(String(id)));
}

async function findByIdWithFallback(name, id) {
  const n = Number(id);
  if (!n) return { doc: null, fromDb: false };
  // 本实例刚删了它（还没落库）→ 对调用方就是「不存在」，不能去库里捞回来
  if (isLocallyRemoved(name, n)) return { doc: null, fromDb: false };
  const hit = get(name).find((x) => x.id === n);
  if (hit) return { doc: hit, fromDb: false };
  try {
    await ensureCollection(name);
    const res = await db().collection(name).doc(String(n)).get();
    const raw = res && res.data;
    if (!raw) return { doc: null, fromDb: false };
    const o = Object.assign({}, raw);
    delete o._id;
    o.id = Number(o.id || n);
    get(name).push(o);
    get(name).sort((a, b) => (a.id || 0) - (b.id || 0));
    return { doc: o, fromDb: true };
  } catch (e) {
    // 文档确实不存在（或集合都还没建）→ 交给调用方按「不存在」处理
    return { doc: null, fromDb: false };
  }
}

/**
 * 直接按某个字段从数据库读一批文档，绕过内存镜像。
 *
 * 用于「内存镜像**确定**已过期」的场景，目前两处：
 *   1) 会话本身是刚从数据库补进来的 → 本实例快照早于该会话创建，
 *      那么该会话的消息在内存里必然也是空的（否则刚点开的会话看不到内容）
 *   2) 轮询增量（带 afterId）→ 这条路径的职责就是发现新消息，
 *      而内存镜像永不刷新，只看内存永远发现不了别的实例写入的消息
 *
 * 读到的文档会补进内存；**不覆盖**已有项，避免冲掉本实例更新过的数据。
 */
async function fetchByField(name, field, value, limit) {
  try {
    await ensureCollection(name);
    const res = await db().collection(name).where({ [field]: value }).limit(limit || 1000).get();
    const list = ((res && res.data) || []).map((d) => {
      const o = Object.assign({}, d);
      delete o._id;
      o.id = Number(o.id);
      return o;
    });
    const have = new Set(get(name).map((x) => String(x.id)));
    // 跳过「本实例刚删、尚未落库」的：库里还在，但对我们已经不存在了。
    // 否则会出现「取消收藏后又自己变回已收藏」「删了又回来」。
    const kept = list.filter((o) => !isLocallyRemoved(name, o.id));
    for (const o of kept) if (!have.has(String(o.id))) get(name).push(o);
    return kept;
  } catch (e) {
    return [];
  }
}

function find(name, predicate) {
  const list = get(name);
  return predicate ? list.filter(predicate) : list.slice();
}

function one(name, predicate) {
  return get(name).find(predicate) || null;
}

function update(name, id, patch) {
  const doc = findById(name, id);
  if (!doc) return null;
  Object.assign(doc, patch, { updatedAt: Date.now() });
  markDirty(name, doc);
  return doc;
}

function remove(name, predicate) {
  const list = get(name);
  const keep = [];
  const gone = [];
  for (const x of list) {
    if (predicate(x)) gone.push(x);
    else keep.push(x);
  }
  data[name] = keep;
  for (const g of gone) {
    if (!removed[name]) removed[name] = new Set();
    removed[name].add(String(g.id));
    if (dirty[name]) dirty[name].delete(String(g.id));
  }
  return gone.length;
}

function removeById(name, id) {
  const n = Number(id);
  if (!n) return 0;
  const doc = findById(name, n);
  if (!doc) {
    /**
     * 内存里没有这条，但调用方明确要删它 —— 这条很可能是刚从**数据库直查**到的
     * （例如 toggle 用 findFavorites 从库里查到一条本实例内存里没有的收藏）。
     * 此时仍要标记为「已删除」，flush 才会真的从库里删掉；
     * 否则会出现「取消收藏返回成功、但刷新后收藏又回来了」。
     */
    if (!removed[name]) removed[name] = new Set();
    removed[name].add(String(n));
    return 0;
  }
  return remove(name, (x) => x.id === n);
}

/**
 * **立刻从数据库删掉**一条文档（同时清掉内存镜像与待写队列）。
 *
 * 与 `removeById` 的区别：`removeById` 只改内存 + 标记 removed，
 * 真正落库要等请求末尾的 `flush()`。而 flush 有 **deadline 保护** ——
 * 接近云函数超时时会提前收工，把删除留在"下次调用"再写。
 * 于是管理端会看到「删了还在」：
 *   ① DELETE 请求因为超时保护没把删除写进库
 *   ② 紧接着的列表请求落在**另一个实例**上，直查库 → 那条文档还在
 * （`tools/test-admin-ui.js` 的「公告删除未生效」就是偶发命中这个时序。）
 *
 * 管理端的删除必须**当场可见**，所以这里直接删库，不依赖 flush。
 * 删除失败时返回 false，让调用方自己决定怎么报错 —— 不要静默当成成功。
 */
async function removeFresh(name, id) {
  const n = Number(id);
  if (!n) return false;
  await ensureCollection(name);
  await db().collection(name).doc(String(n)).remove();   // 失败则抛出
  // 库里已经没了：内存镜像、待写队列、待删队列都要一起清，避免又被写回去
  const list = get(name);
  const i = list.findIndex((x) => x.id === n);
  if (i > -1) list.splice(i, 1);
  if (dirty[name]) dirty[name].delete(String(n));
  if (removed[name]) removed[name].delete(String(n));
  return true;
}

/**
 * 记录当前所有文档的内容基线（load / resetAndSeed / initialize 之后调用）。
 * meta 与 seq 单独处理（它们有各自的快照机制），这里跳过。
 */
function snapshotBaseline() {
  if (!data) { baseline = null; return; }
  baseline = {};
  for (const name of Object.keys(data)) {
    if (name === 'meta' || name === 'seq') continue;
    const list = data[name];
    if (!Array.isArray(list)) continue;
    const map = {};
    for (const doc of list) map[String(doc.id)] = JSON.stringify(doc);
    baseline[name] = map;
  }
}

/**
 * 把「相对基线被改过」的文档标记为待写。
 *
 * 直接改字段（obj.x = 1）不会触发 markDirty，所以只能靠内容比对发现；
 * 比对用的 JSON 字符串同时用于更新基线，避免同一改动被重复标记。
 */
function markChangedByDiff() {
  if (!data) return;
  if (!baseline) { snapshotBaseline(); return; }
  for (const name of Object.keys(data)) {
    if (name === 'meta' || name === 'seq') continue;
    const list = data[name];
    if (!Array.isArray(list)) continue;
    if (!baseline[name]) baseline[name] = {};
    const base = baseline[name];
    for (const doc of list) {
      const key = String(doc.id);
      const now = JSON.stringify(doc);
      if (base[key] !== now) {
        markDirty(name, doc);
        base[key] = now;
      }
    }
  }
}

/**
 * 「稍后保存」。
 *
 * 云函数内没有常驻进程，统一由请求结束时的 flush() 落库；
 * 这里只置一个标记，flush 动手前会先做一次变更比对（见 markChangedByDiff）。
 */
function saveSoon() { saveSoonFlag = true; }

/**
 * 把内存中的变更增量写回云数据库（错误不再静默吞掉，统一收集返回）
 *
 * 分批并发写入：云开发对单环境写入有 QPS 限制，一次性并发几百条
 * 容易触发限流导致部分失败。这里改为「批内并发、批间串行」，
 * 并支持 deadline 保护——接近超时时提前收工，未写完的留在 dirty 里，
 * 下次调用继续写（幂等，doc.set 覆盖同 id）。
 */
async function flush(opts) {
  const deadline = (opts && opts.deadline) || 0;
  const only = (opts && opts.only) || null;   // 只写这些集合（分片初始化用）
  if (!data) return { written: 0, deleted: 0, errors: [], pending: 0 };

  // 0) 有人调过 saveSoon() → 先找出「被直接改过字段」的文档并标记待写。
  //    必须在收集 dirty 之前做，否则这些改动会被漏掉（历史事故，见 baseline 注释）。
  if (saveSoonFlag) {
    saveSoonFlag = false;
    markChangedByDiff();
  }

  const BATCH = 20;
  let written = 0;
  let deleted = 0;
  let pending = 0;
  const errors = [];
  const timeUp = () => deadline > 0 && Date.now() > deadline;

  const noteErr = (where, e) => {
    const msg = (e && (e.errMsg || e.message)) || String(e);
    if (errors.length < 20) errors.push(where + ': ' + msg);
  };

  // 1) seq 计数器
  if (dirty.meta) {
    try {
      await db().collection('meta').doc('seq').set({ data: { value: data.seq, updatedAt: Date.now() } });
      dirty.meta.clear();
    } catch (e) { noteErr('meta.seq', e); }
  }

  // 1.5) 平台配置（内容变化时才写）
  try {
    const now = JSON.stringify(data.meta.config || {});
    if (now !== configSnapshot) {
      await db().collection('meta').doc('config').set({ data: { value: data.meta.config, updatedAt: Date.now() } });
      configSnapshot = now;
    }
  } catch (e) { noteErr('meta.config', e); }

  // 1.6) 管理后台凭据（内容变化时才写）
  //      必须持久化：否则云函数一冷启动就读不到 admin，后台登录必然 401（与密码值无关）。
  //      单独存 meta/admin 文档，不混进 config —— config 可能下发给客户端。
  try {
    const nowAdmin = JSON.stringify(data.meta.admin || null);
    if (nowAdmin !== adminSnapshot) {
      await db().collection('meta').doc('admin').set({ data: { value: data.meta.admin, updatedAt: Date.now() } });
      adminSnapshot = nowAdmin;
    }
  } catch (e) { noteErr('meta.admin', e); }

  // 2) 收集待写项
  const puts = [];   // { col, id, doc }
  const dels = [];   // { col, id }
  const allow = (name) => !only || only.indexOf(name) > -1;
  for (const name of Object.keys(dirty)) {
    if (name === 'meta') continue;
    if (!allow(name)) continue;
    const map = dirty[name];
    if (!map || !map.size) continue;
    const col = db().collection(name);
    for (const [id, doc] of map) puts.push({ col, id, doc, name });
  }
  for (const name of Object.keys(removed)) {
    if (!allow(name)) continue;
    const set = removed[name];
    if (!set || !set.size) continue;
    const col = db().collection(name);
    for (const id of set) dels.push({ col, id, name });
  }

  // 3) 分批写入；成功后从 dirty/removed 中移除，失败的保留待重试
  async function runBatches(items, kind) {
    // 写入前按需建集合（只探测真正要写的集合，避免 23 次无用往返）
    const names = [...new Set(items.map((it) => it.name))];
    for (const n of names) {
      if (timeUp()) { pending += items.length; return false; }
      await ensureCollection(n);
    }
    for (let i = 0; i < items.length; i += BATCH) {
      if (timeUp()) {
        pending += items.length - i;
        return false;
      }
      const slice = items.slice(i, i + BATCH);
      const results = await Promise.all(slice.map((it) =>
        (kind === 'put'
          ? it.col.doc(it.id).set({ data: it.doc })
          : it.col.doc(it.id).remove()
        ).then(() => true).catch((e) => { noteErr(kind + ' ' + it.name + '#' + it.id, e); return false; })
      ));
      results.forEach((ok, k) => {
        const it = slice[k];
        if (ok) {
          if (kind === 'put') { written++; if (dirty[it.name]) dirty[it.name].delete(it.id); }
          else { deleted++; if (removed[it.name]) removed[it.name].delete(it.id); }
        } else {
          pending++;
        }
      });
    }
    return true;
  }

  await runBatches(puts, 'put');
  if (!timeUp()) await runBatches(dels, 'del');

  return { written, deleted, errors, pending };
}

/**
 * 创建全部集合（云开发 NoSQL 的集合必须先建，SDK 不能隐式建表）
 * 先并发探测哪些已存在，再并发创建缺失的，减少串行等待。
 */
async function createCollections() {
  const created = [];
  const existed = [];
  const failed = [];
  const missing = [];

  // 1) 并发探测存在性
  const probes = await Promise.all(COLLECTIONS.map((name) =>
    db().collection(name).limit(1).get()
      .then(() => true)
      .catch(() => false)
  ));
  COLLECTIONS.forEach((name, i) => {
    if (probes[i]) existed.push(name);
    else missing.push(name);
  });

  // 2) 并发创建缺失的（每批 5 个，避免瞬时压力）
  const BATCH = 5;
  for (let i = 0; i < missing.length; i += BATCH) {
    const slice = missing.slice(i, i + BATCH);
    const rs = await Promise.all(slice.map((name) =>
      db().createCollection(name)
        .then(() => ({ name, ok: true }))
        .catch((e) => {
          const msg = (e && (e.errMsg || e.message)) || String(e);
          if (/exist|already/i.test(msg)) return { name, ok: true, existed: true };
          return { name, ok: false, msg };
        })
    ));
    rs.forEach((r) => {
      if (r.ok) { if (r.existed) existed.push(r.name); else created.push(r.name); }
      else failed.push(r.name + ': ' + r.msg);
    });
  }

  return { created, existed, failed };
}

/** 清除完成标记（强制重新导入时使用） */
async function resetInitialized() {
  try {
    await db().collection('meta').doc('state').set({ data: { initialized: false, at: Date.now() } });
  } catch (e) { /* 忽略 */ }
  if (data && data.meta) data.meta.initialized = false;
  loaded = false;
}

/**
 * 首次初始化：建集合 → 重置内存 → 生成种子 → 落库 → 写完成标记
 *
 * 幂等可重入：
 *  - 已完成（meta.initialized）直接返回
 *  - 未完成则清空内存重来。seed 的 id 来自 seq，重置 seq 后每次生成的 id 一致，
 *    因此重来是「覆盖写」而非追加，不会产生重复数据
 *  - 带 deadline：预算耗尽则提前收工且不写完成标记，下次调用继续
 */
async function initialize(deadline) {
  const report = { steps: [] };

  // 1) 建集合（NoSQL 必须先建，SDK 不能隐式建表）
  const cols = await createCollections();
  report.steps.push({
    step: 'createCollections',
    created: cols.created.length,
    existed: cols.existed.length,
    failed: cols.failed
  });

  // 2) 读数据库真实状态
  await load(true);

  // 3) 已完成则跳过
  if (data.meta.initialized) {
    report.skipped = true;
    report.users = get('users').length;
    return report;
  }

  // 4) 重置内存与待写队列（保证可重入）
  const cfg = data.meta.config || {};
  const fresh = defaults();
  fresh.meta.config = cfg;
  data = fresh;
  clearDirty();
  loaded = true;

  // 5) 生成种子数据（纯内存）
  try {
    withPlainIds(() => {
      require('./seed').build();
      require('./seed2').build();
    });
  } catch (e) {
    report.steps.push({ step: 'seed', error: e.message });
    return report;
  }
  const counts = {};
  for (const n of ['users', 'listings', 'posts', 'groups', 'walls', 'resources']) {
    counts[n] = get(n).length;
  }
  report.steps.push({ step: 'seed', counts });

  // 种子数据已生成，建立变更基线后落库
  snapshotBaseline();

  // 6) 落库
  const f = await flush({ deadline });
  report.steps.push({ step: 'flush', written: f.written, pending: f.pending, errors: f.errors });

  // 7) 全部写成功才标记完成
  if (f.pending === 0 && f.errors.length === 0) {
    try {
      await db().collection('meta').doc('state').set({
        data: { initialized: true, at: Date.now() }
      });
      data.meta.initialized = true;
      report.done = true;
    } catch (e) {
      report.steps.push({ step: 'markState', error: (e && e.errMsg) || String(e) });
    }
  } else {
    report.partial = true;
    report.note = '未全部写完，下次调用会重来（覆盖写，不会重复）';
  }

  return report;
}

/** 批量导入（用于种子数据初始化） */async function bulkInsert(name, docs) {
  const col = db().collection(name);
  const CHUNK = 100;
  let n = 0;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const chunk = docs.slice(i, i + CHUNK);
    await Promise.all(chunk.map((d) => col.doc(String(d.id)).set({ data: d }).then(() => { n++; }).catch(() => {})));
  }
  return n;
}

module.exports = {
  COLLECTIONS,
  db,
    /** 异步加载全量数据（入口调用一次）；要强制重新从云库加载请用 ensure(true) */
    ensure: load,
    /**
     * 同步返回内存数据（兼容本地版 db.load().meta.config 用法）。
     *
     * ⚠️ 这是同步内存读取，**不接受参数** —— 调用 db.load(true) 不会触发重新加载。
     *    真正的强制重载入口是上面的 ensure(force)。排查问题时别调错。
     */
    load: () => data || defaults(),
  flush,
  createCollections,
  ensureCollection,
  initialize,
  initStep,
  readState,
  quickState,
  snapshotCounts,
  resetInitialized,
  bulkInsert,
  get, insert, insertMany, findById, find, one, update, remove, removeById, nextId, saveSoon,
  /** 并发实例下的可见性兜底（内存 → 数据库） */
  findByIdWithFallback, fetchByField,
  /** 把内存里没有的用户补拉进来、**并把旧资料刷新成库里的值**，供同步的 deco.sellerBrief 使用 */
  warmUsers, refreshUsers,
  /** 把某用户的收藏补进内存 / 直查某条收藏（toggle 等「读后写」场景必须直查） */
  warmFavorites, findFavorites,
  /** 统计类接口用：直查数据库取整个集合，不改动内存镜像 */
  readAllFromDb,
  /** 管理端写操作用：先直查最新再打补丁，避免用过期镜像覆盖别人的改动 */
  findByIdFresh, updateFresh,
  /** 管理端删除用：立刻从库里删掉（不等 flush），保证"删了立刻看不到" */
  removeFresh,
  /** 种子导入用：在「朴素连续 id」模式下执行（多实例下种子只由一个实例做一次） */
  withPlainIds,
  /** 仅供调试：当前内存数据 */
  raw: () => data
};
