// ══════════════════════════════════════════════════════
//  🎯 تحديد الهدف — يرجّع حالة واضحة بدل قيمة عمياء
//
//  status: 'certain'   → هدف واحد واضح، نفّذ مباشرة
//          'ambiguous' → أكثر من مرشح أو تضارب بالسياق، اطلب تأكيد
//          'none'      → ما فيه هدف إطلاقاً
// ══════════════════════════════════════════════════════

const { bareId, getContextInfo, getMentionedJids } = require('./utils')
const { getHistory } = require('./memory')

function extractTargetFromValue(value) {
  const raw = String(value || '').trim()
  if (!raw) return null

  const jidMatch = raw.match(/\b\d{8,15}\b/)
  if (jidMatch) return `${jidMatch[0]}@s.whatsapp.net`

  if (raw.includes('@s.whatsapp.net') || raw.includes('@lid')) return raw
  return null
}

// يجمع كل الـ JIDs التي ذُكرت في آخر عدة رسائل بالذاكرة (لبناء قائمة مرشحين عند الغموض)
function collectRecentMentionedJids(chatId, selfIds, window = 6) {
  const seen = new Set()
  const result = []

  getHistory(chatId)
    .slice(-window)
    .forEach(m => {
      (m.mentionedJids || []).forEach(j => {
        const bare = bareId(j)
        if (!selfIds.includes(bare) && !seen.has(bare)) {
          seen.add(bare)
          result.push(j)
        }
      })
    })

  return result
}

function resolveGroupMember(groupInfo, bare) {
  if (!groupInfo?.participants) return null
  return groupInfo.participants.find(p => bareId(p.id) === bare) || null
}

/**
 * @returns {{ status: 'certain', jid: string } |
 *           { status: 'multiple', jids: string[] } |
 *           { status: 'ambiguous', candidates: string[] } |
 *           { status: 'none' }}
 */
function resolveTarget(msg, selfIds, value, chatId, { groupInfo = null, targetIsCertain = true } = {}) {
  // 1) منشن مباشر بنفس الرسالة — الأقوى والأوضح، لا علاقة له بحكم Gemini
  const directMentions = getMentionedJids(msg).filter(j => !selfIds.includes(bareId(j)))

  if (directMentions.length === 1) {
    return { status: 'certain', jid: directMentions[0] }
  }

  if (directMentions.length > 1) {
    // أكثر من منشن مباشر بنفس الرسالة يمثل نية واضحة لاستهداف عدة أشخاص معاً (مثل طرد جماعي)،
    // وليس غموضاً يحتاج توضيحاً — القرار كيف نتعامل مع هذا يُترك لمستدعي الدالة
    return { status: 'multiple', jids: directMentions }
  }

  // 2) رد مباشر (quote) بنفس الرسالة — نفس القوة، لا علاقة له بحكم Gemini
  const ctx = getContextInfo(msg)
  if (ctx?.participant && !selfIds.includes(bareId(ctx.participant))) {
    return { status: 'certain', jid: ctx.participant }
  }

  // 3) قيمة استنتجها Gemini من السياق — هنا نثق بحكمه الدلالي (targetIsCertain) بدل إعادة
  //    حسابه رياضياً من عدد المنشنات بالتاريخ، لأن Gemini يفهم المعنى الفعلي للرسالة
  //    (مثال: "اطرد نصر" بعد ذكر نصر وسلطان معاً — واضح دلالياً رغم وجود مرشحين بالتاريخ)
  const extracted = extractTargetFromValue(value)

  if (extracted) {
    const bare = bareId(extracted)
    const realMember = resolveGroupMember(groupInfo, bare)
    const resolvedJid = realMember?.id || extracted

    if (targetIsCertain) {
      return { status: 'certain', jid: resolvedJid }
    }

    // Gemini نفسه غير متأكد — نبني قائمة مرشحين من السياق القريب لطلب تأكيد صريح
    const recentCandidates = collectRecentMentionedJids(chatId, selfIds)
    const otherRecentCandidates = recentCandidates.filter(j => bareId(j) !== bare)

    if (otherRecentCandidates.length === 0) {
      // بالرغم من عدم ثقة Gemini، ما فيه مرشح آخر فعلياً بالتاريخ — نعتبره الوحيد المتاح
      return { status: 'certain', jid: resolvedJid }
    }

    return {
      status: 'ambiguous',
      candidates: [resolvedJid, ...otherRecentCandidates],
    }
  }

  // 4) ولا منشن ولا رد ولا قيمة — نجرب آخر مرشح وحيد بالذاكرة القريبة فقط
  const recentCandidates = collectRecentMentionedJids(chatId, selfIds)

  if (recentCandidates.length === 1) {
    return { status: 'certain', jid: recentCandidates[0] }
  }

  if (recentCandidates.length > 1) {
    return { status: 'ambiguous', candidates: recentCandidates }
  }

  return { status: 'none' }
}

module.exports = {
  resolveTarget,
}
