/**
 * 验证 api.abs() 的路径映射逻辑
 * 在沙箱里加载真实 utils/api.js，喂入种子数据里的真实路径，断言输出。
 */
const fs = require('fs');
const vm = require('vm');

const ENV = 'cloud1-d1gm4yssj28112256';
// 云存储 fileID 的第二段是「存储桶 ID」，不是环境 ID（写成 envId.envId 会让 image 报错）。
// 这里必须与 miniprogram/utils/config.js 的 CLOUD_BUCKET 保持一致。
const BUCKET = '636c-cloud1-d1gm4yssj28112256-1505193768';
const API = 'D:/wx/campus-xianyu/miniprogram/utils/api.js';
const CONFIG = 'D:/wx/campus-xianyu/miniprogram/utils/config.js';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

const sandbox = {
  console,
  wx: {
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    cloud: { init: () => {}, callFunction: () => {}, uploadFile: () => {} }
  },
  require: (p) => {
    if (p === './config') {
      return { CLOUD_ENV: ENV, CLOUD_BUCKET: BUCKET, CLOUD_FN: 'campus', CLOUD_PATH: 'campus/' };
    }
    throw new Error('unexpected require: ' + p);
  },
  module: { exports: {} }
};
sandbox.exports = sandbox.module.exports;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(API, 'utf8'), sandbox, { filename: API });
const api = sandbox.module.exports;

console.log('=== 1. 种子数据路径映射 ===');
const cases = [
  ['/static/img/p01.jpg', 'cloud://' + ENV + '.' + BUCKET + '/static/img/p01.jpg'],
  ['/static/avatars/a01.jpg', 'cloud://' + ENV + '.' + BUCKET + '/static/avatars/a01.jpg'],
  ['/static/img/p24.jpg', 'cloud://' + ENV + '.' + BUCKET + '/static/img/p24.jpg'],
  ['/static/img/c01.jpg', 'cloud://' + ENV + '.' + BUCKET + '/static/img/c01.jpg']
];
for (const [input, expect] of cases) {
  const got = api.abs(input);
  if (got === expect) ok(input + '  →  ' + got);
  else no(input + '  期望 ' + expect + '  实际 ' + got);
}

console.log('\n=== 2. 已是 cloud:// 的不再包装 ===');
{
  const cf = 'cloud://' + ENV + '.' + BUCKET + '/campus/uploads/123.jpg';
  if (api.abs(cf) === cf) ok('cloud:// 原样返回');
  else no('cloud:// 被改动了: ' + api.abs(cf));
}

console.log('\n=== 3. 网络图片 / dataURI 原样返回 ===');
for (const u of ['https://example.com/a.png', 'http://a.cn/b.jpg', 'data:image/png;base64,AAA']) {
  if (api.abs(u) === u) ok(u.slice(0, 40) + ' 原样返回');
  else no(u + ' 被改动');
}

console.log('\n=== 4. 空值安全 ===');
for (const v of ['', null, undefined]) {
  if (api.abs(v) === '') ok('abs(' + JSON.stringify(v) + ') → 空串（不抛错）');
  else no('abs(' + JSON.stringify(v) + ') 返回了 ' + JSON.stringify(api.abs(v)));
}

console.log('\n=== 5. 逻辑自检：映射后的路径能对上云存储结构 ===');
{
  // 用户把 server/static 上传到云存储根目录后，实际路径应为 static/img/p01.jpg
  const got = api.abs('/static/img/p01.jpg');
  const cloudPath = got.replace('cloud://' + ENV + '.' + BUCKET + '/', '');
  if (cloudPath === 'static/img/p01.jpg') ok('云存储内路径 = ' + cloudPath + '（对应上传 server/static 文件夹）');
  else no('云存储内路径不对: ' + cloudPath);
}

console.log('\n=== 6. 头像字段必须过 api.abs（源文件静态核对）===');
{
  // 背景：种子数据里的头像是 /static/avatars/a04.jpg 这类**相对路径**。
  // 直接绑到 image 上 → 小程序按相对地址请求 → 报
  //   Failed to load image http://127.0.0.1:xxxx/__pageframe__/static/avatars/a04.jpg
  // 真机上表现为头像空白。
  // 曾经详情页卖家和两个卡片组件都踩了这个坑，这里用断言钉住，防止再漏。
  const ROOT = 'D:/wx/campus-xianyu/miniprogram/';

  const read = (rel) => {
    try { return fs.readFileSync(ROOT + rel, 'utf8'); }
    catch (e) { no('读不到 ' + rel); return ''; }
  };

  // 6.1 js 侧：赋值时确实包了 api.abs
  const jsCases = [
    ['pages/detail/detail.js', /seller\s*:[^\n]*api\.abs\([^\n]*avatar/i, '详情页卖家头像'],
    ['components/listing-card/listing-card.js', /sellerAvatar\s*:\s*api\.abs\(/i, '商品卡片卖家头像'],
    ['components/post-card/post-card.js', /authorAvatar\s*:\s*api\.abs\(/i, '帖子卡片作者头像']
  ];
  for (const [f, re, label] of jsCases) {
    const s = read(f);
    if (re.test(s)) ok(label + '：' + f + ' 里已过 api.abs');
    else no(label + '：' + f + ' 里没看到 api.abs 转换（真机头像会空白）');
  }

  // 6.2 wxml 侧：必须绑转换后的扁字段，不能直接绑原始深层属性
  const wxmlCases = [
    ['components/listing-card/listing-card.wxml', 'sellerAvatar', /item\.seller\.avatar/],
    ['components/post-card/post-card.wxml', 'authorAvatar', /post\.author\.avatar/],
    ['pages/detail/detail.wxml', 'seller.avatar', null]
  ];
  for (const [f, safeField, dangerRe] of wxmlCases) {
    const s = read(f);
    if (dangerRe && dangerRe.test(s)) {
      no(f + ' 直接绑了原始头像属性（' + dangerRe.source + '），应绑 ' + safeField);
    } else if (safeField === 'seller.avatar') {
      // 详情页 js 是「就地替换」风格：seller.avatar 本身已经是 cloud://，允许直接用
      if (/seller\.avatar/.test(s)) ok(f + ' 用 seller.avatar（js 已就地转换，允许）');
      else ok(f + ' 未直接引用 seller.avatar（无需处理）');
    } else {
      if (s.includes('{{' + safeField + '}}')) ok(f + ' 绑定 {{' + safeField + '}}');
      else no(f + ' 未绑定 {{' + safeField + '}}，头像可能取不到值');
    }
  }
}

console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 全部通过：图片映射与「上传 server/static 文件夹」完全对应'));
process.exit(bad ? 1 : 0);
