'use strict';
/**
 * 实时事件层（云开发版）
 *
 * 云函数内没有常驻 WebSocket 连接，因此这里不再推送，
 * 而是把消息写入 messages 集合；小程序端通过
 * db.collection('messages').where({convId}).watch() 订阅变更实现实时聊天。
 *
 * 对外保持与本地版 ws.js 完全一致的函数签名，业务代码无需改动。
 */
const db = require('./db');

/** 列表页预览文案 */
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

/**
 * 发送聊天消息（消息写入后由小程序端 watch/轮询订阅到）
 *
 * opts.deferAI=true 时不在本次请求内生成 AI 回复。
 * 原因：大模型往返 3~5 秒，若在这里同步等，用户发消息要卡 5 秒，
 * 且必然踩云函数超时。改由前端另发一次 /ai-reply 请求异步生成。
 */
function sendChatMessage(userId, convId, content, msgType, card, opts) {
  const conv = db.findById('conversations', convId);
  if (!conv || conv.members.indexOf(Number(userId)) === -1) return null;
  const msg = createMessage(conv, Number(userId), msgType || 'text', content, card);
  const peerId = conv.members.find((x) => x !== Number(userId));
  const peer = peerId ? db.findById('users', peerId) : null;
  const defer = opts && opts.deferAI;
  if (peer && peer.isAI && !defer) scheduleAIReply(conv, Number(userId), content);
  return msg;
}

/**
 * 为会话中「最新一条用户消息」生成 AI 回复（供 /ai-reply 端点调用）。
 *
 * 幂等：若该用户消息之后已有 AI 回复，则跳过，避免前端重试导致重复回复。
 */
async function replyLatestAsAI(convId, userId) {
  const conv = db.findById('conversations', convId);
  if (!conv || conv.members.indexOf(Number(userId)) === -1) return { ok: false, reason: '会话不存在' };

  const aiId = conv.members.find((x) => x !== Number(userId));
  const aiUser = aiId ? db.findById('users', aiId) : null;
  if (!aiUser || !aiUser.isAI) return { ok: false, reason: '对方不是 AI' };

  const msgs = db.find('messages', (m) => m.convId === conv.id).sort((a, b) => a.id - b.id);
  // 找最后一条真人消息
  let lastUserMsg = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].senderId === Number(userId)) { lastUserMsg = msgs[i]; break; }
  }
  if (!lastUserMsg) return { ok: false, reason: '没有待回复的用户消息' };

  // 幂等：其后已有 AI 回复则跳过
  const replied = msgs.some((m) => m.senderId === aiId && m.id > lastUserMsg.id);
  if (replied) return { ok: true, skipped: true, reason: '已回复过' };

  await scheduleAIReply(conv, Number(userId), lastUserMsg.content);
  await drainPending();   // 等 LLM 返回并写入内存
  return { ok: true, replied: true };
}

function markRead(userId, convId) {
  const conv = db.findById('conversations', convId);
  if (!conv || conv.members.indexOf(Number(userId)) === -1) return;
  for (const m of db.find('messages', (x) => x.convId === conv.id)) {
    if ((m.readBy || []).indexOf(Number(userId)) === -1) {
      // 必须走 db.update：它会 markDirty，flush 时才真的写回云数据库。
      // 直接改 m.readBy 再 saveSoon() 是无效的 —— 云函数版的 saveSoon 是空实现，
      // 结果「已读」只在当前实例的内存里，冷启动后又变回未读、红点反复出现。
      db.update('messages', m.id, { readBy: (m.readBy || []).concat([Number(userId)]) });
    }
  }
}

/**
 * 登录欢迎语。
 *
 * 注意：这条属于「打招呼」性质，界面上渲染成居中的灰色提示
 * （聊天页里 type=system 不显示成对话气泡），因此**不应产生未读红点**。
 */
const WELCOME_TEXT = '欢迎来到科贸小鱼！我是 AI 客服小校助手。可以先逛逛首页，或点底部「+」发布你的第一件闲置～ 有任何问题随时找我。';

/**
 * 自愈：把该用户历史上「未读的欢迎语」标记为已读。
 *
 * 早期版本创建欢迎语时没有设 preRead，导致老账号一登录就挂着未读红点
 * （用户看到「刚登录就有红点」）。这里在每次登录时顺手清理，
 * 不需要人工改数据。
 *
 * 只针对欢迎语这一条文案，不动其他 system 通知 —— 因为拼团成功、
 * 举报受理、商品下架等业务通知也是 type=system，它们应当保留红点。
 *
 * @returns {number} 本次清理的条数
 */
function healGreetingUnread(userId) {
  const aiUser = db.one('users', (u) => u.isAI);
  if (!aiUser) return 0;
  let n = 0;
  const hits = db.find('messages', (m) =>
    m.senderId === aiUser.id &&
    m.type === 'system' &&
    String(m.content || '').indexOf(WELCOME_TEXT) === 0);
  for (const m of hits) {
    if ((m.readBy || []).indexOf(Number(userId)) === -1) {
      // 同样必须走 db.update 才会落库（见 markRead 处的说明）
      db.update('messages', m.id, { readBy: (m.readBy || []).concat([Number(userId)]) });
      n++;
    }
  }
  return n;
}

/**
 * 系统通知：写入用户与 AI 助手的会话（聊天式通知中心）
 *
 * opts.preRead = true 时直接把该用户标记为已读，不产生未读红点。
 * 用于「欢迎语」这类打招呼性质的通知 —— 用户一进 App 就已经看到，
 * 再挂个红点只会让人困惑（新账号一登录就有红点，看起来像出错了）。
 */
function notifyUser(userId, text, orderCard, opts) {
  const aiUser = db.one('users', (u) => u.isAI);
  if (!aiUser) return;
  let conv = db.one('conversations', (c) =>
    c.members.length === 2 &&
    c.members.indexOf(Number(userId)) !== -1 &&
    c.members.indexOf(aiUser.id) !== -1);
  if (!conv) {
    conv = db.insert('conversations', { members: [Number(userId), aiUser.id], lastMessage: '', lastTime: Date.now() });
  }
  const msg = createMessage(conv, aiUser.id, orderCard ? 'order' : 'system', text, orderCard || null);
  if (opts && opts.preRead && (msg.readBy || []).indexOf(Number(userId)) === -1) {
    msg.readBy.push(Number(userId));
    db.saveSoon();
  }
  pushTo(userId, { type: 'message', convId: conv.id, message: msg });
}

/**
 * AI 客服自动回复。
 *
 * ⚠️ 两个必须注意的点：
 * 1) ai.generateReply 是【同步】函数（内置规则引擎），可能返回对象而非 Promise。
 *    直接 .then() 会抛 TypeError 并让整个发消息接口失败。
 *    这里统一用 Promise.resolve().then() 包一层，同步/异步都能正确处理。
 * 2) 云函数在 main 返回后会冻结进程，未 await 的异步任务会丢失。
 *    因此所有回复任务都注册到 pendingTasks，由 main 在落库前 drainPending() 等待完成。
 */
function scheduleAIReply(conv, userId, userText) {
  let ai = null;
  try { ai = require('./ai'); } catch (e) { return null; }
  const aiId = conv.members.find((x) => x !== userId);
  const user = db.findById('users', userId);

  const task = Promise.resolve()
    .then(() => ai.generateReply(user, String(userText || ''), conv))
    .then((reply) => {
      if (!reply || !reply.text) return null;
      createMessage(conv, aiId, 'text', reply.text, null, reply.quickReplies || null);
      if (reply.cards && reply.cards.length) {
        createMessage(conv, aiId, 'listings', '', reply.cards);
      }
      return reply;
    })
    .catch(() => {
      // 兜底：无论内部出什么错，都要给用户一句回应，而不是石沉大海
      try {
        createMessage(conv, aiId, 'text',
          '抱歉，我这边刚刚没反应过来～你可以换个说法再问我一次，比如「怎么发布闲置」。',
          null, null);
      } catch (e) { /* 忽略 */ }
      return null;
    });

  pendingTasks.push(task);
  return task;
}

/** 待完成的异步任务（AI 回复等），由 main 统一等待 */
const pendingTasks = [];

/** 等待所有挂起的异步任务完成（AI 回复需要在落库前写完） */
async function drainPending() {
  if (!pendingTasks.length) return 0;
  const tasks = pendingTasks.splice(0, pendingTasks.length);
  await Promise.all(tasks.map((p) => Promise.resolve(p).catch(() => null)));
  return tasks.length;
}

/* ---- 以下为兼容本地版接口的空实现（云开发无长连接） ---- */
function pushTo() { /* no-op */ }
function pushToPeer() { /* no-op */ }
function broadcast() { /* no-op */ }
function attachWss() { /* no-op */ }

module.exports = {
  sendChatMessage, markRead, notifyUser, pushTo, pushToPeer, broadcast, attachWss, lastPreview,
  drainPending, scheduleAIReply, replyLatestAsAI,
  WELCOME_TEXT, healGreetingUnread
};
