'use strict';
/**
 * WebSocket 实时中枢：真人一对一聊天、AI 客服会话、系统通知推送、已读回执
 */
const { WebSocketServer } = require('ws');
const db = require('./db');
const auth = require('./auth');
const ai = require('./ai');

const clients = new Map(); // userId -> Set<ws>

function attachWss(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    let token = '';
    try { token = new URL(req.url, 'http://local').searchParams.get('token') || ''; } catch (e) {}
    const user = auth.userByToken(token);
    if (!user) {
      try { ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' })); } catch (e) {}
      ws.close(4001, 'unauthorized');
      return;
    }
    ws.userId = user.id;
    ws.isAlive = true;
    if (!clients.has(user.id)) clients.set(user.id, new Set());
    clients.get(user.id).add(ws);
    send(ws, { type: 'connected', userId: user.id });

    ws.on('message', (buf) => {
      let msg = null;
      try { msg = JSON.parse(String(buf)); } catch (e) { return; }
      if (!msg || !msg.type) return;
      if (msg.type === 'ping') { ws.isAlive = true; send(ws, { type: 'pong', t: Date.now() }); return; }
      if (msg.type === 'send') { sendChatMessage(user.id, msg.convId, msg.content, msg.msgType, msg.card); return; }
      if (msg.type === 'read') { markRead(user.id, msg.convId); return; }
      if (msg.type === 'typing') { pushToPeer(user.id, msg.convId, { type: 'typing', convId: Number(msg.convId), from: user.id }); return; }
    });
    ws.on('close', () => {
      const set = clients.get(user.id);
      if (set) { set.delete(ws); if (!set.size) clients.delete(user.id); }
    });
  });
  const timer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    });
  }, 30000);
  wss.on('close', () => clearInterval(timer));
  return wss;
}

function send(ws, payload) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); } catch (e) {}
}

function pushTo(userId, payload) {
  const set = clients.get(Number(userId));
  if (set) for (const ws of set) send(ws, payload);
}

function broadcast(payload) {
  for (const set of clients.values()) for (const ws of set) send(ws, payload);
}

function pushToPeer(userId, convId, payload) {
  const conv = db.findById('conversations', convId);
  if (!conv) return;
  for (const uid of conv.members) if (uid !== Number(userId)) pushTo(uid, payload);
}

function lastPreview(msg) {
  if (!msg) return '';
  if (msg.type === 'listing') return '[商品] ' + ((msg.card && msg.card.title) || '');
  if (msg.type === 'listings') return '[商品推荐]';
  if (msg.type === 'image') return '[图片]';
  if (msg.type === 'order') return '[订单] ' + ((msg.card && msg.card.title) || '');
  return msg.content || '';
}

function createMessage(conv, senderId, type, content, card, quickReplies) {
  const msg = db.insert('messages', {
    convId: conv.id, senderId, type: type || 'text', content: content || '',
    card: card || null, quickReplies: quickReplies || null, readBy: [senderId]
  });
  conv.lastMessage = lastPreview(msg);
  conv.lastTime = Date.now();
  db.saveSoon();
  return msg;
}

/** 发送聊天消息（REST 与 WS 共用） */
function sendChatMessage(userId, convId, content, msgType, card) {
  const conv = db.findById('conversations', convId);
  if (!conv || conv.members.indexOf(Number(userId)) === -1) return null;
  const msg = createMessage(conv, Number(userId), msgType || 'text', content, card);
  for (const uid of conv.members) pushTo(uid, { type: 'message', convId: conv.id, message: msg });
  const peerId = conv.members.find((x) => x !== Number(userId));
  const peer = peerId ? db.findById('users', peerId) : null;
  if (peer && peer.isAI) scheduleAIReply(conv, Number(userId), content);
  return msg;
}

function markRead(userId, convId) {
  const conv = db.findById('conversations', convId);
  if (!conv || conv.members.indexOf(Number(userId)) === -1) return;
  let changed = false;
  for (const m of db.find('messages', (x) => x.convId === conv.id)) {
    if (m.readBy.indexOf(Number(userId)) === -1) { m.readBy.push(Number(userId)); changed = true; }
  }
  if (changed) db.saveSoon();
  pushToPeer(userId, conv.id, { type: 'read', convId: conv.id, by: Number(userId) });
}

/** 系统通知：写入用户与 AI 助手的会话（聊天式通知中心） */
function notifyUser(userId, text, orderCard) {
  const aiUser = db.one('users', (u) => u.isAI);
  if (!aiUser) return;
  let conv = db.one('conversations', (c) => c.members.length === 2 && c.members.indexOf(Number(userId)) !== -1 && c.members.indexOf(aiUser.id) !== -1);
  if (!conv) {
    conv = db.insert('conversations', { members: [Number(userId), aiUser.id], lastMessage: '', lastTime: Date.now() });
  }
  const msg = createMessage(conv, aiUser.id, orderCard ? 'order' : 'system', text, orderCard || null);
  pushTo(userId, { type: 'message', convId: conv.id, message: msg });
}

function scheduleAIReply(conv, userId, userText) {
  setTimeout(() => {
    pushTo(userId, { type: 'typing', convId: conv.id, from: 'ai' });
  }, 350);
  setTimeout(async () => {
    const user = db.findById('users', userId);
    const aiId = conv.members.find((x) => x !== userId);
    let reply = null;
    try { reply = await ai.llmReply(user, String(userText || '')); } catch (e) {}
    if (!reply) reply = ai.generateReply(user, String(userText || ''), conv);
    const msg = createMessage(conv, aiId, 'text', reply.text, null, reply.quickReplies || null);
    pushTo(userId, { type: 'message', convId: conv.id, message: msg });
    if (reply.cards && reply.cards.length) {
      const cardMsg = createMessage(conv, aiId, 'listings', '', reply.cards);
      pushTo(userId, { type: 'message', convId: conv.id, message: cardMsg });
    }
  }, 1100);
}

module.exports = { attachWss, sendChatMessage, markRead, notifyUser, pushTo, pushToPeer, broadcast, lastPreview };
