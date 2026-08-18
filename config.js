// ══════════════════════════════════════════════════════
//  ⚙️ الإعدادات المركزية
// ══════════════════════════════════════════════════════

require('dotenv').config()

const GEMINI_KEY = process.env.GEMINI_API_KEY
if (!GEMINI_KEY) {
  console.error('❌ لم أجد GEMINI_API_KEY. أنشئ ملف .env بجانب index.js وضع فيه:')
  console.error('   GEMINI_API_KEY=مفتاحك')
  process.exit(1)
}

// مفتاح Tavily اختياري — البوت يستمر بالعمل بدونه، لكن البحث لن يعمل. راجع
// app.tavily.com للحصول على مفتاح مجاني (1000 بحث شهرياً، بدون بطاقة بنكية)
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || ''
if (!TAVILY_API_KEY) {
  console.log('ℹ️  TAVILY_API_KEY غير موجود — ميزة البحث ستكون معطلة حتى تضيفه بملف .env')
}

// مفتاح Serper اختياري — البوت يستمر بالعمل بدونه، لكن ميزة حزمة الملصقات لن تعمل. راجع
// serper.dev للحصول على مفتاح مجاني (2500 استعلام مجاني عند التسجيل، بدون بطاقة بنكية)
const SERPER_API_KEY = process.env.SERPER_API_KEY || ''
if (!SERPER_API_KEY) {
  console.log('ℹ️  SERPER_API_KEY غير موجود — ميزة حزمة الملصقات ستكون معطلة حتى تضيفه بملف .env')
}

module.exports = {
  GEMINI_KEY,
  TAVILY_API_KEY,
  SERPER_API_KEY,
  MODEL_NAME: 'gemini-3.1-flash-lite',

  // توقيع المطور — يظهر بقائمة الأوامر وعرض الحالة، ويعرفه Gemini للرد على أي استفسار
  // عن هوية المطور أو طريقة التواصل معه. عدّل هذين السطرين فقط لتغيير التوقيع أو الرقم
  DEVELOPER_SIGNATURE: '𝙀𝙑𝄞',
  DEVELOPER_CONTACT: '+967772431754',

  // كم رسالة نحتفظ فيها بذاكرة كل محادثة (يجب أن تكون زوجية: user/bot)
  MEMORY_LIMIT: 30,
  MEMORY_HISTORY_WINDOW: 30,

  // مدة صلاحية التأكيد المعلق (طرد/ترقية/تنزيل) بالميلي ثانية
  PENDING_CONFIRMATION_TTL_MS: 2 * 60 * 1000,

  // أقل فاصل زمني مسموح بين طلبين من نفس المحادثة، لحماية الكوتا من السبام
  RATE_LIMIT_COOLDOWN_MS: 3000,

  // أقل فاصل زمني بين أي طلبين متتاليين لـ Gemini على مستوى المشروع بالكامل (عبر كل
  // المحادثات معاً)، لحماية حد الطلبات بالدقيقة (RPM) الخاص بالمفتاح ككل. هذا مختلف عن
  // RATE_LIMIT_COOLDOWN_MS أعلاه الذي يراقب كل محادثة منفردة فقط، بينما حد Google الفعلي
  // يُحسب على إجمالي كل الطلبات من المفتاح بغض النظر عن مصدرها
  GLOBAL_GEMINI_MIN_INTERVAL_MS: 4500,

  // عدد محاولات إعادة الاتصال بـ Gemini قبل الاستسلام
  GEMINI_MAX_ATTEMPTS: 3,
  GEMINI_RETRY_DELAY_MS: 1500,

  // مدة صلاحية تخزين رسائل الرفض المؤقت لكل سبب متكرر (يقلل استهلاك الكوتا)
  REFUSAL_CACHE_TTL_MS: 20 * 1000,
}
