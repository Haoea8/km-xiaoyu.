/**
 * 发布页「数量 + 单位」与「预设 + 其他」类字段的测试。
 *
 * 覆盖：
 *   · 计价单位 = 数量（用户自己写）+ 单位（只能选）
 *   · 交易地点 = 预设 + 「其他（手动填写）」
 *
 * 计价单位这一格改了两轮，需求最终形态是两段式：
 *
 *     计价单位        [ 2 ] 件 ›
 *                     ↑自己写   ↑只能选（没光标、删不掉、移不动、右端写不了字）
 *
 *   第一轮：原本是自由输入框 —— 谁都能写「asdf」，且清空时 `|| '件'` 会把「件」
 *           写回 data，而 input 绑定 data → 「件」自己冒回来，删不掉。
 *   第二轮：整格换成选择器 —— 但**连数字也写不了**了，而数量要用户自己填。
 *   最终：拆成两段。数量是输入框，单位是选择器；拼接后写进 priceUnit
 *         （「2件」），这样各处现成的 `/{{priceUnit}}` 不用改就显示成「¥20/2件」。
 *
 * 用法：node tools/test-publish-fields.js
 */
const Module = require('module');
const fs = require('fs');

const PUBLISH = 'D:/wx/campus-xianyu/miniprogram/pages/publish/publish.js';
const PUBLISH_WXML = 'D:/wx/campus-xianyu/miniprogram/pages/publish/publish.wxml';
/** 后端上限（cloudfunctions/campus/route-trade.js） */
const BE_LOCATION_MAX = 30;   // clampText(b.location, 30)
const BE_UNIT_MAX = 12;       // clampText(b.priceUnit, 12) ← 拼接后必须不超过它
                              // （原来后端是 4，但那是按「单位文字」定的；
                              //   现在存的是「数量+单位」，必须放宽）

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => realSetTimeout(fn, 0);

/* ---------- mock 依赖 ---------- */
const calls = { post: [], toast: [] };
const appMock = { globalData: { user: { id: 2 } }, guard: () => true, afterLogin() { } };
const apiMock = {
  token: () => 'tok',
  abs: (p) => p || '',
  upload: async (p) => 'cloud://env.bucket/' + p,
  post: async (url, body) => { calls.post.push({ url, body }); return { listing: { id: 99 } }; },
  get: async () => ({})
};
const constMock = {
  ZONES: [{ code: 'idle', name: '二手闲置' }, { code: 'book', name: '教材书籍' }],
  TRADE_MODES: { sell: '出售' }
};

/**
 * 取「真正发布商品」的那次请求。
 *
 * ⚠️ 不能再用 `listingCall()`：2026-10-17 加 AI 审核后，`onSubmit` 会先调
 * `/api/ai/moderate`，于是 post[0] 变成审核请求、body 里没有 priceUnit/location，
 * 断言就集体变成「提交不对：undefined」—— 功能没坏，是**测试的取数口径过期了**。
 * 统一走这个 helper 之后，以后再加前置请求也不会把测试打红。
 */
const listingCall = () => calls.post.filter((c) => c.url === '/api/listings')[0] || null;
const aiModerateCalled = () => calls.post.some((c) => c.url === '/api/ai/moderate');

global.Page = (opts) => { global.__pageDef = opts; };
global.getApp = () => appMock;
global.wx = {
  showToast: (o) => calls.toast.push((o && o.title) || ''),
  showLoading() { }, hideLoading() { },
  chooseMedia() { }, previewImage() { }, redirectTo() { }, navigateBack() { }, showModal() { }
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '../../utils/api') return apiMock;
  if (request === '../../utils/util') return {};
  if (request === '../../utils/const') return constMock;
  return origLoad.apply(this, arguments);
};
require(PUBLISH);
Module._load = origLoad;

const pageDef = global.__pageDef;
if (!pageDef) { console.error('无法加载 publish.js（Page 未被调用）'); process.exit(1); }

function makePage(extra) {
  const inst = {};
  for (const k of Object.keys(pageDef)) inst[k] = pageDef[k];
  inst.data = JSON.parse(JSON.stringify(pageDef.data || {}));
  inst.setData = function (patch) { Object.assign(this.data, patch); };
  Object.assign(inst.data, extra || {});
  return inst;
}
function readyPage(extra) {
  return makePage(Object.assign({ agree: true, title: '测试宝贝', images: ['tmp://a.jpg'], priceYuan: '10' }, extra));
}
const tick = () => new Promise((r) => realSetTimeout(r, 10));
const wxml = () => fs.readFileSync(PUBLISH_WXML, 'utf8');
const wxss = () => fs.readFileSync(PUBLISH.replace(/\.js$/, '.wxss'), 'utf8');

(async () => {
  /* ============================================================
   * 一、计价单位：数量 + 单位
   * ============================================================ */
  console.log('=== 1. 结构：数量是输入框，单位是「只能选」的选择器 ===');
  {
    const src = wxml();
    const i = src.indexOf('计价单位');
    const block = src.slice(Math.max(0, i - 400), i + 900);

    if (/bindinput="onUnitCount"/.test(block) && /type="number"/.test(block)) {
      ok('数量是数字输入框（用户自己写）');
    } else {
      no('没找到数量输入框 —— 用户就写不了个数了');
    }
    if (/<picker[^>]*bindchange="onUnitChange"/.test(block)) ok('单位是 picker（只能选）');
    else no('单位不是 picker');
    if (/class="unit-pick"/.test(block)) ok('单位值走 unit-pick（value 在右端）');
    else no('单位值没有独立的展示节点');
    // 旧的自由文本单位实现必须已移除
    const js = fs.readFileSync(PUBLISH, 'utf8');
    if (!/bindinput="onUnit"/.test(src) && !/onUnit\(e\)/.test(js) && !/priceUnit:\s*'件'/.test(js)) {
      ok('旧的自由文本单位（onUnit / data.priceUnit）已彻底移除');
    } else {
      no('还残留旧的自由文本单位实现');
    }
    if (/\.unit-value\s*\{[^}]*display:\s*flex/.test(wxss())) ok('数量与单位在同一行的 flex 容器里');
    else no('.unit-value 不是 flex 容器');
    // 数量框不能设固定宽度：否则右边空出一大片，用户会觉得「这一格很小 / 有上限」
    // 正则要排除 min-width / max-width（前者会被 `width:\s*\d` 误判）
    const unitCountRule = (wxss().match(/\.unit-count\s*\{[^}]*\}/) || [''])[0];
    const hasFixedWidth = /(^|[;\s])width:\s*\d/.test(unitCountRule);
    if (/flex:\s*1/.test(unitCountRule) && !hasFixedWidth) {
      ok('数量框占满可用空间（flex:1，无固定宽度）');
    } else {
      no('数量框还是固定宽度 —— 右边会空出一片，看着像有上限：' + unitCountRule.trim());
    }
  }

  console.log('\n=== 2. 默认值与拼接规则 ===');
  {
    const p = makePage();
    if (p.currentUnit() === '件') ok('数量留空 → priceUnit = 「件」（不生成「1件」）');
    else no('默认不对：' + JSON.stringify(p.currentUnit()));

    p.onUnitCount({ detail: { value: '1' } });
    if (p.currentUnit() === '件') ok('数量填 1 → 仍是「件」（避免出现「¥20/1件」）');
    else no('数量 1 时不该带数字：' + p.currentUnit());

    p.onUnitCount({ detail: { value: '2' } });
    if (p.currentUnit() === '2件') ok('数量填 2 → 「2件」');
    else no('数量 2 拼接不对：' + p.currentUnit());

    p.onUnitCount({ detail: { value: '99' } });
    if (p.currentUnit() === '99件') ok('数量 99 → 「99件」');
    else no('两位数拼接不对：' + p.currentUnit());

    // 换单位后数字仍生效
    p.onUnitChange({ detail: { value: p.data.units.indexOf('天') } });
    if (p.currentUnit() === '99天') ok('换单位后数量保留 → ' + p.currentUnit());
    else no('换单位后拼接不对：' + p.currentUnit());
  }

  console.log('\n=== 3. 数量：只收数字、不限位数、去掉前导零 ===');
  {
    const p = makePage();
    p.onUnitCount({ detail: { value: 'a3b' } });
    if (p.data.unitCount === '3') ok('字母被过滤：a3b → 3');
    else no('字母没被过滤：' + JSON.stringify(p.data.unitCount));

    p.onUnitCount({ detail: { value: '12345' } });
    if (p.data.unitCount === '12345') ok('不限位数：12345 → 12345（用户明确要求别限件数）');
    else no('被限位了：' + JSON.stringify(p.data.unitCount));

    p.onUnitCount({ detail: { value: '-3' } });
    if (p.data.unitCount === '3') ok('负号被过滤：-3 → 3');
    else no('负号没被过滤：' + JSON.stringify(p.data.unitCount));

    p.onUnitCount({ detail: { value: '' } });
    if (p.data.unitCount === '' && p.currentUnit() === '件') ok('可以清空（清空后回到「件」）');
    else no('清空行为不对：' + JSON.stringify(p.data.unitCount));

    // 前导零 —— 用户专门指出的问题：「你这个 00 都可以，这个肯定不行」
    for (const [input, want] of [['00', ''], ['01', '1'], ['007', '7'], ['000123', '123']]) {
      p.onUnitCount({ detail: { value: input } });
      const label = want === '' ? '空（等同不填 → 件）' : want;
      if (p.data.unitCount === want) ok('前导零去掉：' + input + ' → ' + label);
      else no('前导零没处理：' + input + ' → ' + JSON.stringify(p.data.unitCount));
    }
    // 结尾的 0 不能被误伤
    p.onUnitCount({ detail: { value: '10' } });
    if (p.data.unitCount === '10' && p.currentUnit() === '10件') ok('末尾的 0 不受影响：10 → 10件');
    else no('10 被误处理：' + JSON.stringify(p.data.unitCount));

    // ⚠️ 必须 return：小程序 input 仅在 bindinput **返回字符串**时才用它替换输入框内容。
    // 只 setData 不 return → 数据变了但框里还显示着原始内容（用户截图里就是「00000」）。
    const ret = p.onUnitCount({ detail: { value: '00' } });
    if (ret === '') ok('onUnitCount 返回了处理后的值（否则输入框不刷新，会残留 00000）');
    else no('onUnitCount 没返回值：' + JSON.stringify(ret) + ' → 输入框会残留用户原始输入');
    for (const v of ['007', 'a3b', '12345', '10']) {
      const r = p.onUnitCount({ detail: { value: v } });
      if (r === p.data.unitCount && typeof r === 'string') {
        ok('返回值与数据一致：' + v + ' → ' + JSON.stringify(r));
      } else {
        no(v + ' 的返回值与数据不一致：返回值 ' + JSON.stringify(r) + '，数据 ' + JSON.stringify(p.data.unitCount));
      }
    }
  }

  console.log('\n=== 4. 长度：前端不限件数，但拼接后不能超后端（超了要提示，不能静默截断）===');
  {
    const p = makePage();
    p.onUnitCount({ detail: { value: '9'.repeat(6) } });
    p.onUnitChange({ detail: { value: p.data.units.indexOf('小时') } });
    const v = p.currentUnit();
    if (v.length <= BE_UNIT_MAX) ok('6 位数量 + 「小时」= ' + v + '（' + v.length + ' 字），仍在后端 ' + BE_UNIT_MAX + ' 字内');
    else no('超了后端上限：' + v);

    const q = makePage();
    if (q.data.unitMax === 4) ok('单位文字上限 4 字');
    else no('unitMax = ' + q.data.unitMax);
    if (!/maxlength="\{\{unitCountMax\}\}"/.test(wxml()) && !/unitCountMax/.test(fs.readFileSync(PUBLISH, 'utf8'))) {
      ok('数量输入框已无 maxlength，代码里也没有残留（不限制件数）');
    } else {
      no('数量还带着 maxlength / 残留字段');
    }

    // 极端超长 → 明确提示，不静默截断
    calls.post = []; calls.toast = [];
    const r = readyPage();
    r.onUnitCount({ detail: { value: '9'.repeat(20) } });
    await r.onSubmit(); await tick();
    if (!listingCall() && calls.toast.some((t) => /太长/.test(t))) {
      ok('极端超长 → 拦住并提示：' + calls.toast.find((t) => /太长/.test(t)));
    } else {
      no('极端超长没被拦住（会被后端静默截断）');
    }
  }

  console.log('\n=== 5. 计价单位「其他」：只填单位文字 ===');
  {
    const p = makePage();
    p.onUnitChange({ detail: { value: p.data.units.length - 1 } });
    if (p.data.isOtherUnit === true) ok('选中「其他」→ 展开输入框');
    else no('没有展开');
    p.onUnitOther({ detail: { value: '  打  ' } });
    if (p.currentUnitText() === '打') ok('单位文字已 trim：' + p.currentUnitText());
    else no('没 trim');
    p.onUnitCount({ detail: { value: '3' } });
    if (p.currentUnit() === '3打') ok('自定义单位也参与拼接 → ' + p.currentUnit());
    else no('自定义单位拼接不对：' + p.currentUnit());
  }

  console.log('\n=== 6. 计价单位提交 ===');
  {
    calls.post = []; calls.toast = [];
    const p = readyPage();
    await p.onSubmit(); await tick();
    if (listingCall() && listingCall().body.priceUnit === '件') ok('不动它 → priceUnit = 件（老行为不变）');
    else no('默认提交不对：' + (listingCall() ? JSON.stringify(listingCall().body.priceUnit) : '没请求'));
    // 提交前必须过一道 AI 审核（哪怕是静默的）；这条防「以后重构把审核绕过」
    if (aiModerateCalled()) ok('提交前调用了 /api/ai/moderate');
    else no('提交前没有调用 AI 审核');

    calls.post = [];
    const q = readyPage();
    q.onUnitCount({ detail: { value: '2' } });
    q.onUnitChange({ detail: { value: q.data.units.indexOf('天') } });
    await q.onSubmit(); await tick();
    if (listingCall() && listingCall().body.priceUnit === '2天') ok('数量 2 + 天 → priceUnit = 2天');
    else no('提交不对：' + (listingCall() ? JSON.stringify(listingCall().body.priceUnit) : '没请求'));

    calls.post = []; calls.toast = [];
    const r = readyPage();
    r.onUnitChange({ detail: { value: r.data.units.length - 1 } });
    await r.onSubmit(); await tick();
    if (!listingCall() && calls.toast.some((t) => /计价单位/.test(t))) ok('「其他」+ 单位空 → 拦住：' + calls.toast.find((t) => /计价单位/.test(t)));
    else no('单位空没有被拦住');

    calls.post = []; calls.toast = [];
    const s = readyPage();
    s.onUnitChange({ detail: { value: s.data.units.length - 1 } });
    s.onUnitOther({ detail: { value: '2个' } });
    await s.onSubmit(); await tick();
    if (!listingCall() && calls.toast.some((t) => /数字/.test(t))) ok('单位文字里写数字 → 拦住：' + calls.toast.find((t) => /数字/.test(t)));
    else no('单位文字里的数字没被拦住');
  }

  /* ============================================================
   * 二、交易地点
   * ============================================================ */
  console.log('\n=== 7. 交易地点：选项与展开 ===');
  {
    const p = makePage();
    const list = p.data.locations;
    if (list[list.length - 1].indexOf('其他') > -1) ok('最后一项是「' + list[list.length - 1] + '」');
    else no('最后一项不是「其他」');
    const preset = list.slice(0, -1);
    if (preset.indexOf('学生宿舍区') > -1 && preset.indexOf('线上交易') > -1) ok('原来的预设地点都还在（' + preset.length + ' 个）');
    else no('预设地点被改动过');

    p.onLocationChange({ detail: { value: list.length - 1 } });
    if (p.data.isOtherLocation === true) ok('选中「其他」→ 展开输入框');
    else no('没有展开');
    p.onLocationChange({ detail: { value: 2 } });
    if (p.data.isOtherLocation === false && p.currentLocation() === list[2]) ok('切回预设 → 收起并取预设值');
    else no('切回预设后状态不对');
    if (/wx:if="\{\{isOtherLocation\}\}"/.test(wxml()) && /bindinput="onLocationOther"/.test(wxml())) ok('wxml 有条件输入框并绑定了事件');
    else no('wxml 没找到条件输入框');
  }

  console.log('\n=== 8. 交易地点：取值与提交 ===');
  {
    const p = makePage();
    p.onLocationChange({ detail: { value: p.data.locations.length - 1 } });
    p.onLocationOther({ detail: { value: '  3 号宿舍楼下 快递柜旁  ' } });
    if (p.currentLocation() === '3 号宿舍楼下 快递柜旁') ok('手填已 trim：' + p.currentLocation());
    else no('没 trim');
    p.onLocationOther({ detail: { value: '   ' } });
    if (p.currentLocation() === '') ok('只输空格视为空');
    else no('只输空格没被视为空');

    calls.post = []; calls.toast = [];
    const a = readyPage();
    a.onLocationChange({ detail: { value: a.data.locations.length - 1 } });
    await a.onSubmit(); await tick();
    if (!listingCall() && calls.toast.some((t) => /交易地点/.test(t))) ok('「其他」+ 空 → 拦住并提示');
    else no('空地点没有被拦住');

    calls.post = [];
    const b = readyPage();
    b.onLocationChange({ detail: { value: b.data.locations.length - 1 } });
    b.onLocationOther({ detail: { value: '3 号宿舍楼下快递柜旁' } });
    await b.onSubmit(); await tick();
    if (listingCall() && listingCall().body.location === '3 号宿舍楼下快递柜旁') ok('提交 location = ' + listingCall().body.location);
    else no('提交的 location 不对');

    calls.post = [];
    const c = readyPage();
    c.onLocationChange({ detail: { value: 3 } });
    await c.onSubmit(); await tick();
    if (listingCall() && listingCall().body.location === c.data.locations[3]) ok('预设地点 → ' + listingCall().body.location + '（老行为不变）');
    else no('预设地点的老行为被破坏');

    if (makePage().data.locationMax === BE_LOCATION_MAX) ok('locationMax = ' + BE_LOCATION_MAX + '，与后端一致');
    else no('locationMax 与后端不一致');
  }

  global.setTimeout = realSetTimeout;
  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 数量可自己写、单位只能选；价格单位与地点都与后端上限一致'));
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  global.setTimeout = realSetTimeout;
  console.error('测试崩溃:', e);
  process.exit(1);
});
