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
 * 云函数运行时是 **UTC**，直接 getHours() / getMonth() 会得到 UTC 时间，
 * 比北京时间少 8 小时 —— 表现就是钱包明细里「18:45 的交易显示成 10:45」，
 * 以及 0:00~8:00 的交易日期会算到前一天。
 *
 * 统一按东八区（本产品面向国内校园）格式化，且**不依赖服务器时区**：
 * 先把时间戳平移 +8 小时，再用 getUTC* 取值。
 *
 * ⚠️ 本机服务端（server/src/util.js）**故意不这么做** ——
 * 它跑在用户自己的机器上（本来就是 +08:00），用本地 getter 才对，
 * 照抄这里的 +8h 会变成重复偏移。两处刻意不同，改的时候别"统一"。
 */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

function bjDate(ts) {
  return new Date(Number(ts || 0) + TZ_OFFSET_MS);
}

function fmtDate(ts) {
  const d = bjDate(ts);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function fmtTime(ts) {
  const d = bjDate(ts);
  return fmtDate(ts) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

/**
 * 北京时间「今天往前第 offsetDays 天」的 0 点，对应的真实时间戳。
 *
 * 为什么要这个：云函数跑在 UTC，直接
 *     const d = new Date(Date.now() - i * 86400e3);
 *     new Date(d.getFullYear(), d.getMonth(), d.getDate())
 * 得到的是 **UTC 的当天 0 点**，比北京时间的自然日早 8 小时 ——
 * 于是「近 7 天」的柱子会把 0:00~8:00 的数据算到前一天，
 * 用户看到的就是「昨天的单跑到今天」「今天明明有数据某天却是空的」。
 *
 * 这里不依赖服务器时区：先把时间戳平移到北京"墙上时间"，
 * 在平移坐标系里取整到天，再平移回来。
 *
 * @param {number} offsetDays 0=今天，1=昨天，6=6 天前
 * @returns {number} 该日北京 0 点的时间戳（真实 UTC 毫秒）
 */
function bjDayStart(offsetDays) {
  const n = Number(offsetDays) || 0;
  const shifted = Date.now() + TZ_OFFSET_MS;
  const midnightShifted = Math.floor(shifted / 86400e3) * 86400e3;
  return midnightShifted - n * 86400e3 - TZ_OFFSET_MS;
}

/** 把某个时间戳格式化成北京时间的「M/D」（用于图表标签） */
function bjDayLabel(ts) {
  const d = bjDate(ts);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
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

module.exports = {
  randomToken, pick, paginate, yuan, pad, fmtDate, fmtTime, relTime,
  orderNo, publicUser, clampText, num, match, nowDay,
  // 时区工具：云函数跑在 UTC，凡涉及「自然日」的地方都要用它
  TZ_OFFSET_MS, bjDate, bjDayStart, bjDayLabel
};
