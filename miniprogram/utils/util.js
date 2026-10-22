/**
 * 通用格式化与业务小工具
 */
function fmtPrice(fen) {
  const n = Number(fen) || 0;
  if (n % 100 === 0) return String(n / 100);
  return (n / 100).toFixed(2);
}

function fmtMoney(fen) {
  return (Number(fen || 0) / 100).toFixed(2);
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes());
  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function relTime(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + '分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + '小时前';
  if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + '天前';
  const d = new Date(Number(ts));
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

/** 图片九宫格布局（返回每张图的尺寸） */
function gridImages(count, width) {
  const gap = 12;
  if (count === 1) return [{ w: width * 0.66, h: width * 0.66 }];
  if (count === 4) {
    const s = (width - gap) / 2;
    return new Array(4).fill({ w: s, h: s });
  }
  const s = (width - gap * 2) / 3;
  return new Array(count).fill({ w: s, h: s });
}

/** 文字高亮切分（搜索关键词） */
function splitKeyword(text, kw) {
  const t = String(text || '');
  const k = String(kw || '').trim();
  if (!k) return [{ text: t, hit: false }];
  const out = [];
  let rest = t;
  const lower = t.toLowerCase();
  const kLower = k.toLowerCase();
  let idx = lower.indexOf(kLower);
  while (idx > -1) {
    if (idx > 0) out.push({ text: rest.slice(0, idx), hit: false });
    out.push({ text: rest.slice(idx, idx + k.length), hit: true });
    rest = rest.slice(idx + k.length);
    idx = rest.toLowerCase().indexOf(kLower);
  }
  if (rest) out.push({ text: rest, hit: false });
  return out.length ? out : [{ text: t, hit: false }];
}

/** 头像字标的配色（按昵称哈希取一组，免得整片评论区灰糊糊） */
const AV_BG = ['#FDE7E0', '#E6F0FD', '#E9F7EE', '#FFF3DC', '#F0E9FB', '#E4F6F8'];
const AV_FG = ['#D4573A', '#3A76D4', '#2F8A55', '#B57A16', '#6E4FB8', '#2A7E8C'];

/**
 * 头像的「字标兜底」数据：昵称首字 + 一支配色。
 *
 * 用途：界面上的头像是「底色字标 + 图片」两层叠起来的 ——
 * 图片正常就盖住字标，图片为空或加载失败（用户没设置过头像、是云存储里
 * 不存在的 /static/avatars/aXX.jpg、临时链接过期…）就露出字标。
 * 这样头像**永远不会是一块白**。
 *
 * @param {{nickname?: string, id?: number}} u 用户（或只有昵称/ID 的对象）
 * @returns {{letter: string, bg: string, fg: string}}
 */
function avatarFallback(u) {
  const o = u || {};
  const key = String(o.nickname || o.id || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 997;
  return {
    letter: (String(o.nickname || '?').trim()[0] || '?'),
    bg: AV_BG[h % AV_BG.length],
    fg: AV_FG[h % AV_FG.length]
  };
}

/**
 * 把评论整理成**小红书式两级结构**（顶层评论 + 缩在它下面的 replies）。
 *
 * 入参**两种形态都接受**，都先拍平再重新建树：
 *   ① 后端已组织好的两级：`[{...顶层, replies:[{...回复}]}]`
 *   ② 旧的扁平数组：`[{...每条自带 replyTo}]`
 *
 * ★ 为什么嵌套要在**前端**做（而不是只依赖后端返回的 replies）：
 *   云函数是独立部署的 —— 小程序发了新版、云函数还是旧版时，
 *   旧版返回的评论是**平的**（没有 replies 字段）。前端若只会读 `replies`，
 *   界面就是「回复别人的评论，显示成一条单独的评论」，而用户完全看不出
 *   原因在部署上。放在前端建树之后，**两种后端都不会退回平铺**。
 *
 * 规则：
 *   - 顺着 `replyTo` 往上找顶层楼；**父评论已被删除时，把自己当顶层楼**
 *     —— 宁可让它以顶层出现，也绝不丢弃（丢弃就是用户说的「评论被吞」）。
 *   - 最多走 20 层，防脏数据成环死循环。
 *   - 后端没下发 `replyToName` 时，用本地列表里的作者昵称补上，
 *     这样「回复 @某某」在旧后端下也显示得出来。
 *   - 回复不再单独出现在顶层（不会重复渲染）。
 *
 * @param {Array} list 评论数组（两级或扁平均可）
 * @returns {Array} 顶层评论数组，每项带 `replies` / `rootId`
 */
function commentTree(list) {
  // 1) 拍平（两级 → 一维）
  const flat = [];
  for (const c of (list || [])) {
    const top = Object.assign({}, c);
    const replies = top.replies || [];
    delete top.replies;
    flat.push(top);
    for (const r of replies) {
      const rc = Object.assign({}, r);
      delete rc.replies;
      flat.push(rc);
    }
  }
  // 早发的在前：这样遍历到回复时，它的父评论一定已经建成"楼"了
  flat.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (Number(a.id) || 0) - (Number(b.id) || 0));

  const byId = {};
  for (const c of flat) byId[Number(c.id)] = c;

  // 2) 找所属顶层楼
  const rootIdOf = (c) => {
    let cur = c;
    for (let i = 0; i < 20; i++) {
      const pid = Number(cur.replyTo);
      if (!pid) return Number(cur.id);
      const parent = byId[pid];
      if (!parent || Number(parent.id) === Number(cur.id)) return Number(cur.id);
      cur = parent;
    }
    return Number(cur.id);
  };

  const roots = [];
  const index = {};
  for (const c of flat) {
    const pid = Number(c.replyTo);
    const rid = rootIdOf(c);
    // 是"回复某人"、且那条父评论还在、且自己不是顶层楼 → 挂到所属楼的 replies
    if (pid && byId[pid] && rid !== Number(c.id) && index[rid]) {
      index[rid].replies.push(c);
      continue;
    }
    c.replies = [];
    c.rootId = Number(c.id);
    index[Number(c.id)] = c;
    roots.push(c);
  }

  /**
   * 3) 决定「回复 @某某」要不要显示。
   *
   * 规则（用户明确要求）：
   *   - 回复**顶层大评论** → **不显示**（那条回复本来就缩在这条大评论底下，
   *     再写「回复 楼主」是冗余的，小红书也不显示）
   *   - 回复**大评论下面的子评论** → **显示**「回复 某人」+ 被回复人昵称
   *
   * 所以这里对「直接回楼主」的回复**主动清空** replyToName ——
   * 不能只依赖后端：旧版云函数对所有回复都会填 replyToName。
   * 判据用 `replyTo === 本条回复所属楼的 id`，与后端的 `rootOf(t) === t.id` 等价。
   */
  for (const r of roots) {
    for (const rep of r.replies || []) {
      if (Number(rep.replyTo) === Number(r.id)) {
        rep.replyToName = '';      // 回楼主：不显示标识
        rep.replyToText = '';
        continue;
      }
      if (!rep.replyToName) {
        const t = byId[Number(rep.replyTo)];
        rep.replyToName = (t && t.author && t.author.nickname) || '';
      }
    }
  }
  return roots;
}

/** 两级结构里的**总条数**（含回复）—— 与界面实际渲染出来的条数一致 */
function countComments(roots) {
  let n = 0;
  for (const c of (roots || [])) n += 1 + ((c.replies || []).length);
  return n;
}

function debounce(fn, wait) {
  let timer = null;
  return function () {
    const args = arguments;
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait || 400);
  };
}

module.exports = { fmtPrice, fmtMoney, fmtTime, relTime, gridImages, splitKeyword, debounce, pad, avatarFallback, commentTree, countComments };
