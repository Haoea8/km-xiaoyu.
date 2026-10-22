/**
 * 管理后台「数据源」测试。
 *
 * 背景：3100 后台原来只读本地演示库 server/data/db.json，与小程序线上数据
 * （微信云开发）是两套，22 个集合里 17 个对不上 —— 用户反馈「不实时」。
 * 现在支持把 /admin-api/* 透传给线上云函数，看到/操作的就是真实数据。
 *
 * 本测试**不需要真的 API Key**：
 *   · 用一个本地假云端服务器冒充 CloudBase HTTP API，验证请求形状与错误处理
 *   · 未配置 Key 时必须回落到本地库（保证不用云端的人不受影响）
 *
 * 用法：node tools/test-admin-source.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const P = 'D:/wx/campus-xianyu/';
const CLOUD_JS = P + 'server/src/cloud.js';
const CONF = P + 'server/.cloudbase.json';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/* ---------- 假云端：冒充 CloudBase API gateway ---------- */
const received = [];
const fakeCloud = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const rec = {
      url: req.url,
      method: req.method,
      auth: req.headers.authorization || '',
      contentType: req.headers['content-type'] || '',
      body: body ? JSON.parse(body) : null
    };
    received.push(rec);

    // 按约定：真实 CloudBase 会把云函数返回值直接作为响应体
    if (rec.body && rec.body.path === '/admin-api/login') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { token: 'cloud-token-abc', username: 'admin' } }));
    }
    if (rec.body && rec.body.path === '/admin-api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { totals: { users: 17, listings: 49 } } }));
    }
    if (rec.body && rec.body.path === '/admin-api/boom') {
      // 业务错误：HTTP 200 + 非零 code（云函数的失败返回方式）
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 403, message: '无权操作' }));
    }
    if (rec.body && rec.body.path === '/admin-api/httpfail') {
      // 平台级错误：非 2xx
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 'FUNCTIONS_INVOCATION_FAILED', message: '函数执行失败' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { echo: rec.body } }));
  });
});

/* ---------- 准备：把假云端地址注入 cloud.js 的配置 ---------- */
const hadConf = fs.existsSync(CONF);
const backup = hadConf ? fs.readFileSync(CONF, 'utf8') : null;

function writeConf(obj) { fs.writeFileSync(CONF, JSON.stringify(obj), 'utf8'); }
function restoreConf() {
  try {
    if (hadConf) fs.writeFileSync(CONF, backup, 'utf8');
    else if (fs.existsSync(CONF)) fs.unlinkSync(CONF);
  } catch (e) { /* 忽略 */ }
}

(async () => {
  await new Promise((r) => fakeCloud.listen(0, '127.0.0.1', r));
  const cloudPort = fakeCloud.address().port;

  console.log('=== 0. 未配置 Key 时必须不启用（本地模式不受影响）===');
  {
    // 先临时移走配置
    if (fs.existsSync(CONF)) fs.unlinkSync(CONF);
    delete require.cache[require.resolve(CLOUD_JS)];
    const cloud = require(CLOUD_JS);
    if (cloud.enabled() === false) ok('未配置 apiKey → enabled() = false（走本地库）');
    else no('未配置却启用了云端，会打乱本地模式');
    const info = cloud.info();
    if (info.enabled === false && info.keyHint === '') ok('info() 不泄露任何 Key 片段');
    else no('info() 有问题：' + JSON.stringify(info));
  }

  console.log('\n=== 1. 配好 Key 后启用，并把请求打到对的地址 ===');
  {
    writeConf({ apiKey: 'test-key-1234567890', envId: '127.0.0.1:' + cloudPort, fn: 'campus', timeoutMs: 5000 });
    // cloud.js 里 hostname 会拼成 "<envId>.api.tcloudbasegateway.com"，
    // 测试里让 envId 变成 127.0.0.1:port 不可行，所以这里改为直接调用内部 http 逻辑
    // → 见下方「注」：我们改用 monkey-patch https.request 指向假云端。
    delete require.cache[require.resolve(CLOUD_JS)];
    fs.writeFileSync(CONF, JSON.stringify({ apiKey: 'test-key-1234567890' }), 'utf8');

    // 用 https 模块拦截，把域名请求转给本地假云端
    const httpsMod = require('https');
    const realRequest = httpsMod.request;
    httpsMod.request = function (options, cb) {
      const opts = Object.assign({}, options, { hostname: '127.0.0.1', port: cloudPort, protocol: 'http:' });
      return http.request(opts, cb);
    };

    delete require.cache[require.resolve(CLOUD_JS)];
    const cloud = require(CLOUD_JS);

    if (cloud.enabled() === true) ok('配好 apiKey → enabled() = true');
    else no('配了 Key 却没启用');

    const info = cloud.info();
    if (info.enabled && info.keyHint === 'test' + '***' + '7890') ok('info() 只给 Key 头尾：' + info.keyHint);
    else no('keyHint 不对：' + info.keyHint);
    if (!JSON.stringify(info).includes('test-key-1234567890')) ok('info() 不含完整 Key（不会误打印）');
    else no('info() 泄露了完整 Key');

    // 请求形状
    received.length = 0;
    const out = await cloud.invoke({ path: '/admin-api/login', method: 'POST', scope: 'admin', data: { username: 'admin', password: 'admin' } });
    const rec = received[0];
    if (rec && rec.method === 'POST' && rec.url === '/v1/functions/campus') ok('请求路径正确：POST /v1/functions/campus');
    else no('请求路径不对：' + (rec ? rec.method + ' ' + rec.url : '没收到'));
    if (rec && rec.auth === 'Bearer test-key-1234567890') ok('带上了 Authorization: Bearer <Key>');
    else no('Authorization 不对：' + (rec ? rec.auth : '无'));
    if (rec && rec.body && rec.body.path === '/admin-api/login' && rec.body.method === 'POST' && rec.body.scope === 'admin') {
      ok('包体形状正确：{path, method, data, token, scope}');
    } else {
      no('包体形状不对：' + JSON.stringify(rec && rec.body));
    }
    if (out && out.code === 0 && out.data && out.data.token === 'cloud-token-abc') ok('云函数返回值原样透传（code/data）');
    else no('返回值处理不对：' + JSON.stringify(out));
    if (rec && rec.body && rec.body.token === '' && 'token' in rec.body && 'data' in rec.body) ok('token/data 字段始终存在（云函数要求 ev.data）');
    else no('包体缺少 token/data 字段：' + JSON.stringify(rec && rec.body));

    // 业务错误（200 + 非零 code）必须原样返回，不能被当成异常
    const boom = await cloud.invoke({ path: '/admin-api/boom', method: 'GET', scope: 'admin' });
    if (boom && boom.code === 403 && boom.message === '无权操作') ok('业务错误原样返回（code=403 不当异常）');
    else no('业务错误处理不对：' + JSON.stringify(boom));

    // 平台级错误（非 2xx）必须抛错，且**不能映射成 401**
    //（否则后台会误判「登录过期」把人踢回登录页，实际是 Key 配错）
    let thrown = null;
    try { await cloud.invoke({ path: '/admin-api/httpfail', method: 'GET', scope: 'admin' }); } catch (e) { thrown = e; }
    if (thrown && /FUNCTIONS_INVOCATION_FAILED/.test(thrown.message)) ok('平台级错误抛异常并带错误码：' + thrown.message.slice(0, 46));
    else no('平台级错误没按预期抛错');
    if (thrown && thrown.status === 502) ok('非 2xx 统一映射为 502（不会被当成 401 踢回登录页）');
    else no('非 2xx 的状态码映射不对：' + (thrown && thrown.status));

    httpsMod.request = realRequest;
  }

  console.log('\n=== 2. 配置文件损坏时要降级，不能把服务拖down ===');
  {
    fs.writeFileSync(CONF, '{ 这不是合法 JSON', 'utf8');
    delete require.cache[require.resolve(CLOUD_JS)];
    let cloud = null, threw = false;
    try { cloud = require(CLOUD_JS); } catch (e) { threw = true; }
    if (!threw && cloud && cloud.enabled() === false) ok('配置坏了 → 静默降级为未启用（服务照常启动）');
    else no('配置坏了导致异常：threw=' + threw);
  }

  console.log('\n=== 3. 本地服务已接入：/admin-info 与代理分支都在 ===');
  {
    const idx = fs.readFileSync(P + 'server/src/index.js', 'utf8');
    if (/cloud\.enabled\(\)/.test(idx) && /cloud\.invoke\(/.test(idx)) ok('handleAdmin 里有云端分支（透传 /admin-api/*）');
    else no('handleAdmin 里没接云端');
    if (idx.indexOf('cloud.enabled()') < idx.indexOf('auth.adminByToken(token)')) ok('云端分支在本地下发之前（否则会先被 401 挡掉）');
    else no('顺序不对：本地鉴权在云端分支之前');
    if (/\/admin-info/.test(idx)) ok('提供了 /admin-info（后台显示数据源徽标用）');
    else no('缺少 /admin-info');
    if (/CLOUD\.enabled/.test(idx) && /server\/\.cloudbase\.json/.test(idx)) ok('启动时会提示当前数据源与如何接云端');
    else no('启动日志没有数据源提示');

    const html = fs.readFileSync(P + 'server/public/index.html', 'utf8');
    if (/数据源：云端/.test(html) && /数据源：本地演示数据/.test(html)) ok('后台顶部有「云端 / 本地」徽标');
    else no('后台没有数据源徽标');
    if (/setInterval/.test(html) && /everyMs/.test(html)) ok('后台有自动刷新（定时器）');
    else no('后台没有自动刷新');
    if (/this\.dirty/.test(html) && /document\.hidden/.test(html)) ok('自动刷新有保护：填表时暂停 + 后台标签页不刷');
    else no('自动刷新缺少保护（会冲掉正在填的内容）');
  }

  console.log('\n=== 4. 凭据不会被外传 ===');
  {
    const gi = fs.readFileSync(P + '.gitignore', 'utf8');
    if (/server\/\.cloudbase\.json/.test(gi)) ok('.gitignore 忽略了 server/.cloudbase.json');
    else no('.gitignore 没忽略凭据文件');

    const pack = fs.readFileSync(P + 'tools/pack-for-share.js', 'utf8');
    if (/server\/\.cloudbase\.json/.test(pack)) ok('打包排除清单含 server/.cloudbase.json');
    else no('打包没排除凭据文件');
    if (/凭据泄露风险/.test(pack)) ok('打包自检会拦截凭据泄露');
    else no('打包自检没有凭据泄露检查');
    if (fs.existsSync(P + 'server/.cloudbase.json.example')) ok('提供了 .cloudbase.json.example 模板（含填写说明）');
    else no('缺少配置模板');
  }

  restoreConf();
  fakeCloud.close();
  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 数据源可切云端（透传 /admin-api），未配 Key 时不影响本地模式，凭据不外传'));
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  restoreConf();
  try { fakeCloud.close(); } catch (err) { /* 忽略 */ }
  console.error('测试崩溃:', e);
  process.exit(1);
});
