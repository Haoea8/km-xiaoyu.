'use strict';
/**
 * 管理后台启动器（由 start-admin.cmd 调用）。
 *
 * 为什么要把逻辑搬到 Node 里 —— 不是洁癖，是**踩过两次**：
 *
 *   ① 换行符事故：.cmd 存成 LF 时 cmd.exe 解析错乱，窗口刷出一片
 *      「'xxx' 不是内部或外部命令」。（已在 .gitattributes 钉住 CRLF）
 *   ② 编码事故（2026-10-17）：.cmd 存成 UTF-8 且带中文，即使有
 *      `chcp 65001`，cmd.exe 仍会**按字节偏移重新读取批处理文件**，
 *      多字节汉字会把它切错行 —— 于是 `rem ...而是直接打开后台。` 的尾巴
 *      被当成命令执行，报「'♦♦而是直接打开后台。' 不是内部或外部命令」。
 *
 * 结论：**批处理文件只写 ASCII**，所有对用户说的话由 Node 输出
 * （Node 自己就是 UTF-8，配合 chcp 65001 能正常显示中文）。
 * 这是本项目「辅助脚本一律 Node，不写 PowerShell」的同一条理由。
 *
 * 用法（一般不用手敲，双击 start-admin.cmd 即可）：
 *   node tools/start-admin.js             # 起服务；已在运行则打开后台
 *   node tools/start-admin.js --no-open   # 不自动开浏览器（自测用）
 */
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/**
 * 启动前依赖自检。
 *
 * 分享包里**不含 node_modules**（体积原因）。如果 package.json 里又没写
 * `ws` / `busboy`，对方 `npm install` 也装不到 —— 服务会在
 * `Cannot find module 'ws'` 处直接崩，窗口一闪而过，看着就像"仪表盘后台打不开"。
 *
 * 所以在起服务之前先说人话：告诉他跑哪条命令，而不是甩一段 Node 堆栈。
 */
function ensureDeps() {
  const miss = [];
  for (const m of ['ws', 'busboy']) {
    try { require.resolve(m); } catch (e) { miss.push(m); }
  }
  if (!miss.length) return true;
  console.log('');
  bar();
  console.log('  缺少依赖：' + miss.join(', '));
  console.log('  分享包不带 node_modules，装一次就好：');
  console.log('');
  console.log('      在当前目录执行：  npm install');
  console.log('');
  console.log('  装完再双击 start-admin.cmd 即可（首次拉依赖需要联网）。');
  bar();
  return false;
}


const ROOT = path.join(__dirname, '..');
const API_PORT = Number(process.env.API_PORT || 3000);
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 3100);
const NO_OPEN = process.argv.includes('--no-open');

/** 试绑一次；返回 true 表示「绑不上 = 被占用」 */
function tryBind(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
    s.once('listening', () => s.close(() => resolve(false)));
    try {
      s.listen(port, host);
    } catch (e) {
      resolve(false);
    }
  });
}

/**
 * 端口是否已在监听。
 *
 * ★ 必须**两个地址都试**：Windows 下 `0.0.0.0:3100` 被别人占着时，
 *   再 bind `127.0.0.1:3100` 依然会**成功**；反过来也一样。
 *   只试一个就会得出「端口空着」的错误结论 —— 本次实测：
 *   服务在 0.0.0.0:3100 上跑着，脚本却报告「只有 3000 被占」，
 *   于是走到「端口冲突」分支，本该打开的「已在运行」提示没能出现。
 */
async function portInUse(port) {
  if (await tryBind(port, '127.0.0.1')) return true;
  return await tryBind(port, '0.0.0.0');
}

/**
 * 本机可用于「手机 / 别的电脑访问」的 IPv4。
 * 带上网卡名 —— 一台机器上常有好几个（WiFi、有线、Hyper-V 虚拟网卡、手机热点），
 * 只丢一串 IP 出来，用户根本不知道该抄哪个。
 */
function lanUrls(port) {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const c of ifs[name] || []) {
      if (c.family !== 'IPv4' || c.internal) continue;
      const ip = String(c.address);
      if (ip.indexOf('169.254.') === 0) continue; // 链路本地地址，别的设备连不上
      out.push({ nic: name, url: 'http://' + ip + ':' + port });
    }
  }
  return out;
}

/** 读一下后台自己的 /admin-info（只读、2s 超时）。用来判断「已在运行」的是不是**当前这版代码** */
function probeAdminInfo(port) {
  return new Promise((resolve) => {
    const http = require('http');
    const r = http.get({ host: '127.0.0.1', port, path: '/admin-info', timeout: 2000 }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(s));
        } catch (e) {
          resolve(null);
        }
      });
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => {
      r.destroy();
      resolve(null);
    });
  });
}

function openBrowser(url) {
  if (NO_OPEN) return;
  try {
    // 走 cmd 的 start，避免直接 spawn 浏览器时被当成子进程等它退出
    const p = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    p.unref();
  } catch (e) {
    /* 打不开就算了，地址已经打印在屏幕上 */
  }
}

function bar() {
  console.log('  ' + '='.repeat(64));
}

async function main() {
  if (!ensureDeps()) return 1;
  const apiBusy = await portInUse(API_PORT);
  const adminBusy = await portInUse(ADMIN_PORT);
  const adminUrl = 'http://127.0.0.1:' + ADMIN_PORT;

  /* ---------- 两个端口都占着：几乎一定是「上一次开的窗口还没关」 ---------- */
  if (apiBusy && adminBusy) {
    bar();
    console.log('   科贸小鱼 · 管理后台：服务已经在运行了');
    bar();
    console.log('');
    console.log('  端口 ' + API_PORT + ' / ' + ADMIN_PORT + ' 都在监听，说明服务已经启动过了，');
    console.log('  这里直接帮你打开后台，不需要再启动一次。');
    console.log('');
    console.log('  管理后台： ' + adminUrl);
    console.log('  登录账号： admin / admin（演示前记得在【系统设置】里改掉）');
    console.log('');

    // 端口在监听 ≠ 跑的是**当前这版代码**。后台自己会答 /admin-info，
    // 认一下它是不是旧版本（这是本项目最常踩的坑：以为改了，其实跑的是老进程）。
    const info = await probeAdminInfo(ADMIN_PORT);
    if (!info) {
      console.log('  ⚠️ 端口在监听，但 /admin-info 没响应 —— 那个进程可能卡住了。');
      console.log('     建议结束它再重开（见下方命令）。');
      console.log('');
    } else if (!Array.isArray(info.lanUrls)) {
      console.log('  ⚠️ 正在运行的还是**旧版本**（没有局域网地址信息）。');
      console.log('     请关掉那个服务窗口，再双击本文件，才会用上新代码。');
      console.log('');
    } else {
      console.log('  数据源：' + (info.source === 'cloud' ? '云端（线上真实数据）' : '本地演示数据'));
      console.log('');
    }

    const lan = lanUrls(ADMIN_PORT);
    if (lan.length) {
      console.log('  同一 WiFi 下的手机 / 别的电脑也能打开：');
      for (const x of lan) console.log('    ' + x.url + '   [' + x.nic + ']');
      console.log('');
    }
    console.log('  打不开？说明那个服务窗口已经被关掉或卡死了，先清理掉占用：');
    console.log('    taskkill /IM node.exe /F     （会关掉所有 node 进程，谨慎）');
    console.log('  或者按下面的 PID 精确处理：');
    console.log('    netstat -ano | findstr ":' + ADMIN_PORT + '" → 看最后一列 PID → taskkill /PID <PID> /F');
    console.log('');
    openBrowser(adminUrl);
    return 0;
  }

  /* ---------- 只有一个端口被占：说明有别的东西占着，别硬起 ---------- */
  if (apiBusy || adminBusy) {
    const busy = apiBusy ? API_PORT : ADMIN_PORT;
    bar();
    console.log('   [错误] 端口 ' + busy + ' 已被其它程序占用，服务没法启动');
    bar();
    console.log('');
    console.log('  查是谁占着：');
    console.log('    netstat -ano | findstr ":' + busy + '"');
    console.log('  然后结束它（把 <PID> 换成上一行最后一列的数字）：');
    console.log('    taskkill /PID <PID> /F');
    console.log('');
    return 1;
  }

  /* ---------- 正常启动 ---------- */
  bar();
  console.log('   科贸小鱼 · 本地服务启动中');
  bar();
  console.log('  管理后台： ' + adminUrl + '   （admin / admin）');
  console.log('  小程序 API：http://127.0.0.1:' + API_PORT);
  console.log('');
  const lan = lanUrls(ADMIN_PORT);
  if (lan.length) {
    console.log('  同一 WiFi 下的手机 / 别的电脑：');
    for (const x of lan) console.log('    ' + x.url + '   [' + x.nic + ']');
    console.log('');
  }
  console.log('  ⚠️ 这个窗口不要关 —— 关掉服务就停了（按 Ctrl+C 可停止）。');
  console.log('');

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env
  });

  // 等它真的开始监听再开浏览器，否则会打开一个「无法访问」的标签页
  const started = Date.now();
  const timer = setInterval(async () => {
    if (await portInUse(ADMIN_PORT)) {
      clearInterval(timer);
      openBrowser(adminUrl);
    } else if (Date.now() - started > 15000) {
      clearInterval(timer);
    }
  }, 400);
  timer.unref();

  child.on('exit', (code) => {
    clearInterval(timer);
    console.log('');
    bar();
    console.log('  服务已停止（退出码 ' + (code === null ? 'null' : code) + '）。');
    console.log('  若是异常退出，请把上面的报错发给我。');
    bar();
    process.exit(code === null ? 0 : code);
  });
  return null; // 不主动退出，等子进程
}

main()
  .then((code) => {
    if (code !== null) process.exit(code);
  })
  .catch((e) => {
    console.log('启动失败：' + (e && e.message ? e.message : e));
    process.exit(1);
  });
