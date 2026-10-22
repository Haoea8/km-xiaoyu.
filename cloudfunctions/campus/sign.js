'use strict';
/**
 * 云存储图片「服务端签名」。
 *
 * ── 为什么需要它 ───────────────────────────────────────────────
 * 本项目存储桶**不是公开可读**。小程序端 <image src="cloud://...">
 * 会直接被拒（实测：tcb.qcloud.la 域名不带签名一律 403），
 * 表现为「别人看不到我发的商品图 / 头像」。
 *
 * 正规解法是在云开发控制台把存储权限改成「所有用户可读」，
 * 但**免费/试用环境禁掉了这个操作**（点开就提示「无法执行此操作 请升级至付费版」），
 * 微信开发者工具的 CLI 与 CloudBase HTTP OpenAPI 也都没有改权限的接口 —— 都试过，确实没有。
 *
 * ── 绕开的依据 ────────────────────────────────────────────────
 * 云开发控制台「存储权限」页自己的说明：
 *   「云控制台和服务端始终有所有文件读写权限，以下配置仅对小程序端发起的请求有效」
 * ⇒ 云函数是服务端，可以给**任意**文件签发临时链接，
 *   把 https 链接发给前端用即可，**一行存储权限都不用改**。
 *
 * 实测（2026-10-16，tools/check-storage-access.js）：
 *   同一张图，无签名 403；服务端换出的签名链接裸 GET 200 + image/jpeg。
 *
 * ── 三条硬约束 ────────────────────────────────────────────────
 * 1) **必须复制式替换，绝不原地修改**。接口返回值里常常直接引用着内存库里的对象，
 *    原地写入会把签名链接写进内存镜像、随后被 flush 落库 ——
 *    原图路径就被永久改成了几小时后失效的临时链接。
 * 2) **失败必须原样返回**。签名只是锦上添花，绝不能因为它把接口整个搞挂。
 * 3) **结果要缓存**。临时链接本身以小时计有效，不缓存就是每个请求多一次外部调用。
 *
 * 前端因此**零改动**：页面上的 api.abs() 对 https 原样放行（它只转 /static/ 开头的）。
 */

const cloud = require('wx-server-sdk');

/* 与 miniprogram/utils/config.js 保持一致 —— 换云环境时两处都要改 */
const CLOUD_ENV = 'cloud1-d1gm4yssj28112256';
const CLOUD_BUCKET = '636c-cloud1-d1gm4yssj28112256-1505193768';

/** fileID -> { url, exp } */
const cache = new Map();

/**
 * 缓存时长。
 *
 * ⚠️ 这里从 50 分钟改成了 23 小时，原因是真实反馈：
 *   「关掉电脑过了一会，图片和头像就加载不出来了」——
 *   接口数据全是好的，只有图 403。原因是**签名链接过期了**：
 *   小程序页面被系统缓存着，页面里存的是几小时前签的 https，
 *   用户切后台/隔一阵再回来，这些链接早已失效，`<image>` 只能渲染白块。
 *   电脑开关与云端无关（全走云开发），真正的时间炸弹是链接有效期。
 *
 * 现在签发时显式要 24 小时（URL_MAX_AGE），缓存取 23 小时 ——
 * 比有效期短一点，保证发出去的链接一定还没过期。
 */
const URL_MAX_AGE = 24 * 60 * 60;              // 秒
const CACHE_MS = 23 * 60 * 60 * 1000;          // 毫秒

/**
 * 换签（带降级）。
 *
 * 微信云开发的 `getTempFileURL` 支持 `fileList: [{ fileID, maxAge }]` 这种形态；
 * 但某些 SDK 版本只认字符串。所以：**先按带 maxAge 的调，整批都没签出来再退回字符串**。
 * 不能反过来 —— 先调字符串再补调的话，会白白多打一次存储服务。
 */
async function callSign(ids) {
  /**
   * ⚠️ **fileList 必须是字符串数组**（踩过，且是线上事故）：
   *
   * 曾经为了把链接有效期拉长，写成 `fileList: [{ fileID, maxAge }]` —— 那是
   * @cloudbase/node-sdk / Web SDK 的形态，wx-server-sdk 4.x **不认**。
   * 它照样返回 fileList、tempFileURL 也非空，但签名是按错的东西算的：
   * 线上每张图都变成 `...tcb.qcloud.la/...?sign=xxx&t=xxx` 然后**全部 403** ——
   * 表现就是「首页有的图能看、有的图白的」── 其实能看的那些是客户端缓存。
   *
   * 正确写法：fileList 传字符串，有效期用**顶层** maxAge（单位毫秒）。
   */
  try {
    const res = await cloud.getTempFileURL({ fileList: ids, maxAge: URL_MAX_AGE * 1000 });
    const rows = (res && res.fileList) || [];
    if (rows.some((f) => f && f.tempFileURL)) return rows;
  } catch (e) { /* 旧版 SDK 不认 maxAge → 退回最朴素的调用 */ }
  const res2 = await cloud.getTempFileURL({ fileList: ids });
  return (res2 && res2.fileList) || [];
}

/** 单次 getTempFileURL 的文件数上限 */
const BATCH = 50;

let _inited = false;

function ensureInit() {
  if (_inited) return;
  try {
    // db.js 里已经 init 过（DYNAMIC_CURRENT_ENV），这里只是兜底：重复 init 无副作用
    cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  } catch (e) { /* 忽略：init 失败时下面的调用会自然失败并被兜住 */ }
  _inited = true;
}

/**
 * 把 `/static/xxx` 与 `cloud://...` 统一成合法 fileID。
 * 其它字符串（含 http/https）返回 null —— 绝不碰已经可访问的链接。
 */
function toFileId(v) {
  if (typeof v !== 'string' || !v) return null;
  if (v.indexOf('cloud://') === 0) return v;
  if (v.indexOf('/static/') === 0) return 'cloud://' + CLOUD_ENV + '.' + CLOUD_BUCKET + v;
  return null;
}

/**
 * 只处理「纯对象 / 数组」。
 * Date、Buffer、Map、类实例一律跳过 —— 否则会被当成普通对象拆成 {} 而改坏结构。
 */
function isPlain(v) {
  if (!v || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** 深度收集需要签名的 fileID（去重前的原始列表） */
function collect(node, out) {
  if (typeof node === 'string') {
    const f = toFileId(node);
    if (f) out.push(f);
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) collect(node[i], out);
    return;
  }
  if (!isPlain(node)) return;
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) collect(node[keys[i]], out);
}

/**
 * 复制式替换：只在「这一支真的改到了」时才新建节点，否则复用原引用。
 * 这样既不会污染内存库，也不会为纯文本响应白白整树拷贝。
 */
function rewrite(node, map) {
  if (typeof node === 'string') {
    const f = toFileId(node);
    const u = f ? map[f] : null;
    return u || node;
  }
  if (Array.isArray(node)) {
    let changed = false;
    const arr = node.map((v) => {
      const nv = rewrite(v, map);
      if (nv !== v) changed = true;
      return nv;
    });
    return changed ? arr : node;
  }
  if (!isPlain(node)) return node;
  const keys = Object.keys(node);
  let changed = false;
  const o = {};
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const nv = rewrite(node[k], map);
    if (nv !== node[k]) changed = true;
    o[k] = nv;
  }
  return changed ? o : node;
}

/**
 * 批量换签并写进缓存。
 *
 * 三重容错（都针对「一张图没签成 = 真机上退回 cloud:// = 一块白）」）：
 *   ① **按批 try/catch**：某一批整体失败不影响其它批（原来一个 reject 会让整个响应放弃签名）；
 *   ② **单批里个别文件失败 → 重试一次**（偶发失败最常见，重试基本能成）；
 *   ③ **仍失败就记条日志**（只记数量，不记路径），否则这种现象在线上是**完全静默**的 ——
 *      用户只看到「个别商品没图」，而服务端日志一片正常，根本没法查。
 */
async function signInto(ids) {
  ensureInit();
  const now = Date.now();
  let failed = 0;

  const take = (list) => {
    const miss = [];
    const arr = list || [];
    for (let j = 0; j < arr.length; j++) {
      const f = arr[j];
      if (f && f.fileID && f.tempFileURL) cache.set(f.fileID, { url: f.tempFileURL, exp: now + CACHE_MS });
      else if (f && f.fileID) miss.push(f.fileID);
    }
    return miss;
  };

  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    let miss = chunk;
    try {
      // eslint-disable-next-line no-await-in-loop
      const rows = await callSign(chunk);
      miss = take(rows);
    } catch (e) {
      miss = chunk;   // 整批失败：当作全部未签，走下面的重试
    }
    if (!miss.length) continue;

    // 重试一次
    try {
      // eslint-disable-next-line no-await-in-loop
      const rows2 = await callSign(miss);
      const still = take(rows2);
      failed += still.length;
    } catch (e2) {
      failed += miss.length;
    }
  }

  if (failed) {
    try { console.warn('[sign] ' + failed + ' 个文件未能签名（真机上会退回 cloud:// → 显示白块）'); } catch (e) { /* 忽略 */ }
  }
}

/**
 * 把任意返回值里所有云存储图片换成带签名的 https 链接。
 * 入参可以是对象/数组/字符串；返回同构的新对象（无图片时原样返回）。
 *
 * @param {*} root 接口返回值
 * @returns {Promise<*>}
 */
async function resolve(root) {
  try {
    const found = [];
    collect(root, found);
    if (!found.length) return root;   // 纯文本响应：零开销直接返回

    const uniq = Array.from(new Set(found));
    const now = Date.now();
    const stale = uniq.filter((f) => {
      const c = cache.get(f);
      return !(c && c.url && c.exp > now);
    });
    if (stale.length) await signInto(stale);

    const map = {};
    let n = 0;
    for (let i = 0; i < uniq.length; i++) {
      const c = cache.get(uniq[i]);
      if (c && c.url) { map[uniq[i]] = c.url; n++; }
    }
    if (!n) return root;              // 一个都没签成：原样返回
    return rewrite(root, map);
  } catch (e) {
    try { console.warn('[sign] 跳过签名：' + (e && e.message)); } catch (e2) { /* 忽略 */ }
    return root;
  }
}

/** 仅供测试：清空缓存 */
function _clearCache() { cache.clear(); }

module.exports = { resolve, toFileId, _clearCache, CLOUD_ENV, CLOUD_BUCKET };
