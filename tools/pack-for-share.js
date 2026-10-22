/**
 * 打包项目给团队成员（只含源码：不含依赖、本地数据、个人配置）
 *
 * 用法（在项目根目录）：
 *   node tools/pack-for-share.js
 *   node tools/pack-for-share.js --out D:\somewhere\share.zip
 * 产出：D:\wx\campus-xianyu-share.zip
 *
 * ── 为什么用 Node 而不是原来的 .ps1 ──────────────────────────────
 * 原来的 tools/pack-for-share.ps1 是坏的：它含中文注释但没有 BOM，
 * 而 PowerShell 5.1 在无 BOM 时按 ANSI 解码 .ps1，中文会被解码成乱码，
 * 并且乱码字符会「吃掉」后面的引号/换行，直接报
 *   MissingExpressionAfterToken / “,”后面缺少表达式
 * 这类莫名其妙的语法错误（git 里的原版同样没有 BOM，所以它本来就跑不起来）。
 * Node 读源码永远是 UTF-8，中文注释安全，而且本项目的工具链本来就全是 .js，
 * 统一用 Node 不会再碰到编码问题。
 *
 * ── 两个刻意的设计 ────────────────────────────────────────────
 * 1) 不建暂存目录、不做任何删除。
 *    旧版是「全量拷贝到临时目录 → 再删掉 node_modules」，既慢又脆：
 *    递归删除可能被环境的安全守卫拦截并 fail closed。
 *    这里改为**边遍历边过滤**，直接把条目写进 zip，不产生临时文件、不删任何东西。
 * 2) 打包结果必须与「从 git 全新 clone」一致，因此排除项严格对齐 .gitignore。
 *
 * ── 关于 ZIP 写入 ─────────────────────────────────────────────
 * 项目没有引入 zip 依赖，这里用一个极简实现（zlib deflateRaw + CRC32），
 * 只写必要字段，不依赖任何第三方包。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = 'D:\\wx\\campus-xianyu-share.zip';

/* ---------- 包含 / 排除 规则 ---------- */

// 要打包的顶层目录
const INCLUDE_DIRS = ['miniprogram', 'cloudfunctions', 'server', 'tools', 'automation', 'scripts'];

// 要打包的顶层文件
const INCLUDE_FILES = [
  'README.md',              // 仓库门面：项目简介 / 部署 / 运行 / 环境变量（竞赛明确要求）
  'project.config.json',   // 必需：appid / miniprogramRoot / cloudfunctionRoot
  'package.json',
  'package-lock.json',
  'start-admin.cmd',       // 本地管理后台一键启动（双击即可，否则对方要记 node 命令）
  'DEPLOY.md',             // 部署指南
  'TESTING.md',            // 测试与团队协作指南（含「新电脑上手清单」）
  '仪表盘使用.txt',         // 给分享对象的使用说明（怎么开本地仪表盘、账号密码 admin/admin）
  '.gitignore',            // 保持忽略规则一致
  '.gitattributes'         // 统一换行符
];

// 这些目录名在哪里出现都排除
const EXCLUDE_DIR_NAMES = new Set(['node_modules', 'miniprogram_npm']);

// 这些相对路径（正斜杠）连同其下内容一起排除
const EXCLUDE_REL_PATHS = [
  '_backup',           // 重构前的旧代码备份
  'tools/_archive',    // 一次性脚本归档
  'server/data',       // 本地运行时数据（含 session，属状态非源码）
  '.git', '.vscode', '.idea', '.wechatide', '.wxcloud'
];

// 精确排除的文件
const EXCLUDE_FILES = new Set([
  'project.private.config.json',   // 个人本地配置，开发者工具导入时自动生成
  'server/.cloudbase.json',        // ⚠️ 云端 API Key（管理员权限），绝不能进分享包
  '.env', '.env.local'             // 环境变量里的凭据同理
]);

function isExcluded(rel) {
  if (EXCLUDE_FILES.has(rel)) return true;
  for (const p of EXCLUDE_REL_PATHS) {
    if (rel === p || rel.startsWith(p + '/')) return true;
  }
  for (const seg of rel.split('/')) {
    if (EXCLUDE_DIR_NAMES.has(seg)) return true;
  }
  return false;
}

/* ---------- 极简 ZIP 写入 ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

/** DOS 时间/日期（zip 用的老格式，只能表示 1980-2107） */
function dosDateTime(date) {
  const y = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2));
  const d = ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xFFFF, date: d & 0xFFFF };
}

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xFFFF, 0); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };

/**
 * 写 zip。
 * @param {Array<{full:string, rel:string}>} entries
 * @param {string} outPath
 */
function writeZip(entries, outPath) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const data = fs.readFileSync(e.full);
    const nameBuf = Buffer.from(e.rel, 'utf8');
    const crc = crc32(data);

    // 压缩方法 8（deflate）；压缩后反而更大就用 0（store）
    let method = 8;
    let payload = zlib.deflateRawSync(data, { level: 9 });
    if (payload.length >= data.length) { method = 0; payload = data; }

    const { time, date } = dosDateTime(fs.statSync(e.full).mtime);

    // flag 0x0800 = 文件名按 UTF-8 编码
    const local = Buffer.concat([
      u32(0x04034b50),      // local file header signature
      u16(20),              // version needed
      u16(0x0800),          // general purpose flags
      u16(method),
      u16(time), u16(date),
      u32(crc),
      u32(payload.length),  // compressed size
      u32(data.length),     // uncompressed size
      u16(nameBuf.length),
      u16(0),               // extra length
      nameBuf
    ]);

    locals.push(local, payload);

    centrals.push(Buffer.concat([
      u32(0x02014b50),      // central directory signature
      u16(20),              // version made by
      u16(20),              // version needed
      u16(0x0800),
      u16(method),
      u16(time), u16(date),
      u32(crc),
      u32(payload.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),               // extra
      u16(0),               // comment
      u16(0),               // disk number start
      u16(0),               // internal attrs
      u32(0),               // external attrs
      u32(offset),          // local header offset
      nameBuf
    ]));

    offset += local.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32(centralBuf.length),
    u32(offset),
    u16(0)
  ]);

  fs.writeFileSync(outPath, Buffer.concat([...locals, centralBuf, eocd]));
}

/** 回读 zip 的中央目录做校验（确认真的写对了，而不是只看文件存在） */
function verifyZip(zipPath, expectCount, requiredRels) {
  const buf = fs.readFileSync(zipPath);
  const i = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (i < 0) throw new Error('找不到 ZIP 结束记录（EOCD），文件可能不完整');

  const total = buf.readUInt16LE(i + 10);
  const cdSize = buf.readUInt32LE(i + 12);
  const cdOffset = buf.readUInt32LE(i + 16);
  if (total !== expectCount) throw new Error('条目数不符：zip 内 ' + total + '，预期 ' + expectCount);
  if (cdOffset + cdSize + 22 !== buf.length) throw new Error('ZIP 结构长度不自洽');

  // 从中央目录里收集文件名
  const names = new Set();
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录第 ' + n + ' 项签名错误');
    const nameLen = buf.readUInt16LE(p + 28);
    names.add(buf.slice(p + 46, p + 46 + nameLen).toString('utf8'));
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    p += 46 + nameLen + extraLen + commentLen;
  }
  const missing = requiredRels.filter((r) => !names.has(r));
  if (missing.length) throw new Error('zip 内缺少必需条目：' + missing.join(', '));

  // 确认没有把依赖和个人配置打进去
  for (const nm of names) {
    if (nm.includes('/node_modules/')) throw new Error('zip 内混入了依赖：' + nm);
    if (nm === 'project.private.config.json') throw new Error('zip 内混入了个人配置');
  }
  return { total, cdSize, cdOffset };
}

/* ---------- 主流程 ---------- */

function collect() {
  const entries = [];
  const skipped = [];

  const walk = (abs, rel) => {
    for (const item of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? rel + '/' + item.name : item.name;
      if (isExcluded(childRel)) { skipped.push(childRel); continue; }
      const childAbs = path.join(abs, item.name);
      if (item.isDirectory()) walk(childAbs, childRel);
      else if (item.isFile()) entries.push({ full: childAbs, rel: childRel });
    }
  };

  for (const d of INCLUDE_DIRS) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walk(abs, d);
    else console.log('  - 跳过（目录不存在）: ' + d);
  }
  for (const f of INCLUDE_FILES) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs)) entries.push({ full: abs, rel: f });
    else console.log('  - 跳过（文件不存在）: ' + f);
  }
  return { entries, skipped };
}

function main() {
  const outArg = process.argv.indexOf('--out');
  const out = outArg > -1 && process.argv[outArg + 1] ? path.resolve(process.argv[outArg + 1]) : DEFAULT_OUT;

  console.log('=== 1. 边遍历边过滤（不建暂存目录、不删任何文件）===');
  const { entries, skipped } = collect();
  const rawBytes = entries.reduce((s, e) => s + fs.statSync(e.full).size, 0);
  console.log('  收集 ' + entries.length + ' 个文件，' + (rawBytes / 1024 / 1024).toFixed(2) + ' MB（未压缩）');
  console.log('  排除 ' + skipped.length + ' 个路径，例如：');
  skipped.slice(0, 6).forEach((s) => console.log('    - ' + s));
  if (skipped.length > 6) console.log('    ... 另有 ' + (skipped.length - 6) + ' 个');

  console.log('=== 2. 打包前自检（不通过就不生成 zip）===');
  const present = new Set(entries.map((e) => e.rel));
  const required = [
    'project.config.json',
    'miniprogram/app.json',
    'cloudfunctions/campus/index.js',
    'cloudfunctions/campus/package.json',
    'TESTING.md',
    'DEPLOY.md'
  ];
  const problems = [];
  if (present.has('project.private.config.json')) {
    problems.push('混入了 project.private.config.json（个人本地配置）');
  }
  if (![...present].some((r) => r.startsWith('server/static/img/'))) {
    problems.push('缺少 server/static/img（上传云存储用的种子图片，少了图片会全白）');
  }
  if (![...present].some((r) => r.startsWith('cloudfunctions/campus/') && r.endsWith('.js'))) {
    problems.push('cloudfunctions/campus 下没有 .js');
  }

  if (problems.length) {
    console.log('  自检未通过：');
    problems.forEach((p) => console.log('    x ' + p));
    process.exit(1);
  }

  // ⚠️ 凭据泄露检查：server/.cloudbase.json 里是 CloudBase 的 API Key
  //（管理员权限、长期有效）。它已在 .gitignore 与排除清单里，
  // 这里再兜一道：万一排除规则被改动，也绝不让它进包。
  const leaked = [...present].filter((r) => /(^|\/)\.cloudbase\.json$/.test(r) || /(^|\/)\.env(\.local)?$/.test(r));
  if (leaked.length) {
    console.log('  自检未通过（凭据泄露风险）：');
    leaked.forEach((r) => console.log('    x 包内含有凭据文件：' + r));
    console.log('    请检查 EXCLUDE_FILES 与 .gitignore');
    process.exit(1);
  }
  console.log('  通过（必需文件在 / 无依赖 / 无个人配置 / 无凭据泄露 / 种子图片在）');

  console.log('=== 3. 写入 zip（无临时目录、无删除）===');
  const dir = path.dirname(out);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(out)) console.log('  已存在同名文件，将被覆盖');
  writeZip(entries, out);

  console.log('=== 4. 回读校验 ===');
  const v = verifyZip(out, entries.length, required);
  const zipBytes = fs.statSync(out).size;
  console.log('  ✓ 中央目录 ' + v.total + ' 项全部可读，必需条目齐全，无依赖残留');

  console.log('');
  console.log('完成：' + out);
  console.log('  ' + entries.length + ' 个文件，压缩后 ' + (zipBytes / 1024 / 1024).toFixed(2) + ' MB');
  console.log('');
  console.log('  包内顶层内容：');
  for (const d of INCLUDE_DIRS) {
    const n = entries.filter((e) => e.rel === d || e.rel.startsWith(d + '/')).length;
    console.log('    [目录] ' + d.padEnd(16) + n + ' 个文件');
  }
  for (const f of INCLUDE_FILES) {
    if (present.has(f)) console.log('    [文件] ' + f);
  }
  console.log('');
  console.log('  对方拿到后：解压 → 微信开发者工具导入（选项目根目录）→ 见 TESTING.md 第二节。');
}

main();
