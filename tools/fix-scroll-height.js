/**
 * 批量给横向 scroll-view 补显式高度。
 *
 * 原因：scroll-view 在 flex + nowrap 布局下若不设置高度会塌陷，
 * 子元素下半部分被裁掉（用户反馈「校园圈子字显示不完整」）。
 *
 * 高度按各自子元素实测结构计算，并配 box-sizing: border-box
 * 使高度包含 padding，避免重复撑高。
 */
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/wx/campus-xianyu/miniprogram/pages';

const FIXES = [
  { page: 'index',    cls: 'rt-scroll',     h: '86rpx'  },
  { page: 'chat',     cls: 'reco',          h: '310rpx' },
  { page: 'chat',     cls: 'my-list',       h: '210rpx' },
  { page: 'circle',   cls: 'topic-scroll',  h: '92rpx'  },
  { page: 'detail',   cls: 'd-rel',         h: '350rpx' },
  { page: 'zone',     cls: 'zone-scroll',   h: '92rpx'  },
  { page: 'orders',   cls: 'status-bar',    h: '90rpx'  },
  { page: 'resource', cls: 'cat-scroll',    h: '92rpx'  },
  { page: 'resource', cls: 'course-scroll', h: '78rpx'  }
];

let fixed = 0;
let skipped = 0;
let failed = 0;

for (const f of FIXES) {
  const file = path.join(ROOT, f.page, f.page + '.wxss');
  let src = fs.readFileSync(file, 'utf8');

  const esc = f.cls.replace(/-/g, '\\-');
  const re = new RegExp('(\\.' + esc + '\\s*\\{)([^}]*)');

  if (!re.test(src)) {
    console.log('  ❌ ' + f.page + ' .' + f.cls + ' 未找到规则');
    failed++;
    continue;
  }

  const m = src.match(re);
  if (/height\s*:/.test(m[2])) {
    console.log('  – ' + f.page + ' .' + f.cls + ' 已有高度，跳过');
    skipped++;
    continue;
  }

  src = src.replace(re, (all, head, body) => {
    // 去掉结尾多余空白，插入 height 与 box-sizing
    const trimmed = body.replace(/\s+$/, '');
    return head + trimmed + '\n  height: ' + f.h + ';\n  box-sizing: border-box;\n';
  });

  fs.writeFileSync(file, src);
  console.log('  ✓ ' + f.page + ' .' + f.cls + '  →  height: ' + f.h);
  fixed++;
}

console.log('\n修复 ' + fixed + ' 处，跳过 ' + skipped + ' 处' + (failed ? '，失败 ' + failed + ' 处' : ''));

/* 复核 */
console.log('\n=== 复核 ===');
let left = 0;
for (const f of FIXES) {
  const file = path.join(ROOT, f.page, f.page + '.wxss');
  const src = fs.readFileSync(file, 'utf8');
  const esc = f.cls.replace(/-/g, '\\-');
  const m = src.match(new RegExp('\\.' + esc + '\\s*\\{([^}]*)\\}'));
  if (m && /height\s*:/.test(m[1])) {
    const h = (m[1].match(/height\s*:\s*([^;]+)/) || [])[1];
    console.log('  ✓ ' + f.page + ' .' + f.cls + '  height: ' + h.trim());
  } else {
    console.log('  ❌ ' + f.page + ' .' + f.cls + ' 仍无高度');
    left++;
  }
}
console.log('\n' + (left || failed ? '❌ 仍有 ' + (left + failed) + ' 处问题' : '✅ 全部补齐'));
process.exit(left || failed ? 1 : 0);
