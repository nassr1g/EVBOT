// ══════════════════════════════════════════════════════
//  🧠 الذاكرة — تاريخ المحادثة + الأهداف + التأكيدات المعلقة
// ══════════════════════════════════════════════════════

const { MEMORY_LIMIT, PENDING_CONFIRMATION_TTL_MS } = require('../config')

// { chatId: [{ role: 'user'|'bot', content: '...', mentionedJids?: [...] }] }
const memory = {}

// { "chatId:senderId": { action, candidates: [jid...], createdAt, originalText } }
const pendingConfirmations = {}

function getHistory(chatId) {
  return memory[chatId] || []
}

function pushUserMessage(chatId, content, mentionedJids = []) {
  if (!memory[chatId]) memory[chatId] = []
  memory[chatId].push({ role: 'user', content, mentionedJids })
  trimMemory(chatId)
}

function pushBotMessage(chatId, content) {
  if (!memory[chatId]) memory[chatId] = []
  memory[chatId].push({ role: 'bot', content })
  trimMemory(chatId)
}

function trimMemory(chatId) {
  if (memory[chatId] && memory[chatId].length > MEMORY_LIMIT) {
    memory[chatId] = memory[chatId].slice(-MEMORY_LIMIT)
  }
}

function getRecentBotReplies(chatId, count = 4) {
  return getHistory(chatId)
    .filter(m => m.role === 'bot')
    .slice(-count)
    .map(m => `"${m.content}"`)
    .join(' | ')
}

function getMentionsFromHistory(chatId, window = 12) {
  return getHistory(chatId)
    .slice(-window)
    .filter(m => m.mentionedJids && m.mentionedJids.length > 0)
    .map(m => `  - في رسالة سابقة ذُكر: ${m.mentionedJids.join(', ')}`)
    .join('\n')
}

// ─────────────────────────────────────────────
//  تأكيدات معلقة (لأوامر الطرد/الترقية/التنزيل الغامضة، وتفاصيل حزمة الملصقات)
//  المفتاح مركّب من (chatId + senderId) وليس chatId وحده — لأن بمجموعة فيها عدة أشخاص،
//  تعليق مبني على chatId فقط يجعل أي شخص آخر بنفس المجموعة "يُحتجز" داخل تأكيد شخص غيره
//  (مثال: شخص طلب ملصقات ولم يُكمل التفاصيل بعد، فيُعامَل حديث شخص آخر العادي في هذي
//  الأثناء كأنه محاولة إكمال ذلك التأكيد). المفتاح المركّب يعزل كل شخص عن تأكيدات غيره
// ─────────────────────────────────────────────

function pendingKey(chatId, senderId) {
  return `${chatId}:${senderId}`
}

function setPendingConfirmation(chatId, senderId, { action, candidates, originalText }) {
  pendingConfirmations[pendingKey(chatId, senderId)] = {
    action,
    candidates,
    originalText,
    createdAt: Date.now(),
  }
}

function getPendingConfirmation(chatId, senderId) {
  const key = pendingKey(chatId, senderId)
  const pending = pendingConfirmations[key]
  if (!pending) return null

  if (Date.now() - pending.createdAt > PENDING_CONFIRMATION_TTL_MS) {
    // انتهت الصلاحية — تُلغى بصمت كما هو مطلوب
    delete pendingConfirmations[key]
    return null
  }

  return pending
}

function clearPendingConfirmation(chatId, senderId) {
  delete pendingConfirmations[pendingKey(chatId, senderId)]
}

module.exports = {
  getHistory,
  pushUserMessage,
  pushBotMessage,
  getRecentBotReplies,
  getMentionsFromHistory,
  setPendingConfirmation,
  getPendingConfirmation,
  clearPendingConfirmation,
}
