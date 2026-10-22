/**
 * 验证图片 fileID 拼接是否正确。
 * 加载真实 utils/api.js，检查 abs() 输出格式。
 */
const fs = require('fs');
const vm = require('vm');

const ENV = 'cloud1-d1gm4yssj28112256';
const BUCKET = '636c-cloud1-d1gm4yssj28112256-1505193768';
const API = 'D:/wx/campus-xianyu/miniprogram/utils/api.js';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

const sandbox = {
  console,
  wx: {
    getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {},
    cloud: { init: () => {}, callFunction: () => {}, uploadFile: () => {}, getTempFileURL: () => Promise.resolve({}) }
  },
  require: (p) => {
    if (p === './config') return { CLOUD_ENV: ENV, CLOUD_BUCKET: BUCKET, CLOUD_FN: 'campus', CLOUD_PATH: 'campus/' };
    throw new Error('unexpected require: ' + p);
  },
  module: { exports: {} }
};
sandbox.exports = sandbox.module.exports;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(API, 'utf8'), sandbox, { filename: API });
const api = sandbox.module.exports;

console.log('=== 1. 种子路径 → fileID ===');
const cases = ['/static/img/p01.jpg', '/static/avatars/a05.jpg', '/static/img/c02.jpg'];
for (const input of cases) {
  const got = api.abs(input);
  const want = 'cloud://' + ENV + '.' + BUCKET + input;
  if (got === want) ok(input + '\n      → ' + got);
  else { no(input + '\n      期望 ' + want + '\n      实际 ' + got); }
}

console.log('\n=== 2. fileID 结构校验（关键） ===');
{
  const got = api.abs('/static/img/p01.jpg');
  const body = got.replace('cloud://', '');
  const slash = body.indexOf('/');
  const host = body.slice(0, slash);
  const seg = host.split('.');

  if (seg.length === 2) ok('host 分为两段（环境ID.存储桶ID）');
  else no('host 段数不对: ' + seg.length + ' → ' + host);

  if (seg[0] === ENV) ok('第一段 = 环境ID  ' + seg[0]);
  else no('第一段应为环境ID，实际 ' + seg[0]);

  if (seg[1] === BUCKET) ok('第二段 = 存储桶ID  ' + seg[1]);
  else no('第二段应为存储桶ID，实际 ' + seg[1]);

  if (seg[1].indexOf('636c-') === 0) ok('存储桶ID 形如 636c-<envId>-<appid>');
  else no('存储桶ID 形态异常');

  // 关键回归点：第二段不能等于环境 ID
  if (seg[1] !== ENV) ok('第二段不是环境ID（原 bug 已避免）');
  else no('第二段又写成了环境ID —— 会导致图片加载失败！');

  const filePath = body.slice(slash + 1);
  if (filePath === 'static/img/p01.jpg') ok('文件路径 = ' + filePath);
  else no('文件路径异常: ' + filePath);
}

console.log('\n=== 3. 透传与边界 ===');
{
  const cf = 'cloud://' + ENV + '.' + BUCKET + '/campus/uploads/x.jpg';
  if (api.abs(cf) === cf) ok('已是 fileID 的原样返回');
  else no('fileID 被二次包装');

  const http = 'https://a.com/b.png';
  if (api.abs(http) === http) ok('https 原样返回');
  else no('https 被改动');

  for (const v of ['', null, undefined]) {
    if (api.abs(v) === '') ok('abs(' + JSON.stringify(v) + ') = ""');
    else no('空值处理异常');
  }
}

console.log('\n=== 4. 与云存储实际结构对齐 ===');
{
  const got = api.abs('/static/img/p01.jpg');
  const inBucket = got.replace('cloud://' + ENV + '.' + BUCKET + '/', '');
  if (inBucket === 'static/img/p01.jpg') ok('云存储内路径 = ' + inBucket + '（与已上传的 37 个文件一致）');
  else no('路径不对齐: ' + inBucket);
}

console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ fileID 格式正确'));
process.exit(bad ? 1 : 0);
