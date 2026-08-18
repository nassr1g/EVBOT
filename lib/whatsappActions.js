// ══════════════════════════════════════════════════════
//  📲 تنفيذ أوامر واتساب الفعلية على المجموعة
// ══════════════════════════════════════════════════════

const baileysModule = require('@whiskeysockets/baileys')
const { downloadMediaMessage } = baileysModule

if (typeof downloadMediaMessage !== 'function') {
  console.error('❌ downloadMediaMessage غير متاحة من حزمة baileys المثبتة. تحقق من نسخة @whiskeysockets/baileys في package.json.')
  process.exit(1)
}

const { getContextInfo } = require('./utils')

// يجلب أي وسيط قابل للتحويل لملصق من رسالة مباشرة (صورة أو فيديو، والـ GIF يصل كفيديو
// بعلامة gifPlayback من جهة واتساب). يرجّع buffer + نوع الوسيط أو null إذا ما وُجد شيء.
async function getMediaBufferFromMsg(sock, msg) {
  const imageMsg = msg?.message?.imageMessage
  const videoMsg = msg?.message?.videoMessage

  if (!imageMsg && !videoMsg) return null

  try {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { reuploadRequest: sock.updateMediaMessage }
    )
    return {
      buffer,
      type: videoMsg ? 'video' : 'image',
      isGif: !!videoMsg?.gifPlayback,
      seconds: videoMsg?.seconds || 0,
    }
  } catch (e) {
    console.error('❌ فشل تنزيل الوسيط:', e.message)
    return null
  }
}

async function getImageBufferFromMsg(sock, msg) {
  if (!msg?.message?.imageMessage) return null
  try {
    return await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { reuploadRequest: sock.updateMediaMessage }
    )
  } catch (e) {
    console.error('❌ فشل تنزيل الصورة:', e.message)
    return null
  }
}

async function getQuotedMediaBuffer(sock, msg, chatId) {
  const ctx = getContextInfo(msg)
  const quotedImage = ctx?.quotedMessage?.imageMessage
  const quotedVideo = ctx?.quotedMessage?.videoMessage

  if (!quotedImage && !quotedVideo) return null

  const quotedFakeMsg = {
    key: {
      remoteJid: chatId,
      id: ctx.stanzaId,
      participant: ctx.participant,
    },
    message: ctx.quotedMessage,
  }

  try {
    const buffer = await downloadMediaMessage(
      quotedFakeMsg,
      'buffer',
      {},
      { reuploadRequest: sock.updateMediaMessage }
    )
    return {
      buffer,
      type: quotedVideo ? 'video' : 'image',
      isGif: !!quotedVideo?.gifPlayback,
      seconds: quotedVideo?.seconds || 0,
    }
  } catch (e) {
    console.error('❌ فشل تنزيل الوسيط المقتبس:', e.message)
    return null
  }
}

// نُبقي الدالة القديمة للتوافق مع أي استدعاء آخر ما زال يتوقع صورة فقط
async function getQuotedImageBuffer(sock, msg, chatId) {
  const ctx = getContextInfo(msg)
  if (!ctx?.quotedMessage?.imageMessage) return null

  const quotedFakeMsg = {
    key: {
      remoteJid: chatId,
      id: ctx.stanzaId,
      participant: ctx.participant,
    },
    message: ctx.quotedMessage,
  }

  try {
    return await downloadMediaMessage(
      quotedFakeMsg,
      'buffer',
      {},
      { reuploadRequest: sock.updateMediaMessage }
    )
  } catch (e) {
    console.error('❌ فشل تنزيل الصورة المقتبسة:', e.message)
    return null
  }
}

async function renameGroup(sock, chatId, newName) {
  await sock.groupUpdateSubject(chatId, newName)
}

async function updateDescription(sock, chatId, newDesc) {
  await sock.groupUpdateDescription(chatId, newDesc)
}

async function updateGroupPicture(sock, chatId, imgBuffer) {
  await sock.updateProfilePicture(chatId, imgBuffer)
}

async function deleteQuotedMessage(sock, chatId, quotedKey) {
  // تسجيل تشخيصي مؤقت: نطبع المفتاح المُرسَل فعلياً والنتيجة الخام المُعادة من Baileys،
  // ونلتقط أي خطأ بتفصيل كامل (بما فيه أي خصائص إضافية كـ output/data قد تحمل سبب الرفض
  // الحقيقي من واتساب، والتي عادة لا تظهر بـ e.message وحدها)
  console.log('🔍 [تشخيص] deleteQuotedMessage — المفتاح:', JSON.stringify(quotedKey))
  try {
    const result = await sock.sendMessage(chatId, { delete: quotedKey })
    console.log('🔍 [تشخيص] deleteQuotedMessage — النتيجة الخام:', JSON.stringify(result))
    return result
  } catch (e) {
    console.error('🔍 [تشخيص] deleteQuotedMessage — استثناء كامل:', e)
    console.error('🔍 [تشخيص] deleteQuotedMessage — e.message:', e?.message)
    console.error('🔍 [تشخيص] deleteQuotedMessage — e.output:', JSON.stringify(e?.output))
    console.error('🔍 [تشخيص] deleteQuotedMessage — e.data:', JSON.stringify(e?.data))
    throw e
  }
}

async function updateParticipant(sock, chatId, targetJid, action) {
  // action: 'promote' | 'demote' | 'remove'
  await sock.groupParticipantsUpdate(chatId, [targetJid], action)
}

async function setChatAnnouncementMode(sock, chatId, isClosed) {
  await sock.groupSettingUpdate(chatId, isClosed ? 'announcement' : 'not_announcement')
}

async function fetchGroupInfo(sock, chatId) {
  const meta = await sock.groupMetadata(chatId)
  const adminList = meta.participants.filter(p => p.admin).map(p => p.id)
  return {
    name: meta.subject,
    description: meta.desc || '',
    members: meta.participants.length,
    admins: adminList.length,
    adminList: adminList.map(id => id.split('@')[0].split(':')[0]),
    participants: meta.participants,
  }
}

async function fetchGroupProfilePicUrl(sock, chatId) {
  try {
    return await sock.profilePictureUrl(chatId, 'image')
  } catch {
    return null
  }
}

// يجيب رابط دعوة الجروب الحالي. واتساب يشترط أن يكون البوت مشرفاً لجلب هذا الرابط،
// بنفس شرط بقية أوامر الإدارة بالبوت — فيُستدعى دائماً بعد requireAdmin بـ index.js
async function fetchGroupInviteLink(sock, chatId) {
  const code = await sock.groupInviteCode(chatId)
  return `https://chat.whatsapp.com/${code}`
}

module.exports = {
  getImageBufferFromMsg,
  getQuotedImageBuffer,
  getMediaBufferFromMsg,
  getQuotedMediaBuffer,
  renameGroup,
  updateDescription,
  updateGroupPicture,
  deleteQuotedMessage,
  updateParticipant,
  setChatAnnouncementMode,
  fetchGroupInfo,
  fetchGroupProfilePicUrl,
  fetchGroupInviteLink,
}
