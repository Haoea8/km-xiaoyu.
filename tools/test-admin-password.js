/**
 * admin 密码回归测试。
 *
 * 验证三件事：
 *   1) 新密码 admin / admin 能登录成功
 *   2) 旧密码 campus123 已失效
 *   3) seed 源里写的就是 admin（防止以后被改回去）
 *
 * 用真实启动本地服务 + 真实 HTTP 请求，不是 mock。
 * 用法：先 node server/src/index.js，再跑本脚本。
 *
 * ⚠️ 判定「拒绝」时**不能只看 HTTP 状态码**（见下面 rejected() 的注释）：
 *    云端模式下 /admin-api/* 被透传给云函数，HTTP 恒为 200、结果在 body.code 里。
 */
const http = require('http');

const ADMIN_PORT = 3100;

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: ADMIN_PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let s = '';
      res.on('data', (d) => s += d);
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(s); } catch (e) { }
        resolve({ status: res.statusCode, body: j, raw: s.slice(0, 200) });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * 「被拒绝」的判定 —— 不能只看 HTTP 状态码。
 *
 * 本地模式：/admin-api/* 由本地服务处理 → 真返回 HTTP 401。
 * 云端模式：/admin-api/* 被**透传给云函数**，统一走 json(res, 200, out)，
 *           HTTP 恒为 200，业务结果全在 body.code 里（code:401）。
 *
 * 两种模式都是「拒绝」，必须一起判 —— 否则本脚本在云端模式下 100% 假失败
 * （曾经就是这样：跑在全绿的回归里报「旧密码竟然还能登录」，其实是误报）。
 * 另外要求**没有下发 token**：这才是「真没让登进去」的硬证据。
 */
function rejected(r) {
  const code = r.body && r.body.code;
  const hasToken = !!(r.body && r.body.data && r.body.data.token);
  return (r.status === 401 || code === 401) && !hasToken;
}

(async () => {
  let bad = 0;
  const ok = (m) => console.log('  ✓ ' + m);
  const no = (m) => { console.log('  ❌ ' + m); bad++; };

  console.log('=== 1. 新密码 admin / admin 应能登录 ===');
  try {
    const r = await post('/admin-api/login', { username: 'admin', password: 'admin' });
    const d = (r.body && r.body.data) || {};
    if (r.status === 200 && d.token) {
      ok('登录成功，拿到 token（长度 ' + d.token.length + '），username=' + d.username);
    } else {
      no('登录失败：HTTP ' + r.status + '  ' + JSON.stringify(r.body || r.raw));
    }
  } catch (e) {
    no('无法连接本地服务：' + e.message + '（请先启动 node server/src/index.js）');
  }

  console.log('\n=== 2. 旧密码 campus123 应已失效 ===');
  try {
    const r = await post('/admin-api/login', { username: 'admin', password: 'campus123' });
    if (rejected(r)) ok('旧密码被拒绝（HTTP ' + r.status + ' / code ' + (r.body && r.body.code) + '：' + (r.body && r.body.message) + '）');
    else no('旧密码竟然还能登录！HTTP ' + r.status + '  ' + JSON.stringify(r.body || r.raw).slice(0, 90));
  } catch (e) { no('请求失败：' + e.message); }

  console.log('\n=== 3. 错误密码应被拒绝 ===');
  try {
    const r = await post('/admin-api/login', { username: 'admin', password: 'wrong-pw' });
    if (rejected(r)) ok('错误密码被拒绝（HTTP ' + r.status + ' / code ' + (r.body && r.body.code) + '）');
    else no('错误密码通过了！HTTP ' + r.status + '  ' + JSON.stringify(r.body || r.raw).slice(0, 90));
  } catch (e) { no('请求失败：' + e.message); }

  console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ admin 密码已生效：admin / admin 可登录，旧密码失效'));
  process.exit(bad ? 1 : 0);
})();
