/**
 * 实时层（云开发版）
 *
 * 云开发没有常驻 WebSocket，改用 **云数据库实时推送 watch()**：
 *   - 会话列表：订阅 conversations 集合中我参与的会话 → convUpdate 事件
 *   - 聊天页：订阅当前会话的 messages 集合 → message 事件（新消息实时到达）
 *
 * 对外保留与本地 WS 版一致的 API（on/sendChat/read/typing/isConnected/close），
 * 页面代码基本无需改动。
 */
const api = require('./api');
const { CLOUD_ENV } = require('./config');

const handlers = {};
let convWatcher = null;
let msgWatcher = null;
let myId = 0;
let connected = false;
let currentConvId = 0;

function on(event, fn) {
  (handlers[event] = handlers[event] || []).push(fn);
}
function off(event, fn) {
  const arr = handlers[event];
  if (!arr) return;
  if (!fn) { delete handlers[event]; return; }
  const i = arr.indexOf(fn);
  if (i > -1) arr.splice(i, 1);
}
function emit(event, payload) {
  (handlers[event] || []).slice().forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } });
}

function db() {
  return wx.cloud.database({ env: CLOUD_ENV });
}

/* ---------------- 会话订阅（全局） ---------------- */
function connect() {
  if (!api.token() || !wx.cloud) return;
  const u = getApp().globalData.user;
  myId = (u && u.id) || 0;
  if (!myId) return;
  if (convWatcher) return;

  try {
    convWatcher = db().collection('conversations')
      .where({ members: myId })
      .watch({
        onChange(snapshot) {
          if (!connected) { connected = true; emit('connected'); }
          const docs = (snapshot.docs || []).slice().sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
          emit('convUpdate', { list: docs, type: snapshot.type });
        },
        onError(e) {
          connected = false;
          console.warn('[rt] 会话订阅中断，稍后重连', e && e.errMsg);
          convWatcher = null;
          setTimeout(() => { if (api.token()) connect(); }, 5000);
        }
      });
    connected = true;
    emit('connected');
  } catch (e) {
    console.warn('[rt] 会话订阅失败', e);
    connected = false;
  }
}

/* ---------------- 消息订阅（聊天页） ---------------- */
function watchMessages(convId, cb) {
  closeMessages();
  currentConvId = Number(convId);
  if (!currentConvId || !wx.cloud) return null;
  try {
    msgWatcher = db().collection('messages')
      .where({ convId: currentConvId })
      .watch({
        onChange(snapshot) {
          const docs = snapshot.docs || [];
          if (snapshot.type === 'init') {
            if (cb) cb({ type: 'init', list: docs });
            return;
          }
          // 增量：找出新增的文档
          const added = (snapshot.docChanges || [])
            .filter((c) => c.dataType === 'add')
            .map((c) => c.doc)
            .filter(Boolean);
          if (added.length) {
            added.sort((a, b) => (a.id || 0) - (b.id || 0));
            emit('message', { convId: currentConvId, message: added[added.length - 1], added });
            if (cb) cb({ type: 'add', added });
          }
          // 已读变化
          const updated = (snapshot.docChanges || [])
            .filter((c) => c.dataType === 'update' || c.dataType === 'replace')
            .map((c) => c.doc)
            .filter(Boolean);
          if (updated.length) emit('messageUpdate', { convId: currentConvId, updated });
        },
        onError(e) {
          console.warn('[rt] 消息订阅中断', e && e.errMsg);
          msgWatcher = null;
        }
      });
    return msgWatcher;
  } catch (e) {
    console.warn('[rt] 消息订阅失败', e);
    return null;
  }
}

function closeMessages() {
  if (msgWatcher) {
    try { msgWatcher.close(); } catch (e) { /* 忽略 */ }
    msgWatcher = null;
  }
  currentConvId = 0;
}

/* ---------------- 发送 / 已读 ---------------- */
/**
 * 发送消息。
 * 默认由云函数在同一次请求内一并生成 AI 回复并返回 aiMessage，
 * 前端拿到后直接显示 —— 只需一次往返，也不依赖额外路由。
 */
async function sendChat(convId, payload) {
  const body = {
    content: payload && payload.content,
    type: payload && payload.msgType,
    card: payload && payload.card
  };
  const res = await api.post('/api/conversations/' + convId + '/messages', body, { silent: true });
  // aiMessages：本次回复产生的全部 AI 消息（可能是「文字 + 商品卡片」两条）
  return {
    viaWs: false,
    message: res.message,
    aiMessage: res.aiMessage || null,          // 兼容旧字段
    aiMessages: res.aiMessages || (res.aiMessage ? [res.aiMessage] : [])
  };
}

/**
 * 异步触发 AI 回复（备选通道）。
 * 当主通道没带回 aiMessage 时兜底调用。
 */
function requestAiReply(convId) {
  return api.post('/api/conversations/' + convId + '/ai-reply', {}, { silent: true })
    .then((r) => r)
    .catch(() => null);
}

function read(convId) {
  return api.post('/api/conversations/' + convId + '/read', {}, { silent: true }).catch(() => {});
}

/** 云开发版不做「正在输入」广播（需要额外的集合与写入配额） */
function typing() { /* no-op */ }

function isConnected() { return connected; }

/** 消息订阅是否处于活动状态（供聊天页决定是否启用轮询兜底） */
function isWatching() {
  return !!(msgWatcher && currentConvId);
}

function close() {
  if (convWatcher) { try { convWatcher.close(); } catch (e) { /* 忽略 */ } convWatcher = null; }
  closeMessages();
  connected = false;
}

/** 字段变更订阅通用工具（供收藏、资源等页面按需使用） */
function watchCollection(name, where, onChange, onError) {
  if (!wx.cloud) return null;
  try {
    return db().collection(name).where(where).watch({
      onChange,
      onError: onError || ((e) => console.warn('[rt] watch ' + name, e && e.errMsg))
    });
  } catch (e) {
    console.warn('[rt] watch ' + name + ' 失败', e);
    return null;
  }
}

module.exports = {
  connect, close, on, off, emit,
  sendChat, requestAiReply, read, typing, isConnected, isWatching,
  watchMessages, closeMessages, watchCollection
};
