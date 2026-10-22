/**
 * 底部固定栏 / 安全区体检。
 *
 * 起因（真实事故）：
 *   发布页滚到底时，「我承诺…」那一行被底部按钮栏压住一截。
 *   原因：底部栏的 padding 都写了 env(safe-area-inset-bottom)，
 *   但页面级 `.footer-pad` **覆盖**了 app.wxss 里那份（全局那份是带 env 的），
 *   用的是写死的 rpx：
 *
 *       .footer { padding: 18rpx 24rpx calc(18rpx + env(safe-area-inset-bottom)); }  // 124rpx + 安全区
 *       .footer-pad { height: 180rpx; }                                              // 写死
 *
 *   于是在有底部横条的机型上（安全区约 65rpx），固定栏实际高 189rpx > 180rpx 的占位，
 *   最后一屏内容被压住。全项目 11 个页面里 **9 个**都有这个问题。
 *
 * 判据：
 *   1. 同一文件里，若固定底栏用了 env(safe-area-inset-bottom)，
 *      则页面自定义的 `*pad` 高度**必须也包含** env()。
 *      这样「占位 − 固定栏基础高度」这个余量才与机型无关。
 *   2. wxml 里用了 `*pad` 类，但该页 wxss 与 app.wxss 都没定义 → 完全没有占位。
 *
 * 用法：node tools/check-safe-area.js
 */
const fs = require('fs');
const path = require('path');

const MP = 'D:/wx/campus-xianyu/miniprogram';
const SAFE = /env\(safe-area-inset-bottom\)|constant\(safe-area-inset-bottom\)/;

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

const files = [];
(function walk(d) {
  for (const it of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, it.name);
    if (it.isDirectory()) walk(p);
    else files.push(p);
  }
})(MP);

const rel = (f) => f.replace(/\\/g, '/').replace(MP + '/', '');

/** 取某个 wxss 里的所有规则 {cls, body} */
function rules(src) {
  const out = [];
  const re = /\.([\w-]+)[^{},]*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src))) out.push({ cls: m[1], body: m[2] });
  return out;
}

/** app.wxss 里定义的 *pad 类（页面没自定义时会继承它） */
const appWxss = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8');
const globalPads = new Set(rules(stripComments(appWxss)).filter((r) => /pad$/i.test(r.cls)).map((r) => r.cls));

console.log('=== 1. 固定底栏算了安全区，页面自定义的占位也必须算 ===');
{
  const hits = [];
  let checked = 0;
  for (const f of files.filter((x) => x.endsWith('.wxss'))) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const rs = rules(src);
    const fixedBar = rs.find((r) => /position\s*:\s*fixed/.test(r.body) && /bottom\s*:\s*0/.test(r.body) && SAFE.test(r.body));
    if (!fixedBar) continue;
    const pads = rs.filter((r) => /pad$/i.test(r.cls) && /height/.test(r.body));
    for (const pad of pads) {
      checked++;
      if (!SAFE.test(pad.body)) {
        const h = (pad.body.match(/height\s*:\s*([^;]+)/) || [])[1] || '?';
        hits.push(rel(f) + '  .' + pad.cls + ' { height: ' + h.trim() + ' }   （固定栏 .' + fixedBar.cls + ' 已算安全区）');
      }
    }
  }
  if (hits.length) {
    no('发现 ' + hits.length + ' 处占位没算安全区（有底部横条的机型上会压住内容）：');
    hits.forEach((h) => console.log('      ' + h));
    console.log('      → 改成 height: calc(<原值> + env(safe-area-inset-bottom))');
  } else {
    ok('检查了 ' + checked + ' 处占位，均已包含 env(safe-area-inset-bottom)');
  }
}

console.log('\n=== 2. wxml 里用到的 *pad 类必须有定义（否则等于没有占位）===');
{
  const hits = [];
  let checked = 0;
  const defined = new Set();
  for (const f of files.filter((x) => x.endsWith('.wxss'))) {
    rules(stripComments(fs.readFileSync(f, 'utf8'))).forEach((r) => {
      if (/pad$/i.test(r.cls)) defined.add(rel(f).replace(/\.wxss$/, '.wxml') + '|' + r.cls);
    });
  }
  for (const f of files.filter((x) => x.endsWith('.wxml'))) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const used = new Set();
    const re = /class="([^"]*)"/g;
    let m;
    while ((m = re.exec(src))) {
      m[1].split(/\s+/).forEach((c) => { if (/pad$/i.test(c)) used.add(c); });
    }
    for (const cls of used) {
      checked++;
      const localOk = defined.has(rel(f) + '|' + cls);
      if (!localOk && !globalPads.has(cls)) {
        hits.push(rel(f) + '  用了 .' + cls + '，但本页 wxss 与 app.wxss 都没定义');
      }
    }
  }
  if (hits.length) {
    no('发现 ' + hits.length + ' 处「用了占位类但没定义」：');
    hits.forEach((h) => console.log('      ' + h));
  } else {
    ok('检查了 ' + checked + ' 处占位类引用，均有定义（或继承自 app.wxss）');
  }
}

console.log('\n=== 3. 固定底栏本身是否算了安全区 ===');
{
  const hits = [];
  let checked = 0;
  for (const f of files.filter((x) => x.endsWith('.wxss'))) {
    for (const r of rules(stripComments(fs.readFileSync(f, 'utf8')))) {
      if (!/position\s*:\s*fixed/.test(r.body) || !/bottom\s*:\s*0/.test(r.body)) continue;
      // 遮罩类（.mask）是全屏覆盖，不需要安全区
      if (/mask|overlay|modal/i.test(r.cls)) continue;
      if (/padding|height/.test(r.body)) {
        checked++;
        if (!SAFE.test(r.body)) {
          const p = (r.body.match(/padding\s*:\s*([^;]+)/) || [])[1];
          hits.push(rel(f) + '  .' + r.cls + '  padding: ' + (p ? p.trim() : '(无 padding)'));
        }
      }
    }
  }
  if (hits.length) {
    console.log('  ⚠️ 以下固定底栏没算安全区（内容会贴到系统手势条上）：');
    hits.forEach((h) => console.log('      ' + h));
  } else {
    ok('检查了 ' + checked + ' 个固定底栏，均已包含 env(safe-area-inset-bottom)');
  }
}

console.log('\n' + (bad ? '❌ ' + bad + ' 类问题需要修复' : '✅ 底部栏与安全区检查通过'));
process.exit(bad ? 1 : 0);
