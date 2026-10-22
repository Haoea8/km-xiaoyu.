/**
 * 「换一批」交互流程仿真。
 *
 * 严格复刻 miniprogram/pages/index/index.js 里
 * loadRecommend / fetchRecommend / refreshRecommend 的状态机，
 * 对真实云函数逻辑连续点 8 次「换一批」，验证：
 *   1) 第一批正常出 12 件
 *   2) 连点过程中每一批都和上一批明显不同（不是"点了没反应"）
 *   3) 累计能看到池子里几乎所有商品
 *   4) 看完一轮后自动重置循环（不会永远卡在同一批）
 *   5) 任何一次都不会返回空列表
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
        get() { const d = col(name)[String(id)]; return d ? Promise.resolve({ data: d }) : Promise.reject(new Error('x')); },
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

  for (let i = 0; i < 40; i++) {
    const r = await app.main({ path: '/api/_setup', method: 'POST', data: {} });
    if (r.data && r.data.done) break;
  }
  const login = await app.main({ path: '/api/login', method: 'POST', data: { testUserId: 2 } });
  const token = login.data.token;

  // ---------- 前端状态机（与 index.js 保持一致）----------
  const st = { recSeed: 0, recSeen: [], recUnseen: 0, recList: [] };
  const toasts = [];

  async function fetchRecommend(seed, seen, silent) {
    const q = [];
    if (seed) q.push('seed=' + seed);
    if (seen && seen.length) q.push('exclude=' + seen.join(','));
    const url = '/api/recommend/home' + (q.length ? '?' + q.join('&') : '');
    const r = await app.main({ path: url, method: 'GET', data: {}, token });
    const d = r.data || {};
    st.recList = Array.isArray(d.list) ? d.list : ((d.list && d.list.items) || []);
    st.recUnseen = typeof d.unseen === 'number' ? d.unseen : 0;
    return st.recList;
  }

  function loadRecommend(resetSeen) {
    const seed = resetSeen ? 0 : (st.recSeed || 0);
    const seen = resetSeen ? [] : (st.recSeen || []);
    if (resetSeen) { st.recSeed = 0; st.recSeen = []; }
    return fetchRecommend(seed, seen, true);
  }

  async function refreshRecommend() {
    const prev = (st.recList || []).map((x) => x.id).filter(Boolean);
    const prevKey = prev.join(',');
    const seen = st.recSeen || [];
    const exhausted = prev.length > 0 && st.recUnseen < Math.ceil(prev.length / 2);
    const nextSeen = exhausted ? prev : seen.concat(prev.filter((id) => seen.indexOf(id) === -1));
    const nextSeed = (st.recSeed || 0) + 1;

    st.recSeed = nextSeed;
    st.recSeen = nextSeen;
    toasts.push(exhausted ? '已看完全部，重新为你推荐' : '正在换一批');

    await fetchRecommend(nextSeed, nextSeen, true);

    const nowKey = (st.recList || []).map((x) => x.id).join(',');
    if (!exhausted && nowKey && nowKey === prevKey) toasts.push('推荐就这么多啦，稍后再来');
    return { exhausted, prev, now: (st.recList || []).map((x) => x.id) };
  }
  // -------------------------------------------------------

  console.log('=== 第一批（进入首页）===');
  const first = await loadRecommend(true);
  const firstIds = first.map((x) => x.id);
  console.log('  首批 ' + firstIds.length + ' 件，unseen=' + st.recUnseen);
  if (firstIds.length === 12) ok('首批 12 件');
  else no('首批 ' + firstIds.length + ' 件（期望 12）');

  console.log('\n=== 连续点 8 次「换一批」===');
  const batches = [firstIds];
  const seenAll = new Set(firstIds);
  const overlaps = [];
  let resets = 0;

  for (let i = 1; i <= 8; i++) {
    const r = await refreshRecommend();
    const overlap = r.now.filter((id) => r.prev.indexOf(id) > -1).length;
    const freshVsAll = r.now.filter((id) => !seenAll.has(id)).length;
    r.now.forEach((id) => seenAll.add(id));
    batches.push(r.now);
    overlaps.push({ exhausted: r.exhausted, overlap });

    if (r.exhausted) resets++;

    console.log('  第 ' + (i + 1) + ' 批：' + r.now.length + ' 件' +
      ' | 与上批重复 ' + overlap + '/12' +
      ' | 全新 ' + freshVsAll + ' 件' +
      ' | 累计 ' + seenAll.size + ' 件' +
      ' | unseen=' + st.recUnseen +
      (r.exhausted ? '  ⟲ 已重置循环' : ''));

    if (r.now.length === 0) no('第 ' + (i + 1) + ' 批返回空列表！');
    // 未重置时，不该和上一批完全一样
    if (!r.exhausted && r.now.join(',') === r.prev.join(',')) {
      no('第 ' + (i + 1) + ' 批与上一批完全相同（用户会觉得"点了没反应"）');
    }
  }

  console.log();
  if (resets > 0) ok('出现了 ' + resets + ' 次自动重置循环（看完一轮后会重来）');
  else no('连续 8 次都没有触发重置，池子看完后会卡死');
  if (seenAll.size >= 30) ok('累计看到 ' + seenAll.size + ' 件不同商品（池子约 ' + (firstIds.length + 27) + ' 件）');
  else no('累计只看到 ' + seenAll.size + ' 件，覆盖面偏小');

  // 每次「重置循环」的那一批，必须和上一批重叠很小 —— 否则用户点了还是看到同一屏
  const resetBatches = overlaps.filter((o) => o.exhausted);
  if (!resetBatches.length) no('没有出现重置循环的批次');
  else {
    const worst = Math.max.apply(null, resetBatches.map((o) => o.overlap));
    if (worst <= 2) ok('重置循环后的那一批与上批重叠 ≤ ' + worst + '/12（换出来是全新一屏）');
    else no('重置后仍与上批重叠 ' + worst + '/12，用户会觉得"没换"');
  }
  // 非重置批次也不该大面积重复
  const normal = overlaps.filter((o) => !o.exhausted);
  const worstNormal = normal.length ? Math.max.apply(null, normal.map((o) => o.overlap)) : 0;
  if (worstNormal <= 2) ok('所有常规「换一批」与上批重叠 ≤ ' + worstNormal + '/12');
  else no('常规换批出现 ' + worstNormal + '/12 重复，体验会变差');

  console.log('\n=== 提示文案 ===');
  console.log('  ' + toasts.join('\n  '));

  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 交互流程正确：点「换一批」真的会换，看完自动循环，从不空屏'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('仿真崩溃:', e); process.exit(1); });
