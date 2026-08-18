// ══════════════════════════════════════════════════════
//  🗂️ سجل مفاتيح الرسائل — يسجّل فقط ما يلزم لحذف رسالة لاحقاً (لا نص، لا محتوى)
//
//  السبب: واتساب/Baileys لا يوفران أي طريقة لاستعراض "آخر رسائل فلان بالجروب" من العدم —
//  لا يوجد بحث بالتاريخ ولا استعلام حسب المرسل. المسار الوحيد لحذف رسالة هو معرفة مفتاحها
//  الدقيق (id + participant + remoteJid)، والمصدر الوحيد لهذا المفتاح هو مراقبة الرسائل
//  لحظة وصولها. لذا هذا السجل يبني تدريجياً (من لحظة تفعيل هذه الميزة فصاعداً فقط) قائمة
//  بمفاتيح آخر رسائل كل شخص بكل مجموعة، حتى تصبح أوامر "احذف آخر N رسالة لفلان" ممكنة.
//
//  خصوصية: نخزّن فقط id/participant/timestamp — لا نص الرسالة ولا محتواها إطلاقاً.
//  هذا سجل حذف تقني بحت، وليس أرشيف محادثة.
//
//  ملاحظة مهمة عن حدود هذا النظام (لا يمكن تجاوزها تقنياً):
//  1) لا يمكن حذف رسائل أُرسلت قبل بدء تشغيل هذه النسخة من البوت (لا يوجد أرشيف تاريخي
//     من واتساب نفسه يمكن سحبه لاحقاً). لهذا نحفظ السجل بملف كي يصمد عبر إعادة التشغيل،
//     لكنه يبقى فارغاً لأي فترة سبقت أول مرة عمل فيها البوت أصلاً.
//  2) واتساب يستخدم أحياناً صيغتين مختلفتين لهوية نفس الشخص بنفس المحادثة (LID ورقم
//     الهاتف التقليدي PN)، وقد تصل رسالة الشخص بصيغة والرد لاحقاً عليه بصيغة أخرى. لذا
//     نسجّل كل الصيغ المعروفة لهوية المرسل مع كل رسالة، ونطابق بحثاً عن أي منها لا صيغة
//     واحدة فقط — هذا يمنع فشل المطابقة الصامت الذي كان يحدث سابقاً بسبب هذا الاختلاف.
// ══════════════════════════════════════════════════════

const fs = require('fs')
const path = require('path')
const { bareId } = require('./utils')

const LOG_FILE = path.join(__dirname, '..', 'message_log_state.json')

// { chatId: [{ id, participant, altIds: [bare,...], timestamp }, ...] } — الأحدث بالنهاية
let groupLogs = loadState()

// أقصى عدد رسائل نحتفظ بها لكل مجموعة (كل المرسلين مجتمعين) — سقف يحمي الذاكرة، ويكفي
// بسهولة لتغطية طلبات "آخر 50 رسالة" حتى بمجموعات نشطة جداً بين وصول الطلب ومعالجته
const MAX_LOG_PER_GROUP = 500

// أقصى عدد رسائل نعيده لكل شخص بطلب واحد — يطابق نفس الحد الأعلى المتعارف عليه بأوامر
// الحزم الأخرى بالبوت (حماية من طلبات ضخمة غير مقصودة)
const MAX_DELETE_PER_REQUEST = 50

// الأعداد الافتراضية عند عدم تحديد رقم صريح بالطلب
const DEFAULT_DELETE_COUNT_TARGETED = 10 // لشخص معين (رد أو منشن)
const DEFAULT_DELETE_COUNT_GENERAL = 20  // بدون تحديد شخص (حذف عام بالمجموعة)

function loadState() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'))
    }
  } catch (e) {
    console.error('⚠️ تعذر تحميل message_log_state.json:', e.message)
  }
  return {}
}

// حفظ متزامن بسيط بعد كل تسجيل — الحجم صغير جداً (بضع كيلوبايت كحد أقصى، لا نص رسائل
// إطلاقاً)، فتكلفة الكتابة لكل رسالة مهملة عملياً، ولا داعٍ لتعقيد تجميع/تأجيل الكتابة
function saveState() {
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(groupLogs), 'utf8')
  } catch (e) {
    console.error('⚠️ تعذر حفظ message_log_state.json:', e.message)
  }
}

// participantIdentifiers: مصفوفة بكل الصيغ المعروفة لهوية المرسل بهذي الرسالة تحديداً
// (عادة participant + participantPn إن وُجدا معاً)، حتى نطابق لاحقاً بأي منها.
// fromMe: هل هذي رسالة أرسلها البوت نفسه؟ نحتاج نحفظها لأن مفتاح حذف رسالة البوت نفسه
// يختلف شكلاً عن مفتاح حذف رسالة عضو آخر (fromMe:true بلا اشتراط participant، بعكس حذف
// رسالة عضو آخر الذي يتطلب fromMe:false + participant صريح — نفس تمييز getQuotedKey بالضبط)
function recordMessage(chatId, participant, id, timestamp = Date.now(), participantIdentifiers = [], fromMe = false) {
  if (!chatId || !participant || !id) return
  if (!groupLogs[chatId]) groupLogs[chatId] = []

  const altIds = [...new Set([participant, ...participantIdentifiers].filter(Boolean).map(bareId))]

  groupLogs[chatId].push({ id, participant, altIds, timestamp, fromMe: !!fromMe })

  if (groupLogs[chatId].length > MAX_LOG_PER_GROUP) {
    groupLogs[chatId] = groupLogs[chatId].slice(-MAX_LOG_PER_GROUP)
  }

  saveState()
}

// يرجّع آخر N مفتاح رسالة لشخص محدد بمجموعة معينة، الأحدث أولاً. senderBare يجب أن يكون
// نفس صيغة bareId() المستخدمة بباقي الملف (بدون @مجال ولا :جهاز). نطابق ضد altIds كاملة
// (كل الصيغ المعروفة لهذا الشخص بلحظة إرسال كل رسالة)، لا صيغة واحدة فقط، لتفادي فشل
// المطابقة الصامت عند اختلاف صيغة LID/رقم الهاتف بين وقت الإرسال ووقت الرد لاحقاً
function getLastMessagesFrom(chatId, senderBare, count) {
  const log = groupLogs[chatId] || []
  const matches = log.filter(entry => {
    if (Array.isArray(entry.altIds) && entry.altIds.length > 0) {
      return entry.altIds.includes(senderBare)
    }
    // توافق مع سجلات قديمة أُنشئت قبل إضافة altIds (لو وُجدت من نسخة سابقة من الميزة)
    return bareId(entry.participant) === senderBare
  })
  return matches.slice(-count).reverse()
}

// يرجّع آخر N مفتاح رسالة بالمجموعة بغض النظر عن المرسل، الأحدث أولاً
function getLastMessagesAny(chatId, count) {
  const log = groupLogs[chatId] || []
  return log.slice(-count).reverse()
}

module.exports = {
  recordMessage,
  getLastMessagesFrom,
  getLastMessagesAny,
  MAX_DELETE_PER_REQUEST,
  DEFAULT_DELETE_COUNT_TARGETED,
  DEFAULT_DELETE_COUNT_GENERAL,
}
