// ══════════════════════════════════════════════════════
//  🔧 أدوات مساعدة عامة
// ══════════════════════════════════════════════════════

const readline = require('readline')
const crypto = require('crypto')

function askQuestion(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()) }))
}

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    ''
  ).trim()
}

function bareId(jid) {
  if (!jid) return ''
  return jid.split('@')[0].split(':')[0]
}

function getContextInfo(msg) {
  return (
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    msg.message?.documentMessage?.contextInfo ||
    msg.message?.audioMessage?.contextInfo ||
    msg.message?.stickerMessage?.contextInfo ||
    null
  )
}

function getMentionedJids(msg) {
  const ctx = getContextInfo(msg)
  return (ctx?.mentionedJid || []).filter(Boolean)
}

function getQuotedKey(msg, chatId) {
  const ctx = getContextInfo(msg)
  if (!ctx?.stanzaId) return null
  return {
    remoteJid: chatId,
    id: ctx.stanzaId,
    participant: ctx.participant,
    fromMe: false,
  }
}

// يتحقق من وجود وسيط مرفق مباشرة بالرسالة (صورة أو فيديو، والـ GIF يصل كفيديو من واتساب)
function hasAttachedMedia(msg) {
  return !!(msg.message?.imageMessage || msg.message?.videoMessage)
}

function normalizeSpaces(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function cleanDecorations(text) {
  return String(text || '')
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim()
}

function sanitizeCasual(text, maxWords = 14) {
  return normalizeSpaces(
    cleanDecorations(text).replace(/[^\p{L}\p{N}\s]/gu, ' ')
  )
    .split(' ')
    .filter(Boolean)
    .slice(0, maxWords)
    .join(' ')
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60

  if (h > 0) return `${h}س ${m}د ${s}ث`
  if (m > 0) return `${m}د ${s}ث`
  return `${s}ث`
}

// يبني نمطاً متسامحاً مع تكرار الأحرف لكلمة معينة، بحيث "بوت" يطابق أيضاً "بووت" و"بووووت".
// للكلمات العربية، يضيف بادئة "يا" اختيارية (متصلة بالكلمة مباشرة أو منفصلة بمسافة)، لأن حرف
// النداء "يا" غالباً يُكتب ملتصقاً بالكلمة التالية مباشرة بدون مسافة (مثال: "يابوت", "يابووووت")
function buildFuzzyNamePattern(word, { isArabic = false } = {}) {
  const escaped = [...word].map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '+')
  const core = escaped.join('')
  if (isArabic) {
    // "يا" اختيارية: إما غائبة، أو حاضرة (متصلة أو بعدها مسافة) قبل الكلمة نفسها
    return `(?:يا\\s*)?${core}`
  }
  return core
}

// أسماء البوت المعترف بها، مع علامة على أيها يُعامل كنداء "بوت" العام (يستحق سخرية عن الاسم)
// والباقي أسماء فعلية (لا سخرية، رد عادي)
const BOT_NAME_ALIASES = [
  { word: 'بوت', isGenericBotWord: true, isArabic: true },
  { word: 'bot', isGenericBotWord: true, isArabic: false },
  { word: 'EV', isGenericBotWord: false, isArabic: false },
  { word: 'إيجيما', isGenericBotWord: false, isArabic: true },
  { word: 'إيفي', isGenericBotWord: false, isArabic: true },
  { word: 'ايفي', isGenericBotWord: false, isArabic: true },
  { word: 'egima', isGenericBotWord: false, isArabic: false },
]

/**
 * يتحقق إذا نودي البوت بالرسالة (بأي اسم من أسمائه، بأي مكان بالجملة، مع تسامح لتكرار الأحرف
 * وحرف النداء "يا" المتصل) أو بمنشن/رد مباشر.
 *
 * @returns {{ called: boolean, isGenericBotWord: boolean, triggeredBy: 'text'|'mention'|'reply'|null }}
 *   isGenericBotWord تكون true فقط لو النداء كان بكلمة "بوت"/"bot" العامة تحديداً (يستحق سخرية عن الاسم)،
 *   و false لو كان باسم فعلي (EV/إيجيما/إيفي/egima) أو بمنشن/رد.
 *   triggeredBy توضح مصدر الاكتشاف: 'text' (اسم مذكور بالنص، قد يكون نداءً أو حديثاً عنه فقط —
 *   يحتاج فحصاً إضافياً)، أو 'mention'/'reply' (فعل مقصود لا لبس فيه، لا يحتاج فحصاً إضافياً).
 */
function detectBotAddress(text, selfIds, msg) {
  const t = normalizeSpaces(text)

  for (const { word, isGenericBotWord, isArabic } of BOT_NAME_ALIASES) {
    const pattern = buildFuzzyNamePattern(word, { isArabic })
    // الحدود تقبل بداية/نهاية الجملة، مسافة، أو علامات ترقيم شائعة على أي من الجانبين
    const boundary = '(?:^|$|[\\s,.!?؟،؛:؛\\-])'
    const regex = new RegExp(`${boundary}${pattern}${boundary}`, 'iu')
    if (regex.test(t)) {
      return { called: true, isGenericBotWord, triggeredBy: 'text' }
    }
  }

  const ctx = getContextInfo(msg)
  if (ctx) {
    const replyIds = [ctx.participant, ctx.participantPn, ctx.remoteJid]
      .filter(Boolean)
      .map(bareId)

    if (replyIds.some(id => selfIds.includes(id))) {
      return { called: true, isGenericBotWord: false, triggeredBy: 'reply' }
    }

    const mentionIds = (ctx.mentionedJid || []).map(bareId)
    if (mentionIds.some(id => selfIds.includes(id))) {
      return { called: true, isGenericBotWord: false, triggeredBy: 'mention' }
    }

    // تحذير مختصر فقط للحالة المشبوهة فعلاً: منشن أو رد بالرسالة لكن selfIds فارغة بالكامل
    // (يعني لم تُعرف هوية البوت بعد وقت هذا الفحص) — هذا مؤشر على مشكلة بتوقيت الاتصال
    // إذا استمر تكراره، وليس مجرد رسالة عادية لا تخص البوت (تلك لا تحتاج أي تسجيل هنا إطلاقاً)
    if (selfIds.length === 0) {
      console.log('⚠️ detectBotAddress: فحص منشن/رد جرى بينما selfIds فارغة (هوية البوت غير معروفة بعد)')
    }
  }

  return { called: false, isGenericBotWord: false, triggeredBy: null }
}

// يُبقي التوقيع القديم متاحاً لأي كود آخر ما زال يستخدمه (يرجع boolean فقط، بدون تفاصيل الاسم)
function isBotMentionedOrReplied(text, selfIds, msg) {
  return detectBotAddress(text, selfIds, msg).called
}

// معرّف فريد لأسماء الملفات المؤقتة، يمنع تصادم طلبين بنفس اللحظة بالضبط
function uniqueTempId() {
  return `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// يتحقق إذا كان الخطأ يشبه فشل رفع وسائط قابل لإعادة المحاولة (مو خطأ صلاحيات أو خطأ آخر دائم)
function isRetryableUploadError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return /media upload failed|upload failed on all hosts|econnreset|etimedout|network/i.test(msg)
}

// يلف حول أي استدعاء sock.sendMessage يحتوي وسائط (صوت/صورة/ملصق/فيديو)، ويعيد المحاولة
// تلقائياً عند فشل رفع الوسائط تحديداً، مع تأخير متزايد بين المحاولات وتسجيل تفصيلي لكل خطأ
async function sendMediaWithRetry(sock, chatId, content, options = {}, { maxAttempts = 3, retryDelayMs = 2000 } = {}) {
  let lastErr

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await sock.sendMessage(chatId, content, options)
    } catch (err) {
      lastErr = err
      console.error(`❌ فشل إرسال الوسائط (محاولة ${attempt}/${maxAttempts}):`, err?.message || String(err))

      if (!isRetryableUploadError(err) || attempt >= maxAttempts) {
        throw err
      }

      await sleep(retryDelayMs * attempt)
    }
  }

  throw lastErr
}

// ─────────────────────────────────────────────
//  تحليل رد تفاصيل الملصقات — صيغة ثابتة نفرضها نحن (3 أسطر: موضوع / عدد متحرك / عدد
//  عادي)، وليست نصاً حراً، لذا التحليل هنا حتمي وبسيط تماماً بلا أي حاجة لتخمين أو تفسير
// ─────────────────────────────────────────────

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'

function arabicIndicToNumber(str) {
  return str.replace(/[٠-٩]/g, d => String(ARABIC_INDIC_DIGITS.indexOf(d)))
}

/**
 * يحلل رد المستخدم على رسالة تعليمات الملصقات، بصيغة 3 أسطر ثابتة:
 *   السطر 1: موضوع الملصقات (نص حر، كما كتبه المستخدم بالضبط)
 *   السطر 2: عدد الملصقات المتحركة (رقم)
 *   السطر 3: عدد الملصقات العادية/الثابتة (رقم)
 * يتجاهل الأسطر الفارغة الزائدة (بداية/نهاية) لكن يتطلب 3 أسطر محتوى بالضبط بعد ذلك.
 * @returns {{ topic: string, animated: number, static: number } | null} null إذا لم يطابق الرد الصيغة المتوقعة إطلاقاً
 */
function parseStickerDetailsReply(text) {
  const lines = String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)

  if (lines.length !== 3) return null

  const [topicRaw, animatedRaw, staticRaw] = lines
  const animatedNorm = arabicIndicToNumber(animatedRaw).trim()
  const staticNorm = arabicIndicToNumber(staticRaw).trim()

  if (!/^\d{1,2}$/.test(animatedNorm) || !/^\d{1,2}$/.test(staticNorm)) return null

  const topic = normalizeSpaces(topicRaw)
  if (!topic) return null

  return {
    topic,
    animated: parseInt(animatedNorm, 10),
    static: parseInt(staticNorm, 10),
  }
}


function renderProgressBar(percent, width = 12) {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clamped / 100) * width)
  const empty = width - filled
  return `${'▓'.repeat(filled)}${'░'.repeat(empty)} ${clamped}%`
}

// بطاقة تقدم أكثر احترافية لعمليات متعددة المراحل (مثل حزمة الملصقات: بحث → تحضير → إرسال).
// كل مرحلة تُعرض كسطر بأيقونة حالتها (✅ مكتملة، ▶️ حالية مع شريطها، ⏳ قادمة لم تبدأ بعد)
function renderStageProgressCard({ title, stages, currentStageIndex, currentDone, currentTotal }) {
  const lines = [`✨ *${title}*`, '']

  stages.forEach((label, i) => {
    if (i < currentStageIndex) {
      lines.push(`✅ ${label}`)
    } else if (i === currentStageIndex) {
      const pct = currentTotal > 0 ? Math.round((currentDone / currentTotal) * 100) : 0
      const bar = renderProgressBar(pct, 14)
      const countText = currentTotal > 0 ? `(${currentDone}/${currentTotal})` : ''
      lines.push(`▶️ ${label} ${countText}`)
      lines.push(`   ${bar}`)
    } else {
      lines.push(`⏳ ${label}`)
    }
  })

  return lines.join('\n')
}

module.exports = {
  askQuestion,
  extractText,
  bareId,
  getContextInfo,
  getMentionedJids,
  getQuotedKey,
  hasAttachedMedia,
  normalizeSpaces,
  cleanDecorations,
  sanitizeCasual,
  formatDuration,
  isBotMentionedOrReplied,
  detectBotAddress,
  uniqueTempId,
  sendMediaWithRetry,
  renderProgressBar,
  renderStageProgressCard,
  parseStickerDetailsReply,
}
