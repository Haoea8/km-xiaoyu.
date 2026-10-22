const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = 'D:/wx/campus-xianyu/miniprogram';

let bad = 0;
const fail = (m) => { console.log('  ❌ ' + m); bad++; };
const pass = (m) => console.log('  ✓ ' + m);

/* ---------- 0. 语法检查 ---------- */
console.log('=== 0. 语法检查（所有改动文件）===');
const changed = [
  'custom-tab-bar/index.js',
  'app.js',
  'pages/index/index.js',
  'pages/circle/circle.js',
  'pages/message/message.js',
  'pages/profile/profile.js'
];
for (const rel of changed) {
  const f = path.join(ROOT, rel);
  try { new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }); pass('语法通过 ' + rel); }
  catch (e) { fail(rel + ' → ' + e.message); }
}

/* ---------- 1. tabBar 结构 ---------- */
console.log('\n=== 1. tabBar 结构 ===');
const tabSrc = fs.readFileSync(path.join(ROOT, 'custom-tab-bar/index.js'), 'utf8');
const items = [...tabSrc.matchAll(/\{\s*pagePath:\s*'([^']*)',\s*text:\s*'([^']*)',\s*key:\s*'([^']*)'\s*\}/g)]
  .map((m) => ({ pagePath: m[1], text: m[2], key: m[3] }));
items.forEach((it, i) => console.log('  [' + i + '] ' + it.key.padEnd(8) + ' ' + (it.text || '(发布)').padEnd(5) + ' ' + (it.pagePath || '-')));
if (tabSrc.indexOf('setActive') > -1) pass('提供 setActive(key)'); else fail('缺少 setActive');
if (tabSrc.indexOf('syncSelected') > -1) pass('提供 syncSelected() 兜底'); else fail('缺少 syncSelected');
if (/setTimeout\(\(\)\s*=>\s*this\.syncSelected\(true\)/.test(tabSrc)) pass('syncSelected 含延迟重试'); else fail('syncSelected 缺少重试');
if (tabSrc.indexOf('this.setActive(item.key)') > -1) pass('onTap 里先本地点亮'); else fail('onTap 未本地点亮');

/* ---------- 2. app.syncTabBar ---------- */
console.log('\n=== 2. app.syncTabBar 全局方法 ===');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
if (/syncTabBar\s*\(page,\s*key\)/.test(appSrc)) pass('已定义 syncTabBar(page, key)'); else fail('未定义 syncTabBar');
if (/tb\.setActive\(key\)/.test(appSrc)) pass('内部调用 tb.setActive(key)'); else fail('未调用 setActive');
if (/getTabBar\(\)/.test(appSrc)) pass('通过 page.getTabBar() 取实例'); else fail('未取 tabBar 实例');

/* ---------- 3. 页面调用 key 校验 ---------- */
console.log('\n=== 3. 各 tab 页传的 key ===');
const pageKeys = {
  'pages/index/index.js': 'home',
  'pages/circle/circle.js': 'circle',
  'pages/message/message.js': 'message',
  'pages/profile/profile.js': 'mine'
};
const validKeys = items.map((it) => it.key);
for (const rel in pageKeys) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const expect = pageKeys[rel];
  const m = src.match(/app\.syncTabBar\(this,\s*'([^']+)'\)/);
  if (!m) { fail(rel + ' 未调用 app.syncTabBar'); continue; }
  if (m[1] !== expect) { fail(rel + ' 传的 key=' + m[1] + '，应为 ' + expect); continue; }
  if (validKeys.indexOf(m[1]) === -1) { fail(rel + ' 的 key(' + m[1] + ') 不在 tabBar list 中'); continue; }
  const idx = items.findIndex((it) => it.key === m[1]);
  pass(rel.padEnd(26) + " app.syncTabBar(this, '" + m[1] + "')  → 高亮 [" + idx + '] ' + items[idx].text);
}

/* ---------- 4. 硬编码 selected 残留 ---------- */
console.log('\n=== 4. 硬编码 selected 残留 ===');
let hard = 0;
for (const rel of Object.keys(pageKeys)) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (/getTabBar\(\)\.setData\(\{[^}]*selected:\s*\d/.test(src)) { fail(rel + ' 仍有硬编码 selected'); hard++; }
}
if (!hard) pass('4 个 tab 页均无硬编码 selected');

/* ---------- 5. 期望结果 ---------- */
console.log('\n=== 5. 期望结果（修复后）===');
const expectMap = [
  { route: '/pages/index/index', key: 'home', label: '首页' },
  { route: '/pages/circle/circle', key: 'circle', label: '圈子' },
  { route: '/pages/message/message', key: 'message', label: '消息' },
  { route: '/pages/profile/profile', key: 'mine', label: '我的' }
];
for (const e of expectMap) {
  const idx = items.findIndex((it) => it.key === e.key);
  const ok = items[idx] && items[idx].pagePath === e.route;
  if (ok) console.log('  ✓ ' + e.label.padEnd(4) + ' → 高亮 [' + idx + '] ' + items[idx].text);
  else fail(e.label + ' 高亮位置错误');
}

console.log('\n' + (bad ? '❌ 存在 ' + bad + ' 个问题' : '✅ 全部通过：高亮按 key 反查，不再依赖 getCurrentPages 时序'));
process.exit(bad ? 1 : 0);
