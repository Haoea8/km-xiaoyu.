/**
 * 布局自适应性体检。
 *
 * 起因（真实事故）：
 *   个人主页的「在售宝贝」是 2 列网格，代码写着
 *       .grid    { display:flex; flex-wrap:wrap; gap:20rpx; padding:0 24rpx; }
 *       .g-card  { width: calc(50% - 10rpx); }
 *   算下来 2×(50%−10rpx) + 20rpx = 100% —— **刚好铺满，一点余量都没有**。
 *   rpx 换算成 px 会出现小数，不同机型取整后总和略微超过容器宽度，
 *   第二张卡就被挤到下一行 → 用户看到「这个不同手机不适配，一行只有一个」。
 *
 * 判据（本脚本实现）：
 *      每行总宽 = N × (百分比 − X rpx) + (N−1) × gap
 *      余量     = N·X − (N−1)·gap
 *   余量必须 ≥ 8rpx，否则取整误差就可能让它溢出换行。
 *   （8rpx 在最窄的常见机型 320px 上约 3.4px，足够吸收取整误差。）
 *
 * 覆盖：
 *   1. 百分比网格的余量（上面这条，会真正导致换行）
 *   2. 用 px 写尺寸（不随屏幕缩放，大屏上会显得很小）
 *   3. 固定宽度超过屏幕（750rpx 基准）
 *
 * 用法：node tools/check-adaptive.js
 */
const fs = require('fs');
const path = require('path');

const MP = 'D:/wx/campus-xianyu/miniprogram';

/** 余量下限（rpx）。低于它就有取整溢出的风险。 */
const MIN_SLACK = 8;
/** 常见机型宽度（px），用于把 rpx 余量换算成真实像素，判断是否够用 */
const DEVICE_WIDTHS = [320, 360, 375, 393, 414, 430, 768];

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };
const warn = (m) => console.log('  ⚠️  ' + m);

const files = [];
(function walk(d) {
  for (const it of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, it.name);
    if (it.isDirectory()) walk(p);
    else if (it.name.endsWith('.wxss')) files.push(p);
  }
})(MP);

const rel = (f) => f.replace(/\\/g, '/').replace(MP + '/', '');

/** rpx → px（按 750rpx = 屏宽 换算） */
const rpxToPx = (rpx, screenWidth) => (rpx * screenWidth) / 750;

/**
 * 把注释清成空白（保留换行，行号不变）。
 *
 * 必须做：否则「说明为什么不能写成 calc(50% - 10rpx)」这类注释
 * 会被当成真的违规代码报出来（这个假报错我踩过）。
 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

console.log('=== 1. 百分比网格必须留有余量 ===');
{
  const problems = [];
  let checked = 0;

  for (const f of files) {
    const lines = stripComments(fs.readFileSync(f, 'utf8')).split('\n');

    lines.forEach((line, i) => {
      const m = line.match(/calc\(\s*([\d.]+)%\s*-\s*([\d.]+)rpx\s*\)/);
      if (!m) return;
      const pct = parseFloat(m[1]);
      const sub = parseFloat(m[2]);
      if (!pct) return;

      // 由百分比推断每行几张：50% → 2 张，33.333% → 3 张，25% → 4 张
      const n = Math.round(100 / pct);
      if (n < 2 || Math.abs(100 / pct - n) > 0.01) return;   // 不是整齐的等分，跳过

      // 取「本行之前最近的一个 gap 值」——这些网格的容器规则就写在同一文件里、
      // 且紧邻在项目规则之前（见各文件的实际写法）
      let gap = null;
      for (let k = i; k >= 0; k--) {
        const g = lines[k].match(/\bgap\s*:\s*([\d.]+)rpx/);
        if (g) { gap = parseFloat(g[1]); break; }
      }
      if (gap === null) return;

      checked++;
      const slack = n * sub - (n - 1) * gap;      // 余量
      if (slack < MIN_SLACK) {
        problems.push({
          file: rel(f), line: i + 1, n, pct, sub, gap, slack,
          px320: rpxToPx(slack, 320),
          code: line.trim()
        });
      }
    });
  }

  if (problems.length) {
    no('发现 ' + problems.length + ' 处「刚好铺满」，取整后会换行：');
    for (const p of problems) {
      // 反解：余量 = N·X − (N−1)·gap ≥ MIN_SLACK  →  X ≥ ((N−1)·gap + MIN_SLACK) / N
      const needX = Math.ceil(((p.n - 1) * p.gap + MIN_SLACK) / p.n);
      console.log('      ' + p.file + ':' + p.line + '  每行 ' + p.n + ' 张  余量 ' + p.slack + 'rpx'
        + '（320px 机型上仅 ' + p.px320.toFixed(2) + 'px）');
      console.log('        ' + p.code);
      console.log('        → 把 ' + p.sub + 'rpx 改成 ' + needX + 'rpx（余量 ' + MIN_SLACK + 'rpx）');
    }
  } else {
    ok('检查了 ' + checked + ' 处百分比网格，余量均 ≥ ' + MIN_SLACK + 'rpx');
  }
}

console.log('\n=== 2. 不要用 px 写布局尺寸（不随屏幕缩放） ===');
{
  // 边界/圆角/阴影用 px 尚可接受，但 width/height/margin/padding/font-size 用 px
  // 会导致大屏上偏小、小屏上偏大。统一用 rpx。
  const hits = [];
  for (const f of files) {
    stripComments(fs.readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
      const m = line.match(/\b(width|height|min-width|min-height|max-width|max-height|margin|padding|font-size)\s*:\s*[^;]*?(\d+)px/);
      if (m) hits.push({ file: rel(f), line: i + 1, code: line.trim() });
    });
  }
  if (hits.length) {
    warn('发现 ' + hits.length + ' 处用 px 写尺寸（建议改 rpx）：');
    hits.slice(0, 10).forEach((h) => console.log('      ' + h.file + ':' + h.line + '  ' + h.code));
    if (hits.length > 10) console.log('      ... 另有 ' + (hits.length - 10) + ' 处');
  } else {
    ok('没有用 px 写布局尺寸');
  }
}

console.log('\n=== 3. 固定宽度不得超过屏幕（750rpx） ===');
{
  const hits = [];
  for (const f of files) {
    stripComments(fs.readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
      const m = line.match(/\bwidth\s*:\s*(\d+)rpx/);
      if (m && Number(m[1]) > 750) hits.push({ file: rel(f), line: i + 1, w: m[1], code: line.trim() });
    });
  }
  if (hits.length) {
    no('发现 ' + hits.length + ' 处固定宽度超过 750rpx（小屏会被裁掉）：');
    hits.forEach((h) => console.log('      ' + h.file + ':' + h.line + '  ' + h.code));
  } else {
    ok('没有超过 750rpx 的固定宽度');
  }
}

console.log('\n=== 4. 双列瀑布流：卡片必须等高（否则越滚越错位） ===');
{
  // 起因（真实事故）：首页「为你推荐 / 全部好物」是两列各自独立的 flex 列。
  // 卡片标题只写了 ellipsis2（1~2 行自适应），于是「1 行标题」的卡比
  // 「2 行标题」的矮 39rpx；两列各自向前排，每错开一次就累积 39rpx，
  // 表现就是用户说的「越往下拉越长、还不对齐」。
  //
  // 判据：在「多列布局」（wxss 里定义了 ≥2 个 .xxx-col 且 flex-direction: column）
  // 中，凡是用到「限行类」（app.wxss 里声明了 -webkit-line-clamp 的类，
  // 如 ellipsis2 / ellipsis3）的元素，**必须**有一个自己的类声明固定
  // height 或 min-height —— 否则卡片高度会随文案行数变化。
  //
  // 注意：限行属性来自 app.wxss 的全局类（wxml 里和业务类一起用），
  // 所以必须**从 wxml 读实际用了哪些限行类**，只扫 wxss 会漏。

  // 1) 先找出「限行类」有哪些（从 app.wxss）
  const appWxssPath = path.join(MP, 'app.wxss');
  const clampClasses = new Set(
    [...stripComments(fs.readFileSync(appWxssPath, 'utf8')).matchAll(/\.([\w-]+)[^{},]*\{([^}]*)\}/g)]
      .filter((m) => /-webkit-line-clamp/.test(m[2]))
      .map((m) => m[1])
  );

  const hits = [];
  let checked = 0;
  let scannedFiles = 0;

  // 注意：上面的 files 只收集了 .wxss，这里要单独收集 .wxml
  const wxmlFiles = [];
  (function walk(d) {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else if (it.name.endsWith('.wxml')) wxmlFiles.push(p);
    }
  })(MP);

  /** 极简标签扫描：带出每个元素的 class 与父链，用来判断「谁在谁里面」 */
  function scanTags(src) {
    const out = [];
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
    const stack = [];
    let m;
    const selfClosing = /^(image|input|icon|import|include|wxs|slot|checkbox|radio|switch|progress|slider|audio|video|camera|canvas|map|web-view|ad|official-account|open-data|navigation-bar|page-meta)$/;
    while ((m = re.exec(src))) {
      if (m[1] === '/') { stack.pop(); continue; }
      const attrs = m[3];
      const cm = attrs.match(/class="([^"]*)"/);
      const node = {
        cls: cm ? cm[1] : '',
        index: m.index,
        parent: stack[stack.length - 1] || null
      };
      out.push(node);
      if (m[4] !== '/' && !selfClosing.test(m[2])) stack.push(node);
    }
    return out;
  }

  const tokensOf = (attr) => attr.split(/[\s{}?:'"]+/).filter(Boolean);

  for (const f of wxmlFiles) {
    const wxml = stripComments(fs.readFileSync(f, 'utf8'));
    const wxssPath = f.replace(/\.wxml$/, '.wxss');
    if (!fs.existsSync(wxssPath)) continue;
    const rules = [...stripComments(fs.readFileSync(wxssPath, 'utf8')).matchAll(/\.([\w-]+)[^{},]*\{([^}]*)\}/g)]
      .map((m2) => ({ cls: m2[1], body: m2[2] }));

    const nodes = scanTags(wxml);

    // 统计每个 *-col 类在**源码里**出现几次
    // （wx:for 里写一次也算一次 —— 两列共用一条 .wf-col 规则、模板里出现 2 次）
    const colUsage = {};
    for (const n of nodes) {
      for (const t of tokensOf(n.cls)) if (/-col$/.test(t)) colUsage[t] = (colUsage[t] || 0) + 1;
    }
    const colClasses = Object.keys(colUsage).filter((c) => colUsage[c] >= 2);
    if (!colClasses.length) continue;
    const isColumnFlex = (c) => {
      const r = rules.find((x) => x.cls === c);
      return r && /flex-direction\s*:\s*column/.test(r.body);
    };
    if (!colClasses.some(isColumnFlex)) continue;        // 不是「各自向前排」的列布局
    scannedFiles++;

    for (const n of nodes) {
      const tokens = tokensOf(n.cls);
      const usesClamp = tokens.filter((t) => clampClasses.has(t));
      if (!usesClamp.length) continue;

      // ★ 只查「真的在瀑布流列里面」的元素：
      //   沿父链找，只要有某个祖先类是「用了 ≥2 次 + flex-direction: column」，就算。
      //   （不能只用「这个页面有瀑布流」来判定 —— 否则会把同页其它区的
      //     限行文本（如校园热帖的 .hp-content）一起误报。）
      let inColumn = false;
      for (let a = n.parent; a; a = a.parent) {
        for (const t of tokensOf(a.cls)) {
          if (colClasses.includes(t) && isColumnFlex(t)) { inColumn = true; break; }
        }
        if (inColumn) break;
      }
      if (!inColumn) continue;

      checked++;
      const own = tokens.filter((t) => !clampClasses.has(t) && /^[\w-]+$/.test(t));
      // ⚠️ 必须用 (^|[;\s]) 锚定属性名开头 ——
      // 直接写 \bheight\s*: 会匹配到 line-height: 里的 "height:"，
      // 于是有 line-height 的元素全被误判成「已固定高度」（这个假通过我踩过）。
      const hasFixedH = own.some((t) => {
        const r = rules.find((x) => x.cls === t);
        return r && /(?:^|[;\s])(?:min-)?height\s*:/.test(r.body);
      });
      if (!hasFixedH) {
        hits.push({ file: rel(f), cls: own.join(' ') || '(无自有类)', clamp: usesClamp.join(' ') });
      }
    }
  }

  if (scannedFiles === 0) {
    warn('没有找到多列瀑布流布局，本节跳过（若首页瀑布流被移除属正常）');
  } else if (hits.length) {
    no('发现 ' + hits.length + ' 处「限行文本没有固定高度」（卡片高矮不一 → 两列越滚越错位）：');
    hits.forEach((h) => console.log('      ' + h.file + '  .' + h.cls + '  （用了 ' + h.clamp + '）'));
    console.log('      → 给它加 height: <行数 × line-height>，并把 line-height 写成 rpx，');
    console.log('        例如 2 行：line-height: 38rpx; height: 76rpx; overflow: hidden;');
  } else {
    ok('检查了 ' + scannedFiles + ' 个多列页面、' + checked + ' 处限行文本，均有固定高度（卡片等高）');
  }
}

console.log('\n' + (bad ? '❌ ' + bad + ' 类问题需要修复' : '✅ 布局自适应检查通过'));
process.exit(bad ? 1 : 0);
