/**
 * 网络层（云开发版）
 *
 * 对外保持与本地 REST 版完全一致的签名：
 *   api.get(path, data, opts) / api.post / api.patch / api.del / api.upload / api.abs
 * 因此所有页面代码无需改动。
 *
 * 内部把「REST 路径 + 方法 + body」打包成一次云函数调用：
 *   wx.cloud.callFunction({ name: 'campus', data: { path, method, data, token, scope } })
 */
const { CLOUD_ENV, CLOUD_BUCKET, CLOUD_FN, CLOUD_PATH, LOCAL_API } = require('./config');

let ready = false;

function init() {
  ready = true;
}

function token() { return wx.getStorageSync('token') || ''; }
function setToken(t) { wx.setStorageSync('token', t || ''); }
function clearToken() { wx.removeStorageSync('token'); }

/**
 * 静态资源地址
 *
 * 云存储 fileID 的格式是 cloud://<环境ID>.<存储桶ID>/<路径>，
 * 第二段必须是存储桶 ID —— 写成环境 ID 会让 image 组件把它当相对路径，
 * 报 "Failed to load image http://127.0.0.1:xxxx/__pageframe__/.../cloud://..."。
 *
 * 种子数据里存的是 /static/img/p01.jpg 这类相对路径，
 * 这里统一转成:
 *   cloud://<envId>.<bucketId>/static/img/p01.jpg
 */
function abs(path) {
  if (!path) return '';
  if (/^(https?|cloud|data):/i.test(path)) return path;
  if (path.startsWith('/static/')) {
    // 种子图片已打进小程序包（miniprogram/static/...），直接用包内路径。
    // 不要再拼 cloud://：云存储里从来没有这批文件，拼出来的 fileID 请求必然 404 → 灰块。
    return path;
  }
  return path;
}

/**
 * 判断是否为云存储 fileID
 * 同样避开 `typeof`（见下方 request 里的说明：SWC 会把它改写成缺失的 @swc/runtime 模块）
 */
function isCloudFile(p) { return !!p && String(p).indexOf('cloud://') === 0; }

/**
 * 批量把 cloud:// fileID 换成可访问的临时链接（供 image 使用）
 * 小程序 image 组件原生支持 cloud://，通常无需转换；
 * 此方法用于需要 http 链接的场景（如 wx.previewImage 之外的分享）。
 */
function toTempUrls(fileIDs) {
  const ids = (fileIDs || []).filter(isCloudFile);
  if (!ids.length) return Promise.resolve({});
  return wx.cloud.getTempFileURL({ fileList: ids })
    .then((res) => {
      const map = {};
      ((res && res.fileList) || []).forEach((f) => { if (f.tempFileURL) map[f.fileID] = f.tempFileURL; });
      return map;
    })
    .catch(() => ({}));
}

/* ---------------- 核心请求 ---------------- */
/**
 * 本地后台探测（开发者工具里自动连本机 server）。
 *
 * 规则：
 *   1. config.LOCAL_API 显式填了地址 → 用它；
 *   2. 没填且当前是「开发版」(envVersion === develop) → 试 http://127.0.0.1:3000；
 *   3. 体验版 / 正式版 → 永不走本地，直接云函数。
 * 探测失败（本机没起 server）会自动回退云函数，所以最坏情况与改动前一致。
 * 结果缓存，一次会话只探一次。
 */
let _localBase = null;
function checkLocal() {
  if (_localBase !== null) return Promise.resolve(_localBase);
  let base = LOCAL_API || '';
  if (!base) {
    try {
      const env = wx.getAccountInfoSync().miniProgram.envVersion;
      if (env === 'develop') base = 'http://127.0.0.1:3000';
    } catch (e) { /* 低版本基础库拿不到，忽略 */ }
  }
  if (!base) { _localBase = ''; return Promise.resolve(''); }
  return new Promise((resolve) => {
    wx.request({
      url: String(base).replace(/\/+$/, '') + '/api/ai/debug',
      method: 'GET',
      timeout: 900,
      success: () => { _localBase = base; resolve(base); },
      fail: () => { _localBase = ''; resolve('');  // 本机没起 server → 回退云函数
      }
    });
  });
}
function request(method, path, data, opts) {
  return checkLocal().then((base) => new Promise((resolve, reject) => {
    const o = opts || {};
    const t = token();
    if (o.loading) wx.showLoading({ title: o.loading === true ? '加载中' : o.loading, mask: true });

    const done = () => { if (o.loading) wx.hideLoading(); };

    /**
     * 本地 REST 模式（config.LOCAL_API 填了地址时启用）。
     *
     * 目的：评委/开发者在本机跑起 server 后，小程序与后台共享同一份数据，
     * 不需要任何云开发账号。返回结构与云函数版保持一致（{code, data, message}），
     * 所以下面所有页面代码不需要改。
     */
    if (base) {
      wx.request({
        url: String(base).replace(/\/+$/, '') + path,
        method: String(method || 'GET').toUpperCase(),
        data: data || {},
        header: Object.assign(
          { 'Content-Type': 'application/json' },
          t ? { Authorization: 'Bearer ' + t } : {}
        ),
        success(res) {
          done();
          const body = res && res.data;
          /**
           * ⚠️ 这里刻意不用 `typeof body !== 'object'`：
           * 微信开发者工具的 SWC 编译会把 `typeof` 改写成 `@swc/runtime/_type_of.js`，
           * 而基础库 3.8.12 下这个辅助模块有时不会被注入，
           * 运行时报 `module '@swc/runtime/_type_of.js' is not defined`，整个小程序起不来。
           * 换成「有没有业务字段」判断，效果等价且不触发该 bug。
           */
          if (!body || (body.code === undefined && body.message === undefined && body.data === undefined)) {
            if (!o.silent) wx.showToast({ title: '本地服务无返回', icon: 'none' });
            const e = new Error('本地服务无返回'); e.code = 0; return reject(e);
          }
          if (body.code === 0) return resolve(body.data || {});
          const msg = body.message || '请求失败';
          if (body.code === 401) clearToken();
          if (!o.silent) wx.showToast({ title: msg, icon: 'none', duration: 2000 });
          const e = new Error(msg); e.code = body.code; reject(e);
        },
        fail(err) {
          done();
          const raw = (err && err.errMsg) || '';
          let msg = '连不上本地服务';
          if (/url not in domain list|合法域名/i.test(raw)) {
            msg = '请勾选「不校验合法域名」（详情 → 本地设置）';
          } else if (/fail/i.test(raw)) {
            msg = '本地服务未启动，先运行 node server/src/index.js';
          }
          if (!o.silent) wx.showToast({ title: msg, icon: 'none', duration: 2500 });
          const e = new Error(msg); e.code = -1; reject(e);
        }
      });
      return;
    }

    wx.cloud.callFunction({
      name: CLOUD_FN,
      data: {
        path,
        method,
        data: data || null,
        token: t,
        scope: o.scope || 'api'
      },
      success(res) {
        done();
        const body = res && res.result;
        if (!body) {
          if (!o.silent) wx.showToast({ title: '云函数无返回', icon: 'none' });
          const e = new Error('云函数无返回');
          e.code = 0;
          return reject(e);
        }
        if (body.code === 0) return resolve(body.data || {});
        const msg = body.message || '请求失败';
        // 仅在服务端明确否定身份（401）时清 token。
        // 超时、网络错误等一律保留登录态，避免把用户误踢下线。
        if (body.code === 401) clearToken();
        if (!o.silent) wx.showToast({ title: msg, icon: 'none', duration: 2000 });
        const e = new Error(msg);
        e.code = body.code;
        reject(e);
      },
      fail(err) {
        done();
        const raw = (err && err.errMsg) || '';
        let msg = '云函数调用失败';
        if (/FunctionName parameter could not be found|not found/i.test(raw)) {
          msg = '云函数未部署，请先上传 campus 云函数';
        } else if (/timeout/i.test(raw)) {
          msg = '网络超时，请重试';
        } else if (/environment/i.test(raw)) {
          msg = '云环境未初始化，请检查 utils/config.js';
        } else if (raw) {
          msg = raw.replace(/^cloud\.callFunction:fail\s*/, '');
        }
        if (!o.silent) wx.showToast({ title: msg, icon: 'none', duration: 2500 });
        const e = new Error(msg);
        e.code = -1;   // 非服务端业务错误（网络/超时等）
        reject(e);
      }
    });
  }));
}

/**
 * 文件上传
 *  - 云函数模式：传云存储，返回 fileID（cloud://...）
 *  - 本地模式：传本机 server 的 /api/upload，返回**完整 http 地址**
 *    ⚠️ 必须返回绝对地址，不能返回 /static/uploads/xxx：
 *    abs() 会把 /static/ 开头的路径当成「小程序包内文件」，而包内根本没有这张图，
 *    结果就是灰块/花屏。这是之前踩过的坑，这里显式避开。
 */
function upload(filePath, dir) {
  return checkLocal().then((base) => {
    if (base) {
      const root = String(base).replace(/\/+$/, '');
      const tk = token();
      return new Promise((resolve, reject) => {
        wx.uploadFile({
          url: root + '/api/upload',
          filePath: filePath,
          name: 'file',
          header: tk ? { Authorization: 'Bearer ' + tk } : {},
          formData: { dir: dir || 'uploads' },
          success(res) {
            let body = null;
            try { body = JSON.parse(res.data || '{}'); } catch (e) { body = null; }
            if (body && body.code === 0) {
              const d = body.data || {};
              const u = d.url || (d.urls && d.urls[0]) || '';
              return resolve(u ? root + u : '');
            }
            reject(new Error((body && body.message) || '上传失败'));
          },
          fail(err) {
            const raw = (err && err.errMsg) || '';
            reject(new Error(/url not in domain list|合法域名/i.test(raw)
              ? '请勾选「不校验合法域名」（详情 → 本地设置）'
              : '本地服务未启动，先双击 start-admin.cmd'));
          }
        });
      });
    }

    const ext = (String(filePath).match(/\.[A-Za-z0-9]+$/) || [''])[0];
    const name = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext;
    return new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath: CLOUD_PATH + (dir || 'uploads') + '/' + name,
        filePath,
        success: (res) => {
          if (res && res.fileID) return resolve(res.fileID);
          reject(new Error('上传失败'));
        },
        fail: (err) => {
          const raw = (err && err.errMsg) || '';
          reject(new Error(/permission|denied/i.test(raw) ? '云存储权限不足，请在控制台开通' : '上传失败'));
        }
      });
    });
  });
}

module.exports = {
  init, abs, isCloudFile, toTempUrls, token, setToken, clearToken, upload,
  get: (p, data, o) => request('GET', p, data, o),
  post: (p, data, o) => request('POST', p, data, o),
  patch: (p, data, o) => request('PATCH', p, data, o),
  del: (p, data, o) => request('DELETE', p, data, o)
};
