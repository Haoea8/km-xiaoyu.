/**
 * 公告交互回归测试。
 *
 * 真实问题（两轮）：
 *   ① 首页那条公告点下去是 `wx.switchTab` 到**校园圈子** —— 公告和圈子毫无关系，
 *      用户点「公告」却跳进圈子，公告正文根本看不到。
 *   ② 改成「跳公告详情页」后，用户明确反馈：**「公告点进去弹个窗显示就好了，为什么要跳转」**。
 *      → 最终形态：点横幅**弹窗**显示正文，不跳页。
 *
 * 弹窗方案的额外好处：正文随 `/api/home` 整条下发，
 * **不需要新接口**，所以不受「云函数是否已部署」影响（只上传小程序就生效）。
 *
 * 本测试守三件事：
 *   A) 接口：`GET /api/home` 的 notice **带 content**（弹窗才有正文可显示）
 *   B) 接线：首页公告绑的是 `openNotice`（弹窗），**不是** goCircle、**也不是** navigateTo
 *   C) 弹窗本体：wxml 里有遮罩层、能关闭，关闭方法存在
 *
 * 用法：node tools/test-notice-detail.js   （离线）
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/wx/campus-xianyu';
const FN = ROOT + '/cloudfunctions/campus';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/* ---------- mock 云数据库 ---------- */
const store = {};
const col = (n) => (store[n] = store[n] || {});
const copy = (d) => JSON.parse(JSON.stringify(d));
function makeCollection(name) {
  return {
    doc(id) {
      return {
        set({ data }) { col(name)[String(id)] = Object.assign({ _id: String(id) }, copy(data)); return Promise.resolve({}); },
        get() { const d = col(name)[String(id)]; return d ? Promise.resolve({ data: copy(d) }) : Promise.reject(new Error('not found')); },
        remove() { delete col(name)[String(id)]; return Promise.resolve({}); }
      };
    },
    where(cond) {
      const match = (d) => Object.keys(cond || {}).every((k) => d[k] === cond[k]);
      const q = { limit() { return q; }, skip() { return q; }, get() { return Promise.resolve({ data: Object.values(col(name)).filter(match).map(copy) }); } };
      return q;
    },
    limit() { return { skip() { return this; }, get: () => Promise.resolve({ data: Object.values(col(name)).map(copy) }) }; },
    skip() { return this; },
    get() { return Promise.resolve({ data: Object.values(col(name)).map(copy) }); }
  };
}
const fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'mock', init() { }, getWXContext: () => ({}),
  database: () => ({ collection: makeCollection, createCollection(n) { col(n); return Promise.resolve({}); } })
};
const origLoad = Module._load;
Module._load = function (r) { if (r === 'wx-server-sdk') return fakeSdk; return origLoad.apply(this, arguments); };

(async () => {
  const app = require(FN + '/index.js');
  for (let i = 0; i < 40; i++) {
    const r = await app.main({ path: '/api/_setup', method: 'POST', data: {} });
    if (r.data && r.data.done) break;
  }

  console.log('=== A. 公告数据（弹窗要有正文可显示） ===');
  const home = await app.main({ path: '/api/home', method: 'GET', data: {} });
  const notice = home.data && home.data.notice;
  if (notice) ok('首页接口带回公告（#' + notice.id + '「' + String(notice.title).slice(0, 16) + '」）');
  else no('首页接口没有公告 —— 横幅和弹窗都无从显示');
  if (notice && String(notice.content || '').length > 5) {
    ok('★ 带正文（' + String(notice.content).length + ' 字）→ 弹窗能直接显示，**无需额外接口**');
  } else no('★ 公告没带 content → 弹窗会是空的（这正是要保证的点）');

  const list = await app.main({ path: '/api/notices', method: 'GET', data: {} });
  if (((list.data && list.data.list) || []).length) ok('公告列表仍可取（后台管理用）');

  console.log('\n=== B. 首页接线（弹窗，不跳转） ===');
  const wxml = fs.readFileSync(ROOT + '/miniprogram/pages/index/index.wxml', 'utf8');
  const m = wxml.match(/<view[^>]*class="notice"[^>]*>/);
  if (!m) no('找不到首页公告节点');
  else {
    const tag = m[0];
    if (/goCircle/.test(tag)) no('★ 公告仍绑在 goCircle（点公告跳校园圈子）');
    else ok('公告不再绑定 goCircle');
    if (/bindtap="openNotice"/.test(tag)) ok('公告绑定 openNotice → 弹窗显示');
    else no('公告没有绑定 openNotice（' + tag.slice(0, 90) + '）');
    if (/navigateTo|goNotice/.test(tag)) no('★ 公告仍在做页面跳转（用户要求：弹窗即可，别跳转）');
    else ok('★ 公告**不再跳转页面**（符合用户要求）');
  }

  const idxJs = fs.readFileSync(ROOT + '/miniprogram/pages/index/index.js', 'utf8');
  if (/openNotice\s*\(/.test(idxJs)) ok('index.js 定义了 openNotice');
  else no('index.js 缺 openNotice（wxml 绑了但方法不存在 = 点了没反应）');
  if (/closeNoticePopup\s*\(/.test(idxJs)) ok('index.js 定义了 closeNoticePopup');
  else no('index.js 缺 closeNoticePopup（弹窗关不掉）');
  if (/noticeOpen/.test(idxJs) && /noticeOpen:\s*false/.test(idxJs)) ok('data 里有 noticeOpen 状态');
  else no('data 里没有 noticeOpen（弹窗无法控制显隐）');
  if (/navigateTo\([^)]*notice-detail/.test(idxJs)) no('★ 仍在跳转公告详情页');
  else ok('不再跳转公告详情页');

  console.log('\n=== C. 弹窗本体（遮罩 + 关闭 + 可滚动正文） ===');
  const mask = wxml.match(/<view[^>]*class="np-mask"[^>]*>/);
  if (mask) ok('wxml 里有弹窗遮罩层（np-mask）');
  else no('wxml 缺少弹窗遮罩层');
  if (mask && /catchtap="closeNoticePopup"/.test(mask[0])) ok('点遮罩可关闭');
  else no('点遮罩没有关闭逻辑（用户会卡在弹窗里）');
  if (/closeNoticePopup/.test(wxml)) ok('弹窗内有明确的关闭入口');
  else no('弹窗没有关闭入口');
  // 长公告要能滚：用 scroll-view 而不是固定高度（wx.showModal 会截断，所以自定义）
  if (/np-body/.test(wxml) && /scroll-y/.test(wxml)) ok('正文用 scroll-view 可滚动（长公告不会看不全）');
  else no('正文不可滚动 → 长公告会被截断');

  Module._load = origLoad;
  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 点首页公告弹窗显示正文（不跳转），正文随首页接口带回、无需额外接口'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('运行失败：' + e.stack); process.exit(1); });
