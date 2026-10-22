#!/usr/bin/env node
/**
 * check-mirror.js —— 「云函数 ↔ 本地镜像」一致性体检
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它
 * ---------------------------------------------------------------------------
 * 本项目约定 `cloudfunctions/campus/*` 与 `server/src/*` 是**镜像代码，必须同步改**：
 * 云函数跑在微信云开发、本地那份跑在 3100 管理后台，两边是**同一套业务逻辑的两份拷贝**
 * （`server/src/interactions.js` 顶部注释、记忆里的项目约定都写了这条）。
 *
 * 但这条约定**只写在注释里，一直没有自动检查**，于是踩过两类坑：
 *   ① 只改了云函数一侧 → 本地后台/线上行为不一致，且从界面完全看不出来；
 *   ② 对同一个文件并行发多个 Edit，只有最后一个落盘，前面的改动**被静默覆盖**
 *      （2026-10-16 加互动消息 hook 时真实发生：extend.js 的 4 个 hook 只剩下 1 个，
 *       而其它断言仍然通过，肉眼很难发现）。
 * 本脚本就是这两类问题的哨兵。
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 刻意**不做**「整文件 diff」
 * ---------------------------------------------------------------------------
 * 两份代码本来就**不是逐字节镜像**，硬比对会产生大量假报错（本项目其它体检脚本
 * 都明确警惕这一点：`check-scroll-height.js` 曾因对着非 scroll-view 元素假报错而重写）：
 *   - require 路径深度不同：云函数 `require('./db')` / 本地 `require('../db')`、`require('db')`
 *   - 事件总线模块**改了名**：云函数 `events.js` ↔ 本地 `ws.js`
 *   - 底栏文件刻意不同：`db.js`（本地单实例无 id 竞态，保持小 id）、`config.js`（云环境凭据）
 *     —— 见 `db.js` 顶部 `plainIdMode` 注释
 *   - 少量注释/日志措辞不同
 * 所以本脚本改比**「清单」**：路由表、互动 hook、接口调用
 * —— 这些是注释改动和路径改名都影响不了的**语义指纹**。
 *
 * ---------------------------------------------------------------------------
 * 检查项（全部为「不一致即退出码 1」）
 * ---------------------------------------------------------------------------
 *   A. 路由清单：每个 `route('METHOD','/api/x')` 的 (方法, 路径) 集合，逐对文件必须完全相同
 *      → 直接抓「只在云函数加了接口，本地没加」这类漏同步
 *      （确实**应当**存在的差异写在 `KNOWN_ROUTE_DIFF` 里，用 ⚠ 提示且不算失败）
 *   B. 互动 hook 清单：每个 `it.add({type:'xxx'})` 出现在哪些路由文件，两侧必须完全相同
 *      → 抓「hook 被覆盖/漏加了某几处」（并行 Edit 覆盖真实翻车点）
 *   C. 互动接口调用：`it.list` / `it.unreadCount` / `it.markRead` 两侧都要有
 *   D. 共享数据层必须**逐字节一致**：`interactions.js`（含匿名保护逻辑，两侧必须同源）
 *   E. 路由层调用的 `db.xxx(...)` 必须在**本侧 db.js 里存在**
 *      → 抓「镜像代码用了某侧没有的数据层方法」（本地服务会直接 TypeError，已真实发生过）
 *
 * 本脚本**不覆盖**：函数体内部逻辑被改坏（那要靠 `test-*.js` 回归测试与反向对照）。
 *
 * 用法：
 *   node tools/check-mirror.js
 * 退出码：0 = 一致；1 = 有不一致（需要人工同步）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLOUD_DIR = path.join(ROOT, 'cloudfunctions', 'campus');
const SERVER_DIR = path.join(ROOT, 'server', 'src');
const SERVER_ROUTES = path.join(SERVER_DIR, 'routes');

/** 云函数文件 → 本地文件名（默认同名；特殊的在这里写清原因） */
const NAME_MAP = {
  'events.js': 'ws.js', // 事件总线：云函数叫 events.js，本地叫 ws.js
};

/** 必须逐字节一致的共享模块（数据层，逻辑同源） */
const MUST_BE_IDENTICAL = ['interactions.js'];

/** 不参与配对（各自有意为之，见文件顶部注释） */
const SKIP_PAIR = new Set([
  'db.js',        // 本地单实例：刻意不跟「id 带实例槽位」的改动
  'config.js',    // 云环境 ID / 存储桶 ID / API Key 本来就不同
  'index.js',     // 入口形态不同（云函数 main vs express 挂载）
  'cloud.js',     // 只有本地有：调线上云函数的 HTTP 网关
  'sign.js',      // 只有云端有：给私有存储桶的图片签发临时链接。本地 REST 直接由
                  // server/static/ 出图（http 可访问），既不需要、也不该改写成云端链接
  'package.json',
]);

/**
 * 已登记的**路由级**差异（⚠ 不算失败，但必须写清原因）。
 * 为什么不直接把这几个路由加进白名单就算了：白名单会连"以后又漏同步"一起放过，
 * 所以这里只登记**逐条**的差异，并打印原因 —— 新增一条就意味着要重新审视一次。
 */
const KNOWN_ROUTE_DIFF = {
  'route-social.js': {
    'POST /api/conversations/:id/ai-reply': [
      '本地 server 的 ws.sendChatMessage 一律「内联」生成 AI 回复（不实现 deferAI 两段式），',
      '前端把 /ai-reply 当**兜底通道**（silent:true，404 被 catch 忽略；AI 回复已内联产生，',
      '最迟由聊天页轮询补上），所以本地没有这条路由。',
      '云端为了压低首字节时延才拆成「先存消息立刻返回 / 再补 AI 回复」两段，因此云端有它。',
    ].join(''),
  },
};

// ============================ 工具 ============================

const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const rel = p => path.relative(ROOT, p).replace(/\\/g, '/');
const short = f => f.replace(/^route-/, '').replace(/\.js$/, '');

/** 路由声明指纹：`route('GET', '/api/x')` → `GET /api/x` */
function routesOf(src) {
  const out = new Set();
  const RE = /route\(\s*['"](\w+)['"]\s*,\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = RE.exec(src)) !== null) out.add(m[1] + ' ' + m[2]);
  return out;
}

/** `it.add({ type: 'xxx' })` → { type: [文件key…] } */
function hooksOf(files) {
  const map = new Map();
  const RE = /it\.add\(\s*\{[^}]*?type:\s*['"]([a-z_]+)['"]/gs;
  for (const f of files) {
    const src = read(f.path);
    if (!src) continue;
    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(src)) !== null) {
      if (!map.has(m[1])) map.set(m[1], new Set());
      map.get(m[1]).add(f.key);
    }
  }
  return map;
}

/** 哪些文件的源码里有此调用 */
function callersOf(files, re) {
  return files.filter(f => { const s = read(f.path); return s && re.test(s); }).map(f => f.key).sort();
}

/** 建配对：云函数文件 → 本地镜像路径 */
function buildPairs() {
  const pairs = [];
  for (const f of fs.readdirSync(CLOUD_DIR).filter(x => x.endsWith('.js')).sort()) {
    if (SKIP_PAIR.has(f)) continue;
    const serverName = NAME_MAP[f] || f;
    const serverPath = f.startsWith('route-')
      ? path.join(SERVER_ROUTES, serverName.slice('route-'.length))
      : path.join(SERVER_DIR, serverName);
    pairs.push({ name: f, key: short(f), cloud: path.join(CLOUD_DIR, f), server: serverPath });
  }
  return pairs;
}

// ============================ 检查 ============================

function checkRoutes(pairs) {
  console.log('\n=== A. 路由清单（(方法, 路径) 集合必须完全相同）===');
  let bad = 0;
  for (const p of pairs) {
    const c = read(p.cloud);
    if (c === null) { console.log(`  ✗ ${p.name}  云侧读不到`); bad++; continue; }
    const s = read(p.server);
    if (s === null) { console.log(`  ✗ ${p.name}  本地侧缺少镜像文件 → ${rel(p.server)}`); bad++; continue; }

    const rc = routesOf(c), rs = routesOf(s);
    const known = KNOWN_ROUTE_DIFF[p.name] || {};
    let onlyCloud = [...rc].filter(x => !rs.has(x)).sort();
    const onlyServer = [...rs].filter(x => !rc.has(x)).sort();
    // 已登记的差异从「只在云函数有」里摘出来，单独用 ⚠ 提示（不判失败）
    const knownHit = onlyCloud.filter(x => known[x]);
    onlyCloud = onlyCloud.filter(x => !known[x]);

    if (onlyCloud.length === 0 && onlyServer.length === 0) {
      console.log(`  ✓ ${p.name.padEnd(18)} ${rc.size} 条路由，两侧一致`);
    } else {
      bad++;
      console.log(`  ✗ ${p.name.padEnd(18)} 路由不一致（云 ${rc.size} / 本地 ${rs.size}）`);
      onlyCloud.forEach(x => console.log(`        只在云函数有: ${x}`));
      onlyServer.forEach(x => console.log(`        只在本地有  : ${x}`));
    }
    // 已登记的差异放在后面打印，避免被误当成失败项
    for (const x of knownHit) {
      console.log(`  ⚠ ${p.name.padEnd(18)} 已登记差异: ${x}`);
      console.log(`        ${known[x]}`);
    }
  }
  return bad;
}

function checkHooks(pairs, cloudFiles, serverFiles) {
  console.log('\n=== B. 互动 hook 清单（type → 出现在哪个路由文件；两侧必须完全相同）===');
  const ch = hooksOf(cloudFiles), sh = hooksOf(serverFiles);
  const all = [...new Set([...ch.keys(), ...sh.keys()])].sort();
  if (all.length === 0) {
    console.log('  ✗ 两侧都没有任何 it.add(...) —— 互动消息的埋点是不是整个丢了？');
    return 1;
  }
  let bad = 0;
  for (const t of all) {
    const c = [...(ch.get(t) || [])].sort();
    const s = [...(sh.get(t) || [])].sort();
    const same = c.join(',') === s.join(',');
    if (!same) bad++;
    console.log(`  ${same ? '✓' : '✗'} ${t.padEnd(18)} 云[${c.join(',') || '—'}]  本地[${s.join(',') || '—'}]`);
  }
  return bad;
}

function checkInterfaces(cloudFiles, serverFiles) {
  console.log('\n=== C. 互动接口调用（两侧都要有）===');
  const defs = [
    ['it.list', /it\.list\s*\(/],
    ['it.unreadCount', /it\.unreadCount\s*\(/],
    ['it.markRead', /it\.markRead\s*\(/],
  ];
  let bad = 0;
  for (const [name, re] of defs) {
    const c = callersOf(cloudFiles, re), s = callersOf(serverFiles, re);
    const same = c.join(',') === s.join(',');
    if (!same) bad++;
    console.log(`  ${same ? '✓' : '✗'} ${name.padEnd(15)} 云[${c.join(',') || '—'}]  本地[${s.join(',') || '—'}]`);
  }
  return bad;
}

function checkIdentical() {
  console.log('\n=== D. 共享数据层逐字节一致 ===');
  let bad = 0;
  for (const f of MUST_BE_IDENTICAL) {
    const c = read(path.join(CLOUD_DIR, f)), s = read(path.join(SERVER_DIR, f));
    if (c === null || s === null) { console.log(`  ✗ ${f}  有一侧读不到`); bad++; continue; }
    if (c === s) {
      console.log(`  ✓ ${f}  完全一致（${Buffer.byteLength(c)} B）`);
    } else {
      const lc = c.split('\n'), ls = s.split('\n');
      const n = Math.max(lc.length, ls.length);
      let at = 0;
      for (let i = 0; i < n; i++) if (lc[i] !== ls[i]) { at = i + 1; break; }
      console.log(`  ✗ ${f}  不一致（云 ${Buffer.byteLength(c)} B / 本地 ${Buffer.byteLength(s)} B），首处不同在第 ${at} 行`);
      console.log(`        云  : ${(lc[at - 1] || '<<缺>>').trim().slice(0, 110)}`);
      console.log(`        本地: ${(ls[at - 1] || '<<缺>>').trim().slice(0, 110)}`);
      bad++;
    }
  }
  return bad;
}

/**
 * 从某侧 db.js 里提取「对外暴露的方法名」。
 * 做法：去掉注释后取 `module.exports = { ... }` 整块，按逗号/换行切分，
 * 每段取 `name` 或 `key: value` 的 key。导出块里混着行内对象与注释，所以先洗一遍。
 */
function dbApiOf(file) {
  const src = read(file);
  if (!src) return null;
  const noComment = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const at = noComment.indexOf('module.exports');
  if (at < 0) return null;
  const body = noComment.slice(at);
  const set = new Set();
  for (const seg of body.split(/[,\n]/)) {
    const m = seg.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::|\s*$)/);
    if (m) set.add(m[1]);
  }
  return set;
}

/**
 * E. 路由层调用的 `db.xxx(...)` 必须在**本侧的 db.js 里真的存在**。
 *
 * 为什么需要它（真实事故，2026-10-16）：
 *   云端为多实例加了 `db.findByIdWithFallback`，路由层镜像代码直接写死调用；
 *   但本地 `server/src/db.js` 是单实例、不需要这个方法，于是**没有**它。
 *   结果云函数正常、本地服务的「删除我的商品」一按就 TypeError。
 *   而 A/B/C/D 四项检查都只看路由清单与文本一致性 —— 全部通过，压根发现不了。
 */
function checkDbApi(pairs) {
  console.log('\n=== E. 路由层调用的 db 方法在两侧 db.js 里都存在 ===');
  const cloudApi = dbApiOf(path.join(CLOUD_DIR, 'db.js'));
  const serverApi = dbApiOf(path.join(SERVER_DIR, 'db.js'));
  if (!cloudApi || !serverApi) { console.log('  ✗ 有一侧 db.js 读不到或解析失败'); return 1; }

  let bad = 0;
  const RE = /\bdb\.([A-Za-z_$][\w$]*)\s*\(/g;
  // `typeof db.x !== 'function'` / `typeof db.x === 'function'` 包住的可选调用不算问题
  // （这是显式的跨端兼容写法：本地单实例缺这个方法也能正常工作）
  const GUARD = /typeof\s+db\.([A-Za-z_$][\w$]*)\s*[!=]==\s*['"]function['"]/g;
  for (const p of pairs) {
    for (const side of ['cloud', 'server']) {
      const raw = read(p[side]);
      if (!raw) continue;
      const api = side === 'cloud' ? cloudApi : serverApi;
      // 注释里的示例代码（如 `db.collection(...).watch()`）不是真实调用，先洗掉
      const src = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      const guarded = new Set();
      let g;
      while ((g = GUARD.exec(src)) !== null) guarded.add(g[1]);
      GUARD.lastIndex = 0;

      const missing = new Set();
      let m;
      while ((m = RE.exec(src)) !== null) {
        if (!api.has(m[1]) && !guarded.has(m[1])) missing.add(m[1]);
      }
      RE.lastIndex = 0;
      if (missing.size) {
        bad++;
        console.log(`  ✗ ${path.basename(p[side])}（${side === 'cloud' ? '云端' : '本地'}）` +
          ` 调了不存在的 db 方法：${[...missing].join(', ')}`);
      }
    }
  }
  if (!bad) console.log(`  ✓ 两侧共 ${pairs.length} 个路由文件，调用的 db 方法全部存在`);
  return bad;
}

// ============================ main ============================

function main() {
  console.log('云函数目录 : ' + rel(CLOUD_DIR));
  console.log('本地镜像   : ' + rel(SERVER_DIR));
  if (Object.keys(NAME_MAP).length) console.log('改名映射   : ' + Object.entries(NAME_MAP).map(([a, b]) => `${a} → ${b}`).join('、'));
  console.log('跳过（各自有意不同）: ' + [...SKIP_PAIR].join(', '));

  const pairs = buildPairs();
  const cloudFiles = pairs.map(p => ({ key: p.key, path: p.cloud }));
  const serverFiles = pairs.map(p => ({ key: p.key, path: p.server }));

  let bad = 0;
  bad += checkRoutes(pairs);
  bad += checkHooks(pairs, cloudFiles, serverFiles);
  bad += checkInterfaces(cloudFiles, serverFiles);
  bad += checkIdentical();
  bad += checkDbApi(pairs);

  console.log('');
  if (bad === 0) {
    console.log('✅ 云函数与本地镜像的「路由 / 互动 hook / 接口 / 共享数据层」全部一致');
    process.exit(0);
  }
  console.log(`❌ 发现 ${bad} 处不一致 —— 改业务逻辑时两侧必须同步（本项目硬约定，见脚本顶部说明）`);
  process.exit(1);
}

main();
