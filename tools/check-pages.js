/** 校验 app.json 中每个页面的必需文件是否存在 */
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/wx/campus-xianyu/miniprogram';
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));

let bad = 0;
console.log('=== 页面文件完整性 ===');
for (const p of app.pages) {
  const base = path.join(ROOT, p);
  const miss = [];
  for (const ext of ['.js', '.wxml', '.json']) {
    if (!fs.existsSync(base + ext)) miss.push(ext);
  }
  const size = fs.existsSync(base + '.js') ? fs.statSync(base + '.js').size : 0;
  const hasWxss = fs.existsSync(base + '.wxss');
  const isStub = size < 400;
  const flag = miss.length ? '❌ 缺 ' + miss.join(',') : (isStub ? '○ 占位' : '● 已实现');
  if (miss.length) bad++;
  console.log('  ' + flag.padEnd(12) + p.padEnd(38) + (hasWxss ? 'wxss✓' : 'wxss-') + '  js=' + size + 'B');
}

console.log('\n=== 组件 ===');
for (const [name, p] of Object.entries(app.usingComponents || {})) {
  const base = path.join(ROOT, p.replace(/^\//, ''));
  const miss = ['.js', '.wxml', '.json'].filter((e) => !fs.existsSync(base + e));
  console.log('  ' + (miss.length ? '❌ 缺' + miss.join(',') : '✓').padEnd(12) + name.padEnd(16) + fs.existsSync(base + '.wxss') ? '' : '');
  if (miss.length) bad++;
}

console.log('\n=== tabBar ===');
for (const t of (app.tabBar.list || [])) {
  const base = path.join(ROOT, t.pagePath);
  const ok = ['.js', '.wxml'].every((e) => fs.existsSync(base + e));
  console.log('  ' + (ok ? '✓' : '❌') + ' ' + t.pagePath + '  (' + t.text + ')');
  if (!ok) bad++;
}
const cbBase = path.join(ROOT, 'custom-tab-bar/index');
console.log('  ' + (['.js', '.wxml', '.json', '.wxss'].every((e) => fs.existsSync(cbBase + e)) ? '✓' : '❌') + ' custom-tab-bar/index');

console.log('\n=== utils / 全局 ===');
for (const f of ['app.js', 'app.json', 'app.wxss', 'sitemap.json', 'utils/api.js', 'utils/ws.js', 'utils/util.js', 'utils/const.js']) {
  const ok = fs.existsSync(path.join(ROOT, f));
  console.log('  ' + (ok ? '✓' : '❌') + ' ' + f);
  if (!ok) bad++;
}

console.log('\n' + (bad ? '❌ 存在 ' + bad + ' 个问题' : '✅ 全部页面文件齐全，可正常编译'));
process.exit(bad ? 1 : 0);
