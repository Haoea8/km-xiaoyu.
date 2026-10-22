'use strict';
/**
 * 云端数据源（零依赖）。
 *
 * 用途：让本地管理后台（3100）看到并操作**小程序线上真实数据**，
 * 而不是本地演示数据（server/data/db.json）。
 *
 * 原理：通过 CloudBase 官方 HTTP API 调用线上云函数 campus，
 * 复用云端**已有的** /admin-api/* 全部接口 —— 不在本地重写任何管理逻辑。
 *
 *      POST https://{envId}.api.tcloudbasegateway.com/v1/functions/campus
 *      Authorization: Bearer <API Key>
 *      Body: { path, method, data, token, scope }
 *
 * 云函数的返回格式是 { code, data }，与本地服务**完全一致**，
 * 所以这里是纯透传，管理后台前端一行都不用改。
 *
 * ── 启用方式（二选一）──
 *   1) 在 server/.cloudbase.json 里填 apiKey（该文件已加入 .gitignore，不会外传）
 *   2) 设置环境变量 CLOUDBASE_API_KEY
 * 未配置时不启用，一切照旧走本地 db.json。
 *
 * ⚠️ API Key 是「管理员权限」的长期凭据，只用于本机后端，绝不可提交或打印。
 *
 * 零依赖：只用 Node 内置的 https，不引入任何 npm 包
 * （本项目服务端刻意保持零依赖，打包脚本也会校验）。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', '.cloudbase.json');

const DEFAULTS = {
  envId: 'cloud1-d1gm4yssj28112256',
  fn: 'campus',
  /** 云函数超时 20s，这里留一点余量 */
  timeoutMs: 15000
};

let cached = null;

/**
 * 读取配置。优先环境变量，其次配置文件。任何异常都静默降级为「未启用」。
 * @returns {{apiKey:string, envId:string, fn:string, timeoutMs:number}}
 */
function config() {
  if (cached) return cached;
  const cfg = Object.assign({}, DEFAULTS, { apiKey: '' });

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (raw.apiKey) cfg.apiKey = String(raw.apiKey).trim();
        if (raw.envId) cfg.envId = String(raw.envId).trim();
        if (raw.fn) cfg.fn = String(raw.fn).trim();
        if (Number(raw.timeoutMs) > 0) cfg.timeoutMs = Number(raw.timeoutMs);
      }
    }
  } catch (e) {
    // 配置文件坏了不能让服务起不来 —— 只是不启用云端而已
    console.error('[cloud] 配置文件读取失败（将按未启用处理）:', e.message);
  }

  if (process.env.CLOUDBASE_API_KEY) cfg.apiKey = String(process.env.CLOUDBASE_API_KEY).trim();
  if (process.env.CLOUDBASE_ENV) cfg.envId = String(process.env.CLOUDBASE_ENV).trim();
  if (process.env.CLOUDBASE_FN) cfg.fn = String(process.env.CLOUDBASE_FN).trim();

  cached = cfg;
  return cfg;
}

/** 是否已配置云端（配好 Key 才会启用） */
function enabled() {
  return !!config().apiKey;
}

/** 供启动日志用：只暴露环境 ID 和函数名，**绝不返回 Key** */
function info() {
  const c = config();
  return {
    enabled: !!c.apiKey,
    envId: c.envId,
    fn: c.fn,
    /** 只给 Key 的头尾各 4 位，方便用户确认「填的是哪一把」 */
    keyHint: c.apiKey ? c.apiKey.slice(0, 4) + '***' + c.apiKey.slice(-4) : ''
  };
}

/**
 * 调用云函数。
 * @param {{path:string, method?:string, data?:object, token?:string, scope?:string}} req
 * @returns {Promise<{code:number, data?:any, message?:string}>}
 */
function invoke(req) {
  const c = config();
  if (!c.apiKey) return Promise.reject(new Error('未配置云端 API Key'));

  const body = JSON.stringify({
    path: req.path || '/',
    method: String(req.method || 'GET').toUpperCase(),
    data: req.data === undefined ? null : req.data,
    token: req.token || '',
    scope: req.scope === 'admin' ? 'admin' : 'api'
  });

  const options = {
    hostname: c.envId + '.api.tcloudbasegateway.com',
    port: 443,
    path: '/v1/functions/' + encodeURIComponent(c.fn),
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + c.apiKey,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    timeout: c.timeoutMs
  };

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn) => (arg) => { if (!done) { done = true; fn(arg); } };

    const r = https.request(options, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (s.length < 8 * 1024 * 1024) s += chunk; });
      res.on('end', finish(() => {
        let parsed = null;
        try { parsed = s ? JSON.parse(s) : null; } catch (e) { parsed = null; }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          // HTTP API 直接把云函数的返回值作为响应体
          if (parsed && typeof parsed === 'object' && 'code' in parsed) return resolve(parsed);
          return resolve({ code: 0, data: parsed === null ? {} : parsed });
        }

        // 非 2xx = **平台级**错误（Key 无效 / 函数不存在 / 超限…）。
        // 云函数自身的业务错误一律是「HTTP 200 + 非零 code」，不会走到这里，
        // 所以这里全部按「上游异常（502）」处理 —— 不要映射成 401，
        // 否则后台会误以为「登录过期了」而把人踢回登录页，实际是 Key 配错了。
        const code = (parsed && parsed.code) || ('HTTP_' + res.statusCode);
        const msg = (parsed && (parsed.message || parsed.msg)) || ('云端返回 ' + res.statusCode);

        let hint = '';
        if (/INVALID_CREDENTIALS|UNAUTHENTICATED|INVALID_TOKEN/i.test(String(code))) {
          hint = '　→ 请检查 server/.cloudbase.json 里的 apiKey 是否正确（CloudBase 控制台 → 身份认证 → API Key 管理）';
        } else if (/FUNCTIONS_NOT_FOUND/i.test(String(code))) {
          hint = '　→ 环境 ' + c.envId + ' 下没有云函数，请确认函数名与部署状态';
        } else if (/ECONOMIC|RESOURCE_LIMIT|EXCEED/i.test(String(code))) {
          hint = '　→ 云端配额/并发受限，稍后重试';
        }

        const err = new Error('云端调用失败：' + code + '　' + String(msg).slice(0, 200) + hint);
        err.cloudCode = code;
        err.status = 502;
        reject(err);
      }));
    });

    r.on('timeout', finish(() => {
      const err = new Error('云端响应超时（' + c.timeoutMs + 'ms）');
      err.status = 504;
      r.destroy();
      reject(err);
    }));

    r.on('error', finish((e) => {
      const err = new Error('连接云端失败：' + (e && e.message ? e.message : '网络错误'));
      err.status = 502;
      reject(err);
    }));

    r.write(body);
    r.end();
  });
}

/** 探活：调一次 /admin-api/login 之外最轻的接口，确认 Key 与环境真的能用 */
async function ping() {
  const out = await invoke({ path: '/admin-api/login', method: 'POST', scope: 'admin',
    data: { username: '\u0000__ping__', password: '\u0000__ping__' } });
  // 走到这里说明「网络通 + Key 有效 + 函数可达」；
  // 账号密码故意写错，所以 code=401 也是成功探活。
  return { reachable: true, code: out && out.code };
}

module.exports = { enabled, config, info, invoke, ping };
