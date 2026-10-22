/**
 * 检查「横向 scroll-view」是否设置了显式高度。
 *
 * 背景：横向 scroll-view 不给高度时，在 flex / nowrap 场景下会塌陷，
 * 子元素下半部分被裁掉（用户反馈过「校园圈子字显示不完整」）。
 *
 * 判定方式：**动态扫描 wxml** 找出所有 `<scroll-view scroll-x>`，
 * 再去对应 wxss 里检查它的 class 有没有声明 height / max-height。
 *
 * 为什么不用硬编码清单：原来这里是一张手写的 [页面, class] 列表，
 * 一旦某个 scroll-view 被改成普通 view（或 class 改名），清单就过时了 ——
 * 会对着一个已经不是 scroll-view 的元素报「缺少高度」（假报错）。
 * 动态扫描不会过时，而且新加的横向 scroll-view 也会被自动覆盖。
 *
 * 只检查**横向**（scroll-x）：纵向 scroll-view 通常靠 flex:1 撑开，
 * 强制要求固定高度会误报。
 */
const fs = require('fs');
const path = require('path');

const MP = 'D:/wx/campus-xianyu/miniprogram';
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

/** 收集所有 wxml */
const wxmls = [];
(function walk(d) {
  for (const it of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, it.name);
    if (it.isDirectory()) { if (it.name !== 'node_modules') walk(p); }
    else if (it.name.endsWith('.wxml')) wxmls.push(p);
  }
})(MP);

console.log('=== 横向 scroll-view 高度检查（动态扫描）===');
let checked = 0;
for (const wxml of wxmls) {
  const src = stripComments(fs.readFileSync(wxml, 'utf8'));
  // 抓取所有 scroll-view 开标签
  const tags = src.match(/<scroll-view\b[^>]*>/g) || [];
  if (!tags.length) continue;

  const wxssPath = wxml.replace(/\.wxml$/, '.wxss');
  const wxss = fs.existsSync(wxssPath) ? stripComments(fs.readFileSync(wxssPath, 'utf8')) : '';
  const rel = (f) => f.replace(/\\/g, '/').replace(MP + '/', '');

  for (const tag of tags) {
    const isX = /\bscroll-x\b/.test(tag);
    if (!isX) continue;                                   // 只查横向
    const cm = tag.match(/class="([^"]*)"/);
    if (!cm) continue;
    const cls = cm[1].split(/[\s{}?:'"]+/).filter((c) => /^[a-z][\w-]*$/i.test(c))[0];
    if (!cls) continue;
    checked++;

    // 在页面 wxss 与 app.wxss 里找该 class 的规则
    const appWxss = stripComments(fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8'));
    const rule = (src2) => {
      const m = src2.match(new RegExp('\\.' + cls.replace(/-/g, '\\-') + '\\s*\\{([^}]*)\\}'));
      return m ? m[1] : null;
    };
    const body = rule(wxss) || rule(appWxss);

    if (!body) {
      no(rel(wxml) + '  .' + cls + '  横向 scroll-view 但没有找到样式规则');
      continue;
    }
    const h = (body.match(/(^|;)\s*(max-)?height\s*:\s*([^;]+)/) || [])[3];
    if (h) ok(rel(wxml) + '  .' + cls + '  height: ' + h.trim());
    else no(rel(wxml) + '  .' + cls + '  缺少 height（横向滚动会塌陷、内容被裁）');
  }
}

if (!checked) console.log('  （没有找到横向 scroll-view）');
console.log('\n' + (bad ? '❌ ' + bad + ' 处需要补高度' : '✅ 全部横向 scroll-view 已设置高度（共 ' + checked + ' 个）'));
process.exit(bad ? 1 : 0);
