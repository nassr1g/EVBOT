// ══════════════════════════════════════════════════════
//  🚦 حماية بسيطة من السبام لكل محادثة
// ══════════════════════════════════════════════════════

const { RATE_LIMIT_COOLDOWN_MS } = require('../config')

const lastRequestAt = new Map() // chatId → timestamp

function isRateLimited(chatId) {
  const last = lastRequestAt.get(chatId)
  if (!last) return false
  return Date.now() - last < RATE_LIMIT_COOLDOWN_MS
}

function markRequest(chatId) {
  lastRequestAt.set(chatId, Date.now())
}

module.exports = {
  isRateLimited,
  markRequest,
}
