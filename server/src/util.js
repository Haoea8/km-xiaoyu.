'use strict';
const crypto = require('crypto');

function randomToken(n = 24) {
  return crypto.randomBytes(n).toString('hex');
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function paginate(list, page, pageSize) {
  const p = Math.max(1, Number(page) || 1);
  const s = Math.min(60, Math.max(1, Number(pageSize) || 10));
  const start = (p - 1) * s;
  return {
    list: list.slice(start, start + s),
    page: p,
    pageSize: s,
    total: list.length,
    hasMore: start + s < list.length
  };
}

function yuan(fen) {
  const n = Number(fen) || 0;
  return (Math.round(n) / 100).toFixed(2);
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

/**
 * ⚠️ 这里用**本机时区**是对的，不要照抄云函数那份。
 *
 * 云函数（cloudfunctions/campus/util.js）运行时是 UTC，
 * `new Date().getHours()` 会得到 UTC 小时（比北京时间少 8 小时），
 * 所以那份改成「时间戳 +8h 再用 getUTC*」显式取东八区。
 * 而本机服务跑在用户自己的机器上（本来就 +08:00），
 * 用本地 getter 才是对的 —— 若在这里也加 8 小时会变成重复偏移。
 */
function fmtDate(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function fmtTime(ts) {
  const d = new Date(ts);
  return fmtDate(ts) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function relTime(ts) {
  const d = Date.now() - Number(ts || 0);
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + '分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + '小时前';
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + '天前';
  return fmtDate(ts);
}

function orderNo() {
  const d = new Date();
  return 'CY' + String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate()) +
    String(Date.now()).slice(-6) + Math.floor(Math.random() * 90 + 10);
}

function publicUser(u) {
  if (!u) return null;
  const out = Object.assign({}, u);
  delete out.openid;
  delete out.password;
  return out;
}

function clampText(s, max) {
  const t = String(s == null ? '' : s).trim();
  return max ? t.slice(0, max) : t;
}

function num(v, d = 0) {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function match(text, kw) {
  return String(text || '').toLowerCase().includes(String(kw || '').toLowerCase());
}

function nowDay() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/**
 * 北京时间（UTC+8）的日界工具。
 *
 * 本地服务跑在 +08:00，直接用 `new Date(y,m,d)` 得到的已经是北京 0 点；
 * 但路由层与云端是**镜像代码**，里面写的是 `util.bjDayStart(i)`。
 * 缺了这两个函数，本地后台一点「仪表盘」就 TypeError。
 *
 * 这里**刻意不依赖服务器时区**（先平移到北京墙上时间、取整到天、再平移回来），
 * 与云端实现同构 —— 这样即使有人把本机 TZ 改成 UTC，数字也不会错位一天。
 */
const TZ_OFFSET_MS = 8 * 3600 * 1000;

function bjDayStart(offsetDays) {
  const n = Number(offsetDays) || 0;
  const shifted = Date.now() + TZ_OFFSET_MS;
  const midnightShifted = Math.floor(shifted / 86400e3) * 86400e3;
  return midnightShifted - n * 86400e3 - TZ_OFFSET_MS;
}

function bjDayLabel(ts) {
  const d = new Date(Number(ts || Date.now()) + TZ_OFFSET_MS);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
}

module.exports = {
  randomToken, pick, paginate, yuan, pad, fmtDate, fmtTime, relTime,
  orderNo, publicUser, clampText, num, match, nowDay,
  bjDayStart, bjDayLabel
};
