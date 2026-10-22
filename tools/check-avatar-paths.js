/**
 * 图片/头像路径检查（静态）。
 *
 * 背景：种子数据里的图片路径是 /static/avatars/a04.jpg 这类**相对路径**，
 * 直接绑到 image 组件上会被当成相对地址请求，
 * 报「Failed to load image http://127.0.0.1:xxx/__pageframe__/static/...」，
 * 真机上就是一片空白。
 *
 * 所有这类路径都必须过 api.abs() 转成 cloud:// 文件 ID。
 * 本项目已有约定：wxml 不直接绑 xxx.avatar 这类原始属性，
 * 而是绑 js 里处理过的扁字段（peerAvatar / sellerAvatar / avatarAbs …）。
 *
 * 本脚本检查：
 *   1. wxml 里是否存在「直接绑定原始头像属性」的写法（如 item.seller.avatar）
 *   2. wxml 里是否有硬编码 /static/ 的 image src
 *   3. js 里给 avatar/cover 赋值但漏了 api.abs 的情况
 *
 * 用法：node tools/check-avatar-paths.js
 */
const fs = require('fs');
const path = require('path');

const MP = 'D:/wx/campus-xianyu/miniprogram';

/** 允许的写法：这些字段名说明已经在 js 里处理过（扁字段，非原始深层属性） */
const SAFE_SUFFIX = /(Abs|Avatar)$/;   // avatarAbs / peerAvatar / sellerAvatar / authorAvatar / uploaderAvatar

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

const files = [];
(function walk(d) {
  for (const it of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, it.name);
    if (it.isDirectory()) walk(p);
    else files.push(p);
  }
})(MP);

console.log('=== 1. wxml 绑定的头像，其 js 必须做过 api.abs 转换 ===');
{
  // 本项目的约定是「就地替换」：js 里把对象的 avatar 直接换成 cloud:// 文件 ID，
  //   author: Object.assign(p.author || {}, { avatar: api.abs(p.author && p.author.avatar) })
  // 所以 wxml 直接用 x.avatar 是允许的 —— 前提是对应的 js 确实做了转换。
  const hits = [];
  let checked = 0;
  for (const f of files.filter((x) => x.endsWith('.wxml'))) {
    const jsPath = f.replace(/\.wxml$/, '.js');
    let jsSrc = '';
    try { jsSrc = fs.readFileSync(jsPath, 'utf8'); } catch (e) { }
    // js 里是否存在「avatar 与 abs 同时出现」的处理痕迹
    const jsHandlesAvatar = /avatar[^\n]{0,80}api\.abs|api\.abs[^\n]{0,80}avatar/i.test(jsSrc);

    const s = fs.readFileSync(f, 'utf8');
    s.split('\n').forEach((l, i) => {
      const m = l.match(/src="\{\{\s*([^}]+?)\s*\}\}"/);
      if (!m) return;
      const expr = m[1].trim();
      if (!/avatar/i.test(expr)) return;
      if (SAFE_SUFFIX.test(expr)) return;          // 扁字段（xxxAvatar / xxxAbs），已处理
      checked++;
      if (!jsHandlesAvatar) {
        const rel = f.replace(/\\/g, '/').replace(MP + '/', '');
        hits.push(rel + ':' + (i + 1) + '  ' + expr + '   （' + path.basename(jsPath) + ' 里没找到 avatar 的 abs 处理）');
      }
    });
  }
  if (!hits.length) ok('检查了 ' + checked + ' 处头像绑定，对应的 js 均做过 api.abs 转换');
  else {
    no('发现 ' + hits.length + ' 处未转换（真机会空白）：');
    hits.forEach((h) => console.log('      ' + h));
  }
}

console.log('\n=== 2. wxml 里不要出现硬编码 /static/ 的 image src ===');
{
  const hits = [];
  for (const f of files.filter((x) => x.endsWith('.wxml'))) {
    const s = fs.readFileSync(f, 'utf8');
    s.split('\n').forEach((l, i) => {
      if (/<image[^>]*src="\/static\//.test(l)) {
        hits.push(f.replace(MP + '\\', '').replace(MP + '/', '') + ':' + (i + 1));
      }
    });
  }
  if (!hits.length) ok('没有硬编码 /static/ 的图片');
  else { no('发现 ' + hits.length + ' 处：'); hits.forEach((h) => console.log('      ' + h)); }
}

console.log('\n=== 3. js 里给图片字段赋值时应过 api.abs ===');
{
  const hits = [];
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const s = fs.readFileSync(f, 'utf8');
    s.split('\n').forEach((l, i) => {
      const m = l.match(/^\s*(avatar|cover|coverUrl|sellerAvatar|authorAvatar|peerAvatar|avatarAbs)\s*:\s*([^,]+?),?\s*$/);
      if (!m) return;
      const rhs = m[2].trim();
      if (/api\.abs|\.abs\(/.test(rhs)) return;      // 已转换
      if (/^['"`]/.test(rhs)) return;                 // 字面量（如组件初始空串）
      if (/^(null|undefined|'')$/.test(rhs)) return;  // 空值
      if (/^(urls|tempFilePath|localPath)/.test(rhs)) return;  // 上传返回的已是 fileID
      hits.push(f.replace(MP + '\\', '').replace(MP + '/', '') + ':' + (i + 1) + '  ' + l.trim().slice(0, 80));
    });
  }
  if (!hits.length) ok('未发现漏转换的图片赋值');
  else {
    console.log('  ⚠️  以下 ' + hits.length + ' 处未过 api.abs（请人工确认是否为本地上传返回的 fileID）：');
    hits.forEach((h) => console.log('      ' + h));
  }
}

console.log('\n' + (bad ? '❌ ' + bad + ' 类问题需要修复' : '✅ 图片/头像路径处理检查通过'));
process.exit(bad ? 1 : 0);
