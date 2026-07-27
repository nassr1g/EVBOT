// ══════════════════════════════════════════════════════
//  🖼️ حزمة الملصقات — بحث صور Serper (Google Images الفعلي) + تحميل + تحويل دفعة ملصقات
// ══════════════════════════════════════════════════════

const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const ffmpeg = require('fluent-ffmpeg')
const { SERPER_API_KEY } = require('../config')
const { uniqueTempId } = require('./utils')

ffmpeg.setFfmpegPath('ffmpeg')

const TMP_DIR = path.join(__dirname, '..', 'tmp')
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

const MIN_STICKERS = 1
const MAX_STICKERS = 20
const DEFAULT_STICKERS = 10

// الحد الأقصى المطلق لعدد نتائج البحث بطلب واحد (يُستخدم كسقف بدالة fetchBatch أدناه،
// التي تدير هامش الأمان الفعلي وإعادة المحاولة عند النقص عبر صفحات نتائج جديدة)
const MAX_FETCH_RESULTS = 60

const DOWNLOAD_TIMEOUT_MS = 15000
const MAX_CONCURRENT_DOWNLOADS = 5

function clampCount(n, fallback) {
  const num = Number(n)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.max(MIN_STICKERS, Math.min(MAX_STICKERS, Math.round(num)))
}

// يحدد كم ملصق متحرك وكم ثابت، حسب ما طلبه المستخدم صراحة أو تلقائياً (نصف/نصف تقريباً)
function splitAnimatedStatic(total, requestedAnimated, requestedStatic) {
  const hasAnimated = Number.isFinite(Number(requestedAnimated)) && Number(requestedAnimated) >= 0
  const hasStatic = Number.isFinite(Number(requestedStatic)) && Number(requestedStatic) >= 0

  if (hasAnimated && hasStatic) {
    const animated = Math.min(total, Math.max(0, Math.round(Number(requestedAnimated))))
    const staticCount = Math.min(total - animated, Math.max(0, Math.round(Number(requestedStatic))))
    return { animated, static: total - animated >= 0 ? staticCount : 0, total: animated + staticCount }
  }

  if (hasAnimated) {
    const animated = Math.min(total, Math.max(0, Math.round(Number(requestedAnimated))))
    return { animated, static: total - animated, total }
  }

  if (hasStatic) {
    const staticCount = Math.min(total, Math.max(0, Math.round(Number(requestedStatic))))
    return { animated: total - staticCount, static: staticCount, total }
  }

  // لا تحديد — البوت يختار توزيعاً تلقائياً متوازناً تقريباً (نصف متحرك ونصف ثابت)
  const animated = Math.floor(total / 2)
  return { animated, static: total - animated, total }
}

async function fetchWithTimeout(url, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stickerbot/1.0)' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const arrayBuf = await res.arrayBuffer()
    return Buffer.from(arrayBuf)
  } finally {
    clearTimeout(timer)
  }
}

// يشغّل مجموعة promises بحد أقصى للتزامن، ويرجع فقط النتائج الناجحة (يتجاهل الفاشلة بصمت).
// يتوقف مبكراً بمجرد الوصول لعدد النجاحات المطلوب (targetSuccesses) بدل معالجة كل العناصر
// المتبقية بلا داعٍ، لأننا أصلاً نطلب أكثر من الحاجة كهامش أمان ضد الروابط الميتة فقط.
// onSuccess (اختياري) يُستدعى بعد كل عنصر ناجح تحديداً بعدد النجاحات التراكمي حتى الآن،
// حتى يعكس شريط التقدم عدد الملصقات الفعلية الجاهزة لا عدد المحاولات الأكبر منها
async function mapLimitSettled(items, limit, fn, targetSuccesses, onSuccess = null) {
  const results = []
  let index = 0
  let stopped = false

  async function worker() {
    while (!stopped && index < items.length) {
      const current = index++
      try {
        const value = await fn(items[current], current)
        if (stopped) continue
        if (value !== null && value !== undefined) {
          results.push(value)
          if (onSuccess) onSuccess(Math.min(results.length, targetSuccesses))
          if (results.length >= targetSuccesses) stopped = true
        }
      } catch (err) {
        // فشل عنصر فردي لا يوقف بقية الدفعة، لكن نسجّله (بإيجاز) بدل تجاهله بصمت
        // تماماً — بدون هذا التسجيل يصعب اكتشاف أنماط فشل ممنهجة (مثال: نوع صيغة صور
        // معينة تفشل بانتظام) لأنها تبدو من الخارج كنقص عادي بالنتائج فقط
        const url = items[current]?.thumbnailUrl || items[current]?.imageUrl || '(unknown)'
        console.error(`⚠️ فشل تحميل/تحويل ملصق: ${url} — ${err?.message || String(err)}`)
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker)
  await Promise.all(workers)
  return results
}

const SERPER_IMAGES_URL = 'https://google.serper.dev/images'
const SEARCH_TIMEOUT_MS = 10000

// يبحث عبر Serper (نتائج Google Images الفعلية). نُبقي حقل البحث q نظيفاً بموضوع المستخدم
// فقط دائماً (بدون أي إضافة تُغيّر معناه أو تُضيّق نتائجه)، ونطلب صور متحركة فقط عبر
// tbs=itp:animated (معامل Google Images الرسمي والموثّق لهذا الغرض تحديداً) بدل حشر
// "filetype:gif" داخل نص البحث نفسه، لأن ذلك كان يُضيّق النتائج ويؤثر على شمولية البحث
async function searchSerperImages(query, { animated = false, count = 20, page = 1 } = {}) {
  if (!SERPER_API_KEY) {
    console.error('⚠️ SERPER_API_KEY غير موجود — تعذر تنفيذ بحث الصور')
    return []
  }

  const finalQuery = query
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)

  try {
    const body = { q: finalQuery, num: Math.min(count, 100) }
    if (animated) body.tbs = 'itp:animated'
    if (page > 1) body.page = page

    const res = await fetch(SERPER_IMAGES_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Serper HTTP ${res.status}: ${errText.slice(0, 300)}`)
    }

    const data = await res.json()
    const results = (data?.images || []).slice(0, count)
    console.log(`🔎 Serper [${animated ? 'gif' : 'static'}] "${finalQuery}" صفحة ${page} → ${results.length} نتيجة`)
    return results
  } catch (err) {
    console.error(`❌ فشل بحث الصور عن "${finalQuery}" (Serper، صفحة ${page}):`, err?.message || String(err))
    return []
  } finally {
    clearTimeout(timer)
  }
}


async function downloadAndConvertStatic(imageResult) {
  const buffer = await fetchWithTimeout(imageResult.imageUrl)
  const id = uniqueTempId()
  const tmpOut = path.join(TMP_DIR, `pack_static_${id}.webp`)

  try {
    await new Promise((resolve, reject) => {
      const inputStream = Readable.from(buffer)
      // لا نفرض صيغة إدخال معينة (لا inputFormat): روابط صور Serper/Google كثيراً ما تكون
      // بلا امتداد ملف واضح بالمسار (روابط وكيل/CDN، مثال شائع: صور gstatic.com بلا ".jpg"
      // أو ".png" إطلاقاً)، فتخمين الصيغة من الرابط كان يفرض صيغة خاطئة أحياناً كثيرة ويُفشل
      // فك التشفير تماماً. ffmpeg قادر على اكتشاف الصيغة الحقيقية من محتوى البايتات نفسها
      // بثقة أعلى بكثير من أي تخمين نصي من الرابط، فنترك له هذا تلقائياً
      ffmpeg(inputStream)
        .outputOptions([
          '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
          '-quality', '90',
          '-loop', '0',
        ])
        .toFormat('webp')
        .on('end', resolve)
        .on('error', reject)
        .save(tmpOut)
    })
    const out = fs.readFileSync(tmpOut)
    return out
  } finally {
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut)
  }
}

async function downloadAndConvertAnimated(imageResult) {
  const buffer = await fetchWithTimeout(imageResult.imageUrl)
  const id = uniqueTempId()
  const tmpIn = path.join(TMP_DIR, `pack_anim_in_${id}.gif`)
  const tmpOut = path.join(TMP_DIR, `pack_anim_out_${id}.webp`)

  fs.writeFileSync(tmpIn, buffer)

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(tmpIn)
        .outputOptions([
          '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,fps=15',
          '-quality', '80',
          '-loop', '0',
          '-preset', 'default',
          '-an',
          '-vsync', '0',
        ])
        .toFormat('webp')
        .on('end', resolve)
        .on('error', reject)
        .save(tmpOut)
    })
    return fs.readFileSync(tmpOut)
  } finally {
    if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn)
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut)
  }
}

// يجهّز دفعة واحدة (متحركة أو ثابتة) بعدد نجاحات مضمون قدر الإمكان: يبحث ويحمّل ويحوّل،
// وإذا نقص العدد عن المطلوب (روابط ميتة، صور غير صالحة...)، يعيد البحث بصفحة نتائج تالية
// (نتائج جديدة لم تُجرَّب من قبل) ويكمل النقص، حتى MAX_FETCH_ROUNDS محاولة توسّع كحد أقصى
const MAX_FETCH_ROUNDS = 4
const INITIAL_FETCH_MULTIPLIER = 2.5
const EXPANSION_FETCH_MULTIPLIER = 2

async function fetchBatch(query, animated, targetSuccesses, converter, onSuccess) {
  if (targetSuccesses <= 0) return []

  const buffers = []
  let round = 0
  let page = 1
  // نتتبع كل رابط صورة جربناه (نجح أو فشل) عبر كل الجولات، لأن صفحات نتائج Serper
  // المتتالية أحياناً ترجع نتائج متطابقة جزئياً أو كلياً مع صفحة سابقة (خصوصاً لمواضيع
  // بحث ضيقة النتائج) — بدون هذا التتبع، نفس الصورة قد تُحمَّل وتُرسَل أكثر من مرة كملصقين
  // منفصلين ظاهرياً رغم كونهما نفس المحتوى بالضبط
  const seenUrls = new Set()

  while (buffers.length < targetSuccesses && round < MAX_FETCH_ROUNDS) {
    round++
    const remaining = targetSuccesses - buffers.length
    // بالجولة الأولى هامش أوسع نسبياً (×2.5)، وبجولات التوسع اللاحقة هامش أصغر (×2) لأنها
    // أصلاً تلاحق نقصاً محدداً لا تحتاج فيه هامشاً كبيراً كالبداية
    const multiplier = round === 1 ? INITIAL_FETCH_MULTIPLIER : EXPANSION_FETCH_MULTIPLIER
    const fetchCount = Math.min(MAX_FETCH_RESULTS, Math.max(Math.ceil(remaining * multiplier), remaining + 4))

    const rawResults = await searchSerperImages(query, { animated, count: fetchCount, page })
    page++

    // نستبعد أي نتيجة رابطها مطابق تماماً لرابط جربناه بجولة سابقة (أو بنفس الجولة نظرياً)
    const results = rawResults.filter(r => {
      const url = r.imageUrl
      if (!url || seenUrls.has(url)) return false
      seenUrls.add(url)
      return true
    })

    if (results.length === 0) {
      // ما فيه نتائج جديدة فعلياً بهذي الصفحة (فاضية أو كلها مكررة) — لا فائدة من
      // محاولة صفحات لاحقة غالباً
      break
    }

    const newBuffers = await mapLimitSettled(results, MAX_CONCURRENT_DOWNLOADS, converter, remaining, (n) => {
      onSuccess(buffers.length + n)
    })

    buffers.push(...newBuffers)
  }

  return buffers.slice(0, targetSuccesses)
}

/**
 * يبحث عن حزمة ملصقات بموضوع معين ويجهزها كـ buffers جاهزة للإرسال.
 * @param {string} query - موضوع البحث (يُفضل بالإنجليزية لنتائج أدق)
 * @param {object} opts - { count, requestedAnimated, requestedStatic, onProgress }
 *   onProgress(stage, done, total) يُستدعى أثناء التقدم — stage تكون 'searching' مرة واحدة
 *   عند بدء البحث، ثم 'preparing' مرات متكررة أثناء تحميل وتحويل كل ملصق (done/total تراكمي
 *   عبر النوعين معاً)
 * @returns {{ buffers: Buffer[], animatedCount: number, staticCount: number, requested: number }}
 */
async function buildStickerPack(query, { count, requestedAnimated, requestedStatic, onProgress = null } = {}) {
  if (!SERPER_API_KEY) {
    const err = new Error('serper_key_missing')
    err.code = 'SERPER_KEY_MISSING'
    throw err
  }

  const total = clampCount(count, DEFAULT_STICKERS)
  const split = splitAnimatedStatic(total, requestedAnimated, requestedStatic)

  if (onProgress) onProgress('searching', 0, total)

  // نتتبع عدد النجاحات الفعلية لكل دفعة على حدة، ثم نجمعهما لعرض تقدم موحّد لا يتجاوز
  // أبداً "total" — fetchBatch نفسها تتكفل بمحاولات التوسع عند النقص، فهذا العداد يعكس
  // فقط النجاحات الحقيقية النهائية بغض النظر عن كم جولة بحث احتاجت للوصول لها
  let staticDone = 0
  let animatedDone = 0
  const reportCombined = () => {
    if (onProgress) onProgress('preparing', staticDone + animatedDone, total)
  }

  const [finalStatic, finalAnimated] = await Promise.all([
    fetchBatch(query, false, split.static, downloadAndConvertStatic, (n) => {
      staticDone = n
      reportCombined()
    }),
    fetchBatch(query, true, split.animated, downloadAndConvertAnimated, (n) => {
      animatedDone = n
      reportCombined()
    }),
  ])

  return {
    buffers: [...finalAnimated, ...finalStatic],
    animatedCount: finalAnimated.length,
    staticCount: finalStatic.length,
    requested: total,
  }
}

module.exports = {
  buildStickerPack,
  MIN_STICKERS,
  MAX_STICKERS,
  DEFAULT_STICKERS,
}
