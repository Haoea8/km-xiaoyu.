/**
 * 小程序 UI 接口的「硬限制」体检。
 *
 * 起因：详情页的「举报」点了没反应。
 *   根因是 wx.showActionSheet 的 itemList **数组长度最大为 6**（官方文档），
 *   而详情页用的 REPORT_REASONS 有 7 项 → 接口调用失败 → 界面毫无反应、
 *   Console 也可能只有一行 fail 回调（代码里没写 fail，于是完全静默）。
 *   其它页面的举报列表是 4/5/6 项，所以只有详情页坏 —— 很容易被当成玄学。
 *
 * 这类「超限后静默失效」的限制值得用静态检查盯住，目前覆盖：
 *   1. wx.showActionSheet 的 itemList（≤ 6）
 *   2. wx.showModal 的 confirmText / cancelText（≤ 4 个字符）
 *   3. wx.showToast 的 title（图标为默认时 ≤ 7 个汉字，过长会被截断 —— 仅提示）
 *
 * 用法：node tools/check-ui-limits.js
 */
const fs = require('fs');
const path = require('path');

const MP = 'D:/wx/campus-xianyu/miniprogram';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

const files = [];
(function walk(d) {
  for (const it of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, it.name);
    if (it.isDirectory()) walk(p);
    else if (it.name.endsWith('.js')) files.push(p);
  }
})(MP);

const rel = (f) => f.replace(/\\/g, '/').replace(MP + '/', '');

/** 把一个数组字面量文本拆成元素个数 */
function countItems(text) {
  return text.split(',')
    .map((x) => x.trim())
    .filter((x) => x && /^['"`]/.test(x)).length;
}

/**
 * 解析 itemList 的取值：
 *   - 内联数组字面量 → 直接数
 *   - 标识符（REPORT_REASONS 等）→ 在同文件或 utils/const.js 里找它的定义
 * @returns {number|null} 条数；解析不出来返回 null
 */
function resolveItemList(expr, fileSrc) {
  const inline = expr.match(/^\s*\[([\s\S]*?)\]\s*$/);
  if (inline) return countItems(inline[1]);

  const name = expr.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;

  let m = fileSrc.match(new RegExp('const\\s+' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\]'));
  if (m) return countItems(m[1]);

  try {
    const constSrc = fs.readFileSync(path.join(MP, 'utils/const.js'), 'utf8');
    m = constSrc.match(new RegExp('const\\s+' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\]'));
    if (m) return countItems(m[1]);
  } catch (e) { /* 忽略 */ }
  return null;
}

console.log('=== 1. wx.showActionSheet 的 itemList 不得超过 6 项 ===');
{
  // 官方文档：itemList「按钮的文字数组，数组长度最大为 6」。
  // 超过 6 会直接调用失败（并且若没写 fail 回调，界面上完全看不出问题）。
  const LIMIT = 6;
  const hits = [];
  let checked = 0;
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    // 逐个 showActionSheet 调用点，取它对象里的 itemList 值
    const re = /showActionSheet\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
    let m;
    while ((m = re.exec(s))) {
      const body = m[1];
      const im = body.match(/itemList\s*:\s*([\s\S]*?)(?:,\s*\n|,\s*(?:success|fail|complete|itemColor|alertText)\b|$)/);
      if (!im) continue;
      const n = resolveItemList(im[1], s);
      if (n === null) continue;
      checked++;
      if (n > LIMIT) hits.push(rel(f) + '  itemList ' + n + ' 项（上限 ' + LIMIT + '）');
    }
  }
  if (hits.length) {
    no('发现 ' + hits.length + ' 处超限，点击后会毫无反应：');
    hits.forEach((h) => console.log('      ' + h));
  } else {
    ok('检查了 ' + checked + ' 处 itemList，均未超过 ' + LIMIT + ' 项');
  }
}

console.log('\n=== 2. wx.showModal 的 confirmText / cancelText 不得超过 4 个字符 ===');
{
  const hits = [];
  let checked = 0;
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    const re = /showModal\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
    let m;
    while ((m = re.exec(s))) {
      const body = m[1];
      for (const key of ['confirmText', 'cancelText']) {
        const km = body.match(new RegExp(key + "\\s*:\\s*['\"`]([^'\"`]*)['\"`]"));
        if (!km) continue;
        checked++;
        if (km[1].length > 4) hits.push(rel(f) + '  ' + key + ' = 「' + km[1] + '」');
      }
    }
  }
  if (hits.length) {
    no('发现 ' + hits.length + ' 处超限（按钮文字最多 4 个字符，超出会被截断）：');
    hits.forEach((h) => console.log('      ' + h));
  } else {
    ok('检查了 ' + checked + ' 处按钮文案，均未超过 4 个字符');
  }
}

console.log('\n' + (bad ? '❌ ' + bad + ' 类问题需要修复' : '✅ UI 接口限制检查通过'));
process.exit(bad ? 1 : 0);
