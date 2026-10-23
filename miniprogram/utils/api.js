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
const { CLOUD_ENV, CLOUD_BUCKET, CLOUD_FN, CLOUD_PATH } = require('./config');

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

/** 判断是否为云存储 fileID */
function isCloudFile(p) { return typeof p === 'string' && p.startsWith('cloud://'); }

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
function request(method, path, data, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const t = token();
    if (o.loading) wx.showLoading({ title: o.loading === true ? '加载中' : o.loading, mask: true });

    const done = () => { if (o.loading) wx.hideLoading(); };

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
  });
}

/**
 * 文件上传 → 云存储
 * 返回 fileID（cloud://...），可直接用于 image 组件
 */
function upload(filePath, dir) {
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
}

module.exports = {
  init, abs, isCloudFile, toTempUrls, token, setToken, clearToken, upload,
  get: (p, data, o) => request('GET', p, data, o),
  post: (p, data, o) => request('POST', p, data, o),
  patch: (p, data, o) => request('PATCH', p, data, o),
  del: (p, data, o) => request('DELETE', p, data, o)
};
