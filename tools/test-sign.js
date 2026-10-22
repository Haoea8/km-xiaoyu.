/**
 * 图片签名（cloudfunctions/campus/sign.js）回归测试。**离线**，不需要联网、不需要部署。
 *
 * 守的是四条：
 *   A) 覆盖：`/static/...` 与 `cloud://...` 都要被换成签名链接，其它字符串不动
 *   B) ★ 安全：**绝不原地修改入参** —— 接口返回值常常直接引用内存库对象，
 *      原地写会把签名链接落库，把原图路径永久改坏（这条最要紧）
 *   C) 结构：Date / 非纯对象不被拆坏
 *   D) 兜底：签名失败、纯文本响应时都**原样返回**，不能把接口搞挂
 *
 * 用法：node tools/test-sign.js
 */
const Module = require('module');
const path = require('path');

const SIGN = 'D:/wx/campus-xianyu/cloudfunctions/campus/sign.js';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/* ---------- mock wx-server-sdk ---------- */
let calls = [];         // 每次 getTempFileURL 收到的 fileList
let shouldFail = false;

const fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'mock-env',
  init() {},
  getTempFileURL({ fileList }) {
    // 真实 API 两种入参都支持：字符串，或 { fileID, maxAge }
    const ids = fileList.map((f) => (typeof f === 'string' ? f : f.fileID));
    calls.push(ids.slice());
    if (shouldFail) return Promise.reject(new Error('mock 网络失败'));
    return Promise.resolve({
      fileList: ids.map((id) => ({ fileID: id, tempFileURL: 'https://cdn.example.com/' + String(id).split('/').slice(3).join('/') + '?sign=mock', status: 0 }))
    });
  }
};

const origLoad = Module._load;
Module._load = function (r) {
  if (r === 'wx-server-sdk') return fakeSdk;
  return origLoad.apply(this, arguments);
};

const sign = require(SIGN);

(async () => {
  /* ---------- A. 覆盖 ---------- */
  console.log('=== A. 该换的换、不该动的不动 ===');
  const input = {
    list: [
      { id: 1, cover: '/static/img/p01.jpg', seller: { avatar: '/static/avatars/a04.jpg' } },
      { id: 2, cover: 'cloud://mock-env.636c-x-1/campus/uploads/abc.jpg' },
      { id: 3, cover: 'https://other.example.com/x.jpg' },
      { id: 4, cover: '' },
      { id: 5, cover: 'not-a-path' }
    ],
    note: '纯文本'
  };
  const out = await sign.resolve(input);
  const c0 = out.list[0].cover;
  if (/^https:\/\/cdn\.example\.com\/static\/img\/p01\.jpg\?sign=mock$/.test(c0)) ok('/static/ 相对路径 → 签名 https（' + c0 + '）');
  else no('/static/ 没有被正确签名：' + c0);
  if (/^https:\/\//.test(out.list[0].seller.avatar)) ok('嵌套的头像也被签名（seller.avatar）');
  else no('嵌套字段漏了：' + out.list[0].seller.avatar);
  if (/^https:\/\//.test(out.list[1].cover)) ok('cloud:// fileID → 签名 https');
  else no('cloud:// 没有被签名：' + out.list[1].cover);
  if (out.list[2].cover === 'https://other.example.com/x.jpg') ok('已有 https 链接原样保留（不重复签名）');
  else no('外部 https 被改坏了：' + out.list[2].cover);
  if (out.list[3].cover === '' && out.list[4].cover === 'not-a-path') ok('空串与非路径字符串不受影响');
  else no('普通字符串被改坏了');
  if (out.note === '纯文本') ok('普通文本字段不受影响');

  /* ---------- B. ★ 绝不原地修改 ---------- */
  console.log('\n=== B. ★ 入参绝不能被原地修改（否则会把签名链接写进内存库）===');
  // 模拟「接口直接返回内存库里的对象引用」
  const inMemory = { id: 7, images: ['/static/img/p02.jpg'], title: '内存里的商品' };
  const res2 = await sign.resolve({ list: [inMemory] });
  if (inMemory.images[0] === '/static/img/p02.jpg') ok('★ 原对象里的图片路径**没有被改写**（内存库安全）');
  else no('★ 原对象被原地改成了 ' + inMemory.images[0] + '　⇒ 会被 flush 落库，原图路径永久损坏');
  if (/^https:\/\//.test(res2.list[0].images[0])) ok('返回给前端的是新对象，里面已是签名链接');
  else no('返回值里没有被签名：' + res2.list[0].images[0]);
  if (res2.list[0] !== inMemory) ok('返回的是副本（引用不同）');
  else no('返回的还是同一个对象引用');

  // 反向对照：故意写一个「原地改」的版本，确认上面那条断言真的能抓到问题
  const buggyInPlace = (node, map) => {
    if (typeof node === 'string') return map[node] || node;
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) node[i] = buggyInPlace(node[i], map); return node; }
    if (!node || typeof node !== 'object') return node;
    for (const k of Object.keys(node)) node[k] = buggyInPlace(node[k], map);
    return node;
  };
  const victim = { images: ['/static/img/p03.jpg'] };
  buggyInPlace(victim, { '/static/img/p03.jpg': 'https://signed' });
  if (victim.images[0] === 'https://signed') ok('反向对照：原地改的写法**确实**会污染原对象 ⇒ 上面那条断言有效（不是空断言）');
  else no('反向对照失败：原地改居然没污染，说明该断言抓不到东西');

  /* ---------- C. 结构安全 ---------- */
  console.log('\n=== C. 特殊类型不被拆坏 ===');
  const d = new Date('2026-10-16T00:00:00Z');
  const raw = {
    createdAt: d,
    buf: Buffer.from('hi'),
    when: { t: '/static/img/p04.jpg' }
  };
  const out3 = await sign.resolve(raw);
  if (out3.createdAt instanceof Date && out3.createdAt.getTime() === d.getTime()) ok('Date 对象原样保留（没被拆成 {}）');
  else no('Date 被改坏了：' + JSON.stringify(out3.createdAt));
  if (Buffer.isBuffer(out3.buf)) ok('Buffer 原样保留');
  else no('Buffer 被改坏了');
  if (/^https:\/\//.test(out3.when.t)) ok('同时仍能把普通字段里的图片签掉');
  else no('普通字段漏签：' + out3.when.t);

  /* ---------- D. 兜底 ---------- */
  console.log('\n=== D. 失败与空转都必须是「原样返回」 ===');
  sign._clearCache();
  calls = [];
  const textOnly = { ok: true, msg: '没有图片' };
  const r4 = await sign.resolve(textOnly);
  if (r4 === textOnly && calls.length === 0) ok('纯文本响应：不发起任何签名调用（零开销）');
  else no('纯文本响应也发起了调用（calls=' + calls.length + '）');

  sign._clearCache();
  shouldFail = true;
  const r5 = await sign.resolve({ cover: '/static/img/p05.jpg' });
  if (r5.cover === '/static/img/p05.jpg') ok('★ 签名失败时原样返回（图片加载不出，但接口不会挂）');
  else no('签名失败时改坏了返回：' + JSON.stringify(r5));
  shouldFail = false;

  /* ---------- E. 批量分片与缓存 ---------- */
  console.log('\n=== E. 批量分片 / 缓存 ===');
  sign._clearCache();
  calls = [];
  const many = { imgs: [] };
  for (let i = 0; i < 120; i++) many.imgs.push('/static/img/x' + i + '.jpg');
  const r6 = await sign.resolve(many);
  const total = calls.reduce((s, c) => s + c.length, 0);
  if (calls.length === 3 && total === 120) ok('120 个文件按 50 一批分成 ' + calls.length + ' 次调用（单次上限 50）');
  else no('分片不对：calls=' + calls.length + ' total=' + total);
  if (r6.imgs.every((u) => /^https:\/\//.test(u))) ok('全部 120 个都被签名');

  calls = [];
  await sign.resolve(many);
  if (calls.length === 0) ok('第二次走缓存，不再重复调用（临时链接有效期以小时计）');
  else no('缓存没生效，又调了 ' + calls.length + ' 次');

  Module._load = origLoad;
  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 私有存储桶下，接口返回的图片都会被换成服务端签发的临时链接；入参不被污染、失败不影响接口'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('运行失败：' + e.stack); process.exit(1); });
