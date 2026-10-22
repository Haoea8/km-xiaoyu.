'use strict';
const db = require('./db');
const { randomToken } = require('./util');

function createSession(userId, type = 'user') {
  const token = randomToken(24);
  db.insert('sessions', { token, userId, type, createdAt: Date.now() });
  return token;
}

function destroySession(token) {
  if (token) db.remove('sessions', (s) => s.token === token);
}

function userByToken(token) {
  if (!token) return null;
  const s = db.one('sessions', (x) => x.token === token && x.type === 'user');
  if (!s) return null;
  return db.findById('users', s.userId) || null;
}

function adminByToken(token) {
  if (!token) return null;
  const s = db.one('sessions', (x) => x.token === token && x.type === 'admin');
  return s ? { username: s.userId, isAdmin: true } : null;
}

function tokenFromReq(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  try {
    const u = new URL(req.url, 'http://local');
    return (u.searchParams.get('token') || '').trim();
  } catch (e) { return ''; }
}

function adminLogin(username, password) {
  const data = db.load();
  const admin = (data.meta && data.meta.admin) || null;
  if (!admin) return null;
  if (admin.username !== username || admin.password !== password) return null;
  return createSession(username, 'admin');
}

module.exports = {
  createSession, destroySession, userByToken, adminByToken, tokenFromReq, adminLogin
};
