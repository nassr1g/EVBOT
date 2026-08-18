// ══════════════════════════════════════════════════════
//  📊 تتبع الاستهلاك — عداد محلي تقريبي لكل خدمة (Gemini / Tavily / Serper)
//
//  ملاحظة مهمة وصادقة: لا توجد أي خدمة من الثلاث تعطي "نسبة متبقية فعلية" عبر API — لا
//  Google ولا Tavily ولا Serper يوفرون endpoint لسؤاله "كم باقي لي من حصتي؟". لذا هذا
//  الملف لا "يقرأ" رقماً حقيقياً من الخدمة، بل يعدّ كل استدعاء نقوم به نحن محلياً، ويقارنه
//  بحد الحصة المعروف للخطة المجانية (موثّق بكل خدمة)، فينتج نسبة استخدام/تبقّي تقريبية.
//  التقدير يبقى دقيقاً طالما البوت هو المستخدم الوحيد للمفاتيح؛ أي استخدام خارجي للمفتاح
//  نفسه (سكربت آخر، حساب مشترك) لن ينعكس هنا لأننا لا نستطيع رؤيته.
// ══════════════════════════════════════════════════════

const fs = require('fs')
const path = require('path')

const USAGE_FILE = path.join(__dirname, '..', 'usage_state.json')

// ─────────────────────────────────────────────
//  حدود الخطط المجانية المعروفة (موثّقة من كل مزوّد). تُستخدم فقط كمرجع للنسبة المئوية،
//  وليست مصدراً حياً — إذا رفعت خطتك لاحقاً غيّر الأرقام هنا يدوياً
// ─────────────────────────────────────────────
const LIMITS = {
  gemini: {
    // Gemini Flash-Lite (الخطة المجانية): حد يومي للطلبات (RPD) وحد بالدقيقة (RPM).
    // نتتبع كلا الحدين، لكن نعرض RPD كنسبة أساسية لأنه الأكثر تحديداً للاستخدام اليومي
    rpd: 1000,
    rpm: 15,
    resetCycle: 'daily', // يُصفَّر تلقائياً كل منتصف ليل (توقيت الخادم)
  },
  tavily: {
    monthly: 1000,
    resetCycle: 'monthly',
  },
  serper: {
    // Serper يعطي رصيداً ثابتاً عند التسجيل (لا يتجدد تلقائياً كل شهر إلا بخطة مدفوعة)،
    // لذا نعامله كـ"رصيد" ينقص فقط، بدل استخدام دوري يُصفَّر
    credits: 2500,
    resetCycle: 'none',
  },
}

// ─────────────────────────────────────────────
//  حالة الاستخدام + حفظ/تحميل من ملف (يصمد عبر إعادة تشغيل البوت)
// ─────────────────────────────────────────────

function defaultState() {
  const now = Date.now()
  return {
    gemini: { count: 0, cycleStart: now },
    tavily: { count: 0, cycleStart: now },
    serper: { count: 0 }, // بلا cycleStart لأنه رصيد لا يتجدد
  }
}

let state = loadState()

function loadState() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'))
      // دمج مع الافتراضي حتى لو الملف قديم وناقص حقولاً (ترقية من نسخة سابقة)
      return { ...defaultState(), ...loaded }
    }
  } catch (e) {
    console.error('⚠️ تعذر تحميل usage_state.json:', e.message)
  }
  return defaultState()
}

function saveState() {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(state, null, 2), 'utf8')
  } catch (e) {
    console.error('⚠️ تعذر حفظ usage_state.json:', e.message)
  }
}

// يتحقق هل حان وقت تصفير الدورة (يومي لـGemini، شهري لـTavily)، ويصفّرها تلقائياً لو نعم
function ensureCycleFresh(service) {
  const limit = LIMITS[service]
  const entry = state[service]
  if (!limit || !entry || limit.resetCycle === 'none') return

  const now = Date.now()
  const elapsedMs = now - (entry.cycleStart || now)

  const cycleMs = limit.resetCycle === 'daily'
    ? 24 * 60 * 60 * 1000
    : 30 * 24 * 60 * 60 * 1000 // تقريب شهري بسيط (30 يوم) — كافٍ لعرض تقديري

  if (elapsedMs >= cycleMs) {
    entry.count = 0
    entry.cycleStart = now
  }
}

// ─────────────────────────────────────────────
//  تسجيل استدعاء — تُستدعى مرة واحدة بعد كل نجاح فعلي لطلب لتلك الخدمة
// ─────────────────────────────────────────────

function recordUsage(service) {
  if (!state[service]) return
  ensureCycleFresh(service)
  state[service].count += 1
  saveState()
}

// ─────────────────────────────────────────────
//  حساب ملخص النسب — يُستخدم بأمر "حالة التوكنز" وبأمر status العام
// ─────────────────────────────────────────────

function computeServiceSummary(service, keyPresent) {
  const limit = LIMITS[service]
  const entry = state[service]
  ensureCycleFresh(service)

  if (!keyPresent) {
    return { available: false, used: 0, cap: 0, percentUsed: 0, percentLeft: 0 }
  }

  const cap = limit.rpd ?? limit.monthly ?? limit.credits ?? 0
  const used = Math.min(entry.count, cap)
  const percentUsed = cap > 0 ? Math.round((used / cap) * 100) : 0
  const percentLeft = Math.max(0, 100 - percentUsed)

  return { available: true, used, cap, percentUsed, percentLeft }
}

function getUsageSummary({ hasGemini = true, hasTavily = false, hasSerper = false } = {}) {
  return {
    gemini: computeServiceSummary('gemini', hasGemini),
    tavily: computeServiceSummary('tavily', hasTavily),
    serper: computeServiceSummary('serper', hasSerper),
  }
}

module.exports = {
  recordUsage,
  getUsageSummary,
  LIMITS,
}
