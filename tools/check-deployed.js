/**
 * 「线上云函数 vs 本地代码」版本体检（**只读**，不写任何数据）。
 *
 * 为什么需要它：小程序前端和云函数是**两套独立发布**的东西。
 * 前端点「上传」更新了体验版，云函数没重新部署时，
 * 云端跑的还是旧逻辑 —— 用户看到的就还是旧行为，
 * 而这一点**从界面上完全看不出来**。
 *
 * 真实事故（2026-10-16）：评论的两级结构（回复缩在被回复者底下）在前端已生效，
 * 但云函数没部署 → 旧版返回扁平的评论 → 「回复别人的评论」仍然显示成单独一条；
 * 同一个帖子还会「外面显示 2 条、进去 0 条」（旧版的评论读取路径看不到另一些评论）。
 *
 * 原理：用 `server/.cloudbase.json` 里的 API Key 直接调**线上已部署的云函数**
 *      （CloudBase HTTP API，见 server/src/cloud.js），
 *      对比它返回的**字段与行为**跟本地代码是否一致。
 *
 * 判据（按本地代码的演进）：
 *   ① `GET /api/posts/:id` 是否返回 `commentTotal`
 *      —— 本地在「两级评论」那次改动里开始返回，**没有就是旧版**。
 *   ② 评论里是否有 `replyToName`（更早一轮加的）。
 *   ③ 「列表上的评论数」与「详情实际列出的条数」是否一致
 *      —— 本地已改为从 comments 集合重新推导；旧版会不一致。
 *   ④ 图片是不是**服务端签发的临时 https 链接**
 *      —— 存储桶是私有的（2026-10-16 实测：tcb.qcloud.la 不带签名一律 403），
 *         而免费/试用环境改不了存储权限，故改由云函数用 getTempFileURL 换签（见 sign.js）。
 *         返回值里还有 `cloud://...` 或 `/static/...` 就是**旧版**，
 *         界面表现是「图片全白 / 报 Failed to load image」。
 *   ⑤ 管理后台「内容侧」接口（`/admin-api/walls` / `resources` / `groups`）是否存在
 *      —— 判据是「未登录返回 401」而不是「404 接口不存在」；
 *         404 说明云函数还是旧版，后台那三个页面会是空的。
 *
 * 用法：
 *   node tools/check-deployed.js
 * 退出码：0 = 与本地一致；1 = 线上是旧版（需要重新部署）；2 = 无法连上（没配 Key 等）
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cloud = require(path.join(ROOT, 'server', 'src', 'cloud.js'));

const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => console.log('  ❌ ' + m);
const warn = (m) => console.log('  ⚠️  ' + m);

const flatCount = (tops) => {
  let n = 0;
  for (const c of (tops || [])) n += 1 + ((c.replies || []).length);
  return n;
};

(async () => {
  if (!cloud.enabled()) {
    console.log('⚠️  未配置云端 API Key，无法体检线上云函数。');
    console.log('   配置方法：在 server/.cloudbase.json 里填 apiKey');
    console.log('   （CloudBase 控制台 → 身份认证 → API Key 管理），该文件已被 .gitignore 忽略。');
    process.exit(2);
  }
  const info = cloud.info();
  console.log('线上云函数体检（只读）');
  console.log('  环境 ' + info.envId + ' · 函数 ' + info.fn + ' · Key ' + info.keyHint);

  let outdated = 0;

  /* ---------- 1. 新版标志：commentTotal ---------- */
  console.log('\n[1] 评论两级结构（新版标志：commentTotal 字段）');
  const list = await cloud.invoke({ path: '/api/posts?page=1&pageSize=10', method: 'GET', scope: 'api' });
  const posts = (list.data && list.data.list) || [];
  if (!posts.length) {
    warn('帖子列表为空，无法判断（确认线上是否已初始化数据）');
  }
  let hasTotal = null;
  const samples = posts.filter((p) => Number(p.commentCount) > 0).slice(0, 4);
  for (const p of samples.length ? samples : posts.slice(0, 2)) {
    const d = await cloud.invoke({ path: '/api/posts/' + p.id, method: 'GET', scope: 'api' });
    const dd = d.data || {};
    if ('commentTotal' in dd) hasTotal = true;
    else if (hasTotal === null) hasTotal = false;
  }
  if (hasTotal === true) ok('返回了 commentTotal → 评论两级结构已在线上生效');
  else if (hasTotal === false) { bad('**没有** commentTotal → 线上是旧版，需要重新部署云函数'); outdated++; }
  else warn('样本不足，未能判断');

  /* ---------- 2. 更早的新版标志：replyToName ---------- */
  console.log('\n[2] 回复关系（更早一轮加的 replyToName）');
  let sawReply = null, sawName = null;
  for (const p of posts.slice(0, 8)) {
    const d = await cloud.invoke({ path: '/api/posts/' + p.id, method: 'GET', scope: 'api' });
    for (const c of ((d.data && d.data.comments) || [])) {
      for (const r of (c.replies || [])) {
        if (r.replyTo || c.replyTo) { sawReply = true; if (r.replyToName || c.replyToName) sawName = true; }
      }
      if (c.replyTo) { sawReply = true; if (c.replyToName) sawName = true; }
    }
    if (sawName) break;
  }
  if (sawReply === null) warn('线上暂时没有「回复别人的评论」，这项跳过');
  else if (sawName) ok('回复关系带上了回复对象昵称');
  else { bad('有回复但**没有** replyToName → 线上早于那一轮改动'); outdated++; }

  /* ---------- 3. 数字一致性：列表数字 vs 详情实际条数 ---------- */
  console.log('\n[3] 「列表显示的评论数」与「详情实际列出的条数」是否一致');
  let checked = 0, mismatch = 0;
  for (const p of posts) {
    if (!(Number(p.commentCount) > 0)) continue;
    const d = await cloud.invoke({ path: '/api/posts/' + p.id, method: 'GET', scope: 'api' });
    const dd = d.data || {};
    const real = flatCount(dd.comments);
    const shown = Number(p.commentCount);   // 详情页上「全部评论（N）」用的是实际条数
    checked++;
    if (shown !== real) {
      mismatch++;
      bad('帖子 #' + p.id + '：列表显示 ' + shown + ' 条，详情实际列出 ' + real + ' 条'
        + (real === 0 ? '　← 就是「外面有评论、进去一条都没有」' : ''));
    }
    if (checked >= 6) break;
  }
  if (!checked) warn('没有「评论数 > 0」的帖子可对比');
  else if (!mismatch) ok('抽查 ' + checked + ' 个帖子，数字都与实际条数一致');
  else { outdated++; }

  /* ---------- 4. 图片签名（私有存储桶的绕行方案）---------- */
  console.log('\n[4] 图片是否已换成服务端签发的临时链接');
  // 判据：返回值里**不该**再出现 cloud:// 或 /static/；应出现 tcb.qcloud.la / COS 的签名 https
  let rawImg = 0, signedImg = 0;
  const firstRaw = { v: '' };
  const walk = (v) => {
    if (typeof v === 'string') {
      if (v.indexOf('cloud://') === 0 || v.indexOf('/static/') === 0) {
        rawImg++; if (!firstRaw.v) firstRaw.v = v;
      } else if (/^https:\/\/[^/]*(tcb\.qcloud\.la|cos\.[a-z0-9-]+\.myqcloud\.com)\//i.test(v)) {
        signedImg++;
      }
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    for (const k of Object.keys(v)) walk(v[k]);
  };
  // 扫两处：帖子列表（上面已取）与首页（用户第一眼看到、图最多）
  (posts || []).slice(0, 5).forEach(walk);
  try {
    const h = await cloud.invoke({ path: '/api/home', method: 'GET', scope: 'api' });
    walk(h.data || {});
  } catch (e) { warn('首页接口取样失败：' + (e && e.message)); }

  if (rawImg > 0) {
    bad('仍有 ' + rawImg + ' 处未签名的图片路径（例如 ' + firstRaw.v + '）');
    bad('　→ 线上云函数是旧版：私有存储桶下这些图在小程序端会 403（界面「图片全白」）');
    outdated++;
  } else if (signedImg > 0) {
    ok('抽到的 ' + signedImg + ' 个图片地址都是签名 https → 图片签名已在线上生效');
  } else {
    warn('样例里没有图片可判断（线上数据可能为空）');
  }

  /* ---------- 5. 管理后台「内容侧」接口 ---------- */
  console.log('\n[5] 管理后台「内容侧」接口（校园墙 / 学习资源 / 拼团）');
  // 判据：未登录访问应得 401（接口存在且受保护）。
  // 得 404「接口不存在」= 线上还是旧版云函数（这三个接口是后补的）。
  // 注意 scope 必须是 'admin'：route-admin.js 里每条路由都注册在 admin 作用域，
  // 用 'api' 去调会**一律 404**，看起来就像「没部署」—— 这是最容易被误判的一步。
  const ADMIN_NEW = ['/admin-api/walls', '/admin-api/resources', '/admin-api/groups'];
  const missing = [];
  for (const p of ADMIN_NEW) {
    try {
      const r = await cloud.invoke({ path: p, method: 'GET', scope: 'admin' });
      const code = (r && r.code) || 0;
      if (code === 401) continue;
      if (code === 404) { missing.push(p); continue; }
      warn(p + ' 返回 code=' + code + '（既非 401 也非 404，需人工确认）');
    } catch (e) {
      warn(p + ' 调用失败：' + (e && e.message ? e.message : e));
    }
  }
  if (missing.length) {
    bad('线上缺 ' + missing.length + '/' + ADMIN_NEW.length + ' 个后台接口（如 ' + missing[0] + ' → 404「接口不存在」）');
    bad('　→ 云端数据源下，后台「校园墙 / 学习资源 / 拼团管理」三个页面会是空的');
    outdated++;
  } else {
    ok('3 个内容侧接口都在线上（未登录返回 401 → 存在且受保护）');
  }

  /* ---------- 结论 ---------- */
  console.log('\n' + '─'.repeat(60));
  if (outdated) {
    console.log('结论：❌ 线上云函数是**旧版**（' + outdated + ' 项不符），需要重新部署。');
    console.log('     部署方法见 DEPLOY.md 第 1 步 —— 开发者工具左侧文件树 → 右键');
    console.log('     cloudfunctions/campus →「上传并部署：云端安装依赖（不上传 node_modules）」。');
    console.log('     ⚠️ 前端「上传」体验版和云函数部署是**两件事**，只做前者不生效。');
    process.exit(1);
  }
  console.log('结论：✅ 线上云函数与本地代码一致。');
  console.log('     若界面仍不对，先排除小程序缓存：开发者工具「清缓存 → 全部清除」后重新编译，');
  console.log('     手机上把小程序删掉再扫码进入体验版。');
  process.exit(0);
})().catch((e) => {
  console.log('\n❌ 体检失败：' + (e && e.message ? e.message : e));
  if (e && e.cloudCode) console.log('   （平台级错误码 ' + e.cloudCode + '，多为 API Key 无效或函数不存在）');
  process.exit(2);
});
