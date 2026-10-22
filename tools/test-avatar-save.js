/**
 * 头像保存回归测试：「传一次就该生效」。
 *
 * 守护的真实 bug（用户反馈「个人头像得上传两次才能保存并成功显示」）：
 *   上传 + PATCH 成功之后又调了一次 this.load()，而 /api/me 读的是**实例内存快照**。
 *   PATCH 落在云函数实例 A、这次 GET 落到实例 B 时，B 返回的还是旧头像，
 *   applyUser() 把刚设好的 avatarAbs **覆盖回旧图** → 看起来像「第一次没保存」。
 *
 * 断言三件事：
 *   ① 上传成功后 avatarAbs 立刻是新 fileID（用 PATCH 的返回值落地，不等重新拉取）
 *   ② 上传后**不再**多发一次 /api/me（否则旧响应会把新头像盖回去）
 *   ③ 上传中连点不会重复上传；失败时状态复位、头像不变
 *
 * 用法：node tools/test-avatar-save.js
 */
const Module = require('module');

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ✗ ' + m); bad++; };

const SETTINGS = 'D:/wx/campus-xianyu/miniprogram/pages/settings/settings.js';

const calls = { upload: 0, patch: [], get: 0 };
const impl = {
  upload: async () => 'cloud://env.bucket/avatars/new.jpg',
  patch: async (url, body) => ({ user: { id: 1, nickname: '张三', bio: '', avatar: body.avatar } }),
  get: async () => ({ user: { id: 1, nickname: '张三', bio: '', avatar: 'cloud://env.bucket/avatars/OLD.jpg' } })
};

const appMock = {
  globalData: { user: { id: 1, nickname: '张三', avatar: 'cloud://env.bucket/avatars/OLD.jpg' } },
  guard: () => true,
  setUser(u) { this.globalData.user = u; calls.setUser = u; }
};

const apiMock = {
  token: () => 'tok',
  abs: (p) => p || '',
  upload: async () => { calls.upload++; return impl.upload(); },
  patch: async (url, body) => { calls.patch.push({ url, body }); return impl.patch(url, body); },
  get: async () => { calls.get++; return impl.get(); },
  post: async () => ({ ok: true })
};

global.Page = (o) => { global.__pageDef = o; };
global.getApp = () => appMock;
global.wx = {
  showLoading() { }, hideLoading() { }, showToast() { }, getStorageSync: () => '', setStorageSync() { },
  chooseMedia(o) { global.__choose = o; }, clearStorage() { }
};

const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../../utils/api') return apiMock;
  if (request === '../../utils/config') return { CLOUD_ENV: 'mock-env' };
  if (request === '../../utils/const') return { COLLEGES: ['计算机学院'], GRADES: ['大一'] };
  return orig.apply(this, arguments);
};
require(SETTINGS);
const pageDef = global.__pageDef;
if (!pageDef) { console.error('无法加载 settings.js'); process.exit(1); }

function makePage() {
  const inst = Object.create(null);
  for (const k of Object.keys(pageDef)) inst[k] = pageDef[k];
  inst.data = JSON.parse(JSON.stringify(pageDef.data || {}));
  inst.setData = function (patch) { Object.assign(this.data, patch); };
  inst.data.logged = true;
  inst.data.user = { id: 1, nickname: '张三', bio: '', avatar: 'cloud://env.bucket/avatars/OLD.jpg' };
  inst.data.avatarAbs = 'cloud://env.bucket/avatars/OLD.jpg';
  return inst;
}

(async () => {
  console.log('=== 1. 微信头像：传一次就显示新头像 ===');
  {
    calls.upload = 0; calls.patch.length = 0; calls.get = 0;
    impl.upload = async () => 'cloud://env.bucket/avatars/new.jpg';
    const p = makePage();
    await p.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/a.png' } });
    if (p.data.avatarAbs === 'cloud://env.bucket/avatars/new.jpg') ok('avatarAbs 已变成新头像');
    else no('avatarAbs = ' + p.data.avatarAbs + '，应为新头像');
    if (calls.get === 0) ok('上传后没有再拉 /api/me（不会用旧快照盖回新头像）');
    else no('上传后又拉了 ' + calls.get + ' 次 /api/me —— 这就是「要传两次」的根因');
    if (appMock.globalData.user.avatar === 'cloud://env.bucket/avatars/new.jpg') ok('app.setUser 同步了新头像（其他页面跟着变）');
    else no('全局用户头像没同步：' + appMock.globalData.user.avatar);
    if (p.data.uploading === false) ok('uploading 已复位');
    else no('uploading 卡在 true');
  }

  console.log('\n=== 2. 空响应兜底：PATCH 没回 user 时也能落地 ===');
  {
    calls.upload = 0; calls.get = 0;
    impl.patch = async () => ({});
    const p = makePage();
    await p.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/b.png' } });
    if (p.data.avatarAbs === 'cloud://env.bucket/avatars/new.jpg') ok('回退用本地 fileID 落地，仍显示新头像');
    else no('avatarAbs = ' + p.data.avatarAbs);
    impl.patch = async (url, body) => ({ user: { id: 1, nickname: '张三', bio: '', avatar: body.avatar } });
  }

  console.log('\n=== 3. 从相册选：连点只上传一次 ===');
  {
    calls.upload = 0;
    const p = makePage();
    p.data.uploading = true;          // 模拟「第一次还在传」
    p.changeAvatar();
    if (calls.upload === 0) ok('上传中再次点击被挡下（不会两个上传互相覆盖）');
    else no('连点又发起了一次上传');

    p.data.uploading = false;
    p.changeAvatar();
    if (typeof global.__choose === 'object' && global.__choose.success) ok('正常点击会打开相册');
    else no('没有打开相册');
  }

  console.log('\n=== 4. 上传失败：状态复位、头像不变 ===');
  {
    calls.upload = 0;
    impl.upload = async () => { throw new Error('网络错误'); };
    const p = makePage();
    await p.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/c.png' } });
    if (p.data.avatarAbs === 'cloud://env.bucket/avatars/OLD.jpg') ok('失败后头像保持旧值（不会先变空）');
    else no('avatarAbs = ' + p.data.avatarAbs);
    if (p.data.uploading === false) ok('uploading 已复位，可以重试');
    else no('uploading 卡在 true，用户无法重试');
  }

  console.log('\n' + (bad ? '✗ 有 ' + bad + ' 项失败' : '✓ 全部通过'));
  process.exit(bad ? 1 : 0);
})();
