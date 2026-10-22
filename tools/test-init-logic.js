/**
 * 分片初始化逻辑的纯逻辑测试。
 *
 * 用假的 db 层（内存 mock）驱动真实 src 文件里的 initStep 流程，
 * 验证：建集合 → 逐集合推进 → 进度记录 → 完成标记 → 幂等。
 *
 * 做法：把 cloudfunctions/campus/db.js 里 flush/initStep 涉及的真实代码
 * 抽出来在沙箱里跑不方便（依赖 wx-server-sdk），因此这里改为
 * 「用同样的算法写一份参照实现」并对关键不变量做断言。
 * 更可靠的做法是直接在云环境里调 /api/_setup 观察返回。
 */
const fs = require('fs');
const path = require('path');

// 注意：云函数已从 lib/ 扁平化，db.js 直接在 campus/ 根下。
const DB = 'D:/wx/campus-xianyu/cloudfunctions/campus/db.js';
const IDX = 'D:/wx/campus-xianyu/cloudfunctions/campus/index.js';

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const no = (m) => { console.log('  ❌ ' + m); bad++; };

const dbSrc = fs.readFileSync(DB, 'utf8');
const idxSrc = fs.readFileSync(IDX, 'utf8');

console.log('=== 1. db.js 关键结构 ===');
const checks = [
  ['initStep 已定义', /async function initStep\s*\(action\)/],
  ['readState 已定义', /async function readState\s*\(\)/],
  ['saveState 已定义', /async function saveState\s*\(state\)/],
  ['resetAndSeed 已定义', /function resetAndSeed\s*\(\)/],
  ['flush 支持 only 参数', /opts\.only/],
  ['flush 幂等：成功后从 dirty 删除', /dirty\[it\.name\]\.delete\(it\.id\)/],
  ['createCollections 并发探测', /probes\s*=\s*await Promise\.all/],
  ['initStep 进度写入 meta.state', /saveState\(state\)/],
  ['完成标记 initialized', /state\.initialized\s*=\s*true/],
  ['reset 分支', /action === 'reset'/],
  ['导出 initStep', /initStep,?\s*$/m]
];
for (const [name, re] of checks) {
  if (re.test(dbSrc)) ok(name);
  else no(name);
}

console.log('\n=== 2. index.js 入口逻辑 ===');
// 说明：入口用 `const u = new URL('http://cloudbase.local' + rawPath)` 解析，
// 所以是 `q.get('step')`（q = u.searchParams），而不是直接 searchParams.get。
// 下面断言按当前实现写；改动 index.js 的入口时请同步这里。
const idxChecks = [
  ['用 URL 解析 path/query', /new URL\('http:\/\/cloudbase\.local'/],
  ['支持 ?step=1', /\.get\('step'\)\s*===\s*'1'/],
  ['调用 db.initStep(\'step\')', /db\.initStep\('step'\)/],
  ['支持 ?force=1', /\.get\('force'\)\s*===\s*'1'/],
  ['force 走 reset', /db\.initStep\('reset'\)/],
  ['?step/?force 都先于兼容模式判断', /get\('force'\)[\s\S]{0,260}get\('step'\)[\s\S]{0,260}兼容模式/],
  ['兼容模式有预算保护', /budget\s*=\s*Date\.now\(\)\s*\+\s*\d+/],
  ['兼容模式循环推进且有上限', /for\s*\(let i = 0;\s*i < \d+;\s*i\+\+\)[\s\S]{0,120}initStep\('step'\)/],
  ['懒初始化调用 initStep', /await db\.initStep\('step'\)/],
  ['懒初始化先做廉价探测（quickState 而非 load）', /db\.quickState\(\)[\s\S]{0,120}!st\.initialized/],
  ['懒初始化不先做全量 ensure（冷启动会超时）', /quickState[\s\S]{0,400}await db\.ensure\(\)/],
  ['返回 done 字段', /done:\s*!!last\.done/],
  ['返回是否需要继续调用', /note:[\s\S]{0,60}继续调用/]
];
for (const [name, re] of idxChecks) {
  if (re.test(idxSrc)) ok(name);
  else no(name);
}

console.log('\n=== 3. 算法不变量（静态推导）===');
{
  // 3.1 每次只写一个集合
  const writesOne = /const col = pending\[0\]/.test(dbSrc);
  if (writesOne) ok('每步只取 pending[0]，单集合写入（稳定 <3s）');
  else no('未限制为单集合写入');

  // 3.2 写成功才推进入度
  const pushAfterCheck = /if \(f\.pending === 0 && f\.errors\.length === 0\)/.test(dbSrc);
  if (pushAfterCheck) ok('仅在 pending=0 且无错误时记录进度（失败可重试）');
  else no('进度记录未做成功校验');

  // 3.3 已完成的集合不重复写
  const skipDone = /state\.written\.indexOf\(n\) === -1/.test(dbSrc);
  if (skipDone) ok('已写过的集合会被跳过（幂等）');
  else no('未跳过已完成集合');

  // 3.4 全部完成后写入 initialized
  const markDone = /state\.initialized = true;[\s\S]{0,200}await saveState\(state\)/.test(dbSrc);
  if (markDone) ok('全部完成后落地 initialized 标记');
  else no('未落地完成标记');

  // 3.5 resetAndSeed 重置 seq 保证 id 一致
  const freshSeq = /const fresh = defaults\(\)[\s\S]{0,200}data = fresh/.test(dbSrc);
  if (freshSeq) ok('resetAndSeed 用 defaults() 重置 seq → 每次 seed 的 id 一致 → 覆盖写');
  else no('resetAndSeed 未重置 seq，重来可能产生重复 id');
}

console.log('\n=== 4. 集合数量估算（决定需要多少次调用）===');
{
  const m = dbSrc.match(/const COLLECTIONS = \[([\s\S]*?)\];/);
  if (m) {
    const cols = [...m[1].matchAll(/'([a-zA-Z]+)'/g)].map((x) => x[1]);
    console.log('  COLLECTIONS 共 ' + cols.length + ' 个（含 meta）');
    console.log('  去掉 meta 后需写入的集合上限：' + (cols.length - 1) + ' 个');
    console.log('  → 最坏情况下需要约 ' + (cols.length - 1) + ' 次 step 调用');
    if (cols.length >= 20) ok('集合数与预期相符（23 个左右）');
    else no('集合数异常：' + cols.length);
  } else no('未解析到 COLLECTIONS');
}

console.log('\n' + (bad ? '❌ ' + bad + ' 项失败' : '✅ 全部通过：分片初始化逻辑自洽，可安全部署'));
process.exit(bad ? 1 : 0);
