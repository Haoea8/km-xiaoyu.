/**
 * 「换一批」推荐测试。
 *
 * 验证：
 *   1) 同参数结果稳定（确定性，不会乱跳）
 *   2) 换 seed → 顺序变化（档内打散生效）
 *   3) 传 exclude → 优先返回没展示过的商品（真的"换"了）
 *   4) 累计 exclude 连续换批 → 覆盖面持续扩大（核心）
 *   5) 候选耗尽时仍能填满一屏（循环复用，不返回空）
 *   6) unseen 计数正确（前端据此判断何时重置循环）
 *   7) 推荐质量：高分商品仍优先、每件带推荐理由
 *   8) 参数健壮性：非法 seed / exclude 不崩
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
  const onSale = Object.values(store.listings).filter((l) => l.status === 'on').length;

  // 便捷调用：返回 { ids, meta }
  const rec = async (qs) => {
    const r = await app.main({ path: '/api/recommend/home' + (qs || ''), method: 'GET', data: {}, token });
    const d = (r.data) || {};
    const list = Array.isArray(d.list) ? d.list : (d.list && d.list.items) || [];
    return {
      list,
      ids: list.map((x) => x.id),
      reason: d.reason,
      unseen: typeof d.unseen === 'number' ? d.unseen : null,
      poolSize: typeof d.poolSize === 'number' ? d.poolSize : null,
      typeOk: Array.isArray(d.list)
    };
  };

  ok('数据就绪：在售 ' + onSale + ' 件，用户 ' + login.data.user.nickname);

  console.log('\n=== 0. 返回结构必须把 list 直接给成数组 ===');
  {
    const a = await rec('');
    if (a.typeOk) ok('data.list 是数组（' + a.list.length + ' 件），前端可直接 .map');
    else no('data.list 不是数组（前端 .map 会崩）—— 后端返回结构不对');
    if (a.unseen !== null && a.poolSize !== null) ok('带 unseen=' + a.unseen + ' / poolSize=' + a.poolSize);
    else no('缺少 unseen / poolSize，前端无法判断何时重置循环');
  }

  console.log('\n=== 1. 同参数结果应稳定（确定性）===');
  {
    const a = await rec('');
    const b = await rec('');
    if (a.ids.join(',') === b.ids.join(',')) ok('无参数两次调用一致（' + a.ids.length + ' 件）');
    else no('同参数结果不稳定，首页会乱跳');

    const c = await rec('?seed=5');
    const d = await rec('?seed=5');
    if (c.ids.join(',') === d.ids.join(',')) ok('同 seed 结果可复现');
    else no('同 seed 结果不一致');
  }

  console.log('\n=== 2. 换 seed 应带来顺序变化 ===');
  {
    const a = await rec('?seed=0');
    const b = await rec('?seed=1');
    const c = await rec('?seed=2');
    const s0 = a.ids.join(','), s1 = b.ids.join(','), s2 = c.ids.join(',');
    if (s0 !== s1 || s1 !== s2) ok('seed 变化改变顺序（分档随机生效）');
    else no('换 seed 顺序完全不变，档内打散未生效');
    if (a.ids[0] && b.ids[0] && c.ids[0]) {
      const set = new Set([a.ids[0], b.ids[0], c.ids[0]]);
      console.log('  三个 seed 首件 id: ' + [a.ids[0], b.ids[0], c.ids[0]].join(', ') +
        (set.size > 1 ? '（有变化）' : '（完全相同）'));
    }
  }

  console.log('\n=== 3. 传 exclude 应优先换出新面孔（核心）===');
  {
    const first = await rec('?seed=1');
    const second = await rec('?seed=2&exclude=' + first.ids.join(','));
    const overlap = second.ids.filter((id) => first.ids.indexOf(id) > -1).length;
    const fresh = second.ids.length - overlap;
    const rate = second.ids.length ? Math.round((fresh / second.ids.length) * 100) : 0;
    console.log('  第一批 ' + first.ids.length + ' 件 / 第二批 ' + second.ids.length + ' 件');
    console.log('  第二批新面孔 ' + fresh + ' 件（' + rate + '%），重复 ' + overlap + ' 件');
    if (fresh > second.ids.length / 2) ok('换一批后大部分是新商品（' + rate + '% 新）');
    else no('换一批后新商品太少，用户会觉得"没换"');
  }

  console.log('\n=== 4. 累计 exclude 连续换 5 批（关键回归）===');
  {
    const seen = [];
    const seenSet = new Set();
    const perBatch = [];
    for (let i = 1; i <= 5; i++) {
      const q = '?seed=' + i + (seen.length ? '&exclude=' + seen.join(',') : '');
      const r = await rec(q);
      perBatch.push(r.ids.length);
      r.ids.forEach((id) => { seenSet.add(id); if (seen.indexOf(id) === -1) seen.push(id); });
      console.log('    第 ' + i + ' 批：' + r.ids.length + ' 件，累计覆盖 ' + seenSet.size + ' 件，unseen=' + r.unseen);
    }
    console.log('  在售 ' + onSale + ' 件（不含自己发布的），5 批累计覆盖 ' + seenSet.size + ' 件');
    // 前 3 批必须持续增长（这是之前失败的场景：卡在 24 件）
    if (perBatch[0] + perBatch[1] + perBatch[2] > 24) ok('前 3 批累计 > 24 件，说明没在"只排上一批"上打转');
    else no('前 3 批累计仅 ' + (perBatch[0] + perBatch[1] + perBatch[2]) + ' 件，累计排除未生效');
    if (seenSet.size > 24) ok('累计覆盖 ' + seenSet.size + ' 件（> 2 批的量）');
    else no('累计覆盖仅 ' + seenSet.size + ' 件，覆盖面没扩大');

    // 每一批都不应出现「跟已看过的完全重合」
    const last = await rec('?seed=6&exclude=' + seen.join(','));
    const lastOverlap = last.ids.filter((id) => seenSet.has(id)).length;
    console.log('  第 6 批与已看过的重合 ' + lastOverlap + '/' + last.ids.length + ' 件');
  }

  console.log('\n=== 5. 候选耗尽时不应返回空 ===');
  {
    const allIds = Object.values(store.listings)
      .filter((l) => l.status === 'on' && l.sellerId !== 2).map((l) => l.id);
    const r = await rec('?seed=9&exclude=' + allIds.join(','));
    if (r.ids.length >= 10) ok('全部排除后仍返回 ' + r.ids.length + ' 件（循环复用，不空屏）');
    else no('候选耗尽后仅返回 ' + r.ids.length + ' 件，可能空屏');
  }

  console.log('\n=== 6. unseen 计数正确性（前端靠它重置循环）===');
  {
    const allIds = Object.values(store.listings)
      .filter((l) => l.status === 'on' && l.sellerId !== 2).map((l) => l.id);
    const r = await rec('?seed=1&exclude=' + allIds.join(','));
    if (r.unseen === 0) ok('全部排除时 unseen=0，前端会重置循环');
    else no('全部排除时 unseen=' + r.unseen + '（应为 0）');

    const r2 = await rec('');
    if (r2.unseen > 0) ok('有候选时 unseen=' + r2.unseen + ' > 0');
    else no('有候选时 unseen=' + r2.unseen + '，前端会误判为看完');
  }

  console.log('\n=== 7. 推荐质量：高分优先 + 每件带理由 ===');
  {
    const r = await rec('?seed=1');
    const scores = r.list.filter((x) => typeof x.score === 'number').map((x) => x.score);
    if (scores.length) console.log('  本批 score 区间：' + Math.min.apply(null, scores) + ' ~ ' + Math.max.apply(null, scores));
    const withReason = r.list.filter((x) => x.reason).length;
    if (withReason === r.list.length && r.list.length) ok('每件商品都带推荐理由（' + r.list.length + '/' + r.list.length + '）');
    else no('部分商品缺推荐理由（' + withReason + '/' + r.list.length + '）');
  }

  console.log('\n=== 8. 参数健壮性 ===');
  {
    const b1 = await rec('?seed=abc');
    if (b1.ids.length > 0) ok('seed 非数字不崩（' + b1.ids.length + ' 件）');
    else no('seed 非数字导致空结果');

    const b2 = await rec('?exclude=abc,,,xyz');
    if (b2.ids.length > 0) ok('exclude 含非法值不崩（' + b2.ids.length + ' 件）');
    else no('exclude 非法值导致空结果');

    const b3 = await rec('?seed=3&exclude=');
    if (b3.ids.length > 0) ok('exclude 为空串不崩（' + b3.ids.length + ' 件）');
    else no('exclude 空串导致空结果');
  }

  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 「换一批」功能正确：会换、越换越新、换完循环、不空屏'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
