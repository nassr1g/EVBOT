// ══════════════════════════════════════════════════════
//  📷 حزمة الصور — بحث صور Serper (Google Images الفعلي) + تحميل دفعة صور
//  (عادية وGIF متحركة معاً) — الصور الثابتة تُرسل كما هي، أما GIF فتُحوَّل إلى MP4 أولاً
//  (واتساب لا يدعم ملفات .gif مباشرة إطلاقاً؛ يتطلب gifPlayback فيديو MP4 حقيقي)
// ══════════════════════════════════════════════════════

const fs = require('fs')
const path = require('path')
const ffmpeg = require('fluent-ffmpeg')
const { SERPER_API_KEY } = require('../config')
const { uniqueTempId } = require('./utils')

ffmpeg.setFfmpegPath('ffmpeg')

const TMP_DIR = path.join(__dirname, '..', 'tmp')
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

const MIN_PHOTOS = 1
const MAX_PHOTOS = 20
const DEFAULT_PHOTOS = 10

const MAX_FETCH_RESULTS = 60
const SEARCH_TIMEOUT_MS = 10000
const DOWNLOAD_TIMEOUT_MS = 15000
const MAX_CONCURRENT_DOWNLOADS = 5

// حد أقصى لحجم أي ملف نحمّله — صور/GIFs جودة كاملة من گوگل أحياناً عدة ميجابايت، وهذا
// يحمي من هدر بيانات دون داعٍ حقيقي (واتساب نفسه يضغط الوسائط المرسلة أصلاً بجانبه)
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024 // 5MB

const SERPER_IMAGES_URL = 'https://google.serper.dev/images'

function clampCount(n, fallback) {
  const num = Number(n)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.max(MIN_PHOTOS, Math.min(MAX_PHOTOS, Math.round(num)))
}

// يحدد كم صورة متحركة (GIF) وكم عادية، حسب ما طلبه المستخدم صراحة أو تلقائياً —
// نفس منطق splitAnimatedStatic بـstickerPack.js بالضبط
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

  const animated = Math.floor(total / 2)
  return { animated, static: total - animated, total }
}

async function fetchWithTimeout(url, timeoutMs = DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_DOWNLOAD_BYTES) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; photobot/1.0)' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const declaredLength = Number(res.headers.get('content-length') || 0)
    if (declaredLength > maxBytes) {
      throw new Error(`file_too_large_declared:${declaredLength}`)
    }

    if (!res.body) {
      const arrayBuf = await res.arrayBuffer()
      const buf = Buffer.from(arrayBuf)
      if (buf.length > maxBytes) throw new Error(`file_too_large:${buf.length}`)
      return buf
    }

    const chunks = []
    let received = 0
    for await (const chunk of res.body) {
      received += chunk.length
      if (received > maxBytes) {
        controller.abort()
        throw new Error(`file_too_large_stream:${received}`)
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  } finally {
    clearTimeout(timer)
  }
}

// يشغّل مجموعة promises بحد أقصى للتزامن، يرجع فقط النتائج الناجحة، ويتوقف مبكراً بمجرد
// الوصول لعدد النجاحات المطلوب — نفس منطق stickerPack.js بالضبط (راجع تعليقاته هناك)
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
        const url = items[current]?.imageUrl || '(unknown)'
        console.error(`⚠️ فشل تحميل صورة: ${url} — ${err?.message || String(err)}`)
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker)
  await Promise.all(workers)
  return results
}

// يبحث عبر Serper (نتائج Google Images الفعلية). لطلب المتحركة تحديداً نستخدم
// tbs=itp:animated (معامل Google Images الرسمي والموثّق لهذا الغرض) بدل أي حشر بنص البحث
async function searchSerperImages(query, { animated = false, count = 20, page = 1 } = {}) {
  if (!SERPER_API_KEY) {
    console.error('⚠️ SERPER_API_KEY غير موجود — تعذر تنفيذ بحث الصور')
    return []
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)

  try {
    const body = { q: query, num: Math.min(count, 100) }
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
    console.log(`🔎 Serper [${animated ? 'gif' : 'photo'}] "${query}" صفحة ${page} → ${results.length} نتيجة`)
    return results
  } catch (err) {
    console.error(`❌ فشل بحث الصور عن "${query}" (Serper، صفحة ${page}):`, err?.message || String(err))
    return []
  } finally {
    clearTimeout(timer)
  }
}

// يحمّل الصورة كما هي (بلا أي تحويل صيغة أو تحجيم قسري) — الهدف صور عادية تُرسل وتُعرض
// بجودتها الطبيعية، بعكس الملصقات التي تحتاج تحويلاً إلزامياً لصيغة webp مربعة
async function downloadPhoto(imageResult) {
  const buffer = await fetchWithTimeout(imageResult.imageUrl)
  return { buffer, title: imageResult.title || '', isAnimated: false }
}

// واتساب لا يدعم ملفات .gif مباشرة إطلاقاً (مؤكد من توثيق Baileys الرسمي) — خاصية
// gifPlayback تتطلب ملف MP4 حقيقي (فيديو H.264)، وإرسال بايتات GIF خام تحت هذه الخاصية
// يصل كرسالة لكن لا يُشغَّل ولا تظهر صورة واضحة منه (تماماً كما لوحظ). لذا نحوّل GIF
// المُحمَّل إلى MP4 عبر ffmpeg قبل إرجاعه، بنفس بنية تحويل media.js لكن للفيديو لا الملصق
async function downloadAnimatedPhoto(imageResult) {
  const buffer = await fetchWithTimeout(imageResult.imageUrl)
  const id = uniqueTempId()
  const tmpIn = path.join(TMP_DIR, `photo_gif_in_${id}.gif`)
  const tmpOut = path.join(TMP_DIR, `photo_gif_out_${id}.mp4`)

  fs.writeFileSync(tmpIn, buffer)

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(tmpIn)
        .outputOptions([
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // أبعاد زوجية إلزامية لترميز H.264
          '-pix_fmt', 'yuv420p', // توافق أوسع مع مشغلات الفيديو على الجوالات
          '-movflags', '+faststart',
        ])
        .videoCodec('libx264')
        .noAudio()
        .toFormat('mp4')
        .on('end', resolve)
        .on('error', reject)
        .save(tmpOut)
    })
    const mp4Buffer = fs.readFileSync(tmpOut)
    return { buffer: mp4Buffer, title: imageResult.title || '', isAnimated: true }
  } finally {
    if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn)
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut)
  }
}

// يجهّز دفعة واحدة (متحركة أو ثابتة) بعدد نجاحات مضمون قدر الإمكان، بنفس منطق fetchBatch
// بـstickerPack.js بالضبط (بما فيه إزالة التكرار عبر seenUrls — كانت السبب بتكرار نفس
// الصورة أكثر من مرة بالحزمة النهائية عند تداخل نتائج صفحات البحث المتتالية)
const MAX_FETCH_ROUNDS = 4
const INITIAL_FETCH_MULTIPLIER = 2.5
const EXPANSION_FETCH_MULTIPLIER = 2

async function fetchBatch(query, animated, targetSuccesses, converter, onSuccess) {
  if (targetSuccesses <= 0) return []

  const items = []
  let round = 0
  let page = 1
  const seenUrls = new Set()

  while (items.length < targetSuccesses && round < MAX_FETCH_ROUNDS) {
    round++
    const remaining = targetSuccesses - items.length
    const multiplier = round === 1 ? INITIAL_FETCH_MULTIPLIER : EXPANSION_FETCH_MULTIPLIER
    const fetchCount = Math.min(MAX_FETCH_RESULTS, Math.max(Math.ceil(remaining * multiplier), remaining + 4))

    const rawResults = await searchSerperImages(query, { animated, count: fetchCount, page })
    page++

    const results = rawResults.filter(r => {
      const url = r.imageUrl
      if (!url || seenUrls.has(url)) return false
      seenUrls.add(url)
      return true
    })

    if (results.length === 0) break

    const newItems = await mapLimitSettled(results, MAX_CONCURRENT_DOWNLOADS, converter, remaining, (n) => {
      onSuccess(items.length + n)
    })

    items.push(...newItems)
  }

  return items.slice(0, targetSuccesses)
}

/**
 * يبحث عن حزمة صور (عادية ومتحركة) بموضوع معين ويجهزها كعناصر جاهزة للإرسال.
 * @param {string} query - موضوع البحث (يُفضل بالإنجليزية لنتائج أدق)
 * @param {object} opts - { count, requestedAnimated, requestedStatic, onProgress }
 *   onProgress(stage, done, total) — stage تكون 'searching' مرة واحدة عند البدء،
 *   ثم 'preparing' مرات متكررة أثناء التحميل (تراكمي عبر النوعين معاً)
 * @returns {{ items: {buffer: Buffer, title: string, isAnimated: boolean}[], animatedCount: number, staticCount: number, requested: number }}
 */
async function buildPhotoPack(query, { count, requestedAnimated, requestedStatic, onProgress = null } = {}) {
  if (!SERPER_API_KEY) {
    const err = new Error('serper_key_missing')
    err.code = 'SERPER_KEY_MISSING'
    throw err
  }

  const total = clampCount(count, DEFAULT_PHOTOS)
  const split = splitAnimatedStatic(total, requestedAnimated, requestedStatic)

  if (onProgress) onProgress('searching', 0, total)

  let staticDone = 0
  let animatedDone = 0
  const reportCombined = () => {
    if (onProgress) onProgress('preparing', staticDone + animatedDone, total)
  }

  const [staticItems, animatedItems] = await Promise.all([
    fetchBatch(query, false, split.static, downloadPhoto, (n) => {
      staticDone = n
      reportCombined()
    }),
    fetchBatch(query, true, split.animated, downloadAnimatedPhoto, (n) => {
      animatedDone = n
      reportCombined()
    }),
  ])

  return {
    items: [...animatedItems, ...staticItems],
    animatedCount: animatedItems.length,
    staticCount: staticItems.length,
    requested: total,
  }
}

module.exports = {
  buildPhotoPack,
  MIN_PHOTOS,
  MAX_PHOTOS,
  DEFAULT_PHOTOS,
}
