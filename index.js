// ملاحظة على التوافق بين الإصدارات:
// - في baileys 6.7.22 وما قبله (CommonJS نقي): الدالة نفسها هي التصدير الرئيسي مباشرة
// - في baileys 6.8.0+ / 7.x (ESM): التصدير الرئيسي كائن يحتوي خاصية default هي الدالة
// نتحقق أيهما ينطبق فعلياً بدل افتراض واحد فقط، حتى يبقى الملف يعمل مهما كان الإصدار المثبت
const baileysModule = require('@whiskeysockets/baileys')
const makeWASocket = typeof baileysModule === 'function' ? baileysModule : baileysModule.default
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} = baileysModule

const pino = require('pino')

const { MODEL_NAME, DEVELOPER_SIGNATURE, DEVELOPER_CONTACT } = require('./config')
const { startKeepAliveServer, startSelfPing } = require('./keepalive')
const {
  extractText,
  bareId,
  getContextInfo,
  getMentionedJids,
  getQuotedKey,
  hasAttachedMedia,
  normalizeSpaces,
  formatDuration,
  detectBotAddress,
  findOwnLidFromParticipants,
  sendMediaWithRetry,
  renderProgressBar,
  renderStageProgressCard,
  parseStickerDetailsReply,
  renderUsageBar,
} = require('./lib/utils')

const memory = require('./lib/memory')
const messageLog = require('./lib/messageLog')
const { getGroupState, saveGroupStates } = require('./lib/groupState')
const gemini = require('./lib/gemini')
const actions = require('./lib/whatsappActions')
const media = require('./lib/media')
const stickerPack = require('./lib/stickerPack')
const photoPack = require('./lib/photoPack')
const { resolveTarget } = require('./lib/targetResolver')
const rateLimit = require('./lib/rateLimit')

// ══════════════════════════════════════════════════════
//  🧩 دوال تركيب النصوص التي تحتاج بيانات حية (لا تُصنَّف كـ "ردود ثابتة"
//  لأنها ليست جملاً محادثية، بل عرض بيانات هيكلي كالحالة والمساعدة)
// ══════════════════════════════════════════════════════

function buildHelpText(groupState) {
  return `
╭─ أوامري
│
│ ① تغيير اسم الجروب
│    قل: يا بوت غير اسم الجروب إلى كذا
│
│ ② تغيير وصف الجروب
│    قل: يا بوت غير الوصف إلى كذا
│
│ ③ تغيير صورة الجروب
│    أرسل الصورة وقل: يا بوت غير الصورة
│
│ ④ طرد عضو
│    قل: يا بوت اطرد فلان (مع منشن أو رد)
│
│ ⑤ ترقية عضو
│    قل: يا بوت اعط فلان إشراف (مع منشن أو رد)
│
│ ⑥ تنزيل إشراف
│    قل: يا بوت نزّل فلان (مع منشن أو رد)
│
│ ⑦ حذف رسالة
│    رد على الرسالة وقل: يا بوت احذفها
│    حذف عدة رسائل: يا بوت احذف آخر 10 رسائل (للجميع، أو مع رد/منشن لشخص معين)
│
│ ⑧ قفل الشات
│    قل: يا بوت اقفل الشات
│
│ ⑨ فتح الشات
│    قل: يا بوت افتح الشات
│
│ ⑩ نظام المشرفين
│    قل: يا بوت اقفل نظام المشرفين
│    أو: يا بوت افتح نظام المشرفين
│
│ ⑪ حالة البوت
│    قل: يا بوت حالة البوت
│
│ ⑫ تحويل صورة لملصق
│    أرسل الصورة وقل: يا بوت حولها ملصق
│
│ ⑬ إرسال أغنية
│    قل: يا بوت ابعث أغنية [اسم الأغنية أو الفنان]
│
│ ⑭ حزمة ملصقات
│    قل: يا بوت جيب ملصقات [موضوع] (تقدر تحدد عدد ونوع متحرك/عادي)
│
│ ⑮ حزمة صور
│    قل: يا بوت جيب صور [موضوع] (تقدر تحدد العدد ونوع متحرك GIF/عادي)
│
│ ⑯ معلومات المجموعة (تشمل رابط الدعوة)
│    قل: يا بوت معلومات الجروب
│
│ ⑰ حالة التوكنز/الحصص
│    قل: يا بوت حالة التوكنز
│
╰─ وضع المشرفين الآن: ${groupState.adminOnlyCommands ? 'مفعل' : 'معطل'}

━━━━━━━━━━━━━━━━━━━
🛠️ المطور: ${DEVELOPER_SIGNATURE}
عندك فكرة أو أمر تبي تضيفه أو تحسين أو واجهتك مشكلة بالبوت؟ تواصل معي على ${DEVELOPER_CONTACT}
`.trim()
}

// تسمية عرض قصيرة لكل خدمة + سطرها داخل بطاقة حالة/توكنز — تُبنى من نتيجة
// gemini.getUsageReport() (راجع lib/usageTracker.js لتفاصيل كيفية حساب النسبة)
function formatServiceUsageLine(label, emoji, summary) {
  if (!summary.available) {
    return `┃ ${emoji} *${label}*: غير مفعّل (لا يوجد مفتاح)`
  }
  const tag = summary.isLive ? '' : ' (تقديري)'
  return `┃ ${emoji} *${label}*: ${renderUsageBar(summary.percentUsed)} (${summary.used}/${summary.cap})${tag}`
}

async function buildStatusText(groupInfo, groupState, lastAiLatencyMs, botStartedAt) {
  const usage = await gemini.getUsageReport()

  const lines = []
  lines.push('┏━━━━━━━━━━━━━━━━━━━')
  lines.push('┃   ⚙️  *حالة البوت*')
  lines.push('┣━━━━━━━━━━━━━━━━━━━')
  lines.push(`┃ ⏱️  *مدة التشغيل*: ${formatDuration(Date.now() - botStartedAt)}`)
  lines.push(`┃ ⚡ *آخر استجابة*: ${Math.max(0, lastAiLatencyMs)}ms`)
  lines.push(`┃ 🧠 *المحرك*: ${MODEL_NAME}`)

  if (groupInfo) {
    lines.push('┣━━━━━━━━━━━━━━━━━━━')
    lines.push(`┃ 👥 *المجموعة*: ${groupInfo.name}`)
    lines.push(`┃ 👤 *الأعضاء*: ${groupInfo.members}`)
    lines.push(`┃ 🛡️  *المشرفون*: ${groupInfo.admins}`)
    lines.push(`┃ 🔒 *وضع المشرفين*: ${groupState.adminOnlyCommands ? 'مفعل' : 'معطل'}`)
  }

  lines.push('┣━━━━━━━━━━━━━━━━━━━')
  lines.push('┃ 📊 *استهلاك الحصص* (اكتب "حالة التوكنز" للتفاصيل)')
  lines.push(formatServiceUsageLine('Gemini', '🤖', usage.gemini))
  lines.push(formatServiceUsageLine('Tavily', '🔎', usage.tavily))
  lines.push(formatServiceUsageLine('Serper', '🖼️', usage.serper))

  lines.push('┣━━━━━━━━━━━━━━━━━━━')
  lines.push(`┃ 🛠️  *المطور*: ${DEVELOPER_SIGNATURE}`)
  lines.push(`┃ 📞 *للتواصل*: ${DEVELOPER_CONTACT}`)
  lines.push('┗━━━━━━━━━━━━━━━━━━━')
  return lines.join('\n')
}

// بطاقة تفصيلية مخصصة لاستهلاك الحصص — أمر مستقل ("حالة التوكنز") يعرض تفاصيل أوسع من
// السطر المختصر بداخل buildStatusText (حد كل خدمة، دورة التجديد، ونسبة التبقي الصريحة)
async function buildUsageText() {
  const usage = await gemini.getUsageReport()

  function detailBlock(label, emoji, summary, capLabel, cycleNote) {
    const lines = []
    const sourceTag = summary.available ? (summary.isLive ? ' — رصيد حي فعلي 🟢' : ' — تقدير محلي 🟡') : ''
    lines.push(`┃ ${emoji} *${label}*${sourceTag}`)
    if (!summary.available) {
      lines.push('┃    غير مفعّل — لا يوجد مفتاح API لهذه الخدمة بملف .env')
      return lines
    }
    lines.push(`┃    ${renderUsageBar(summary.percentUsed)}`)
    lines.push(`┃    مستخدم: ${summary.used} من ${summary.cap} ${capLabel}`)
    lines.push(`┃    متبقي: ${summary.percentLeft}%`)
    if (cycleNote) lines.push(`┃    ${cycleNote}`)
    return lines
  }

  const lines = []
  lines.push('┏━━━━━━━━━━━━━━━━━━━')
  lines.push('┃  📊 *حالة استهلاك التوكنز/الحصص*')
  lines.push('┣━━━━━━━━━━━━━━━━━━━')
  lines.push(...detailBlock('Gemini (الذكاء الاصطناعي)', '🤖', usage.gemini, 'طلب/يوم', 'يتجدد الحد يومياً (حسب توقيت تشغيل الخادم)'))
  lines.push('┣━━━━━━━━━━━━━━━━━━━')
  lines.push(...detailBlock('Tavily (البحث)', '🔎', usage.tavily, 'بحث/شهر', 'يتجدد الحد شهرياً'))
  lines.push('┣━━━━━━━━━━━━━━━━━━━')
  lines.push(...detailBlock('Serper (الصور/الملصقات)', '🖼️', usage.serper, 'استعلام', 'رصيد ثابت لا يتجدد تلقائياً (خطة مجانية)'))
  lines.push('┣━━━━━━━━━━━━━━━━━━━')
  lines.push('┃ 🟢 الأرقام الحية فعلية 100% من الخدمة نفسها لحظياً.')
  lines.push('┃ 🟡 الأرقام التقديرية نحسبها محلياً من عدد طلباتنا الفعلي، لأن')
  lines.push('┃ الخدمة نفسها لا توفر endpoint حياً لقراءتها (موثّق رسمياً من مزوّدها).')
  lines.push('┃ التقدير دقيق طالما البوت هو المستخدم الوحيد للمفتاح.')
  lines.push('┗━━━━━━━━━━━━━━━━━━━')
  return lines.join('\n')
}

// ══════════════════════════════════════════════════════
//  🚀 التشغيل
// ══════════════════════════════════════════════════════

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    syncFullHistory: false,
    // نُفعّلها صراحة (بدل الاعتماد على القيمة الافتراضية غير الموثقة بوضوح لهذا الإصدار):
    // بدونها، حدث messages.upsert لا يُطلَق إطلاقاً لرسائل البوت نفسه المُرسَلة (fromMe:true)
    // — أكّدنا هذا فعلياً بتشخيص حي (صفر أسطر تسجيل ظهرت لرسائل البوت رغم إرساله فعلياً)،
    // ما كان يمنع تسجيلها بسجل الحذف الجماعي من الأساس، فتبقى غير قابلة للحذف لاحقاً
    emitOwnEvents: true,
    // مطلوبة رسمياً من توثيق Baileys (من الخصائص القليلة "المطلوبة فعلياً" رغم كونها
    // اختيارية بالنوع) — تُستخدم داخلياً لعمليات مثل إعادة إرسال رسالة مفقودة أو فك تشفير
    // الأصوات باستفتاءات، وربما عمليات أخرى تعتمد على محتوى الرسالة الأصلي (مثل الحذف/
    // الإلغاء). بدون هذا الملف، لا نملك مخزناً فعلياً لمحتوى الرسائل السابقة، فنعيد
    // undefined دائماً (نمط رسمي موثّق من Baileys نفسه لبوتات بلا مخزن كامل)
    getMessage: async () => undefined,
  })

  let botJid = ''
  let botLid = ''
  let paired = false
  let lidRetryInterval = null
  const botStartedAt = Date.now()
  let lastAiLatencyMs = 0

  // يحاول التقاط botLid من sock.user.lid إن توفرت، ويحدّث المتغير المشترك فوراً لو نجح.
  // نستدعي هذي الدالة من مكانين: عند كل حدث creds.update، وبفحص دوري احتياطي قصير أدناه.
  // ملاحظة: تبيّن أن سبب فراغ botLid بعد ربط جديد ليس مسألة وقت/مزامنة (جُرِّب الانتظار
  // لدقائق داخل نفس العملية بدون فائدة)، بل لأن هذا تحديداً هو الاتصال الذي سيُغلق قريباً
  // برمز 515 (انظر أدناه) — الإصلاح الحقيقي هناك، وهذي الدالة مجرد خط دفاع إضافي خفيف
  function tryCaptureBotLid(source) {
    if (botLid) return true
    const freshLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : ''
    if (freshLid) {
      botLid = freshLid
      console.log(`✅ botLid التُقطت عبر ${source}: ${bareId(botLid)}`)
      return true
    }
    return false
  }

  sock.ev.on('creds.update', async (...args) => {
    await saveCreds(...args)
    tryCaptureBotLid('creds.update')
  })

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !paired) {
      paired = true

      // نقرأ الرقم من متغير بيئة PHONE_NUMBER بدل إدخاله يدوياً بالطرفية — على استضافة
      // مثل Render ما فيه طرفية تفاعلية نكتب فيها، فالرقم يُضبط مرة وحدة بلوحة التحكم
      const num = String(process.env.PHONE_NUMBER || '').replace(/\D/g, '')

      if (num.length < 10) {
        console.log('\n══════════════════════════════════════')
        console.log('❌ رقمك غير موجود أو غير صحيح!')
        console.log('أضف متغير بيئة اسمه PHONE_NUMBER وقيمته رقمك مع كود الدولة (بدون +)')
        console.log('مثال: 967xxxxxxxxx')
        console.log('══════════════════════════════════════\n')
        return
      }

      try {
        const code = await sock.requestPairingCode(num)
        const fmt = code.match(/.{1,4}/g).join('-')
        console.log('\n══════════════════════════════════════')
        console.log(`Code 🔑: ${fmt}`)
        console.log('══════════════════════════════════════')
        console.log('  1. WhatsApp ← ⋮ ← Linked devices')
        console.log('  2. Link a device → Link with phone number instead')
        console.log(`  3. Enter: ${fmt}`)
        console.log('══════════════════════════════════════\n')
      } catch (e) {
        console.error(' Linking code error ❌:', e.message)
      }
    }

    if (connection === 'open') {
      botJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : ''
      botLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : ''
      console.log(`\nThe bot number is working 🚀 ${bareId(botJid)}\n`)

      if (!botLid && botJid) {
        // فحص احتياطي خفيف فقط — الإصلاح الأساسي لمشكلة عدم توفر botLid بعد ربط جديد هو
        // ترقية مكتبة Baileys (كانت مشكلة LID معروفة ومعترف بها من المطورين أنفسهم بهذا
        // الإصدار تحديداً). هذا الفحص يبقى كخط دفاع إضافي خفيف بغض النظر عن الإصدار
        console.log('⏳ botLid غير متوفرة بعد — فحص احتياطي قصير (30 ثانية)...')
        let attempts = 0
        const MAX_ATTEMPTS = 6 // 6 محاولات × 5 ثوانٍ = 30 ثانية
        lidRetryInterval = setInterval(() => {
          attempts++
          if (tryCaptureBotLid(`فحص دوري (محاولة ${attempts})`)) {
            clearInterval(lidRetryInterval)
            lidRetryInterval = null
          } else if (attempts >= MAX_ATTEMPTS) {
            console.log('⚠️ botLid لسا فارغة بعد الفحص الاحتياطي')
            clearInterval(lidRetryInterval)
            lidRetryInterval = null
          }
        }, 5000)
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      console.log(`🔌 الاتصال انقطع، رمز الحالة: ${code}`)

      if (code === DisconnectReason.loggedOut) {
        console.log('Log out 🚪')
        process.exit(0)
      }

      // ننظف أي مؤقت التقاط LID عالق قبل الانتقال لـsock جديد
      if (lidRetryInterval) {
        clearInterval(lidRetryInterval)
        lidRetryInterval = null
      }

      // نزيل كل مستمعي هذا الـsock القديم قبل إعادة الاتصال داخل نفس العملية، لتفادي أي
      // تعامل مزدوج أو حالة عالقة من الـsock القديم أثناء إنشاء sock جديد بنفس العملية
      sock.ev.removeAllListeners()

      console.log('Reconnection within 5 seconds 🔄...')
      setTimeout(startBot, 5000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // نسجّل مفتاح كل رسالة جروب هنا (قبل فحص notify)، لأن رسائل البوت نفسه (fromMe:true)
    // قد تصل بنوع 'append' بدل 'notify' حتى مع emitOwnEvents:true — لو حصرنا التسجيل خلف
    // فحص notify فقط، نخاطر بتفويت رسائل البوت مجدداً بصمت. بقية المعالجة (تصنيف، ردود...)
    // تبقى مقصورة على notify فقط كالسابق تماماً، فهذا التغيير لا يوسّع أي سلوك آخر غير التسجيل
    for (const rawMsg of messages) {
      const rawChatId = rawMsg?.key?.remoteJid
      const rawIsGroup = rawChatId?.endsWith('@g.us')
      if (rawIsGroup && rawMsg?.key?.id) {
        const loggedSenderJid = rawMsg.key.fromMe
          ? (botJid || botLid || rawMsg.key.participantPn || rawMsg.key.participant || rawChatId)
          : (rawMsg.key.participantPn || rawMsg.key.participant || rawChatId)
        const loggedAltIds = rawMsg.key.fromMe
          ? [botJid, botLid].filter(Boolean)
          : [rawMsg.key.participantPn, rawMsg.key.participant].filter(Boolean)

        if (rawMsg.key.fromMe) {
          console.log(`🔍 [تشخيص تسجيل] رسالة بوت وصلت: type=${type} id=${rawMsg.key.id} botJid=${botJid} botLid=${botLid} loggedSenderJid=${loggedSenderJid} chatId=${rawChatId}`)
        }

        messageLog.recordMessage(
          rawChatId, loggedSenderJid, rawMsg.key.id,
          Number(rawMsg.messageTimestamp) * 1000 || Date.now(),
          loggedAltIds,
          !!rawMsg.key.fromMe
        )
      }
    }

    if (type !== 'notify') return

    const msg = messages[0]
    if (!msg?.message) return

    const chatId = msg.key.remoteJid
    const isGroup = chatId?.endsWith('@g.us')

    if (msg.key.fromMe) return

    const senderJid = msg.key.participantPn || msg.key.participant || chatId
    const senderBare = bareId(senderJid)
    // بعض المجموعات تسجل الأعضاء بصيغة LID فقط (بدون رقم هاتف بحقل id إطلاقاً)، لذا نجمع
    // كل الصيغ المعروفة لهوية المرسل هنا، ونتحقق من العضوية بالإشراف مقابلها جميعاً معاً
    const senderIdentifiers = [bareId(msg.key.participantPn), bareId(msg.key.participant)].filter(Boolean)
    const text = extractText(msg)
    const hasImage = hasAttachedMedia(msg)

    if (!text && !hasImage) return

    // بعد ربط جديد (QR/كود اقتران) تحديداً، قد تصل أول رسالة قبل أن يكتمل حدث
    // 'connection'=='open' فعلياً وتُعبّأ botJid/botLid، فتبقى selfIds فارغة تماماً ويفشل فحص
    // المنشن/الرد دائماً بصمت (فحص الاسم بالنص لا يتأثر لأنه لا يعتمد على selfIds، لذا كان
    // "يا بوت" يشتغل بينما المنشن/الرد لا). ننتظر قليلاً (حتى 8 ثوانٍ) بدل المتابعة ببيانات
    // ناقصة، فتُعالَج أول رسالة صح بدل تجاهلها بصمت أو رفضها خطأً
    if (!botJid) {
      const WAIT_STEP_MS = 300
      const MAX_WAIT_MS = 8000
      let waited = 0
      while (!botJid && waited < MAX_WAIT_MS) {
        await new Promise(r => setTimeout(r, WAIT_STEP_MS))
        waited += WAIT_STEP_MS
      }
    }

    const selfIds = [bareId(botJid), bareId(botLid)].filter(Boolean)

    // إذا لم يُنادَ البوت لا يفعل شيئًا — نتحقق من هذا الآن، قبل أي طلب شبكة مكلف مثل
    // جلب بيانات المجموعة، حتى لا نستهلك موارد على رسائل عادية لا تخص البوت إطلاقاً
    let addressResult = await detectBotAddress(text || '', selfIds, msg, sock)

    // نتحفظ بأي groupInfo نجلبه هنا مبكراً، لنعيد استخدامه لاحقاً بدل تكرار نفس الطلب
    let earlyGroupInfo = null

    if (!addressResult.called && isGroup && !botLid) {
      // منشن أو رد قد يكون فشل اكتشافه فقط لأننا لا نعرف botLid بعد (وليس لأن الرسالة
      // فعلاً لا تخص البوت) — نتحقق: هل الرسالة أصلاً فيها سياق منشن/رد خام؟ إذا نعم،
      // نجرب نتعلم LID الخاص بنا من قائمة أعضاء المجموعة (بيانات سنحتاجها بأي حال)
      // ونعيد فحص العنونة مرة واحدة بمعرّفات محدّثة، بدل الاستسلام النهائي بصمت
      const ctxCheck = getContextInfo(msg)
      const hasRawMentionContext = !!(ctxCheck?.participant || (ctxCheck?.mentionedJid?.length > 0))

      if (hasRawMentionContext) {
        try {
          earlyGroupInfo = await actions.fetchGroupInfo(sock, chatId)
          const learnedLid = findOwnLidFromParticipants(earlyGroupInfo.participants, botJid)
          if (learnedLid) {
            botLid = learnedLid
            console.log(`✅ botLid عبر قائمة أعضاء المجموعة: ${bareId(botLid)}`)
            const retrySelfIds = [bareId(botJid), bareId(botLid)].filter(Boolean)
            addressResult = await detectBotAddress(text || '', retrySelfIds, msg, sock)
          }
        } catch (e) {
          console.error('⚠️ فشلت محاولة تعلم botLid من قائمة أعضاء المجموعة:', e.message)
        }
      }
    }

    if (!addressResult.called) return
    const wasCalledByGenericBotWord = addressResult.isGenericBotWord

    // حماية صامتة من السبام — لا رد إطلاقاً هنا، فقط تجاهل. توضع هنا (قبل أي طلب Gemini
    // أو شبكة) حتى تبقى خط الدفاع الأول الفعلي ضد رسائل متكررة سريعة، بدل أن تُستهلك
    // طلبات Gemini على كل رسالة قبل الوصول لفحص الحد الأدنى الزمني
    if (rateLimit.isRateLimited(chatId)) return
    rateLimit.markRequest(chatId)

    // اسم البوت مذكور بالنص (لا منشن ولا رد مباشر) — هذي الحالة الوحيدة فيها لبس فعلي:
    // هل الرسالة موجّهة له، أو مجرد حديث عنه لطرف ثالث؟ نفحص هذا قبل أي معالجة أخرى
    if (addressResult.triggeredBy === 'text') {
      const isDirectAddress = await gemini.classifyAddressIntent(text || '')
      if (!isDirectAddress) return
    }

    let groupInfo = earlyGroupInfo
    let senderIsAdmin = false

    if (isGroup && !groupInfo) {
      try {
        groupInfo = await actions.fetchGroupInfo(sock, chatId)
      } catch (e) {
        console.error('❌ خطأ في جلب معلومات المجموعة:', e.message)
        const errText = await gemini.generateContextualReply({
          chatId,
          reasonKey: 'group_metadata_failed',
          reasonContext: 'تعذر جلب بيانات المجموعة من واتساب (خطأ تقني بالاتصال)',
          userText: text,
        })
        await sock.sendMessage(chatId, { text: errText }, { quoted: msg }).catch(() => {})
        return
      }
    }

    if (isGroup && groupInfo) {
      senderIsAdmin = senderIdentifiers.some(id => groupInfo.adminList.includes(id))
    }

    const groupState = isGroup ? getGroupState(chatId) : { adminOnlyCommands: false }
    const senderName = msg.pushName || senderBare || 'unknown'

    console.log(`\n📨 [${senderName}]: ${text || '[media]'}`)

    try { await sock.sendPresenceUpdate('composing', chatId) } catch {}

    const reply = async (txt) => {
      if (!txt) return
      return sock.sendMessage(chatId, { text: txt }, { quoted: msg })
    }

    // ────────────────────────────────────────────
    //  أولوية قصوى: هل فيه تأكيد معلق بهذه المحادثة؟
    // ────────────────────────────────────────────
    const pending = memory.getPendingConfirmation(chatId, senderBare)

    if (pending) {
      // مسار خاص لتفاصيل حزمة الملصقات — لا يمر عبر Gemini إطلاقاً هنا، فقط تحليل حتمي
      // للصيغة الثابتة (3 أسطر). هذا يلغي أي احتمال خطأ عشوائي بالأعداد من نموذج لغوي
      if (pending.action === 'awaiting_sticker_details') {
        const details = parseStickerDetailsReply(text)

        if (!details) {
          // الصيغة غير مطابقة — نطلب إعادة المحاولة بنفس الصيغة، والتأكيد يبقى معلقاً
          // عمداً (لا نمسحه) حتى يحاول المستخدم مرة أخرى أو تنتهي صلاحية الانتظار تلقائياً
          const retryText = await gemini.generateContextualReply({
            chatId, reasonKey: 'sticker_details_invalid_format',
            reasonContext: 'المستخدم كان المفروض يرسل تفاصيل الملصقات بصيغة 3 أسطر محددة (الموضوع، عدد المتحركة، عدد العادية) لكن رده لم يطابق هذه الصيغة، اطلب منه إعادة المحاولة بنفس الصيغة المطلوبة',
            userText: text,
          })
          await reply(retryText)
          return
        }

        if (details.animated === 0 && details.static === 0) {
          memory.clearPendingConfirmation(chatId, senderBare)
          const zeroText = await gemini.generateContextualReply({
            chatId, reasonKey: 'sticker_details_all_zero',
            reasonContext: 'المستخدم حدد صفر بكلا عددي المتحركة والعادية، فلا يوجد أي ملصق فعلي مطلوب',
            userText: text,
          })
          await reply(zeroText)
          return
        }

        const requestedTotal = details.animated + details.static
        if (requestedTotal > stickerPack.MAX_STICKERS) {
          // نطلب توضيحاً بدل اقتطاع صامت لأحد النوعين ليلائم الحد الأقصى، حتى يقرر
          // المستخدم بنفسه كيف يوزع العدد بدل ما نقرر نيابة عنه بطريقة قد لا تناسبه
          const tooManyText = await gemini.generateContextualReply({
            chatId, reasonKey: 'sticker_details_over_max',
            reasonContext: `المستخدم طلب ${requestedTotal} ملصق إجمالاً (${details.animated} متحرك + ${details.static} عادي) لكن الحد الأقصى المسموح هو ${stickerPack.MAX_STICKERS}، اطلب منه يعيد الإرسال بنفس الصيغة (3 أسطر) بمجموع لا يتجاوز ${stickerPack.MAX_STICKERS}`,
            userText: text,
          })
          await reply(tooManyText)
          return
        }

        memory.clearPendingConfirmation(chatId, senderBare)
        lastAiLatencyMs = 0
        try { await sock.sendPresenceUpdate('paused', chatId) } catch {}
        await executeStickerPackRequest({ sock, chatId, msg, text, details, reply })
        return
      }

      // مسار خاص لتفاصيل حزمة الصور — نفس صيغة الملصقات بالضبط (3 أسطر: موضوع/متحرك/عادي)
      // بعد إضافة دعم GIF المتحركة للصور أيضاً
      if (pending.action === 'awaiting_photo_details') {
        const details = parseStickerDetailsReply(text)

        if (!details) {
          const retryText = await gemini.generateContextualReply({
            chatId, reasonKey: 'photo_details_invalid_format',
            reasonContext: 'المستخدم كان المفروض يرسل تفاصيل الصور بصيغة 3 أسطر محددة (الموضوع، عدد GIF المتحركة، عدد الصور العادية) لكن رده لم يطابق هذه الصيغة، اطلب منه إعادة المحاولة بنفس الصيغة المطلوبة',
            userText: text,
          })
          await reply(retryText)
          return
        }

        if (details.animated === 0 && details.static === 0) {
          memory.clearPendingConfirmation(chatId, senderBare)
          const zeroText = await gemini.generateContextualReply({
            chatId, reasonKey: 'photo_details_all_zero',
            reasonContext: 'المستخدم حدد صفر بكلا عددي المتحركة والعادية، فلا يوجد أي صورة فعلية مطلوبة',
            userText: text,
          })
          await reply(zeroText)
          return
        }

        const requestedTotal = details.animated + details.static
        if (requestedTotal > photoPack.MAX_PHOTOS) {
          const tooManyText = await gemini.generateContextualReply({
            chatId, reasonKey: 'photo_details_over_max',
            reasonContext: `المستخدم طلب ${requestedTotal} صورة إجمالاً (${details.animated} متحركة + ${details.static} عادية) لكن الحد الأقصى المسموح هو ${photoPack.MAX_PHOTOS}، اطلب منه يعيد الإرسال بنفس الصيغة (3 أسطر) بمجموع لا يتجاوز ${photoPack.MAX_PHOTOS}`,
            userText: text,
          })
          await reply(tooManyText)
          return
        }

        memory.clearPendingConfirmation(chatId, senderBare)
        lastAiLatencyMs = 0
        try { await sock.sendPresenceUpdate('paused', chatId) } catch {}
        await executePhotoPackRequest({ sock, chatId, msg, text, details, reply })
        return
      }

      // مسار خاص لتأكيد طرد الكل — لا يحتاج منطق اختيار مرشح، فقط تأكيد أو رفض صريح
      if (pending.action === 'kick_all') {
        const intent = await gemini.classifyGenericConfirmation(
          text, `طرد جميع أعضاء المجموعة (${pending.candidates.length} عضو)`
        )
        lastAiLatencyMs = 0
        try { await sock.sendPresenceUpdate('paused', chatId) } catch {}

        if (intent === 'confirm') {
          memory.clearPendingConfirmation(chatId, senderBare)
          await executeBulkKick({
            sock, chatId, msg, targetJids: pending.candidates, groupInfo, reply, originalText: pending.originalText,
          })
          return
        }

        if (intent === 'deny') {
          memory.clearPendingConfirmation(chatId, senderBare)
          const cancelText = await gemini.generateContextualReply({
            chatId, reasonKey: 'kick_all_cancelled',
            reasonContext: 'المستخدم تراجع عن طرد جميع أعضاء المجموعة',
            userText: text,
          })
          await reply(cancelText)
          return
        }

        // unclear — التأكيد يبقى معلقاً، نطلب توضيحاً صريحاً بس بدون تنفيذ
        const clarifyText = await gemini.generateContextualReply({
          chatId, reasonKey: 'kick_all_still_unclear',
          reasonContext: 'المستخدم لم يؤكد أو يرفض بوضوح طرد جميع الأعضاء بعد، اطلب تأكيداً صريحاً بنعم أو لا',
          userText: text,
        })
        await reply(clarifyText)
        return
      }

      const structuredCandidates = pending.candidates.map((jid, index) => ({
        index,
        bareId: bareId(jid), // نفس دالة bareId المستوردة أعلاه، الاسم مطابق فقط لسهولة القراءة بجانب gemini.js
      }))
      const intentResult = await gemini.classifyConfirmationIntent(text, structuredCandidates)

      lastAiLatencyMs = 0 // لا يوجد وقت أمر تنفيذي هنا بعد

      try { await sock.sendPresenceUpdate('paused', chatId) } catch {}

      if (intentResult.intent === 'deny') {
        memory.clearPendingConfirmation(chatId, senderBare)
        const cancelText = await gemini.generateContextualReply({
          chatId,
          reasonKey: 'confirmation_cancelled',
          reasonContext: 'المستخدم تراجع عن تنفيذ الأمر المعلق (طرد/ترقية/تنزيل إشراف)',
          userText: text,
        })
        await reply(cancelText)
        return
      }

      if (intentResult.intent === 'confirm') {
        // حالة أ: مرشح واحد بس أصلاً — تأكيد عام يكفي
        if (pending.candidates.length === 1) {
          memory.clearPendingConfirmation(chatId, senderBare)
          await executeTargetedAction({
            sock, chatId, msg, action: pending.action,
            targetJid: pending.candidates[0], groupInfo, reply, originalText: pending.originalText,
          })
          return
        }

        // حالة ب: عدة مرشحين، والمستخدم حدد فهرس صالح منهم بوضوح
        const validIndex = Number.isInteger(intentResult.chosenIndex)
          && intentResult.chosenIndex >= 0
          && intentResult.chosenIndex < pending.candidates.length

        if (validIndex) {
          const chosenJid = pending.candidates[intentResult.chosenIndex]
          memory.clearPendingConfirmation(chatId, senderBare)
          await executeTargetedAction({
            sock, chatId, msg, action: pending.action,
            targetJid: chosenJid, groupInfo, reply, originalText: pending.originalText,
          })
          return
        }

        // تأكيد عام بدون تحديد مين، وفيه أكثر من مرشح — لازم تحديد صريح، نطلب توضيح
      }

      // أي حالة متبقية (unclear، أو confirm بدون تحديد صالح من عدة مرشحين) — نطلب توضيح صريح
      // التأكيد يبقى معلقاً هنا عمداً (لا نمسحه) حتى يحدد المستخدم مين يقصد أو يرفض صراحة
      const clarifyText = await gemini.generateContextualReply({
        chatId,
        reasonKey: 'confirmation_still_ambiguous',
        reasonContext: 'المستخدم لم يوضح بعد أي شخص يقصد من بين عدة مرشحين محتملين، اطلب منه يحدد بوضوح برقم الترتيب أو منشن مباشر',
        userText: text,
      })
      await reply(clarifyText)
      return
    }

    // ────────────────────────────────────────────
    //  التصنيف العادي
    // ────────────────────────────────────────────
    const aiStart = Date.now()
    const currentMentions = getMentionedJids(msg).filter(j => !selfIds.includes(bareId(j)))

    let classified
    try {
      classified = await gemini.classifyMessage(text || ' ', chatId, senderName, groupInfo, currentMentions, wasCalledByGenericBotWord)

      // إذا طلب البحث ضمن نفس الاستدعاء الأول، ننفذه ثم نعيد الاستدعاء مرة واحدة فقط
      // بنتيجة حقيقية (سقف واحد لإعادة الاستدعاء يمنع أي حلقة نظرية غير متوقعة)
      if (classified.needsSearch) {
        const placeholderMsg = classified.msg
        let searchResult
        try {
          const webResult = await gemini.performWebSearch(classified.searchQuery || text || '')
          searchResult = webResult !== null ? webResult : 'search_failed'
        } catch (e) {
          console.error('❌ فشل تنفيذ البحث:', e.message)
          searchResult = 'search_failed'
        }

        const afterSearch = await gemini.classifyMessage(text || ' ', chatId, senderName, groupInfo, currentMentions, wasCalledByGenericBotWord, searchResult)

        // حماية: لو Gemini كرر نفس الرد المؤقت الأول رغم توفر نتيجة البحث (بدل صياغة رد
        // نهائي فعلي)، أو لا يزال يطلب بحثاً إضافياً، نضمن وصول معلومة حقيقية للمستخدم
        // بدل ما يعلق على الرد المؤقت بلا متابعة
        const stillPlaceholder = afterSearch.needsSearch || (afterSearch.msg && afterSearch.msg === placeholderMsg)

        if (stillPlaceholder && searchResult && searchResult !== 'search_failed') {
          classified = { ...afterSearch, needsSearch: false, msg: searchResult }
        } else if (stillPlaceholder && searchResult === 'search_failed') {
          classified = { ...afterSearch, needsSearch: false, msg: 'ما قدرت أتحقق من معلومات حالية الآن، جرب بعدين' }
        } else {
          classified = afterSearch
        }
      }
    } catch (err) {
      console.error('❌ فشل التصنيف نهائياً:', err.message)
      lastAiLatencyMs = Date.now() - aiStart
      try { await sock.sendPresenceUpdate('paused', chatId) } catch {}
      const errText = await gemini.generateContextualReply({
        chatId,
        reasonKey: 'classification_failed',
        reasonContext: 'تعذر فهم الرسالة تقنياً بسبب خطأ بالاتصال بمحرك الذكاء الاصطناعي',
        userText: text,
      })
      await reply(errText)
      return
    }

    lastAiLatencyMs = Date.now() - aiStart
    try { await sock.sendPresenceUpdate('paused', chatId) } catch {}

    // إذا نظام المشرفين مفعل، الأوامر فقط للمشرفين (reply و confirmation_reply ليسا أوامر تنفيذية)
    const isExecutableCommand = classified.action !== 'reply' && classified.action !== 'confirmation_reply'
    if (isGroup && groupState.adminOnlyCommands && isExecutableCommand && !senderIsAdmin) {
      const deniedText = await gemini.generateContextualReply({
        chatId,
        reasonKey: 'admin_only_mode_blocked',
        reasonContext: 'نظام (الأوامر للمشرفين فقط) مفعل بالجروب والمستخدم ليس مشرفاً فحاول ينفذ أمراً',
        userText: text,
      })
      await reply(deniedText)
      return
    }
    // ----------- إضافة التفاعلات على الأوامر فقط -----------
    if (isExecutableCommand) {
      let reactionEmoji = "✅"
      switch (classified.action) {
        case 'send_song': reactionEmoji = "🎵"; break;
        case 'make_sticker': reactionEmoji = "✨"; break;
        case 'send_stickers': reactionEmoji = "🖼️"; break;
        case 'send_photos': reactionEmoji = "📷"; break;
        case 'close_chat': reactionEmoji = "🔒"; break;
        case 'open_chat': reactionEmoji = "🔓"; break;
        case 'delete_quoted': case 'bulk_delete': reactionEmoji = "🗑️"; break;
        case 'kick': case 'kick_all': reactionEmoji = "🥾"; break;
        case 'promote': reactionEmoji = "⭐"; break;
        case 'demote': reactionEmoji = "⬇️"; break;
        case 'change_picture': reactionEmoji = "🖼️"; break;
        case 'rename_group': case 'change_description': reactionEmoji = "✏️"; break;
        case 'help': reactionEmoji = "ℹ️"; break;
        case 'status': reactionEmoji = "⚙️"; break;
        case 'usage': reactionEmoji = "📊"; break;
        case 'get_info': reactionEmoji = "📋"; break;
        case 'toggle_admin_only': reactionEmoji = "🛡️"; break;
      }
      try {
        await sock.sendMessage(chatId, { react: { text: reactionEmoji, key: msg.key } })
      } catch (e) {}
    }
    // ----------------------------------------------------

    await handleClassifiedAction({
      sock, chatId, msg, text, classified, groupInfo, groupState,
      senderIsAdmin, isGroup, hasImage, reply, selfIds,
      lastAiLatencyMs, botStartedAt, senderBare, currentMentions,
    })
  })
}

// ══════════════════════════════════════════════════════
//  🎬 تنفيذ الأمر بعد التصنيف
// ══════════════════════════════════════════════════════

async function requireGroup(isGroup, chatId, reply, text) {
  if (isGroup) return true
  const msgText = await gemini.generateContextualReply({
    chatId, reasonKey: 'not_a_group',
    reasonContext: 'الأمر المطلوب يعمل فقط داخل مجموعات وهذه محادثة خاصة',
    userText: text,
  })
  await reply(msgText)
  return false
}

async function requireAdmin(senderIsAdmin, chatId, reply, text) {
  if (senderIsAdmin) return true
  const msgText = await gemini.generateContextualReply({
    chatId, reasonKey: 'not_admin',
    reasonContext: 'المستخدم ليس مشرفاً بالمجموعة وهذا الأمر يتطلب صلاحيات إشراف',
    userText: text,
  })
  await reply(msgText)
  return false
}

async function requireValue(value, chatId, reply, text, whatIsMissing) {
  if (value) return true
  const msgText = await gemini.generateContextualReply({
    chatId, reasonKey: `missing_value_${whatIsMissing}`,
    reasonContext: `المستخدم طلب أمراً لكنه لم يحدد ${whatIsMissing} المطلوب لتنفيذه`,
    userText: text,
  })
  await reply(msgText)
  return false
}

// يتحقق إن كان جيد معين مشرفاً، بمطابقة مباشرة على قائمة المشاركين الخام بنفس صيغة
// المعرّف الأصلية (JID أو LID)، بدل قائمة adminList المبسّطة التي قد تفقد معلومات
// الصيغة وتسبب عدم تطابق خاطئ بين الحسابات المسجلة بصيغ مختلفة داخل نفس المجموعة
function isParticipantAdmin(groupInfo, targetJid) {
  const targetBare = bareId(targetJid)
  const member = groupInfo?.participants?.find(p => bareId(p.id) === targetBare)
  return !!member?.admin
}

// ينفذ فعلياً أمراً على هدف محدد (يُستخدم من التصنيف المباشر أو من مسار التأكيد)
async function executeTargetedAction({ sock, chatId, msg, action, targetJid, groupInfo, reply, originalText }) {
  const targetBare = bareId(targetJid)

  try {
    if (action === 'kick') {
      await actions.updateParticipant(sock, chatId, targetJid, 'remove')
    } else if (action === 'promote') {
      if (isParticipantAdmin(groupInfo, targetJid)) {
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'promote_already_admin',
          reasonContext: 'المستخدم طلب ترقية شخص لكنه مشرف أصلاً',
          userText: originalText,
        })
        await reply(msgText)
        return
      }
      await actions.updateParticipant(sock, chatId, targetJid, 'promote')
    } else if (action === 'demote') {
      if (!isParticipantAdmin(groupInfo, targetJid)) {
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'demote_not_admin',
          reasonContext: 'المستخدم طلب تنزيل إشراف عن شخص لكنه ليس مشرفاً أصلاً',
          userText: originalText,
        })
        await reply(msgText)
        return
      }
      await actions.updateParticipant(sock, chatId, targetJid, 'demote')
    }

    const ack = await gemini.generateActionAck({
      action, userText: originalText, detail: targetBare, success: true,
    })
    await reply(ack)
  } catch (e) {
    console.error(`❌ تنفيذ ${action} فشل:`, e.message)
    const msgText = await gemini.generateContextualReply({
      chatId, reasonKey: `${action}_execution_failed`,
      reasonContext: `فشل تنفيذ أمر ${action} تقنياً، الأغلب لأن البوت ليس مشرفاً بالمجموعة أو الشخص غير موجود`,
      userText: originalText,
    })
    await reply(msgText)
  }
}

// يطرد قائمة أهداف دفعة واحدة، يتجاوز أي فشل فردي ويكمل الباقي، ويلخص النتيجة بالنهاية
async function executeBulkKick({ sock, chatId, msg, targetJids, groupInfo, reply, originalText }) {
  const succeeded = []
  const failed = []

  for (const targetJid of targetJids) {
    const targetBare = bareId(targetJid)
    try {
      await actions.updateParticipant(sock, chatId, targetJid, 'remove')
      succeeded.push(targetBare)
    } catch (e) {
      console.error(`❌ فشل طرد ${targetBare} ضمن الطرد الجماعي:`, e.message)
      failed.push(targetBare)
    }
  }

  const summaryContext = failed.length === 0
    ? `طُرد ${succeeded.length} أشخاص بنجاح ضمن أمر طرد جماعي، بدون أي فشل`
    : succeeded.length === 0
      ? `فشل طرد كل الأشخاص المطلوبين (${failed.length}) ضمن أمر طرد جماعي، على الأغلب لأن البوت ليس مشرفاً`
      : `طُرد ${succeeded.length} أشخاص بنجاح ضمن أمر طرد جماعي، وفشل طرد ${failed.length} منهم لأسباب تقنية`

  const ack = await gemini.generateActionAck({
    action: 'kick', userText: originalText, detail: summaryContext, success: succeeded.length > 0,
  })
  await reply(ack)
}

// يدير أمر الحذف الجماعي (bulk_delete) بحالاته الثلاث: رد على شخص، منشن شخص أو أكثر، أو
// بدون تحديد (يحذف من الجميع). يعتمد على messageLog الذي يبني نفسه تدريجياً من لحظة تفعيل
// هذي الميزة فصاعداً — لا يمكنه حذف رسائل أقدم من ذلك أو لم يرصدها البوت وهو متصل فعلياً
async function handleBulkDelete({ sock, chatId, msg, text, classified, senderIsAdmin, isGroup, reply, currentMentions, selfIds }) {
  if (!(await requireGroup(isGroup, chatId, reply, text))) return
  if (!(await requireAdmin(senderIsAdmin, chatId, reply, text))) return

  // نحدد وضع الاستهداف أولاً (قبل حساب العدد)، لأن العدد الافتراضي عند عدم التحديد
  // يختلف حسب وجود هدف محدد أم لا (10 لشخص معين، 20 لحذف عام بلا هدف)
  // نحدد وضع الاستهداف بنفس أولوية resolveTarget (منشن مباشر > رد مباشر > عام)، لأن هذا
  // أوضح إشارة نية صريحة بالرسالة الحالية نفسها، بعكس الاعتماد على تخمين من الذاكرة هنا
  const ctx = getContextInfo(msg)
  // نتحقق من كل صيغ هوية "من رددت عليه" المعروفة (participant وparticipantPn معاً)، لأن
  // واتساب قد يرسل الرد بصيغة LID بينما سُجّلت رسائل الشخص أصلاً بصيغة رقم الهاتف أو العكس
  const repliedToRaw = ctx?.participant || ctx?.participantPn || null
  const repliedToBare = repliedToRaw ? bareId(repliedToRaw) : null
  // مهم: الرد على رسالة البوت نفسه هو مجرد طريقة لمخاطبة البوت (تماماً كمناداته بالاسم)،
  // وليس تحديداً لهدف الحذف. بدون هذا الاستثناء، أي رد على رسالة البوت لطلب حذف عام كان
  // يُفهم خطأً كطلب "احذف رسائل البوت نفسه فقط" فيفشل لعدم وجود سجل مطابق
  const repliedToIsBot = repliedToBare && selfIds.includes(repliedToBare)

  let targets = [] // [{ bare, jid }] — فارغة تعني "الجميع" (الحالة 4)

  if (currentMentions.length > 0) {
    targets = currentMentions.map(jid => ({ bare: bareId(jid), jid }))
  } else if (repliedToBare && !repliedToIsBot) {
    targets = [{ bare: repliedToBare, jid: repliedToRaw }]
  }

  // العدد: نستخدم ما حدده المستخدم صراحة إن وُجد، وإلا نطبّق افتراضياً حسب وجود هدف محدد
  // (10 رسائل للشخص المحدد، 20 رسالة للحذف العام) بدل رفض الأمر لمجرد غياب رقم صريح
  const requestedCount = classified.deleteCount > 0
    ? classified.deleteCount
    : (targets.length > 0 ? messageLog.DEFAULT_DELETE_COUNT_TARGETED : messageLog.DEFAULT_DELETE_COUNT_GENERAL)

  const count = Math.min(requestedCount, messageLog.MAX_DELETE_PER_REQUEST)

  // نجمع كل مفاتيح الرسائل المطلوب حذفها أولاً (لكل هدف على حدة، أو عاماً لو بدون هدف)،
  // قبل تنفيذ أي حذف فعلي، حتى نعرف مسبقاً هل يوجد شيء نحذفه أصلاً. الحذف العام (بلا هدف)
  // يشمل رسائل البوت نفسه أيضاً لو وقعت ضمن آخر N رسالة، لأنها جزء حقيقي من تلك الرسائل
  const deletionPlan = [] // [{ entry, targetBare }]

  if (targets.length > 0) {
    for (const target of targets) {
      const entries = messageLog.getLastMessagesFrom(chatId, target.bare, count)
      entries.forEach(entry => deletionPlan.push({ entry, targetBare: target.bare }))
    }
  } else {
    const entries = messageLog.getLastMessagesAny(chatId, count)
    entries.forEach(entry => deletionPlan.push({ entry, targetBare: bareId(entry.participant) }))
  }

  if (deletionPlan.length === 0) {
    const msgText = await gemini.generateContextualReply({
      chatId, reasonKey: 'bulk_delete_nothing_logged',
      reasonContext: 'المستخدم طلب حذف عدة رسائل لكن البوت لم يرصد أي رسائل مؤهلة للحذف بعد من هذا الشخص أو بهذي المجموعة — السجل يبدأ فارغاً من لحظة تشغيل هذي الميزة فصاعداً فقط، ولا يمكنه رؤية رسائل أرسلت قبل ذلك',
      userText: text,
    })
    await reply(msgText)
    return
  }

  // تشخيص مؤقت: نطبع الخطة الكاملة قبل التنفيذ (هل رسائل البوت موجودة فعلاً بالخطة؟ كم
  // منها؟) لأن سجل الحذف السابق أظهر رسائل من مستخدم واحد فقط، ولم يتضح إن كان هذا لأن
  // رسائل البوت فعلاً غير موجودة بآخر N، أو لأنها موجودة لكن شيء آخر يستبعدها بصمت
  console.log(`🔍 [تشخيص] خطة الحذف الكاملة (${deletionPlan.length} رسالة):`)
  deletionPlan.forEach(({ entry, targetBare }, i) => {
    console.log(`   [${i}] id=${entry.id} fromMe=${entry.fromMe} participant=${entry.participant} targetBare=${targetBare} timestamp=${entry.timestamp}`)
  })

  let succeeded = 0
  let failed = 0

  for (const { entry } of deletionPlan) {
    // مفتاح الحذف داخل مجموعة (بعكس محادثة خاصة) يتطلب حقل participant دائماً، حتى لرسائل
    // البوت نفسه (fromMe:true) — تأكدنا من هذا من بيانات فعلية حقيقية صادرة من Baileys نفسه
    // بمجموعات (وليس من مثال توثيق عام للمحادثات الخاصة فقط، الذي يحذف participant لأنه لا
    // معنى له أصلاً بمحادثة ثنائية). سابقاً كنا نحذف participant لرسائل fromMe:true، فكان
    // واتساب يستقبل الطلب بصمت (بلا خطأ) لكن لا ينفذ الحذف الفعلي لأن المفتاح غير مكتمل
    const key = entry.fromMe
      ? { remoteJid: chatId, id: entry.id, participant: entry.participant, fromMe: true }
      : { remoteJid: chatId, id: entry.id, participant: entry.participant, fromMe: false }
    try {
      await actions.deleteQuotedMessage(sock, chatId, key)
      succeeded++
    } catch (e) {
      console.error(`❌ فشل حذف رسالة ضمن الحذف الجماعي (id=${entry.id}, fromMe=${entry.fromMe}):`, e.message)
      failed++
      // فشل رسالة فردية لا يوقف الباقي — قد تكون خارج نافذة الحذف الزمنية لواتساب
      // (~يومين ونصف) رغم وجودها بسجلنا، وهذا لا يعني فشل بقية الرسائل الأحدث
    }
  }


  const summaryContext = failed === 0
    ? `حُذفت ${succeeded} رسالة بنجاح ضمن أمر حذف جماعي، بدون أي فشل`
    : succeeded === 0
      ? `فشل حذف كل الرسائل المطلوبة (${failed}) ضمن أمر حذف جماعي، غالباً لأنها تجاوزت المدة الزمنية المسموحة للحذف بواتساب أو لأن البوت فقد صلاحية الإشراف`
      : `حُذفت ${succeeded} رسالة بنجاح ضمن أمر حذف جماعي، وفشل حذف ${failed} منها (غالباً لتجاوزها مدة الحذف المسموحة بواتساب)`

  const ack = await gemini.generateActionAck({
    action: 'bulk_delete', userText: text, detail: summaryContext, success: succeeded > 0,
  })
  await reply(ack)
}

// يدير أوامر الهدف (kick/promote/demote) عبر resolveTarget بحالاته الأربع (بما فيها الاستهداف الجماعي)
async function handleTargetedCommand({ sock, chatId, msg, action, classified, groupInfo, senderIsAdmin, isGroup, text, reply, selfIds, senderBare }) {
  if (!(await requireGroup(isGroup, chatId, reply, text))) return
  if (!(await requireAdmin(senderIsAdmin, chatId, reply, text))) return

  const resolution = resolveTarget(msg, selfIds, classified.value, chatId, {
    groupInfo,
    targetIsCertain: classified.targetIsCertain,
  })

  if (resolution.status === 'none') {
    const msgText = await gemini.generateContextualReply({
      chatId, reasonKey: `${action}_no_target`,
      reasonContext: `المستخدم طلب ${action === 'kick' ? 'طرد' : action === 'promote' ? 'ترقية' : 'تنزيل إشراف'} شخص لكن لم يحدد منشن أو رد على رسالته ولا يوجد سياق واضح بالمحادثة`,
      userText: text,
    })
    await reply(msgText)
    return
  }

  if (resolution.status === 'multiple') {
    if (action === 'kick') {
      await executeBulkKick({ sock, chatId, msg, targetJids: resolution.jids, groupInfo, reply, originalText: text })
      return
    }

    // للترقية والتنزيل، لم يُطلب دعم جماعي — نعامل عدة منشنات مباشرة كحالة تحتاج توضيح
    // بدل توسيع النطاق تلقائياً لأمر لم يُطلب دعمه بالجملة
    memory.setPendingConfirmation(chatId, senderBare, {
      action, candidates: resolution.jids, originalText: text,
    })
    const count = resolution.jids.length
    const msgText = await gemini.generateContextualReply({
      chatId, reasonKey: `${action}_ambiguous_target`,
      reasonContext: `المستخدم منشن ${count} أشخاص مباشرة لكن أمر ${action === 'promote' ? 'الترقية' : 'تنزيل الإشراف'} يُطبّق على شخص واحد فقط حالياً، اطلب منه يحدد بترتيب الذكر (الأول، الثاني...) مين بالضبط يقصد`,
      userText: text,
    })
    await reply(msgText)
    return
  }

  if (resolution.status === 'ambiguous') {
    memory.setPendingConfirmation(chatId, senderBare, {
      action, candidates: resolution.candidates, originalText: text,
    })
    const count = resolution.candidates.length
    const msgText = await gemini.generateContextualReply({
      chatId, reasonKey: `${action}_ambiguous_target`,
      reasonContext: `المستخدم طلب ${action === 'kick' ? 'طرد' : action === 'promote' ? 'ترقية' : 'تنزيل إشراف'} لكن فيه ${count} أشخاص محتملين بالسياق الأخير وغير واضح مين بالضبط، اطلب منه يحدد بترتيب الذكر (الأول، الثاني...) أو بمنشن مباشر — لا تذكر أي أرقام هاتف`,
      userText: text,
    })
    await reply(msgText)
    return
  }

  // certain
  await executeTargetedAction({
    sock, chatId, msg, action, targetJid: resolution.jid, groupInfo, reply, originalText: text,
  })
}

// ينفذ حزمة الملصقات مباشرة بتفاصيل دقيقة معروفة سلفاً (من رد المستخدم المُحلَّل بصيغته
// الثابتة) — لا استدعاء لـGemini إطلاقاً بهذا المسار، فقط بحث → تحضير → إرسال. يعرض بطاقة
// تقدم حية واحدة تُعدَّل عبر ثلاث مراحل: البحث → التحضير (تحميل وتحويل) → الإرسال
async function executeStickerPackRequest({ sock, chatId, msg, text, details, reply }) {
  const { topic, animated: requestedAnimated, static: requestedStatic } = details
  const total = requestedAnimated + requestedStatic

  const STAGES = ['البحث عن الملصقات', 'تحميل وتحويل الملصقات', 'إرسال الملصقات']
  const progressMsg = await reply(renderStageProgressCard({
    title: 'جاري تجهيز حزمة الملصقات',
    stages: STAGES, currentStageIndex: 0, currentDone: 0, currentTotal: 0,
  }))
  const canTrackProgress = !!progressMsg?.key

  let lastEditAt = 0
  const EDIT_THROTTLE_MS = 700
  const updateCard = async (stageIndex, done, stageTotal, { force = false } = {}) => {
    if (!canTrackProgress) return
    const now = Date.now()
    if (!force && now - lastEditAt < EDIT_THROTTLE_MS) return
    lastEditAt = now

    const card = renderStageProgressCard({
      title: 'جاري تجهيز حزمة الملصقات',
      stages: STAGES, currentStageIndex: stageIndex, currentDone: done, currentTotal: stageTotal,
    })
    try {
      await sock.sendMessage(chatId, { text: card, edit: progressMsg.key })
    } catch (e) {
      console.error('⚠️ فشل تعديل بطاقة تقدم الملصقات:', e.message)
    }
  }

  let pack
  try {
    pack = await stickerPack.buildStickerPack(topic, {
      count: total,
      requestedAnimated,
      requestedStatic,
      onProgress: (stage, done, stageTotal) => {
        const stageIndex = stage === 'searching' ? 0 : 1
        updateCard(stageIndex, done, stageTotal)
      },
    })
  } catch (e) {
    console.error('❌ فشل تجهيز حزمة الملصقات:', e.message)

    if (e.code === 'SERPER_KEY_MISSING') {
      const msgText = await gemini.generateContextualReply({
        chatId, reasonKey: 'send_stickers_key_missing',
        reasonContext: 'ميزة حزمة الملصقات تحتاج إعداداً تقنياً (مفتاح API) لم يُضبط بعد من صاحب البوت',
        userText: text,
      })
      await reply(msgText)
      return
    }

    const msgText = await gemini.generateContextualReply({
      chatId, reasonKey: 'send_stickers_build_failed',
      reasonContext: 'فشل البحث عن الملصقات أو تحميلها تقنياً',
      userText: text,
    })
    await reply(msgText)
    return
  }

  if (!pack.buffers.length) {
    const msgText = await gemini.generateContextualReply({
      chatId, reasonKey: 'send_stickers_no_results',
      reasonContext: 'بحثنا عن ملصقات بالموضوع المطلوب لكن ما لقينا نتائج صالحة نرسلها',
      userText: text,
    })
    await reply(msgText)
    return
  }

  // مرحلة الإرسال: متتابعة (لا متزامنة دفعة واحدة) حتى لا نُغرق واتساب برفع عدة وسائط
  // بنفس اللحظة، وحتى يبقى ترتيب وصول الملصقات منطقياً للمستخدم
  await updateCard(2, 0, pack.buffers.length, { force: true })

  let sentCount = 0
  for (const buffer of pack.buffers) {
    try {
      await sendMediaWithRetry(sock, chatId, { sticker: buffer }, { quoted: msg })
      sentCount++
    } catch (e) {
      console.error('❌ فشل إرسال أحد ملصقات الحزمة:', e.message)
      // نتجاهل فشل ملصق فردي ونكمل الباقي، بدل إيقاف الحزمة كاملة
    }
    await updateCard(2, sentCount, pack.buffers.length)
  }

  // تحديث أخير مضمون (force) يعكس النتيجة النهائية الفعلية، حتى لو تجاهل throttle آخر تحديث
  await updateCard(2, sentCount, pack.buffers.length, { force: true })

  if (sentCount === 0) {
    const msgText = await gemini.generateContextualReply({
      chatId, reasonKey: 'send_stickers_all_failed',
      reasonContext: 'تم تجهيز الملصقات لكن فشل إرسال كل واحد منها تقنياً',
      userText: text,
    })
    await reply(msgText)
    return
  }

  const ack = await gemini.generateActionAck({
    action: 'send_stickers', userText: text,
    detail: `أُرسل ${sentCount} من ${pack.requested} ملصق (${pack.animatedCount} متحرك، ${pack.staticCount} عادي) بموضوع "${topic}"`,
    success: true,
  })
  await reply(ack)
}

// ينفذ حزمة الصور مباشرة بتفاصيل دقيقة معروفة سلفاً — نفس فلسفة executeStickerPackRequest
// أعلاه بالضبط، لكن بمرحلتين فقط (بحث → إرسال) بدل ثلاث، لأن الصور تُرسل كما هي بلا أي
// تحويل صيغة إضافي (بعكس الملصقات التي تحتاج تحويل webp إلزامي)
async function executePhotoPackRequest({ sock, chatId, msg, text, details, reply }) {
  const { topic, animated: requestedAnimated, static: requestedStatic } = details
  const total = requestedAnimated + requestedStatic

  const STAGES = ['البحث عن الصور', 'تحميل الصور', 'إرسال الصور']
  const progressMsg = await reply(renderStageProgressCard({
    title: 'جاري تجهيز حزمة الصور',
    stages: STAGES, currentStageIndex: 0, currentDone: 0, currentTotal: 0,
  }))
  const canTrackProgress = !!progressMsg?.key

  let lastEditAt = 0
  const EDIT_THROTTLE_MS = 700
  const updateCard = async (stageIndex, done, stageTotal, { force = false } = {}) => {
    if (!canTrackProgress) return
    const now = Date.now()
    if (!force && now - lastEditAt < EDIT_THROTTLE_MS) return
    lastEditAt = now

    const card = renderStageProgressCard({
      title: 'جاري تجهيز حزمة الصور',
      stages: STAGES, currentStageIndex: stageIndex, currentDone: done, currentTotal: stageTotal,
    })
    try {
      await sock.sendMessage(chatId, { text: card, edit: progressMsg.key })
    } catch (e) {
      console.error('⚠️ فشل تعديل بطاقة تقدم الصور:', e.message)
    }
  }

  let pack
  try {
    pack = await photoPack.buildPhotoPack(topic, {
      count: total,
      requestedAnimated,
      requestedStatic,
      onProgress: (stage, done, stageTotal) => {
        const stageIndex = stage === 'searching' ? 0 : 1
        updateCard(stageIndex, done, stageTotal)
      },
    })
  } catch (e) {
    console.error('❌ فشل تجهيز حزمة الصور:', e.message)

    if (e.code === 'SERPER_KEY_MISSING') {
      const msgText = await gemini.generateContextualReply({
        chatId, reasonKey: 'send_photos_key_missing',
        reasonContext: 'ميزة حزمة الصور تحتاج إعداداً تقنياً (مفتاح API) لم يُضبط بعد من صاحب البوت',
        userText: text,
      })
      await reply(msgText)
      return
    }

    const msgText = await gemini.generateContextualReply({
      chatId, reasonKey: 'send_photos_build_failed',
      reasonContext: 'فشل البحث عن الصور أو تحميلها تقنياً',
      userText: text,
    })
    await reply(msgText)
    return
  }

  if (!pack.items.length) {
    const msgText = await gemini.generateContextualReply({
      chatId, reasonKey: 'send_photos_no_results',
      reasonContext: 'بحثنا عن صور بالموضوع المطلوب لكن ما لقينا نتائج صالحة نرسلها',
      userText: text,
    })
    await reply(msgText)
    return
  }

  await updateCard(2, 0, pack.items.length, { force: true })

  let sentCount = 0
  for (const item of pack.items) {
    try {
      if (item.isAnimated) {
        // GIF متحركة: تُرسل كفيديو بعلامة gifPlayback (هذي طريقة واتساب لعرض GIF متحركة
        // فعلياً، بعكس صورة ثابتة عادية)
        await sendMediaWithRetry(sock, chatId, { video: item.buffer, gifPlayback: true }, { quoted: msg })
      } else {
        await sendMediaWithRetry(sock, chatId, { image: item.buffer }, { quoted: msg })
      }
      sentCount++
    } catch (e) {
      console.error('❌ فشل إرسال إحدى صور الحزمة:', e.message)
      // نتجاهل فشل صورة فردية ونكمل الباقي، بدل إيقاف الحزمة كاملة
    }
    await updateCard(2, sentCount, pack.items.length)
  }

  await updateCard(2, sentCount, pack.items.length, { force: true })

  if (sentCount === 0) {
    const msgText = await gemini.generateContextualReply({
      chatId, reasonKey: 'send_photos_all_failed',
      reasonContext: 'تم تجهيز الصور لكن فشل إرسال كل واحدة منها تقنياً',
      userText: text,
    })
    await reply(msgText)
    return
  }

  const ack = await gemini.generateActionAck({
    action: 'send_photos', userText: text,
    detail: `أُرسل ${sentCount} من ${pack.requested} صورة (${pack.animatedCount} متحركة GIF، ${pack.staticCount} عادية) بموضوع "${topic}"`,
    success: true,
  })
  await reply(ack)
}

async function handleClassifiedAction({
  sock, chatId, msg, text, classified, groupInfo, groupState,
  senderIsAdmin, isGroup, hasImage, reply, selfIds, lastAiLatencyMs, botStartedAt, senderBare, currentMentions,
}) {
  switch (classified.action) {
    case 'help': {
      await reply(buildHelpText(groupState))
      break
    }

    case 'status': {
      const statusText = await buildStatusText(groupInfo, groupState, lastAiLatencyMs, botStartedAt)
      await reply(statusText)
      break
    }

    case 'usage': {
      const usageText = await buildUsageText()
      await reply(usageText)
      break
    }

    case 'get_info': {
      if (!isGroup || !groupInfo) {
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'get_info_not_group',
          reasonContext: 'المستخدم طلب معلومات المجموعة لكن هذه محادثة خاصة وليست مجموعة',
          userText: text,
        })
        await reply(msgText)
        break
      }

      // نجلب رابط الدعوة هنا ضمن نفس بطاقة المعلومات (بدل أمر منفصل كما كان سابقاً).
      // لا تحقق من كون الطالب نفسه مشرفاً — أي عضو بالجروب يقدر يشوف الرابط ضمن معلومات
      // المجموعة. لكن واتساب نفسه يشترط أن يكون البوت مشرفاً لجلب الرابط فعلياً (قيد من
      // واتساب لا نتحكم فيه)، فإن فشل الجلب لهذا السبب، نعرض بقية المعلومات بدون الرابط
      // بدل إفشال الأمر بالكامل — معلومات الجروب أهم من رابط قد لا يتوفر أصلاً
      let inviteLink = null
      try {
        inviteLink = await actions.fetchGroupInviteLink(sock, chatId)
      } catch (e) {
        console.error('⚠️ تعذر جلب رابط الجروب ضمن معلومات المجموعة (غالباً البوت ليس مشرفاً):', e.message)
      }

      const lines = []
      lines.push('┏━━━━━━━━━━━━━━━━━━━')
      lines.push('┃  📋 *معلومات المجموعة*')
      lines.push('┣━━━━━━━━━━━━━━━━━━━')
      lines.push(`┃ 👥 *الاسم*: ${groupInfo.name}`)
      lines.push(`┃ 👤 *الأعضاء*: ${groupInfo.members}`)
      lines.push(`┃ 🛡️  *المشرفون*: ${groupInfo.admins}`)
      lines.push(`┃ 🔒 *وضع المشرفين*: ${groupState.adminOnlyCommands ? 'مفعل' : 'معطل'}`)
      if (inviteLink) {
        lines.push(`┃ 🔗 *رابط الدعوة*: ${inviteLink}`)
      }
      lines.push('┗━━━━━━━━━━━━━━━━━━━')

      if (groupInfo.description) {
        lines.push('')
        lines.push('📝 *الوصف:*')
        lines.push(groupInfo.description)
      }

      const infoText = lines.join('\n')

      const picUrl = await actions.fetchGroupProfilePicUrl(sock, chatId)
      if (picUrl) {
        await sock.sendMessage(chatId, { image: { url: picUrl }, caption: infoText }, { quoted: msg })
      } else {
        await reply(infoText)
      }
      break
    }

    case 'rename_group': {
      if (!(await requireGroup(isGroup, chatId, reply, text))) break
      if (!(await requireAdmin(senderIsAdmin, chatId, reply, text))) break
      if (!(await requireValue(classified.value, chatId, reply, text, 'الاسم الجديد'))) break

      try {
        await actions.renameGroup(sock, chatId, classified.value)
        const ack = await gemini.generateActionAck({ action: 'rename_group', userText: text, detail: classified.value, success: true })
        await reply(ack)
      } catch (e) {
        console.error('❌ فشل تغيير الاسم:', e.message)
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'rename_group_failed',
          reasonContext: 'فشل تغيير اسم المجموعة تقنياً',
          userText: text,
        })
        await reply(msgText)
      }
      break
    }

    case 'change_description': {
      if (!(await requireGroup(isGroup, chatId, reply, text))) break
      if (!(await requireAdmin(senderIsAdmin, chatId, reply, text))) break
      if (!(await requireValue(classified.value, chatId, reply, text, 'الوصف الجديد'))) break

      try {
        await actions.updateDescription(sock, chatId, classified.value)
        const ack = await gemini.generateActionAck({ action: 'change_description', userText: text, detail: classified.value, success: true })
        await reply(ack)
      } catch (e) {
        console.error('❌ فشل تغيير الوصف:', e.message)
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'change_description_failed',
          reasonContext: 'فشل تغيير وصف المجموعة تقنياً',
          userText: text,
        })
        await reply(msgText)
      }
      break
    }

    case 'change_picture': {
      if (!(await requireGroup(isGroup, chatId, reply, text))) break
      if (!(await requireAdmin(senderIsAdmin, chatId, reply, text))) break

      const imgBuffer = await actions.getImageBufferFromMsg(sock, msg)
      if (!imgBuffer) {
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'change_picture_no_image',
          reasonContext: 'المستخدم طلب تغيير صورة المجموعة لكن لم يرسل صورة مع الأمر',
          userText: text,
        })
        await reply(msgText)
        break
      }

      try {
        await actions.updateGroupPicture(sock, chatId, imgBuffer)
        const ack = await gemini.generateActionAck({ action: 'change_picture', userText: text, detail: 'group picture updated', success: true })
        await reply(ack)
      } catch (e) {
        console.error('❌ فشل تغيير الصورة:', e.message)
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'change_picture_failed',
          reasonContext: 'فشل تغيير صورة المجموعة تقنياً',
          userText: text,
        })
        await reply(msgText)
      }
      break
    }

    case 'toggle_admin_only': {
      if (!(await requireGroup(isGroup, chatId, reply, text))) break
      if (!(await requireAdmin(senderIsAdmin, chatId, reply, text))) break

      const current = getGroupState(chatId)
      const value = normalizeSpaces(classified.value).toLowerCase()

      if (value === 'on' || value === 'true' || value === '1') {
        current.adminOnlyCommands = true
      } else if (value === 'off' || value === 'false' || value === '0') {
        current.adminOnlyCommands = false
      } else if (/اقفل|شغل|فعّل|فعل/i.test(text)) {
        current.adminOnlyCommands = true
      } else if (/افتح|فتح/i.test(text)) {
        current.adminOnlyCommands = false
      } else {
        current.adminOnlyCommands = !current.adminOnlyCommands
      }

      saveGroupStates()

      const ack = await gemini.generateActionAck({
        action: 'toggle_admin_only', userText: text,
        detail: current.adminOnlyCommands ? 'on' : 'off', success: true,
      })
      await reply(`${ack} ${current.adminOnlyCommands ? 'المشرفين ماسكينها' : 'رجعت للجميع'}`)
      break
    }

    case 'delete_quoted': {
      if (!(await requireGroup(isGroup, chatId, reply, text))) break
      if (!(await requireAdmin(senderIsAdmin, chatId, reply, text))) break

      const quotedKey = getQuotedKey(msg, chatId)
      if (!quotedKey) {
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'delete_quoted_no_reply',
          reasonContext: 'المستخدم طلب حذف رسالة لكنه لم يرد على أي رسالة',
          userText: text,
        })
        await reply(msgText)
        break
      }

      try {
        await actions.deleteQuotedMessage(sock, chatId, quotedKey)
        const ack = await gemini.generateActionAck({ action: 'delete_quoted', userText: text, detail: 'deleted quoted message', success: true })
        await reply(ack)
      } catch (e) {
        console.error('❌ فشل حذف الرسالة:', e.message)
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'delete_quoted_failed',
          reasonContext: 'فشل حذف الرسالة تقنياً، غالباً لأن البوت ليس مشرفاً',
          userText: text,
        })
        await reply(msgText)
      }
      break
    }

    case 'bulk_delete': {
      await handleBulkDelete({
        sock, chatId, msg, text, classified, senderIsAdmin, isGroup, reply, currentMentions, selfIds,
      })
      break
    }

    case 'promote':
    case 'demote':
    case 'kick': {
      await handleTargetedCommand({
        sock, chatId, msg, action: classified.action, classified,
        groupInfo, senderIsAdmin, isGroup, text, reply, selfIds, senderBare,
      })
      break
    }

    case 'kick_all': {
      if (!(await requireGroup(isGroup, chatId, reply, text))) break
      if (!(await requireAdmin(senderIsAdmin, chatId, reply, text))) break

      // تأكيد إجباري دائماً بغض النظر عن وضوح الطلب — هذا أمر مدمّر ولا يُنفذ أبداً من أول رسالة
      // نستبعد البوت نفسه من القائمة (وإلا سيحاول طرد نفسه ضمن العملية الجماعية)
      const allMemberJids = (groupInfo?.participants || [])
        .map(p => p.id)
        .filter(id => !selfIds.includes(bareId(id)))

      if (allMemberJids.length === 0) {
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'kick_all_no_members',
          reasonContext: 'المستخدم طلب طرد كل الأعضاء لكن تعذر الحصول على قائمة أعضاء المجموعة',
          userText: text,
        })
        await reply(msgText)
        break
      }

      memory.setPendingConfirmation(chatId, senderBare, {
        action: 'kick_all', candidates: allMemberJids, originalText: text,
      })

      const msgText = await gemini.generateContextualReply({
        chatId, reasonKey: 'kick_all_confirm_required',
        reasonContext: `المستخدم طلب إزالة جميع أعضاء المجموعة (${allMemberJids.length} عضو). هذا إجراء إداري واسع النطاق ولا يمكن التراجع عنه، لذا اطلب منه تأكيداً صريحاً وواضحاً (نعم أو لا) قبل المتابعة، ووضّح أن هذا سيفرغ المجموعة من أعضائها بالكامل`,
        userText: text,
      })
      await reply(msgText)
      break
    }

    case 'close_chat': {
      if (!(await requireGroup(isGroup, chatId, reply, text))) break
      if (!(await requireAdmin(senderIsAdmin, chatId, reply, text))) break

      try {
        await actions.setChatAnnouncementMode(sock, chatId, true)
        const ack = await gemini.generateActionAck({ action: 'close_chat', userText: text, detail: 'announcement', success: true })
        await reply(ack)
      } catch (e) {
        console.error('❌ فشل قفل الشات:', e.message)
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'close_chat_failed', reasonContext: 'فشل قفل الشات تقنياً', userText: text,
        })
        await reply(msgText)
      }
      break
    }

    case 'open_chat': {
      if (!(await requireGroup(isGroup, chatId, reply, text))) break
      if (!(await requireAdmin(senderIsAdmin, chatId, reply, text))) break

      try {
        await actions.setChatAnnouncementMode(sock, chatId, false)
        const ack = await gemini.generateActionAck({ action: 'open_chat', userText: text, detail: 'not_announcement', success: true })
        await reply(ack)
      } catch (e) {
        console.error('❌ فشل فتح الشات:', e.message)
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'open_chat_failed', reasonContext: 'فشل فتح الشات تقنياً', userText: text,
        })
        await reply(msgText)
      }
      break
    }

    case 'make_sticker': {
      let mediaSource = null

      if (hasImage) {
        mediaSource = await actions.getMediaBufferFromMsg(sock, msg)
      }
      if (!mediaSource) {
        mediaSource = await actions.getQuotedMediaBuffer(sock, msg, chatId)
      }

      if (!mediaSource) {
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'sticker_no_image',
          reasonContext: 'المستخدم طلب تحويل صورة أو فيديو أو GIF لملصق لكن لم يرسل أو يرد على أي وسيط قابل للتحويل',
          userText: text,
        })
        await reply(msgText)
        break
      }

      try {
        const webpBuffer = await media.convertToSticker(mediaSource)
        await sendMediaWithRetry(sock, chatId, { sticker: webpBuffer }, { quoted: msg })
      } catch (e) {
        if (e.code === 'VIDEO_TOO_LONG') {
          const msgText = await gemini.generateContextualReply({
            chatId, reasonKey: 'sticker_video_too_long',
            reasonContext: `المستخدم أرسل فيديو أو GIF أطول من ${media.MAX_ANIMATED_STICKER_SECONDS} ثواني لتحويله لملصق متحرك، وهذا الحد الأقصى المسموح به من واتساب للملصقات المتحركة، اطلب منه يرسل مقطع أقصر`,
            userText: text,
          })
          await reply(msgText)
          break
        }

        console.error('❌ فشل تحويل الملصق:', e.message)
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'sticker_conversion_failed',
          reasonContext: 'فشل تحويل الوسيط إلى ملصق تقنياً',
          userText: text,
        })
        await reply(msgText)
      }
      break
    }

    case 'send_song': {
      const query = normalizeSpaces(classified.value || '')

      if (!query) {
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'send_song_no_query',
          reasonContext: 'المستخدم طلب أغنية لكن لم يحدد اسمها أو اسم الفنان',
          userText: text,
        })
        await reply(msgText)
        break
      }

      const waitingText = await gemini.generateContextualReply({
        chatId, reasonKey: 'send_song_waiting', skipCache: true, // كل بحث جديد يستحق رد طازج، لا نخزنه
        reasonContext: 'البوت بدأ البحث عن الأغنية وسيرسلها بعد لحظات، أخبر المستخدم أنك تبحث الآن',
        userText: text,
      })
      const progressMsg = await reply(waitingText || 'جاري البحث عن الأغنية...')

      // إذا لم نحصل على رسالة صالحة لأي سبب، نكمل بدون تتبع تقدم حي بدل تعطل لاحق
      const canTrackProgress = !!progressMsg?.key

      // تحديث الرسالة نفسها بشريط تقدم حقيقي أثناء التحميل الفعلي، بدل رسائل منفصلة متكررة.
      // فاصل قصير جداً يجعل التحديث يبدو لحظياً، مع بقائه أقل بقليل من معدل تحديثات yt-dlp
      // الطبيعي (تقريباً كل ثانية)، فلا نحاول التعديل أسرع مما تصل بيانات جديدة فعلياً
      let lastEditAt = 0
      const EDIT_THROTTLE_MS = 900

      const onProgress = async ({ percent, etaSeconds }) => {
        if (!canTrackProgress) return
        const now = Date.now()
        if (now - lastEditAt < EDIT_THROTTLE_MS && percent < 100) return
        lastEditAt = now

        const bar = renderProgressBar(percent)
        const etaText = etaSeconds != null
          ? `⏳ الوقت المتبقي التقريبي: ${formatDuration(etaSeconds * 1000)}`
          : ''
        const progressText = [
          '🎵 جاري تحميل الأغنية...',
          bar,
          etaText,
        ].filter(Boolean).join('\n')

        try {
          await sock.sendMessage(chatId, { text: progressText, edit: progressMsg.key })
        } catch (e) {
          // فشل تعديل واحد لا يستحق إيقاف التحميل، نتجاهله ونكمل بصمت
          console.error('⚠️ فشل تعديل رسالة التقدم:', e.message)
        }
      }

      // مرحلة 1: البحث والتحميل — نفصلها عن مرحلة الإرسال بعدها حتى تكون رسالة
      // الخطأ دقيقة (هل فشل البحث/التحميل فعلياً، أم أن التحميل نجح وفشل الرفع لاحقاً؟)
      let songData
      try {
        songData = await media.searchAndDownloadSong(query, onProgress)
      } catch (e) {
        console.error('❌ فشل تحميل الأغنية (مرحلة البحث/التحميل):', e.message)
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'send_song_download_failed',
          reasonContext: 'فشل البحث عن الأغنية أو تحميلها من المصدر',
          userText: text,
        })
        await reply(msgText)
        break
      }

      const { buffer, title, duration, thumbnail, url } = songData

      // خلص التحميل، نعدّل الرسالة مرة أخيرة برسالة ثابتة (بدون شريط تقدم، لعدم توفر
      // تتبع تقدم حقيقي لمرحلة الرفع عبر Baileys) قبل رفع الملف فعلياً لواتساب
      if (canTrackProgress) {
        try {
          await sock.sendMessage(chatId, { text: 'جاري الرفع 📤...', edit: progressMsg.key })
        } catch {}
      }

      // مرحلة 2: الإرسال — منفصلة تماماً، مع إعادة محاولة تلقائية عند فشل رفع الوسائط
      try {
        await sendMediaWithRetry(
          sock, chatId,
          { audio: buffer, mimetype: 'audio/mpeg', pttAudio: false, fileName: `${title}.mp3` },
          { quoted: msg }
        )

        const cardLines = [
          '┏━━━━━━━━━━━━━━━━━━━',
          '┃   🎶  تفضّل أغنيتك',
          '┣━━━━━━━━━━━━━━━━━━━',
          `┃ 🎵 *الاسم*: ${title}`,
          `┃ ⏱️  *المدة*: ${formatDuration(duration * 1000)}`,
          '┗━━━━━━━━━━━━━━━━━━━',
          '',
          `*🔗الرابط* : ${url} `,
        ].join('\n')

        if (thumbnail) {
          await sendMediaWithRetry(sock, chatId, { image: { url: thumbnail }, caption: cardLines }, { quoted: msg })
        } else {
          await reply(cardLines)
        }

        console.log(`🎵 أرسلت: ${title} (${duration}s)`)
      } catch (e) {
        console.error('❌ فشل إرسال الأغنية بعد التحميل الناجح (مرحلة الرفع):', e.message)
        const msgText = await gemini.generateContextualReply({
          chatId, reasonKey: 'send_song_upload_failed',
          reasonContext: 'تم تحميل الأغنية بنجاح لكن فشل رفعها وإرسالها عبر واتساب لسبب تقني',
          userText: text,
        })
        await reply(msgText)
      }
      break
    }

    case 'send_stickers': {
      const instructionsText = await gemini.generateStickerInstructions(text)
      memory.setPendingConfirmation(chatId, senderBare, {
        action: 'awaiting_sticker_details', candidates: [], originalText: text,
      })
      await reply(instructionsText)
      break
    }

    case 'send_photos': {
      const instructionsText = await gemini.generatePhotoInstructions(text)
      memory.setPendingConfirmation(chatId, senderBare, {
        action: 'awaiting_photo_details', candidates: [], originalText: text,
      })
      await reply(instructionsText)
      break
    }

    case 'confirmation_reply':
    case 'reply':
    default: {
      await reply(classified.msg)
      break
    }
  }
}

async function main() {
  // خادم التنشيط والتنشيط الذاتي — يمنع Render من إطفاء البوت بعد خمول. يعمل بأمان
  // أيضاً لو شغّلت البوت محلياً أو بتريمكس (بس بدون فائدة عملية بهذي الحالة)
  startKeepAliveServer(process.env.PORT || 3000)
  startSelfPing(process.env.SELF_URL, 14 * 60 * 1000) // كل 14 دقيقة

  await gemini.initGemini()
  await startBot()
}

main().catch(err => {
  console.error('❌ خطأ عام:', err)
  process.exit(1)
})
