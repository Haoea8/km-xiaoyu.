const __BASE = require('path').resolve(__dirname, '..');
const fs = require('fs');
const files = [
  (__BASE + '/miniprogram/custom-tab-bar/index.js'),
  (__BASE + '/miniprogram/pages/index/index.js'),
  (__BASE + '/miniprogram/pages/circle/circle.js'),
  (__BASE + '/miniprogram/pages/message/message.js'),
  (__BASE + '/miniprogram/pages/profile/profile.js'),
  (__BASE + '/miniprogram/utils/config.js'),
  (__BASE + '/project.config.json')
];

console.log('=== 项目目录：D:/wx/campus-xianyu ===');
console.log('=== 改动落点核对 ===');
for (const f of files) {
  const st = fs.statSync(f);
  const src = fs.readFileSync(f, 'utf8');
  const rel = f.replace((__BASE + '/'), '');
  let note = '';

  if (f.indexOf('custom-tab-bar') > -1) {
    note = src.indexOf('syncSelected') > -1 ? '改好了：含 syncSelected 路由反查' : '未改';
  } else if (f.indexOf('utils/config.js') > -1) {
    const m = src.match(/CLOUD_ENV:\s*'([^']+)'/);
    note = '环境ID = ' + (m ? m[1] : '?');
  } else if (f.indexOf('project.config.json') > -1) {
    const m = src.match(/"appid":\s*"([^"]+)"/);
    note = 'AppID = ' + (m ? m[1] : '?');
  } else {
    const hasHard = /getTabBar\(\)\.setData\(\{[^}]*selected:\s*\d/.test(src);
    note = hasHard ? '未改：仍有硬编码 selected' : '改好了：已移除硬编码 selected';
  }

  console.log('  ' + new Date(st.mtimeMs).toLocaleString().padEnd(22) + rel);
  console.log('      ' + note);
}
