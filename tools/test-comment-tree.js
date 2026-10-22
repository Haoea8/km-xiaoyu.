/**
 * 评论区「小红书式两级结构」回归测试 —— 专治用户反馈的两类现象：
 *
 *   ① 「我回复我那条评论，却还是以一条单独的评论显示」
 *      —— 回复没有缩到被回复者那条评论底下。
 *   ② 「从外面看明明显示有两条评论，进去后却一条都没有」
 *      —— 列表（帖子卡片）上的数字与详情页实际列出的条数对不上。
 *
 * ★ 为什么必须在前端建树（本测试守护的核心设计）：
 *   云函数是**独立部署**的。小程序发了新版、云函数还是旧版时，
 *   旧版 `GET /api/posts/:id` 返回的评论是**平铺**的（没有 replies 字段）。
 *   如果前端只会读 `replies`，界面就退回平铺 —— 而用户完全看不出
 *   原因在「云函数没重新部署」上（这正是 2026-10-16 被反馈的那一轮）。
 *   `util.commentTree()` 接受**两种形态**（两级 / 扁平）并统一重新建树。
 *
 * 反向对照（已验证会变红）：把 commentTree 改成「只读 replies、不按 replyTo 建树」
 * → 第 1 组（旧后端扁平数据）立刻失败。
 *
 * 用法：node tools/test-comment-tree.js   （离线，无需启动服务）
 */
const Module = require('module');
const fs = require('fs');

const ROOT = 'D:/wx/campus-xianyu';
const PAGE = ROOT + '/miniprogram/pages/post-detail/post-detail.js';
const UTIL = ROOT + '/miniprogram/utils/util.js';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };
const eq = (got, want, label) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(label + ' = ' + a);
  else no(label + ' ＝ ' + a + '，期望 ' + b);
};

const util = require(UTIL);
if (typeof util.commentTree !== 'function') {
  console.log('  ❌ utils/util.js 没有导出 commentTree —— 前端无法在旧后端下建两级结构');
  process.exit(1);
}

/* ================= 一、纯函数：util.commentTree ================= */
console.log('=== 1. commentTree：扁平（旧后端）也要能建出两级 ===');
{
  // 旧后端返回的形状：一维数组，回复靠 replyTo 指向父评论
  const flat = [
    { id: 11, content: '妈', author: { id: 5, nickname: '甲' }, createdAt: 100 },
    { id: 12, content: '回你', replyTo: 11, author: { id: 6, nickname: '乙' }, createdAt: 200 }
  ];
  const roots = util.commentTree(flat);
  eq(roots.length, 1, '顶层条数');
  eq(roots[0].id, 11, '顶层是母评论');
  eq((roots[0].replies || []).length, 1, '回复被挂在母评论下');
  eq(roots[0].replies[0].id, 12, '挂上的是那条回复');
  eq(roots[0].replies[0].replyToName, '', '★ 回复**顶层大评论** → 不显示「回复某人」');
  eq(roots.some((c) => c.id === 12), false, '回复**不**再出现在顶层（不会渲染两遍）');
}

console.log('\n=== 1b. 回复**子评论** → 必须显示「回复 某人」 ===');
{
  const roots = util.commentTree([
    { id: 11, content: '妈', author: { id: 5, nickname: '甲' }, createdAt: 100 },
    { id: 12, content: '回你', replyTo: 11, author: { id: 6, nickname: '乙' }, createdAt: 200 },
    { id: 13, content: '回回你', replyTo: 12, author: { id: 7, nickname: '丙' }, createdAt: 300 }
  ]);
  eq(roots.length, 1, '只有 1 个顶层楼');
  eq(roots[0].replies.length, 2, '两条回复都缩在楼下');
  const r12 = roots[0].replies.find((r) => r.id === 12);
  const r13 = roots[0].replies.find((r) => r.id === 13);
  eq(r12.replyToName, '', '12 回的是楼主 → 不显示');
  eq(r13.replyToName, '乙', '★ 13 回的是子评论 → 显示「回复 乙」');
}

console.log('\n=== 1c. 旧后端给所有回复都填了 replyToName → 前端要清掉「回楼主」那种 ===');
{
  // 模拟旧版云函数：replyToName 一律填上
  const roots = util.commentTree([
    { id: 11, content: '妈', author: { id: 5, nickname: '甲' }, createdAt: 100 },
    { id: 12, content: '回你', replyTo: 11, replyToName: '甲', author: { id: 6, nickname: '乙' }, createdAt: 200 },
    { id: 13, content: '回回你', replyTo: 12, replyToName: '乙', author: { id: 7, nickname: '丙' }, createdAt: 300 }
  ]);
  const r12 = roots[0].replies.find((r) => r.id === 12);
  const r13 = roots[0].replies.find((r) => r.id === 13);
  eq(r12.replyToName, '', '回楼主的那条被清空（不能只依赖后端）');
  eq(r13.replyToName, '乙', '回子评论的保留');
}

console.log('\n=== 2. commentTree：两级（新后端）结果必须一致 ===');
{
  const nested = [
    {
      id: 11, content: '妈', author: { id: 5, nickname: '甲' }, createdAt: 100,
      replies: [{ id: 12, content: '回你', replyTo: 11, author: { id: 6, nickname: '乙' }, createdAt: 200 }]
    }
  ];
  const roots = util.commentTree(nested);
  eq(roots.length, 1, '顶层条数');
  eq(roots[0].replies.length, 1, '回复条数');
  eq(roots[0].replies[0].replyToName, '', '回复顶层大评论 → 不显示「回复某人」');
  // 两种形态必须得到**同一个**结构（否则「换了后端界面就变」）
  const flatSame = util.commentTree([
    { id: 11, content: '妈', author: { id: 5, nickname: '甲' }, createdAt: 100 },
    { id: 12, content: '回你', replyTo: 11, author: { id: 6, nickname: '乙' }, createdAt: 200 }
  ]);
  eq(JSON.stringify(roots), JSON.stringify(flatSame), '两种入参形状 → 完全相同的结构');
}

console.log('\n=== 3. commentTree：父评论已被删除时，回复不能丢 ===');
{
  const roots = util.commentTree([
    { id: 12, content: '回你', replyTo: 999, author: { id: 6, nickname: '乙' }, createdAt: 200 }
  ]);
  eq(roots.length, 1, '父评论没了 → 自己成为顶层（宁可位置不理想，也绝不丢弃）');
  eq(roots[0].id, 12, '顶层就是那条回复');
  eq(util.countComments(roots), 1, '计数不为 0');
}

console.log('\n=== 4. commentTree：回复的回复也缩在同一楼下（小红书式，不再分层） ===');
{
  const roots = util.commentTree([
    { id: 1, content: 'A', author: { id: 5, nickname: 'A' }, createdAt: 1 },
    { id: 2, content: 'B', replyTo: 1, author: { id: 6, nickname: 'B' }, createdAt: 2 },
    { id: 3, content: 'C', replyTo: 2, author: { id: 7, nickname: 'C' }, createdAt: 3 }
  ]);
  eq(roots.length, 1, '只有 1 个顶层楼');
  eq(roots[0].replies.map((r) => r.id), [2, 3], '回复的回复也平铺在该楼的 replies 里');
}

/* ================= 二、页面行为：post-detail ================= */
let pageDef = null;
let apiGetImpl = null;
let apiCalls = 0;

global.Page = (opts) => { pageDef = opts; };
global.getApp = () => ({ guard: () => true, openChat() {}, on() {}, off() {} });
global.wx = {
  showToast() {}, showModal() {}, navigateTo() {}, navigateBack() {},
  previewImage() {}, stopPullDownRefresh() {}, showActionSheet() {}
};
const apiMock = {
  abs: (p) => p || '',
  get: (p, d, o) => { apiCalls++; return apiGetImpl(p, d, o); },
  post: async () => ({}),
  del: async () => ({})
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === '../../utils/api') return apiMock;
  return origLoad.apply(this, arguments);
};
require(PAGE);
Module._load = origLoad;

if (!pageDef || typeof pageDef.fetch !== 'function') {
  console.log('  ❌ 没能加载 post-detail 页面定义');
  process.exit(1);
}
const makePage = () => {
  const p = Object.assign({}, pageDef);
  p.data = JSON.parse(JSON.stringify(pageDef.data));
  p.setData = function (patch) { Object.assign(this.data, patch); };
  return p;
};
const post = (extra) => Object.assign({
  id: 1, content: '测试', images: [], topics: [], likeCount: 0, commentCount: 0,
  author: { id: 5, nickname: '甲' }
}, extra || {});

(async () => {
  console.log('\n=== 5. 页面：后端返回**扁平**评论（旧云函数）也要嵌套 ===');
  {
    apiGetImpl = async () => ({
      post: post({ commentCount: 2 }),
      comments: [
        { id: 11, content: '妈', author: { id: 5, nickname: '甲' }, createdAt: 100 },
        { id: 12, content: '回你', replyTo: 11, author: { id: 6, nickname: '乙' }, createdAt: 200 }
      ]
    });
    const p = makePage();
    p.data.id = 1;
    await p.fetch();
    eq(p.data.comments.length, 1, '顶层评论数（回复不在顶层）');
    eq(p.data.comments[0].replies.length, 1, '母评论下的回复数');
    eq(p.data.commentTotal, 2, 'commentTotal（含回复）');
    eq(p.data.comments[0].replies[0].replyToName, '', '回复顶层大评论 → 页面上不显示「回复某人」');
  }

  console.log('\n=== 6. 页面：每条顶层评论默认只露 2 条回复，可展开 ===');
  {
    apiGetImpl = async () => ({
      post: post({ commentCount: 5 }),
      comments: [
        { id: 11, content: '妈', author: { id: 5, nickname: '甲' }, createdAt: 100 },
        { id: 21, content: '回复1', replyTo: 11, author: { id: 6, nickname: '乙' }, createdAt: 201 },
        { id: 22, content: '回复2', replyTo: 11, author: { id: 7, nickname: '丙' }, createdAt: 202 },
        { id: 23, content: '回复3', replyTo: 11, author: { id: 8, nickname: '丁' }, createdAt: 203 }
      ]
    });
    const p = makePage();
    p.data.id = 1;
    await p.fetch();
    eq(p.data.comments[0].visibleReplies.length, 2, '默认露出的回复数');
    eq(p.data.comments[0].hiddenCount, 1, '折叠起来的回复数（「展开 N 条回复」）');
    eq(p.data.commentTotal, 4, 'commentTotal（1 顶层 + 3 回复）');
    p.toggleReplies({ currentTarget: { dataset: { id: 11 } } });
    eq(p.data.comments[0].visibleReplies.length, 3, '展开后全部露出');
    eq(p.data.comments[0].hiddenCount, 0, '展开后没有折叠项');
  }

  console.log('\n=== 7. 页面：外面显示有 N 条、第一次读回来是空的 → 自动重试 ===');
  {
    // 真实场景：列表（帖子卡片）显示 2 条评论，点进详情却是 0 条。
    // 这类「读不完整」重试一次通常就好 —— 但不能让用户看到「0 条」还以为评论被吞了。
    apiCalls = 0;
    apiGetImpl = async () => {
      if (apiCalls === 1) return { post: post({ commentCount: 2 }), comments: [] };
      return {
        post: post({ commentCount: 2 }),
        comments: [
          { id: 11, content: '妈', author: { id: 5, nickname: '甲' }, createdAt: 100 },
          { id: 12, content: '回你', replyTo: 11, author: { id: 6, nickname: '乙' }, createdAt: 200 }
        ]
      };
    };
    const p = makePage();
    p.data.id = 1;
    await p.fetch();
    eq(apiCalls, 2, '确实自动重试了一次');
    eq(p.data.comments.length, 1, '重试后拿到了评论');
    eq(p.data.commentTotal, 2, 'commentTotal 与列出来的条数一致');
    eq(p.data.commentHint, '', '拿到数据后不显示「没能加载出来」');
  }

  console.log('\n=== 8. 页面：重试后仍为空 → 明确提示 + 可点重试（不假装「没人评论」）===');
  {
    apiGetImpl = async () => ({ post: post({ commentCount: 2 }), comments: [] });
    const p = makePage();
    p.data.id = 1;
    await p.fetch();
    if (p.data.commentHint) ok('给出提示：' + p.data.commentHint);
    else no('仍为空却没有任何提示 → 用户会以为评论被吞了');
    eq(p.data.commentTotal, 0, '列不出来就不虚报数字');
  }

  console.log('\n=== 9. 列表与详情必须一致（后端 realCommentCounts 的契约） ===');
  {
    // 详情页的「全部评论（N）」= 实际列出的条数；
    // 列表接口也用同一份真实条数覆盖 commentCount（见 deco.realCommentCounts）。
    // 这里只断言前端侧的口径：N 恒等于「1 + replies」的总和。
    apiGetImpl = async () => ({
      post: post({ commentCount: 999 }),   // 存储字段是脏的
      comments: [
        { id: 1, content: 'A', author: { id: 5, nickname: 'A' }, createdAt: 1 },
        { id: 2, content: 'B', replyTo: 1, author: { id: 6, nickname: 'B' }, createdAt: 2 }
      ]
    });
    const p = makePage();
    p.data.id = 1;
    await p.fetch();
    eq(p.data.commentTotal, 2, '显示的是真实列出的条数（而不是脏的 commentCount=999）');
    eq(p.data.post.commentCount, 2, '回给页面的 post.commentCount 也按真实条数');
  }

  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 评论两级结构正确：回复缩在被回复者楼下、默认露 2 条可展开、数字与列表一致'));
  process.exit(bad ? 1 : 0);
})();
