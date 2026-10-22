/**
 * 上线前体检（提交体验版 / 正式发布前跑一遍）
 *
 * 覆盖那些「一旦漏掉，真机上才暴露、现场很尴尬」的项：
 *   1. 启动页（app.json pages 第一项）与四件套齐全
 *   2. tabBar 配置与图标体积（>40KB 真机可能不显示图标）
 *   3. appid 与云环境配置是否自洽（project.config.json / utils/config.js）
 *   4. 云函数目录结构（部署时只打包根层级，子目录会被跳过）
 *   5. 云函数依赖（wx-server-sdk 是否在 package.json 里）
 *   6. sitemap.json 合法性
 *   7. 各页面 json 是否含无效字段（会让开发者工具报错）
 *   8. 需要人工在微信后台确认的清单（脚本查不到，仅打印提醒）
 *
 * 只读检查，不修改任何文件。
 * 用法：node tools/check-release.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/wx/campus-xianyu';
const MP = path.join(ROOT, 'miniprogram');

let bad = 0;
let warn = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };
const wa = (m) => { console.log('  ⚠️  ' + m); warn++; };
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

console.log('=== 1. 启动页与页面完整性 ===');
const app = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'));
const pages = app.pages || [];
if (!pages.length) no('app.json 没有 pages');
else {
  const first = pages[0];
  const missing = ['js', 'json', 'wxml'].filter((e) => !fs.existsSync(path.join(MP, first + '.' + e)));
  const noWxss = !fs.existsSync(path.join(MP, first + '.wxss'));
  if (!missing.length) ok('启动页 ' + first + '：必需文件齐全' + (noWxss ? '（无 .wxss，用全局样式，正常）' : ''));
  else no('启动页 ' + first + ' 缺少：' + missing.join(', '));

  let pageBad = 0;
  for (const p of pages) {
    const miss = ['js', 'json', 'wxml'].filter((e) => !fs.existsSync(path.join(MP, p + '.' + e)));
    if (miss.length) { console.log('      缺件：' + p + ' → ' + miss.join(', ')); pageBad++; }
  }
  if (pageBad) no('共 ' + pageBad + '/' + pages.length + ' 个页面存在缺件');
  else ok('全部 ' + pages.length + ' 个页面的 js/json/wxml 都在');
}

console.log('\n=== 2. tabBar 与图标体积 ===');
const tb = app.tabBar || {};
if (!tb.list || !tb.list.length) wa('未配置 tabBar');
else {
  console.log('      项目：' + tb.list.map((t) => t.text).join(' / '));
  let iconBad = 0, iconMiss = 0;
  for (const t of tb.list) {
    for (const k of ['iconPath', 'selectedIconPath']) {
      if (!t[k]) continue;
      const p = path.join(MP, t[k]);
      if (!fs.existsSync(p)) { console.log('      ❌ 缺失：' + t[k]); iconMiss++; continue; }
      const n = fs.statSync(p).size;
      if (n > 40 * 1024) { console.log('      ⚠️  ' + t[k] + ' ' + kb(n) + ' 超过 40KB，真机可能不显示'); iconBad++; }
    }
  }
  if (iconMiss) no(iconMiss + ' 个图标文件缺失');
  else if (iconBad) wa(iconBad + ' 个图标体积超标');
  else ok('全部图标存在且 ≤ 40KB');
}

console.log('\n=== 3. appid 与云环境自洽 ===');
const pc = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
const cfgSrc = fs.readFileSync(path.join(MP, 'utils/config.js'), 'utf8');
const envId = (cfgSrc.match(/CLOUD_ENV:\s*'([^']+)'/) || [])[1];
const fnName = (cfgSrc.match(/CLOUD_FN:\s*'([^']+)'/) || [])[1];
const bucket = (cfgSrc.match(/CLOUD_BUCKET:\s*'([^']+)'/) || [])[1];
console.log('      appid        : ' + pc.appid);
console.log('      云环境       : ' + envId);
console.log('      云函数       : ' + fnName);
console.log('      存储桶       : ' + bucket);
if (pc.appid && envId && fnName) ok('三项均已配置（需与微信后台实际值一致，脚本无法验证）');
else no('appid / CLOUD_ENV / CLOUD_FN 有缺项');
if (bucket && envId && bucket.indexOf(envId) > -1) ok('存储桶 ID 内含环境 ID（格式正确）');
else if (bucket) wa('存储桶 ID 未包含环境 ID，请确认格式 636c-<envId>-<appid>');
if (envId && bucket === envId) no('存储桶写成环境 ID 了，图片会加载失败');

console.log('\n=== 4. 云函数目录结构（部署只打包根层级）===');
const FN_DIR = path.join(ROOT, 'cloudfunctions', fnName || 'campus');
if (!fs.existsSync(FN_DIR)) no('云函数目录不存在：cloudfunctions/' + fnName);
else {
  const entries = fs.readdirSync(FN_DIR, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && e.name !== 'node_modules').map((e) => e.name);
  const js = entries.filter((e) => e.isFile() && e.name.endsWith('.js')).map((e) => e.name);
  console.log('      根层级 js：' + js.length + ' 个');
  if (dirs.length) no('根层级存在子目录：' + dirs.join(', ') + ' —— 部署时会被跳过，模块会找不到');
  else ok('无子目录，模块都在根层级（部署不会丢文件）');

  const pkgPath = path.join(FN_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) no('缺少 package.json');
  else {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const dep = (pkg.dependencies || {})['wx-server-sdk'];
    if (dep) ok('依赖 wx-server-sdk ' + dep + '（已声明，云端可自动安装）');
    else no('package.json 未声明 wx-server-sdk');
  }

  // require 的本地模块是否都存在
  let missMod = 0;
  for (const f of js) {
    const s = fs.readFileSync(path.join(FN_DIR, f), 'utf8');
    for (const m of s.matchAll(/require\('\.\/([^']+)'\)/g)) {
      const target = m[1].endsWith('.js') ? m[1] : m[1] + '.js';
      if (!fs.existsSync(path.join(FN_DIR, target))) { console.log('      ❌ ' + f + ' 引用了不存在的 ./' + m[1]); missMod++; }
    }
  }
  if (missMod) no(missMod + ' 处 require 指向不存在的文件');
  else ok('所有 require("./x") 都能找到对应文件');
}

console.log('\n=== 5. sitemap 与页面配置合法性 ===');
const smPath = path.join(MP, 'sitemap.json');
if (!fs.existsSync(smPath)) wa('没有 sitemap.json（不参与搜索可不配）');
else {
  try {
    const sm = JSON.parse(fs.readFileSync(smPath, 'utf8'));
    ok('sitemap.json 合法（' + ((sm.rules || []).length) + ' 条规则，action=' + ((sm.rules || [])[0] || {}).action + '）');
  } catch (e) { no('sitemap.json 不是合法 JSON：' + e.message); }
}
const VALID_PAGE_KEYS = ['navigationBarTitleText', 'navigationBarBackgroundColor', 'navigationBarTextStyle',
  'backgroundColor', 'backgroundTextStyle', 'enablePullDownRefresh', 'onReachBottomDistance',
  'disableScroll', 'usingComponents', 'navigationStyle', 'backgroundColorTop', 'backgroundColorBottom',
  'initialRenderingCache', 'restartStrategy', 'handleWebviewPreload', 'visualEffectInBackground',
  'renderer', 'componentFramework', 'style', 'enablePassiveEvent', 'pageOrientation'];
let keyBad = 0;
for (const p of pages) {
  const f = path.join(MP, p + '.json');
  if (!fs.existsSync(f)) continue;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const k of Object.keys(j)) {
      if (VALID_PAGE_KEYS.indexOf(k) === -1) { console.log('      ⚠️  ' + p + '.json 含非标准字段：' + k); keyBad++; }
    }
  } catch (e) { no(p + '.json 不是合法 JSON'); }
}
if (keyBad) wa(keyBad + ' 个非标准页面字段（建议清理，避免工具告警）');
else ok('所有页面 json 字段规范');

console.log('\n=== 6. 需人工在微信后台确认（脚本无法读取）===');
console.log('  □ 云函数 campus 已部署，且「超时」已设为 20 秒（默认 3 秒会超时）');
console.log('  □ 云存储已上传 static/img 与 static/avatars（否则图片空白）');
console.log('  □ ★ 图片能被人看到（二选一即可，2026-10-16 起推荐第 ② 种）');
console.log('     ① 云存储权限设为「所有用户可读」—— 云开发控制台 → 存储 → 权限设置');
console.log('        ⚠ 免费/试用版环境**做不了**：会弹「无法执行此操作 请升级至付费版」，');
console.log('          微信 CLI 与 CloudBase OpenAPI 也都没有改权限/安全规则的接口。');
console.log('     ② 云函数签发临时链接（推荐，且免费版可用）—— 已实现，见 cloudfunctions/campus/sign.js');
console.log('        依据（官方）：「云控制台和服务端始终有所有文件读写权限，配置仅对小程序端请求有效」，');
console.log('        故由云函数用 getTempFileURL 把 cloud:// 换成签名 https 返回，**前端零改动**。');
console.log('        前提：云函数必须**已部署**（sign.js 只存在于云端，本地镜像刻意不跟）。');
console.log('        —— 部署后用 `node tools/check-deployed.js` 复核，看第 [4] 项是否 ✅。');
console.log('     根因：wx.cloud.uploadFile 上传的文件带 x-cos-meta-fileid 元信息（绑定创建者），');
console.log('     默认权限「仅创建者可读写」→ 只有本人能看，即「我发的商品/改的头像别人那边一片空白，');
console.log('     但我自己看着正常」；控制台手动上传的不带该头、默认公开，所以「有的图能看、有的不能看」。');
console.log('  □ 集合 messages / conversations 权限设为「所有用户可读」');
  console.log('     —— 不开也能聊（聊天页有 3 秒轮询兜底），只是不即时；');
  console.log('        开了则**任何用户可读全部聊天记录**，按需要取舍');
  console.log('  □ project.config.json 的 appid 与小程序后台一致');
  console.log('  □ 「版本管理」里已把开发版本设为体验版（详见 DEPLOY.md 第 5 步）');
  console.log('  □ 谁来测试？管理员 + 项目成员**自带**体验者权限，无需加入体验成员；');
  console.log('     只有「不在成员名单里的外部测试者」才需要加到「体验成员」');
  console.log('     上限（项目成员 / 体验成员各算）：个人 15、未认证非个人 30、已认证未发布 60、已认证已发布 90');
  console.log('  □ 「用户隐私保护指引」已声明【收集你的昵称、头像】（及相册）——');
  console.log('     否则点头像/选相册会「点了没反应」（基础库≥2.32.3 会拦截未声明的隐私接口）；');
  console.log('     自检：运行时调 wx.getPrivacySetting（本项目实测 needAuthorization=false 且协议名有值）');
  console.log('  □ 提醒测试者：登录时点「微信一键登录」，**不要**点下方演示账号（否则账号会串）');
  console.log('  □ 数据库 meta 集合存在 admin / config / state 三个文档');
  console.log('');
  console.log('  以上都不涉及「备案」。**仅在要正式上线时**才需再看下面两条（详见 DEPLOY.md 第 6 步）：');
  console.log('  □ 【体验版 / 多人测试 / 比赛演示 都不需要备案】');
  console.log('  □ 已完成小程序备案（2023-09-01 起未备案不得上架；流程含 24h 内工信部短信核验）');
  console.log('  □ ⚠️ 主体类型与服务类目自洽：二手交易通常需「电商平台」类目，');
  console.log('     该类目要《增值电信业务经营许可证》——**个人主体办不了**，可能需换企业/个体户主体');

console.log('\n=== 7. 体积概览（小程序包上限 2MB）===');
let total = 0, files = 0;
(function walk(d) {
  for (const it of fs.readdirSync(d, { withFileTypes: true })) {
    if (it.name === 'node_modules' || it.name === 'miniprogram_npm') continue;
    const p = path.join(d, it.name);
    if (it.isDirectory()) walk(p); else { total += fs.statSync(p).size; files++; }
  }
})(MP);
console.log('      miniprogram/ 共 ' + files + ' 个文件 / ' + kb(total));
if (total > 2 * 1024 * 1024) no('超过 2MB 上限，无法上传');
else ok('未超 2MB 上限（余量 ' + kb(2 * 1024 * 1024 - total) + '）');

console.log('\n=== 8. Windows 批处理（.cmd）必须是 CRLF 换行 ===');
{
  // 起因（真实事故）：start-admin.cmd 写成 LF 换行后，双击时 cmd.exe 解析错乱，
  // 窗口里刷出一片「'xxx' 不是内部或外部命令」的乱码（连英文标语都被切碎），
  // 但服务其实**能启动** —— 所以这个错很容易被当成"偶发"忽略。
  // cmd.exe 对 LF 结尾的批处理支持很差，尤其 for / if / goto 块。
  // 这类问题只在 Windows 双击时暴露，靠读代码看不出来，必须静态检查。
  const cmds = [];
  (function walk(d) {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      if (it.name === 'node_modules' || it.name === '.git') continue;
      // 归档/备份目录不参与运行，不纳入本项检查（也不去改动它们）
      if (it.name === '_archive' || it.name === '_backup') continue;
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else if (/\.(cmd|bat)$/i.test(it.name)) cmds.push(p);
    }
  })(ROOT);

  const lfOnly = [];
  const withBom = [];
  const shown = (f) => f.replace(/\\/g, '/').replace(ROOT + '/', '');
  for (const f of cmds) {
    const buf = fs.readFileSync(f);
    const s = buf.toString('utf8');
    const lone = (s.match(/(?<!\r)\n/g) || []).length;
    if (lone > 0) lfOnly.push(shown(f) + '（' + lone + ' 处单独 LF）');
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) withBom.push(shown(f));
  }
  if (lfOnly.length) {
    no('以下批处理不是 CRLF 换行，双击时会解析错乱：');
    lfOnly.forEach((x) => console.log('      ' + x));
    console.log('      → 用 CRLF 重写（每行结尾 \\r\\n）');
  } else {
    ok('检查了 ' + cmds.length + ' 个批处理，全部 CRLF 换行');
  }
  if (withBom.length) {
    warn('以下批处理带 UTF-8 BOM（cmd 会把 BOM 当命令的一部分）');
    withBom.forEach((x) => console.log('      ' + x));
  }
}

console.log('\n' + '='.repeat(52));
if (bad) console.log('❌ ' + bad + ' 项必须修复' + (warn ? '，另有 ' + warn + ' 项建议处理' : ''));
else if (warn) console.log('⚠️  无阻断问题，但有 ' + warn + ' 项建议处理');
else console.log('✅ 体检通过，可以上传体验版');
process.exit(bad ? 1 : 0);
